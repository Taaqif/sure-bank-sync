/**
 * Fake bank for testing the pipeline end-to-end. Options: {"mfa": true}
 * exercises the code prompt, {"captcha": true} the remote browser view
 * (type a word into a fake check page and press the button), {"fail": true}
 * a failed login with console output (for the debug files).
 */
import type { BankAccount, BankTransaction } from "../models.js";
import { AuthError, type ProviderDefinition } from "./base.js";

const ACCT: BankAccount = { id: "000-111 9999", name: "Demo Everyday", currency: "AUD" };
const SAVER: BankAccount = { id: "000-111 8888", name: "Demo Saver", currency: "AUD" };

const CAPTCHA_PAGE = `<!doctype html><html><body style="font:16px system-ui;padding:40px">
<h2>Demo bank security check</h2>
<p>Type a word, then press the button.</p>
<input id="word" style="font-size:18px;padding:6px"> <button id="go" style="font-size:18px;padding:6px 14px">I'm a person</button>
<div style="height:1200px"></div><p>Bottom of the page</p>
<script>
document.getElementById("go").onclick = () => {
  if (!document.getElementById("word").value.trim()) return alert("type something first");
  document.body.insertAdjacentHTML("afterbegin", '<p id="ok" style="color:green">Thanks!</p>');
};
</script></body></html>`;

export const demo: ProviderDefinition = {
  name: "demo",
  label: "Demo bank (testing)",
  credentialFields: [],
  create: (ctx) => ({
    async login() {
      ctx.log("demo: logging in");
      if (ctx.options.fail) {
        const page = ctx.browser.pages()[0] ?? (await ctx.browser.newPage());
        await page.setContent(`<h1>Demo bank is down</h1><script>console.warn("demo: login service unavailable")</script>`);
        await page.waitForTimeout(200);
        throw new AuthError("demo: login failed on purpose");
      }
      if (ctx.options.mfa) {
        const code = await ctx.requestMfa("Demo bank: enter any 6 digit code");
        if (!/^\d{6}$/.test(code)) throw new AuthError("demo: code must be 6 digits");
      }
      if (ctx.options.captcha) {
        const page = ctx.browser.pages()[0] ?? (await ctx.browser.newPage());
        await page.setContent(CAPTCHA_PAGE);
        await ctx.requestBrowserHelp(page, "Demo bank: type any word in the box and press \"I'm a person\".", async () =>
          (await page.locator("#ok").count()) > 0,
        );
        ctx.log("demo: check passed");
      }
    },
    async listAccounts() {
      return [ACCT, SAVER];
    },
    async fetchTransactions({ since, until }) {
      const acct = ACCT;
      const out: BankTransaction[] = [];
      for (let d = new Date(`${since}T00:00:00Z`); d <= new Date(`${until}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
        const date = d.toISOString().slice(0, 10);
        out.push({ account: acct, date, amountCents: -450, description: "DEMO COFFEE CO" });
        if (d.getUTCDate() === 1) out.push({ account: acct, date, amountCents: 250_000, description: "DEMO SALARY" });
      }
      return out;
    },
  }),
};

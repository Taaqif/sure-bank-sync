/** Fake bank for testing the pipeline end-to-end. Set options {"mfa": true} to exercise the OTP prompt. */
import type { BankAccount, BankTransaction } from "../models.js";
import { AuthError, type ProviderDefinition } from "./base.js";

const ACCT: BankAccount = { id: "000-111 9999", name: "Demo Everyday", currency: "AUD" };
const SAVER: BankAccount = { id: "000-111 8888", name: "Demo Saver", currency: "AUD" };

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

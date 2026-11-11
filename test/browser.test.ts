import { chromium } from "playwright";
import { describe, expect, it } from "vitest";
import { settle } from "../src/providers/base.js";

describe("settle", () => {
  it("doesn't wait for background traffic that never stops", async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.route("**/*", (route) =>
        route.request().url().includes("beacon") ? new Promise(() => {}) : route.fulfill({ body: "<p>ok</p>", contentType: "text/html" }),
      );
      await page.goto("https://bank.example/");
      // A beacon that never finishes, like bank analytics.
      await page.evaluate(() => { void fetch("https://bank.example/beacon"); });
      const t = Date.now();
      await settle(page);
      expect(Date.now() - t).toBeLessThan(3000);
    } finally {
      await browser.close();
    }
  }, 30_000);
});

describe("macquarie What's new popup", () => {
  it("closes it (over two slides) before clicking what's underneath", async () => {
    const { dismissWhatsNew } = await import("../src/providers/macquarie.js");
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      // Same structure as Macquarie's popup: a Next slide, then "Got it".
      await page.setContent(`
        <button id="under" onclick="this.textContent='clicked'">Accounts</button>
        <mq-whats-new style="position:fixed;inset:0;background:#fff;display:block">
          <h1 class="mq-whats-new__information-title">Confirmation of Payee</h1>
          <div class="mq-whats-new__actions">
            <button id="next" onclick="this.remove();document.getElementById('done').hidden=false">Next</button>
            <button id="done" class="mq-whats-new__actions--finish" hidden onclick="document.querySelector('mq-whats-new').remove()">Got it</button>
          </div>
        </mq-whats-new>`);
      const logs: string[] = [];
      await dismissWhatsNew(page, (m) => logs.push(m));
      await page.locator("#under").click({ timeout: 10_000 });
      expect(await page.locator("#under").innerText()).toBe("clicked");
      expect(await page.locator("mq-whats-new").count()).toBe(0);
      expect(logs).toEqual(['macquarie: closing a "What\'s new" popup (Confirmation of Payee)']);
    } finally {
      await browser.close();
    }
  }, 30_000);
});

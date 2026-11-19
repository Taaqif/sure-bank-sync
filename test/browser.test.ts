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

describe("amex activity search date range", () => {
  // The live search page: hidden ISO dates inside Start/End groups, and the
  // same groups under an aria-hidden ancestor (the page does this for menus).
  const fields = `
    <div role="group" aria-label="Start date">
      <input name="undefined-start-date" type="hidden" value="2026-10-19">
      <input aria-label="Day" value="19"><input aria-label="Month" value="10"><input aria-label="Year" value="2026">
    </div>
    <div role="group" aria-label="End date">
      <input name="undefined-end-date" type="hidden" value="2026-11-19">
      <input aria-label="Day" value="19"><input aria-label="Month" value="11"><input aria-label="Year" value="2026">
    </div>`;

  it("reads the hidden dates from the groups, including under aria-hidden", async () => {
    const { amexDateRange } = await import("../src/providers/amex.js");
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.setContent(`<main>${fields}</main><div aria-hidden="true">${fields}</div>`);
      expect(await page.getByRole("group", { name: "Start date", exact: true }).count()).toBe(1);
      const { start, end } = amexDateRange(page);
      expect(await start.locator('input[name$="-start-date"]').inputValue()).toBe("2026-10-19");
      expect(await end.locator('input[name$="-end-date"]').inputValue()).toBe("2026-11-19");
      expect(await start.locator('input[aria-label="Day"]').inputValue()).toBe("19");

      await page.locator("main").evaluate((el) => el.setAttribute("aria-hidden", "true"));
      expect(await page.getByRole("group", { name: "Start date", exact: true }).count()).toBe(0);
      expect(await amexDateRange(page).start.locator('input[name$="-start-date"]').inputValue()).toBe("2026-10-19");
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

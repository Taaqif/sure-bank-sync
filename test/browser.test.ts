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

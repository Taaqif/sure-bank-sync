import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { describe, expect, it } from "vitest";
import { csvSummary, scrubValue, startRecording, suggestCode, type Recording } from "../src/recorder.js";

describe("recorder helpers", () => {
  it("replaces stored login values with placeholders", () => {
    expect(scrubValue("tye123", { username: "tye123", password: "x" })).toBe("{{username}}");
    expect(scrubValue("01/11/2026", { username: "tye123" })).toBe("01/11/2026");
  });

  it("summarises a CSV download", () => {
    expect(csvSummary('﻿"Date","Amount"\r\n01/11/2026,1\r\n02/11/2026,2\r\n')).toEqual({ header: ["Date", "Amount"], rows: 2 });
  });

  it("suggests the most specific locator", () => {
    expect(
      suggestCode({ kind: "click", el: { tag: "button", selectors: [{ kind: "role", role: "button", name: "Apply" }, { kind: "testid", attr: "data-testid", value: "apply" }], html: "" } }),
    ).toBe('await page.locator("[data-testid=\\"apply\\"]").click();');
    expect(suggestCode({ kind: "fill", masked: true, el: { tag: "input", selectors: [{ kind: "label", value: "Password" }], html: "" } })).toContain("secret");
  });
});

describe("startRecording", () => {
  it("records clicks, typed values and keys, without secrets", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rec-"));
    const browser = await chromium.launch();
    try {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      await page.setContent(`
        <label for="u">User</label><input id="u" name="user">
        <label for="p">Password</label><input id="p" type="password">
        <input id="d" placeholder="DD/MM/YYYY">
        <button data-testid="go">Apply</button>`);
      const rec = await startRecording(ctx, {
        recipe: "t",
        provider: "demo",
        connectionId: "c",
        dir,
        credentials: { username: "tye123", password: "hunter2" },
        secrets: ["hunter2"],
        label: (u) => u,
        log: () => {},
      });
      // Trusted input, like a person (or the remote view) would make.
      await page.click("#u");
      await page.keyboard.type("tye123");
      await page.click("#p");
      await page.keyboard.type("hunter2");
      await page.click("#d");
      await page.keyboard.type("01/11/2026");
      await page.keyboard.press("Enter");
      await page.click("[data-testid=go]");
      await page.waitForTimeout(200);
      const out: Recording = await rec.stop();
      const saved = JSON.parse(await readFile(join(dir, "recipe-t.json"), "utf8")) as Recording;
      expect(saved.steps.length).toBe(out.steps.length);
      const text = JSON.stringify(saved);
      expect(text).not.toContain("hunter2");
      expect(text).not.toContain("tye123");
      const fills = saved.steps.filter((s) => s.kind === "fill");
      expect(fills.map((s) => s.value ?? "masked")).toEqual(["{{username}}", "masked", "01/11/2026"]);
      expect(saved.steps.some((s) => s.kind === "press" && s.key === "Enter")).toBe(true);
      const apply = saved.steps.findLast((s) => s.kind === "click")!;
      expect(apply.el?.selectors[0]).toEqual({ kind: "testid", attr: "data-testid", value: "go" });
      expect(apply.code).toContain("data-testid");
      expect(apply.shot).toMatch(/^train-t-\d{3}\.png$/);
    } finally {
      await browser.close();
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

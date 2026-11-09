import { mkdtempSync, readFileSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { configureLogFile, logger, tailLog } from "../src/log.js";

describe("log file", () => {
  it("rotates at the size cap and tails across both files", () => {
    const dir = mkdtempSync(join(tmpdir(), "sbs-log-"));
    configureLogFile(dir, 2000);
    const log = logger("test");
    for (let i = 0; i < 60; i++) log.info(`line ${i} ${"x".repeat(40)}`);
    log.error("boom", new Error("kaput"));

    const cur = join(dir, "app.log");
    expect(statSync(cur).size).toBeLessThanOrEqual(2000 + 500);
    expect(existsSync(cur + ".1")).toBe(true);
    expect(statSync(cur + ".1").size).toBeLessThanOrEqual(2000);

    const entries = tailLog(1000);
    expect(entries.at(-1)).toMatch(/ERROR test: boom\nError: kaput/);
    expect(entries.at(-2)).toContain("line 59");
    // older lines were rotated out for good
    expect(entries.some((e) => e.includes("line 0 "))).toBe(false);
    expect(readFileSync(cur, "utf8") + readFileSync(cur + ".1", "utf8")).toContain("line 59");
  });
});

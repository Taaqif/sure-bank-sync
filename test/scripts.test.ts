import { describe, expect, it } from "vitest";
import { RemotePage, RunPage } from "../src/web/views/pages.js";
import type { Run } from "../src/db/schema.js";

/** Inline <script> bodies of a rendered page. */
async function scripts(node: unknown): Promise<string[]> {
  const html = String(await (node as { toString(): string | Promise<string> }).toString());
  return [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
}

describe("inline page scripts", () => {
  // Template strings in TSX can turn "\n" in a regex into a real line break; make sure every script parses.
  const run = { id: 1, connectionId: "c", status: "running", log: "", dryRun: false, trigger: "manual", startedAt: "2026-11-09T00:00:00Z" } as unknown as Run;
  it.each([
    ["browser view", () => RemotePage({ connectionId: "c", prompt: "Solve the check" })],
    ["live run page", () => RunPage({ run, shots: [] })],
  ])("%s scripts parse", async (_name, render) => {
    const list = await scripts(render());
    expect(list.length).toBeGreaterThan(0);
    for (const s of list) expect(() => new Function(s)).not.toThrow();
  });
});

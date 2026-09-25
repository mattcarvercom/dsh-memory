import assert from "node:assert/strict";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { parseFrontmatter } from "../lib/frontmatter.js";
import { projectKey } from "../lib/keys.js";
import { applyPlan, planModeChange, planMoveLegacy, planPurge } from "../lib/migrate.js";
import { readState, resolveMode } from "../lib/state.js";
import { updateMemory } from "../lib/store.js";
import { claudeMemoryDir, claudeNew, claudeOld, dshMade, dshMemoryDir, makeRoots, putMemory } from "./helpers.js";

const KEY = "-home-me-dev";

async function files(dir) {
  try {
    return (await readdir(dir)).filter((f) => f.endsWith(".md") && f !== "MEMORY.md").sort();
  } catch {
    return [];
  }
}
async function meta(dir, file) {
  return parseFrontmatter(await readFile(join(dir, file), "utf8")).data.metadata ?? {};
}

describe("mode changes", () => {
  let t;
  let claude;
  let dsh;
  beforeEach(async () => {
    t = await makeRoots();
    claude = claudeMemoryDir(t.claudeRoot, KEY);
    dsh = dshMemoryDir(t.dshRoot, KEY);
  });
  afterEach(() => t.cleanup());

  it("dsh -> shared moves dsh memories into Claude Code's folder, renaming collisions and stamping origin", async () => {
    await putMemory(claude, "style.md", claudeOld("style", "Claude's style"));
    await putMemory(dsh, "style.md", "---\nname: style\ndescription: dsh style\ntype: feedback\n---\nlegacy dsh body\n");
    await putMemory(dsh, "notes.md", dshMade("notes", "dsh notes"));
    const plan = await planModeChange(t.roots, "dsh", "shared");
    assert.deepEqual(plan.steps.map((s) => [s.kind, s.file, s.toFile]).sort(), [["move", "notes.md", "notes.md"], ["move", "style.md", "style-dsh.md"]]);
    await applyPlan(t.roots, plan, { recordMode: true });
    assert.deepEqual(await files(claude), ["notes.md", "style-dsh.md", "style.md"]);
    assert.equal((await meta(claude, "style-dsh.md")).origin, "dsh");
    assert.equal((await meta(claude, "style.md")).origin, undefined);
    const index = await readFile(join(claude, "MEMORY.md"), "utf8");
    assert.match(index, /\(notes\.md\)/);
    assert.match(index, /\(style-dsh\.md\)/);
    assert.match(index, /\(style\.md\) — hook for style\.md/);
    assert.deepEqual(await files(dsh), []);
    assert.equal((await readState(t.dshRoot)).mode, "shared");
  });

  it("shared -> dsh moves dsh files out and copies Claude Code's; --clean skips the copies", async () => {
    await putMemory(claude, "rule.md", claudeOld("rule", "a rule"));
    await putMemory(claude, "mine.md", dshMade("mine", "dsh made this"));
    await putMemory(claude, "edited.md", `${claudeNew("edited", "edited by dsh").replace("  type: project\n", "  type: project\n  updatedBy: dsh\n")}`);

    const clean = await planModeChange(t.roots, "shared", "dsh", { clean: true });
    assert.deepEqual(clean.steps.map((s) => s.kind), ["move"]);
    assert.match(clean.notes.join("\n"), /edited\.md: Claude Code memory edited by dsh/);

    const plan = await planModeChange(t.roots, "shared", "dsh", { now: "2026-03-03T00:00:00.000Z" });
    await applyPlan(t.roots, plan, { recordMode: true });
    assert.deepEqual(await files(claude), ["edited.md", "rule.md"]);
    assert.deepEqual(await files(dsh), ["edited.md", "mine.md", "rule.md"]);
    assert.deepEqual(await meta(dsh, "rule.md"), { origin: "claude", copiedFrom: "rule.md", copiedAt: "2026-03-03T00:00:00.000Z" });
    assert.equal((await meta(dsh, "mine.md")).origin, "dsh");
  });

  it("shared -> overlay moves dsh files out without copying", async () => {
    await putMemory(claude, "rule.md", claudeOld("rule", "a rule"));
    await putMemory(claude, "mine.md", dshMade("mine", "dsh made this"));
    await applyPlan(t.roots, await planModeChange(t.roots, "shared", "overlay"), { recordMode: true });
    assert.deepEqual(await files(claude), ["rule.md"]);
    assert.deepEqual(await files(dsh), ["mine.md"]);
  });

  it("returning to shared drops unchanged copies and handles edited and deleted-upstream ones", async () => {
    await putMemory(claude, "same.md", claudeOld("same", "unchanged"));
    await putMemory(claude, "changed.md", claudeOld("changed", "will be edited"));
    await putMemory(claude, "gone.md", claudeOld("gone", "deleted upstream"));
    await applyPlan(t.roots, await planModeChange(t.roots, "shared", "dsh"), { recordMode: true });
    await updateMemory(dsh, "changed.md", { body: "dsh's better version" }, "dsh");
    await (await import("node:fs/promises")).unlink(join(claude, "gone.md"));

    const conflicted = await planModeChange(t.roots, "dsh", "shared");
    assert.deepEqual(conflicted.conflicts.map((c) => c.copy), ["changed.md"]);
    await assert.rejects(applyPlan(t.roots, conflicted, { recordMode: true }), /--prefer/);

    const plan = await planModeChange(t.roots, "dsh", "shared", { prefer: "dsh" });
    const kinds = Object.fromEntries(plan.steps.map((s) => [s.file, s.kind]));
    assert.deepEqual(kinds, { "same.md": "drop", "changed.md": "replace", "gone.md": "drop" });
    await applyPlan(t.roots, plan, { recordMode: true });
    assert.deepEqual(await files(claude), ["changed.md", "same.md"]);
    const changed = await readFile(join(claude, "changed.md"), "utf8");
    assert.match(changed, /dsh's better version/);
    assert.match(changed, /originSessionId: 3f2a9c1e/);
    assert.equal((await meta(claude, "changed.md")).updatedBy, "dsh");
    assert.deepEqual(await files(dsh), []);
  });

  it("--restore-deleted brings back copies whose original was deleted", async () => {
    await putMemory(claude, "gone.md", claudeOld("gone", "deleted upstream"));
    await applyPlan(t.roots, await planModeChange(t.roots, "shared", "dsh"), { recordMode: true });
    await (await import("node:fs/promises")).unlink(join(claude, "gone.md"));
    await applyPlan(t.roots, await planModeChange(t.roots, "dsh", "shared", { restoreDeleted: true }), { recordMode: true });
    assert.deepEqual(await files(claude), ["gone.md"]);
    const m = await meta(claude, "gone.md");
    assert.equal(m.copiedFrom, undefined);
    assert.equal(m.copiedAt, undefined);
  });

  it("dsh <-> overlay moves nothing", async () => {
    await putMemory(dsh, "a.md", dshMade("a", "x"));
    const plan = await planModeChange(t.roots, "dsh", "overlay");
    assert.equal(plan.steps.length, 0);
  });

  it("backs up memory folders but never Claude Code's session transcripts", async () => {
    await putMemory(claude, "rule.md", claudeOld("rule", "a rule"));
    await writeFile(join(t.claudeRoot, "projects", KEY, "session.jsonl"), "{}\n");
    const { backupDir } = await applyPlan(t.roots, await planModeChange(t.roots, "shared", "dsh"), { recordMode: true });
    assert.deepEqual(await readdir(join(backupDir, "claude", KEY)), ["memory"]);
    assert.deepEqual(await files(join(backupDir, "claude", KEY, "memory")), ["rule.md"]);
  });
});

describe("purge and legacy", () => {
  let t;
  beforeEach(async () => {
    t = await makeRoots();
  });
  afterEach(() => t.cleanup());

  it("purge --origin dsh removes dsh-created files only and lists dsh-edited ones", async () => {
    const claude = claudeMemoryDir(t.claudeRoot, KEY);
    await putMemory(claude, "rule.md", claudeOld("rule", "a rule"));
    await putMemory(claude, "mine.md", dshMade("mine", "dsh made"));
    await putMemory(claude, "touched.md", claudeNew("touched", "x").replace("  type: project\n", "  type: project\n  updatedBy: dsh\n"));
    const plan = await planPurge(t.roots, "shared", "dsh");
    assert.deepEqual(plan.steps.map((s) => s.file), ["mine.md"]);
    assert.match(plan.notes.join(""), /touched\.md: edited by dsh, kept/);
    await applyPlan(t.roots, plan);
    assert.deepEqual(await files(claude), ["rule.md", "touched.md"]);
    assert.doesNotMatch(await readFile(join(claude, "MEMORY.md"), "utf8"), /mine\.md/);
  });

  it("move-legacy folds root-level dsh memories into the session's project", async () => {
    await putMemory(t.dshRoot, "old-pref.md", "---\nname: old-pref\ndescription: legacy\ntype: feedback\n---\nx\n");
    const project = join(t.home, "dev", "p");
    await mkdir(project, { recursive: true });
    const plan = await planMoveLegacy(t.roots, "shared", project);
    await applyPlan(t.roots, plan);
    const target = claudeMemoryDir(t.claudeRoot, projectKey(project));
    assert.deepEqual(await files(target), ["old-pref.md"]);
    assert.equal((await meta(target, "old-pref.md")).origin, "dsh");
    assert.deepEqual(await files(t.dshRoot), []);
  });
});

describe("resolveMode", () => {
  let t;
  beforeEach(async () => {
    t = await makeRoots();
  });
  afterEach(() => t.cleanup());

  it("adopts the configured mode for a fresh store and records it", async () => {
    assert.deepEqual(await resolveMode(t.dshRoot, "shared"), { mode: "shared", configured: "shared", pending: false, adopted: true });
    assert.equal((await readState(t.dshRoot)).mode, "shared");
  });

  it("treats a pre-mode store with memories as dsh mode, pending a migration", async () => {
    await putMemory(dshMemoryDir(t.dshRoot, KEY), "a.md", dshMade("a", "x"));
    assert.deepEqual(await resolveMode(t.dshRoot, "shared"), { mode: "dsh", configured: "shared", pending: true, adopted: false });
    assert.equal(await readState(t.dshRoot), null);
  });

  it("reports a pending migration when the marker and config disagree", async () => {
    await resolveMode(t.dshRoot, "dsh");
    assert.equal((await resolveMode(t.dshRoot, "shared")).pending, true);
    assert.equal((await resolveMode(t.dshRoot, undefined)).pending, false);
  });
});

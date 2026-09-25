import assert from "node:assert/strict";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { editFrontmatter, parseFrontmatter } from "../lib/frontmatter.js";
import {
  createMemory, deleteMemory, findSimilar, freeName, originOf, scanMemoryFiles, typeOf, updateMemory, upsertIndexLine,
} from "../lib/store.js";
import { claudeOld, makeRoots, putMemory } from "./helpers.js";

describe("editFrontmatter", () => {
  const src = "---\nname: x\ndescription: d\ntags:\n  - a\n  - b\ntype: feedback\n# comment\noriginSessionId: abc\n---\nbody\n";

  it("changes only the targeted keys and keeps lists, comments and unknown keys", () => {
    const out = editFrontmatter(src, { set: { description: "new: value" }, setMeta: { updatedBy: "dsh" } });
    assert.equal(out, "---\nname: x\ndescription: \"new: value\"\ntags:\n  - a\n  - b\ntype: feedback\n# comment\noriginSessionId: abc\nmetadata:\n  updatedBy: dsh\n---\nbody\n");
  });

  it("replaces a nested key and its continuation lines, and removes keys", () => {
    const nested = "---\nname: y\nmetadata:\n  type: user\n  note: >\n    folded\n    text\n  copiedFrom: y.md\n---\nb\n";
    const out = editFrontmatter(nested, { setMeta: { note: "plain" }, unsetMeta: ["copiedFrom"] });
    assert.equal(out, "---\nname: y\nmetadata:\n  type: user\n  note: plain\n---\nb\n");
  });

  it("quotes strings that would read back as another type", () => {
    const out = editFrontmatter("---\nname: a\n---\n", { setMeta: { modified: "2026", flag: "true", path: "C:\\x" } });
    const meta = parseFrontmatter(out).data.metadata;
    assert.deepEqual(meta, { modified: "2026", flag: "true", path: "C:\\x" });
  });

  it("replaces the body", () => {
    assert.equal(editFrontmatter("---\nname: a\n---\nold\n", { body: "new\n" }), "---\nname: a\n---\nnew\n");
  });

  it("keeps the blank line Claude Code writes after the fence", () => {
    const claude = "---\nname: a\n---\n\nBody.\n";
    assert.equal(editFrontmatter(claude, { setMeta: { updatedBy: "dsh" } }), "---\nname: a\nmetadata:\n  updatedBy: dsh\n---\n\nBody.\n");
    assert.equal(editFrontmatter(claude, { body: "New.\n" }), "---\nname: a\n---\n\nNew.\n");
  });
});

describe("store", () => {
  let t;
  let dir;
  before(async () => {
    t = await makeRoots();
    dir = join(t.home, "folder");
  });
  after(() => t.cleanup());

  it("creates dsh memories with provenance in the metadata form, and indexes them", async () => {
    await createMemory(dir, "a.md", { name: "a", description: "first", type: "user", body: "Body", sessionId: "s-1", now: "2026-01-01T00:00:00.000Z" });
    const content = await readFile(join(dir, "a.md"), "utf8");
    assert.equal(content, "---\nname: a\ndescription: first\nmetadata:\n  type: user\n  origin: dsh\n  originSessionId: s-1\n  modified: 2026-01-01T00:00:00.000Z\n---\nBody\n");
    assert.match(await readFile(join(dir, "MEMORY.md"), "utf8"), /^- \[a\]\(a\.md\) — first$/m);
    await assert.rejects(createMemory(dir, "a.md", { name: "a", description: "x", type: "user", body: "B" }), /already exists/);
  });

  it("updates a Claude Code memory in place: keeps its shape and unknown fields, adds updatedBy", async () => {
    await putMemory(dir, "old.md", claudeOld("old", "old style", "tags:\n  - keep\n"));
    await updateMemory(dir, "old.md", { body: "New body", type: "project", now: "2026-02-02T00:00:00.000Z" }, "claude");
    const out = await readFile(join(dir, "old.md"), "utf8");
    assert.equal(out, "---\nname: old\ndescription: old style\ntype: project\noriginSessionId: 3f2a9c1e-5b7d-4e8a-9c0b-1d2e3f4a5b6c\ntags:\n  - keep\nmetadata:\n  modified: 2026-02-02T00:00:00.000Z\n  updatedBy: dsh\n---\nNew body\n");
  });

  it("does not mark dsh's own files as updatedBy", async () => {
    await updateMemory(dir, "a.md", { description: "changed" }, "dsh");
    const { data } = parseFrontmatter(await readFile(join(dir, "a.md"), "utf8"));
    assert.equal(data.metadata.updatedBy, undefined);
    assert.equal(data.metadata.origin, "dsh");
    assert.match(await readFile(join(dir, "MEMORY.md"), "utf8"), /\(a\.md\) — changed$/m);
  });

  it("keeps a concurrent index edit made by another writer", async () => {
    const indexPath = join(dir, "MEMORY.md");
    await writeFile(indexPath, `${await readFile(indexPath, "utf8")}- [claude-added](claude-added.md) — by Claude Code\n`);
    await createMemory(dir, "b.md", { name: "b", description: "second", type: "project", body: "B" });
    const index = await readFile(indexPath, "utf8");
    assert.match(index, /claude-added\.md/);
    assert.match(index, /\(b\.md\)/);
  });

  it("moves deleted non-dsh files to the trash", async () => {
    const trash = join(t.home, "trash");
    const result = await deleteMemory(dir, "old.md", { trashDir: trash });
    assert.equal(result.deleted, true);
    assert.deepEqual(await readdir(trash), ["old.md"]);
    assert.doesNotMatch(await readFile(join(dir, "MEMORY.md"), "utf8"), /old\.md/);
  });

  it("reads origin and type in both shapes", async () => {
    assert.equal(originOf({}, "claude"), "claude");
    assert.equal(originOf({}, "dsh"), "dsh");
    assert.equal(originOf({ metadata: { origin: "dsh" } }, "claude"), "dsh");
    assert.equal(typeOf({ type: "feedback" }), "feedback");
    assert.equal(typeOf({ metadata: { type: "user" } }), "user");
  });

  it("finds duplicates by name or word overlap", async () => {
    const entries = await scanMemoryFiles(dir);
    assert.equal(findSimilar(entries, { file: "a.md", name: "a", description: "unrelated" })[0].entry.filename, "a.md");
    await upsertIndexLine(dir, "x.md", "x", "y");
    const near = findSimilar(
      [{ filename: "commit-style.md", name: "commit-style", description: "factual commit messages only" }],
      { file: "commits.md", name: "commits", description: "commit messages factual only" },
    );
    assert.equal(near.length, 1);
    assert.equal(findSimilar(entries, { file: "zzz.md", name: "zzz", description: "nothing like the others" }).length, 0);
  });

  it("picks free names with a suffix", async () => {
    assert.equal(await freeName(dir, "new.md", "dsh"), "new.md");
    assert.equal(await freeName(dir, "a.md", "dsh"), "a-dsh.md");
    assert.equal(await freeName(dir, "a.md", "dsh", new Set(["a-dsh.md"])), "a-dsh-2.md");
  });
});

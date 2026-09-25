import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { after, before, describe, it } from "node:test";
import { projectKey } from "../lib/keys.js";
import { claudeMemoryDir, claudeOld, dshMade, makeRoots, putMemory } from "./helpers.js";

const run = promisify(execFile);
const MEM = fileURLToPath(new URL("../bin/mem.js", import.meta.url));

describe("mem CLI", () => {
  let t;
  let dev;
  let mem;
  before(async () => {
    t = await makeRoots();
    dev = join(t.home, "dev");
    await mkdir(dev, { recursive: true });
    const claude = claudeMemoryDir(t.claudeRoot, projectKey(dev));
    await putMemory(claude, "rule.md", claudeOld("rule", "a rule about commits"));
    await putMemory(claude, "mine.md", dshMade("mine", "made by dsh"));
    mem = async (...args) => (await run(process.execPath, ["--no-warnings", MEM, ...args, "--dsh-root", t.dshRoot, "--claude-root", t.claudeRoot, "--cwd", dev], {
      env: { ...process.env, XDG_CACHE_HOME: join(t.home, ".cache") },
    })).stdout;
  });
  after(() => t.cleanup());

  it("sets the mode on a fresh store without moving anything", async () => {
    assert.match(await mem("mode", "shared"), /mode set to shared; there were no memories to move/);
    assert.equal((await mem("mode")).trim(), "shared");
  });

  it("reports status with provenance counts", async () => {
    const out = await mem("status");
    assert.match(out, /mode: shared/);
    assert.match(out, /store: 2 memories \(1 dsh, 1 claude\)|store: 2 memories \(1 claude, 1 dsh\)/);
  });

  it("searches the resolved folders", async () => {
    assert.match(await mem("search", "commits"), /rule\.md \[feedback\]/);
  });

  it("lists by origin", async () => {
    const out = await mem("list", "--origin", "dsh");
    assert.match(out, /mine\.md \(origin dsh\)/);
    assert.doesNotMatch(out, /rule\.md/);
  });

  it("dry-runs a mode change without touching files", async () => {
    const out = await mem("mode", "dsh", "--dry-run");
    assert.match(out, /shared -> dsh:/);
    assert.match(out, /move {3}.*mine\.md/);
    assert.match(out, /copy {3}.*rule\.md/);
    assert.equal((await mem("mode")).trim(), "shared");
    assert.deepEqual((await readdir(claudeMemoryDir(t.claudeRoot, projectKey(dev)))).sort(), ["MEMORY.md", "mine.md", "rule.md"]);
  });

  it("purges dsh's memories", async () => {
    assert.match(await mem("purge", "--origin", "dsh"), /removed 1 memories/);
    assert.deepEqual((await readdir(claudeMemoryDir(t.claudeRoot, projectKey(dev)))).sort(), ["MEMORY.md", "rule.md"]);
  });
});

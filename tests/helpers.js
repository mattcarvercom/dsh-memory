/** Shared test fixtures: temporary roots and memory files. */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeMemoryDir, dshMemoryDir } from "../lib/keys.js";

/** A temporary home with a dsh store and a Claude Code home inside it. */
export async function makeRoots() {
  const home = await mkdtemp(join(tmpdir(), "dsh-unified-memory-test-"));
  const roots = {
    home,
    dshRoot: join(home, ".dsh", "memory"),
    claudeRoot: join(home, ".claude"),
    indexDir: join(home, ".cache", "dsh-unified-memory"),
    aliases: {},
  };
  return { ...roots, roots, cleanup: () => rm(home, { recursive: true, force: true }) };
}

/** Write a memory file (raw content) and optionally its index line. */
export async function putMemory(dir, file, content, indexLine = true) {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, file), content);
  if (indexLine) {
    const indexPath = join(dir, "MEMORY.md");
    let index = "# Memory Index\n\n";
    try {
      index = await readFile(indexPath, "utf8");
    } catch {
      // New index.
    }
    await writeFile(indexPath, `${index.replace(/\n*$/, "\n")}- [${file.replace(/\.md$/, "")}](${file}) — hook for ${file}\n`);
  }
}

/** A Claude Code-authored memory in the old top-level style, with fields dsh does not know. */
export function claudeOld(name, description, extra = "") {
  return `---\nname: ${name}\ndescription: ${description}\ntype: feedback\noriginSessionId: 3f2a9c1e-5b7d-4e8a-9c0b-1d2e3f4a5b6c\n${extra}---\nBody of ${name}.\n`;
}

/** A Claude Code-authored memory in the current metadata style. */
export function claudeNew(name, description, type = "project") {
  return `---\nname: ${name}\ndescription: ${description}\nmetadata:\n  type: ${type}\n---\nBody of ${name}.\n`;
}

/** A dsh-authored memory. */
export function dshMade(name, description, type = "project") {
  return `---\nname: ${name}\ndescription: ${description}\nmetadata:\n  type: ${type}\n  origin: dsh\n  originSessionId: session-1\n---\nBody of ${name}.\n`;
}

export { claudeMemoryDir, dshMemoryDir };

/**
 * Which folders a session reads and writes in each mode.
 *
 * | mode    | writes            | reads and searches                      |
 * |---------|-------------------|-----------------------------------------|
 * | dsh     | dsh store         | dsh store                               |
 * | overlay | dsh store         | dsh store, then Claude Code (read-only) |
 * | shared  | Claude Code       | Claude Code                             |
 *
 * Every mode also reads the legacy user-level folder (`<dshRoot>/*.md`,
 * written by versions before modes) read-only, until `mem move-legacy`
 * folds it into a project.
 *
 * @module dsh-unified-memory/layout
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { claudeMemoryDir, dirExists, dshMemoryDir, resolveKey } from "./keys.js";
import { INDEX_FILE } from "./store.js";

/**
 * @typedef {{dir: string, source: "dsh" | "claude" | "legacy", side: "dsh" | "claude", writable: boolean}} Folder
 */

/** Whether the legacy user-level folder holds memories. */
export async function hasLegacy(dshRoot) {
  try {
    return (await readdir(dshRoot)).some((name) => name.endsWith(".md") && name !== INDEX_FILE);
  } catch {
    return false;
  }
}

/**
 * Resolve the folders for a session directory.
 * @param {string} cwd - session directory ("" when unknown).
 * @param {string} mode - the effective mode.
 * @param {{dshRoot: string, claudeRoot: string, aliases?: Record<string, string>, home?: string}} roots
 * @returns {Promise<{key: string | null, write: Folder | null, read: Folder[]}>}
 */
export async function foldersFor(cwd, mode, roots) {
  const read = [];
  let write = null;
  const key = cwd ? await resolveKey(cwd, roots) : null;
  if (key) {
    const dsh = { dir: dshMemoryDir(roots.dshRoot, key), source: "dsh", side: "dsh", writable: true };
    const claude = { dir: claudeMemoryDir(roots.claudeRoot, key), source: "claude", side: "claude", writable: mode === "shared" };
    if (mode === "shared") {
      write = claude;
      read.push(claude);
    } else {
      write = dsh;
      read.push(dsh);
      if (mode === "overlay") read.push(claude);
    }
  }
  if (await hasLegacy(roots.dshRoot)) read.push({ dir: roots.dshRoot, source: "legacy", side: "dsh", writable: false });
  return { key, write, read };
}

/** Project keys with a folder in the dsh store. */
export async function dshKeys(dshRoot) {
  try {
    const entries = await readdir(join(dshRoot, "projects"), { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch {
    return [];
  }
}

/** Project keys with a Claude Code memory folder. */
export async function claudeKeys(claudeRoot) {
  let entries;
  try {
    entries = await readdir(join(claudeRoot, "projects"), { withFileTypes: true });
  } catch {
    return [];
  }
  const keys = [];
  for (const entry of entries) {
    if (entry.isDirectory() && (await dirExists(claudeMemoryDir(claudeRoot, entry.name)))) keys.push(entry.name);
  }
  return keys.sort();
}

/**
 * Every folder the given mode writes to (the store side), for bulk
 * operations like list and purge.
 * @returns {Promise<Array<{key: string, dir: string, side: "dsh" | "claude"}>>}
 */
export async function storeFolders(mode, roots) {
  if (mode === "shared") {
    return (await claudeKeys(roots.claudeRoot)).map((key) => ({ key, dir: claudeMemoryDir(roots.claudeRoot, key), side: "claude" }));
  }
  return (await dshKeys(roots.dshRoot)).map((key) => ({ key, dir: dshMemoryDir(roots.dshRoot, key), side: "dsh" }));
}

/**
 * Project keys and memory-folder resolution, matching Claude Code.
 *
 * Claude Code (verified against 2.1.282) stores auto-memory under
 * `<claudeRoot>/projects/<key>/memory`, where the key is derived from the
 * canonical git root of the launch directory (a worktree maps to its main
 * checkout), or the launch directory itself outside a repository:
 *
 *   key = path with every non-alphanumeric character replaced by `-`;
 *         when longer than 200 characters, the first 200 plus `-` plus a
 *         base-36 hash of the original path.
 *
 * dsh sessions often start in a subdirectory of the folder Claude Code was
 * launched from, so resolution walks from the session's root up to the
 * nearest ancestor that already has a memory folder, stopping at the home
 * directory.
 *
 * @module dsh-unified-memory/keys
 */

import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Claude Code's key length cap before a hash suffix is appended. */
export const KEY_MAX_LENGTH = 200;

/**
 * Claude Code's 32-bit string hash (Java `String.hashCode` over UTF-16 code units).
 * @param {string} text
 * @returns {number}
 */
export function claudeHash(text) {
  let hash = 0;
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  return hash;
}

/**
 * The project key Claude Code uses for a directory path.
 * @param {string} path - absolute directory path.
 * @returns {string}
 */
export function projectKey(path) {
  const key = path.replace(/[^a-zA-Z0-9]/g, "-");
  if (key.length <= KEY_MAX_LENGTH) return key;
  return `${key.slice(0, KEY_MAX_LENGTH)}-${Math.abs(claudeHash(path)).toString(36)}`;
}

/** Apply a configured alias mapping (raw key to canonical key). */
export function aliasKey(key, aliases = {}) {
  return aliases[key] ?? key;
}

const rootCache = new Map();

/**
 * The canonical root Claude Code keys a directory by: the main checkout of
 * its git repository (worktrees resolve to the main checkout), or the
 * directory itself when it is not inside a repository.
 * @param {string} cwd - absolute directory.
 * @returns {Promise<string>}
 */
export async function canonicalRoot(cwd) {
  const dir = resolve(cwd);
  const cached = rootCache.get(dir);
  if (cached !== undefined) return cached;
  let root = dir;
  try {
    const opts = { cwd: dir, windowsHide: true, timeout: 5000 };
    const common = (await run("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], opts)).stdout.trim();
    if (common && basename(common) === ".git") {
      root = dirname(common);
    } else {
      // Submodules and unusual layouts: fall back to the working tree root.
      const top = (await run("git", ["rev-parse", "--show-toplevel"], opts)).stdout.trim();
      if (top) root = top;
    }
  } catch {
    // Not a repository, or git unavailable: key by the directory itself.
  }
  rootCache.set(dir, root);
  return root;
}

/** Forget cached git roots (tests). */
export function clearRootCache() {
  rootCache.clear();
}

/**
 * The directory and its ancestors, nearest first. Stops at the home
 * directory (inclusive) when the directory is inside it, so a session never
 * resolves to a key for `/` or `/home`.
 * @param {string} dir - absolute directory.
 * @param {string} [home]
 * @returns {string[]}
 */
export function ancestry(dir, home = homedir()) {
  const out = [];
  const start = resolve(dir);
  const stopAtHome = start === home || start.startsWith(home.endsWith(sep) ? home : home + sep);
  let current = start;
  for (;;) {
    out.push(current);
    if (stopAtHome && current === home) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return out;
}

/** Whether a directory exists. */
export async function dirExists(dir) {
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

/** Claude Code's memory folder for a key. */
export function claudeMemoryDir(claudeRoot, key) {
  return join(claudeRoot, "projects", key, "memory");
}

/** The dsh store's folder for a key. */
export function dshMemoryDir(dshRoot, key) {
  return join(dshRoot, "projects", key);
}

/**
 * Resolve the project key for a session directory: walk from its canonical
 * root upward and take the nearest ancestor whose key already has a memory
 * folder on either side (Claude Code's or the dsh store's), so keys line up
 * with the folders Claude Code actually uses. Without any match, the root's
 * own key is used and its folder is created on first write.
 * @param {string} cwd - session directory.
 * @param {{dshRoot: string, claudeRoot: string, aliases?: Record<string, string>, home?: string}} roots
 * @returns {Promise<string>}
 */
export async function resolveKey(cwd, roots) {
  const { dshRoot, claudeRoot, aliases = {}, home = homedir() } = roots;
  const root = await canonicalRoot(cwd);
  for (const dir of ancestry(root, home)) {
    const key = aliasKey(projectKey(dir), aliases);
    if (await dirExists(claudeMemoryDir(claudeRoot, key))) return key;
    if (await dirExists(dshMemoryDir(dshRoot, key))) return key;
  }
  return aliasKey(projectKey(root), aliases);
}

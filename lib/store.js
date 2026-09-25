/**
 * Storage layer: memory files in Claude Code's format, the MEMORY.md index,
 * and provenance.
 *
 * A memory folder holds `<name>.md` files (YAML frontmatter + markdown body)
 * and a `MEMORY.md` index with one `- [Title](file.md) — hook` line per
 * memory. Files this plugin creates carry provenance under `metadata:`
 * (`origin: dsh`, `originSessionId`, `modified`); edits to files it did not
 * create add `updatedBy: dsh`. Existing files are edited line by line
 * (see `editFrontmatter`), so fields this plugin does not know survive.
 *
 * @module dsh-unified-memory/store
 */

import { randomBytes } from "node:crypto";
import { cp, mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { editFrontmatter, parseFrontmatter, renderMemoryFile } from "./frontmatter.js";

/** Index file name (Claude Code compatible). */
export const INDEX_FILE = "MEMORY.md";

/** Default read limits for MEMORY.md (Claude Code: 200 lines / 25 KB). */
export const INDEX_LINE_LIMIT = 200;
export const INDEX_BYTE_LIMIT = 25_000;

/** Default cap on memory files listed (Claude Code: 200). */
export const DEFAULT_MAX_LIST = 200;

/** Frontmatter lines read when scanning a folder. */
const SCAN_HEAD_LINES = 40;

/** Memory types (Claude Code's four). */
export const MEMORY_TYPES = ["user", "feedback", "project", "reference"];

/** Provenance value this plugin writes. */
export const DSH_ORIGIN = "dsh";

/** Expand a leading `~/` in a configured path. */
export function expandHome(path, home = homedir()) {
  if (typeof path !== "string" || path.length === 0) return path;
  if (path === "~") return home;
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(home, path.slice(2));
  return path;
}

/**
 * Validate a memory name as a safe single path segment (no separators,
 * traversal, null bytes, or dot-prefix).
 * @param {string} name
 * @returns {string} the name with a trailing `.md` appended when missing.
 */
export function validateMemoryName(name) {
  if (typeof name !== "string" || name.trim().length === 0) throw new Error("memory name must be a non-empty string");
  const trimmed = name.trim();
  if (trimmed.includes("\x00")) throw new Error(`invalid memory name ${JSON.stringify(name)}: null byte`);
  if (trimmed.includes("/") || trimmed.includes("\\")) throw new Error(`invalid memory name ${JSON.stringify(name)}: path separators are not allowed`);
  if (trimmed.startsWith(".")) throw new Error(`invalid memory name ${JSON.stringify(name)}: dot-prefixed names are not allowed`);
  if (trimmed === INDEX_FILE) throw new Error(`invalid memory name ${JSON.stringify(name)}: reserved for the index`);
  return trimmed.toLowerCase().endsWith(".md") ? trimmed : `${trimmed}.md`;
}

/** The `metadata:` mapping of parsed frontmatter, or an empty object. */
export function metaOf(data) {
  const meta = data?.metadata;
  return meta && typeof meta === "object" && !Array.isArray(meta) ? meta : {};
}

/** Frontmatter type, flat (`type:`) or nested (`metadata: type:`). */
export function typeOf(data) {
  if (typeof data?.type === "string") return data.type;
  const type = metaOf(data).type;
  return typeof type === "string" ? type : null;
}

/**
 * Who created a memory. An explicit `metadata.origin` wins; without one, the
 * folder decides: files in Claude Code's folders are Claude Code's, files in
 * the dsh store are dsh's (the pre-provenance plugin wrote them).
 * @param {Record<string, unknown>} data - parsed frontmatter.
 * @param {"claude" | "dsh"} side - which kind of folder the file is in.
 * @returns {string}
 */
export function originOf(data, side) {
  const origin = metaOf(data).origin;
  if (typeof origin === "string" && origin.length > 0) return origin;
  return side === "dsh" ? DSH_ORIGIN : "claude";
}

/**
 * Scan a memory folder: `.md` files except MEMORY.md, frontmatter read from
 * the first lines, newest first, capped.
 * @param {string} dir
 * @param {number} [cap]
 * @returns {Promise<Array<{filename: string, filePath: string, mtimeMs: number, name: string, description: string | null, type: string | null, data: Record<string, unknown>}>>}
 */
export async function scanMemoryFiles(dir, cap = DEFAULT_MAX_LIST) {
  let names;
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const files = names.filter((name) => name.endsWith(".md") && name !== INDEX_FILE && !name.startsWith("."));
  const settled = await Promise.allSettled(files.map(async (filename) => {
    const filePath = join(dir, filename);
    const [content, meta] = await Promise.all([readFile(filePath, "utf8"), stat(filePath)]);
    const { data } = parseFrontmatter(content.split("\n").slice(0, SCAN_HEAD_LINES).join("\n"));
    return {
      filename,
      filePath,
      mtimeMs: meta.mtimeMs,
      name: typeof data.name === "string" ? data.name : filename.replace(/\.md$/i, ""),
      description: typeof data.description === "string" ? data.description : null,
      type: typeOf(data),
      data,
    };
  }));
  return settled
    .filter((r) => r.status === "fulfilled")
    .map((r) => r.value)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, cap);
}

/**
 * Format scanned entries as a list: `- [type] file (ISO date): description`.
 * @param {Array<{filename: string, type: string | null, mtimeMs: number, description: string | null}>} entries
 */
export function formatIndexList(entries) {
  return entries.map((entry) => {
    const type = entry.type ? `[${entry.type}] ` : "";
    const date = new Date(entry.mtimeMs).toISOString();
    return entry.description ? `- ${type}${entry.filename} (${date}): ${entry.description}` : `- ${type}${entry.filename} (${date})`;
  }).join("\n");
}

/**
 * Read a MEMORY.md index trimmed to the read limits (frontmatter and HTML
 * comments excluded from the count, as Claude Code measures).
 * @param {string} dir
 * @param {number} [lineLimit]
 * @param {number} [byteLimit]
 * @returns {Promise<{content: string, path: string, exists: boolean}>}
 */
export async function readMemoryIndex(dir, lineLimit = INDEX_LINE_LIMIT, byteLimit = INDEX_BYTE_LIMIT) {
  const indexPath = join(dir, INDEX_FILE);
  try {
    const raw = await readFile(indexPath, "utf8");
    const measurable = raw.replace(/^---[\s\S]*?---\r?\n?/, "").replace(/<!--[\s\S]*?-->/g, "");
    const kept = [];
    let bytes = 0;
    for (const line of measurable.split("\n")) {
      const size = Buffer.byteLength(line, "utf8") + 1;
      if (kept.length >= lineLimit || bytes + size > byteLimit) break;
      kept.push(line);
      bytes += size;
    }
    return { content: kept.join("\n"), path: indexPath, exists: true };
  } catch {
    return { content: "", path: indexPath, exists: false };
  }
}

/**
 * Read one memory file.
 * @param {string} dir
 * @param {string} name - validated file name.
 * @returns {Promise<{content: string, data: Record<string, unknown>, body: string, filePath: string, exists: boolean}>}
 */
export async function readMemoryFile(dir, name) {
  const filePath = join(dir, name);
  try {
    const content = await readFile(filePath, "utf8");
    const { data, body } = parseFrontmatter(content);
    return { content, data, body, filePath, exists: true };
  } catch {
    return { content: "", data: {}, body: "", filePath, exists: false };
  }
}

/** Atomic replace: random-suffix sibling with exclusive create, then rename. */
export async function writeFileAtomic(filePath, content) {
  await mkdir(dirname(filePath), { recursive: true });
  const tmp = join(dirname(filePath), `.${basename(filePath)}.${randomBytes(6).toString("hex")}.tmp`);
  await writeFile(tmp, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
  try {
    await rename(tmp, filePath);
  } catch (error) {
    await unlink(tmp).catch(() => {});
    throw error;
  }
}

/** Serialize writes to one memory folder within this process. */
const writeChains = new Map();

/**
 * Run an operation exclusively on a folder's write chain. Claude Code takes
 * no lock, so this only orders this process's own writes; the index helpers
 * re-read MEMORY.md immediately before writing it to keep the window for a
 * lost concurrent edit small.
 * @template T
 * @param {string} dir
 * @param {() => Promise<T>} op
 * @returns {Promise<T>}
 */
export function withDirLock(dir, op) {
  const chain = writeChains.get(dir) ?? Promise.resolve();
  const next = chain.then(op, op);
  writeChains.set(dir, next.catch(() => {}));
  return next;
}

/** Index line matcher for a memory file name. */
function indexLineFor(name) {
  return `](${name})`;
}

/** Collapse blank runs and end with one newline. */
function tidyIndex(lines) {
  const cleaned = lines.filter((line, i, arr) => !(line.trim() === "" && (i === 0 || arr[i - 1].trim() === "")));
  return cleaned.join("\n").replace(/\n+$/, "") + "\n";
}

/**
 * Add or replace the MEMORY.md line for one file. Reads the index right
 * before writing so a concurrent edit by another process is kept unless it
 * lands inside that short window.
 * @param {string} dir
 * @param {string} file - memory file name.
 * @param {string} title - the link text.
 * @param {string} hook - the one-line description.
 */
export async function upsertIndexLine(dir, file, title, hook) {
  const indexPath = join(dir, INDEX_FILE);
  let lines;
  try {
    lines = (await readFile(indexPath, "utf8")).split("\n");
  } catch {
    lines = ["# Memory Index", ""];
  }
  const entry = `- [${title}](${file}) — ${hook ?? ""}`.trimEnd();
  const hit = lines.findIndex((line) => line.includes(indexLineFor(file)));
  if (hit === -1) {
    while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
    if (lines.length > 0 && lines[lines.length - 1].startsWith("#")) lines.push("");
    lines.push(entry);
  } else {
    lines[hit] = entry;
  }
  await writeFileAtomic(indexPath, tidyIndex(lines));
}

/**
 * Remove the MEMORY.md line for one file (re-read right before writing).
 * @returns {Promise<string | null>} the removed line, if there was one.
 */
export async function removeIndexLine(dir, file) {
  const indexPath = join(dir, INDEX_FILE);
  let lines;
  try {
    lines = (await readFile(indexPath, "utf8")).split("\n");
  } catch {
    return null;
  }
  const hit = lines.findIndex((line) => line.includes(indexLineFor(file)));
  if (hit === -1) return null;
  const [removed] = lines.splice(hit, 1);
  await writeFileAtomic(indexPath, tidyIndex(lines));
  return removed;
}

/** The MEMORY.md line for one file, if present. */
export async function indexLineOf(dir, file) {
  try {
    const lines = (await readFile(join(dir, INDEX_FILE), "utf8")).split("\n");
    return lines.find((line) => line.includes(indexLineFor(file))) ?? null;
  } catch {
    return null;
  }
}

/** Append a raw index line (used when a move carries an existing line along). */
async function appendIndexLine(dir, file, line) {
  const indexPath = join(dir, INDEX_FILE);
  let lines;
  try {
    lines = (await readFile(indexPath, "utf8")).split("\n");
  } catch {
    lines = ["# Memory Index", ""];
  }
  const hit = lines.findIndex((existing) => existing.includes(indexLineFor(file)));
  if (hit !== -1) lines[hit] = line;
  else {
    while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
    if (lines.length > 0 && lines[lines.length - 1].startsWith("#")) lines.push("");
    lines.push(line);
  }
  await writeFileAtomic(indexPath, tidyIndex(lines));
}

/**
 * Create a new memory file written by dsh, with provenance, and index it.
 * Fails when the file already exists.
 * @param {string} dir
 * @param {string} file - validated file name.
 * @param {{name: string, description: string, type: string, body: string, sessionId?: string, now?: string}} memory
 * @returns {Promise<string>} the file path.
 */
export function createMemory(dir, file, memory) {
  return withDirLock(dir, async () => {
    const filePath = join(dir, file);
    try {
      await stat(filePath);
      throw new Error(`memory ${file} already exists`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const metadata = { type: memory.type, origin: DSH_ORIGIN };
    if (memory.sessionId) metadata.originSessionId = memory.sessionId;
    metadata.modified = memory.now ?? new Date().toISOString();
    const data = { name: memory.name, description: memory.description, metadata };
    await writeFileAtomic(filePath, renderMemoryFile(data, memory.body));
    await upsertIndexLine(dir, file, memory.name, memory.description);
    return filePath;
  });
}

/**
 * Update an existing memory in place. Only the given fields change; every
 * other frontmatter line is kept. The type and modified time are written
 * where the file already keeps them (top level for older files, under
 * `metadata:` otherwise). A file dsh did not create gains `updatedBy: dsh`.
 * @param {string} dir
 * @param {string} file
 * @param {{description?: string, type?: string, body?: string, now?: string}} patch
 * @param {"claude" | "dsh"} side - the kind of folder, for provenance defaults.
 * @returns {Promise<string>} the file path.
 */
export function updateMemory(dir, file, patch, side) {
  return withDirLock(dir, async () => {
    const found = await readMemoryFile(dir, file);
    if (!found.exists) throw new Error(`memory ${file} not found`);
    const { data } = found;
    const set = {};
    const setMeta = {};
    if (patch.description !== undefined) set.description = patch.description;
    if (patch.type !== undefined) {
      if (typeof data.type === "string") set.type = patch.type;
      else setMeta.type = patch.type;
    }
    const now = patch.now ?? new Date().toISOString();
    if (data.modified !== undefined) set.modified = now;
    else setMeta.modified = now;
    if (originOf(data, side) !== DSH_ORIGIN) setMeta.updatedBy = DSH_ORIGIN;
    const content = editFrontmatter(found.content, {
      set,
      setMeta,
      ...(patch.body !== undefined ? { body: `${patch.body.trim()}\n` } : {}),
    });
    await writeFileAtomic(found.filePath, content);
    if (patch.description !== undefined) {
      const title = typeof data.name === "string" ? data.name : file.replace(/\.md$/i, "");
      await upsertIndexLine(dir, file, title, patch.description);
    }
    return found.filePath;
  });
}

/**
 * Delete a memory and its index line. With `trashDir`, the file is moved
 * there instead of removed (used for files dsh did not create).
 * @param {string} dir
 * @param {string} file
 * @param {{trashDir?: string}} [options]
 * @returns {Promise<{deleted: boolean, trashedTo?: string}>}
 */
export function deleteMemory(dir, file, options = {}) {
  return withDirLock(dir, async () => {
    const filePath = join(dir, file);
    try {
      await stat(filePath);
    } catch {
      return { deleted: false };
    }
    let trashedTo;
    if (options.trashDir) {
      trashedTo = join(options.trashDir, file);
      await mkdir(options.trashDir, { recursive: true });
      await cp(filePath, trashedTo, { preserveTimestamps: true });
    }
    await unlink(filePath);
    await removeIndexLine(dir, file);
    return trashedTo ? { deleted: true, trashedTo } : { deleted: true };
  });
}

/** A file name not yet taken in `dir`: `name.md`, then `name-<suffix>.md`, `name-<suffix>-2.md`, ... */
export async function freeName(dir, file, suffix, taken = new Set()) {
  const stem = file.replace(/\.md$/i, "");
  const exists = async (candidate) => {
    if (taken.has(candidate)) return true;
    try {
      await stat(join(dir, candidate));
      return true;
    } catch {
      return false;
    }
  };
  if (!(await exists(file))) return file;
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? `${stem}-${suffix}.md` : `${stem}-${suffix}-${n}.md`;
    if (!(await exists(candidate))) return candidate;
  }
}

/**
 * Move a memory between folders: the file (with optional metadata edits)
 * and its index line. The destination name must be free.
 * @param {{fromDir: string, file: string, toDir: string, toFile?: string, setMeta?: Record<string, unknown>, unsetMeta?: string[]}} move
 */
export async function moveMemory({ fromDir, file, toDir, toFile = file, setMeta = {}, unsetMeta = [] }) {
  const found = await readMemoryFile(fromDir, file);
  if (!found.exists) throw new Error(`memory ${file} not found in ${fromDir}`);
  const edits = Object.keys(setMeta).length > 0 || unsetMeta.length > 0;
  const content = edits ? editFrontmatter(found.content, { setMeta, unsetMeta }) : found.content;
  const line = await indexLineOf(fromDir, file);
  await withDirLock(toDir, async () => {
    await writeFileAtomic(join(toDir, toFile), content);
    const title = typeof found.data.name === "string" ? found.data.name : toFile.replace(/\.md$/i, "");
    if (line && toFile === file) await appendIndexLine(toDir, toFile, line);
    else await upsertIndexLine(toDir, toFile, title, typeof found.data.description === "string" ? found.data.description : "");
  });
  await withDirLock(fromDir, async () => {
    await unlink(join(fromDir, file));
    await removeIndexLine(fromDir, file);
  });
}

/**
 * Copy a memory into another folder with metadata edits, and index it.
 * @param {{fromDir: string, file: string, toDir: string, toFile?: string, setMeta?: Record<string, unknown>}} copy
 */
export async function copyMemory({ fromDir, file, toDir, toFile = file, setMeta = {} }) {
  const found = await readMemoryFile(fromDir, file);
  if (!found.exists) throw new Error(`memory ${file} not found in ${fromDir}`);
  const content = editFrontmatter(found.content, { setMeta });
  await withDirLock(toDir, async () => {
    await writeFileAtomic(join(toDir, toFile), content);
    const title = typeof found.data.name === "string" ? found.data.name : toFile.replace(/\.md$/i, "");
    await upsertIndexLine(toDir, toFile, title, typeof found.data.description === "string" ? found.data.description : "");
  });
}

/** Remove a folder when it holds nothing but an index without entries. */
export async function removeIfEmpty(dir) {
  let names;
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  const memories = names.filter((name) => name.endsWith(".md") && name !== INDEX_FILE);
  if (memories.length > 0) return;
  const others = names.filter((name) => name !== INDEX_FILE);
  if (others.length > 0) return;
  try {
    const index = await readFile(join(dir, INDEX_FILE), "utf8");
    if (/\]\([^)]+\.md\)/.test(index)) return;
  } catch {
    // No index.
  }
  await rm(dir, { recursive: true, force: true });
}

/** Normalized word set for duplicate detection. */
function words(text) {
  return new Set((String(text ?? "").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length >= 3));
}

/**
 * Existing memories that look like duplicates of a new one: the same file
 * name, or name + description word overlap (Jaccard) at or above `threshold`.
 * @param {Array<{filename: string, name: string, description: string | null}>} entries
 * @param {{file: string, name: string, description: string}} candidate
 * @param {number} [threshold]
 */
export function findSimilar(entries, candidate, threshold = 0.5) {
  const mine = words(`${candidate.name} ${candidate.description}`);
  const out = [];
  for (const entry of entries) {
    if (entry.filename === candidate.file) {
      out.push({ entry, score: 1 });
      continue;
    }
    const theirs = words(`${entry.name} ${entry.description ?? ""}`);
    let shared = 0;
    for (const w of mine) if (theirs.has(w)) shared++;
    const union = mine.size + theirs.size - shared;
    const score = union === 0 ? 0 : shared / union;
    if (score >= threshold) out.push({ entry, score });
  }
  return out.sort((a, b) => b.score - a.score);
}

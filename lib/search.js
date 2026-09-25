/**
 * Full-text search over a memory directory, backed by a disposable SQLite
 * (FTS5) index.
 *
 * The markdown files stay the only source of truth. The index is derived data
 * kept outside the memory directory, rebuilt incrementally (by mtime + size),
 * and safe to delete at any time. A query rescans at most once per
 * `minResyncIntervalMs` (default {@link DEFAULT_MIN_RESYNC_INTERVAL_MS}) so a
 * burst of searches in one turn does not re-walk the directory for nothing;
 * this process's own writes bypass that floor via `reindex({force: true})`
 * and are visible to its very next search regardless. Searching lets a
 * session pay tokens only for the memories a query matches instead of
 * preloading the whole catalog into the prompt.
 *
 * Uses the built-in `node:sqlite` module, so there is no native dependency.
 *
 * @module dsh-unified-memory/search
 */

import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync, realpathSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { parseFrontmatter } from "./frontmatter.js";

/** Bump when the table layout changes; a mismatch rebuilds the index. */
const SCHEMA_VERSION = "1";
const INDEX_FILE = "MEMORY.md";

/**
 * Default floor between unforced rescans (`searchMemories`): a search re-runs
 * the directory scan only if this long has passed since the last one,
 * otherwise it queries the index as last synced. Writes made through this
 * process (`reindex`) always bypass the floor, so this process's own edits
 * are visible to its very next search regardless of the floor; the floor only
 * absorbs (a) repeated searches within one turn/session finding nothing new
 * to scan, and (b) the lag before an external change (another host's push,
 * pulled in by the sync layer, or a sibling process's own write) is noticed.
 * One minute is comfortably longer than a burst of searches in one turn and
 * comfortably shorter than any sync cadence in front of it.
 */
export const DEFAULT_MIN_RESYNC_INTERVAL_MS = 60_000;

/**
 * Default cache directory for search indexes: `$XDG_CACHE_HOME/dsh-unified-memory`
 * (never inside a memory folder).
 * @returns {string}
 */
export function defaultIndexDir() {
  return join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "dsh-unified-memory");
}

/**
 * Index location for a memory folder: one database per folder under the
 * cache directory.
 * @param {string} dir - memory folder.
 * @param {string} [indexDir] - cache directory (default {@link defaultIndexDir}).
 * @returns {string}
 */
export function defaultIndexPath(dir, indexDir = defaultIndexDir()) {
  let real = dir;
  try {
    real = realpathSync(dir);
  } catch {
    // Directory may not exist yet; hash the given path.
  }
  const key = createHash("sha1").update(real).digest("hex").slice(0, 12);
  return join(indexDir, `${key}.sqlite`);
}

function openDb(dbPath) {
  mkdirSync(join(dbPath, ".."), { recursive: true });
  const db = new DatabaseSync(dbPath);
  // Rollback journal, not WAL: one self-contained file (a plain copy is complete) and an existing WAL-mode index is converted on open.
  db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = DELETE;");
  return db;
}

function ensureSchema(db, dir) {
  db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)");
  const get = (key) => db.prepare("SELECT value FROM meta WHERE key = ?").get(key)?.value;
  if (get("schema") !== SCHEMA_VERSION || get("dir") !== dir) {
    db.exec("DROP TABLE IF EXISTS docs; DROP TABLE IF EXISTS fts;");
    db.prepare("INSERT OR REPLACE INTO meta VALUES ('schema', ?)").run(SCHEMA_VERSION);
    db.prepare("INSERT OR REPLACE INTO meta VALUES ('dir', ?)").run(dir);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS docs (
      id INTEGER PRIMARY KEY,
      file TEXT NOT NULL UNIQUE,
      mtime REAL NOT NULL,
      size INTEGER NOT NULL,
      type TEXT,
      description TEXT
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(name, description, body, tokenize = 'porter unicode61');
  `);
}

/** Frontmatter `type`, flat (`type:`) or nested (`metadata: type:`). */
function typeOf(data) {
  if (typeof data.type === "string") return data.type;
  const meta = data.metadata;
  return typeof meta === "object" && meta !== null && typeof meta.type === "string" ? meta.type : null;
}

/**
 * Bring the index in line with the directory: index new or changed files
 * (mtime or size differs), drop deleted ones. Unchanged files are not read.
 * Skips the scan entirely (returning the index as last synced) when called
 * unforced within `minResyncIntervalMs` of the last scan - see
 * {@link DEFAULT_MIN_RESYNC_INTERVAL_MS}.
 * @param {DatabaseSync} db
 * @param {string} dir
 * @param {{force?: boolean, minResyncIntervalMs?: number}} [options]
 * @returns {Promise<{indexed: number, removed: number, total: number, skipped: boolean}>}
 */
async function syncIndex(db, dir, options = {}) {
  const { force = false, minResyncIntervalMs = 0 } = options;
  if (!force && minResyncIntervalMs > 0) {
    const syncedAt = Number(db.prepare("SELECT value FROM meta WHERE key = 'synced_at'").get()?.value ?? 0);
    if (Date.now() - syncedAt < minResyncIntervalMs) {
      const total = db.prepare("SELECT count(*) AS n FROM docs").get().n;
      return { indexed: 0, removed: 0, total, skipped: true };
    }
  }
  let names = [];
  try {
    // Flat scan: memory folders are flat, and Claude Code keeps other data in subfolders.
    names = (await readdir(dir)).filter((n) => n.endsWith(".md") && n !== INDEX_FILE && !n.startsWith("."));
  } catch {
    // Missing directory: the index becomes empty.
  }
  const known = new Map(db.prepare("SELECT id, file, mtime, size FROM docs").all().map((r) => [r.file, r]));
  const seen = new Set();
  const changed = [];
  for (const file of names) {
    try {
      const meta = await stat(join(dir, file));
      seen.add(file);
      const prior = known.get(file);
      if (!prior || prior.mtime !== meta.mtimeMs || prior.size !== meta.size) changed.push({ file, mtime: meta.mtimeMs, size: meta.size });
    } catch {
      // Vanished between readdir and stat; treated as removed below.
    }
  }
  const removed = [...known.values()].filter((r) => !seen.has(r.file));

  const loaded = [];
  for (const item of changed) {
    try {
      const { data, body } = parseFrontmatter(await readFile(join(dir, item.file), "utf8"));
      loaded.push({
        ...item,
        name: typeof data.name === "string" ? data.name : basename(item.file, ".md"),
        description: typeof data.description === "string" ? data.description : "",
        type: typeOf(data),
        body,
      });
    } catch {
      // Unreadable file: skip it this round.
    }
  }

  if (loaded.length > 0 || removed.length > 0) {
    db.exec("BEGIN");
    try {
      for (const row of removed) {
        db.prepare("DELETE FROM fts WHERE rowid = ?").run(row.id);
        db.prepare("DELETE FROM docs WHERE id = ?").run(row.id);
      }
      for (const doc of loaded) {
        const prior = known.get(doc.file);
        if (prior) {
          db.prepare("DELETE FROM fts WHERE rowid = ?").run(prior.id);
          db.prepare("DELETE FROM docs WHERE id = ?").run(prior.id);
        }
        const { lastInsertRowid } = db
          .prepare("INSERT INTO docs (file, mtime, size, type, description) VALUES (?, ?, ?, ?, ?)")
          .run(doc.file, doc.mtime, doc.size, doc.type, doc.description);
        db.prepare("INSERT INTO fts (rowid, name, description, body) VALUES (?, ?, ?, ?)").run(lastInsertRowid, doc.name, doc.description, doc.body);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  db.prepare("INSERT OR REPLACE INTO meta VALUES ('synced_at', ?)").run(String(Date.now()));
  return { indexed: loaded.length, removed: removed.length, total: seen.size, skipped: false };
}

const STOPWORDS = new Set(
  ("a an and are as at be but by can did do does for from had has have how i if in into is it its just like may me my no not nothing of on or our so some " +
    "such than that the their them then there these they this to too up us was we were what when where which who why will with would you your about any all also get got").split(" "),
);

/** Words this long or longer also match as a prefix (`server` finds `servers`). */
const PREFIX_MIN_LENGTH = 4;

/**
 * Turn free text into a safe FTS5 query: stopwords dropped, each remaining
 * word quoted (long words also as a prefix), OR-ed together so partial overlap
 * still ranks; bm25 orders by fit.
 * @param {string} text
 * @returns {string} empty when the text has no searchable word.
 */
export function toMatchQuery(text) {
  const words = String(text ?? "").match(/[\p{L}\p{N}]+/gu) ?? [];
  const terms = [...new Set(words.map((w) => w.toLowerCase()).filter((w) => w.length >= 2 && !STOPWORDS.has(w)))];
  return terms.map((w) => (w.length >= PREFIX_MIN_LENGTH ? `"${w}"*` : `"${w}"`)).join(" OR ");
}

/**
 * Hits weaker than this fraction of the best hit's strength are dropped, which
 * trims the long tail. There is deliberately no absolute floor: bm25 scores a
 * term that appears in most files (the corpus's dominant topic) near zero, so
 * an absolute cutoff would make queries about that topic return nothing.
 * "No match" is instead the honest case where no file contains any keyword.
 */
const RELATIVE_CUTOFF = 0.5;

/**
 * Search a memory directory. Results are ranked best first and paged: the
 * relevance trim is anchored to the best hit over the whole result set, so
 * every page comes from the same ordered list and `offset` walks through all
 * of it.
 * @param {string} dir - memory directory.
 * @param {string} query - free-text query.
 * @param {{limit?: number, offset?: number, type?: string | null, indexPath?: string, minResyncIntervalMs?: number}} [options]
 * @returns {Promise<{hits: Array<{file: string, type: string | null, description: string, score: number}>, total: number, offset: number, empty: boolean}>}
 *   `total` is the number of relevant matches across all pages; `empty` is
 *   true when the query had no searchable keyword at all (only stopwords or
 *   punctuation).
 */
export async function searchMemories(dir, query, options = {}) {
  const match = toMatchQuery(query);
  const offset = Math.max(0, Math.floor(options.offset ?? 0));
  if (!match) return { hits: [], total: 0, offset, empty: true };
  const db = openDb(options.indexPath ?? defaultIndexPath(dir, options.indexDir));
  try {
    ensureSchema(db, dir);
    await syncIndex(db, dir, { minResyncIntervalMs: options.minResyncIntervalMs ?? DEFAULT_MIN_RESYNC_INTERVAL_MS });
    const params = [match];
    let where = "fts MATCH ?";
    if (options.type) {
      where += " AND d.type = ?";
      params.push(options.type);
    }
    const ranked =
      "SELECT d.file AS file, d.type AS type, d.description AS description, d.mtime AS mtime, bm25(fts, 6.0, 4.0, 1.0) AS score " +
      `FROM fts JOIN docs d ON d.id = fts.rowid WHERE ${where}`;
    const best = db.prepare(`${ranked} ORDER BY score LIMIT 1`).get(...params);
    if (!best) return { hits: [], total: 0, offset, empty: false };
    const floor = best.score * RELATIVE_CUTOFF;
    const total = db.prepare(`SELECT count(*) AS n FROM (${ranked}) WHERE score <= ?`).get(...params, floor).n;
    const limit = Math.max(1, Math.min(Math.floor(options.limit ?? 5), 100));
    const hits = db
      .prepare(`SELECT file, type, description, score FROM (${ranked}) WHERE score <= ? ORDER BY score, mtime DESC LIMIT ? OFFSET ?`)
      .all(...params, floor, limit, offset)
      .map((r) => ({ file: r.file, type: r.type, description: r.description, score: r.score }));
    return { hits, total, offset, empty: false };
  } finally {
    db.close();
  }
}

/**
 * Force an incremental sync and report what changed - bypasses
 * {@link DEFAULT_MIN_RESYNC_INTERVAL_MS}. Used by the CLI, and by this
 * process's own add/update/delete actions so a write is visible to this
 * process's very next search regardless of the unforced floor elsewhere.
 * @param {string} dir
 * @param {{indexPath?: string, rebuild?: boolean}} [options]
 */
export async function reindex(dir, options = {}) {
  const dbPath = options.indexPath ?? defaultIndexPath(dir, options.indexDir);
  const db = openDb(dbPath);
  try {
    ensureSchema(db, dir);
    if (options.rebuild) db.exec("DELETE FROM fts; DELETE FROM docs;");
    return { ...(await syncIndex(db, dir, { force: true })), indexPath: dbPath };
  } finally {
    db.close();
  }
}

/**
 * Search several memory folders and merge the results into one ranking.
 * Each folder keeps its own index; hits are merged by bm25 score (lower is
 * better) and labeled with their source, then paged.
 * @param {Array<{dir: string, source: string}>} sources
 * @param {string} query
 * @param {{limit?: number, offset?: number, type?: string | null, indexDir?: string, minResyncIntervalMs?: number}} [options]
 * @returns {Promise<{hits: Array<{file: string, dir: string, source: string, type: string | null, description: string, score: number}>, total: number, offset: number, empty: boolean}>}
 */
export async function searchSources(sources, query, options = {}) {
  const offset = Math.max(0, Math.floor(options.offset ?? 0));
  const limit = Math.max(1, Math.min(Math.floor(options.limit ?? 5), 100));
  if (!toMatchQuery(query)) return { hits: [], total: 0, offset, empty: true };
  const all = [];
  for (const { dir, source } of sources) {
    const { hits } = await searchMemories(dir, query, { ...options, limit: 100, offset: 0 });
    for (const hit of hits) all.push({ ...hit, dir, source });
  }
  all.sort((a, b) => a.score - b.score);
  return { hits: all.slice(offset, offset + limit), total: all.length, offset, empty: false };
}

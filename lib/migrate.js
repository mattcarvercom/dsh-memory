/**
 * Mode switching, purge, and legacy moves: every bulk change is planned
 * first (a dry run prints the plan), then applied after a backup.
 *
 * Provenance decides where files go: `origin: dsh` files belong to the dsh
 * side, everything else to Claude Code. Copies of Claude Code memories taken
 * when leaving shared mode carry `copiedFrom`/`copiedAt`, so returning to
 * shared mode can drop unchanged copies instead of duplicating them.
 *
 * @module dsh-unified-memory/migrate
 */

import { cp, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { claudeMemoryDir, dshMemoryDir, dirExists } from "./keys.js";
import { claudeKeys, dshKeys, foldersFor, hasLegacy, storeFolders } from "./layout.js";
import { reindex } from "./search.js";
import { writeState } from "./state.js";
import {
  DSH_ORIGIN, INDEX_FILE, copyMemory, deleteMemory, freeName, metaOf, moveMemory, originOf,
  readMemoryFile, removeIfEmpty, scanMemoryFiles, updateMemory,
} from "./store.js";

/**
 * @typedef {object} Step
 * @property {"move" | "copy" | "drop" | "replace" | "delete"} kind
 * @property {string} key - project key.
 * @property {string} fromDir
 * @property {string} file
 * @property {string} [toDir]
 * @property {string} [toFile]
 * @property {Record<string, unknown>} [setMeta]
 * @property {string[]} [unsetMeta]
 * @property {string} reason - human-readable explanation.
 */

/**
 * @typedef {object} Plan
 * @property {string} from
 * @property {string} to
 * @property {Step[]} steps
 * @property {Array<{key: string, copy: string, original: string, dir: string}>} conflicts - edited copies needing `prefer`.
 * @property {string[]} notes - informational lines (edited Claude files that stay, deleted-upstream copies kept out).
 * @property {string[]} touched - folders whose search index must be rebuilt.
 */

const MEMORY_SCAN_CAP = 1_000_000;

/** All memories in a folder with their parsed frontmatter. */
async function filesIn(dir) {
  return scanMemoryFiles(dir, MEMORY_SCAN_CAP);
}

/**
 * Plan a mode change.
 * @param {{dshRoot: string, claudeRoot: string}} roots
 * @param {string} from - the mode the files are in now.
 * @param {string} to - the target mode.
 * @param {{clean?: boolean, prefer?: "dsh" | "claude", restoreDeleted?: boolean, now?: string}} [options]
 * @returns {Promise<Plan>}
 */
export async function planModeChange(roots, from, to, options = {}) {
  const now = options.now ?? new Date().toISOString();
  /** @type {Plan} */
  const plan = { from, to, steps: [], conflicts: [], notes: [], touched: [] };
  const touch = (dir) => {
    if (!plan.touched.includes(dir)) plan.touched.push(dir);
  };
  if (from === to) return plan;
  // dsh <-> overlay: the dsh store stays where it is; only what is read changes.
  if (from !== "shared" && to !== "shared") {
    for (const key of await claudeKeys(roots.claudeRoot)) touch(claudeMemoryDir(roots.claudeRoot, key));
    for (const key of await dshKeys(roots.dshRoot)) touch(dshMemoryDir(roots.dshRoot, key));
    return plan;
  }

  if (to === "shared") {
    // dsh store -> Claude Code folders.
    for (const key of await dshKeys(roots.dshRoot)) {
      const fromDir = dshMemoryDir(roots.dshRoot, key);
      const toDir = claudeMemoryDir(roots.claudeRoot, key);
      touch(fromDir);
      touch(toDir);
      const taken = new Set();
      for (const entry of await filesIn(fromDir)) {
        const meta = metaOf(entry.data);
        const copiedFrom = typeof meta.copiedFrom === "string" ? meta.copiedFrom : null;
        if (copiedFrom) {
          const original = await readMemoryFile(toDir, copiedFrom);
          const edited = meta.updatedBy === DSH_ORIGIN;
          if (!original.exists) {
            if (options.restoreDeleted) {
              const toFile = await freeName(toDir, copiedFrom, "dsh", taken);
              taken.add(toFile);
              plan.steps.push({ kind: "move", key, fromDir, file: entry.filename, toDir, toFile, unsetMeta: ["copiedFrom", "copiedAt"], reason: `restore ${copiedFrom}, deleted on the Claude Code side` });
            } else {
              plan.steps.push({ kind: "drop", key, fromDir, file: entry.filename, reason: `copy of ${copiedFrom}, which was deleted on the Claude Code side (pass --restore-deleted to restore it)` });
            }
          } else if (!edited) {
            plan.steps.push({ kind: "drop", key, fromDir, file: entry.filename, reason: `unchanged copy of ${copiedFrom}` });
          } else if (options.prefer === "dsh") {
            plan.steps.push({ kind: "replace", key, fromDir, file: entry.filename, toDir, toFile: copiedFrom, reason: `dsh's edited copy replaces ${copiedFrom} (--prefer dsh)` });
          } else if (options.prefer === "claude") {
            plan.steps.push({ kind: "drop", key, fromDir, file: entry.filename, reason: `edited copy of ${copiedFrom} dropped, Claude Code's version kept (--prefer claude)` });
          } else {
            plan.conflicts.push({ key, copy: entry.filename, original: copiedFrom, dir: toDir });
          }
          continue;
        }
        const toFile = await freeName(toDir, entry.filename, "dsh", taken);
        taken.add(toFile);
        const setMeta = originOf(entry.data, "dsh") === DSH_ORIGIN && metaOf(entry.data).origin === undefined ? { origin: DSH_ORIGIN } : {};
        plan.steps.push({
          kind: "move", key, fromDir, file: entry.filename, toDir, toFile, setMeta,
          reason: toFile === entry.filename ? "dsh memory moves into the shared folder" : `dsh memory moves into the shared folder, renamed (${entry.filename} exists there)`,
        });
      }
    }
    return plan;
  }

  // from shared -> overlay or dsh: dsh-created files leave the Claude Code folders.
  for (const key of await claudeKeys(roots.claudeRoot)) {
    const fromDir = claudeMemoryDir(roots.claudeRoot, key);
    const toDir = dshMemoryDir(roots.dshRoot, key);
    touch(fromDir);
    const taken = new Set();
    for (const entry of await filesIn(fromDir)) {
      if (originOf(entry.data, "claude") === DSH_ORIGIN) {
        const toFile = await freeName(toDir, entry.filename, "dsh", taken);
        taken.add(toFile);
        touch(toDir);
        plan.steps.push({ kind: "move", key, fromDir, file: entry.filename, toDir, toFile, reason: "dsh memory moves out to the dsh store" });
        continue;
      }
      if (metaOf(entry.data).updatedBy === DSH_ORIGIN) {
        plan.notes.push(`${key}/${entry.filename}: Claude Code memory edited by dsh; the edit stays with Claude Code's file`);
      }
      if (to === "dsh" && !options.clean) {
        const toFile = await freeName(toDir, entry.filename, "claude", taken);
        taken.add(toFile);
        touch(toDir);
        plan.steps.push({
          kind: "copy", key, fromDir, file: entry.filename, toDir, toFile,
          setMeta: { origin: "claude", copiedFrom: entry.filename, copiedAt: now },
          reason: "copy of a Claude Code memory for the dsh store",
        });
      }
    }
  }
  return plan;
}

/**
 * Plan removing every memory with the given origin from the store side of
 * the current mode. Files that origin only edited are listed, not removed.
 * @returns {Promise<Plan>}
 */
export async function planPurge(roots, mode, origin) {
  /** @type {Plan} */
  const plan = { from: mode, to: mode, steps: [], conflicts: [], notes: [], touched: [] };
  for (const { key, dir, side } of await storeFolders(mode, roots)) {
    for (const entry of await filesIn(dir)) {
      if (originOf(entry.data, side) === origin) {
        plan.steps.push({ kind: "delete", key, fromDir: dir, file: entry.filename, reason: `created by ${origin}` });
        if (!plan.touched.includes(dir)) plan.touched.push(dir);
      } else if (metaOf(entry.data).updatedBy === origin) {
        plan.notes.push(`${key}/${entry.filename}: edited by ${origin}, kept (created by ${originOf(entry.data, side)})`);
      }
    }
  }
  return plan;
}

/**
 * Plan moving the legacy user-level folder (`<dshRoot>/*.md`) into the
 * project folder a directory resolves to in the current mode.
 * @returns {Promise<Plan>}
 */
export async function planMoveLegacy(roots, mode, cwd) {
  /** @type {Plan} */
  const plan = { from: mode, to: mode, steps: [], conflicts: [], notes: [], touched: [] };
  if (!(await hasLegacy(roots.dshRoot))) return plan;
  const { key, write } = await foldersFor(cwd, mode, roots);
  if (!write) throw new Error(`no project folder resolves for ${cwd}`);
  const taken = new Set();
  for (const entry of await filesIn(roots.dshRoot)) {
    const toFile = await freeName(write.dir, entry.filename, "legacy", taken);
    taken.add(toFile);
    const setMeta = metaOf(entry.data).origin === undefined ? { origin: DSH_ORIGIN } : {};
    plan.steps.push({ kind: "move", key, fromDir: roots.dshRoot, file: entry.filename, toDir: write.dir, toFile, setMeta, reason: `legacy user-level memory moves into ${key}` });
  }
  plan.touched.push(write.dir);
  return plan;
}

/** Timestamp usable in a folder name. */
function stamp(now = new Date()) {
  return now.toISOString().replace(/[:.]/g, "-");
}

/**
 * Back up the dsh store (except earlier backups) and every Claude Code
 * memory folder. Only the `memory` subfolders are copied, never Claude
 * Code's session transcripts.
 * @returns {Promise<string>} the backup folder.
 */
export async function backup(roots) {
  const target = join(roots.dshRoot, "backups", stamp());
  await mkdir(target, { recursive: true });
  if (await dirExists(roots.dshRoot)) {
    for (const name of await readdir(roots.dshRoot)) {
      if (name === "backups") continue;
      await cp(join(roots.dshRoot, name), join(target, "dsh", name), { recursive: true, preserveTimestamps: true });
    }
  }
  for (const key of await claudeKeys(roots.claudeRoot)) {
    await cp(claudeMemoryDir(roots.claudeRoot, key), join(target, "claude", key, "memory"), { recursive: true, preserveTimestamps: true });
  }
  return target;
}

/**
 * Apply a plan: back up, run every step, record the new mode (for mode
 * changes), and rebuild the search index of every touched folder.
 * @param {{dshRoot: string, claudeRoot: string, indexDir?: string}} roots
 * @param {Plan} plan
 * @param {{recordMode?: boolean}} [options]
 * @returns {Promise<{backupDir: string, applied: number}>}
 */
export async function applyPlan(roots, plan, options = {}) {
  if (plan.conflicts.length > 0) {
    throw new Error(`${plan.conflicts.length} edited copies conflict with Claude Code's originals; rerun with --prefer dsh or --prefer claude`);
  }
  const backupDir = await backup(roots);
  const emptied = new Set();
  for (const step of plan.steps) {
    if (step.kind === "move") {
      await moveMemory({ fromDir: step.fromDir, file: step.file, toDir: step.toDir, toFile: step.toFile, setMeta: step.setMeta, unsetMeta: step.unsetMeta });
      emptied.add(step.fromDir);
    } else if (step.kind === "copy") {
      await copyMemory({ fromDir: step.fromDir, file: step.file, toDir: step.toDir, toFile: step.toFile, setMeta: step.setMeta });
    } else if (step.kind === "drop" || step.kind === "delete") {
      await deleteMemory(step.fromDir, step.file);
      emptied.add(step.fromDir);
    } else if (step.kind === "replace") {
      const copy = await readMemoryFile(step.fromDir, step.file);
      await updateMemory(step.toDir, step.toFile, {
        body: copy.body,
        ...(typeof copy.data.description === "string" ? { description: copy.data.description } : {}),
      }, "claude");
      await deleteMemory(step.fromDir, step.file);
      emptied.add(step.fromDir);
    }
  }
  for (const dir of emptied) {
    if (dir !== roots.dshRoot) await removeIfEmpty(dir);
  }
  if (options.recordMode) await writeState(roots.dshRoot, plan.to, { previous: plan.from, backup: backupDir });
  for (const dir of plan.touched) {
    if (await dirExists(dir)) await reindex(dir, { rebuild: true, indexDir: roots.indexDir });
  }
  return { backupDir, applied: plan.steps.length };
}

/**
 * Human-readable plan for the CLI.
 * @param {Plan} plan
 * @param {string} title
 */
export function formatPlan(plan, title) {
  const lines = [title];
  if (plan.steps.length === 0 && plan.conflicts.length === 0) lines.push("  no files to change");
  for (const step of plan.steps) {
    const target = step.toDir ? ` -> ${step.toDir}/${step.toFile}` : "";
    lines.push(`  ${step.kind.padEnd(7)} ${step.fromDir}/${step.file}${target}\n          ${step.reason}`);
  }
  if (plan.conflicts.length > 0) {
    lines.push("", "Conflicts (dsh edited these copies; rerun with --prefer dsh or --prefer claude):");
    for (const c of plan.conflicts) lines.push(`  ${c.key}: ${c.copy} vs ${c.dir}/${c.original}`);
  }
  if (plan.notes.length > 0) {
    lines.push("", "Notes:");
    for (const note of plan.notes) lines.push(`  ${note}`);
  }
  return lines.join("\n");
}

/**
 * Every memory on the store side of a mode, with provenance, for listing.
 * @returns {Promise<Array<{key: string, file: string, dir: string, origin: string, updatedBy: string | null, copiedFrom: string | null, description: string | null}>>}
 */
export async function listProvenance(roots, mode) {
  const out = [];
  for (const { key, dir, side } of await storeFolders(mode, roots)) {
    for (const entry of await filesIn(dir)) {
      const meta = metaOf(entry.data);
      out.push({
        key,
        file: entry.filename,
        dir,
        origin: originOf(entry.data, side),
        updatedBy: typeof meta.updatedBy === "string" ? meta.updatedBy : null,
        copiedFrom: typeof meta.copiedFrom === "string" ? meta.copiedFrom : null,
        description: entry.description,
      });
    }
  }
  return out;
}

export { INDEX_FILE };

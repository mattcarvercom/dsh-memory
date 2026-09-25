/**
 * The mode marker: `<dshRoot>/state.json` records which mode the files on
 * disk are actually in. The configured `mode` records intent; only
 * `mem mode <mode>` moves files and updates the marker, so a dsh restart
 * never migrates anything on its own.
 *
 * @module dsh-unified-memory/state
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { INDEX_FILE, writeFileAtomic } from "./store.js";

/** The three storage modes. */
export const MODES = ["dsh", "overlay", "shared"];

/** Marker path for a dsh store. */
export function statePath(dshRoot) {
  return join(dshRoot, "state.json");
}

/** Read the marker; `null` when absent or unreadable. */
export async function readState(dshRoot) {
  try {
    const state = JSON.parse(await readFile(statePath(dshRoot), "utf8"));
    return MODES.includes(state?.mode) ? state : null;
  } catch {
    return null;
  }
}

/** Write the marker. */
export async function writeState(dshRoot, mode, extra = {}) {
  const state = { version: 1, mode, updatedAt: new Date().toISOString(), ...extra };
  await writeFileAtomic(statePath(dshRoot), `${JSON.stringify(state, null, 2)}\n`);
  return state;
}

/** Whether the dsh store holds any memory files (project folders or the legacy root). */
export async function dshStoreHasMemories(dshRoot) {
  const hasFiles = async (dir) => {
    try {
      return (await readdir(dir)).some((name) => name.endsWith(".md") && name !== INDEX_FILE);
    } catch {
      return false;
    }
  };
  if (await hasFiles(dshRoot)) return true;
  try {
    const projects = await readdir(join(dshRoot, "projects"), { withFileTypes: true });
    for (const entry of projects) {
      if (entry.isDirectory() && (await hasFiles(join(dshRoot, "projects", entry.name)))) return true;
    }
  } catch {
    // No project folders.
  }
  return false;
}

/**
 * Decide the effective mode.
 *
 * - With a marker, the files are in the marker's mode. A configured mode
 *   that differs means a migration is pending: the store stays readable in
 *   the on-disk mode but refuses writes until `mem mode` runs.
 * - Without a marker, a dsh store that already holds memories predates
 *   modes, so its files are in `dsh` mode. Otherwise nothing needs to move
 *   and the configured mode (default `dsh`) is adopted and recorded.
 *
 * @param {string} dshRoot
 * @param {string | undefined} configured - the configured mode, if any.
 * @returns {Promise<{mode: string, configured: string | undefined, pending: boolean, adopted: boolean}>}
 */
export async function resolveMode(dshRoot, configured) {
  const state = await readState(dshRoot);
  if (state) {
    const pending = configured !== undefined && configured !== state.mode;
    return { mode: state.mode, configured, pending, adopted: false };
  }
  if (await dshStoreHasMemories(dshRoot)) {
    const pending = configured !== undefined && configured !== "dsh";
    return { mode: "dsh", configured, pending, adopted: false };
  }
  const mode = configured ?? "dsh";
  await writeState(dshRoot, mode, { adoptedFrom: "fresh" });
  return { mode, configured, pending: false, adopted: true };
}

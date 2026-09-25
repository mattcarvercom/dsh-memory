#!/usr/bin/env node
/**
 * mem: the dsh-unified-memory command line. Searches memories the way the plugin
 * does, and owns every bulk change: switching modes, purging by origin, and
 * folding the legacy user-level folder into a project. Bulk changes print a
 * plan with --dry-run and back up both stores before applying.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { foldersFor, storeFolders } from "../lib/layout.js";
import { applyPlan, formatPlan, listProvenance, planModeChange, planMoveLegacy, planPurge } from "../lib/migrate.js";
import { reindex, searchSources } from "../lib/search.js";
import { dshStoreHasMemories, MODES, readState, writeState } from "../lib/state.js";
import { expandHome } from "../lib/store.js";

const USAGE = `usage:
  mem status [--cwd DIR]
  mem search <keywords...> [-n N] [-o OFFSET] [-t TYPE] [--cwd DIR] [--json]
  mem list [--origin dsh|claude] [--updated-by dsh] [--json]
  mem mode [dsh|overlay|shared] [--dry-run] [--clean] [--prefer dsh|claude] [--restore-deleted]
  mem purge --origin dsh [--dry-run]
  mem move-legacy [--cwd DIR] [--dry-run]
  mem reindex [--rebuild]

common options:
  --dsh-root DIR      dsh store (default $DSH_MEMORY_ROOT, else $DSH_HOME/memory, else ~/.dsh/memory)
  --claude-root DIR   Claude Code home (default $CLAUDE_CONFIG_DIR or ~/.claude)
  --alias RAW=KEY     project alias, as in the plugin's projectAliases (repeatable)

After \`mem mode X\`, set \`mode: X\` in the memory row of your dsh profile patch
(or leave mode unset there) so the plugin does not stay read-only.`;

function parse(argv) {
  const opts = { words: [], limit: 5, offset: 0, type: null, json: false, rebuild: false, dryRun: false, clean: false, restoreDeleted: false, aliases: {} };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-n" || arg === "--limit") opts.limit = Number(argv[++i]);
    else if (arg === "-o" || arg === "--offset") opts.offset = Number(argv[++i]);
    else if (arg === "-t" || arg === "--type") opts.type = argv[++i];
    else if (arg === "--cwd") opts.cwd = argv[++i];
    else if (arg === "--origin") opts.origin = argv[++i];
    else if (arg === "--updated-by") opts.updatedBy = argv[++i];
    else if (arg === "--prefer") opts.prefer = argv[++i];
    else if (arg === "--dsh-root") opts.dshRoot = argv[++i];
    else if (arg === "--claude-root") opts.claudeRoot = argv[++i];
    else if (arg === "--alias") {
      const [raw, key] = String(argv[++i]).split("=");
      if (raw && key) opts.aliases[raw] = key;
    } else if (arg === "--json") opts.json = true;
    else if (arg === "--rebuild") opts.rebuild = true;
    else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--clean") opts.clean = true;
    else if (arg === "--restore-deleted") opts.restoreDeleted = true;
    else if (arg === "-h" || arg === "--help") opts.help = true;
    else opts.words.push(arg);
  }
  return opts;
}

function fail(message) {
  console.error(message);
  process.exit(2);
}

const [command, ...rest] = process.argv.slice(2);
const opts = parse(rest);
if (!command || opts.help || command === "help") {
  console.log(USAGE);
  process.exit(0);
}

const roots = {
  dshRoot: expandHome(opts.dshRoot ?? process.env.DSH_MEMORY_ROOT ?? join(process.env.DSH_HOME || join(homedir(), ".dsh"), "memory")),
  claudeRoot: expandHome(opts.claudeRoot ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude")),
  aliases: opts.aliases,
};
const cwd = opts.cwd ?? process.cwd();

/** The mode the files are in: the marker, else `dsh` for a pre-mode store, else unset. */
async function diskMode() {
  const state = await readState(roots.dshRoot);
  if (state) return state.mode;
  return (await dshStoreHasMemories(roots.dshRoot)) ? "dsh" : null;
}

if (command === "status") {
  const mode = await diskMode();
  console.log(`mode: ${mode ?? "not set (no memories yet; the plugin adopts its configured mode on first use)"}`);
  console.log(`dsh store: ${roots.dshRoot}\nClaude Code: ${roots.claudeRoot}`);
  const { key, write, read } = await foldersFor(cwd, mode ?? "dsh", roots);
  console.log(`\nfor ${cwd}:\n  project key: ${key}`);
  if (write) console.log(`  writes to:   ${write.dir}`);
  for (const f of read) console.log(`  reads:       ${f.dir}${f.writable ? "" : " (read-only)"}`);
  if (mode) {
    const all = await listProvenance(roots, mode);
    const byOrigin = new Map();
    for (const m of all) byOrigin.set(m.origin, (byOrigin.get(m.origin) ?? 0) + 1);
    const edited = all.filter((m) => m.updatedBy === "dsh" && m.origin !== "dsh").length;
    console.log(`\nstore: ${all.length} memories (${[...byOrigin].map(([o, n]) => `${n} ${o}`).join(", ") || "none"})${edited ? `, ${edited} edited by dsh` : ""}`);
  }
} else if (command === "search") {
  const query = opts.words.join(" ");
  if (!query.trim()) fail(USAGE);
  const mode = (await diskMode()) ?? "dsh";
  const { read } = await foldersFor(cwd, mode, roots);
  const { hits, total, empty } = await searchSources(read, query, { limit: opts.limit, offset: opts.offset, type: opts.type });
  if (opts.json) console.log(JSON.stringify({ total, hits: hits.map((h) => ({ ...h, path: join(h.dir, h.file) })) }, null, 2));
  else if (empty) console.log(`no searchable keywords in "${query}" (only common words)`);
  else if (hits.length === 0) console.log(`no memories match "${query}"`);
  else {
    for (const h of hits) console.log(`${join(h.dir, h.file)} [${h.type ?? "untyped"}]\n  ${h.description}`);
    const end = opts.offset + hits.length;
    if (end < total) console.error(`(showing ${opts.offset + 1}-${end} of ${total} matches; next page: -o ${end})`);
  }
} else if (command === "list") {
  const mode = await diskMode();
  if (!mode) {
    console.log("no memories yet");
    process.exit(0);
  }
  const all = (await listProvenance(roots, mode)).filter((m) =>
    (!opts.origin || m.origin === opts.origin) && (!opts.updatedBy || m.updatedBy === opts.updatedBy));
  if (opts.json) console.log(JSON.stringify(all, null, 2));
  else if (all.length === 0) console.log("no matching memories");
  else for (const m of all) {
    const tags = [`origin ${m.origin}`, m.updatedBy ? `updated by ${m.updatedBy}` : "", m.copiedFrom ? `copy of ${m.copiedFrom}` : ""].filter(Boolean).join(", ");
    console.log(`${m.key}/${m.file} (${tags})\n  ${m.description ?? ""}`);
  }
} else if (command === "mode") {
  const from = await diskMode();
  const to = opts.words[0];
  if (!to) {
    console.log(from ?? "not set");
    process.exit(0);
  }
  if (!MODES.includes(to)) fail(`unknown mode "${to}"; use one of ${MODES.join(", ")}`);
  if (opts.prefer && !["dsh", "claude"].includes(opts.prefer)) fail("--prefer takes dsh or claude");
  if (!from) {
    if (opts.dryRun) console.log(`mode would be set to ${to}; there are no memories to move`);
    else {
      await writeState(roots.dshRoot, to, { adoptedFrom: "fresh" });
      console.log(`mode set to ${to}; there were no memories to move`);
    }
    process.exit(0);
  }
  const plan = await planModeChange(roots, from, to, { clean: opts.clean, prefer: opts.prefer, restoreDeleted: opts.restoreDeleted });
  console.log(formatPlan(plan, `${from} -> ${to}${opts.clean ? " (clean: no copies of Claude Code memories)" : ""}:`));
  if (opts.dryRun) process.exit(0);
  if (plan.conflicts.length > 0) fail("\nnot applied: resolve the conflicts with --prefer dsh or --prefer claude");
  const { backupDir, applied } = await applyPlan(roots, plan, { recordMode: true });
  console.log(`\napplied ${applied} changes; mode is now ${to}\nbackup: ${backupDir}\nset \`mode: ${to}\` in the memory row of your dsh profile patch (or leave it unset), then restart dsh`);
} else if (command === "purge") {
  if (!opts.origin) fail("purge requires --origin (for example --origin dsh)");
  const mode = await diskMode();
  if (!mode) {
    console.log("no memories yet");
    process.exit(0);
  }
  const plan = await planPurge(roots, mode, opts.origin);
  console.log(formatPlan(plan, `purge memories created by ${opts.origin}:`));
  if (opts.dryRun || plan.steps.length === 0) process.exit(0);
  const { backupDir, applied } = await applyPlan(roots, plan);
  console.log(`\nremoved ${applied} memories\nbackup: ${backupDir}`);
} else if (command === "move-legacy") {
  const mode = (await diskMode()) ?? "dsh";
  const plan = await planMoveLegacy(roots, mode, cwd);
  console.log(formatPlan(plan, `move legacy user-level memories into the project for ${cwd}:`));
  if (opts.dryRun || plan.steps.length === 0) process.exit(0);
  const { backupDir, applied } = await applyPlan(roots, plan);
  console.log(`\nmoved ${applied} memories\nbackup: ${backupDir}`);
} else if (command === "reindex") {
  const mode = (await diskMode()) ?? "dsh";
  const dirs = new Set((await storeFolders(mode, roots)).map((f) => f.dir));
  if (mode === "overlay") for (const f of await storeFolders("shared", roots)) dirs.add(f.dir);
  for (const dir of dirs) {
    const result = await reindex(dir, { rebuild: opts.rebuild });
    console.log(`${dir}: ${result.total} files, ${result.indexed} indexed, ${result.removed} removed`);
  }
  if (dirs.size === 0) console.log("no memory folders");
} else {
  fail(USAGE);
}

/**
 * Prompt text: the injected `memory:notes` section and the memory tool's
 * description. The save and don't-save guidance is adapted from Claude
 * Code's memory prompt and kept short for small-context models.
 *
 * @module dsh-unified-memory/prompts
 */

/** Where memories live, per mode, as the model is told. */
const MODE_LINES = {
  dsh: "Long-term memory (persists across sessions).",
  overlay: "Long-term memory (persists across sessions). Memories marked (Claude Code) are read-only: they belong to Claude Code and cannot be changed from here.",
  shared: "Long-term memory (persists across sessions, shared with Claude Code: it reads and writes the same memories).",
};

/** Guidance on when to save and what not to save. */
const DISCIPLINE = [
  "Save with the memory tool when the user asks you to remember something, states a preference or corrects you, or you learn a durable fact that is not in the code (why a decision was made, where an external system lives).",
  "Do not save code structure, git history, fix recipes, transient task state, or anything already in AGENTS.md or CLAUDE.md. Never save secrets.",
  "Before adding, search first; update an existing memory instead of adding a near-duplicate.",
  "For feedback and project memories, write the rule or fact, then **Why:** and **How to apply:** lines.",
  "A memory is a snapshot from when it was written: verify files, functions, and flags it names still exist before relying on them.",
];

/** Note shown while the configured mode differs from the files on disk. */
export function pendingNote(state) {
  if (!state.pending) return "";
  return `Memory is read-only right now: it is configured for ${state.configured} mode but the files are still in ${state.mode} mode. Tell the user to run \`mem mode ${state.configured} --dry-run\`, then \`mem mode ${state.configured}\`.`;
}

/**
 * Full prompt section: each folder's MEMORY.md and its file list.
 * @param {{mode: string, pending: boolean, configured?: string}} state
 * @param {Array<{label: string, index: string}>} indexes - per-folder MEMORY.md content.
 * @param {string} fileList - recent memory files across folders.
 * @returns {string}
 */
export function renderPromptSection(state, indexes, fileList) {
  const parts = indexes.filter((i) => i.index.trim()).map((i) => `## ${i.label}\n\n${i.index.trim()}`);
  if (fileList.trim()) parts.push(`## Memory files\n\n${fileList.trim()}`);
  const note = pendingNote(state);
  if (parts.length === 0 && !note) return "";
  return [MODE_LINES[state.mode] ?? MODE_LINES.dsh, ...(note ? ["", note] : []), ...parts, "", "Memory management:", ...DISCIPLINE.map((d) => `- ${d}`)].join("\n");
}

/**
 * Compact section for `promptMode: feedback`: only the standing feedback
 * rules are preloaded; everything else is reached through search.
 * @param {{mode: string, pending: boolean, configured?: string}} state
 * @param {Array<{filename: string, description: string | null, readOnly?: boolean}>} feedback
 * @param {number} otherCount - memories not listed here.
 * @returns {string}
 */
export function renderFeedbackSection(state, feedback, otherCount) {
  const rules = feedback.map((e) => `- ${e.filename.replace(/\.md$/i, "")}${e.readOnly ? " (Claude Code)" : ""}: ${e.description ?? ""}`);
  const note = pendingNote(state);
  return [
    `${MODE_LINES[state.mode] ?? MODE_LINES.dsh} Standing user feedback, always apply:`,
    ...(rules.length > 0 ? rules : ["(none)"]),
    "",
    `${otherCount} more memories are not preloaded. Before working in an area, or when the user mentions earlier work, run the memory tool with action=search query=<keywords>, then action=read name=<file name> for a hit. An empty result means nothing relevant is stored. action=list shows every memory by name.`,
    ...(note ? ["", note] : []),
    "",
    "Memory management:",
    ...DISCIPLINE.map((d) => `- ${d}`),
  ].join("\n");
}

/** Tool description for the memory tool. */
export const TOOL_DESCRIPTION = [
  "Manage long-term, cross-session memory stored as markdown files (Claude Code's format).",
  "",
  "Actions:",
  "- add: save a new memory (name, text, description, type). Fails with a list of similar memories when it looks like a duplicate; update one of those instead, or repeat with force=true if it really is new.",
  "- update: change an existing memory by name (text, description, and/or type).",
  "- delete: remove a memory by name.",
  "- search: full-text search by keywords (query); best hits first, paged with limit and offset. Prefer this to list when looking for something.",
  "- list: every memory by name, grouped by type (add query= or type= to see descriptions of a subset).",
  "- read: the full content of a memory by name.",
  "",
  "Types: user (who the user is), feedback (how to work: preferences and corrections), project (durable facts and decisions not in the code), reference (where external things live).",
  "Do not save code structure, git history, fix recipes, transient task state, or secrets.",
].join("\n");

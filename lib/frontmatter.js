/**
 * Minimal YAML frontmatter parser/serializer for Claude Code-compatible
 * memory files.
 *
 * Reading supports the subset Claude Code writes: scalar values (plain,
 * quoted, numbers, booleans, null) and one level of nested mappings under a
 * key (e.g. `metadata:` with `type:` / `originSessionId:` children). Shapes
 * outside that subset (lists, block scalars) are not fully parsed.
 *
 * Writing an existing file therefore never re-serializes its frontmatter:
 * {@link editFrontmatter} changes only the keys being set, line by line, and
 * leaves every other line exactly as it was. {@link renderMemoryFile} is for
 * files this plugin creates from scratch.
 *
 * @module dsh-unified-memory/frontmatter
 */

const FM_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/;

/**
 * Parse the YAML frontmatter block at the top of a document.
 * @param {string} content - the full file content.
 * @returns {{ data: Record<string, unknown>, body: string, hasFrontmatter: boolean }}
 *   `data` is the parsed mapping (empty when there is no frontmatter),
 *   `body` is the content after the closing `---`, and `hasFrontmatter`
 *   reports whether a block was present.
 */
export function parseFrontmatter(content) {
  const match = FM_RE.exec(content);
  if (!match) return { data: {}, body: content, hasFrontmatter: false };
  return { data: parseMapping(match[1].split(/\r?\n/)), body: content.slice(match[0].length), hasFrontmatter: true };
}

/**
 * Parse an indented mapping into a plain object. Unknown shapes degrade to
 * raw string values so nothing is lost on a round-trip.
 * @param {string[]} lines - the frontmatter block lines (without the `---`).
 * @returns {Record<string, unknown>}
 */
function parseMapping(lines) {
  const result = {};
  let currentKey = null;
  let currentIndent = -1;
  for (const line of lines) {
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();
    const sep = trimmed.indexOf(":");
    if (sep === -1) {
      if (currentKey !== null && indent > currentIndent) {
        // A bare child line under the current key: fold into its raw text.
        const child = result[currentKey];
        if (typeof child === "string") result[currentKey] = child + "\n" + trimmed;
        continue;
      }
      result["__raw"] = (result["__raw"] ?? "") + (result["__raw"] ? "\n" : "") + trimmed;
      continue;
    }
    const key = trimmed.slice(0, sep).trim();
    if (!/^[A-Za-z0-9_.-]+$/.test(key)) {
      result["__raw"] = (result["__raw"] ?? "") + (result["__raw"] ? "\n" : "") + trimmed;
      continue;
    }
    const rawValue = trimmed.slice(sep + 1).trim();
    if (rawValue === "") {
      currentKey = key;
      currentIndent = indent;
      result[key] = {}; // nested mapping placeholder
      continue;
    }
    if (indent > 0 && currentKey !== null && indent > currentIndent) {
      // Nested child under the current key.
      const parent = result[currentKey];
      if (parent && typeof parent === "object" && !Array.isArray(parent) && !("__raw" in parent)) {
        parent[key] = parseScalar(rawValue);
        continue;
      }
    }
    currentKey = key;
    currentIndent = indent;
    result[key] = parseScalar(rawValue);
  }
  return result;
}

/** Parse one YAML scalar value. */
function parseScalar(raw) {
  if (raw === "null" || raw === "~") return null;
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (/^-?\d+$/.test(raw)) return Number(raw);
  if (/^-?\d+\.\d+$/.test(raw)) return Number(raw);
  if (raw.startsWith('"')) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw.slice(1, raw.endsWith('"') ? -1 : undefined);
    }
  }
  if (raw.startsWith("'")) {
    const end = raw.endsWith("'") ? raw.length - 1 : undefined;
    return raw.slice(1, end).replace(/''/g, "'");
  }
  // Plain scalar: strip an inline YAML comment (` # comment`).
  const comment = raw.indexOf(" #");
  return comment === -1 ? raw : raw.slice(0, comment).trimEnd();
}

/** Whether a plain string needs YAML quoting on serialization. */
function needsQuoting(value) {
  // Strings that would read back as another type (number, boolean, null).
  if (/^-?\d+(\.\d+)?$/.test(value) || /^(true|false|null|~)$/.test(value)) return true;
  return value === "" || /^[\s\-?:,[\]{}#&*!|>'"%@`]/.test(value) || /[:#]\s/.test(value) ||
    value.includes("\n") || value !== value.trim();
}

/**
 * Serialize a frontmatter block (including the `---` fences) from a data
 * mapping, preserving nested mappings.
 * @param {Record<string, unknown>} data
 * @returns {string}
 */
export function serializeFrontmatter(data) {
  const lines = ["---"];
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined || value === null) continue;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      lines.push(`${key}:`);
      for (const [childKey, childValue] of Object.entries(value)) {
        if (childValue === undefined || childValue === null || childKey === "__raw") continue;
        lines.push(`  ${childKey}: ${quoteScalar(childValue)}`);
      }
      continue;
    }
    lines.push(`${key}: ${quoteScalar(value)}`);
  }
  lines.push("---", "");
  return lines.join("\n");
}

/** Quote a scalar value when needed. */
function quoteScalar(value) {
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (typeof value !== "string") return String(value);
  if (!needsQuoting(value)) return value;
  // Double quotes with JSON escaping; parseScalar reads them back with JSON.parse.
  return JSON.stringify(value);
}

/**
 * Render a complete memory file: frontmatter block + body.
 * @param {Record<string, unknown>} data - frontmatter fields.
 * @param {string} body - markdown body (may be empty).
 * @returns {string}
 */
export function renderMemoryFile(data, body) {
  const head = serializeFrontmatter(data);
  return `${head}${body.trimStart()}\n`;
}

/** Indentation width of a line. */
function indentOf(line) {
  return line.length - line.trimStart().length;
}

/** Whether a line is `key:` or `key: value` for exactly this key. */
function isKeyLine(line, key) {
  const trimmed = line.trimStart();
  return trimmed.startsWith(`${key}:`) && (trimmed.length === key.length + 1 || /\s/.test(trimmed[key.length + 1]));
}

/**
 * The index just past a key line and its continuation lines (more-indented
 * lines, or blank lines followed by more-indented ones).
 */
function endOfEntry(lines, start) {
  const base = indentOf(lines[start]);
  let end = start + 1;
  while (end < lines.length) {
    const line = lines[end];
    if (line.trim() === "") {
      let next = end + 1;
      while (next < lines.length && lines[next].trim() === "") next++;
      if (next < lines.length && indentOf(lines[next]) > base) {
        end = next;
        continue;
      }
      break;
    }
    if (indentOf(line) <= base) break;
    end++;
  }
  return end;
}

/**
 * Edit frontmatter in place: set top-level keys and `metadata:` children,
 * rewriting only those lines (a replaced key also drops its old continuation
 * lines). Every other line, including comments, lists and unknown keys, is
 * kept byte for byte. A document without frontmatter gets a new block.
 * @param {string} content - the full file content.
 * @param {{set?: Record<string, unknown>, setMeta?: Record<string, unknown>, unsetMeta?: string[], body?: string}} edits
 *   `set` for top-level keys, `setMeta` for keys under `metadata:`,
 *   `unsetMeta` to remove keys under `metadata:`, and `body` to replace
 *   everything after the closing fence.
 * @returns {string} the new file content.
 */
export function editFrontmatter(content, edits) {
  const match = FM_RE.exec(content);
  const lines = match ? match[1].split(/\r?\n/) : [];
  const newline = match && match[0].includes("\r\n") ? "\r\n" : "\n";
  const body = edits.body !== undefined ? edits.body : match ? content.slice(match[0].length) : content;

  for (const [key, value] of Object.entries(edits.set ?? {})) {
    const at = lines.findIndex((line) => indentOf(line) === 0 && isKeyLine(line, key));
    const rendered = `${key}: ${quoteScalar(value)}`;
    if (at === -1) lines.push(rendered);
    else lines.splice(at, endOfEntry(lines, at) - at, rendered);
  }

  const metaEdits = Object.entries(edits.setMeta ?? {});
  if (metaEdits.length > 0) {
    let at = lines.findIndex((line) => indentOf(line) === 0 && isKeyLine(line, "metadata"));
    if (at === -1) {
      lines.push("metadata:");
      at = lines.length - 1;
    }
    for (const [key, value] of metaEdits) {
      const end = endOfEntry(lines, at);
      const children = lines.slice(at + 1, end).filter((line) => line.trim() !== "");
      const childIndent = children.length > 0 ? " ".repeat(Math.min(...children.map(indentOf))) : "  ";
      const rendered = `${childIndent}${key}: ${quoteScalar(value)}`;
      let hit = -1;
      for (let i = at + 1; i < end; i++) {
        if (indentOf(lines[i]) === childIndent.length && isKeyLine(lines[i], key)) {
          hit = i;
          break;
        }
      }
      if (hit === -1) lines.splice(end, 0, rendered);
      else lines.splice(hit, endOfEntry(lines, hit) - hit, rendered);
    }
  }

  const unset = edits.unsetMeta ?? [];
  if (unset.length > 0) {
    const at = lines.findIndex((line) => indentOf(line) === 0 && isKeyLine(line, "metadata"));
    if (at !== -1) {
      for (const key of unset) {
        const end = endOfEntry(lines, at);
        for (let i = at + 1; i < end; i++) {
          if (indentOf(lines[i]) > 0 && isKeyLine(lines[i], key)) {
            lines.splice(i, endOfEntry(lines, i) - i);
            break;
          }
        }
      }
    }
  }

  const head = ["---", ...lines, "---"].join(newline);
  let tail;
  if (edits.body === undefined) {
    // Untouched body: kept byte for byte, including a blank line after the fence.
    tail = body;
  } else {
    // Replaced body: keep the file's own convention of a blank line after the fence.
    const original = match ? content.slice(match[0].length) : "";
    const gap = /^\r?\n/.test(original) ? newline : "";
    tail = `${gap}${edits.body.replace(/^(\r?\n)+/, "")}`;
    if (tail !== "" && !tail.endsWith("\n")) tail += "\n";
  }
  return `${head}${newline}${tail}`;
}

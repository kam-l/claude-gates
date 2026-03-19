#!/usr/bin/env node
/**
 * AgentGate v1 — shared module.
 *
 * Parsers for the two YAML frontmatter fields (requires, verification)
 * with backward compatibility for the old gate: block schema.
 *
 * Exports:
 *   extractFrontmatter(mdContent)  → string | null
 *   parseRequires(mdContent)       → string[] | null
 *   parseVerification(mdContent)   → string | null
 *   findAgentMd(agentType, projectRoot, home) → string | null
 *   VERDICT_RE                     → RegExp
 */

const fs = require("fs");
const path = require("path");

const VERDICT_RE = /^Result:\s*(PASS|FAIL|REVISE|CONVERGED)/m;

/**
 * Extract frontmatter block from markdown content.
 * Returns the raw YAML string between --- fences, or null.
 *
 * Uses line-anchored close fence to avoid matching indented --- inside
 * YAML block scalars (e.g. description: | with --- in the text).
 */
function extractFrontmatter(mdContent) {
  // Closing --- must be at column 0, followed by newline or EOF
  const match = mdContent.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  return match ? match[1] : null;
}

/**
 * Parse requires: list from agent YAML frontmatter.
 * New schema: top-level `requires: ["implementer", "cleaner"]`
 * Returns string[] or null if not present.
 */
function parseRequires(mdContent) {
  const fm = extractFrontmatter(mdContent);
  if (!fm) return null;

  // New schema: requires: ["a", "b"] (inline array)
  const inlineMatch = fm.match(/^requires:\s*\[([^\]]*)\]/m);
  if (inlineMatch) {
    const items = inlineMatch[1]
      .split(",")
      .map(s => s.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
    return items.length > 0 ? items : null;
  }

  // New schema: requires: block sequence
  const blockMatch = fm.match(/^requires:\s*\r?\n((?:\s+-\s*.*\r?\n?)+)/m);
  if (blockMatch) {
    const items = [];
    for (const line of blockMatch[1].split(/\r?\n/)) {
      // Handle: - name, - "name", - 'name', - "name with spaces"
      const m = line.match(/^\s+-\s*(?:"([^"]+)"|'([^']+)'|(\S+))/);
      if (m) items.push(m[1] || m[2] || m[3]);
    }
    return items.length > 0 ? items : null;
  }

  return null;
}

/**
 * Parse verification: prompt from agent YAML frontmatter.
 * New schema: top-level `verification: |` multiline block.
 * Falls back to old `gate.prompt` for backward compatibility.
 * Returns the prompt string or null.
 */
function parseVerification(mdContent) {
  const fm = extractFrontmatter(mdContent);
  if (!fm) return null;

  // New schema: verification: | (multiline block scalar)
  const vMatch = fm.match(/^verification:\s*\|\s*\r?\n((?:[ ]{2,}.*\r?\n?)+)/m);
  if (vMatch) {
    return vMatch[1]
      .split(/\r?\n/)
      .map(line => line.replace(/^ {2}/, ""))
      .join("\n")
      .trim();
  }

  // Fallback: old gate.prompt schema
  const gateMatch = fm.match(/^gate:\s*\r?\n((?:[ ]{2,}.*\r?\n?)*)/m);
  if (gateMatch) {
    const gb = gateMatch[1];
    const pm = gb.match(/^\s+prompt:\s*\|\s*\r?\n((?:\s{4,}.*\r?\n?)+)/m);
    if (pm) {
      return pm[1]
        .split(/\r?\n/)
        .map(line => line.replace(/^ {4}/, ""))
        .join("\n")
        .trim();
    }
  }

  return null;
}

/**
 * Find agent .md: project-level first, then global.
 * Returns absolute path or null.
 */
function findAgentMd(agentType, projectRoot, home) {
  if (projectRoot) {
    const projectPath = path.join(projectRoot, ".claude", "agents", `${agentType}.md`);
    if (fs.existsSync(projectPath)) return projectPath;
  }
  if (home) {
    const globalPath = path.join(home, ".claude", "agents", `${agentType}.md`);
    if (fs.existsSync(globalPath)) return globalPath;
  }
  return null;
}

module.exports = { extractFrontmatter, parseRequires, parseVerification, findAgentMd, VERDICT_RE };

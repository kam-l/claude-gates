#!/usr/bin/env node
/**
 * ClaudeGates v2 — shared module.
 *
 * Parsers for YAML frontmatter fields (requires, verification, conditions, gates).
 *
 * Exports:
 *   extractFrontmatter(mdContent)  → string | null
 *   parseRequires(mdContent)       → string[] | null
 *   parseVerification(mdContent)   → string | null
 *   parseConditions(mdContent)     → string | null
 *   parseGates(mdContent)          → Array<{ agent, maxRounds, fixer? }> | null
 *   requiresScope(mdContent)       → boolean
 *   findAgentMd(agentType, projectRoot, home) → string | null
 *   VERDICT_RE                     → RegExp
 */

const fs = require("fs");
const path = require("path");

const VERDICT_RE = /^Result:\s*(PASS|FAIL|REVISE|CONVERGED)/mi;

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
 * Schema: top-level `verification: |` multiline block.
 * Returns the prompt string or null.
 */
function parseVerification(mdContent) {
  const fm = extractFrontmatter(mdContent);
  if (!fm) return null;

  const vMatch = fm.match(/^verification:\s*\|\s*\r?\n((?:[ ]{2,}.*\r?\n?)+)/m);
  if (vMatch) {
    return vMatch[1]
      .split(/\r?\n/)
      .map(line => line.replace(/^ {2}/, ""))
      .join("\n")
      .trim();
  }

  return null;
}

/**
 * Parse conditions: prompt from agent YAML frontmatter.
 * Semantic pre-check run BEFORE the agent spawns.
 * Same format as verification: (block scalar with |).
 * Returns the prompt string or null.
 */
function parseConditions(mdContent) {
  const fm = extractFrontmatter(mdContent);
  if (!fm) return null;
  const cMatch = fm.match(/^conditions:\s*\|\s*\r?\n((?:[ ]{2,}.*\r?\n?)+)/m);
  if (cMatch) {
    return cMatch[1]
      .split(/\r?\n/)
      .map(line => line.replace(/^ {2}/, ""))
      .join("\n")
      .trim();
  }
  return null;
}

/**
 * Parse gates: field from agent YAML frontmatter.
 * Format:
 *   gates:
 *     - [reviewer, 3]
 *     - [playtester, 3]
 *
 * Returns Array<{ agent: string, maxRounds: number }> or null.
 */
function parseGates(mdContent) {
  const fm = extractFrontmatter(mdContent);
  if (!fm) return null;

  const blockMatch = fm.match(/^gates:\s*\r?\n((?:\s+-\s*.*\r?\n?)+)/m);
  if (!blockMatch) return null;

  const gates = [];
  for (const line of blockMatch[1].split(/\r?\n/)) {
    const m = line.match(/^\s+-\s*\[\s*["']?([A-Za-z0-9_-]+)["']?\s*,\s*(\d+)\s*(?:,\s*["']?([A-Za-z0-9_-]+)["']?\s*)?\]/);
    if (m) {
      const entry = { agent: m[1], maxRounds: parseInt(m[2], 10) };
      if (m[3]) entry.fixer = m[3];
      gates.push(entry);
    }
  }
  return gates.length > 0 ? gates : null;
}

/**
 * Check whether agent definition requires a scope for gating.
 * Returns true if frontmatter contains gates: or requires:.
 * Note: verification: alone does NOT require scope (backward compatible).
 */
function requiresScope(mdContent) {
  const fm = extractFrontmatter(mdContent);
  if (!fm) return false;
  return /^(gates|requires|conditions)\s*:/m.test(fm);
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

module.exports = { extractFrontmatter, parseRequires, parseVerification, parseConditions, parseGates, requiresScope, findAgentMd, VERDICT_RE };

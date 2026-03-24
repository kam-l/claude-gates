#!/usr/bin/env node
/**
 * Pipeline v3 — shared module.
 *
 * Parsers for unified verification: field and conditions:.
 *
 * Exports:
 *   extractFrontmatter(mdContent)     → string | null
 *   parseVerification(mdContent)      → Step[] | null
 *   parseConditions(mdContent)        → string | null
 *   requiresScope(mdContent)          → boolean
 *   findAgentMd(agentType, projectRoot, home) → string | null
 *   VERDICT_RE                        → RegExp
 *
 * Step types:
 *   { type: 'SEMANTIC', prompt: string }
 *   { type: 'COMMAND', command: string, allowedTools: string[] }
 *   { type: 'REVIEW', agent: string, maxRounds: number }
 *   { type: 'REVIEW_WITH_FIXER', agent: string, maxRounds: number, fixer: string }
 */

const fs = require("fs");
const path = require("path");

const VERDICT_RE = /^Result:\s*(PASS|FAIL|REVISE|CONVERGED)/mi;

/**
 * Extract frontmatter block from markdown content.
 * Returns the raw YAML string between --- fences, or null.
 */
function extractFrontmatter(mdContent) {
  const match = mdContent.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  return match ? match[1] : null;
}

/**
 * Parse unified verification: field from agent YAML frontmatter.
 *
 * Format:
 *   verification:
 *     - ["Verify the artifact is complete."]       # SEMANTIC
 *     - [/question, AskUserTool]                   # COMMAND
 *     - [reviewer, 3]                              # REVIEW
 *     - [reviewer, 3, fixer]                       # REVIEW_WITH_FIXER
 *
 * Returns Step[] or null.
 */
function parseVerification(mdContent) {
  const fm = extractFrontmatter(mdContent);
  if (!fm) return null;

  // Match the verification: block (array of items)
  const blockMatch = fm.match(/^verification:\s*\r?\n((?:\s+-\s*.*\r?\n?)+)/m);
  if (!blockMatch) return null;

  const steps = [];
  for (const line of blockMatch[1].split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith("-")) continue;

    // Extract the array content: - [...]
    const arrMatch = trimmed.match(/^-\s*\[(.+)\]\s*$/);
    if (!arrMatch) continue;

    const inner = arrMatch[1].trim();
    const step = parseStepArray(inner);
    if (step) steps.push(step);
  }

  return steps.length > 0 ? steps : null;
}

/**
 * Parse inner content of a step array.
 * Determines step type from first element:
 *   - Quoted string → SEMANTIC
 *   - Starts with / → COMMAND
 *   - Agent name → REVIEW or REVIEW_WITH_FIXER
 */
function parseStepArray(inner) {
  // SEMANTIC: ["prompt literal"] or ['prompt literal']
  const semanticMatch = inner.match(/^["'](.+)["']$/);
  if (semanticMatch) {
    return { type: "SEMANTIC", prompt: semanticMatch[1] };
  }

  // Split by comma, trim each part
  const parts = splitCSV(inner);
  if (parts.length === 0) return null;

  const first = parts[0];

  // COMMAND: /command, Tool1, Tool2, ...
  if (first.startsWith("/")) {
    return {
      type: "COMMAND",
      command: first,
      allowedTools: parts.slice(1)
    };
  }

  // REVIEW or REVIEW_WITH_FIXER: agent, maxRounds[, fixer]
  const agentName = unquote(first);
  if (!agentName || !/^[A-Za-z0-9_-]+$/.test(agentName)) return null;

  const maxRounds = parts.length >= 2 ? parseInt(parts[1], 10) : 3;
  if (isNaN(maxRounds)) return null;

  if (parts.length >= 3) {
    const fixer = unquote(parts[2]);
    if (fixer && /^[A-Za-z0-9_-]+$/.test(fixer)) {
      return { type: "REVIEW_WITH_FIXER", agent: agentName, maxRounds, fixer };
    }
  }

  return { type: "REVIEW", agent: agentName, maxRounds };
}

/**
 * Split CSV respecting quoted strings.
 * "a, b, c" → ["a", "b", "c"]
 * Does not handle nested quotes — step arrays are simple.
 */
function splitCSV(str) {
  const parts = [];
  let current = "";
  let inQuote = false;
  let quoteChar = "";

  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (inQuote) {
      if (ch === quoteChar) {
        inQuote = false;
      } else {
        current += ch;
      }
    } else if (ch === '"' || ch === "'") {
      inQuote = true;
      quoteChar = ch;
    } else if (ch === ",") {
      parts.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

/** Remove surrounding quotes from a string. */
function unquote(s) {
  if (!s) return s;
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

/**
 * Parse conditions: prompt from agent YAML frontmatter.
 * Semantic pre-check run BEFORE the agent spawns.
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
 * Check whether agent definition requires a scope for pipeline.
 * Returns true if frontmatter contains verification: (array form) or conditions:.
 */
function requiresScope(mdContent) {
  const fm = extractFrontmatter(mdContent);
  if (!fm) return false;
  // verification: followed by newline+indent (array form, not block scalar)
  if (/^verification:\s*\r?\n\s+-/m.test(fm)) return true;
  if (/^conditions\s*:/m.test(fm)) return true;
  return false;
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

module.exports = { extractFrontmatter, parseVerification, parseConditions, requiresScope, findAgentMd, VERDICT_RE };

#!/usr/bin/env node
/**
 * AgentGate v1 — legacy compatibility module.
 *
 * Handles the old gate: schema from project-level agent definitions
 * that use {task_dir} interpolation and .context/tasks/ conventions.
 *
 * This module will be removed once all projects migrate to the new
 * requires: + verification: schema with scope-based artifacts.
 *
 * Exports:
 *   extractLegacyArtifactPath(mdContent, projectRoot) → { artifactPath, artifactName } | null
 *   runLegacyVerification(legacyInfo, verification, mdContent, data, projectRoot, home) → void
 */

const fs = require("fs");
const path = require("path");
const { extractFrontmatter, VERDICT_RE } = require("./agent-gate-shared.js");

/**
 * Highest-numbered dir under {projectRoot}/.context/tasks/, or null.
 */
function resolveTaskDir(projectRoot) {
  try {
    const tasksDir = path.join(projectRoot, ".context", "tasks");
    if (!fs.existsSync(tasksDir)) return null;
    const dirs = fs.readdirSync(tasksDir)
      .filter(d => /^\d+$/.test(d))
      .sort((a, b) => parseInt(b, 10) - parseInt(a, 10));
    return dirs.length > 0 ? `.context/tasks/${dirs[0]}` : null;
  } catch {
    return null;
  }
}

/**
 * Parse old gate: block from frontmatter.
 * Returns { artifact, required, verdict, prompt, context, model } or null.
 */
function parseLegacyGate(mdContent) {
  const fm = extractFrontmatter(mdContent);
  if (!fm) return null;

  const gateMatch = fm.match(/^gate:\s*\r?\n((?:[ ]{2,}.*\r?\n?)*)/m);
  if (!gateMatch) return null;
  const gb = gateMatch[1];

  const gate = {};

  const am = gb.match(/^\s+artifact:\s*"([^"]+)"/m);
  if (am) gate.artifact = am[1];

  const rm = gb.match(/^\s+required:\s*(true|false)/mi);
  gate.required = rm ? rm[1].toLowerCase() === "true" : false;

  const vm = gb.match(/^\s+verdict:\s*(true|false)/mi);
  gate.verdict = vm ? vm[1].toLowerCase() === "true" : false;

  const cm = gb.match(/^\s+context:\s*\r?\n((?:\s{4,}-\s*"[^"]*"\s*\r?\n?)+)/m);
  if (cm) {
    gate.context = [];
    for (const item of cm[1].matchAll(/^\s+-\s*"([^"]*)"/gm)) {
      gate.context.push(item[1]);
    }
  }

  return gate;
}

/**
 * Extract legacy artifact path (.context/tasks/N/...) for backward compat.
 * Returns { artifactPath, artifactName } or null.
 */
function extractLegacyArtifactPath(mdContent, projectRoot) {
  const gate = parseLegacyGate(mdContent);
  if (!gate || !gate.artifact) return null;

  const taskDir = resolveTaskDir(projectRoot);
  if (!taskDir) return null;

  const resolved = gate.artifact.replace(/\{task_dir\}/g, taskDir);
  const fullPath = path.isAbsolute(resolved) ? resolved : path.join(projectRoot, resolved);

  if (fs.existsSync(fullPath)) {
    return { artifactPath: fullPath, artifactName: path.basename(resolved) };
  }

  return null;
}

/**
 * Run legacy verification (old gate: schema).
 * Checks verdict line, gathers context files, then calls the semantic checker.
 */
function runLegacyVerification(legacyInfo, verification, mdContent, data, projectRoot, home, runSemanticCheck) {
  const { artifactPath, artifactName } = legacyInfo;
  const artifactContent = fs.readFileSync(artifactPath, "utf-8");

  // Check verdict line if gate.verdict: true
  const gate = parseLegacyGate(mdContent);
  if (gate && gate.verdict && !VERDICT_RE.test(artifactContent)) {
    process.stdout.write(JSON.stringify({
      decision: "block",
      reason: `[AgentGate] Your ${artifactName} is missing a Result: line. Add 'Result: PASS' or 'Result: FAIL' as a standalone line.`
    }));
    return;
  }

  // Gather context files
  let contextContent = "";
  if (gate && gate.context) {
    const taskDir = resolveTaskDir(projectRoot);
    for (const ctxTemplate of gate.context) {
      try {
        const ctxPath = ctxTemplate.replace(/\{task_dir\}/g, taskDir || "");
        const fullPath = path.isAbsolute(ctxPath) ? ctxPath : path.join(projectRoot, ctxPath);
        const content = fs.readFileSync(fullPath, "utf-8");
        contextContent += `\n--- ${ctxPath} ---\n${content}\n`;
      } catch {} // missing context → skip
    }
  }

  runSemanticCheck(verification, artifactContent, artifactPath, contextContent, data.agent_type, data.agent_id, data.session_id);
}

module.exports = { extractLegacyArtifactPath, runLegacyVerification, resolveTaskDir, parseLegacyGate };

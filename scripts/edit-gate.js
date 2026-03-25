#!/usr/bin/env node
/**
 * ClaudeGates v2 — PostToolUse:Edit|Write gate.
 *
 * Tracks edited files in SQLite (stop-gate reads them).
 * Runs opt-in formatter commands on each newly-edited file (deduped).
 *
 * Config (claude-gates.json):
 *   edit_gate.commands: ["dotnet format --include {file}"]
 *   {file} is replaced with the absolute path of the just-edited file.
 *   Commands run only on NEW files (dedup — same file edited twice doesn't re-run).
 *   Failures are non-fatal (stderr warning, never blocks).
 *
 * Fail-open.
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { getDb, addEdit, getEdits } = require("./claude-gates-db.js");
const { loadConfig } = require("./claude-gates-config.js");

try {
  const data = JSON.parse(fs.readFileSync(0, "utf-8"));

  const sessionId = data.session_id || "";
  if (!sessionId) process.exit(0);

  const HOME = process.env.USERPROFILE || process.env.HOME || "";
  const sessionDir = path.join(HOME, ".claude", "sessions", sessionId);

  // Extract file_path from tool_input (Edit/Write both use file_path)
  const toolInput = data.tool_input || {};
  let filePath = toolInput.file_path || "";

  // Fallback: try tool_result if tool_input doesn't have it
  if (!filePath && data.tool_result) {
    const resultMatch = String(data.tool_result).match(/(?:file|path)[:\s]+([^\n,]+)/i);
    if (resultMatch) filePath = resultMatch[1].trim();
  }

  if (!filePath) process.exit(0);

  // Normalize path (resolve + forward slashes)
  const normalized = path.resolve(filePath).replace(/\\/g, "/");

  // SQLite: track edits
  const db = getDb(sessionDir);

  // Check if this is a new file (not already tracked)
  const editsBefore = getEdits(db);
  const isNew = !editsBefore.includes(normalized);

  // Track the file
  addEdit(db, normalized);

  // Run formatter commands on new files only (dedup)
  if (isNew) {
    const config = loadConfig();
    const commands = config.edit_gate.commands || [];

    for (const cmd of commands) {
      const expanded = cmd.replace(/\{file\}/g, normalized);
      try {
        execSync(expanded, {
          encoding: "utf-8",
          timeout: 30000,
          stdio: ["pipe", "pipe", "pipe"]
        });
      } catch (err) {
        // Non-fatal — show stderr output to user
        const output = (err.stderr || "").trim();
        if (output) {
          process.stderr.write(`[ClaudeGates] ⚠️ edit: Formatter — ${output}\n`);
        } else {
          process.stderr.write(`[ClaudeGates] ⚠️ edit: Formatter failed — ${expanded}\n`);
        }
      }
    }
  }

  db.close();

  process.exit(0);
} catch {
  process.exit(0); // fail-open
}

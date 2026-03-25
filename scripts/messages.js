#!/usr/bin/env node
/**
 * Unified messaging for all claude-gates hooks.
 *
 * Template: [ClaudeGates] {emoji} {message}
 *
 * Output channels:
 *   block()   → stdout JSON { decision:"block", reason } — reason is injected into Claude's context
 *   info()    → stdout JSON { systemMessage } — user sees it (PreToolUse/PostToolUse only)
 *   notify()  → side-channel file — pipeline-block.js surfaces on next PreToolUse
 *   log()     → stderr — debug only, invisible to user
 *
 * SubagentStop cannot use systemMessage (issue #16289). Use notify() there;
 * pipeline-block.js reads the file on next PreToolUse and surfaces via systemMessage.
 */

const fs = require("fs");
const path = require("path");

const PREFIX = "[ClaudeGates]";

function fmt(emoji, text) {
  return `${PREFIX} ${emoji} ${text}`;
}

/** Block a tool call. reason is injected into Claude's context. */
function block(emoji, text) {
  const msg = fmt(emoji, text);
  process.stdout.write(JSON.stringify({ decision: "block", reason: msg }));
}

/** Show info to user via systemMessage. Works on PreToolUse/PostToolUse only. */
function info(emoji, text) {
  const msg = fmt(emoji, text);
  process.stdout.write(JSON.stringify({ systemMessage: msg }));
}

/** Queue a notification for the user. pipeline-block.js surfaces it on next PreToolUse.
 *  Use this from SubagentStop/SubagentStart where systemMessage is broken. */
function notify(sessionDir, emoji, text) {
  const msg = fmt(emoji, text);
  const filePath = path.join(sessionDir, ".pipeline-notifications");
  try {
    fs.appendFileSync(filePath, msg + "\n", "utf-8");
  } catch {} // non-fatal
}

/** Read and clear queued notifications. Returns string or null. */
function drainNotifications(sessionDir) {
  const filePath = path.join(sessionDir, ".pipeline-notifications");
  try {
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, "utf-8").trim();
    fs.unlinkSync(filePath);
    return content || null;
  } catch {
    return null;
  }
}

/** Debug log to stderr. Invisible to user. Same template for grep-ability. */
function log(emoji, text) {
  process.stderr.write(fmt(emoji, text) + "\n");
}

module.exports = { fmt, block, info, notify, drainNotifications, log };

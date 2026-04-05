#!/usr/bin/env node
"use strict";
/**
 * Pipeline v3 — UserPromptSubmit gate toggle.
 *
 * Intercepts "gate on", "gate off", "gate status" (and plural "gates")
 * to toggle or query the gate-disabled marker file. Blocks the prompt
 * so it never reaches the model.
 *
 * Toggle takes effect on the next hook invocation, not retroactively
 * on in-flight hooks.
 *
 * Fail-open.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseToggleCommand = parseToggleCommand;
exports.onUserPromptSubmit = onUserPromptSubmit;
const fs_1 = __importDefault(require("fs"));
const Messaging_1 = require("./Messaging");
const SessionManager_1 = require("./SessionManager");
const TOGGLE_PATTERN = /^gates?\s+(on|off|status)$/i;
function parseToggleCommand(prompt) {
    const match = prompt.trim().match(TOGGLE_PATTERN);
    if (!match) {
        return null;
    }
    return match[1].toLowerCase();
}
function onUserPromptSubmit(data) {
    const prompt = data.prompt || "";
    const command = parseToggleCommand(prompt);
    if (!command) {
        process.exit(0);
    }
    if (command === "status") {
        const state = SessionManager_1.SessionManager.isGateDisabled() ? "OFF" : "ON";
        const out = { decision: "block", reason: Messaging_1.Messaging.fmt("", `Gates are currently ${state}.`), };
        process.stdout.write(JSON.stringify(out));
        process.exit(0);
    }
    const disable = command === "off";
    SessionManager_1.SessionManager.setGateDisabled(disable);
    const emoji = disable ? "⏸️" : "▶️";
    const verb = disable ? "disabled" : "re-enabled";
    const hint = disable ? " Type \"gate on\" to re-enable." : "";
    const out = { decision: "block", reason: Messaging_1.Messaging.fmt(emoji, `Gates ${verb}.${hint}`), };
    process.stdout.write(JSON.stringify(out));
    process.exit(0);
}
// ── Entry point (guarded for import safety) ────────────────────────────
if (require.main === module) {
    try {
        onUserPromptSubmit(JSON.parse(fs_1.default.readFileSync(0, "utf-8")));
    }
    catch {
        process.exit(0); // fail-open
    }
}
//# sourceMappingURL=GateToggle.js.map
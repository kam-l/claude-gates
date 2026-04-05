#!/usr/bin/env node
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

import fs from "fs";
import { Messaging, } from "./Messaging";
import { SessionManager, } from "./SessionManager";

const TOGGLE_PATTERN = /^gates?\s+(on|off|status)$/i;

export function parseToggleCommand(prompt: string,): "on" | "off" | "status" | null
{
  const match = prompt.trim().match(TOGGLE_PATTERN,);
  if (!match)
  {
    return null;
  }
  return match[1].toLowerCase() as "on" | "off" | "status";
}

export function onUserPromptSubmit(data: any,): void
{
  const prompt = data.prompt || "";
  const command = parseToggleCommand(prompt,);
  if (!command)
  {
    process.exit(0,);
  }

  if (command === "status")
  {
    const state = SessionManager.isGateDisabled() ? "OFF" : "ON";
    const out = { decision: "block", reason: Messaging.fmt("", `Gates are currently ${state}.`,), };
    process.stdout.write(JSON.stringify(out,),);
    process.exit(0,);
  }

  const disable = command === "off";
  SessionManager.setGateDisabled(disable,);

  const emoji = disable ? "⏸️" : "▶️";
  const verb = disable ? "disabled" : "re-enabled";
  const hint = disable ? " Type \"gate on\" to re-enable." : "";
  const out = { decision: "block", reason: Messaging.fmt(emoji, `Gates ${verb}.${hint}`,), };
  process.stdout.write(JSON.stringify(out,),);
  process.exit(0,);
}

// ── Entry point (guarded for import safety) ────────────────────────────

if (require.main === module)
{
  try
  {
    onUserPromptSubmit(JSON.parse(fs.readFileSync(0, "utf-8",),),);
  }
  catch
  {
    process.exit(0,); // fail-open
  }
}

#!/usr/bin/env node
"use strict";
/**
 * Pipeline v3 — SessionStart context injection.
 *
 * Scans for gated agents and displays a startup banner showing active gates,
 * verification pipelines, and toggle hints. Also injects behavioral guidance
 * so the orchestrator knows pipeline gates block other work.
 *
 * Fail-open.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.formatStep = formatStep;
exports.formatPipeline = formatPipeline;
exports.discoverGatedAgents = discoverGatedAgents;
exports.buildBanner = buildBanner;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const FrontmatterParser_1 = require("./FrontmatterParser");
const SessionManager_1 = require("./SessionManager");
const Enums_1 = require("./types/Enums");
const HOME = process.env.USERPROFILE || process.env.HOME || "";
const PROJECT_ROOT = process.cwd();
// ── Exported helpers (tested in PipelineTest.ts) ─────────────────────
function formatStep(step) {
    switch (step.type) {
        case Enums_1.StepType.Check:
            {
                const truncated = step.prompt.length > 40
                    ? step.prompt.slice(0, 40) + "..."
                    : step.prompt;
                return `CHECK("${truncated}")`;
            }
        case Enums_1.StepType.Verify:
            return `VERIFY(${step.agent}, ${step.maxRounds})`;
        case Enums_1.StepType.VerifyWithFixer:
            return `VERIFY(${step.agent}, ${step.maxRounds}, ${step.fixer})`;
        case Enums_1.StepType.Transform:
            return `TRANSFORM(${step.agent})`;
    }
    return step;
}
function formatPipeline(steps) {
    return steps.map(formatStep).join(" \u2192 ");
}
function discoverGatedAgents(projectDir, globalDir) {
    const seen = new Set();
    const results = [];
    function scanDir(dir, source) {
        let entries;
        try {
            entries = fs_1.default.readdirSync(dir);
        }
        catch {
            return;
        }
        for (const file of entries) {
            if (!file.endsWith(".md")) {
                continue;
            }
            const name = file.slice(0, -3);
            if (seen.has(name)) {
                continue;
            }
            try {
                const content = fs_1.default.readFileSync(path_1.default.join(dir, file), "utf-8");
                const steps = FrontmatterParser_1.FrontmatterParser.parseVerification(content);
                if (steps) {
                    seen.add(name);
                    results.push({ name, source, steps, });
                }
            }
            catch {
                // skip unreadable files
            }
        }
    }
    if (projectDir) {
        scanDir(path_1.default.join(projectDir, ".claude", "agents"), "project");
    }
    if (globalDir) {
        scanDir(path_1.default.join(globalDir, ".claude", "agents"), "global");
    }
    return results;
}
function buildBanner(gateDisabled) {
    const lines = [];
    lines.push(gateDisabled
        ? "[ClaudeGates] Session gates: PAUSED"
        : "[ClaudeGates] Session gates:");
    lines.push(gateDisabled
        ? "  Plan Gate: OFF"
        : "  Plan Gate: ON");
    const agents = discoverGatedAgents(PROJECT_ROOT, HOME);
    if (agents.length === 0) {
        lines.push("  (no gated agents)");
    }
    else {
        for (const agent of agents) {
            const suffix = agent.source === "global" ? " (global)" : "";
            lines.push(`  ${agent.name}: ${formatPipeline(agent.steps)}${suffix}`);
        }
    }
    lines.push(gateDisabled
        ? "Toggle: \"gate on\" to resume."
        : "Toggle: \"gate off\" to pause, \"gate on\" to resume.");
    const port = process.env.CLAUDE_GATES_PORT || "64735";
    lines.push(`Monitor: http://localhost:${port}`);
    return lines.join("\n");
}
// ── Main (only when run directly, not imported) ─────────────────────
if (require.main === module) {
    try {
        const gateDisabled = SessionManager_1.SessionManager.isGateDisabled();
        const banner = buildBanner(gateDisabled);
        process.stderr.write(banner + "\n");
        const modelContext = banner + "\n\n"
            + "Agents with `verification:` in their frontmatter have pipeline gates. "
            + "After each gated agent completes, its verification steps (reviewers, semantic checks) "
            + "will block other tools until processed. Plan accordingly: process gated agent results "
            + "before starting unrelated work. Run gated agents in foreground, not background.";
        process.stdout.write(JSON.stringify({ additionalContext: modelContext, }));
        process.exit(0);
    }
    catch {
        process.exit(0);
    }
}
//# sourceMappingURL=SessionContext.js.map
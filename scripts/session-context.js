#!/usr/bin/env node
"use strict";
/**
 * Pipeline v3 — SessionStart context injection.
 *
 * Injects a brief note about pipeline enforcement so the orchestrator
 * knows that gated agents have verification steps that block other work.
 *
 * Fail-open.
 */
Object.defineProperty(exports, "__esModule", { value: true });
try {
    process.stdout.write(JSON.stringify({
        additionalContext: "[ClaudeGates] Agents with `verification:` in their frontmatter have pipeline gates. " +
            "After each gated agent completes, its verification steps (reviewers, semantic checks) " +
            "will block other tools until processed. Plan accordingly: process gated agent results " +
            "before starting unrelated work. Run gated agents in foreground, not background."
    }));
    process.exit(0);
}
catch {
    process.exit(0);
}
//# sourceMappingURL=session-context.js.map
# Changelog

All notable changes to claude-gates. Grouped by minor version — patch releases omitted unless noteworthy.

## [4.4.0] — 2026-04-05

- **`gates on/off/status` toggle** — type `gates off` in the prompt to disable all pipeline gates project-wide; `gates on` to re-enable, `gates status` to check. UserPromptSubmit hook intercepts the command before it reaches the model. All 6 pipeline hooks respect the marker and exit early when disabled.
- **Plan gate works by default** — no setup required. Every `ExitPlanMode` is automatically gated by the plan-gate hook. Trivial plans (<=20 lines) bypass automatically; a safety valve auto-allows after 3 blocked attempts.
- **Pipeline is for multi-agent orchestration** — the `verification:` frontmatter pipeline is designed for agents that spawn other agents. It enforces a rigid workflow (source → check → verify → fix) across the entire agent lifecycle, not individual tool calls.

## [3.6.0] — 2026-03-31

- **Gater v2** — adversarial review lenses (accuracy, completeness, fit, freshness, redundancy), actionable block messages, verification injection ([#1](https://github.com/kam-l/claude-gates/pull/1))
- **Langfuse tracing** — opt-in observability via `tracing.js` with cross-process trace correlation stored in SQLite
- Example scenario walkthrough added to README

## [3.4.0] — 2026-03-30

- **Semantics-first redesign** — removed output structure injection from agent prompts. Agents think freely; structure is requested only at SubagentStop when the agent summarizes its work
- Verifiers pivoted at SubagentStop instead of SubagentStart
- Updated agents, skills, and tests for the new philosophy

## [3.3.0] — 2026-03-28

- Pipeline v3 stabilization (8 patch releases)
- Fixed CI test script path (`claude-gates-test.js` → `pipeline-test.js`)

## [3.0.0] — 2026-03-25

- **Pipeline v3** — new state machine engine (`pipeline.js`), unified `verification:` array format in agent frontmatter
- Pure CRUD separation: `pipeline-db.js` owns data, `pipeline.js` owns transitions
- Role-aware dispatch: source, verifier, fixer, ungated — each has distinct step() behavior
- Step types inferred from array shape: `SEMANTIC`, `COMMAND`, `REVIEW`, `REVIEW_WITH_FIXER`
- 93 unit tests + 30 end-to-end tests

## [2.11.0] — 2026-03-20

- Removed `requires:` field from frontmatter (simplified schema)
- Added ASCII lifecycle diagram to README

## [2.10.0] — 2026-03-18

- **Parallel safety** — `agent_id`-based artifact paths eliminate collision between concurrent pipelines
- 6 stabilization patches for scope isolation edge cases

## [2.9.0] — 2026-03-16

- Transcript-based scope resolution for parallel pipelines
- Gate-block now allows all subagents, only locks orchestrator
- Fixed inject path to use pattern, not explicit path (removed file-move race)

## [2.8.0] — 2026-03-14

- **Transcript-based scope resolution** — foundation for parallel agent execution with scope isolation
- Fixed subagent transcript path derivation from parent + agent_id
- Normalized `agentType` in gate transitions

## [2.7.0] — 2026-03-12

- **Edit-gate** repurposed as formatter runner (was file tracker only)
- **Stop-gate** added — scans for debug patterns (`TODO`, `console.log`), nudges uncommitted changes
- Scope-aware gate-block for parallel pipelines
- Case-insensitive `VERDICT_RE`
- `/update` command, `.gitignore` lock file

## Pre-2.7.0

Early versions (v2.1–v2.6) established the core architecture:

- **v2.6.0** — Universal gater agent, SQLite-only state, `plan-gate-clear.js`
- **v2.5.0** — Gate-block enforces all tools + fixer agent support
- **v2.4.0** — Database refactor: 8 tables → 4 tables
- **v2.3.0** — Config system (`claude-gates.json`), verdict-based plan-gate, commit-gate
- **v2.1.0** — SQLite state management, plan gate, adversary stamp
- **v1.0.0** — Initial standalone plugin: agent-gate with basic verification hooks

# Architecture Guide (for .NET developers)

This codebase is a Claude Code plugin written in Node.js. If you know C#/.NET, this guide maps every concept to something you already understand.

## Mental Model

```
Claude Code (the IDE)          claude-gates (this plugin)
=======================        ===========================
VS Extension / Middleware  →   Hook scripts in scripts/
IServiceCollection         →   require() calls at top of file
DbContext                  →   pipeline-db.js (static methods)
State machine / MediatR    →   pipeline.js (step function)
Middleware pipeline        →   Hook chain: conditions → injection → verification → block
```

**Each hook script = one .NET middleware component.** It reads JSON from stdin (like `HttpContext`), does work, optionally writes JSON to stdout (like modifying the `Response`), and exits with code 0 (like calling `next()`).

## Directory Structure

```
scripts/
  pipeline-shared.js          # Shared utilities — like a Utils/Helpers static class
  pipeline-db.js              # SQLite CRUD — like a Repository<T> (all static methods)
  pipeline.js                 # State machine engine — like IStateMachine.Step()
  messages.js                 # Output formatting — like ILogger with channels
  tracing.js                  # Langfuse observability — like AddOpenTelemetry() (opt-in)

  pipeline-conditions.js      # Hook: PreToolUse:Agent — pre-spawn gate
  pipeline-injection.js       # Hook: SubagentStart — context injection
  pipeline-verification.js    # Hook: SubagentStop — verdict processing (main logic)
  pipeline-block.js           # Hook: PreToolUse — blocks tools during active pipeline
  stop-gate.js                # Hook: OnStop — session cleanup

  commit-gate.js              # Hook: PreToolUse:Bash — commit validation
  edit-gate.js                # Hook: PostToolUse:Edit/Write — edit tracking
  plan-gate.js                # Hook: PreToolUse:ExitPlanMode — plan review gate
  plan-gate-clear.js          # Hook: PostToolUse:ExitPlanMode — clears plan gate
  session-cleanup.js          # Hook: SessionStart — cleanup old sessions
  session-context.js          # Hook: SessionStart — injects session context

  claude-gates-db.js          # Legacy v2 DB module (backward compat)
  claude-gates-config.js      # Config loader (claude-gates.json)

  pipeline-test.js            # Unit tests (93 tests — like [Fact] methods)
  test-pipeline-e2e.js        # E2E tests (30 tests)
  test-pipeline.js            # Older test file

.claude/agents/               # Agent definitions (YAML frontmatter + markdown body)
.claude-plugin/plugin.json    # Plugin manifest (like a .csproj for packaging)
```

## Data Flow — One Pipeline Run

```
Step 1: User asks Claude to spawn an agent with scope=my-task
        ↓
Step 2: pipeline-conditions.js (PreToolUse:Agent)
        ├─ Reads agent .md file, parses conditions: field
        ├─ Runs semantic pre-check (optional): "Is the codebase ready?"
        ├─ Registers agent in SQLite (agents table)
        ├─ Writes .running-{scope} marker file
        └─ Exits 0 (allows spawn) or writes { decision: "block" } (blocks spawn)
        ↓
Step 3: pipeline-injection.js (SubagentStart)
        ├─ Creates pipeline: inserts pipeline_state + pipeline_steps rows
        ├─ Resolves agent role: source | verifier | fixer
        ├─ Injects context for verifiers/fixers (artifact path, round info)
        └─ Exits 0 (with optional additionalContext in stdout JSON)
        ↓
Step 4: Agent runs... (Claude Code handles this, not our code)
        ↓
Step 5: pipeline-verification.js (SubagentStop)  ← THIS IS THE MAIN FILE
        ├─ Resolves scope (transcript → message → DB fallback)
        ├─ Finds/creates artifact file ({scope}/{agentType}.md)
        ├─ Dispatches by role:
        │   source   → run SEMANTIC check if active step is SEMANTIC
        │   verifier → run implicit semantic check + extract Result: verdict
        │   fixer    → run implicit semantic check
        ├─ Calls engine.step(db, scope, { role, artifactVerdict, semanticVerdict })
        │   ↓ returns next Action:
        │   { action: "spawn", agent: "reviewer" }  → reviewer needs to run
        │   { action: "source", agent: "worker" }   → source needs revision
        │   { action: "done" }                       → pipeline complete!
        │   { action: "failed" }                     → exhausted max rounds
        └─ Writes notification to .pipeline-notifications file
        ↓
Step 6: pipeline-block.js (PreToolUse — fires on EVERY tool call)
        ├─ Queries engine.getAllNextActions(db) — what's expected?
        ├─ If tool call matches expected action → exit 0 (allow)
        ├─ If not → write { decision: "block", reason: "Spawn reviewer first" }
        └─ Surfaces notifications from Step 5 via systemMessage
        ↓
Step 7: Repeat Steps 2-6 for each agent in the pipeline
        (reviewer runs → verification checks verdict → next step or done)
```

## State Machine (pipeline.js)

```
                    ┌─────────────────────────────────────────────┐
                    │              Pipeline States                 │
                    │                                              │
   createPipeline() │  ┌────────┐    PASS     ┌───────────┐      │
   ─────────────────┼─→│ normal │────────────→│ completed │      │
                    │  └────┬───┘             └───────────┘      │
                    │       │                                      │
                    │       │ REVISE                               │
                    │       ↓                                      │
                    │  ┌──────────┐   source/fixer    ┌────────┐  │
                    │  │ revision │───completes───────→│ normal │  │
                    │  └────┬─────┘   (reactivate)    └────────┘  │
                    │       │                                      │
                    │       │ rounds > maxRounds                   │
                    │       ↓                                      │
                    │  ┌────────┐                                  │
                    │  │ failed │                                  │
                    │  └────────┘                                  │
                    └─────────────────────────────────────────────┘

Step statuses: pending → active → passed
                              ↘ revise (source must redo)
                              ↘ fix    (fixer must fix)
                              ↘ failed (exhausted rounds)
```

## Key .NET ↔ JS Patterns

### "DI" — There is none
JS uses `require()` at the top of each file. Every dependency is a static import. There's no IoC container — functions just call other functions directly.

### "Entity Framework" — It's raw SQL
`pipeline-db.js` uses `better-sqlite3` which is like using `SqlConnection` + `SqlCommand` directly. `db.prepare("SQL").run(params)` = `command.ExecuteNonQuery()`. Rows come back as plain objects (like anonymous types), not tracked entities.

### "async/await" — Almost nothing is async
All file I/O uses `readFileSync`, all DB calls are synchronous. The only async operation is Langfuse's `shutdownAsync()`, which is deliberately fire-and-forget.

### "Middleware" → Hook scripts
Each hook script is registered in `.claude-plugin/plugin.json` and fires on specific events (like `app.UseMiddleware<T>()` for different request types). The "next()" equivalent is `process.exit(0)`.

### Error handling → try/catch + exit 0
Every hook wraps its entire body in `try { ... } catch { process.exit(0) }`. This is the "fail-open" pattern — if anything goes wrong, the hook silently allows the operation to proceed. Like middleware that calls `next()` in its catch block.

## Testing

```bash
node scripts/pipeline-test.js       # 93 unit tests — tests pipeline-db + pipeline.js
node scripts/test-pipeline-e2e.js   # 30 e2e tests — tests hook scripts end-to-end
```

Tests use a simple `test(name, fn)` / `assert` pattern (no Jest/Mocha). Like `[Fact]` methods in xUnit but without a test runner — just a script that runs assertions and counts pass/fail.

## Observability (Langfuse)

Opt-in via environment variables. When enabled, each pipeline run produces a Langfuse trace with spans for key operations (pipeline creation, verdict processing, semantic checks, engine state transitions). See `scripts/tracing.js` for the .NET analogy comments.

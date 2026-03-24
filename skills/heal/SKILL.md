---
description: "Diagnose and repair broken claude-gates pipeline state. Use when: gate is stuck, 'gate blocked' after agent completed, stale gate rows, gates not firing, agent completed but no gates spawned, pipeline frozen, 'Spawn: X (scope=Y)' blocking wrong agent, gate-block won't unblock, need to clear gates, reset pipeline."
allowed-tools: Read, Grep, Glob
argument-hint: [session-id]
---

## Important

Pipeline-block hooks may be blocking tool calls in the stuck session. ALL database commands MUST be given to the user as `! ...` commands to copy-paste themselves. Do NOT attempt to run them via Bash — the `!` prefix runs shell commands in the Claude Code terminal, bypassing hook blocks.

## Process

1. **Get session ID.** If `$ARGUMENTS` is empty, ask: "Paste the session ID (UUID) from the stuck session."

2. **Construct DB path.** Build the path and substitute it into all commands below:
   - Windows: `C:\Users\{USERNAME}\.claude\sessions\{SESSION_ID}\session.db`
   - macOS/Linux: `~/.claude/sessions/{SESSION_ID}/session.db`
   Use forward slashes in the node commands regardless of OS.

3. **Dump state.** Present this diagnostic command for the user to run — substitute the real DB path for `DB_PATH`:

```
! node -e "const Database = require(require('path').join(process.env.CLAUDE_PLUGIN_DATA, 'node_modules', 'better-sqlite3')); const db = new Database(process.argv[1]); console.log('=== V3 PIPELINES ==='); try { db.prepare('SELECT scope, source_agent, status, current_step_index FROM pipeline_state').all().forEach(r => console.log(JSON.stringify(r))); } catch { console.log('(no v3 tables)'); } console.log('=== V3 STEPS ==='); try { db.prepare('SELECT scope, step_index, step_type, status, agent, fixer, round, max_rounds FROM pipeline_steps ORDER BY scope, step_index').all().forEach(r => console.log(JSON.stringify(r))); } catch { console.log('(no v3 tables)'); } console.log('=== V2 GATES ==='); try { db.prepare('SELECT scope, gate_agent, source_agent, fixer_agent, status, round, max_rounds FROM gates ORDER BY scope').all().forEach(r => console.log(JSON.stringify(r))); } catch { console.log('(no v2 tables)'); } console.log('=== AGENTS ==='); try { db.prepare('SELECT scope, agent, verdict FROM agents WHERE scope != \"_meta\"').all().forEach(r => console.log(JSON.stringify(r))); } catch {} console.log('=== BLOCKING ==='); let b = []; try { b.push(...db.prepare('SELECT scope, step_index, step_type, status, agent FROM pipeline_steps WHERE status IN (\"active\",\"revise\",\"fix\")').all().map(r => 'v3: ' + r.scope + ' step ' + r.step_index + ' (' + r.step_type + ') status=' + r.status + (r.agent ? ' agent=' + r.agent : ''))); } catch {} try { b.push(...db.prepare('SELECT scope, gate_agent, status FROM gates WHERE status IN (\"active\",\"revise\",\"fix\")').all().map(r => 'v2: ' + r.scope + '/' + r.gate_agent + ' status=' + r.status)); } catch {} if (!b.length) console.log('NONE'); else b.forEach(x => console.log(x)); db.close();" "DB_PATH"
```

4. **Analyze** the user's output. Present findings using this table:

| Symptom | Likely cause |
|---------|-------------|
| v3 step `active` but agent completed | Verification hook errored silently, or agent didn't write to output_filepath |
| v3 pipeline `revision` stuck | Source/fixer completed but verification hook didn't process reactivation |
| v3 step `fix` stuck | Fixer completed but engine.step() wasn't called |
| v2 gate `active` but agent completed | Gate agent's .md lacks `verification:` field |
| BLOCKING = NONE but still blocked | Stale plugin cache — check version with `claude plugin list` |
| Steps/gates EMPTY | `scope=` missing from spawn prompt, or pipeline never created |

Ask: "What would you like to do?" with options:
- **Complete pipeline** (v3) — mark all steps passed for a scope
- **Delete pipeline** (v3) — remove pipeline rows so it recreates on next spawn
- **Pass v2 gates** — mark all v2 blocking gates as passed for a scope
- **Nuclear clear** — clear ALL blocking state across v2 + v3
- **Nothing** — just wanted the diagnosis

5. **Output fix command.** Substitute `DB_PATH` and `SCOPE` with actual values:

**Complete v3 pipeline for scope:**
```
! node -e "const Database = require(require('path').join(process.env.CLAUDE_PLUGIN_DATA, 'node_modules', 'better-sqlite3')); const db = new Database(process.argv[1]); db.transaction(() => { db.prepare(\"UPDATE pipeline_steps SET status = 'passed' WHERE scope = ?\").run(process.argv[2]); db.prepare(\"UPDATE pipeline_state SET status = 'completed' WHERE scope = ?\").run(process.argv[2]); })(); console.log('Completed pipeline for scope:', process.argv[2]); db.close();" "DB_PATH" "SCOPE"
```

**Delete v3 pipeline (allows recreation on re-spawn):**
```
! node -e "const Database = require(require('path').join(process.env.CLAUDE_PLUGIN_DATA, 'node_modules', 'better-sqlite3')); const db = new Database(process.argv[1]); db.transaction(() => { db.prepare('DELETE FROM pipeline_steps WHERE scope = ?').run(process.argv[2]); db.prepare('DELETE FROM pipeline_state WHERE scope = ?').run(process.argv[2]); })(); console.log('Deleted pipeline for scope:', process.argv[2]); db.close();" "DB_PATH" "SCOPE"
```

**Pass all v2 gates for scope:**
```
! node -e "const Database = require(require('path').join(process.env.CLAUDE_PLUGIN_DATA, 'node_modules', 'better-sqlite3')); const db = new Database(process.argv[1]); const r = db.prepare(\"UPDATE gates SET status = 'passed' WHERE scope = ?\").run(process.argv[2]); console.log('Passed', r.changes, 'v2 gates for scope:', process.argv[2]); db.close();" "DB_PATH" "SCOPE"
```

**Nuclear clear (all blocking state, all scopes):**
```
! node -e "const Database = require(require('path').join(process.env.CLAUDE_PLUGIN_DATA, 'node_modules', 'better-sqlite3')); const db = new Database(process.argv[1]); let c = 0; try { c += db.prepare(\"UPDATE pipeline_steps SET status = 'passed' WHERE status IN ('active','revise','fix')\").run().changes; c += db.prepare(\"UPDATE pipeline_state SET status = 'completed' WHERE status IN ('normal','revision')\").run().changes; } catch {} try { c += db.prepare(\"UPDATE gates SET status = 'passed' WHERE status IN ('active','revise','fix')\").run().changes; } catch {} console.log('Cleared', c, 'blocking entries'); db.close();" "DB_PATH"
```

6. **Verify.** Tell user to re-run the diagnostic command from step 3 and confirm BLOCKING = NONE. Then tell them to retry their action in the stuck session.

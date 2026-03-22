---
description: "Diagnose and repair broken claude-gates pipeline state. Use when: gate is stuck, 'gate blocked' after agent completed, stale gate rows, gates not firing, agent completed but no gates spawned, pipeline frozen, 'Spawn: X (scope=Y)' blocking wrong agent, gate-block won't unblock, need to clear gates, reset pipeline."
allowed-tools: Bash(node *), Read, Grep, Glob
argument-hint: [session-id]
---

## Process

1. **Get session ID.** If `$ARGUMENTS` is empty, `AskUserQuestion`: "Which session needs healing? Paste the session ID (UUID from the stuck session)."

2. **Locate DB.** Substitute the session ID into this command and run it:

```bash
node -e "
const path = require('path');
const HOME = process.env.USERPROFILE || process.env.HOME;
const dbPath = path.join(HOME, '.claude', 'sessions', process.argv[1], 'session.db');
require('fs').existsSync(dbPath) ? console.log(dbPath) : (console.error('NOT FOUND:', dbPath), process.exit(1));
" "THE_SESSION_ID"
```

If not found, `AskUserQuestion`: "DB not found. Is the session ID correct?"

3. **Dump state.** Substitute the DB path from step 2:

```bash
node -e "
const Database = require(require('path').join(process.env.CLAUDE_PLUGIN_DATA, 'node_modules', 'better-sqlite3'));
const db = new Database(process.argv[1]);
const gates = db.prepare('SELECT scope, gate_agent, source_agent, fixer_agent, status, round, max_rounds, \"order\" FROM gates ORDER BY scope, \"order\"').all();
const agents = db.prepare('SELECT scope, agent, verdict FROM agents WHERE scope != \"_meta\"').all();
console.log('=== GATES ===');
if (!gates.length) console.log('EMPTY');
else gates.forEach(g => console.log(JSON.stringify(g)));
console.log('=== AGENTS ===');
if (!agents.length) console.log('EMPTY');
else agents.forEach(a => console.log(JSON.stringify(a)));
const blocking = gates.filter(g => ['active','revise','fix'].includes(g.status));
console.log('=== BLOCKING ===');
if (!blocking.length) console.log('NONE');
else blocking.forEach(g => console.log(g.gate_agent + ' scope=' + g.scope + ' status=' + g.status));
db.close();
" "THE_DB_PATH"
```

4. **Present findings with `AskUserQuestion`.** Show blocking gates and diagnosis:

| Symptom | Likely cause |
|---------|-------------|
| Gate `active` but agent already completed | Gate agent's .md lacks `verification:` field, or verification hook errored silently |
| Gates EMPTY after source completed | `scope=` missing from spawn prompt, or conditions hook was blocked by a stale gate |
| Wrong scope blocking (e.g. task-2 blocks task-3) | Previous scope's gates not cleaned up after final PASS |
| `status = 'fix'` stuck | Fixer completed but transition not processed |
| `status = 'revise'` stuck | Source agent didn't re-run with scope |

   Ask: "What would you like to do?" with choices:
   - **Pass specific gate** — mark one gate as passed
   - **Pass all gates for scope** — unblock entire scope
   - **Init gates for scope** — create gate rows from source agent's definition
   - **Nuclear clear** — pass ALL blocking gates across all scopes
   - **Nothing** — just wanted the diagnosis

5. **Execute chosen fix.** Substitute DB path, scope, and agent name into the chosen command:

**Pass specific gate:**
```bash
node -e "
const Database = require(require('path').join(process.env.CLAUDE_PLUGIN_DATA, 'node_modules', 'better-sqlite3'));
const db = new Database(process.argv[1]);
db.prepare(\"UPDATE gates SET status = 'passed' WHERE scope = ? AND gate_agent = ?\").run(process.argv[2], process.argv[3]);
console.log('Done');
db.close();
" "THE_DB_PATH" "THE_SCOPE" "THE_GATE_AGENT"
```

**Pass all gates for scope:**
```bash
node -e "
const Database = require(require('path').join(process.env.CLAUDE_PLUGIN_DATA, 'node_modules', 'better-sqlite3'));
const db = new Database(process.argv[1]);
const r = db.prepare(\"UPDATE gates SET status = 'passed' WHERE scope = ?\").run(process.argv[2]);
console.log('Passed', r.changes, 'gates');
db.close();
" "THE_DB_PATH" "THE_SCOPE"
```

**Init gates for scope:** Read the source agent's `.md` file (use `findAgentMd` lookup: `.claude/agents/{type}.md` in project, then `~/.claude/agents/`). Parse its `gates:` YAML entries as `[agent, maxRounds]` or `[agent, maxRounds, fixer]`. Then:

```bash
node -e "
const Database = require(require('path').join(process.env.CLAUDE_PLUGIN_DATA, 'node_modules', 'better-sqlite3'));
const db = new Database(process.argv[1]);
const scope = process.argv[2];
const source = process.argv[3];
// gates: JSON array of [agent, maxRounds, fixer?]
const gates = JSON.parse(process.argv[4]);
const ins = db.prepare('INSERT INTO gates (scope, \"order\", gate_agent, source_agent, fixer_agent, max_rounds, round, status) VALUES (?, ?, ?, ?, ?, ?, 0, ?)');
db.transaction(() => {
  gates.forEach((g, i) => ins.run(scope, i + 1, g[0], source, g[2] || null, g[1], i === 0 ? 'active' : 'pending'));
  db.prepare('INSERT OR REPLACE INTO agents (scope, agent, outputFilepath) VALUES (?, ?, null)').run(scope, source);
})();
console.log('Initialized', gates.length, 'gates for', scope);
db.close();
" "THE_DB_PATH" "THE_SCOPE" "SOURCE_AGENT_TYPE" '[[\"cleaner\",1],[\"reviewer\",3]]'
```

**Nuclear clear:**
```bash
node -e "
const Database = require(require('path').join(process.env.CLAUDE_PLUGIN_DATA, 'node_modules', 'better-sqlite3'));
const db = new Database(process.argv[1]);
const r = db.prepare(\"UPDATE gates SET status = 'passed' WHERE status IN ('active','revise','fix')\").run();
console.log('Cleared', r.changes, 'blocking gates');
db.close();
" "THE_DB_PATH"
```

6. **Verify.** Re-run the diagnostic from step 3. Confirm blocking gates = NONE. Tell user to retry their action.

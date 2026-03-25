---
description: "Diagnose and repair broken claude-gates pipeline state. Use when: gate is stuck, 'gate blocked' after agent completed, stale gate rows, gates not firing, agent completed but no gates spawned, pipeline frozen, 'Spawn: X (scope=Y)' blocking wrong agent, gate-block won't unblock, need to clear gates, reset pipeline."
allowed-tools: Read, Grep, Glob
argument-hint: [session-id]
---

Pipeline-block hooks block tool calls in the stuck session. ALL database commands MUST be given as `! ...` commands for the user to run. The `!` prefix runs in Claude Code's terminal, bypassing hook blocks.

## Process

1. **Resolve session ID.** Use `$ARGUMENTS` if provided. Otherwise, check if the current session is stuck (most common case) — the session ID is in the conversation context. Only ask if neither is available.

2. **Build the `! ...` diagnostic command** with the real DB path substituted (forward slashes regardless of OS).
   Session data lives under the project root: `{CWD}/.sessions/{SESSION_ID}/session.db`

   The `better-sqlite3` require resolves via `CLAUDE_PLUGIN_DATA`:
   ```
   require(require('path').join(process.env.CLAUDE_PLUGIN_DATA,'node_modules','better-sqlite3'))
   ```

Present this diagnostic command with the real DB path:

```
! node -e "const db=require(require('path').join(process.env.CLAUDE_PLUGIN_DATA,'node_modules','better-sqlite3'))('DB_PATH');console.log('=== BLOCKING ===');let b=[];try{b.push(...db.prepare(\"SELECT scope,step_index,step_type,status,agent FROM pipeline_steps WHERE status IN ('active','revise','fix')\").all().map(r=>'v3: '+r.scope+' step '+r.step_index+' ('+r.step_type+') status='+r.status+(r.agent?' agent='+r.agent:'')))}catch{}try{b.push(...db.prepare(\"SELECT scope,gate_agent,status FROM gates WHERE status IN ('active','revise','fix')\").all().map(r=>'v2: '+r.scope+'/'+r.gate_agent+' status='+r.status))}catch{}if(!b.length)console.log('NONE');else b.forEach(x=>console.log(x));console.log('=== PIPELINES ===');try{db.prepare('SELECT scope,source_agent,status,current_step FROM pipeline_state').all().forEach(r=>console.log(JSON.stringify(r)))}catch{console.log('(no v3)')}console.log('=== STEPS ===');try{db.prepare('SELECT scope,step_index,step_type,status,agent,round,max_rounds FROM pipeline_steps ORDER BY scope,step_index').all().forEach(r=>console.log(JSON.stringify(r)))}catch{}db.close()"
```

3. **Auto-diagnose** from the user's output and **output the fix command** — no menu. Use this decision tree:

| Symptom | Diagnosis | Fix |
|---------|-----------|-----|
| Single scope blocking | Pipeline stuck for one scope | **Delete scope** |
| Multiple scopes blocking | Multiple stuck pipelines | **Nuclear clear** |
| `pipeline_state` status=`revision` | Source got REVISE but re-spawn didn't happen | **Delete scope** (re-spawn will recreate) |
| BLOCKING = NONE but still blocked | Stale plugin cache | Tell user: `claude plugin list` to check version, restart Claude Code |
| No tables / empty | Pipeline never created | `scope=` was missing from spawn prompt — no DB fix needed |
| v3 step `active`, agent completed | Verification hook errored silently | **Delete scope** (re-spawn will recreate) |

**Delete v3 pipeline for scope** (substitute DB_PATH and SCOPE):
```
! node -e "const db=require(require('path').join(process.env.CLAUDE_PLUGIN_DATA,'node_modules','better-sqlite3'))('DB_PATH');db.exec(\"DELETE FROM pipeline_steps WHERE scope='SCOPE'\");db.exec(\"DELETE FROM pipeline_state WHERE scope='SCOPE'\");db.exec(\"DELETE FROM agents WHERE scope='SCOPE'\");console.log('Deleted scope: SCOPE');db.close()"
```

**Nuclear clear** (substitute DB_PATH):
```
! node -e "const db=require(require('path').join(process.env.CLAUDE_PLUGIN_DATA,'node_modules','better-sqlite3'))('DB_PATH');let c=0;const scopes=[];try{db.prepare(\"SELECT scope FROM pipeline_state WHERE status IN ('normal','revision')\").all().forEach(r=>scopes.push(r.scope));c+=db.prepare(\"DELETE FROM pipeline_steps WHERE scope IN (SELECT scope FROM pipeline_state WHERE status IN ('normal','revision'))\").run().changes;c+=db.prepare(\"DELETE FROM agents WHERE scope IN (SELECT scope FROM pipeline_state WHERE status IN ('normal','revision'))\").run().changes;c+=db.prepare(\"DELETE FROM pipeline_state WHERE status IN ('normal','revision')\").run().changes}catch{}try{c+=db.prepare(\"DELETE FROM gates WHERE status IN ('active','revise','fix')\").run().changes}catch{}console.log('Cleared '+c+' entries for scopes: '+scopes.join(', '));db.close()"
```

4. **Verify.** After user runs the fix, tell them to retry their action. If still stuck, re-run diagnostic from step 2.

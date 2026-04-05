---
name: unblock
description: "Nuclear pipeline unblock — force-deletes stuck pipelines and clears markers. Use when: gate is stuck, 'gate blocked' after agent completed, pipeline frozen, need to clear gates, reset pipeline, unblock session."
argument-hint: "[session-id] [scope]"
disable-model-invocation: true
---

Output this command for the user to run. Substitute SESSION_ID from `$ARGUMENTS` or the current session ID.

If a scope is provided in `$ARGUMENTS`, include it as the second argument.

```
! node ${CLAUDE_PLUGIN_ROOT}/scripts/unblock.js SESSION_ID [SCOPE]
```

That's it. The script handles diagnosis, deletion, and marker cleanup.

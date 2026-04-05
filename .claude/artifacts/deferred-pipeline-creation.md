# Deferred Pipeline Creation

Pipelines are created during SubagentStop (not SubagentStart) to enable parallel source agents with different scopes to run concurrently.

- **Timing**: Pipeline creation deferred from SubagentStart to SubagentStop hook
- **Trigger**: Source agent completes, frontmatter parsed, scope extracted, verification steps resolved
- **Isolation**: Multiple agents with different `scope=` values run in parallel without contention
- **Safety**: Check guards against duplicate pipelines via `repo.pipelineExists()`

This design eliminates the race condition where concurrent source agents would collide during early pipeline creation, allowing true parallel execution while maintaining correctness.

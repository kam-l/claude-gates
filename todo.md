# claude-gates TODO

## Unify verification: and gates: into single field
- Merge `verification:` prompt and `gates:` agent list into one `verification:` field
- String entries = semantic prompt (Layer 2 `claude -p`), array entries = agent gate
- Example:
  ```yaml
  verification:
    - "Evaluate whether this artifact demonstrates real implementation"
    - [reviewer, 3]
    - [playtester, 2]
  ```
- Backward compat: keep parsing old `gates:` + `verification:` format
- Rename internal `parseGates` → `parseChains` (alias old name)

## ~~Fix output_filepath to use project-local path~~ DONE
- Moved all session data (artifacts + DB) from `~/.claude/sessions/{id}/` to `{CWD}/.sessions/{id}/`
- Shared `getSessionDir()` in pipeline-shared.js, replaces 11 hardcoded path constructions
- session-cleanup.js sweeps both new and legacy locations
- `.sessions/` added to .gitignore

## ~~Fix: gate rows not cleared after final PASS~~ DONE
- Root cause: verification hook's no-verification block only handled fixers/sources, not gate agents
- Gate agents with no verification:/gates: in their own .md exited silently, leaving gate row as 'active'
- Fixed: added gate agent lookup in no-verification block of claude-gates-verification.js
- Added 2 E2E tests: bare gate PASS + bare gate REVISE (318 total, 0 failures)

---
description: "Bump plugin version, sync docs, commit, tag, and push. Use when: 'bump', 'release', 'update version', 'push a new version'."
disable-model-invocation: true
allowed-tools: Bash, Read, Edit, Grep, Glob
argument-hint: "[major | minor | patch]"
---

## Steps

1. **Read current version** from `package.json` (field `"version"`).

2. **Compute new version.** Parse as semver. Apply bump type from `$ARGUMENTS` (default `patch`).

3. **Bump version** in exactly two files (replace all occurrences):
   - `package.json`
   - `.claude-plugin/plugin.json`

4. **Sync README.md.** Count `### .*Gate$` headings in README.md. If the gates badge number differs from the count, update it.

5. **Run tests.** Execute `node scripts/claude-gates-test.js`. If any test fails, stop and report — do not commit broken code.

6. **Commit.** Stage only changed files by name. Message format:
   ```
   chore: bump to v{NEW_VERSION}
   ```

7. **Tag.** Create git tag `v{NEW_VERSION}`.

8. **Push.** `git push && git push --tags`.

9. **Report.** Print the new version and remind user to reinstall: `claude plugin marketplace add kam-l/claude-gates`

## Invariants

- NEVER use `git add -A` or `git add .` — stage specific files only.
- NEVER skip tests. A failing test means the bump is wrong.
- NEVER amend previous commits — always create new ones.

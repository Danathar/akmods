---
name: run-checks
description: Run the local, host-safe verification suite for Danathar/akmods (shellcheck, actionlint, bats unit tests, node tests). Use before committing or opening a PR. Never runs just build/test or containers.
---

# run-checks

Run from the repo root, serially. These are the only local checks allowed; container work is CI-only.

1. `actionlint` — workflow lint.
2. `shellcheck` on changed shell scripts (e.g. `git diff --name-only origin/main -- '*.sh'`).
3. `npx --yes bats@1.11.1 tests/unit` — unit tests (if `tests/unit` exists on your branch).
4. `node --test` — Node tooling tests (`scripts/tests/*.test.mjs`, `.claude/hooks/tests/*.test.mjs`).

Never run `just build|test|fetch-kernel|push|manifest|clean`, `sudo`, package installs or local containers.
`tests/e2e/run.sh` runs in a container: leave it to CI (`E2E (fedora container)`).

Report which checks ran and which were skipped because files don't exist yet. Afterwards:
`gh pr checks <PR> -R Danathar/akmods --watch`.

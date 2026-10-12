# Copilot instructions

The authoritative agent guide is [`AGENTS.md`](../AGENTS.md). Read it before suggesting changes.

Critical rules (full text in AGENTS.md):

- This is a fork of `ublue-os/akmods`; upstream is read-only. Never target it with issues or PRs.
- Do not suggest running `just build|test|fetch-kernel|push|manifest|clean`, `sudo`, package installs, or
  local container builds; those run only in CI.
- Prefer new fork-local files over edits to upstream-owned files (`Justfile`, `build_files/`, `images.yaml`,
  generated `build-akmods-*.yml`).
- Changes that add/remove a fork delta must update `FORK-PATCHES.md`.

Reviewing PRs: use `.github/prompts/review-pr.prompt.md`. Prompt catalog: `.github/prompts/README.md`.

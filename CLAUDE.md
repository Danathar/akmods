# CLAUDE.md

Read [`AGENTS.md`](AGENTS.md) first — it is the authoritative agent guide for this repo (fork rules, host
safety, testing, PR conventions). This file only adds Claude Code notes.

Critical rules (full text in AGENTS.md):

- Fork of `ublue-os/akmods`; upstream is read-only. All `gh` writes use `-R Danathar/akmods`.
- Never run `just build|test|fetch-kernel|push|manifest|clean`, `sudo`, package installs or local containers.
- Any change adding/removing a fork delta must update `FORK-PATCHES.md`.

Claude Code specifics:

- Skills live in `.claude/skills/` (`run-checks`, `upstream-sync`, `fork-patch-audit`); reusable prompts are
  catalogued in `.github/prompts/README.md`.
- Project settings and the Bash guard hook are in `.claude/settings.json` and `.claude/hooks/`; session
  continuity is in `.claude/session-summary.md` and `.claude/memory/`. Read the session summary at the start
  of a session and update it at the end.

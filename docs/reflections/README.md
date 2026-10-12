# Reflections

A reflection is a dated, short account of how a piece of work in this
repository actually went, and what to do differently next time. It is for
patterns in the work itself, not for facts about the code.

**Host rule.** This is a workstation-hosted checkout: agents never run
`just build|test|fetch-kernel|push|manifest|clean`, `sudo`, a package install,
`podman build|push|login|system prune` or `cosign sign`, and never write real
signing keys into `certs/`; container verification runs in GitHub Actions. Pull
requests and issues go to `Danathar/akmods` (`--repo Danathar/akmods`), never
to the read-only upstream `ublue-os/akmods`.

## Where things go

| Place | Holds | Lifetime |
|---|---|---|
| `AGENTS.md` | standing rules | durable |
| [.claude/memory/](../../.claude/memory/README.md) | one specific mistake and its rule | until no longer true |
| [.claude/session-summary.md](../../.claude/session-summary.md) | what is in flight now | overwritten each session |
| [FORK-PATCHES.md](../../FORK-PATCHES.md) | every deliberate difference from upstream, with its removal condition | until the patch is dropped |
| this directory | recurring patterns in how the work goes | dated, kept |

Example of the split: "an empty `KERNEL_PRIVKEY` writes a 1-byte key" is a
correction (memory). "Our PR checks passed while the scheduled build could not
pass, because the two paths differ in what they exercise" is a reflection.

## When to write one

- After a PR where review or CI found something the author's own checks missed.
- After an incident, a revert, or a surprise during a rollout or an upstream merge.
- When the same kind of problem has come up twice.

Do not write one for routine work that went as planned.

## Format

File name `YYYY-MM-DD-<topic>.md`. Sections:

```markdown
# <title>

**Date:** YYYY-MM-DD
**Context:** which PRs/issues/commits this is about

## What happened
Observed events only, each with a PR, commit, run or file reference.

## What it shows
The pattern, stated as narrowly as the evidence allows.

## What to do next time
Concrete practices. If one hardens into a standing rule, move it to AGENTS.md.
```

Rules: no event that cannot be traced to a PR, commit, run or file; mark guesses
as `[INFERENCE]`; link to the evidence instead of retelling it; delete or amend
an entry that later proves wrong. If a reflection produces a specific do/don't,
also add a correction in `.claude/memory/`. PRs and issues in other
repositories are written `Owner/repo#N`.

## Index

| Entry | Subject |
|---|---|
| [2026-10-11-fork-history-lessons](2026-10-11-fork-history-lessons.md) | What the T2 target, the 1-byte signing key and the post-merge `git: command not found` show about verifying a fork whose builds run elsewhere |
| [2026-10-11-acmm-lessons-from-openaudible](2026-10-11-acmm-lessons-from-openaudible.md) | What the same ACMM rollout on `Danathar/openaudible-autoupdate` taught, applied to this repository's guard hook |

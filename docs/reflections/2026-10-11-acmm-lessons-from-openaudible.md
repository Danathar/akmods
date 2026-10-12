# What the ACMM rollout on openaudible-autoupdate taught, applied here first

**Date:** 2026-10-11
**Context:** the 46 open `[ACMM ...]` issues on `Danathar/akmods` (#7-#52) are
worked as parallel slices, one PR each (#53-#56 and this one). The same rollout
ran on `Danathar/openaudible-autoupdate`; its merged tree and
`docs/reflections/2026-10-09-acmm-lessons-from-tududi.md` are the starting
material, and they in turn drew on `Danathar/tududi#53` and `#60`.

## What happened

- **The guard hook is inherited, not rewritten.** `.claude/hooks/guard-bash.mjs`
  and its tests started from `Danathar/openaudible-autoupdate`'s copy at
  `.claude/hooks/guard-bash.mjs`, which already carried the fixes found in
  review of `Danathar/tududi#53` (8 of its 12 commits are `fix(hooks)`): a threat model at the top
  ("careless misuse, not deliberate obfuscation"), a fail-closed `gh` allowlist,
  `git config`/`git remote`/`env -S`/`xargs` handling.
- **Only the host-safety half was replaced.** openaudible's hook protects a
  single script that runs `sudo dnf install`, and its one exemption is "run it
  with stubs on PATH", checked on disk. This repository has no such script; its
  dangerous surface is the Justfile (`build`, `test`, `fetch-kernel`, `push`,
  `manifest`, `clean`, `generate-workflows`), `fetch-kernel.sh` and
  `build_files/**`, podman, cosign and `certs/`. There is no stub exemption here:
  the safe forms are `--dry-run`/`--evaluate`/`--list` and CI.
- **The fork shape added a new rule class.** openaudible is not a fork. Here the
  likeliest wrong-repository write is to the upstream, so `ublue-os/akmods` gets
  its own refusal messages and `git push upstream` / pushing to the upstream
  URL are blocked; `git remote set-url --push` stays limited to `DISABLE`.
- **CI image sources.** The inherited lesson that Docker Hub's anonymous pull
  limit fails every PR at once (`Danathar/tududi#58`) is applied by the CI
  slice: this repo's own build already uses `quay.io/fedora/fedora` and
  `quay.io/centos/centos` as builders (`Justfile` `builder`).

## What it shows

- Copying a hardened guard saves the review rounds, but the part that is
  repository-specific (what is actually dangerous here) must be rewritten from
  the repo's own history, not carried over. [INFERENCE] Here that history was
  `FORK-PATCHES.md`.
- A fork needs the guard to know about its upstream; a generic "other
  repository" refusal does not tell the agent why `ublue-os/akmods` is off limits.
- The tests are the specification: one case per rule with its allowed
  counterpart (`just build` blocked, `just --dry-run build` allowed) is what keeps
  a later tightening from breaking the read-only forms agents need.

## What to do next time

- Start a new repo's guard from the latest merged copy in the fleet, delete the
  host-specific half, and write the new repo's dangerous commands from its
  Justfile/workflows before writing rules.
- Fail closed for anything not on the allowlist (unknown `gh` groups, any
  recipe not under `--dry-run`); add the specific message second.
- Keep `node --test` as the single command that runs hook tests, so CI
  (`agent-tooling.yml`) and local runs agree.

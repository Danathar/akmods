# AGENTS.md — directions for any AI agent working in this repo

This file is the **authoritative** agent guide. `CLAUDE.md`, `.github/copilot-instructions.md` and
`.cursor/rules/akmods.mdc` only point here; if they disagree with this file, this file wins.

## What this repo is

`Danathar/akmods` is a **fork** of [`ublue-os/akmods`](https://github.com/ublue-os/akmods). It builds signed
Fedora akmod RPMs into OCI cache images using a `Justfile`, `Containerfile.in`, `images.yaml` and the scripts
in `build_files/` (`common`, `extra`, `nvidia`, `zfs`, `prep`, `post`, `test`).

The fork exists to feed [`Danathar/zfs-aurora-complex`](https://github.com/Danathar/zfs-aurora-complex).
That repo clones this one **as source** at build time, rewrites the `main.zfs` target in `images.yaml`, and
runs this repo's `just push`. Any commit on this fork's `main` can therefore change that repo's next build.
**If patch P2 (image name from `images.yaml`) regresses, `zfs-aurora-complex` publishes to the wrong image
name.**

## Fork vs upstream

- Upstream (`ublue-os/akmods`, git remote `upstream`) is **read-only**. Never open PRs, issues or comments
  against it.
- Every `gh` write MUST target this fork: `gh ... -R Danathar/akmods` (or `--repo Danathar/akmods`).
  `gh` otherwise resolves the upstream parent for a fork.
- Compare against upstream with `git fetch upstream && git diff upstream/main...HEAD`.

## Fork patch registry discipline

[`FORK-PATCHES.md`](FORK-PATCHES.md) lists every deliberate delta from upstream (permanent `P*`, temporary
`T*`, plus operational state). Rules:

1. **Any change that adds, removes or alters a fork delta MUST update `FORK-PATCHES.md` in the same PR**
   (files, what, why, merge note, removal condition).
2. Prefer new fork-local files over editing upstream-owned files (anything that exists in `upstream/main`:
   `Justfile`, `build_files/`, `images.yaml`, existing workflows, `README.md`, `CODEOWNERS`, templates,
   `CHANGELOG.md`, `renovate.json`). Edits to those make every future upstream merge harder; if one is
   unavoidable, say so in the PR body.
3. Do not "fix" the `ghcr.io/ublue-os/...` references in `README.md` (see P3) and do not revert `org: danathar`
   (P1) or the `akmods_name` logic (P2) as dead weight.

## Upstream merge procedure

Walk `FORK-PATCHES.md` top to bottom after `git merge upstream/main`; each entry either still applies, is now
redundant, or can be dropped. Step-by-step: `.claude/skills/upstream-sync/SKILL.md` and
`.github/prompts/upstream-sync.prompt.md`. The consumer-side process is in `zfs-aurora-complex`
(`docs/akmods-fork-maintenance.md`).

An upstream sync PR **must land as a merge commit, never a squash**. A squash drops upstream's ancestry, so
the next sync re-merges from a stale base (this happened with #66). The Hive picks the merge method from the
PR: it uses a merge commit only when the title contains `sync upstream`, the PR has the `upstream-sync`
label, or the branch starts with `upstream-sync/`. Title sync PRs `chore: sync upstream ublue-os/akmods`,
and add the label and branch name when you can. `policy-check` fails a PR that brings in upstream
commits without any of the three (`.github/scripts/check-upstream-sync.sh`).

## HOST SAFETY (absolute)

The checkout may live on a developer's workstation. Never run, locally:

- `just build`, `just test`, `just fetch-kernel`, `just push`, `just manifest`, `just clean` — they build
  containers, download kernels and push to registries;
- `sudo`, `dnf`, `rpm-ostree`, or any package install;
- `podman build`, `podman push`, `podman system prune`, or any local container.

Container and end-to-end verification happens in GitHub Actions on the PR. Never print tokens or secrets.
Allowed locally: `git`, `gh`, `shellcheck`, `actionlint`, `yq`, `jq`, `node --test`,
`npx --yes bats@1.11.1 tests/unit`, and read-only `just --evaluate` / `just --dry-run`.

## Findings about the Bash guard hook: what is in scope

The Bash guard hook, `.claude/hooks/guard-bash.mjs` (with the shell reader it
imports, `.claude/hooks/shell-reader.mjs`), refuses `gh` writes that do not
target this fork, destructive `git` commands, and the builds, kernel
downloads, pushes, `sudo`, package installs, local containers and signing
listed under HOST SAFETY. It catches **mistakes by an agent that is following
these rules**. It is not a sandbox against an agent that is trying to get
around it. A shell can spell a command in endless ways, and a reader in a hook
cannot keep up with all of them. Do not file, and do not fix unprompted,
findings of this kind:

- **Disguised spellings.** A blocked command gets through only when its name
  or arguments are written in a form nobody types in ordinary work: quote
  marks inside a word (`g"i"t`), brace, wildcard or extended-glob names
  (`{git,}`, `g?t`, `g@(i)t`), backslash-newline splits, `$'...'` escapes,
  variables or command substitution that build the name, or the same tricks
  inside a command string handed to another shell or wrapper program.

These are still in scope. File them as usual:

- **The hook fails open.** It crashes, times out, or is missing a tool, and
  the command runs unchecked.
- **An ordinary spelling gets through.** The command is written the way an
  agent would type it doing normal work: the plain name, its full path
  (`/usr/bin/git`), a documented short option or alias (`git push -f`), or
  the plain command behind a wrapper program (`timeout`, `xargs`, `flock`,
  `watch`). Wrapped commands stay in scope under the ruling on
  Danathar/atomic-image-builder#772.
- **A regression.** A case the hook's tests already cover stops being
  refused.
- **The hook blocks normal work it should allow.**

This is a standing ruling, not a gap to report: an agent that has to disguise
a command to run it is already breaking the rules in this file.

## Gotchas that cost hours

- **All `Build * akmods` workflows and `Cleanup Old Images` are `disabled_manually`** in GitHub settings (not
  visible in any file). This fork's own workflows build and publish nothing; the publish path is exercised
  from `zfs-aurora-complex`.
- **No repo secrets are configured** (`KERNEL_PRIVKEY`, `AKMOD_PRIVKEY_20230518`, `SIGNING_SECRET`). On
  `pull_request` the build falls back to the test key and passes; on `schedule`/`workflow_dispatch` an empty
  secret yields a 1-byte key file and `fetch-kernel` dies with a PEM decode error. A green PR check does not
  predict a green nightly. Details: the "Scheduled builds" section of `FORK-PATCHES.md`.
- `just generate-workflows` deletes and regenerates `.github/workflows/build*.yml` from `workflow-templates/`
  and `images.yaml`. Never hand-edit generated `build-akmods-*.yml`; edit templates/`images.yaml` instead.
- T1: never flip `zfs.main.linux_experimental` to `true` just to turn a red ZFS build green.

## How to test

| What | Command |
|---|---|
| Shell lint | `shellcheck <files>` |
| Workflow lint | `actionlint` |
| Unit tests (bats) | `npx --yes bats@1.11.1 tests/unit` |
| Node tooling tests | `node --test` (from repo root) |
| End-to-end (container) | `tests/e2e/run.sh` — **CI only**, never on a workstation |

CI (`.github/workflows/ci.yml`: `Lint (shellcheck)`, `Lint (actionlint)`, `Unit tests (bats)`,
`E2E (fedora container)`; `agent-tooling.yml`; `coverage-gate.yml`; `policy-check.yml`) runs on every PR to
`main`. CI images must come from `registry.fedoraproject.org/fedora` or `quay.io/fedora/fedora`, not Docker Hub.

## Where the other agent docs live

| Topic | Path |
|---|---|
| Fork delta registry | `FORK-PATCHES.md` |
| Risk tiers / change classification | `docs/risk-tiers.md`, `docs/change-classification.md` |
| AI-ops runbook | `docs/ai-ops-runbook.md` |
| Session summary (continuity) | `.claude/session-summary.md` |
| Agent memory | `.claude/memory/` |
| Reflections / lessons | `docs/reflections/` |
| Skills | `.claude/skills/*/SKILL.md` |
| Prompts catalog | `.github/prompts/README.md` |
| Human contributor guide | `CONTRIBUTING.md` |

## PR conventions

- Branch from `origin/main`; one logical change per PR; conventional commits (`docs:`, `ci:`, `test:`,
  `fix:`, `feat(agents):` …).
- Open with `gh pr create -R Danathar/akmods --base main --head <branch>`; list what each file is for and one
  `Closes #N` line per issue.
- Watch checks: `gh pr checks <PR> -R Danathar/akmods --watch`; fix until green.
- **Never merge** your own PR, and do not change repo settings or rulesets.

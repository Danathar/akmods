# Session summary

The handoff between working sessions. Read it at the start of a session, after
`AGENTS.md` and `CLAUDE.md`; rewrite it at the end. It carries only what is
true right now and would otherwise have to be rediscovered. Standing rules
belong in `AGENTS.md`, mistakes worth never repeating in
[memory/](memory/README.md), recurring patterns in
[../docs/reflections/](../docs/reflections/README.md), and every difference from
upstream in [../FORK-PATCHES.md](../FORK-PATCHES.md).

**Host rule.** Never run `just build|test|fetch-kernel|push|manifest|clean`,
`sudo`, a package install, `podman build|push|login|system prune` or `cosign
sign` on the workstation, and never write real signing keys into `certs/`.
`guard-bash.mjs` blocks these; container verification runs in GitHub Actions.
GitHub writes pass `--repo Danathar/akmods`; `ublue-os/akmods` is the read-only
upstream.

## How to use it

Start of session:

1. Read "Current state" and the latest session entry below.
2. Verify anything you are about to rely on. Branch names, PR numbers and SHAs
   drift: check with `git log origin/main`,
   `gh pr list -R Danathar/akmods`, `gh issue list -R Danathar/akmods` and
   `gh workflow list --all -R Danathar/akmods` (workflow enablement is a
   repository setting; no file records it).

End of session. This file is one tracked singleton, so concurrent PRs that all
rewrite it will conflict or overwrite each other. Rule: **only the session that
lands work on `main` (the one that merges, or a dedicated handoff PR opened
after the merge) rewrites it**, starting from the current `origin/main` copy. A
session that opens a PR to be merged later puts its notes in the PR body and
leaves this file alone. Steps for the session that updates it:

1. Update "Current state" so it matches what is on `main` now.
2. Replace the "Last session" entry. Overwrite it; do not append a history. What
   is worth keeping long term goes to `AGENTS.md`, `memory/`,
   `docs/reflections/` or `FORK-PATCHES.md`.
3. Rewrite "Open threads" and "Next steps": remove what is finished, and keep
   each remaining item to one line with its issue or PR number.
4. Record only things you observed. Mark guesses as `[INFERENCE]`.

Entry format:

```markdown
## Last session: <YYYY-MM-DD> - <one-line focus>

**Done:** what landed, with PR/issue numbers
**In flight:** open PRs, unmerged branches, half-finished work
**Blocked on:** decisions or merges needed before the next step
**Watch:** observed but not acted on
```

---

## Current state (as of 2026-10-11, observed with gh/git)

- **What the repo is:** `Danathar/akmods`, a fork of `ublue-os/akmods` (builds
  signed Fedora akmod RPMs into OCI cache images). `main` was at `fbb314c`
  (`Install git so main-flavor ZFS builds can apply the 2.4.3 patches (#6)`,
  merged 2026-08-11) before the ACMM slice PRs. `origin/main` is 23 commits
  ahead of and 35 behind `upstream/main` (`cc75e3b`, 2026-10-08).
- **Fork patches:** P1 (`org: danathar`), P2 (`akmods_name` from
  `images.yaml`, `AKMODS_IMAGE_NAME` override), P3 (README), P4 (Scorecard
  workflow), T1 (`zfs.main.linux_experimental: false`), T3 (authenticated
  OpenZFS release lookup), T4 (`python3-cffi`), T5 (`jq`), T6 (`git`); T2 was
  retired 2026-07-30. All in [../FORK-PATCHES.md](../FORK-PATCHES.md).
- **Workflows:** `Build CENTOS|COREOS-STABLE|COREOS-TESTING|LONGTERM-6.18|MAIN|OGC
  akmods` and `Cleanup Old Images` are `disabled_manually`; `build-akmod`,
  `cache-kernel` (reusable) and `Scorecard supply-chain security` are active.
  Repository secrets: none (`gh api repos/Danathar/akmods/actions/secrets`
  total_count 0), so a scheduled build would write a 1-byte signing key and fail
  in `fetch-kernel` ([memory](memory/empty-kernel-privkey-writes-a-one-byte-key.md)).
  Repository rulesets: none.
- **Consumer:** `Danathar/zfs-aurora-complex` clones this repo as source and runs
  its `just push`; "workflows disabled" does not mean the publish path is dead
  ([memory](memory/workflows-disabled-is-not-publish-dead.md)).
- **ACMM rollout in flight:** the 46 open `[ACMM ...]` issues (#7-#52) are being
  closed by slice PRs from `acmm/<slice>` branches: A `acmm/a` (#56: bats unit
  suite, e2e, lint, coverage gate), B `acmm/b` (#53: agent instructions, prompts,
  skills), C `acmm/c` (agent tooling: this file, `settings.json`, the guard hook,
  memory, reflections), D1 `acmm/d1` (#55: risk tiers, policies, ruleset), D2
  `acmm/d2` (#54: metrics, rubric, runbook), E (agent workflows). Nothing is
  merged yet; the integrator adds one `FORK-PATCHES.md` entry for all ACMM files
  afterwards. Re-check with `gh pr list -R Danathar/akmods`.
- **Agent tooling:** `.claude/settings.json` registers
  `.claude/hooks/guard-bash.mjs` on every Bash call and carries allow/ask/deny
  permissions; `node --test` (run by `agent-tooling.yml` once slice A lands)
  executes `.claude/hooks/tests/`.
- **Not verified from this repository:** whether `zfs-aurora-complex` currently
  runs against `aurora-dx:stable`, and anything about the signing secrets'
  intended values.

## Last session: 2026-10-11 - ACMM slice C (learning and safety tooling)

**Done:** nothing merged; the slice C PR adds the guard hook and tests,
`settings.json`, `memory/` (six corrections from `FORK-PATCHES.md` history),
this handoff file and two reflections (issues #19, #24, #25, #26, #27, #35, #36,
#41).
**In flight:** slice PRs #53-#56 plus the C and E PRs; all unmerged.
**Blocked on:** review and merge order of the slice PRs (not decided here).
**Watch:** the guard refuses `podman run` outright (no local containers), so
`tests/e2e/run.sh` is CI-only; `Edit/Write(certs/**)` is denied in settings.

## Open threads

- `guard-bash.mjs` is a guard against careless commands, not a sandbox (threat
  model at the top of the file). `just` recipes are refused by default (any
  recipe not under `--dry-run`/`--evaluate`/`--list`/`--show`); aliases, shell
  variables and scripts written then run are out of scope.
- The next upstream merge is 35 commits behind; check that `main`-flavor ZFS
  still has the tools `build-kmod-zfs.sh` calls
  ([memory](memory/main-flavor-zfs-needs-git-and-jq.md)).

## Next steps

1. Merge the slice PRs (owner decision), then have the merging session rewrite
   this file from `origin/main`.
2. Before enabling any `Build *` workflow, set `KERNEL_PRIVKEY`,
   `AKMOD_PRIVKEY_20230518` and `SIGNING_SECRET`, or harden the `-s` guard in
   `build-prep.sh`.

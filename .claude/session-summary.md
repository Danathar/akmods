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

## Current state (as of 2026-10-12, observed with gh/git)

- **What the repo is:** `Danathar/akmods`, a fork of `ublue-os/akmods` (builds
  signed Fedora akmod RPMs into OCI cache images). `origin/main` is 29 commits
  ahead of and 35 behind `upstream/main`; #59 (opened by `auto-issues.yml`)
  tracks the sync.
- **Fork patches:** P1 (`org: danathar`), P2 (`akmods_name` from
  `images.yaml`, `AKMODS_IMAGE_NAME` override), P3 (README), P4 (Scorecard
  workflow), P5 (the ACMM agent tooling, CI and governance files), T1
  (`zfs.main.linux_experimental: false`), T4 (`python3-cffi`), T6 (`git`);
  T2 was retired 2026-07-30, T3 (OpenZFS API release lookup) and T5 (`jq`)
  on 2026-10-24 once upstream #618 pinned the full ZFS version. All in [../FORK-PATCHES.md](../FORK-PATCHES.md). `tests/unit/`
  pins P1, P2, P4, P6, T1, T4 and T6.
- **Build workflows:** `Build CENTOS|COREOS-STABLE|COREOS-TESTING|LONGTERM-6.18|MAIN|OGC
  akmods` and `Cleanup Old Images` are `disabled_manually`. Repository secrets:
  none, so a scheduled build would write a 1-byte signing key and fail in
  `fetch-kernel` ([memory](memory/empty-kernel-privkey-writes-a-one-byte-key.md)).
- **Checks and merging:** ruleset `protect main` (id `24902471`) is active and
  requires seven checks: `Lint (shellcheck)`, `Lint (actionlint)`,
  `Unit tests (bats)`, `E2E (fedora container)`, `Coverage gate`,
  `Agent tooling (node --test)`, `policy-check`; the branch must be up to date
  with `main`. See [../docs/branch-protection.md](../docs/branch-protection.md).
  The Hive merge strategy is `hive-serialized` (switched on by the owner on
  2026-10-12, as the owner reported; not read from the dashboard API here).
- **Scheduled workflows:** `nightly-compliance`, `agent-audit`, `pr-metrics`,
  `auto-qa` and `auto-issues` each ran once by `workflow_dispatch` on
  2026-10-12 and succeeded. `claude.yml` and `ai-fix.yml` have never run: no
  `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` secret exists, so their agent
  step is skipped.
- **Local tooling:** the Justfile now has `set lists` (from upstream), which
  just < 1.57 rejects; tests and CI use the pinned just 1.58.0 from
  `tests/install-tools.sh`. Bare `node --test` skips dot-directories;
  `scripts/tests/dot-claude.test.mjs` imports the `.claude/` tests so it runs
  all of them.
- **Consumer:** `Danathar/zfs-aurora-complex` clones this repo as source and runs
  its `just push`; "workflows disabled" does not mean the publish path is dead
  ([memory](memory/workflows-disabled-is-not-publish-dead.md)).
- **Not verified from this repository:** whether `zfs-aurora-complex` currently
  runs against `aurora-dx:stable`, and anything about the signing secrets'
  intended values.

## Last session: 2026-10-12 - ACMM issues #7-#52

**Done:** slice PRs #56, #53, #54, #55, #57, #58 merged (commits in
[../docs/agent-tasks/2026-10-11.md](../docs/agent-tasks/2026-10-11.md));
ruleset `24902471` applied; the handoff PR (#60) added the P5 registry entry;
the owner switched Hive to the serialized merge lane, closing #45.
**In flight:** nothing.
**Blocked on:** nothing.
**Watch:** #59, the first automated upstream-sync issue.

## Open threads

- `guard-bash.mjs` is a guard against careless commands, not a sandbox (threat
  model at the top of the file). `just` recipes are refused by default (any
  recipe not under `--dry-run`/`--evaluate`/`--list`/`--show`); aliases, shell
  variables and scripts written then run are out of scope.
- The next upstream merge is 35 commits behind (#59); check that `main`-flavor
  ZFS still has the tools `build-kmod-zfs.sh` calls
  ([memory](memory/main-flavor-zfs-needs-git-and-jq.md)).

## Next steps

1. Owner: re-run the ACMM evaluation for `akmods`.
2. Upstream sync (#59), walking `FORK-PATCHES.md`.
3. Before enabling any `Build *` workflow, set `KERNEL_PRIVKEY`,
   `AKMOD_PRIVKEY_20230518` and `SIGNING_SECRET`, or harden the `-s` guard in
   `build-prep.sh`.

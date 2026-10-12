# What this fork's history shows about verifying work that runs somewhere else

**Date:** 2026-10-11
**Context:** `FORK-PATCHES.md` (T1, T2, T5, T6 and the operational-state
section), PRs #2, #3, #4 and #6 on `Danathar/akmods`, and the runs cited there.
The ACMM rollout (issues #7-#52, one PR per slice) is the first time this
history is being written down as patterns rather than patches.

## What happened

- **T2, a published artifact nobody consumed.** On 2026-07-26 `b68b856 feat:
  publish main-flavor zfs akmods from this fork` added a `zfs` target to the
  `main` flavor and enabled `Build MAIN akmods`. On 2026-07-30 `57351e4 revert:
  stop building the main-flavor zfs akmods artifact` removed it and the workflow
  went back to `disabled_manually`. The build itself worked (run 30206124460);
  no image was ever published under the target. The registry note says why it
  went: `zfs-aurora-complex` builds the akmod from this repo's source on every
  run, so "an unconsumed daily image is pure cost". Two follow-up docs commits
  (`6562843`, `7be68a9`) were needed because the first write-ups of the
  revert and of README changes contradicted the tree.
- **A green PR check that predicted nothing.** On `pull_request` the signing-key
  step is skipped and the build falls back to the test key; on
  `schedule`/`workflow_dispatch` it writes an empty secret into
  `certs/private_key.priv`, a 1-byte file that defeats the `-s` fallback, and
  `fetch-kernel` dies with `OSSL_DECODER_from_bio` errors in about two minutes
  (runs 30318357041, 30412211886, 30503677867). The two trigger paths exercise
  different code (`reusable-build.yml:114-120`, `build-prep.sh:70-73`).
- **A merge that broke a flavor upstream does not build.** After merging
  upstream on 2026-08-11 (`de25897`, PR #5), the first main-flavor ZFS build died
  with `git: command not found`, exit 127: upstream's `c30f343` applies patches
  with `git apply`, and upstream only installs `git` for `centos|coreos|longterm`.
  Fix: `fbb314c` (#6), registered as T6. The same class of gap had already
  produced T5 (`jq`).
- **Claims about the fork that were wrong and had to be rewritten.**
  `FORK-PATCHES.md` first said "nothing pushes anywhere" and that the push path
  had "never run against a real registry"; `a54a450` (#4) corrected both because
  `zfs-aurora-complex` runs this repo's `just push` regularly. The README's
  cosign/COPY examples were briefly pointed at `ghcr.io/danathar`, where both
  images 404.

## What it shows

- Where a fork's code actually runs (here: a different repository's workflows)
  is not visible from this repository's own workflow list or `git log`. Docs
  written from the local view alone were wrong twice (the "pushes nothing" claim,
  the README namespace).
- A check on one trigger does not cover another when the trigger changes which
  steps run. The 1-byte key was invisible to every PR.
- Merging a project whose build matrix is a subset of ours makes the subset's
  missing assumptions our problem: upstream's tooling is only exercised on the
  flavors upstream builds. [INFERENCE] More such gaps will appear on the next
  merge: this fork is 35 commits behind `upstream/main` as of 2026-10-11 and
  `main` ZFS is the only flavor that exercises them.
- Adding a build target that nothing consumes costs a revert and several
  documentation fixes even when the build is green.

## What to do next time

- Before calling a fork patch dead, check the consumer (`zfs-aurora-complex`);
  before changing a publishing claim, check `gh workflow list --all` and the
  registry, not the checkout.
- After any change that touches signing, secrets or scheduled paths, say in the
  PR which trigger it was verified on; a PR check does not stand in for a
  `workflow_dispatch` run.
- After each upstream merge, diff the tools `build_files/zfs/build-kmod-zfs.sh`
  and `build-prep.sh` call against what the `main` flavor installs, and run a
  `main` ZFS build in CI before merging.
- Record the reason for every fork-only package or flag when adding it (T4's
  reason was lost) and write the retire condition next to it.
- Corrections that came out of this are in [.claude/memory/](../../.claude/memory/README.md).

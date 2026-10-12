# Fork patch registry

Every deliberate difference between this fork and [`ublue-os/akmods`](https://github.com/ublue-os/akmods) is listed here.
The point is that an upstream merge is a mechanical operation: after `git merge upstream/main`, walk this
file top to bottom and confirm each entry either still applies, is now redundant, or can be dropped.

Regenerate the delta this file describes with:

```
git fetch upstream
git diff upstream/main...HEAD
```

Patches are grouped by whether they are **permanent** (fork identity — they will never go upstream and
should survive every merge) or **temporary** (working around a bug, a gap, or a version skew — each has a
stated condition under which it should be deleted).

---

## Permanent

### P1 — Publish into this fork's GHCR namespace

- **Files:** `images.yaml` (`akmods-base` anchor, `org:`)
- **What:** `org: ublue-os` → `org: danathar`.
- **Why:** every image name in `images.yaml` is assembled as `<registry>/<org>/<name>`. Left at
  `ublue-os`, `just push` from this fork targets `ghcr.io/ublue-os/...` and the registry returns 403,
  because the fork's `GITHUB_TOKEN` has no write access to the upstream org.
- **This value is inert; the push path that uses it is not.** `zfs-aurora-complex` sets `org`
  explicitly on the `main.zfs` node it rewrites (see P2), so the consumer never reads *this* anchor's
  `org` — that is the narrow sense in which the value is unexercised. The `Justfile`'s push recipe
  itself runs against a real registry on every cache rebuild that consumer triggers. Keep the value so
  the destination is already correct for any target the consumer does not rewrite, and for a local
  `just push`. This bullet previously said "nothing pushes anywhere" and that it had "*never* run
  against a real registry"; both were wrong — see the operational state section.
- **Merge note:** upstream touches this anchor whenever it adds a field. Keep `org`, take everything else.

### P2 — Image name comes from `images.yaml`, not the target name

- **Files:** `Justfile` (`akmods_name`)
- **What:** upstream hardcodes `akmods_name := 'akmods' + '-<target>'`. This fork reads
  `.images.<version>.<flavor>.<target>.name`, with an `AKMODS_IMAGE_NAME` environment override.
- **Why:** `zfs-aurora-complex` rewrites the `main.zfs` block in `images.yaml` at build time (see
  `ci_tools/akmods_configure_zfs_target.py` in that repo) to publish under a different image name
  (`zfs-aurora-complex-akmods`). Deriving the name from the config lets that repo control the publish
  destination without patching the `Justfile` on every run.
- **Merge note:** this is the single most load-bearing patch in the fork. If an upstream merge silently
  reverts it, `zfs-aurora-complex` starts publishing to the wrong image name.

### P3 — Fork README

- **Files:** `README.md`
- **What:** four changes against upstream's README:
  1. `# ublue-os akmods` → `# akmods (Danathar fork)`, and the per-flavor build badges dropped (they
     pointed at upstream's workflow runs, which say nothing about this fork).
  2. A "Why This Fork Exists" section — what this fork feeds and which patches are load-bearing.
  3. A "Supply-chain scorecard" section documenting how to read the results produced by P4.
  4. A "This fork's workflows publish no images" callout above "How it's organized".
- **Deliberately *not* changed:** the `COPY --from=ghcr.io/ublue-os/...` and
  `cosign verify ... ghcr.io/ublue-os/akmods:...` examples still point at **upstream's** registry. They
  were briefly rewritten to `ghcr.io/danathar/...`, which was wrong: nothing publishes `akmods` or
  `akmods-nvidia` under that namespace (both 404 as of 2026-07-30), so those refs pointed at images
  that do not exist, and the checked-in `cosign.pub` is upstream's key.
  Do not "fix" them back to the fork's namespace unless publishing is actually turned on.
- **Merge note:** conflicts on nearly every upstream README change. Keep the fork's framing and the
  no-images callout; fold in upstream's substantive content.

### P4 — OpenSSF Scorecard workflow

- **Files:** `.github/workflows/scorecard.yml`, `.github/scripts/scorecard-summary.sh`
- **What:** upstream ships its own `scorecard.yml`; the fork adds the summary script and the steps
  that run it (~27 added lines). Runs Scorecard on push to `main`, weekly, and on branch-protection
  changes; uploads SARIF and writes a readable Markdown summary into the run.
- **Merge note:** upstream's edits to `scorecard.yml` are almost always Renovate digest bumps, which
  auto-merge next to the fork's added steps. Take upstream's pins, keep the summary steps.
  `scorecard-summary.sh` is fork-only and never conflicts.

### P5 — Agent tooling, CI checks and governance (ACMM)

- **Files:** new, fork-local: `AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md`, `.editorconfig`,
  `.shellcheckrc`, `.coverage-thresholds.json`, `risk-config.json`, `.claude/` (settings, guard hook and its
  tests, memory, skills, session summary), `.cursor/rules/`, `.github/copilot-instructions.md`,
  `.github/prompts/`, `.github/labeler.yml`, `.github/auto-qa-tuning.json`, `.github/rulesets/main.json`,
  `policies/`, `scripts/` (`*.mjs` plus `scripts/tests/`), `tests/` (bats unit, container e2e, fixtures),
  `docs/` (upstream has no `docs/`), and these workflows:
  `ci`, `coverage-gate`, `agent-tooling`, `policy-check`, `pr-metrics`, `claude`, `ai-fix`, `labeler`,
  `auto-qa`, `nightly-compliance`, `auto-issues`, `agent-audit` (`.github/workflows/<name>.yml`).
  One upstream-owned edit: `.gitignore` gains `.claude/settings.local.json`.
- **What:** the test suite, CI checks, policy-as-code and agent directions added to close the ACMM
  issues #7–#52 (PRs #53–#58). The required checks that guard `main` (ruleset `24902471`, see
  `docs/branch-protection.md`) come from these workflows. `tests/unit/` pins P1, P2, P4 and T1–T6, so
  an upstream merge that silently reverts one of them now fails CI instead of reaching
  `zfs-aurora-complex`.
- **Why:** the repository is worked by Hive agents; these files are their directions and the gates
  they cannot merge around.
- **Merge note:** all but `.gitignore` are new files upstream does not have, so a merge only
  conflicts if upstream adds a file with the same path (check `git diff --name-status upstream/main...HEAD`
  for `A` entries that became `M`). On `.gitignore`, keep both sides. Two traps:
  `just generate-workflows` runs `rm -f .github/workflows/build*.yml`, so never give a fork-local
  workflow a `build` prefix; and renaming a job in `ci.yml`, `coverage-gate.yml`, `agent-tooling.yml`
  or `policy-check.yml` blocks every merge until the ruleset is updated (procedure in
  `docs/branch-protection.md`). Adding a patch to this file without a `# covers:` bats test fails the
  `Coverage gate` check unless it is exempted in `.coverage-thresholds.json`.

### P6 — No nvidia targets and no OGC kernel flavors

- **Files:** `images.yaml` (build groups and `images:`), and through `just generate-workflows` the
  generated `.github/workflows/build-akmods-*.yml` (`build-akmods-ogc.yml` and
  `build-akmods-ogc-lts.yml` no longer exist).
- **What:** the `nvidia-lts` and `nvidia-open` targets, the `ogc` and `ogc-lts` kernel flavors, the
  `extra` target (only the OGC groups used it), and the anchors only they referenced are removed. What
  is left: `common` on `main` / `coreos-*`, and `zfs` on `centos` / `coreos-*` / `longterm-6.18`.
  The `build_files/nvidia/`, `fetch-kernel.sh` OGC branch and `Justfile` nvidia/OGC logic stay
  untouched, so upstream merges of those files never conflict.
- **Why:** nothing here uses them. `zfs-aurora-complex` builds only `main.zfs`, which it injects itself
  (see P2). Their third-party package repos break often, and that kept upstream syncs red for reasons
  unrelated to this fork. In the #66 sync, negativo17's F45 `nvidia-580` repo had mismatched driver and
  kmod versions, and the Terra mirror served stale metadata for `akmod-openrazer` on `ogc-lts`.
- **Merge note:** upstream edits to these groups, or a new nvidia target or OGC flavor, conflict here or
  come back silently through a group upstream adds. Drop them again, then run `just generate-workflows`.
  `tests/unit/fork_patches.bats` (P6) fails if either one comes back.

---

## Temporary

### T1 — `zfs.main` block pinning the kernel-compatibility gate

- **Files:** `images.yaml` (`zfs.main`)
- **What:** an explicit `zfs.main` block setting `minor_version: "2.4"` and
  `linux_experimental: false`. Upstream has no `zfs.main` key at all.
- **Why it is not redundant:** the values are identical to `zfs.default`, so this is *behaviourally* a
  no-op — it exists to carry a warning at the point of temptation. `zfs-aurora-complex` injects its own
  `images.<ver>.main.zfs` target at build time and the `Justfile` reads `.zfs.main.linux_experimental`
  when building it, so this block is the knob a future maintainer would reach for when a `main` ZFS build
  goes red. The comment there explains why flipping it to `true` is the wrong fix.
- **Background:** it *was* `true` briefly (2026-07-26 → 2026-07-27). OpenZFS 2.4.3 refuses to configure
  against a kernel newer than 7.0, and `aurora-dx:latest` had moved to Fedora 44's 7.1.x kernel:

  ```
  configure: error:
      *** Cannot build against kernel version 7.1.4-202.fc44.x86_64.
      *** The maximum supported kernel version is 7.0.
  ```

  `--enable-linux-experimental` got past it, but the consumer then switched to `aurora-dx:stable`
  (kernel 7.0.12-201.fc44), inside the supported range, so the override was re-armed to `false`. The
  flag suppresses OpenZFS's own refusal to build against an unvalidated kernel; with it set, a future
  kernel bump past the ceiling silently produces an unvalidated module instead of failing loudly, and
  consumers that gate on that failure lose their upstream-compat signal.
- **Remove when:** never, unless upstream adds an equivalent. Set to `true` only as a deliberate,
  temporary, documented exception — not to turn a red build green.

### T2 — *(retired 2026-07-30)* ZFS akmod for the `main` kernel flavor

Between 2026-07-26 and 2026-07-30 this fork added a `zfs` target to `images.43.main` / `images.44.main`
(by merging in `*server-build-group-only-x86`) and configured it to publish as
`ghcr.io/danathar/akmods-zfs:main-43` and `:main-44`. It has been **reverted** — the build-matrix
entries are gone and `build-akmods-main.yml` is byte-identical to its pre-change state. `images.yaml`
is not fully byte-identical to the pre-target tree: the `zfs.main` block and the `org: danathar`
namespace change were both introduced in the same commit as this target, but they survive the revert
on their own merits (see T1 and P1) rather than as leftovers of it. No image was ever actually
published under this target — see operational state below.

Kept as a note rather than deleted because the idea recurs: `zfs-aurora-complex` builds the ZFS akmod
from this repo's *source* on every run, and publishing a prebuilt cache here looks like an obvious
saving. It was dropped because that consumer builds fine without it, and an unconsumed daily image is
pure cost. If you revisit it, the build itself is proven to work — see run 30206124460.

### T3 — Hardened OpenZFS release discovery

- **Files:** `build_files/zfs/build-kmod-zfs.sh`, `Justfile` (`build`, `test` — `SECRETS` array),
  `Containerfile.in` (`--mount=type=secret,id=github_token` on the ZFS build step)
- **What:** four changes to the unauthenticated `curl` upstream uses against
  `api.github.com/repos/openzfs/zfs/releases`:
  1. sends `Authorization: Bearer` when `GITHUB_TOKEN`/`GH_TOKEN`/`/run/secrets/github_token` is present;
  2. disables `xtrace` around token handling so CI's `set -x` cannot echo the token into the job log;
  3. asserts the response is a JSON array before parsing, and prints the body on failure;
  4. fails loudly when no release matches `zfs-<minor>` instead of silently producing an empty version.

  Upstream's #590 (merged here in the #59 sync) added its own `CURL` array with
  `--retry 5 --retry-delay 5 --retry-all-errors` and rewrote the same lines. That collides with this
  patch. The conflict was resolved by keeping all four changes above, adding upstream's retry flags to
  `curl_args`, and defining upstream's `CURL` array just above the xtrace guard, because the tarball
  and signature downloads further down use it.
- **Why:** the anonymous GitHub API allows 60 requests/hour per IP. On shared CI runners that budget is
  routinely exhausted, and the API then returns a rate-limit *object* rather than an array. Upstream's
  `jq` then yields an empty `ZFS_VERSION` and the build fails much later with a confusing error.
- **Remove when:** upstream adopts an authenticated or non-API release lookup. Until then this must be
  carried forward as a unit — the `Justfile` secret plumbing and the `Containerfile.in` secret mount are
  useless without the script change, and vice versa.

### T4 — `python3-cffi` in the build environment

- **Files:** `build_files/prep/build-prep.sh` (`RPMS_TO_INSTALL`)
- **What:** one added package.
- **Why:** *not recorded at the time it was added.* Most likely a missing transitive dependency of the
  ZFS `pyzfs` bindings, which `configure` will silently disable if `cffi` is absent.
- **Remove when:** confirmed unnecessary. Do not drop it on the assumption it is dead weight — verify by
  running a full `main` ZFS build without it first.

### T5 — `dnf install -y jq` inside the ZFS build step

- **Files:** `build_files/zfs/build-kmod-zfs.sh`
- **What:** installs `jq` before parsing the release JSON.
- **Why:** `jq` is not guaranteed present in the build stage, and upstream's script assumes it is.
- **Remove when:** `jq` is added to `RPMS_TO_INSTALL` in `build_files/prep/build-prep.sh` (upstream or
  here), which is the better place for it.

### T6 — `git` in the build environment

- **Files:** `build_files/prep/build-prep.sh` (`RPMS_TO_INSTALL`)
- **What:** one added package, in the unconditional list.
- **Why:** upstream's `c30f343` applies the 2.4.3 compatibility patches with `git apply`, but
  `build-prep.sh` only installs `git` when `KERNEL_FLAVOR` matches `centos|coreos|longterm`. Upstream
  never builds ZFS on the `main` flavor, so upstream never needs it there; this fork does, and the
  build died with `git: command not found` (exit 127) on the first run after the merge. Same class of
  gap as T5.
- **Remove when:** upstream installs `git` for all flavors, stops using `git apply` (the patch block
  is guarded to ZFS 2.4.3 and disappears once 2.4.4 ships), or starts building ZFS on `main` itself.

---

## Related

- Sync and pin process: [`docs/akmods-fork-maintenance.md`](https://github.com/Danathar/zfs-aurora-complex/blob/main/docs/akmods-fork-maintenance.md) in `zfs-aurora-complex`.
- Consuming repo's akmods config: `ci/defaults.json` and `ci_tools/akmods_configure_zfs_target.py` in `zfs-aurora-complex`.

## Operational state (not a patch, but easy to lose)

### This fork's own workflows build and publish nothing

As of 2026-07-30, **all `Build * akmods` workflows and `Cleanup Old Images` are
`disabled_manually`**, so nothing is built or pushed by any workflow *in this repository*.

That is not the same as `ghcr.io/danathar` being empty, which this section previously claimed. The
fork is consumed as *source* by `zfs-aurora-complex`, which clones it, rewrites the `main.zfs` target
(P2), and then runs **this repo's own `just push`**. The `Justfile`'s push path is therefore exercised
regularly against a real registry; it is just driven from outside this repository. Do not read "the
workflows are disabled" as "the publish code is dead" — that reading is what makes P1 look like
removable dead weight during a merge.

`Build MAIN akmods` was briefly enabled (2026-07-26 → 2026-07-30) while testing the retired T2 target,
then switched back off. This state lives in GitHub repository settings, not in any file here, so `git
log` will never show it changing — which is exactly why it is written down.

### Scheduled builds cannot succeed without the signing secrets

This one costs an hour to rediscover. No repository secrets are configured, and the failure mode differs
by trigger:

- On **`pull_request`**, the `Retrieve Signing Key` step in `reusable-build.yml` is skipped. The
  committed `certs/private_key.priv` stays 0 bytes, `build-prep.sh`'s `[[ ! -s ... ]]` test fires, and
  the build falls back to the test key and succeeds with `WARNING: Using test signing key.`
- On **`schedule`** / `workflow_dispatch` / `merge_group`, that step *runs* and writes an empty
  `secrets.KERNEL_PRIVKEY` into `certs/private_key.priv` — producing a **1-byte** file. `-s` now passes,
  so the test-key fallback never triggers, and the run dies in `fetch-kernel` with:

  ```
  OSSL_DECODER_from_bio:unsupported:...:No supported data to decode. Input type: PEM
  error: Recipe `fetch-kernel` failed with exit code 1
  ```

  This kills the *kernel cache* job, before any akmod is built. Observed on runs 30318357041,
  30412211886, 30503677867 (~2 min each).

So a green PR check does **not** predict a green nightly. Enabling any scheduled build requires setting
`KERNEL_PRIVKEY` and `AKMOD_PRIVKEY_20230518` first, or patching the `-s` guard to also reject
whitespace-only key files. `SIGNING_SECRET` is absent too, so pushed images would not be cosign-signed
either.

Note the 2026-07-05 disabling had a *different* cause — a transient `kojipkgs` truncation
(`curl (18) end of response with ... bytes missing`), a flake rather than a config fault.

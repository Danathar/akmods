# AI / operations runbook

Symptom → diagnosis → action for the real failure modes of this fork. Written for agents and maintainers.
Patch background: [FORK-PATCHES.md](../FORK-PATCHES.md). Signals: [quality.md](quality.md). Coordination: [multi-agent.md](multi-agent.md).

**Ground rules.** All `gh` writes use `-R Danathar/akmods`; upstream `ublue-os/akmods` is read-only. Never print secrets.
On a shared workstation do not run `just build|fetch-kernel|push` or containers — reproduce in GitHub Actions.

## Failure modes

### 1. `Retrieve Signing Keys` fails with `Missing signing secret: KSIGN_20240711`
- **Where:** push / schedule / `workflow_dispatch` runs on `main` (`KSIGN_MODE=production`), kernel-cache or build
  job. Not on PRs, which use the test keys in `certs/test/`.
- **Diagnosis:** no `KSIGN_*` secret and no `ksign` environment are configured, and production never falls back to
  the test keys. (Before the signing-key port in #259, the same gap wrote an empty `KERNEL_PRIVKEY` as a 1-byte key
  and `fetch-kernel` died with a PEM decode error: runs 30318357041, 30412211886, 30503677867.)
- **Action:** the owner decides whether this fork signs with its own production key; agents never create keys,
  secrets or environments. The steps are in `FORK-PATCHES.md`, "Production builds cannot succeed without the
  signing secrets". A green PR check does not predict a green production run.

### 2. OpenZFS "maximum supported kernel version is 7.0"
- **Symptom:** `configure: error: *** Cannot build against kernel version 7.1.x ... maximum supported kernel version is 7.0.`
- **Diagnosis:** the consumer's kernel moved past what the selected OpenZFS minor supports (2.4.3 → 7.0).
- **Action:** pin the consumer to a kernel inside the range (e.g. `aurora-dx:stable`) or move to an OpenZFS release that
  supports it. **Do not** set `zfs.main.linux_experimental: true` to go green (T1): it silently builds an unvalidated
  module on the next bump.

### 3. ZFS version pin: "ZFS_VERSION must be a full X.Y.Z release" / 404 fetching the ZFS tarball
- **Diagnosis:** `build-kmod-zfs.sh` takes a full OpenZFS release from `zfs.<flavor>.version` (else
  `zfs.default.version`) in `images.yaml`, or a `ZFS_VERSION` override. It no longer queries the GitHub API
  (upstream #618), so the old rate-limit failure and its fork patch (T3, retired) are gone.
- **Action:** check the pin is `X.Y.Z` and that `zfs-X.Y.Z` exists on the OpenZFS releases page. Renovate manages
  the pin.

### 4. `curl (18) end of response with ... bytes missing` from kojipkgs
- **Diagnosis:** transient truncation downloading kernel RPMs from `kojipkgs.fedoraproject.org`; the reason the
  workflows were first disabled on 2026-07-05. A flake, not a config fault.
- **Action:** re-run the job. If it repeats across several runs, check Fedora infra status before changing code.
  Don't add retries unprompted.

### 5. `git: command not found` (exit 127) on `main`-flavor ZFS
- **Diagnosis:** `build-prep.sh` only installed `git` for `centos|coreos|longterm`; the ZFS 2.4.3 compat patches use `git apply`.
- **Action:** confirm T6 (`git` in `RPMS_TO_INSTALL`) survived the upstream merge. Re-add if missing.

### 6. Consumer `zfs-aurora-complex` publishes under the wrong image name
- **Symptom:** images appear as `akmods-zfs` (or fail to appear as `zfs-aurora-complex-akmods`) in `ghcr.io/danathar`.
- **Diagnosis:** P2 regressed — `Justfile` `akmods_name` is back to `'akmods' + '-<target>'`, ignoring the name the
  consumer writes into `images.yaml` / `AKMODS_IMAGE_NAME`. Most likely an upstream merge reverted it.
- **Action:** `just --evaluate akmods_name` (read-only) with `AKMODS_IMAGE_NAME` unset against a rewritten `images.yaml`;
  restore P2 per FORK-PATCHES.md. Also check P1 (`org: danathar`) — a regression there gives a 403 on push.

### 7. A workflow "doesn't run" / no checks appear
- **Diagnosis:** all six `Build * akmods` workflows and `Cleanup Old Images` are `disabled_manually` (repo setting, invisible
  in `git log`). Check with `gh workflow list -R Danathar/akmods --all`.
- **Action:** do not enable them casually — see #1. PR-triggered CI workflows (`ci.yml`, etc.) are separate and should always run.

### 8. Generated workflow edit rejected / drifted
- **Action:** edit `workflow-templates/*.yaml.in`, run `just generate-workflows`, commit templates and outputs together.

## Reading Hive / agent state for this repo

Hive (the orchestrator, `hivecommons/hive`) acts on this repo through issues and PRs; its output is attributable by the
footer `— hive: agent=<name>` on issues and comments.

- Open Hive work: `gh issue list -R Danathar/akmods --state open --search '"hive:"'` and `gh pr list -R Danathar/akmods`.
- ACMM gaps: issues titled `[ACMM L<n>] …` carry a criterion ID and the files that would satisfy it.
- What agents have done: [docs/agent-tasks/](agent-tasks/README.md) (ledger), [PR metrics](metrics/README.md) (agent share,
  acceptance), the `agent-audit` workflow summaries, and `.claude/session-summary.md` for the last session.
- The `agent-signature` workflow (job `signature`, advisory) checks the same attribution line on an open PR from the
  Hive App or an `ai-fix/` branch, while the description can still be edited; a red `signature` means the PR body
  lacks the `— hive: agent=<name> ...` line.
- A PR with no recent activity and failing checks is the signal to inspect; stale agent branches are named `acmm/*`, `hive/*`,
  `claude/*`.
- Escalate to a human when: signing secrets or rulesets are involved, upstream merge conflicts touch P1/P2, or two
  consecutive agent attempts at the same fix fail.

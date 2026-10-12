# AI / operations runbook

Symptom → diagnosis → action for the real failure modes of this fork. Written for agents and maintainers.
Patch background: [FORK-PATCHES.md](../FORK-PATCHES.md). Signals: [quality.md](quality.md). Coordination: [multi-agent.md](multi-agent.md).

**Ground rules.** All `gh` writes use `-R Danathar/akmods`; upstream `ublue-os/akmods` is read-only. Never print secrets.
On a shared workstation do not run `just build|fetch-kernel|push` or containers — reproduce in GitHub Actions.

## Failure modes

### 1. `fetch-kernel` dies with `OSSL_DECODER_from_bio:unsupported ... Input type: PEM`
- **Where:** schedule / `workflow_dispatch` / `merge_group` runs (~2 min), kernel-cache job. Not on PRs.
- **Diagnosis:** the `Retrieve Signing Key` step in `reusable-build.yml` writes an empty `secrets.KERNEL_PRIVKEY`
  into `certs/private_key.priv`, a **1-byte** file. `build-prep.sh`'s `[[ ! -s ... ]]` test passes, so the test-key
  fallback never fires. Runs 30318357041, 30412211886, 30503677867.
- **Action:** set `KERNEL_PRIVKEY` and `AKMOD_PRIVKEY_20230518` (and `SIGNING_SECRET` for cosign) as repo secrets
  *before* enabling any scheduled build; or patch the guard to reject whitespace-only keys (a fork patch → registry entry).
  A green PR check does not predict a green nightly.

### 2. OpenZFS "maximum supported kernel version is 7.0"
- **Symptom:** `configure: error: *** Cannot build against kernel version 7.1.x ... maximum supported kernel version is 7.0.`
- **Diagnosis:** the consumer's kernel moved past what the selected OpenZFS minor supports (2.4.3 → 7.0).
- **Action:** pin the consumer to a kernel inside the range (e.g. `aurora-dx:stable`) or move to an OpenZFS release that
  supports it. **Do not** set `zfs.main.linux_experimental: true` to go green (T1): it silently builds an unvalidated
  module on the next bump.

### 3. ZFS release discovery: empty `ZFS_VERSION` / "response was not a JSON array"
- **Diagnosis:** anonymous GitHub API is limited to 60 req/h per IP; shared runners exhaust it and the API returns a
  rate-limit object. T3 detects it and prints the body.
- **Action:** make sure `GITHUB_TOKEN`/`GH_TOKEN` reaches the build — Justfile `SECRETS` array, `Containerfile.in`
  `--mount=type=secret,id=github_token`. Retry later if it was a one-off. If T3 was lost in an upstream merge, restore
  it as a unit (script + Justfile + Containerfile.in).

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
- A PR with no recent activity and failing checks is the signal to inspect; stale agent branches are named `acmm/*`, `hive/*`,
  `claude/*`.
- Escalate to a human when: signing secrets or rulesets are involved, upstream merge conflicts touch P1/P2, or two
  consecutive agent attempts at the same fix fail.

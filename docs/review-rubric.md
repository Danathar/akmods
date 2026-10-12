# PR review rubric

Applies to every PR in this fork, by humans and by agents (self-review before opening, reviewer after).
Mark each item **pass / fail / n/a** in the review. A **fail** on a *blocker* item means request changes.
Background: [FORK-PATCHES.md](../FORK-PATCHES.md) is the source of truth for what the fork deliberately differs on;
risk tiers are in [risk-tiers.md](risk-tiers.md), and agent rules in [AGENTS.md](../AGENTS.md).

## Blockers

1. **Fork-patch registry current.** If the diff adds, changes, or removes a deliberate difference from
   `ublue-os/akmods`, `FORK-PATCHES.md` has a matching entry (files, what, why, merge note, remove-when).
   *Exception:* in a parallel agent rollout the merging session owns that file — see [multi-agent.md](multi-agent.md).
2. **P1 intact.** `images.yaml` `akmods-base` anchor still has `org: danathar`.
3. **P2 intact.** `Justfile` `akmods_name` still reads `.images.<version>.<flavor>.<target>.name` from `images.yaml`
   and honours `AKMODS_IMAGE_NAME`. If it regresses, `zfs-aurora-complex` publishes under the wrong image name.
4. **T1 intact.** `zfs.main.linux_experimental` is `false`. Setting it `true` to turn a red build green is a rejection
   (it hides the kernel-ceiling signal).
5. **Signing paths untouched.** No change to `certs/`, `cosign.pub`, `KERNEL_PRIVKEY` / `AKMOD_PRIVKEY_*` /
   `SIGNING_SECRET` handling, or the `[[ ! -s ... ]]` guards in `build-prep.sh`, unless that *is* the PR's stated purpose
   and a human owner approved. No secret values in logs, diffs, or PR text.
6. **Generated workflows regenerated, not hand-edited.** `build-akmods-*.yml` come from `workflow-templates/`;
   they carry a "GENERATED WORKFLOW, DO NOT EDIT BY HAND" header. Change `workflow-templates/*.yaml.in` and run `just generate-workflows`; never patch one output.
7. **No unrequested workflow enabling.** Do not re-enable the disabled `Build * akmods` / Cleanup workflows;
   that is a repo setting and needs the secrets first (see [ai-ops-runbook.md](ai-ops-runbook.md)).
8. **Upstream-owned files touched minimally.** Anything that exists in `upstream/main` (Justfile, `build_files/`,
   `images.yaml`, existing workflows, README, CODEOWNERS, templates, CHANGELOG, renovate.json) is edited only when
   unavoidable, with the smallest possible hunk, and called out in the PR body. Prefer a new fork-local file.
9. **Never touches upstream.** No PR/issue/comment targets `ublue-os/akmods`; every `gh` write uses `-R Danathar/akmods`.

## Should-fix

10. **Tests added or updated.** Shell changes have bats cases in `tests/unit`; Node tooling has `scripts/tests/*.test.mjs`.
    A bug fix includes a test that fails without it.
11. **CI contract green.** `Lint (shellcheck)`, `Lint (actionlint)`, `Unit tests (bats)`, `E2E (fedora container)`,
    `Coverage gate`, `Agent tooling (node --test)`, `policy-check` — see [quality.md](quality.md).
12. **Actions pinned** to full commit SHAs with a version comment; workflow `permissions:` least-privilege;
    no `pull_request_target` with untrusted checkout; no secrets echoed (`set +x` around token handling, as in T3).
13. **Failure is loud.** New scripts fail with a clear message rather than producing an empty value
    (the `ZFS_VERSION` empty-string failure mode is the cautionary tale).
14. **Docs in step.** Behaviour, patch, or workflow changes update the relevant doc in the same PR.
15. **Conventional commit title**; one concern per PR; body states what changed, why, and which checks ran.

## Nice-to-have

- Smaller diff than first drafted; dead code removed rather than commented out.
- A merge note for the next `git merge upstream/main` when the change sits near an upstream hunk.

## Reviewer output format

```
Verdict: approve | request-changes
Blockers: <numbers failed or "none">
Should-fix: <numbers failed or "none">
Notes: <one short paragraph>
```

# Quality index

Where quality signals for this fork come from and how to read them. Rubric for reviewers:
[review-rubric.md](review-rubric.md). Metric definitions: [metrics.md](metrics.md).

## Important context

This fork's own `Build * akmods` and Cleanup workflows are **disabled**, and no repository secrets exist
([FORK-PATCHES.md](../FORK-PATCHES.md), "Operational state"). So a green check here proves the *code and
tooling* are sound; it does **not** prove a real kernel/akmod build works. Real builds run in the consumer,
`Danathar/zfs-aurora-complex`, which clones this repo and runs `just` from it.

## Signals

| Signal | Where | What a failure means | First action |
|---|---|---|---|
| `Lint (shellcheck)` | `.github/workflows/ci.yml` | Shell in `build_files/`, `fetch-kernel.sh`, scripts has a defect. | Run `shellcheck` locally on the named file. |
| `Lint (actionlint)` | `ci.yml` | Workflow syntax / expression / pinning problem. | `actionlint` locally. |
| `Unit tests (bats)` | `ci.yml` | Behaviour of a shell function regressed (e.g. ZFS release discovery, P2 name lookup). | `npx --yes bats@1.11.1 tests/unit`. |
| `E2E (fedora container)` | `ci.yml` | Scripts fail in a real Fedora userland (missing `git`/`jq`-class gaps). | Read the job log; reproduce with `tests/e2e/run.sh` **in CI only** on shared hosts. |
| `Coverage gate` | `coverage-gate.yml` | Test coverage fell under `.coverage-thresholds.json`. | Add tests; never lower the threshold to pass. |
| `Agent tooling (node --test)` | `agent-tooling.yml` | A Node script or hook (`scripts/`, `.claude/hooks/`) is broken. | `node --test`. |
| `policy-check` | `policy-check.yml` | A change violates the policies in `policies/` / [risk tiers](risk-tiers.md). | Read the check's message; fix the change, not the policy. |
| Scorecard | `scorecard.yml` (P4) | Supply-chain posture changed; see README "Supply-chain scorecard". | Open the run summary. |
| PR metrics | `pr-metrics.yml`, [`docs/metrics/`](metrics/README.md) | Trend, not gate: acceptance, TTM, agent share, reverts. | Compare latest snapshot to previous. |
| Agent audit / nightly compliance | `agent-audit.yml`, `nightly-compliance.yml` | Agent activity or repo invariants drifted. | See [ai-ops-runbook.md](ai-ops-runbook.md). |

## Reading them together

1. **Required checks red** → fix before anything else; do not merge around them.
2. **All green but the change touches P1/P2/T1/T3/T6 or signing** → green is necessary, not sufficient: confirm by the
   [rubric](review-rubric.md), and note that the consumer repo is the real end-to-end test.
3. **Metrics trending badly** (acceptance down, p90 TTM up, any revert) → look for a recurring rubric item agents miss and
   fix it at the source (AGENTS.md, a policy, or a test).

Each non-trivial incident should end with a regression test or a rubric/policy line, not just a fix.

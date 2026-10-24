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
| `Mutation check on changed lines (advisory)` | `agent-tooling.yml` (pull requests only; never required) | A changed line of the guard hook, its reader or a `scripts/*.mjs` script can be broken without any test failing. | Read the step summary; add a test, or accept the survivor in `.mutation-survivors.json`. See [below](#mutation-check-on-changed-lines). |
| `policy-check` | `policy-check.yml` | A change violates the policies in `policies/` / [risk tiers](risk-tiers.md). | Read the check's message; fix the change, not the policy. |
| Scorecard | `scorecard.yml` (P4) | Supply-chain posture changed; see README "Supply-chain scorecard". | Open the run summary. |
| PR metrics | `pr-metrics.yml`, [`docs/metrics/`](metrics/README.md) | Trend, not gate: acceptance, TTM, agent share, reverts. | Compare latest snapshot to previous. |
| Agent audit / nightly compliance | `agent-audit.yml`, `nightly-compliance.yml` | Agent activity or repo invariants drifted. | See [ai-ops-runbook.md](ai-ops-runbook.md). |

## Mutation check on changed lines

Every guard-hook fix that merged here was later found, by a hand mutation audit, to have changed lines the
tests did not notice when they were broken (#120, #129, #133, #136, #149, #165), and each needed a separate
test-only PR. The reader is also copied byte-identical into other repositories, so an unpinned line here is
unpinned everywhere. The `mutation` job in `agent-tooling.yml` does that audit on each pull request (#192).

- **What it mutates:** only the added and changed lines (`git diff -U0 <base>...HEAD`) of
  `.claude/hooks/*.mjs` and `scripts/*.mjs`. Tests are never mutated.
- **Which tests it runs:** [StrykerJS](https://stryker-mutator.io/) `@stryker-mutator/core` 10.0.0 with its
  built-in `command` test runner, so the tests stay plain `node --test` files. Hook files run against
  `node --test .claude/hooks/tests/guard-bash.test.mjs scripts/tests/gate-refusal-corpus.test.mjs`; a script
  `scripts/<name>.mjs` runs against `scripts/tests/<name>.test.mjs`, and a changed script without one is
  reported. `scripts/tests/shell-reader.test.mjs` is never in a command: it pins the reader's sha256, so it
  fails for every mutant and would count each one as killed.
- **No dependency:** CI installs the pinned Stryker with `npm install --prefix "$RUNNER_TEMP/stryker"
  --no-save --ignore-scripts`, outside the checkout; the repository has no `package.json`.
  `scripts/mutation-check.mjs` is dependency-free and `stryker.config.mjs` holds the Stryker settings.
- **Result:** exit 0 means no new survivor, 1 a new survivor (each listed in the step summary with a
  ready-to-fill ledger entry), 2 the check could not run. The job has `continue-on-error: true`, is never a
  required check, is skipped for `chore: sync upstream` pull requests, and has a 45 minute timeout (a full
  guard test run is about 19 s and runs once per mutant; a typical hook fix is 100 to 300 mutants).
- **What to do with a survivor:** add a test that fails on it. If it is equivalent (behaves the same) or
  harmless over-refusal (the guard refuses more, never less), add the printed entry to
  `.mutation-survivors.json` with a real reason. Entries match on file, mutator, original and replacement
  text, not on line numbers, so they survive edits elsewhere in the file. A survivor that lets the guard
  allow a command it should refuse is never accepted.
- **By hand:** install Stryker the same way into a temporary directory, then
  `node scripts/mutation-check.mjs --base origin/main --stryker <dir>/node_modules/.bin/stryker`.
  `--dry-run` prints the Stryker runs without starting them; `--report <file>` checks existing Stryker JSON
  reports against the ledger.

## Reading them together

1. **Required checks red** → fix before anything else; do not merge around them.
2. **All green but the change touches P1/P2/T1/T3/T6 or signing** → green is necessary, not sufficient: confirm by the
   [rubric](review-rubric.md), and note that the consumer repo is the real end-to-end test.
3. **Metrics trending badly** (acceptance down, p90 TTM up, any revert) → look for a recurring rubric item agents miss and
   fix it at the source (AGENTS.md, a policy, or a test).

Each non-trivial incident should end with a regression test or a rubric/policy line, not just a fix.

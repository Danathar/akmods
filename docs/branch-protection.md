# Branch protection and serialized merging

`main` is what `Danathar/zfs-aurora-complex` and anyone using this fork consume
as build source for signed akmod images. This page says what should protect it,
why, and how to apply and verify that. Every command here targets
`Danathar/akmods`; upstream (`ublue-os/akmods`) is read-only. See
[SECURITY-AI.md](security/SECURITY-AI.md).

## Status

**Applied.** The ruleset in
[`.github/rulesets/main.json`](../.github/rulesets/main.json) has been live as
ruleset `24902471` (`protect main`, `active`) since 2026-10-12, after the last
ACMM pull request (#58) merged and all seven required checks had passed on
`main`. The live rules matched the committed file when it was applied (the
diff under "Verify" printed nothing).

Check the live state (neither call needs admin rights):

```bash
gh api repos/Danathar/akmods/branches/main --jq .protected
gh api repos/Danathar/akmods/rulesets --jq '.[] | "\(.id) \(.name) \(.enforcement)"'
```

The first prints `true`; the second lists `24902471 protect main active`.
Anything else means the ruleset was removed or disabled and `main` again
accepts a direct push.

## Why

Every gate in this repository sits behind a pull request: lint, bats unit
tests, the e2e container run, the coverage gate, Node tooling tests and the
policy check (private-key placeholders, workflow permissions, fork patches P1/P2).
Nothing makes anyone open one. Tokens that can write `main` without a person
reading the change: Hive's GitHub App (it reads issue/PR text written by
others) and any workflow with `contents: write`. A bad commit on `main` can
redirect publishing, or weaken signing.

## The ruleset

[`.github/rulesets/main.json`](../.github/rulesets/main.json) is in GitHub's
import format and applies as-is.

- **Targets `~DEFAULT_BRANCH`**, so it follows a rename of `main`.
- **No bypass actors.** A bypass for Actions or an App hands back the direct
  push this exists to stop.
- **`deletion` and `non_fast_forward`** stop `main` being deleted or rewritten.
- **`pull_request` with 0 approvals.** On a single-maintainer repository one
  required approval would mean nothing can merge (nobody approves their own PR).
  0 still forces every change through a pull request with passing checks. It
  does not make the merger a person.
- **Seven required checks**, all GitHub Actions (`integration_id` 15368):

  | Check | Source workflow |
  | --- | --- |
  | `Lint (shellcheck)`, `Lint (actionlint)`, `Unit tests (bats)`, `E2E (fedora container)` | `ci.yml` |
  | `Coverage gate` | `coverage-gate.yml` |
  | `Agent tooling (node --test)` | `agent-tooling.yml` |
  | `policy-check` | `policy-check.yml` |

  All run on every pull request to `main` with no path filter, so no PR waits
  on a check that never starts. `policies/ruleset.json` makes
  `node scripts/check-policies.mjs` fail if the file loses a rule or a check.
- **Up-to-date branch** (`strict_required_status_checks_policy: true`): checks
  have run on what will actually land.

## Merge queue (#45)

GitHub's merge queue exists only for organization-owned repositories; this
repository is under a personal account (`Danathar`), so the ruleset has no
`merge_queue` rule and it cannot be turned on. The same guarantee comes from a
pairing:

1. The up-to-date rule plus required checks above (repository side, this file).
2. Hive's serialized merge lane, `merge_strategy: hive-serialized`: Hive lands
   one pull request at a time and re-validates the next against the new
   `main`, so two PRs that pass alone cannot break `main` together.

The ACMM evaluation credits the Merge queue criterion when the repository's
strategy is `hive-serialized` **and** the default branch has at least one
required status check. The Hive side is a dashboard setting (ACMM evaluation,
Merge queue row for `akmods`, **Use serialized merge lane**, or
`POST /api/repos/merge-strategy` with
`{"repo": "akmods", "merge_strategy": "hive-serialized"}`), not a file here.
This repository's side of #45 is the applied ruleset; the Hive side has to be
switched on by the owner in the dashboard.

## Apply

Already done (above). To re-create it after a deletion, a repository admin
runs:

```bash
gh api --method POST repos/Danathar/akmods/rulesets \
  --input .github/rulesets/main.json
```

and updates the ruleset id on this page.

## Verify

Being active does not prove the rules match the file. Compare (prints nothing
when they match):

```bash
diff <(gh api repos/Danathar/akmods/rulesets/24902471 \
         --jq '{name,target,enforcement,conditions,bypass_actors,rules}' | jq -S .) \
     <(jq -S '{name,target,enforcement,conditions,bypass_actors,rules}' \
         .github/rulesets/main.json)
```

Also confirm `gh api repos/Danathar/akmods/branches/main --jq .protected`
prints `true`. GitHub fills defaults for omitted `pull_request` parameters;
the file spells them out so the diff stays empty.

## Change the ruleset

Edit the file in a pull request; after it merges, update the live ruleset:

```bash
gh api --method PUT repos/Danathar/akmods/rulesets/24902471 \
  --input .github/rulesets/main.json
```

### Renaming a required check

That order deadlocks when a PR renames a required job: the PR reports only the
new name while the live ruleset waits for the old one. Stage it:

1. Open the PR that renames the job and updates `.github/rulesets/main.json`
   (and `policies/ruleset.json`) to the new name; wait for the new check to pass.
2. While it is open, PUT the file from that branch to the live ruleset. The PR
   can now merge on its new check.
3. Merge it, then run the verify diff against `main`.

No other PR can merge between steps 2 and 3; do step 3 straight after step 2.

## When there is a second reviewer

Set `required_approving_review_count` to 1 and consider
`require_last_push_approval`, so a push after approval needs a fresh one.

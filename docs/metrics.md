# Metrics

What this fork measures about its own pull requests, how each number is defined, and what it is
(and is not) good for. Computed by [`scripts/pr-metrics.mjs`](../scripts/pr-metrics.mjs); snapshots live in
[`docs/metrics/`](metrics/README.md). Weekly run: [`.github/workflows/pr-metrics.yml`](../.github/workflows/pr-metrics.yml).

## Population

Every **closed** pull request in `Danathar/akmods` (merged or not), optionally limited by `--since`.
Open PRs are never counted. This repo is small (single digits of PRs at the time of writing), so
every figure is a description of a handful of events, not a statistic. Read the counts next to the rates.

## Metrics

| Metric | Definition | Why it matters here |
|---|---|---|
| **Acceptance rate** | `merged / closed`. | A falling rate means agents (or humans) are opening PRs that review rejects — usually a missed fork constraint (see [review rubric](review-rubric.md)). |
| **Time to merge (TTM)** | `merged_at − created_at`, in hours; reported as median, p90, max over merged PRs. | Merge lanes are serialized ([multi-agent](multi-agent.md)); a growing p90 signals a stuck lane or red required checks. |
| **Agent vs human split** | A PR is *agent-authored* if any holds: author is a bot account (`type: Bot` / `[bot]`); head branch starts with `acmm/`, `claude/`, `copilot/`, `codex/`, `ai-fix/`, `hive/`, `agent/`; label `agent`, `ai-generated`, `ai-fix` or `hive`; body has a `Co-Authored-By: Claude/Copilot/Codex` trailer or "Generated with Claude". Everything else is human. | Lets acceptance and TTM be compared per author class, and tracks how much of the fork's change flow is agent-driven. |
| **Agent share** | `agent closed / all closed`. | The headline autonomy figure. |
| **Reverts** | Closed PRs whose title starts with `Revert` (case-insensitive). **Revert rate** = `reverts / merged`. | A merged change that had to be undone is the strongest quality signal; for P1/P2 regressions it means a consumer build was at risk. |

## Known limits

- Agent detection is heuristic. A human PR with a Claude trailer counts as agent; an agent PR from a plain
  branch with no trailer counts as human. Tighten the signals (e.g. a required `agent` label) rather than
  adjusting the numbers.
- TTM includes time a PR sat as a draft or waited for the serialized merge lane.
- Revert detection is title-based; a manual `git revert` pushed straight to `main` is invisible.
- This measures PR flow, not build health. This fork's own build workflows are disabled
  (see [FORK-PATCHES.md](../FORK-PATCHES.md) "Operational state"), so build success rates are not tracked
  here; the consumer `zfs-aurora-complex` is where builds actually run.

## Running it

```
node scripts/pr-metrics.mjs                                  # gh api, writes docs/metrics/<today>.{md,json}
node scripts/pr-metrics.mjs --since 2026-10-01 --stdout      # print only
node scripts/pr-metrics.mjs --input prs.json --out-dir /tmp/m   # offline, REST pull-request array
node --test scripts/tests                                    # tests
```

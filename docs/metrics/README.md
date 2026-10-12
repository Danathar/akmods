# Metric snapshots

Point-in-time outputs of [`scripts/pr-metrics.mjs`](../../scripts/pr-metrics.mjs); metric definitions are in
[`docs/metrics.md`](../metrics.md).

- `<YYYY-MM-DD>.md` — human-readable table. `<YYYY-MM-DD>.json` — same data, machine-readable.
- Snapshots are **append-only history**: never edit an old one, add a new date.
- The weekly [`pr-metrics` workflow](../../.github/workflows/pr-metrics.yml) does *not* commit. It writes the report to the
  run's job summary and uploads it as an artifact. To record a snapshot in the repo, run the script locally
  (`node scripts/pr-metrics.mjs`) and open a normal PR — snapshots are docs-tier changes.

## Snapshots

| Date | Notes |
|---|---|
| [2026-10-11](2026-10-11.md) | First snapshot, generated against live `Danathar/akmods` data (6 closed PRs, all merged). |

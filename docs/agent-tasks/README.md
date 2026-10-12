# Agent task ledger

Traceability for agent-run work: each dated file lists the tasks agents performed, tied to the issue that asked for it,
the PR that delivered it, and the merge commit. Lets a reviewer go from "what changed" to "who/what asked and decided".

## Format

One file per day: `YYYY-MM-DD.md`, containing a table:

| Column | Meaning |
|---|---|
| Task | Short name of the unit of work (a slice). |
| Issues | Issue numbers the work closes (`#N`). |
| Agent | Who ran it (slice id / agent name, orchestrated by Hive). |
| Branch / PR | Branch name and `#PR`. |
| Merge commit | Short SHA on `main`; `pending` until merged. |
| Outcome | `merged`, `closed`, `open`, or `abandoned` with a one-line reason. |

Rules:
- Append-only; correct mistakes with a new line, not by rewriting history.
- Only the merging session fills `Merge commit` and `Outcome` (see [multi-agent.md](../multi-agent.md)).
- Anything an agent did that did not result in a PR (investigation, abandoned attempt) gets a row too.

## Entries

- [2026-10-11](2026-10-11.md) — ACMM rollout, issues #7–#52.

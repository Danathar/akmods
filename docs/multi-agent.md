# Multi-agent coordination

How agents work together in this repo. Rules for a single agent are in [AGENTS.md](../AGENTS.md); review criteria in
[review-rubric.md](review-rubric.md).

## Roles

- **Hive** (`hivecommons/hive`) is the orchestrator: it files work as issues (e.g. the `[ACMM L<n>]` gaps), dispatches
  agents, and tracks outcomes. Agents don't schedule each other; they take one issue and return one PR.
- **Slice agents** implement a bounded piece of work in an isolated git worktree on their own branch.
- **The merging session / integrator** is the only actor that merges and that edits shared singleton files.
- **Humans** own signing secrets, repo settings/rulesets, and anything touching upstream.

## Rules

1. **One PR per slice.** A slice owns a disjoint set of paths (declared up front); it creates only files in its own set and
   may *link* to other slices' paths. `Closes #N` lines in the PR body, one per issue.
2. **Worktree + branch per slice** (`acmm/<slice>`), cut from `origin/main`. Never work in the base checkout.
3. **Serialized merge lane.** PRs merge one at a time, each rebased on the new `main` with checks green. Agents never merge;
   the integrator does, and fixes up conflicts.
4. **Singleton files are owned by the merging session:** `FORK-PATCHES.md` (one registry entry for the whole rollout), the
   session summary (`.claude/session-summary.md`), and the `merge` fields of the [agent-task ledger](agent-tasks/README.md).
   Slice agents don't edit them.
5. **Upstream-owned files are off limits** unless unavoidable; call it out in the PR (see rubric item 8).
6. **Upstream is read-only.** No PRs/issues/comments to `ublue-os/akmods`; all `gh` writes use `-R Danathar/akmods`.
7. **Shared contracts have fixed names** (CI job names, file paths). Don't rename them; peers depend on them.
8. **Host safety.** No builds, containers, `sudo`, or package installs on the shared workstation; container verification is
   done in GitHub Actions on the PR.
9. **Report in a fixed shape:** PR number, files added, issues closed, check results, upstream-owned files touched,
   anything unverified.

## Handoff and conflict handling

- Questions between peers go through the orchestrator messaging channel; keep them short. Long content goes in a shared
  file, not a message.
- If two slices need the same file, the second waits or the integrator splits ownership explicitly.
- A failing check on a slice PR is fixed by the slice's agent; a conflict on `main` is fixed by the integrator.
- Record every agent-run unit of work in [docs/agent-tasks/](agent-tasks/README.md).

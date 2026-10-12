# "Workflows disabled" does not mean "the publish code is dead"

**Date:** 2026-10-11
**Wrong:** reading "all six `Build * akmods` workflows and `Cleanup Old Images`
are `disabled_manually`" as "nothing here ever pushes to a registry", and
therefore treating P1 (`org: danathar`), P2 (`akmods_name` from `images.yaml`)
and the `Justfile` push recipe as removable dead weight during an upstream
merge. `FORK-PATCHES.md` itself said this, wrongly, until it was corrected.
**Right:** `Danathar/zfs-aurora-complex` clones this repo as *source*, rewrites
the `main.zfs` target (P2) and runs this repo's own `just push` from its own
workflows. The push path runs against a real registry on every cache rebuild
that consumer triggers; it is just driven from outside this repository. Check
the consumer before calling any fork patch dead, and re-check workflow state
with `gh workflow list --all -R Danathar/akmods` (the enabled/disabled state is a
repository setting, `git log` never shows it changing).
**Why it matters:** an upstream merge that drops P1/P2 as "unused" makes the
consumer publish to the wrong namespace or image name (P2 is called the most
load-bearing patch in the fork).
**Evidence:** `FORK-PATCHES.md`, "Operational state" and P1 (rewritten in
a54a450, `docs: stop claiming this fork pushes nothing to ghcr.io/danathar`, #4);
`gh workflow list --all -R Danathar/akmods` shows the `Build *` workflows and
`Cleanup Old Images` as `disabled_manually`.

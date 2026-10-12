---
description: Add, change or retire a fork patch and keep FORK-PATCHES.md accurate
---

Task: ${input:change:Describe the fork delta to add, change or retire}.

1. Decide **permanent** (fork identity, e.g. P1/P2) or **temporary** (workaround for a bug or version skew,
   e.g. T1–T6). Prefer a new fork-local file over editing an upstream-owned one.
2. Make the code change in the smallest possible diff. Confirm with `git fetch upstream && git diff
   upstream/main...HEAD -- <files>`.
3. Update `FORK-PATCHES.md` **in the same PR**, using the existing entry shape: Files, What, Why, Merge
   note (permanent) or Remove when (temporary). For a retirement, either delete the entry or leave a
   dated "retired" note like T2 when the idea is likely to recur.
4. If the change touches `Justfile`'s `akmods_name`, `images.yaml` `main.zfs`, or `build_files/zfs/`, state
   the impact on `Danathar/zfs-aurora-complex`.
5. Validate with `actionlint`, `shellcheck` and `node --test` as applicable (no local container builds).
   Open the PR with `-R Danathar/akmods`.

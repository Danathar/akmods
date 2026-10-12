---
name: fork-patch-audit
description: Audit that FORK-PATCHES.md matches the actual diff against upstream. Use before merging a PR that touches Justfile, images.yaml, build_files/, Containerfile.in or workflows, or when the registry may have drifted.
---

# fork-patch-audit

1. `git fetch upstream && git diff --stat upstream/main...HEAD` — list every file differing from upstream.
2. For each file, find its entry in `FORK-PATCHES.md` (P1 `images.yaml` org; P2 `Justfile` `akmods_name`;
   P3 `README.md`; P4 scorecard workflow/script; T1 `images.yaml` `zfs.main`; T3 `build-kmod-zfs.sh` +
   `Justfile` + `Containerfile.in`; T4/T6 `build-prep.sh`; T5 `jq`).
3. Report: files with no registry entry (drift), entries whose files no longer differ (redundant — candidate
   for removal), and entries whose "Remove when" condition is now met.
4. Fork-local additive files (docs, agent config, tests, new workflows) are expected; they are covered by the
   integrator's single registry entry, not one per file.
5. Propose registry edits; do not alter code to satisfy the registry.

---
description: Review a pull request to Danathar/akmods
---

Review PR ${input:pr:PR number} in `Danathar/akmods` (`gh pr view <N> -R Danathar/akmods`,
`gh pr diff <N> -R Danathar/akmods`). Do not approve or merge; report findings only.

Check, in order:

1. **Fork delta:** does the diff add/remove/alter a difference from upstream? If so, is `FORK-PATCHES.md`
   updated in the same PR? Does it edit upstream-owned files (`Justfile`, `build_files/`, `images.yaml`,
   existing workflows, `README.md`) unnecessarily?
2. **Consumer impact:** could it break `Danathar/zfs-aurora-complex`? Especially `akmods_name` (P2), the
   `main.zfs` target, `linux_experimental` (T1; flipping to `true` to fix a red build is wrong) and
   `build_files/zfs/build-kmod-zfs.sh`.
3. **Generated files:** `.github/workflows/build-akmods-*.yml` must match `just generate-workflows` output
   from `workflow-templates/` and `images.yaml`; no hand edits.
4. **Safety:** actions pinned to full SHAs, minimal `permissions`, no secrets echoed (watch `set -x`), no
   Docker Hub images in CI.
5. **Checks:** `gh pr checks <N> -R Danathar/akmods`. Remember a green PR does not predict a green nightly
   (no signing secrets; see `FORK-PATCHES.md`).

Output a table of finding, file:line, severity, suggested fix.

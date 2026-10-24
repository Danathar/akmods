---
description: Diagnose a ZFS / kernel-compatibility build failure
---

A ZFS akmod build failed. Diagnose without building locally (never run `just build|test|fetch-kernel`).
Get logs with `gh run view <id> -R <repo> --log-failed` (the build usually runs in
`Danathar/zfs-aurora-complex`, which drives this repo's source).

Classify the failure:

- **Kernel too new:** `configure: error: *** Cannot build against kernel version X. *** The maximum supported
  kernel version is Y.` — the OpenZFS release does not support the kernel yet. Correct fixes: pin/wait for a
  supported kernel or newer ZFS (`zfs.<flavor>.version`, else `zfs.default.version`, in `images.yaml`). Do **not** set
  `linux_experimental: true` as a fix (see T1 in `FORK-PATCHES.md`).
- **Version pin:** "ZFS_VERSION must be a full X.Y.Z release" or a 404 fetching `zfs-X.Y.Z.tar.gz` — check
  the `zfs.*.version` pin in `images.yaml` (or a `ZFS_VERSION` override). The build makes no GitHub API call.
- **`git: command not found` (127):** T6 — `git` missing in the build environment
  (`build_files/prep/build-prep.sh` `RPMS_TO_INSTALL`).
- **Signing:** `OSSL_DECODER_from_bio ... Input type: PEM` in `fetch-kernel` — empty signing secret on a
  non-PR trigger (see "Scheduled builds" in `FORK-PATCHES.md`).
- **Mirror flake:** `curl (18) end of response with ... bytes missing` from `kojipkgs` — rerun.
- **Wrong image name:** published name differs from expected — check P2 (`akmods_name` in `Justfile`).

Report: classification, evidence (log lines), proposed fix, and whether a `FORK-PATCHES.md` entry is needed.

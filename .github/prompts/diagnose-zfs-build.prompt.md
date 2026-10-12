---
description: Diagnose a ZFS / kernel-compatibility build failure
---

A ZFS akmod build failed. Diagnose without building locally (never run `just build|test|fetch-kernel`).
Get logs with `gh run view <id> -R <repo> --log-failed` (the build usually runs in
`Danathar/zfs-aurora-complex`, which drives this repo's source).

Classify the failure:

- **Kernel too new:** `configure: error: *** Cannot build against kernel version X. *** The maximum supported
  kernel version is Y.` — the OpenZFS release does not support the kernel yet. Correct fixes: pin/wait for a
  supported kernel or newer ZFS (`zfs.<flavor>.minor_version` in `images.yaml`). Do **not** set
  `linux_experimental: true` as a fix (see T1 in `FORK-PATCHES.md`).
- **Release discovery:** empty `ZFS_VERSION`, "not a JSON array", or a rate-limit body — the GitHub API
  lookup in `build_files/zfs/build-kmod-zfs.sh` (see T3); check the `github_token` secret is mounted.
- **`git: command not found` (127):** T6 — `git` missing in the build environment
  (`build_files/prep/build-prep.sh` `RPMS_TO_INSTALL`).
- **Signing:** `OSSL_DECODER_from_bio ... Input type: PEM` in `fetch-kernel` — empty signing secret on a
  non-PR trigger (see "Scheduled builds" in `FORK-PATCHES.md`).
- **Mirror flake:** `curl (18) end of response with ... bytes missing` from `kojipkgs` — rerun.
- **Wrong image name:** published name differs from expected — check P2 (`akmods_name` in `Justfile`).

Report: classification, evidence (log lines), proposed fix, and whether a `FORK-PATCHES.md` entry is needed.

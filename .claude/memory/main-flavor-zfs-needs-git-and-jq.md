# Main-flavor ZFS builds need `git` and `jq`, which upstream's build env only installs for other flavors

**Date:** 2026-10-11
**Wrong:** assuming that because upstream's ZFS script works, the `main` flavor's
build environment has what it uses. Upstream never builds ZFS on `main`, so it
never needed to install them there.
**Right:** `build-prep.sh` installs `git` for every flavor only because of this
fork (T6, the first `RPMS_TO_INSTALL` list); upstream installs `git` and `jq`
only in its `coreos|longterm` block. `jq` for the main flavor comes from T5's
`dnf install -y jq` inside `build-kmod-zfs.sh`. After every upstream merge,
check that whatever new tool `build_files/zfs/build-kmod-zfs.sh` calls is
installed for the `main` flavor too. `tests/unit/zfs_flavor_deps.bats` fails
when upstream's gated package list changes.
**Why it matters:** the first build after the 2026-08-11 upstream merge died
with `git: command not found` (exit 127) because upstream's `c30f343` started
applying the 2.4.3 patches with `git apply`.
**Evidence:** `fbb314c Install git so main-flavor ZFS builds can apply the 2.4.3
patches (#6)`; `c30f343 fix(zfs): backport upstream 7.1 and mmap fixes into 2.4.3`;
`a243ca3` (#117) dropped `centos` from the gated block; at `e8738d5`:
`build_files/prep/build-prep.sh:51-53` (T6) and `:74-88` (the gated block),
`build_files/zfs/build-kmod-zfs.sh:114-119` (`git apply`); `FORK-PATCHES.md` T5,
T6.

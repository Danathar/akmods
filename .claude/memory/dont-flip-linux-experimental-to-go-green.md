# Do not set `zfs.main.linux_experimental: true` to turn a red build green

**Date:** 2026-10-11
**Wrong:** when a main-flavor ZFS build fails with `Cannot build against kernel
version 7.1.4-202.fc44.x86_64. The maximum supported kernel version is 7.0`,
setting `zfs.main.linux_experimental: true` (`--enable-linux-experimental`) so
configure proceeds. That is exactly what happened 2026-07-26 to 2026-07-27.
**Right:** the failure is OpenZFS's own kernel-compatibility gate working. Move
the consumer to a kernel inside the supported range (the fix was switching
`zfs-aurora-complex` from `aurora-dx:latest` to `aurora-dx:stable`, kernel
7.0.12-201.fc44) and keep the flag `false`. Use `true` only as a deliberate,
temporary, documented exception (`coreos-testing` keeps it because it rides
ahead of stable kernels on purpose).
**Why it matters:** with the flag set, a later kernel bump past the ceiling
silently produces a module built against an unsupported kernel instead of
failing, and consumers that gate on the failure lose their upstream-compat
signal.
**Evidence:** `795fd0c Re-arm the OpenZFS kernel-compatibility gate for the main
flavor` (#2); `images.yaml` `zfs.main` block and its comment (lines 11-24 at
`fbb314c`); `FORK-PATCHES.md` T1.

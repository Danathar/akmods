# Do not drop `python3-cffi` as dead weight

**Date:** 2026-10-11
**Wrong:** removing `python3-cffi` from `build-prep.sh`'s `RPMS_TO_INSTALL`
because nothing visible uses it and the fork's commit message never said why.
**Right:** the reason was not recorded when it was added (T4). The likely cause
is a transitive dependency of OpenZFS's `pyzfs` bindings, which `configure`
silently disables when `cffi` is absent, so the build still succeeds but
produces a different artifact. Remove it only after a full `main` ZFS build
without it, run in CI, shows no change.
**Why it matters:** the loss would be silent: no failing step, only missing
bindings.
**Evidence:** `FORK-PATCHES.md` T4; `build_files/prep/build-prep.sh:62` at
`fbb314c`.

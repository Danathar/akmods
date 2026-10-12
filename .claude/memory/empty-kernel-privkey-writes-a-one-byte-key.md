# An empty `KERNEL_PRIVKEY` writes a 1-byte key, so the test-key fallback never fires

**Date:** 2026-10-11
**Wrong:** treating a green `pull_request` build as proof that a scheduled or
`workflow_dispatch` build will pass, or enabling a `Build *` workflow without
setting the signing secrets.
**Right:** no repository secrets are configured. On `pull_request` the
`Retrieve Signing Key` step in `reusable-build.yml` is skipped, `certs/private_key.priv`
stays 0 bytes, `build-prep.sh`'s `[[ ! -s ... ]]` test fires and the build uses
the test key (`WARNING: Using test signing key.`). On
`schedule`/`workflow_dispatch`/`merge_group` the step runs and `echo ""` into
`certs/private_key.priv` leaves a **1-byte** file (a newline); `-s` now passes,
the fallback is skipped, and `fetch-kernel` dies with `OSSL_DECODER_from_bio:
unsupported ... Input type: PEM`. Before enabling any scheduled build, set
`KERNEL_PRIVKEY` and `AKMOD_PRIVKEY_20230518` (and `SIGNING_SECRET` for cosign),
or make the `-s` guard reject whitespace-only files.
**Why it matters:** the failure kills the kernel-cache job in about two minutes,
before any akmod builds, and no PR check ever shows it. Never write key
material into `certs/` locally either: `guard-bash.mjs` refuses it, because a
partial key there recreates this failure.
**Evidence:** `.github/workflows/reusable-build.yml:114-120` and
`build_files/prep/build-prep.sh:70-73` at `fbb314c`; `FORK-PATCHES.md`
"Scheduled builds cannot succeed without the signing secrets" (runs
30318357041, 30412211886, 30503677867).

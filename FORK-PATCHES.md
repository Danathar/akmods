# Fork patch registry

Every deliberate difference between this fork and [`ublue-os/akmods`](https://github.com/ublue-os/akmods) is listed here.
The point is that an upstream merge is a mechanical operation: after `git merge upstream/main`, walk this
file top to bottom and confirm each entry either still applies, is now redundant, or can be dropped.

Regenerate the delta this file describes with:

```
git fetch upstream
git diff upstream/main...HEAD
```

Patches are grouped by whether they are **permanent** (fork identity — they will never go upstream and
should survive every merge) or **temporary** (working around a bug, a gap, or a version skew — each has a
stated condition under which it should be deleted).

---

## Permanent

### P1 — Publish into this fork's GHCR namespace

- **Files:** `images.yaml` (`akmods-base` anchor, `org:`)
- **What:** `org: ublue-os` → `org: danathar`.
- **Why:** every image name in `images.yaml` is assembled as `<registry>/<org>/<name>`. Left at
  `ublue-os`, `just push` from this fork targets `ghcr.io/ublue-os/...` and the registry returns 403,
  because the fork's `GITHUB_TOKEN` has no write access to the upstream org.
- **Merge note:** upstream touches this anchor whenever it adds a field. Keep `org`, take everything else.

### P2 — Image name comes from `images.yaml`, not the target name

- **Files:** `Justfile` (`akmods_name`)
- **What:** upstream hardcodes `akmods_name := 'akmods' + '-<target>'`. This fork reads
  `.images.<version>.<flavor>.<target>.name`, with an `AKMODS_IMAGE_NAME` environment override.
- **Why:** `zfs-aurora-complex` rewrites the `main.zfs` block in `images.yaml` at build time (see
  `ci_tools/akmods_configure_zfs_target.py` in that repo) to publish under a different image name
  (`zfs-aurora-complex-akmods`). Deriving the name from the config lets that repo control the publish
  destination without patching the `Justfile` on every run.
- **Merge note:** this is the single most load-bearing patch in the fork. If an upstream merge silently
  reverts it, `zfs-aurora-complex` starts publishing to the wrong image name.

### P3 — Fork README

- **Files:** `README.md`
- **What:** fork banner, rationale, and `ghcr.io/danathar/...` pull examples in place of `ghcr.io/ublue-os/...`.
- **Merge note:** conflicts on nearly every upstream README change. Keep the fork's framing, fold in
  upstream's substantive content.

### P4 — OpenSSF Scorecard workflow

- **Files:** `.github/workflows/scorecard.yml`, `.github/scripts/scorecard-summary.sh`
- **What:** entirely fork-local. Runs Scorecard on push to `main`, weekly, and on branch-protection
  changes; uploads SARIF and writes a readable Markdown summary into the run.
- **Merge note:** upstream has no equivalent, so this should never conflict.

---

## Temporary

### T1 — ZFS akmod for the `main` kernel flavor

- **Added:** 2026-07-26
- **Files:** `images.yaml` (`images.43.main`, `images.44.main` merge in `*server-build-group-only-x86`),
  `.github/workflows/build-akmods-main.yml` (generated)
- **What:** upstream builds `zfs` only for the server flavors (`centos`, `coreos-*`, `longterm-*`). This
  fork also builds and publishes `ghcr.io/danathar/akmods-zfs:main-43` and `:main-44`.
- **Why:** `zfs-aurora-complex` targets Aurora DX, which rides the Fedora `main` kernel. Until this
  existed, that repo had to rebuild the ZFS akmod from this repo's source on every run.
- **Remove when:** upstream adds a `zfs` target under `main` (then take upstream's), or
  `zfs-aurora-complex` stops consuming a published ZFS cache image.
- **Merge note:** if upstream restructures the build-group anchors, re-derive this rather than taking the
  merge result verbatim, then re-run `just generate-workflows`.

### T2 — `--enable-linux-experimental` for the `main` flavor

- **Added:** 2026-07-26
- **Files:** `images.yaml` (`zfs.main.linux_experimental: true`)
- **What:** passes `--enable-linux-experimental` to the OpenZFS `configure` for `main` builds only,
  the same override `coreos-testing` already carries.
- **Why:** OpenZFS 2.4.3 refuses to configure against a kernel newer than 7.0:

  ```
  configure: error:
      *** Cannot build against kernel version 7.1.4-202.fc44.x86_64.
      *** The maximum supported kernel version is 7.0.
  ```

  Fedora 44's `main` kernel is 7.1.x, so without this flag every `main` ZFS build fails at configure.
  This is the same failure that broke `zfs-aurora-complex`'s nightly (runs 30148339311, 30192096209).
- **Risk:** the flag disables an upstream compatibility gate. The module may build and still misbehave
  against a kernel OpenZFS has not validated. Treat `main` ZFS builds as unvalidated until OpenZFS
  declares support.
- **Remove when:** an OpenZFS release in the configured `minor_version` line raises its maximum supported
  kernel to at or above the Fedora `main` kernel. Check `META`'s `Linux-Maximum` in the OpenZFS tag being
  built; when it covers the current `main` kernel, delete the `zfs.main` block and let it inherit
  `zfs.default`.

### T3 — Hardened OpenZFS release discovery

- **Files:** `build_files/zfs/build-kmod-zfs.sh`, `Justfile` (`build`, `test` — `SECRETS` array),
  `Containerfile.in` (`--mount=type=secret,id=github_token` on the ZFS build step)
- **What:** four changes to the unauthenticated `curl` upstream uses against
  `api.github.com/repos/openzfs/zfs/releases`:
  1. sends `Authorization: Bearer` when `GITHUB_TOKEN`/`GH_TOKEN`/`/run/secrets/github_token` is present;
  2. disables `xtrace` around token handling so CI's `set -x` cannot echo the token into the job log;
  3. asserts the response is a JSON array before parsing, and prints the body on failure;
  4. fails loudly when no release matches `zfs-<minor>` instead of silently producing an empty version.
- **Why:** the anonymous GitHub API allows 60 requests/hour per IP. On shared CI runners that budget is
  routinely exhausted, and the API then returns a rate-limit *object* rather than an array. Upstream's
  `jq` then yields an empty `ZFS_VERSION` and the build fails much later with a confusing error.
- **Remove when:** upstream adopts an authenticated or non-API release lookup. Until then this must be
  carried forward as a unit — the `Justfile` secret plumbing and the `Containerfile.in` secret mount are
  useless without the script change, and vice versa.

### T4 — `python3-cffi` in the build environment

- **Files:** `build_files/prep/build-prep.sh` (`RPMS_TO_INSTALL`)
- **What:** one added package.
- **Why:** *not recorded at the time it was added.* Most likely a missing transitive dependency of the
  ZFS `pyzfs` bindings, which `configure` will silently disable if `cffi` is absent.
- **Remove when:** confirmed unnecessary. Do not drop it on the assumption it is dead weight — verify by
  running a full `main` ZFS build without it first.

### T5 — `dnf install -y jq` inside the ZFS build step

- **Files:** `build_files/zfs/build-kmod-zfs.sh`
- **What:** installs `jq` before parsing the release JSON.
- **Why:** `jq` is not guaranteed present in the build stage, and upstream's script assumes it is.
- **Remove when:** `jq` is added to `RPMS_TO_INSTALL` in `build_files/prep/build-prep.sh` (upstream or
  here), which is the better place for it.

---

## Related

- Sync and pin process: [`docs/akmods-fork-maintenance.md`](https://github.com/Danathar/zfs-aurora-complex/blob/main/docs/akmods-fork-maintenance.md) in `zfs-aurora-complex`.
- Consuming repo's akmods config: `ci/defaults.json` and `ci_tools/akmods_configure_zfs_target.py` in `zfs-aurora-complex`.

## Operational state (not a patch, but easy to lose)

- The fork's build workflows were disabled by hand after the 2026-07-05 scheduled runs failed on a
  transient `kojipkgs` truncation (`curl (18) end of response with ... bytes missing`) — a flake, not a
  config fault. `Build MAIN akmods` has since been re-enabled; `CENTOS`, `COREOS-STABLE`,
  `COREOS-TESTING`, `LONGTERM-6.18`, `OGC`, and `Cleanup Old Images` remain `disabled_manually`
  deliberately, since nothing here consumes them.
- No repository secrets are configured. `KERNEL_PRIVKEY` / `AKMOD_PRIVKEY_20230518` are absent, so
  `build-prep.sh` falls back to the **test signing key** (`certs/*.priv.test`) and logs
  `WARNING: Using test signing key.` `SIGNING_SECRET` is absent too, so pushed images are not
  cosign-signed. Anything consuming these images must enroll the test key or not verify at all.

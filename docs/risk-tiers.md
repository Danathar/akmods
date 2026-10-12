# Risk tiers

How risky is a change to `Danathar/akmods`? This fork builds **signed** Fedora
akmod RPMs and publishes them as OCI images to `ghcr.io/danathar/*`; another
repository (`Danathar/zfs-aurora-complex`) consumes the fork as source. A bad
change can leak or invalidate signing material, publish to the wrong registry,
or ship an unsigned/mis-signed kernel module to every machine that pulls the
image. Tiers say how much scrutiny a change needs. How a pull request is
classified is in [change-classification.md](change-classification.md).

Tier 1 is the **most** dangerous. The table below is the human-readable copy of
[`risk-config.json`](../risk-config.json), which is the machine-readable source
the classifier reads. `node scripts/check-policies.mjs` fails when the two
disagree, and when a path in the config matches no file in the repository, so
the table cannot drift. Edit both in the same pull request.

| Tier | Name | Paths | Required commands | Review |
| --- | --- | --- | --- | --- |
| 1 | critical | `certs/**`, `cosign.pub`, `.github/CODEOWNERS`, `.github/rulesets/**`, `policies/**`, `scripts/check-policies.mjs`, `risk-config.json`, `.claude/settings.json`, `.claude/hooks/**` | `node scripts/check-policies.mjs`, `node --test`, `actionlint` | `owner` |
| 2 | high | `.github/workflows/**`, `Containerfile.in`, `Justfile`, `images.yaml`, `build_files/prep/**`, `build_files/post/**`, `build_files/zfs/**`, `FORK-PATCHES.md`, `AGENTS.md`, `CLAUDE.md`, `.github/copilot-instructions.md`, `.cursor/rules/**`, `.github/prompts/**`, `.claude/**`, `docs/risk-tiers.md`, `docs/security/**` | `node scripts/check-policies.mjs`, `node --test`, `actionlint`, `shellcheck` | `owner` |
| 3 | medium | `build_files/**`, `fetch-kernel.sh`, `workflow-templates/**`, `files/**`, `renovate.json`, `scripts/**`, `tests/**`, `.github/scripts/**`, `.github/labeler.yml`, `.github/auto-qa-tuning.json`, `.shellcheckrc`, `.coverage-thresholds.json` | `shellcheck`, `node --test` | `ci` |
| 4 | low | `docs/**`, `*.md`, `.editorconfig`, `.gitignore`, `.gitattributes`, `.devcontainer.json`, `.github/ISSUE_TEMPLATE/**`, `.github/pull_request_template.md` | none | `ci` |

Rules for reading the table:

- A file takes the **most dangerous** tier any of its globs matches
  (`docs/risk-tiers.md` matches `docs/**` and the tier 2 entry: it is tier 2).
- A file that matches nothing is **tier 2 (high)**: unknown is not safe.
- Globs are anchored over repository-relative paths; `*` stays inside one
  directory, `**` crosses directories.
- `Review: owner` means the repository owner reads the change before merge.
  `ci` means green required checks are enough.
- A glob for a file that has not landed yet may be listed under `pending` in
  `risk-config.json`, which exempts it from the must-match-a-file check. Remove
  the entry once the file is on `main`; there are none today.
- A path glob cannot see inside a file. A reviewer may raise a change above its
  path tier, never lower it. Raise it when, for example, a tier 3
  `build_files/*/build-kmod-*.sh` change touches signing, `dnf`/`curl`
  downloads without checksums, or `--enable-linux-experimental`.

## Why each tier

**Tier 1, critical: the trust anchors.** `certs/` holds the public signing
certificates and 0-byte placeholders for the private keys (see
[SECURITY-AI.md](security/SECURITY-AI.md)); `cosign.pub` verifies image
signatures. The rulesets, CODEOWNERS, `policies/` and the checker are what
stop every other rule being edited away, and `.claude/settings.json` and
`.claude/hooks/` are the agent guard rails.

**Tier 2, high: the signing and publishing path.** `Containerfile.in`
(secret mounts, build stages), `build_files/prep/` (`build-prep.sh`,
`dual-sign-check.sh`), `build_files/post/` (`build-post.sh`, `dual-sign.sh`),
the ZFS scripts (authenticated OpenZFS release discovery, patches, kernel
compat gate: fork patch T3, T1), the `Justfile` (push, manifest, secrets,
the P2 image-name lookup), `images.yaml` (P1 `org: danathar`, registry,
names) and every workflow (several hold `packages: write`,
`id-token: write`, `attestations: write`, and consume the signing secrets).
`FORK-PATCHES.md` and the agent-direction files define what agents may do.

**Tier 3, medium: contained build logic and tooling.** The per-kmod
`build_files/**` scripts, `fetch-kernel.sh`, the `workflow-templates/` that
generate the build workflows, `files/`, and the repository's scripts and tests.
A defect breaks a build or a test, not the signing chain.

**Tier 4, low: documentation and metadata.**

## Using it

```bash
node scripts/check-policies.mjs --classify Justfile build_files/common/build-kmod-wl.sh README.md
```

prints the tier and review of each path. The policy checker itself runs in CI
as the `policy-check` job; see [`policies/README.md`](../policies/README.md).

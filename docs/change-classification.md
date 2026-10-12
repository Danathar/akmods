# Change classification

Every change to `Danathar/akmods` is classified by risk tier before review
(ACMM: change classification). The tiers, their paths, required commands and
review level are defined in [risk-tiers.md](risk-tiers.md) and stored as data in
[`risk-config.json`](../risk-config.json); this page only says how to apply
them. It does not repeat the path list, so there is one place to update.

## Procedure

1. List the files the change touches.
2. Classify each: `node scripts/check-policies.mjs --classify <path>...`.
3. The change's tier is the **most dangerous** (lowest number) of its files.
4. Raise it, never lower it, if the content is riskier than the path
   (signing, downloads, registry names, token scopes, anything that handles
   `KERNEL_PRIVKEY`, `AKMOD_PRIVKEY_20230518` or `SIGNING_SECRET`).
5. Run the tier's required commands (the table in risk-tiers.md) and state
   the tier in the pull request description.
6. Tier 1 and 2 changes need the owner's review. Tier 3 and 4 merge on green
   checks. Nothing is merged by an agent.

## Fork-specific rules of thumb

- **Upstream-owned files** (anything in `ublue-os/akmods`: `Justfile`,
  `build_files/`, `images.yaml`, existing workflows, `README.md`) are edited
  only for a documented fork patch in `FORK-PATCHES.md`. The change is tier 2
  or higher *and* needs a registry entry there. Prefer a new fork-local file.
- **Never lowered by size.** A one-line change to `images.yaml` `org:` is tier 2
  however small; it redirects every push (patch P1).
- **Workflows with write permissions** are tier 2. A fork-local workflow also
  has to satisfy `policies/workflow-permissions.json` (top-level read-only
  `permissions:`, SHA-pinned actions, no `pull_request_target`).
- **Kmod build scripts** (tier 3) become tier 2 if they alter signing or
  `dual-sign` behaviour, because the build scripts run as root with the
  signing key present.
- **Mixed pull requests** are classified as a whole by their highest tier.
  Splitting a docs change out of a tier 2 pull request makes review easier.

## Machine enforcement

`node scripts/check-policies.mjs` (the `policy-check` CI job) verifies that
the tier table here and in risk-tiers.md matches `risk-config.json`, and that
every configured path matches a file. It does not label pull requests; the
classification above is applied by the author or reviewer.

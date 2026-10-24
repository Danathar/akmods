# Policies

Machine-checked rules for this fork, evaluated by
[`scripts/check-policies.mjs`](../scripts/check-policies.mjs) and run in CI by
the `policy-check` job ([workflow](../.github/workflows/policy-check.yml)).
Locally: `node scripts/check-policies.mjs`; the checker's own tests:
`node --test scripts/tests/check-policies.test.mjs`. Dependency-free Node.

| File | Rule |
| --- | --- |
| `signing-keys.json` | `certs/*.priv` are 0-byte placeholders; no private key material anywhere else (except `certs/*.priv.test`); `secrets.KERNEL_PRIVKEY`, `AKMOD_PRIVKEY_20230518`, `SIGNING_SECRET` are referenced only by `reusable-build.yml` and `reusable-cache-kernel.yml` |
| `workflow-permissions.json` | no `pull_request_target`, no `write-all`; fork-local workflows also need top-level read-only `permissions:`, SHA-pinned actions, no event text in `run:` |
| `repo-target.json` | every `gh` write command names `Danathar/akmods` (upstream is read-only) |
| `fork-patches.json` | fork patches P1, P2, T6 from `FORK-PATCHES.md` are still present |
| `ruleset.json` | `.github/rulesets/main.json` has the required rules and the seven required checks |
| `upstream-owned.json` | globs of upstream files, exempt from the fork-local-only rules |

`risk-config.json` against `docs/risk-tiers.md` is checked too; see
[docs/risk-tiers.md](../docs/risk-tiers.md).

Changing a policy is a tier 1 change. Reword prose rather than adding
exemptions: the repo-target rule deliberately has none.

# Policies

Machine-checked rules for this fork, evaluated by
[`scripts/check-policies.mjs`](../scripts/check-policies.mjs) and run in CI by
the `policy-check` job ([workflow](../.github/workflows/policy-check.yml)).
Locally: `node scripts/check-policies.mjs`; the checker's own tests:
`node --test scripts/tests/check-policies.test.mjs`. Dependency-free Node.

| File | Rule |
| --- | --- |
| `signing-keys.json` | `certs/*.priv` are 0-byte placeholders; no private key material anywhere else (except the test keys in `certs/test/*.key`); `secrets.KSIGN_*`, `KERNEL_PRIVKEY`, `AKMOD_PRIVKEY_20230518`, `SIGNING_SECRET` are referenced only by `reusable-build.yml` and `reusable-cache-kernel.yml` |
| `workflow-permissions.json` | no `pull_request_target`, no `write-all`; fork-local workflows also need top-level read-only `permissions:`, SHA-pinned actions, no event text in `run:` |
| `repo-target.json` | every `gh` write command names `Danathar/akmods` (upstream is read-only) |
| `fork-patches.json` | fork patches P1, P2, T6, T7 from `FORK-PATCHES.md` are still present |
| `secret-argv.json` | no secret on a command line: in the `Justfile` and every workflow's `run:` scripts, a value naming `*TOKEN*`, `*PASSWORD*`, `*SECRET*`, `secrets.*` or `github.token` is never passed as `-p`, `--password`, `--creds` or `--registry-password`, or inside a `user:$TOKEN@` URL; pipe it in (`printf '%s' "$TOKEN" \| ... --password-stdin`) or write it to a file |
| `ruleset.json` | `.github/rulesets/main.json` has the required rules and the seven required checks |
| `upstream-owned.json` | globs of upstream files, exempt from the fork-local-only rules |
| `check-policies-corpus.json` | not a rule: the fleet's shared regression corpus for the checker (one workflow per fixed bypass and the run-expression violations it must produce). Canonical copy in [Danathar/dns-failover](https://github.com/Danathar/dns-failover/blob/main/policies/check-policies-corpus.json); copied byte for byte, pinned by SHA-256 in `scripts/tests/check-policies.test.mjs`, replayed there on every pull request, and compared with dns-failover's `main` by `nightly-compliance.yml` ([#245](https://github.com/Danathar/akmods/issues/245)) |

`risk-config.json` against `docs/risk-tiers.md` is checked too; see
[docs/risk-tiers.md](../docs/risk-tiers.md).

Changing a policy is a tier 1 change. Reword prose rather than adding
exemptions: the repo-target rule deliberately has none.

# Contributing to Danathar/akmods

This is a personal fork of [`ublue-os/akmods`](https://github.com/ublue-os/akmods) that feeds
[`zfs-aurora-complex`](https://github.com/Danathar/zfs-aurora-complex). See `README.md` ("Why This Fork
Exists") and [`FORK-PATCHES.md`](FORK-PATCHES.md).

## Where contributions belong

- **General akmods improvements** (new kmods, kernel flavors, upstream bug fixes) belong in
  [`ublue-os/akmods`](https://github.com/ublue-os/akmods) — follow its
  [contributor guide](https://docs.projectbluefin.io/contributing). They reach this fork through upstream merges.
- **Fork-specific changes** (anything that serves `zfs-aurora-complex`, CI/tooling for this fork, agent docs)
  go here. Open issues and PRs against `Danathar/akmods` only; never against upstream from this fork's work.

## Making a change

1. Branch from `main`; keep one logical change per PR; use conventional commit messages.
2. Prefer new files over editing upstream-owned ones (`Justfile`, `build_files/`, `images.yaml`, existing
   workflows). Never hand-edit `.github/workflows/build-akmods-*.yml`: edit `workflow-templates/` or
   `images.yaml` and run `just generate-workflows` (requires `yq`).
3. **If your change adds, removes or alters a difference from upstream, update `FORK-PATCHES.md`** in the same
   PR.
4. Test (see below), open a PR against `main`, fill in the PR template.

## Testing

| What | Command |
|---|---|
| Shell lint | `shellcheck <files>` |
| Workflow lint | `actionlint` |
| Unit tests | `npx --yes bats@1.11.1 tests/unit` |
| Node tooling | `node --test` |
| End-to-end | `tests/e2e/run.sh` (runs in a container; CI does this) |

Do not run `just build`, `just test`, `just fetch-kernel`, `just push` or `just manifest` on a workstation:
they build containers, download kernels and push images. Those paths are exercised in CI.

CI note: a green PR does not mean scheduled builds work — no signing secrets are configured and all
`Build * akmods` workflows are disabled (see `FORK-PATCHES.md`, "Operational state").

## Pull requests

- Describe what each file is for; link issues with `Closes #N`.
- Wait for checks (`gh pr checks <PR> -R Danathar/akmods --watch`) to be green.
- Changes to `Justfile`'s `akmods_name` logic, `images.yaml` or `build_files/zfs/` can break the downstream
  consumer; call that out in the PR.
- PRs are merged by the maintainer, not the author.

## AI agents

Agents follow [`AGENTS.md`](AGENTS.md); prompts live in `.github/prompts/`, skills in `.claude/skills/`.

## Conduct

See [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).

---
description: Merge upstream ublue-os/akmods into the fork and walk FORK-PATCHES.md
---

Sync this fork with upstream. Upstream is read-only; do not touch `ublue-os/akmods` on GitHub. Never run
`just build|test|fetch-kernel|push|manifest`, `sudo`, or package installs.

1. `git fetch upstream origin`; create a branch named `upstream-sync/<date>` from `origin/main`;
   `git log --oneline HEAD..upstream/main` to see what is incoming.
2. `git merge upstream/main`. Resolve conflicts using the merge notes in `FORK-PATCHES.md`
   (README conflicts: keep fork framing and the no-images callout; `images.yaml`: keep `org: danathar` and
   `zfs.main`; `Justfile`: keep the `akmods_name` logic).
3. Walk `FORK-PATCHES.md` top to bottom. For each P*/T* entry record: still applies / redundant / drop, with
   evidence from `git diff upstream/main...HEAD`. Pay special attention to T6 (`git` install) and T5 (`jq`),
   which upstream may have fixed, and T3 (must be carried as a unit across `Justfile`, `Containerfile.in`,
   `build_files/zfs/build-kmod-zfs.sh`).
4. Confirm P2 survived: the `Justfile` still reads `.images.<version>.<flavor>.<target>.name` with the
   `AKMODS_IMAGE_NAME` override. A regression breaks `Danathar/zfs-aurora-complex`.
5. Update `FORK-PATCHES.md` for every entry that became redundant or changed. Run `actionlint`, `shellcheck`
   on touched scripts, and `node --test`.
6. Open a PR with
   `gh pr create -R Danathar/akmods --base main --label upstream-sync --title "chore: sync upstream ublue-os/akmods"`;
   include the verdict per patch. Do not merge. The PR must land as a merge commit, never a squash: the
   title, label or `upstream-sync/` branch is what tells the Hive (AGENTS.md, "Upstream merge procedure").

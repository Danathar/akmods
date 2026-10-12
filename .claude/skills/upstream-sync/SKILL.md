---
name: upstream-sync
description: Merge ublue-os/akmods upstream into the Danathar/akmods fork and walk FORK-PATCHES.md. Use when asked to sync, update or merge from upstream.
---

# upstream-sync

Full prompt: `.github/prompts/upstream-sync.prompt.md`. Summary:

1. `git fetch upstream origin`; branch `upstream-sync/<date>` from `origin/main`; `git merge upstream/main`.
2. Resolve conflicts per each entry's *Merge note* in `FORK-PATCHES.md`.
3. Walk the file top to bottom: each P*/T* entry still applies, is redundant, or can be dropped. Verify P2
   (`akmods_name` in `Justfile`) especially — its regression breaks `Danathar/zfs-aurora-complex`.
4. Update `FORK-PATCHES.md`, run the `run-checks` skill, open a PR with
   `gh pr create -R Danathar/akmods --label upstream-sync --title "chore: sync upstream ublue-os/akmods"`.
   The title, label or `upstream-sync/` branch makes the Hive land it as a merge commit; a squash drops
   upstream's ancestry (see AGENTS.md, "Upstream merge procedure").

Upstream is read-only; never write to it. Never merge the PR yourself.

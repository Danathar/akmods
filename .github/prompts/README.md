# Prompt catalog

Reusable prompts for recurring tasks in this fork. Each is a self-contained `*.prompt.md` (VS Code / Copilot
prompt-file format; usable verbatim in any agent). All of them inherit the rules in [`AGENTS.md`](../../AGENTS.md):
host safety, upstream read-only, `-R Danathar/akmods` for `gh` writes.

| Prompt | Use it when |
|---|---|
| [`upstream-sync.prompt.md`](upstream-sync.prompt.md) | Merging `ublue-os/akmods` `main` into this fork and walking `FORK-PATCHES.md` |
| [`fork-patch.prompt.md`](fork-patch.prompt.md) | Adding, changing or retiring a fork patch (P*/T*) |
| [`review-pr.prompt.md`](review-pr.prompt.md) | Reviewing a PR to this fork |
| [`diagnose-zfs-build.prompt.md`](diagnose-zfs-build.prompt.md) | A ZFS / kernel-compatibility build failure |
| [`regenerate-workflows.prompt.md`](regenerate-workflows.prompt.md) | Changing `images.yaml` or `workflow-templates/` and regenerating build workflows |

Matching skills (shorter, tool-triggered): `.claude/skills/{run-checks,upstream-sync,fork-patch-audit}/SKILL.md`.

Conventions: keep prompts specific to this repo, cite only commands and paths that exist, and update the
catalog table when adding one.

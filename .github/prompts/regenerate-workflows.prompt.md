---
description: Change images.yaml or workflow-templates and regenerate build workflows
---

The `.github/workflows/build-akmods-*.yml` files are generated ("DO NOT EDIT BY HAND"). To change them:

1. Edit `images.yaml` and/or `workflow-templates/{workflow,job,cache_kernel,check-status}.yaml.in`.
2. Regenerate: `just generate-workflows` from the repo root. It needs `yq` and only rewrites
   `.github/workflows/build*.yml` inside the checkout (it deletes then recreates them). It does not build
   anything, but do not run any other `just` recipe locally.
3. Validate with `actionlint`.
4. Review the diff: the regenerated workflows should differ only by what you changed. Note the generator
   substitutes a random cron minute, so cron lines may churn; keep existing ones where unrelated.
5. Remember "disabled" state lives in GitHub settings, not in files; regeneration does not change it.
6. If the delta from upstream changes, update `FORK-PATCHES.md`. Open the PR with `-R Danathar/akmods`.

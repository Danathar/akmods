# Strategy

## What this fork is for

`Danathar/akmods` exists to give **`Danathar/zfs-aurora-complex`** a working, signed-capable ZFS akmod build path on
Fedora kernels (including the `main` flavor upstream never builds ZFS for). It is not a product, and not a general
replacement for `ublue-os/akmods`.

## Principles

1. **Minimal delta from upstream.** Every difference is registered in [FORK-PATCHES.md](../FORK-PATCHES.md) with a
   reason and a remove-when. The goal is that `git merge upstream/main` stays mechanical. New capability goes in new
   fork-local files first; edits to upstream-owned files are a last resort.
2. **Serve the consumer.** P1/P2 (namespace, image-name-from-config) are load-bearing for `zfs-aurora-complex`; T1/T3/T6
   keep its ZFS build correct. A change that can't be justified by that consumer or by merge-friendliness doesn't belong.
3. **Fail loudly.** Don't force a green build with the kernel-compat override, don't swallow rate-limit responses, don't
   fall back silently to the test key in scheduled builds.
4. **Nothing is built here by default.** The fork's own build workflows stay disabled until signing secrets exist and a
   consumer needs a cache. An unconsumed daily image is pure cost (see retired T2).
5. **Upstream is read-only.** Contribute fixes upstream only by explicit human decision.

## ACMM stance

The Hive ACMM evaluation scores repo maturity. This fork targets **Level 6 (Fully Autonomous) for the process layer** —
CI contract, agent instructions, guardrails, policies, metrics, runbook, task ledger, orchestration — while keeping the
*build* layer deliberately manual: nothing here may autonomously push images, enable disabled workflows, touch signing
material, or merge. Autonomy is bounded by [risk tiers](risk-tiers.md) and the
[review rubric](review-rubric.md); humans keep merge authority and secrets.

## How we know it's working

[PR metrics](metrics.md) (acceptance, time-to-merge, agent share, reverts), the [quality index](quality.md), and the
[agent-task ledger](agent-tasks/README.md). Review quarterly: are agents landing PRs that pass the rubric the first time,
and is the patch registry still short?

## Non-goals

Publishing our own akmod images by default, diverging from upstream's build design, owning kernel/OpenZFS compatibility
policy beyond keeping the gate honest.

# Correction memory

One file per correction: a mistake an agent (or a person) made, or came within
one step of making, in this repository, the rule that prevents it, and the
evidence. The conversation that produced a mistake is gone by the next session;
these files are what is left.

**Host rule.** This is a workstation-hosted checkout. Agents never run
`just build|test|fetch-kernel|push|manifest|clean`, `sudo`, a package install,
`podman build|push|login|system prune` or `cosign sign`, and never write real
signing keys into `certs/`. Container and e2e verification happens in GitHub
Actions on the pull request. `.claude/hooks/guard-bash.mjs` enforces this.
`Danathar/akmods` is a fork: every `gh` write passes `--repo Danathar/akmods`;
`ublue-os/akmods` is the read-only upstream.

## What goes here

- Something that went wrong, or nearly did, that is easy to repeat and hard to
  see from the code alone. This repository's best source is
  [FORK-PATCHES.md](../../FORK-PATCHES.md), which records each fork patch and the
  failure behind it; an entry here is the short "do not do this again" form with
  a pointer back to the evidence.
- Not here: standing rules for all work (those go in `AGENTS.md`), what is in
  flight now ([../session-summary.md](../session-summary.md)), and patterns in
  how the work goes ([../../docs/reflections/](../../docs/reflections/README.md)).
  A correction that hardens into a standing rule is promoted to `AGENTS.md`; the
  entry stays as the reason behind the rule.

## Naming and format

`<kebab-case-topic>.md`, one correction per file:

```markdown
# <short title>

**Date:** YYYY-MM-DD (when it was recorded)
**Wrong:** what was done or assumed
**Right:** what is true / what to do
**Why it matters:** the consequence of repeating it
**Evidence:** commit, PR, run or file:line that shows it
```

Evidence must be something a reader can open. A claim that cannot be checked
against a commit, a PR, a run or a file does not get an entry. Line numbers name
the commit they were read at; `build-prep.sh`, `images.yaml` and
`reusable-build.yml` change with every upstream merge, so re-check them.

## When to add and retire

- Add an entry in the same PR that fixes the mistake, or at the end of the
  session in which it was caught, and link it from the index below. Extend an
  existing entry rather than adding a near-duplicate.
- Re-verify an entry before relying on it. If it stopped being true (for
  example upstream starts installing `git` for every flavor), delete or rewrite
  it in the PR that makes it untrue. A stale correction is worse than none.
- Upstream-owned files (anything in `upstream/main`) are changed only when
  unavoidable, and every such change is registered in `FORK-PATCHES.md`; this
  directory is fork-local and never conflicts with an upstream merge.

## Index

| Entry | One line |
|---|---|
| [workflows-disabled-is-not-publish-dead](workflows-disabled-is-not-publish-dead.md) | Every `Build *` workflow being `disabled_manually` does not make `just push`, P1 or P2 dead code: `zfs-aurora-complex` drives them |
| [dont-repoint-readme-refs-to-ghcr-danathar](dont-repoint-readme-refs-to-ghcr-danathar.md) | README `COPY --from` / `cosign verify` examples stay on `ghcr.io/ublue-os/...`; nothing is published under `ghcr.io/danathar/akmods` |
| [dont-flip-linux-experimental-to-go-green](dont-flip-linux-experimental-to-go-green.md) | `zfs.main.linux_experimental: true` turns a red ZFS build green by disabling the kernel-compat gate |
| [empty-kernel-privkey-writes-a-one-byte-key](empty-kernel-privkey-writes-a-one-byte-key.md) | With no `KERNEL_PRIVKEY` secret, scheduled/dispatch builds write a 1-byte key; the test-key fallback never fires, and a green PR check predicts nothing |
| [main-flavor-zfs-needs-git-and-jq](main-flavor-zfs-needs-git-and-jq.md) | Upstream never builds ZFS on `main`, so its build env lacks what the ZFS script uses; `git` is T6 (`jq` was T5, retired 2026-10-24) |
| [dont-drop-python3-cffi-as-dead-weight](dont-drop-python3-cffi-as-dead-weight.md) | T4's rationale was never recorded; verify with a full main ZFS build before removing it |

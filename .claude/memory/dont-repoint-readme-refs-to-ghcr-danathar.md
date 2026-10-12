# Do not repoint the README's cosign / COPY examples to ghcr.io/danathar

**Date:** 2026-10-11
**Wrong:** "fixing" the README's `COPY --from=ghcr.io/ublue-os/akmods:...` and
`cosign verify ... ghcr.io/ublue-os/akmods:...` examples to the fork's
namespace, because the fork is the repository you are standing in. This was
done once and reverted.
**Right:** leave them pointing at upstream's registry. Nothing publishes
`akmods` or `akmods-nvidia` under `ghcr.io/danathar`, so rewritten references
point at images that do not exist, and the checked-in `cosign.pub` is
upstream's key, so verification of a fork-published image with it would fail
anyway. Change them only if publishing is actually turned on.
**Why it matters:** users copy these examples; a rewritten one 404s, and a
cosign command against the fork's namespace verifies nothing.
**Evidence:** `FORK-PATCHES.md` P3 ("Deliberately *not* changed", both images
404 as of 2026-07-30); `de629cb docs: adopt fork-identity README` and
`6562843 fix(docs): correct the README entry in the fork patch registry`.

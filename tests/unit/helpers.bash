# Shared helpers for the bats unit tests. Sourced with `load helpers`.
#
# Everything here is read-only against the checkout: tests work on a copy of the
# files they need under $BATS_TEST_TMPDIR, `podman` is a stub, and the Justfile's
# build directory is redirected into the temp dir (AKMODS_BUILDDIR).

REPO_ROOT="$(cd "${BATS_TEST_DIRNAME}/../.." && pwd)"
export REPO_ROOT

# Only the pinned `just` is verified against this Justfile (see
# tests/install-tools.sh). JUST_BIN lets a developer point at it when the system
# one differs.
JUST_BIN="${JUST_BIN:-just}"

# Same yq flag the Justfile uses; stderr (a deprecation warning on some yq
# versions) is dropped so it cannot pollute `run` output.
yq() {
    command yq --yaml-fix-merge-anchor-to-spec "$@" 2>/dev/null
}

require_tools() {
    local tool
    for tool in "$@"; do
        command -v "${tool}" >/dev/null 2>&1 || skip "${tool} not installed"
    done
}

# Copies the files `just` needs into a scratch repo and puts a stub `podman` on
# PATH (the Justfile resolves `podman` at parse time via `which`; nothing here
# ever runs it). Sets WORK (scratch repo) and exports AKMODS_BUILDDIR/PATH.
make_scratch_repo() {
    WORK="${BATS_TEST_TMPDIR}/repo"
    mkdir -p "${WORK}/.github" "${BATS_TEST_TMPDIR}/stubs" "${BATS_TEST_TMPDIR}/build"
    cp "${REPO_ROOT}/Justfile" "${REPO_ROOT}/images.yaml" "${WORK}/"
    cp -r "${REPO_ROOT}/workflow-templates" "${WORK}/"
    cp -r "${REPO_ROOT}/.github/workflows" "${WORK}/.github/"
    printf '#!/bin/sh\necho "stub podman invoked: $*" >&2\nexit 99\n' >"${BATS_TEST_TMPDIR}/stubs/podman"
    chmod +x "${BATS_TEST_TMPDIR}/stubs/podman"
    export PATH="${BATS_TEST_TMPDIR}/stubs:${PATH}"
    export AKMODS_BUILDDIR="${BATS_TEST_TMPDIR}/build"
    # Never inherit a developer's or CI's overrides into an evaluation.
    unset AKMODS_IMAGE_NAME AKMODS_KERNEL AKMODS_VERSION AKMODS_TARGET AKMODS_REGISTRY AKMODS_TRANSPORT ZFS_VERSION ZFS_CONFIGURE_ARGS
}

# just_eval <variable> — prints one Justfile variable, evaluated in $WORK.
just_eval() {
    (cd "${WORK}" && "${JUST_BIN}" --evaluate "$1")
}

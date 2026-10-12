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
    unset AKMODS_IMAGE_NAME AKMODS_KERNEL AKMODS_VERSION AKMODS_TARGET AKMODS_REGISTRY AKMODS_TRANSPORT ZFS_MINOR_VERSION ZFS_CONFIGURE_ARGS
}

# just_eval <variable> — prints one Justfile variable, evaluated in $WORK.
just_eval() {
    (cd "${WORK}" && "${JUST_BIN}" --evaluate "$1")
}

# Prints the body of build-kmod-zfs.sh's release-discovery section: from the
# xtrace guard through the ZFS_VERSION validation. Fails if the markers moved,
# so a refactor cannot silently turn the T3 tests into no-ops.
extract_zfs_discovery() {
    local script="${REPO_ROOT}/build_files/zfs/build-kmod-zfs.sh"
    local out
    out="$(sed -n '/^xtrace_was_enabled=0$/,/^echo "ZFS_CONFIGURE_ARGS==/p' "${script}")"
    [[ "${out}" == xtrace_was_enabled=0* && "${out}" == *'echo "ZFS_CONFIGURE_ARGS=='* ]] || {
        echo "release-discovery markers not found in ${script}" >&2
        return 1
    }
    printf '%s\n' "${out}"
}

# make_curl_stub <json-file|-> — installs a `curl` stub on PATH that records its
# arguments to $BATS_TEST_TMPDIR/curl.args (one per line) and writes the given
# fixture to the `-o` target. Pass `-` to fail with exit 22 like `curl -f`.
make_curl_stub() {
    local fixture="$1"
    mkdir -p "${BATS_TEST_TMPDIR}/stubs"
    cat >"${BATS_TEST_TMPDIR}/stubs/curl" <<STUB
#!/usr/bin/env bash
printf '%s\n' "\$@" >"${BATS_TEST_TMPDIR}/curl.args"
out=""
while [[ \$# -gt 0 ]]; do
    if [[ "\$1" == "-o" ]]; then out="\$2"; fi
    shift
done
[[ "${fixture}" == "-" ]] && exit 22
cp "${fixture}" "\${out}"
STUB
    chmod +x "${BATS_TEST_TMPDIR}/stubs/curl"
    export PATH="${BATS_TEST_TMPDIR}/stubs:${PATH}"
}

# run_zfs_discovery [bash-flags...] — runs the extracted discovery code under
# `set -euo pipefail` in a scratch cwd with ZFS_MINOR_VERSION=2.4. Credentials in
# the caller's environment are not scrubbed on purpose: tests set what they need.
run_zfs_discovery() {
    local snippet="${BATS_TEST_TMPDIR}/discovery.sh"
    {
        printf 'set -euo pipefail\n'
        printf 'ZFS_MINOR_VERSION=%s\nZFS_CONFIGURE_ARGS=\n' "${ZFS_TEST_MINOR:-2.4}"
        extract_zfs_discovery
    } >"${snippet}"
    mkdir -p "${BATS_TEST_TMPDIR}/cwd"
    cd "${BATS_TEST_TMPDIR}/cwd" || return 1
    run bash "$@" "${snippet}"
}

# extract_justfile_secrets <recipe> — prints the SECRETS-selection block of one
# Justfile recipe (`build` or `test`): from `SECRETS=()` up to, not including,
# the `podman build` line. Fails if the markers moved or the block picked up a
# just interpolation, so it can be run as plain bash.
extract_justfile_secrets() {
    local recipe="$1" out
    out="$(awk -v r="${recipe}" '
        $0 ~ "^" r ":" { inr = 1; next }
        inr && /^[^ \t#]/ { exit }
        inr && /^    SECRETS=\(\)$/ { f = 1 }
        inr && f && /podman }} build/ { exit }
        f { sub(/^    /, ""); print }
    ' "${REPO_ROOT}/Justfile")"
    [[ "${out}" == 'SECRETS=()'* && "${out}" == *'SECRETS+=(--secret=id=github_token,env=GH_TOKEN)'* ]] || {
        echo "SECRETS block not found in Justfile recipe '${recipe}'" >&2
        return 1
    }
    [[ "${out}" != *'{{'* ]] || {
        echo "SECRETS block in recipe '${recipe}' contains a just interpolation" >&2
        return 1
    }
    printf '%s\n' "${out}"
}

# justfile_podman_build_line <recipe> — prints the `podman build` line of one recipe.
justfile_podman_build_line() {
    awk -v r="$1" '
        $0 ~ "^" r ":" { inr = 1; next }
        inr && /^[^ \t#]/ { exit }
        inr && /podman }} build / { print; exit }
    ' "${REPO_ROOT}/Justfile"
}

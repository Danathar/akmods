#!/usr/bin/env bats
# T3 — the GitHub token's path from the host into the ZFS build container:
#   Justfile `build`/`test`  ->  podman build --secret=id=github_token,env=...
#   Containerfile.in         ->  RUN --mount=type=secret,id=github_token
#   build-kmod-zfs.sh        ->  reads /run/secrets/github_token
# Inside the container GITHUB_TOKEN/GH_TOKEN are not set, so the secret file is
# the only way the token reaches the OpenZFS release lookup in a real build.
# zfs_release_discovery.bats covers the env-var path; this file covers the rest.

load helpers

setup() {
    unset GITHUB_TOKEN GH_TOKEN
}

# run_secrets_block <recipe> [bash-flags...] — runs the recipe's SECRETS block
# and prints the resulting array, one element per line, after a marker line.
run_secrets_block() {
    local recipe="$1"
    shift
    local snippet="${BATS_TEST_TMPDIR}/secrets-${recipe}.sh"
    {
        printf 'set -euo pipefail\n'
        extract_justfile_secrets "${recipe}"
        cat <<'SH'
echo "--- SECRETS (${#SECRETS[@]})"
for s in "${SECRETS[@]}"; do printf '%s\n' "$s"; done
SH
    } >"${snippet}" || return 1
    run bash "$@" "${snippet}"
}

# Like run_zfs_discovery, but /run/secrets/github_token is redirected to a file
# under $BATS_TEST_TMPDIR. The test for the literal path is separate (below).
run_zfs_discovery_with_secret_dir() {
    local snippet="${BATS_TEST_TMPDIR}/discovery.sh" body
    body="$(extract_zfs_discovery)" || return 1
    [[ "${body}" == *'/run/secrets/github_token'* ]] || {
        echo "build-kmod-zfs.sh no longer reads /run/secrets/github_token" >&2
        return 1
    }
    {
        printf 'set -euo pipefail\n'
        printf 'ZFS_MINOR_VERSION=2.4\nZFS_CONFIGURE_ARGS=\n'
        printf '%s\n' "${body//\/run\/secrets\/github_token/${BATS_TEST_TMPDIR}/run/secrets/github_token}"
        cat <<'SH'
if [[ -n "${github_token+x}" || -n "${curl_args+x}" ]]; then echo "TOKEN VARIABLES STILL SET"; fi
SH
    } >"${snippet}"
    mkdir -p "${BATS_TEST_TMPDIR}/cwd"
    cd "${BATS_TEST_TMPDIR}/cwd" || return 1
    run bash "$@" "${snippet}"
}

write_secret_file() {
    mkdir -p "${BATS_TEST_TMPDIR}/run/secrets"
    printf '%s' "$1" >"${BATS_TEST_TMPDIR}/run/secrets/github_token"
}

# --- Justfile: which env var becomes the podman secret -------------------------

# covers: T3
@test "T3: Justfile build/test pass GITHUB_TOKEN as the github_token secret" {
    export GITHUB_TOKEN=tok
    for recipe in build test; do
        run_secrets_block "${recipe}"
        [ "${status}" -eq 0 ]
        [ "${lines[0]}" = "--- SECRETS (1)" ]
        [ "${lines[1]}" = "--secret=id=github_token,env=GITHUB_TOKEN" ]
    done
}

# covers: T3
@test "T3: Justfile build/test fall back to GH_TOKEN" {
    export GH_TOKEN=tok
    for recipe in build test; do
        run_secrets_block "${recipe}"
        [ "${status}" -eq 0 ]
        [ "${lines[0]}" = "--- SECRETS (1)" ]
        [ "${lines[1]}" = "--secret=id=github_token,env=GH_TOKEN" ]
    done
}

# covers: T3
@test "T3: Justfile build/test prefer GITHUB_TOKEN over GH_TOKEN" {
    export GITHUB_TOKEN=primary GH_TOKEN=secondary
    for recipe in build test; do
        run_secrets_block "${recipe}"
        [ "${status}" -eq 0 ]
        [ "${lines[0]}" = "--- SECRETS (1)" ]
        [ "${lines[1]}" = "--secret=id=github_token,env=GITHUB_TOKEN" ]
    done
}

# covers: T3
@test "T3: Justfile build/test pass no secret without a token" {
    for recipe in build test; do
        run_secrets_block "${recipe}"
        [ "${status}" -eq 0 ]
        [ "${lines[0]}" = "--- SECRETS (0)" ]
    done
}

# covers: T3
@test "T3: Justfile build/test keep the token out of xtrace (CI runs them under set -x)" {
    export GITHUB_TOKEN=very-secret-token-value GH_TOKEN=other-secret-token-value
    for recipe in build test; do
        run_secrets_block "${recipe}" -x
        [ "${status}" -eq 0 ]
        [[ "${output}" != *very-secret-token-value* ]]
        [[ "${output}" != *other-secret-token-value* ]]
        # Tracing was on before the guard and came back on after it.
        [[ "${output}" == *"+ set +x"* ]]
        [[ "${output}" == *"+ echo '--- SECRETS (1)'"* ]]
    done
}

# covers: T3
@test "T3: Justfile build/test hand SECRETS to podman build" {
    for recipe in build test; do
        run justfile_podman_build_line "${recipe}"
        [ "${status}" -eq 0 ]
        [ -n "${output}" ]
        # shellcheck disable=SC2016 # matching the literal Justfile text
        [[ "${output}" == *'"${SECRETS[@]}"'* ]]
    done
}

# --- the secret id and path agree across the three files ----------------------

# covers: T3
@test "T3: secret id is github_token in the Justfile, the Containerfile mount and the script path" {
    run grep -o -E -- '--secret=id=[^,]+,env=(GITHUB_TOKEN|GH_TOKEN)' "${REPO_ROOT}/Justfile"
    [ "${status}" -eq 0 ]
    [ "${#lines[@]}" -eq 4 ]
    for line in "${lines[@]}"; do
        [[ "${line}" == '--secret=id=github_token,env='* ]]
    done
    # The ZFS build step mounts it at the default path (/run/secrets/<id>):
    # no target=/dst= override.
    run grep -E -- '--mount=type=secret' "${REPO_ROOT}/Containerfile.in"
    [ "${status}" -eq 0 ]
    [ "${#lines[@]}" -eq 1 ]
    [[ "${output}" =~ --mount=type=secret,id=github_token[[:space:]]*\\$ ]]
    run grep -c -F -- '-r /run/secrets/github_token' "${REPO_ROOT}/build_files/zfs/build-kmod-zfs.sh"
    [ "${output}" = "1" ]
}

# covers: T3
@test "T3: the secret mount is on the RUN step that runs build-kmod-zfs.sh" {
    run awk '/^RUN /{step = ""} {step = step $0 "\n"} /^\/tmp\/build-kmod-zfs\.sh$/{printf "%s", step; exit}' "${REPO_ROOT}/Containerfile.in"
    [ "${status}" -eq 0 ]
    [[ "${output}" == *"--mount=type=secret,id=github_token"* ]]
}

# --- build-kmod-zfs.sh: the in-container secret file ---------------------------

# covers: T3
@test "T3: discovery reads the token from /run/secrets/github_token when no env token is set" {
    make_curl_stub "${REPO_ROOT}/tests/fixtures/zfs-releases.json"
    write_secret_file from-secret-file
    run_zfs_discovery_with_secret_dir
    [ "${status}" -eq 0 ]
    [[ "${output}" == *"ZFS_VERSION==2.4.3"* ]]
    grep -qx 'Authorization: Bearer from-secret-file' "${BATS_TEST_TMPDIR}/curl.args"
}

# covers: T3
@test "T3: an env token wins over the secret file" {
    make_curl_stub "${REPO_ROOT}/tests/fixtures/zfs-releases.json"
    write_secret_file from-secret-file
    export GH_TOKEN=from-env
    run_zfs_discovery_with_secret_dir
    [ "${status}" -eq 0 ]
    grep -qx 'Authorization: Bearer from-env' "${BATS_TEST_TMPDIR}/curl.args"
    run grep -c 'from-secret-file' "${BATS_TEST_TMPDIR}/curl.args"
    [ "${output}" = "0" ]
}

# covers: T3
@test "T3: the secret-file token stays out of xtrace and the token variables are unset afterwards" {
    make_curl_stub "${REPO_ROOT}/tests/fixtures/zfs-releases.json"
    write_secret_file very-secret-file-token
    run_zfs_discovery_with_secret_dir -x
    [ "${status}" -eq 0 ]
    [[ "${output}" != *very-secret-file-token* ]]
    [[ "${output}" != *"TOKEN VARIABLES STILL SET"* ]]
    grep -qx 'Authorization: Bearer very-secret-file-token' "${BATS_TEST_TMPDIR}/curl.args"
}

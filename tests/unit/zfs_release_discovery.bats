#!/usr/bin/env bats
# T3 — hardened OpenZFS release discovery in build_files/zfs/build-kmod-zfs.sh.
# Only the discovery section is extracted and run (never the dnf/gpg/build
# parts), against a stub `curl` — no network, nothing outside $BATS_TEST_TMPDIR.

load helpers

setup() {
    require_tools jq
    unset GITHUB_TOKEN GH_TOKEN
}

# covers: T3
@test "T3: discovery section can be extracted from the build script" {
    run extract_zfs_discovery
    [ "${status}" -eq 0 ]
    [[ "${output}" == *'api.github.com/repos/openzfs/zfs/releases'* ]]
}

# covers: T3
@test "T3: picks the newest stable release matching zfs-<minor>" {
    make_curl_stub "${REPO_ROOT}/tests/fixtures/zfs-releases.json"
    run_zfs_discovery
    [ "${status}" -eq 0 ]
    [[ "${output}" == *"ZFS_VERSION==2.4.3"* ]]
}

# covers: T3
@test "T3: skips drafts and prereleases" {
    make_curl_stub "${REPO_ROOT}/tests/fixtures/zfs-releases.json"
    ZFS_TEST_MINOR=2.5 run_zfs_discovery
    [ "${status}" -eq 1 ]
    [[ "${output}" == *"No non-draft, non-prerelease OpenZFS release found for zfs-2.5."* ]]
}

# covers: T3
@test "T3: sends no Authorization header without a token" {
    make_curl_stub "${REPO_ROOT}/tests/fixtures/zfs-releases.json"
    run_zfs_discovery
    [ "${status}" -eq 0 ]
    run grep -ci 'authorization' "${BATS_TEST_TMPDIR}/curl.args"
    [ "${output}" = "0" ]
}

# covers: T3
@test "T3: sends Authorization: Bearer when GITHUB_TOKEN is set" {
    make_curl_stub "${REPO_ROOT}/tests/fixtures/zfs-releases.json"
    export GITHUB_TOKEN=test-token-github
    run_zfs_discovery
    [ "${status}" -eq 0 ]
    grep -qx 'Authorization: Bearer test-token-github' "${BATS_TEST_TMPDIR}/curl.args"
}

# covers: T3
@test "T3: falls back to GH_TOKEN" {
    make_curl_stub "${REPO_ROOT}/tests/fixtures/zfs-releases.json"
    export GH_TOKEN=test-token-gh
    run_zfs_discovery
    [ "${status}" -eq 0 ]
    grep -qx 'Authorization: Bearer test-token-gh' "${BATS_TEST_TMPDIR}/curl.args"
}

# covers: T3
@test "T3: GITHUB_TOKEN wins over GH_TOKEN" {
    make_curl_stub "${REPO_ROOT}/tests/fixtures/zfs-releases.json"
    export GITHUB_TOKEN=primary GH_TOKEN=secondary
    run_zfs_discovery
    grep -qx 'Authorization: Bearer primary' "${BATS_TEST_TMPDIR}/curl.args"
}

# covers: T3
@test "T3: fails fast on HTTP errors (curl -f)" {
    make_curl_stub -
    run_zfs_discovery
    [ "${status}" -ne 0 ]
    grep -qx -- '-fsSL' "${BATS_TEST_TMPDIR}/curl.args"
}

# covers: T3
@test "T3: xtrace is off while the token is handled and restored afterwards" {
    make_curl_stub "${REPO_ROOT}/tests/fixtures/zfs-releases.json"
    export GITHUB_TOKEN=very-secret-token-value
    run_zfs_discovery -x
    [ "${status}" -eq 0 ]
    # bats `run` merges stderr (xtrace output) into $output.
    [[ "${output}" != *very-secret-token-value* ]]
    # Tracing came back on after the guarded region (the jq validation is traced).
    [[ "${output}" == *"+ jq -e"* ]]
    # ...and was genuinely on before it (the set +x line itself is traced).
    [[ "${output}" == *"+ set +x"* ]]
}

# covers: T3
@test "T3: a non-array JSON body (rate-limit object) fails loudly and prints the body" {
    make_curl_stub "${REPO_ROOT}/tests/fixtures/zfs-rate-limit.json"
    run_zfs_discovery
    [ "${status}" -eq 1 ]
    [[ "${output}" == *"was not a JSON array"* ]]
    [[ "${output}" == *"API rate limit exceeded"* ]]
    [[ "${output}" != *"ZFS_VERSION=="* ]]
}

# covers: T3
@test "T3: no release matching zfs-<minor> fails loudly instead of an empty version" {
    make_curl_stub "${REPO_ROOT}/tests/fixtures/zfs-no-match.json"
    run_zfs_discovery
    [ "${status}" -eq 1 ]
    [[ "${output}" == *"No non-draft, non-prerelease OpenZFS release found for zfs-2.4."* ]]
    [[ "${output}" != *"ZFS_VERSION=="* ]]
}

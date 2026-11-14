#!/usr/bin/env bats
# shellcheck disable=SC2016 # single-quoted strings are literal Justfile text to match
# Kernel and module signing keys: the certs/production and certs/test key sets,
# the helpers that load and check them, and the kernel cache keyed on them.
# Upstream runs its own checks for these through `just test-signing-key` in the
# kernel cache workflow. This fork's build workflows are disabled, so these
# tests are the only thing that runs them on a pull request. They use the
# committed test keys only and write nothing outside a temp dir.

load helpers

setup() {
    require_tools openssl jq sha256sum
}

# Prints the body of one Justfile recipe: the lines after `<name>:` up to the
# next line that starts in column 0 (a comment, attribute or the next recipe).
recipe_body() {
    awk -v r="$1" '$0 ~ "^" r ":" { p = 1; next } p && /^[^[:space:]]/ { exit } p' "${REPO_ROOT}/Justfile"
}

@test "signing keys: test and production key lists, certificates and the compatibility copy agree" {
    run bash "${REPO_ROOT}/build_files/test/check-signing-key-test.sh"
    [ "${status}" -eq 0 ]
    [[ "${output}" == *'Signing key validation passed'* ]]
}

@test "signing keys: write-signing-keys refuses a missing or mismatched secret" {
    run bash "${REPO_ROOT}/build_files/test/write-signing-keys-test.sh"
    [ "${status}" -eq 0 ]
    [[ "${output}" == *'Signing key writer validation passed'* ]]
}

@test "signing keys: a module must carry a valid signature from every active key" {
    run bash "${REPO_ROOT}/build_files/test/check-module-signature-test.sh"
    [ "${status}" -eq 0 ]
    [[ "${output}" == *'Module signature validation passed'* ]]
}

@test "kernel cache: the checker accepts a matching cache and refuses a wrong or mixed one" {
    run bash "${REPO_ROOT}/build_files/test/check-kernel-cache-test.sh"
    [ "${status}" -eq 0 ]
    [[ "${output}" == *'Kernel cache validation passed'* ]]
}

@test "kernel cache: test-signing-key runs all four checks" {
    run recipe_body test-signing-key
    [ "${status}" -eq 0 ]
    local t
    for t in check-signing-key-test check-kernel-cache-test check-module-signature-test write-signing-keys-test; do
        [[ "${output}" == *"bash build_files/test/${t}.sh"* ]]
    done
}

@test "kernel cache: fetch-kernel reuses cached RPMs only for the same signing keys and kernel release" {
    run recipe_body fetch-kernel
    [ "${status}" -eq 0 ]
    [[ "${output}" == *'digest=$(signing_key_digest certs "$mode")'* ]]
    [[ "${output}" == *'bash build_files/test/check-kernel-cache.sh "{{ KCPATH }}"'* ]]
    [[ "${output}" == *'rm -f "{{ KCPATH }}"/*.rpm "$stamp"'* ]]
    [[ "${output}" == *'printf '"'"'%s\n'"'"' "$expected" > "$stamp"'* ]]
    # The old check skipped the fetch when one file name existed.
    [[ "${output}" != *"'exit 0' } else"* ]]
    [[ "${output}" != *'DUAL_SIGN'* ]]
}

@test "kernel cache: build and test pass the signing mode and mount the cache with the SELinux relabel option" {
    local r
    for r in build test; do
        run recipe_body "${r}"
        [ "${status}" -eq 0 ]
        [[ "${output}" == *"--cpp-flag=-DKSIGN_MODE_ARG=KSIGN_MODE={{ env('KSIGN_MODE', 'test') }}"* ]]
        [[ "${output}" == *'--volume {{ KCPATH }}:/tmp/kernel_cache:ro,z "'* ]]
        [[ "${output}" != *'/tmp/kernel_cache:ro "'* ]]
    done
}

# load_signing_keys is the one place a key list is read. Production builds sign
# with whatever it returns, and write-signing-keys.sh expands each ID it returns
# as a variable name and a file name, so each refusal below keeps a bad list
# from reaching either. Upstream's helper tests only feed it the committed lists.
# Prints the IDs and directory it loaded, or its error, for one key-list dir.
load_keys() {
    bash -c 'source "$1/build_files/prep/check-signing-key.sh" && load_signing_keys "$2" "$3" && echo "ids=${KSIGN_IDS[*]} dir=$KSIGN_DIR"' \
        _ "${REPO_ROOT}" "$1" "$2"
}

# Writes a key list for mode $1 under a scratch cert dir and prints that dir.
key_list() {
    local dir="${BATS_TEST_TMPDIR}/certs"
    mkdir -p "${dir}/$1"
    printf '%b' "$2" > "${dir}/$1/signing-keys"
    echo "${dir}"
}

@test "signing keys: an unknown signing mode is refused, never read as the test keys" {
    local mode
    for mode in prod Production '' test/../production; do
        run load_keys "${REPO_ROOT}/certs" "${mode}"
        [ "${status}" -eq 1 ]
        [[ "${output}" == *"Unknown signing mode: ${mode}"* ]]
        [[ "${output}" != *'ids='* ]]
    done
}

@test "signing keys: an empty or missing key list is refused" {
    local dir
    dir=$(key_list production '')
    run load_keys "${dir}" production
    [ "${status}" -eq 1 ]
    [[ "${output}" == *"Empty or missing key list: ${dir}/production/signing-keys"* ]]
    run load_keys "${dir}" test
    [ "${status}" -eq 1 ]
    [[ "${output}" == *"Empty or missing key list: ${dir}/test/signing-keys"* ]]
}

@test "signing keys: a key ID that is not KSIGN_ plus capitals, digits and underscores is refused" {
    local id dir
    # Each would otherwise become a variable name for write-signing-keys.sh's
    # indirect expansion and part of a file path under the key directory.
    for id in ksign_test_a KSIGN_test_a KSIGN_ KSIGN_TEST-A '../KSIGN_TEST_A' 'KSIGN_A/../B' 'KSIGN_A B' 'x[$(id)]' ' KSIGN_TEST_A' 'KSIGN_TEST_A '; do
        dir=$(key_list production "KSIGN_TEST_B\n${id}\n")
        run load_keys "${dir}" production
        [ "${status}" -eq 1 ]
        [[ "${output}" == *"Invalid signing key ID: ${id}"* ]]
        [[ "${output}" != *'ids='* ]]
    done
}

@test "signing keys: a key ID listed twice is refused" {
    local dir
    dir=$(key_list production 'KSIGN_TEST_A\nKSIGN_TEST_B\nKSIGN_TEST_A\n')
    run load_keys "${dir}" production
    [ "${status}" -eq 1 ]
    [[ "${output}" == *'Duplicate signing key ID: KSIGN_TEST_A'* ]]
    # An ID contained in an earlier, longer one is not a duplicate.
    dir=$(key_list production 'KSIGN_TEST_AB\nKSIGN_TEST_A\n')
    run load_keys "${dir}" production
    [ "${status}" -eq 0 ]
    [[ "${output}" == *"ids=KSIGN_TEST_AB KSIGN_TEST_A dir=${dir}/production"* ]]
}

@test "signing keys: the last key ID is read even without a trailing newline" {
    local dir
    dir=$(key_list production 'KSIGN_TEST_A\nKSIGN_TEST_B')
    run load_keys "${dir}" production
    [ "${status}" -eq 0 ]
    [[ "${output}" == *"ids=KSIGN_TEST_A KSIGN_TEST_B dir=${dir}/production"* ]]
}

@test "signing keys: a key with no certificate beside it is refused" {
    run bash -c 'source "$1/build_files/prep/check-signing-key.sh" && check_signing_key "$2" "$3"' \
        _ "${REPO_ROOT}" "${REPO_ROOT}/certs/test/KSIGN_TEST_A.key" "${BATS_TEST_TMPDIR}/absent.der"
    [ "${status}" -eq 1 ]
    [[ "${output}" == *"Missing signing key or certificate: ${REPO_ROOT}/certs/test/KSIGN_TEST_A.key ${BATS_TEST_TMPDIR}/absent.der"* ]]
}

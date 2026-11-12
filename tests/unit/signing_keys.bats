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

#!/usr/bin/env bats
# Every build script Containerfile.in runs directly (a line that starts with
# /tmp/<name>.sh) must reach the image as an executable file. The extra kmods
# run as `/tmp/build-kmod-X.sh || echo "SKIPPED: X"`, so a script that lost its
# exec bit, or one that was renamed or moved while the Containerfile still names
# the old path, fails with "Permission denied" / "No such file" and the build
# carries on without that kmod. The upstream move of build-kmod-vhba.sh to
# build_files/extra did exactly that (100755 -> 100644, fixed in #219). This
# fork's workflows build no images and the e2e suite does no container build,
# so nothing else would notice before a consumer's image shipped without it.

load helpers

CONTAINERFILE="${REPO_ROOT}/Containerfile.in"

# Prints the basename of every script Containerfile.in runs as a command:
# lines whose first word is /tmp/<name>.sh. `install ... /tmp/x.sh` and other
# lines that only mention a path are not commands and are left out.
run_scripts() {
    sed -nE 's|^[[:space:]]*/tmp/([A-Za-z0-9_.-]+\.sh)([[:space:]].*)?$|\1|p' "${CONTAINERFILE}" | sort -u
}

# Prints every build_files source that a `COPY build_files/... /tmp/` places
# straight into /tmp: each file of a copied directory, or a copied file.
copied_sources() {
    local src
    sed -nE 's|^COPY (build_files/[^[:space:]]+) /tmp/$|\1|p' "${CONTAINERFILE}" | while read -r src; do
        if [[ -d "${REPO_ROOT}/${src}" ]]; then
            find "${REPO_ROOT}/${src}" -mindepth 1 -maxdepth 1 -type f -printf "${src%/}/%f\n"
        else
            printf '%s\n' "${src}"
        fi
    done | sort -u
}

@test "Containerfile.in: the script list is read (the parser is not vacuous)" {
    run run_scripts
    [ "${status}" -eq 0 ]
    [[ "${output}" == *"build-kmod-vhba.sh"* ]]
    [[ "${output}" == *"build-kmod-zfs.sh"* ]]
    [[ "${output}" == *"check-signatures.sh"* ]] || true # CMD [...] form, not a shell line
    [ "$(printf '%s\n' "${output}" | wc -l)" -ge 20 ]
    run copied_sources
    [ "${status}" -eq 0 ]
    [[ "${output}" == *"build_files/extra/build-kmod-vhba.sh"* ]]
    [[ "${output}" == *"build_files/test/test-prep.sh"* ]]
}

@test "Containerfile.in: every script it runs is copied into /tmp from build_files" {
    local sources script missing=()
    sources="$(copied_sources)"
    while read -r script; do
        grep -qE "/${script//./\\.}\$" <<<"${sources}" || missing+=("${script}")
    done < <(run_scripts)
    if ((${#missing[@]})); then
        printf 'run by Containerfile.in but no COPY build_files/... /tmp/ provides it: %s\n' "${missing[@]}"
        return 1
    fi
}

@test "Containerfile.in: every script it runs is executable in the checkout" {
    local sources script src not_exec=()
    sources="$(copied_sources)"
    while read -r script; do
        while read -r src; do
            [[ -n "${src}" ]] || continue
            [[ -x "${REPO_ROOT}/${src}" ]] || not_exec+=("${src}")
        done < <(grep -E "/${script//./\\.}\$" <<<"${sources}")
    done < <(run_scripts)
    if ((${#not_exec[@]})); then
        printf 'not executable (chmod +x, git update-index --chmod=+x): %s\n' "${not_exec[@]}"
        return 1
    fi
}

@test "Containerfile.in: the exec CMD script is executable too" {
    local cmd
    cmd="$(sed -nE 's|^CMD \["/tmp/([A-Za-z0-9_.-]+\.sh)"\]$|\1|p' "${CONTAINERFILE}")"
    [ "${cmd}" = "check-signatures.sh" ]
    [ -x "${REPO_ROOT}/build_files/test/${cmd}" ]
}

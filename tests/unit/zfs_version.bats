#!/usr/bin/env bats
# shellcheck disable=SC2016 # single-quoted strings are literal Justfile/script text to match
# The OpenZFS release a ZFS akmod is built from, end to end:
#   images.yaml `zfs.<flavor>.version` (or `zfs.default.version`)
#     -> Justfile `zfs_version` (ZFS_VERSION env wins)
#     -> `build`/`test` recipes pass it to the Containerfile as ZFS_VERSION
#     -> build-kmod-zfs.sh accepts only a full X.Y.Z and downloads that release.
# Upstream's sync of 2026-10-24 replaced the release lookup that T3 hardened
# (and zfs_release_discovery.bats tested) with this pin. This fork's workflows
# build no images and the e2e suite evaluates names, not zfs_version, so
# without these tests a flavor silently building the wrong release, or a pin
# the build script refuses, would first show up in a consumer's build.

load helpers

setup() {
    require_tools yq jq
    require_tools "${JUST_BIN}"
    make_scratch_repo
}

# Prints the version check at the top of build-kmod-zfs.sh: from the
# ZFS_VERSION default through the first `fi` after it.
extract_zfs_version_check() {
    local out
    out="$(awk '
        /^ZFS_VERSION="\$\{ZFS_VERSION:-\}"$/ { f = 1 }
        f { print }
        f && /^fi$/ { exit }
    ' "${REPO_ROOT}/build_files/zfs/build-kmod-zfs.sh")"
    [[ "${out}" == 'ZFS_VERSION='* && "${out}" == *'exit 1'* && "${out}" == *$'\nfi' ]] || {
        echo "ZFS_VERSION check not found in build-kmod-zfs.sh" >&2
        return 1
    }
    printf '%s\n' "${out}"
}

# run_zfs_version_check <value> — runs the check with ZFS_VERSION=<value>,
# then prints a marker line if the check let it through.
run_zfs_version_check() {
    local snippet="${BATS_TEST_TMPDIR}/version-check.sh"
    {
        printf 'set -euo pipefail\n'
        extract_zfs_version_check
        printf 'echo "accepted ${ZFS_VERSION}"\n'
    } >"${snippet}" || return 1
    ZFS_VERSION="$1" run bash "${snippet}"
}

# --- Justfile: images.yaml -> zfs_version ---------------------------------------

@test "every flavor in images.yaml resolves to a ZFS version the build script accepts" {
    local flavors flavor version count=0
    flavors="$(yq -r '[.images.*| keys | .[]] | unique | .[]' "${WORK}/images.yaml")"
    [ -n "${flavors}" ]
    for flavor in ${flavors}; do
        version="$(AKMODS_KERNEL="${flavor}" just_eval zfs_version)"
        run_zfs_version_check "${version}"
        [ "${status}" -eq 0 ] || { echo "${flavor}: '${version}' refused: ${output}" >&2; return 1; }
        [ "${output}" = "accepted ${version}" ]
        count=$((count + 1))
    done
    [ "${count}" -ge 4 ]
}

@test "a flavor's own zfs version wins over zfs.default" {
    [ "$(yq '.zfs."coreos-testing" | has("version")' "${WORK}/images.yaml")" = "true" ]
    yq -i '.zfs.default.version = "9.9.1" | .zfs."coreos-testing".version = "9.9.2"' "${WORK}/images.yaml"
    AKMODS_KERNEL=coreos-testing run just_eval zfs_version
    [ "${status}" -eq 0 ]
    [ "${output}" = "9.9.2" ]
}

@test "a flavor block without a version (main) follows zfs.default" {
    [ "$(yq '.zfs.main | has("version")' "${WORK}/images.yaml")" = "false" ]
    yq -i '.zfs.default.version = "9.9.1"' "${WORK}/images.yaml"
    AKMODS_KERNEL=main run just_eval zfs_version
    [ "${status}" -eq 0 ]
    [ "${output}" = "9.9.1" ]
}

@test "a flavor with no zfs block follows zfs.default" {
    [ "$(yq '.zfs | has("coreos-stable")' "${WORK}/images.yaml")" = "false" ]
    yq -i '.zfs.default.version = "9.9.1"' "${WORK}/images.yaml"
    AKMODS_KERNEL=coreos-stable run just_eval zfs_version
    [ "${status}" -eq 0 ]
    [ "${output}" = "9.9.1" ]
}

@test "ZFS_VERSION in the environment overrides images.yaml" {
    AKMODS_KERNEL=coreos-testing ZFS_VERSION=9.9.3 run just_eval zfs_version
    [ "${status}" -eq 0 ]
    [ "${output}" = "9.9.3" ]
}

@test "with no version anywhere, the build script refuses what the Justfile resolves" {
    yq -i 'del(.zfs.default.version)' "${WORK}/images.yaml"
    local version
    version="$(AKMODS_KERNEL=main just_eval zfs_version)"
    run_zfs_version_check "${version}"
    [ "${status}" -eq 1 ]
    [ "${output}" = "ZFS_VERSION must be a full X.Y.Z release (got '${version}')" ]
}

@test "build and test recipes both pass zfs_version to the Containerfile" {
    local recipe line
    for recipe in build test; do
        line="$(awk -v r="${recipe}" '
            $0 ~ "^" r ":" { inr = 1; next }
            inr && /^[^ \t#]/ { exit }
            inr && /ZFS_VERSION_ARG=/ { print; exit }
        ' "${REPO_ROOT}/Justfile")"
        [[ "${line}" == *'"--cpp-flag=-DZFS_VERSION_ARG=ZFS_VERSION={{ zfs_version }}"'* ]] || {
            echo "recipe '${recipe}' no longer passes zfs_version: '${line}'" >&2
            return 1
        }
    done
    run awk '/^#ifdef ZFS$/ { f = 1 } f && /^#endif/ { exit } f { print }' "${REPO_ROOT}/Containerfile.in"
    [[ "${output}" == *$'\nARG ZFS_VERSION_ARG\n'* || "${output}" == *$'\nARG ZFS_VERSION_ARG' ]]
}

# --- build-kmod-zfs.sh: which versions are allowed ------------------------------

@test "build-kmod-zfs.sh accepts a full X.Y.Z release" {
    local good
    for good in 2.4.4 10.0.12 0.0.0; do
        run_zfs_version_check "${good}"
        [ "${status}" -eq 0 ] || { echo "refused: '${good}'" >&2; return 1; }
        [ "${output}" = "accepted ${good}" ]
    done
}

@test "build-kmod-zfs.sh refuses anything but a full X.Y.Z release" {
    local bad
    for bad in "" "null" "2.4" "2" "2-4-4" "2x4x4" "v2.4.4" "zfs-2.4.4" "2.4.4-rc1" "2.4.4.1" "2.4.x" " 2.4.4" "2.4.4 " \
        "2.4.4;true" "2.4.4/../x" $'2.4.4\n2.4.5'; do
        run_zfs_version_check "${bad}"
        [ "${status}" -eq 1 ] || { echo "accepted: '${bad}'" >&2; return 1; }
        [ "${output}" = "ZFS_VERSION must be a full X.Y.Z release (got '${bad}')" ]
    done
}

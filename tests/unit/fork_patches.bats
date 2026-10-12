#!/usr/bin/env bats
# Pins the load-bearing differences between this fork and ublue-os/akmods
# (see FORK-PATCHES.md). If an upstream merge reverts one of them, the matching
# test fails. Each test carries a `# covers: <patch id>` tag that
# scripts/coverage-gate.mjs reads, so every testable patch must be listed.

load helpers

setup() {
    require_tools yq jq
    require_tools "${JUST_BIN}"
    make_scratch_repo
}

# covers: P1
@test "P1: akmods-base anchor publishes into org danathar" {
    run yq '.akmods-base.org' "${REPO_ROOT}/images.yaml"
    [ "${status}" -eq 0 ]
    [ "${output}" = "danathar" ]
}

# covers: P1
@test "P1: no image resolves to the upstream ublue-os org" {
    run yq -r '[explode(.).images.*.*.* | select(tag == "!!map") | .org] | unique | join(",")' "${REPO_ROOT}/images.yaml"
    [ "${status}" -eq 0 ]
    [ "${output}" = "danathar" ]
}

# covers: P2
@test "P2: akmods_name resolves from images.yaml .name for the default target" {
    run just_eval akmods_name
    [ "${status}" -eq 0 ]
    [ "${output}" = "akmods" ]
}

# covers: P2
@test "P2: akmods_name follows an images.yaml .name edit (zfs-aurora-complex's rewrite path)" {
    yq -i '.images."44".main.common.name = "zfs-aurora-complex-akmods"' "${WORK}/images.yaml"
    run just_eval akmods_name
    [ "${status}" -eq 0 ]
    [ "${output}" = "zfs-aurora-complex-akmods" ]
}

# covers: P2
@test "P2: akmods_name is not derived from the target name" {
    export AKMODS_KERNEL=coreos-stable AKMODS_TARGET=zfs
    run just_eval akmods_name
    [ "${status}" -eq 0 ]
    [ "${output}" = "$(yq '.images."44"."coreos-stable".zfs.name' "${WORK}/images.yaml")" ]
    yq -i '.images."44"."coreos-stable".zfs.name = "renamed-by-config"' "${WORK}/images.yaml"
    run just_eval akmods_name
    [ "${output}" = "renamed-by-config" ]
}

# covers: P2
@test "P2: AKMODS_IMAGE_NAME overrides the images.yaml name" {
    export AKMODS_IMAGE_NAME=override-from-env
    run just_eval akmods_name
    [ "${status}" -eq 0 ]
    [ "${output}" = "override-from-env" ]
}

# covers: P2
@test "P2: Justfile still reads .name and honours AKMODS_IMAGE_NAME in source" {
    run grep -F "akmods_name := env('AKMODS_IMAGE_NAME'," "${REPO_ROOT}/Justfile"
    [ "${status}" -eq 0 ]
    [[ "${output}" == *'.name'* ]]
}

# covers: P2
@test "P2: the published image path is registry/org/name from images.yaml" {
    run just_eval registry
    [ "${status}" -eq 0 ]
    [ "${output}" = "ghcr.io" ]
    run just_eval _org
    [ "${output}" = "danathar" ]
}

# covers: T1
@test "T1: zfs.main.linux_experimental is exactly false" {
    run yq '.zfs.main.linux_experimental' "${REPO_ROOT}/images.yaml"
    [ "${status}" -eq 0 ]
    [ "${output}" = "false" ]
}

# covers: T1
@test "T1: no zfs block enables linux_experimental" {
    run yq '[.zfs.* | .linux_experimental] | map(select(. == true)) | length' "${REPO_ROOT}/images.yaml"
    [ "${status}" -eq 0 ]
    [ "${output}" = "0" ]
}

# covers: T1
@test "T1: main flavor builds pass no --enable-linux-experimental" {
    export AKMODS_KERNEL=main
    run just_eval zfs_configure_args
    [ "${status}" -eq 0 ]
    [ -z "${output}" ]
}

# covers: T6
@test "T6: git is in the unconditional RPMS_TO_INSTALL block" {
    run awk '/^RPMS_TO_INSTALL\+=\($/{f=1;next} f&&/^\)$/{exit} f{print $1}' "${REPO_ROOT}/build_files/prep/build-prep.sh"
    [ "${status}" -eq 0 ]
    [[ "${output}" == *$'\ngit'* || "${output}" == git* ]]
}

# covers: T4
@test "T4: python3-cffi is in the unconditional RPMS_TO_INSTALL block" {
    run awk '/^RPMS_TO_INSTALL\+=\($/{f=1;next} f&&/^\)$/{exit} f{print $1}' "${REPO_ROOT}/build_files/prep/build-prep.sh"
    [ "${status}" -eq 0 ]
    [[ "${output}" == *python3-cffi* ]]
}

# covers: T5
@test "T5: the ZFS build installs jq before parsing release JSON" {
    run grep -n -E '^dnf install -y jq$|jq -' "${REPO_ROOT}/build_files/zfs/build-kmod-zfs.sh"
    [ "${status}" -eq 0 ]
    [[ "${lines[0]}" == *"dnf install -y jq" ]]
}

# covers: T3
@test "T3: Justfile and Containerfile.in still plumb the github_token secret" {
    run grep -c 'github_token' "${REPO_ROOT}/Justfile"
    [ "${status}" -eq 0 ]
    [ "${output}" -ge 2 ]
    run grep -F 'id=github_token' "${REPO_ROOT}/Containerfile.in"
    [ "${status}" -eq 0 ]
}

# covers: P4
@test "P4: scorecard workflow and summary script exist" {
    [ -f "${REPO_ROOT}/.github/workflows/scorecard.yml" ]
    [ -f "${REPO_ROOT}/.github/scripts/scorecard-summary.sh" ]
}

# covers: P6
@test "P6: images.yaml defines no nvidia targets and no ogc kernel flavors" {
    run yq -r '[explode(.).images.*.* | keys | .[]] | unique | join(",")' "${REPO_ROOT}/images.yaml"
    [ "${status}" -eq 0 ]
    [[ "${output}" != *nvidia* ]]
    run yq -r '[.images.* | keys | .[]] | unique | join(",")' "${REPO_ROOT}/images.yaml"
    [ "${status}" -eq 0 ]
    [[ "${output}" != *ogc* ]]
}

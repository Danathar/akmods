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

# covers: T7
@test "T7: OpenZFS signing keys are imported from the pinned repo file, never fetched from a keyserver" {
    [ -f "${REPO_ROOT}/build_files/zfs/openzfs-release-keys.asc" ]
    run grep -cF -- 'gpg --batch --import /tmp/openzfs-release-keys.asc' "${REPO_ROOT}/build_files/zfs/build-kmod-zfs.sh"
    [ "${status}" -eq 0 ]
    [ "${output}" -eq 1 ]
    run grep -E -- '--recv(-keys)?' "${REPO_ROOT}/build_files/zfs/build-kmod-zfs.sh"
    [ "${status}" -eq 1 ]
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

# Runs build-prep.sh's RPMFUSION_MIRROR block against a scratch root, with the
# absolute paths it names redirected into ${BATS_TEST_TMPDIR}/root.
run_mirror_block() {
    local block
    block="$(awk '/^if \[\[ -n "\$\{RPMFUSION_MIRROR\}"/{f=1} f{print} f&&/^fi$/{exit}' "${REPO_ROOT}/build_files/prep/build-prep.sh")"
    [ -n "${block}" ]
    block="${block//\/etc\//${BATS_TEST_TMPDIR}/root/etc/}"
    block="${block//\/usr\/share\//${BATS_TEST_TMPDIR}/root/usr/share/}"
    RPMFUSION_MIRROR="https://mirror.example/rpmfusion" run bash -euo pipefail -c "${block}"
}

# covers: T8
@test "T8: RPMFUSION_MIRROR rewrites repo files under /usr/share/dnf5/repos.d (Fedora 45+)" {
    local dir="${BATS_TEST_TMPDIR}/root/usr/share/dnf5/repos.d"
    mkdir -p "${dir}" "${BATS_TEST_TMPDIR}/root/etc"
    touch "${BATS_TEST_TMPDIR}/root/etc/fedora-release"
    printf 'metalink=https://m\n#baseurl=http://download1.rpmfusion.org/free\n' > "${dir}/rpmfusion-free.repo"
    run_mirror_block
    [ "${status}" -eq 0 ]
    run cat "${dir}/rpmfusion-free.repo"
    [[ "${output}" == *'#metalink=https://m'* ]]
    [[ "${output}" == *'baseurl=https://mirror.example/rpmfusion/free'* ]]
}

# covers: T8
@test "T8: RPMFUSION_MIRROR still rewrites repo files under /etc/yum.repos.d (Fedora 43, 44)" {
    local dir="${BATS_TEST_TMPDIR}/root/etc/yum.repos.d"
    mkdir -p "${dir}"
    touch "${BATS_TEST_TMPDIR}/root/etc/fedora-release"
    printf 'metalink=https://m\n#baseurl=http://download1.rpmfusion.org/free\n' > "${dir}/rpmfusion-free.repo"
    run_mirror_block
    [ "${status}" -eq 0 ]
    run cat "${dir}/rpmfusion-free.repo"
    [[ "${output}" == *'baseurl=https://mirror.example/rpmfusion/free'* ]]
}

# covers: T8
@test "T8: RPMFUSION_MIRROR fails with a clear message when no repo file exists" {
    mkdir -p "${BATS_TEST_TMPDIR}/root/etc"
    touch "${BATS_TEST_TMPDIR}/root/etc/fedora-release"
    run_mirror_block
    [ "${status}" -eq 1 ]
    [[ "${output}" == *'No rpmfusion repo files found'* ]]
}

# covers: T9
@test "T9: just login hands the registry token to podman on stdin, never in its arguments" {
    local log="${BATS_TEST_TMPDIR}/podman"
    # Replace the stub with one that records what podman would have received.
    cat >"${BATS_TEST_TMPDIR}/stubs/podman" <<STUB
#!/bin/sh
printf '%s\n' "\$*" >"${log}.argv"
cat >"${log}.stdin"
STUB
    cd "${WORK}" || return 1
    REGISTRY_ACTOR=fork-bot REGISTRY_TOKEN=not-a-real-token run "${JUST_BIN}" login
    [ "${status}" -eq 0 ]
    run cat "${log}.argv"
    [[ "${output}" == 'login '*' -u fork-bot --password-stdin' ]]
    [[ "${output}" != *not-a-real-token* ]]
    run cat "${log}.stdin"
    [ "${output}" = "not-a-real-token" ]
}

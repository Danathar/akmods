#!/usr/bin/env bash
# End-to-end checks for the fork, run inside a throwaway Fedora container (CI job
# `E2E (fedora container)`, image registry.fedoraproject.org/fedora).
#
# What it proves, with no kernel download and no akmod build:
#   1. the bats unit suite also passes on Fedora's bash/coreutils;
#   2. every version/flavor/target combination in images.yaml resolves through
#      the real Justfile (check_valid, org, registry, image name) and an invalid
#      combination is rejected;
#   3. `just generate-workflows` reproduces the committed build-akmods-*.yml
#      (modulo the random cron minute) and is deterministic.
#
# SAFETY: this script installs packages (dnf) and writes /usr/local/bin, so it
# refuses to run anywhere that is not a container. Do not bypass the guard on a
# workstation; run it with `podman run --rm -v "$PWD":/src:ro <fedora image>` if
# you want it locally. Everything else happens in a mktemp dir; the checkout is
# only read.
set -euo pipefail

E2E_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${E2E_DIR}/../.." && pwd)"
# shellcheck source=tests/e2e/lib.sh
source "${E2E_DIR}/lib.sh"

# --- guard -------------------------------------------------------------------
in_container=0
if [[ -f /.dockerenv || -f /run/.containerenv ]]; then
    in_container=1
fi
if [[ "${in_container}" != "1" ]]; then
    echo "REFUSING TO RUN: not inside a container (no /.dockerenv or /run/.containerenv)." >&2
    echo "This script runs dnf and writes /usr/local/bin; run it in the CI job or a throwaway Fedora container." >&2
    exit 2
fi
if [[ "$(id -u)" != "0" ]]; then
    echo "REFUSING TO RUN: must be root inside the container (needs to dnf install)." >&2
    exit 2
fi
if ! grep -qE '^ID=fedora$' /etc/os-release 2>/dev/null; then
    echo "REFUSING TO RUN: expected a Fedora container (ID=fedora in /etc/os-release)." >&2
    exit 2
fi

# --- setup -------------------------------------------------------------------
e2e_stage "Install tools"
dnf install -y -q jq git curl tar gzip gawk findutils diffutils bats
"${REPO_ROOT}/tests/install-tools.sh" /usr/local/bin
just --version
yq --version
e2e_endstage

SCRATCH="$(mktemp -d)"
trap 'rm -rf "${SCRATCH}"' EXIT

# The Justfile resolves `podman` at parse time; nothing here ever runs it.
mkdir -p "${SCRATCH}/stubs" "${SCRATCH}/build"
printf '#!/bin/sh\necho "stub podman invoked: $*" >&2\nexit 99\n' >"${SCRATCH}/stubs/podman"
chmod +x "${SCRATCH}/stubs/podman"
export PATH="${SCRATCH}/stubs:${PATH}"
export AKMODS_BUILDDIR="${SCRATCH}/build"
unset AKMODS_IMAGE_NAME AKMODS_KERNEL AKMODS_VERSION AKMODS_TARGET AKMODS_REGISTRY AKMODS_TRANSPORT ZFS_VERSION ZFS_CONFIGURE_ARGS

# Scratch copy so recipes that write relative to the repo (generate-workflows
# deletes and rewrites .github/workflows/build*.yml) cannot touch the checkout.
WORK="${SCRATCH}/repo"
mkdir -p "${WORK}/.github"
cp "${REPO_ROOT}/Justfile" "${REPO_ROOT}/images.yaml" "${WORK}/"
cp -r "${REPO_ROOT}/workflow-templates" "${WORK}/"
cp -r "${REPO_ROOT}/.github/workflows" "${WORK}/.github/"

yqf() { yq --yaml-fix-merge-anchor-to-spec "$@" 2>/dev/null; }
just_in_work() { (cd "${WORK}" && just --evaluate "$1"); }

# --- 1. unit suite on Fedora ---------------------------------------------------
e2e_stage "bats unit suite on Fedora"
if (cd "${REPO_ROOT}" && bats --tap tests/unit); then
    e2e_ok "bats unit suite passes on Fedora"
else
    e2e_fail "bats unit suite failed on Fedora"
fi
e2e_endstage

# --- 2. every images.yaml combination resolves ----------------------------------
e2e_stage "images.yaml combinations resolve through the Justfile"
# shellcheck disable=SC2016 # the $v/$f are yq variables, not shell
combos="$(yqf -r 'explode(.).images | to_entries | .[] | .key as $v | .value | to_entries | .[] | .key as $f | .value | keys | .[] | "\($v) \($f) \(.)"' "${WORK}/images.yaml")"
combo_count=0
while read -r ver flavor target; do
    [[ -n "${ver}" ]] || continue
    combo_count=$((combo_count + 1))
    label="${ver}/${flavor}/${target}"
    export AKMODS_VERSION="${ver}" AKMODS_KERNEL="${flavor}" AKMODS_TARGET="${target}"
    expected_name="$(yqf ".images.\"${ver}\".\"${flavor}\".\"${target}\".name" "${WORK}/images.yaml")"
    if [[ -z "${expected_name}" || "${expected_name}" == "null" ]]; then
        e2e_fail "${label}: images.yaml has no .name"
        continue
    fi
    e2e_eq "${label}: check_valid" "true" "$(just_in_work check_valid 2>&1)"
    e2e_eq "${label}: akmods_name comes from images.yaml" "${expected_name}" "$(just_in_work akmods_name 2>&1)"
    e2e_eq "${label}: org is danathar (P1)" "danathar" "$(just_in_work _org 2>&1)"
    e2e_eq "${label}: registry" "ghcr.io" "$(just_in_work registry 2>&1)"
done <<<"${combos}"
unset AKMODS_VERSION AKMODS_KERNEL AKMODS_TARGET
e2e_eq "combination count matches images.yaml leaf targets" \
    "$(yqf '[explode(.).images.*.*.* | select(tag == "!!map")] | length' "${WORK}/images.yaml")" "${combo_count}"

out="$(AKMODS_TARGET=does-not-exist just_in_work check_valid 2>&1 || true)"
if [[ "${out}" == *"Invalid Image Combination"* ]]; then
    e2e_ok "an unknown target is rejected with 'Invalid Image Combination'"
else
    e2e_fail "an unknown target was not rejected (got: ${out})"
fi
e2e_eq "AKMODS_IMAGE_NAME overrides the name (P2)" "env-override" \
    "$(AKMODS_IMAGE_NAME=env-override just_in_work akmods_name 2>&1)"
e2e_endstage

# --- 3. workflow generation is reproducible ------------------------------------
e2e_stage "just generate-workflows reproduces committed workflows"
normalize_cron() {
    sed -E "s/^( *- cron: ')[0-9]{2} 0( \* \* \*')[[:space:]]+# 00[0-9]{2}( UTC)/\1MM 0\2 # 00MM\3/" "$1"
}
(cd "${WORK}" && just generate-workflows)
for generated in "${WORK}"/.github/workflows/build-akmods-*.yml; do
    name="$(basename "${generated}")"
    if diff <(normalize_cron "${REPO_ROOT}/.github/workflows/${name}") <(normalize_cron "${generated}") >/dev/null; then
        e2e_ok "${name} matches the committed file"
    else
        e2e_fail "${name} drifted from the committed file"
    fi
done
mkdir -p "${SCRATCH}/first"
cp "${WORK}"/.github/workflows/build-akmods-*.yml "${SCRATCH}/first/"
(cd "${WORK}" && just generate-workflows)
for generated in "${WORK}"/.github/workflows/build-akmods-*.yml; do
    name="$(basename "${generated}")"
    if diff <(normalize_cron "${SCRATCH}/first/${name}") <(normalize_cron "${generated}") >/dev/null; then
        e2e_ok "${name} is deterministic across runs"
    else
        e2e_fail "${name} differs between two generations"
    fi
done
e2e_endstage

echo
echo "e2e: ${E2E_PASS} passed, ${E2E_FAIL} failed"
[[ "${E2E_FAIL}" -eq 0 ]]

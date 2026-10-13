#!/usr/bin/env bats
# Upstream's build_files/prep/build-prep.sh installs the ZFS build tools only
# inside a KERNEL_FLAVOR check (centos, coreos, longterm). This fork also builds
# ZFS on `main` (the target zfs-aurora-complex injects, see P2), which never
# enters that block, so the tools the main-flavor build needs are carried by
# their own patches (T4, T5, T6). Nothing else notices when upstream changes the
# list: this fork's workflows build no images, so the first failure would be a
# red cache build in zfs-aurora-complex (how T6 was found). These tests fail at
# the upstream merge instead. See FORK-PATCHES.md, "ZFS build tools on the main
# flavor".

load helpers

# Each package in upstream's flavor-gated ZFS list and how the main-flavor ZFS
# build gets it: a patch id, or "absent" when main has never installed it and
# its ZFS builds succeed without it.
reviewed_main_flavor_sources() {
    cat <<'EOF'
autoconf absent
automake absent
dkms absent
git T6
jq T5
libtool absent
ncompress absent
python-cffi T4
EOF
}

# Prints the flavor-gated `if` line of build-prep.sh.
flavor_gate_line() {
    grep -m1 -E '^if .*KERNEL_FLAVOR.*centos.*coreos.*longterm.*; then$' \
        "${REPO_ROOT}/build_files/prep/build-prep.sh"
}

# Prints the packages the flavor-gated block appends to RPMS_TO_INSTALL, one per line.
flavor_gated_packages() {
    awk '
        /^if .*KERNEL_FLAVOR.*centos.*coreos.*longterm.*; then$/ { inblock = 1; next }
        inblock && /^fi$/ { exit }
        inblock && /RPMS_TO_INSTALL\+=\($/ { inlist = 1; next }
        inlist && /^[[:space:]]*\)$/ { inlist = 0; next }
        inlist { print $1 }
    ' "${REPO_ROOT}/build_files/prep/build-prep.sh"
}

# covers: T4, T5, T6
@test "T4-T6: upstream's flavor-gated ZFS package list is the one reviewed for main" {
    run flavor_gated_packages
    [ "${status}" -eq 0 ]
    [ -n "${output}" ] || {
        echo "flavor-gated RPMS_TO_INSTALL block not found in build-prep.sh; re-review T4-T6" >&2
        return 1
    }
    local found reviewed
    found="$(printf '%s\n' "${output}" | sort)"
    reviewed="$(reviewed_main_flavor_sources | awk '{print $1}' | sort)"
    [ "${found}" = "${reviewed}" ] || {
        echo "Upstream changed the ZFS build tools it installs only for centos/coreos/longterm." >&2
        echo "The main-flavor ZFS build (zfs-aurora-complex) does not get them. Decide per package" >&2
        echo "whether main needs it (add a T patch) or not, then update this test and FORK-PATCHES.md." >&2
        diff <(printf '%s\n' "${reviewed}") <(printf '%s\n' "${found}") >&2 || true
        return 1
    }
}

# covers: T4, T5, T6
@test "T4-T6: the main flavor still skips the flavor-gated block" {
    run flavor_gate_line
    [ "${status}" -eq 0 ]
    local gate="${output}"
    # Positive control: the extracted condition does select a flavor upstream builds ZFS on.
    run env KERNEL_FLAVOR=coreos-stable bash -c "${gate} exit 0; fi; exit 1"
    [ "${status}" -eq 0 ]
    run env KERNEL_FLAVOR=main bash -c "${gate} exit 1; fi; exit 0"
    [ "${status}" -eq 0 ] || {
        echo "Upstream now installs its ZFS build tools on main: T4, T5 and T6 may be redundant." >&2
        return 1
    }
}

# covers: T4, T5, T6
@test "T4-T6: every package main needs from the gated list is still provided" {
    local unconditional
    unconditional="$(awk '/^RPMS_TO_INSTALL\+=\($/{f=1;next} f&&/^\)$/{exit} f{print $1}' \
        "${REPO_ROOT}/build_files/prep/build-prep.sh")"
    local pkg source
    while read -r pkg source; do
        case "${source}" in
            absent) ;;
            T4) grep -qx 'python3-cffi' <<<"${unconditional}" ;;
            T5) grep -qx 'dnf install -y jq' "${REPO_ROOT}/build_files/zfs/build-kmod-zfs.sh" ;;
            T6) grep -qx 'git' <<<"${unconditional}" ;;
            *)
                echo "${pkg}: unknown source ${source}" >&2
                return 1
                ;;
        esac || {
            echo "${pkg} is no longer provided on main (${source})" >&2
            return 1
        }
    done < <(reviewed_main_flavor_sources)
}

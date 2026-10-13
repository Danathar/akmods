#!/usr/bin/env bats
# shellcheck disable=SC1003,SC2016 # single-quoted strings are literal Justfile/script/spec text to match
# T1 — the OpenZFS kernel-compatibility gate, end to end:
#   images.yaml `zfs.<flavor>.linux_experimental` (or `zfs.default`)
#     -> Justfile `zfs_configure_args` (ZFS_CONFIGURE_ARGS env wins)
#     -> `build`/`test` recipes pass it to the Containerfile as ZFS_CONFIGURE_ARGS
#     -> build-kmod-zfs.sh accepts only `--enable-linux-experimental` and adds it
#        to both ./configure and the rpm-kmod spec files.
# fork_patches.bats pins the images.yaml values to `false` and checks that the
# main flavor gets no flag. Nothing there would notice if `true` stopped
# producing the flag, if a flavor without its own block ignored `zfs.default`,
# or if the build script stopped refusing other configure arguments.

load helpers

setup() {
    require_tools yq jq
    require_tools "${JUST_BIN}"
    make_scratch_repo
}

# --- Justfile: images.yaml -> zfs_configure_args --------------------------------

# covers: T1
@test "T1: a flavor's linux_experimental: true resolves to --enable-linux-experimental" {
    yq -i '.zfs.main.linux_experimental = true' "${WORK}/images.yaml"
    export AKMODS_KERNEL=main
    run just_eval zfs_configure_args
    [ "${status}" -eq 0 ]
    [ "${output}" = "--enable-linux-experimental" ]
}

# covers: T1
@test "T1: a flavor with no zfs block follows zfs.default" {
    [ "$(yq '.zfs | has("coreos-stable")' "${WORK}/images.yaml")" = "false" ]
    export AKMODS_KERNEL=coreos-stable
    run just_eval zfs_configure_args
    [ "${status}" -eq 0 ]
    [ -z "${output}" ]
    yq -i '.zfs.default.linux_experimental = true' "${WORK}/images.yaml"
    run just_eval zfs_configure_args
    [ "${status}" -eq 0 ]
    [ "${output}" = "--enable-linux-experimental" ]
}

# covers: T1
@test "T1: the zfs.main block's false wins over a zfs.default of true" {
    yq -i '.zfs.default.linux_experimental = true' "${WORK}/images.yaml"
    export AKMODS_KERNEL=main
    run just_eval zfs_configure_args
    [ "${status}" -eq 0 ]
    [ -z "${output}" ]
}

# covers: T1
@test "T1: a flavor block without linux_experimental falls back to zfs.default" {
    yq -i 'del(.zfs.main.linux_experimental) | .zfs.default.linux_experimental = true' "${WORK}/images.yaml"
    export AKMODS_KERNEL=main
    run just_eval zfs_configure_args
    [ "${status}" -eq 0 ]
    [ "${output}" = "--enable-linux-experimental" ]
}

# covers: T1
@test "T1: only a literal true enables the flag (fails closed on other values)" {
    export AKMODS_KERNEL=main
    local value
    for value in '"yes"' '"True"' 'null' '1'; do
        yq -i ".zfs.main.linux_experimental = ${value}" "${WORK}/images.yaml"
        run just_eval zfs_configure_args
        [ "${status}" -eq 0 ]
        [ -z "${output}" ] || { echo "linux_experimental: ${value} enabled the flag" >&2; return 1; }
    done
}

# covers: T1
@test "T1: ZFS_CONFIGURE_ARGS in the environment overrides images.yaml" {
    export AKMODS_KERNEL=main ZFS_CONFIGURE_ARGS=--enable-linux-experimental
    run just_eval zfs_configure_args
    [ "${status}" -eq 0 ]
    [ "${output}" = "--enable-linux-experimental" ]
}

# covers: T1
@test "T1: build and test recipes both pass zfs_configure_args to the Containerfile" {
    local recipe line
    for recipe in build test; do
        line="$(awk -v r="${recipe}" '
            $0 ~ "^" r ":" { inr = 1; next }
            inr && /^[^ \t#]/ { exit }
            inr && /ZFS_CONFIGURE_ARGS_ARG=/ { print; exit }
        ' "${REPO_ROOT}/Justfile")"
        [[ "${line}" == *'ZFS_CONFIGURE_ARGS_ARG=ZFS_CONFIGURE_ARGS=\"{{ zfs_configure_args }}\"'* ]] || {
            echo "recipe '${recipe}' no longer passes zfs_configure_args: '${line}'" >&2
            return 1
        }
    done
    run grep -Fx 'ARG ZFS_CONFIGURE_ARGS_ARG' "${REPO_ROOT}/Containerfile.in"
    [ "${status}" -eq 0 ]
}

# --- build-kmod-zfs.sh: which configure arguments are allowed -------------------

# Prints the argument check at the top of build-kmod-zfs.sh: from the
# ZFS_CONFIGURE_ARGS default through the first `fi` after it.
extract_zfs_args_check() {
    local out
    out="$(awk '
        /^ZFS_CONFIGURE_ARGS="\$\{ZFS_CONFIGURE_ARGS:-\}"$/ { f = 1 }
        f { print }
        f && /^fi$/ { exit }
    ' "${REPO_ROOT}/build_files/zfs/build-kmod-zfs.sh")"
    [[ "${out}" == 'ZFS_CONFIGURE_ARGS='* && "${out}" == *'ZFS_CONFIGURE_ARGS_ARRAY=('* && "${out}" == *$'\nfi' ]] || {
        echo "ZFS_CONFIGURE_ARGS check not found in build-kmod-zfs.sh" >&2
        return 1
    }
    printf '%s\n' "${out}"
}

# run_zfs_args_check <value> — runs the check with ZFS_CONFIGURE_ARGS=<value>
# and prints the resulting array, one element per line, after a marker line.
run_zfs_args_check() {
    local snippet="${BATS_TEST_TMPDIR}/args-check.sh"
    {
        printf 'set -euo pipefail\n'
        extract_zfs_args_check
        cat <<'SH'
echo "--- ARRAY (${#ZFS_CONFIGURE_ARGS_ARRAY[@]})"
for a in "${ZFS_CONFIGURE_ARGS_ARRAY[@]}"; do printf '%s\n' "$a"; done
SH
    } >"${snippet}" || return 1
    ZFS_CONFIGURE_ARGS="$1" run bash "${snippet}"
}

# covers: T1
@test "T1: build-kmod-zfs.sh passes no configure arguments by default" {
    run_zfs_args_check ""
    [ "${status}" -eq 0 ]
    [ "${output}" = "--- ARRAY (0)" ]
}

# covers: T1
@test "T1: build-kmod-zfs.sh accepts --enable-linux-experimental as one argument" {
    run_zfs_args_check "--enable-linux-experimental"
    [ "${status}" -eq 0 ]
    [ "${output}" = $'--- ARRAY (1)\n--enable-linux-experimental' ]
}

# covers: T1
@test "T1: build-kmod-zfs.sh refuses any other configure arguments" {
    local bad
    for bad in "--enable-debug" "--enable-linux-experimental --enable-debug" " --enable-linux-experimental" "--enable-linux-experimental;true"; do
        run_zfs_args_check "${bad}"
        [ "${status}" -eq 1 ] || { echo "accepted: '${bad}'" >&2; return 1; }
        [[ "${output}" == "Unsupported ZFS_CONFIGURE_ARGS: ${bad}" ]]
    done
}

# covers: T1
@test "T1: build-kmod-zfs.sh hands the array to ./configure" {
    run grep -cF '"${ZFS_CONFIGURE_ARGS_ARRAY[@]}" \' "${REPO_ROOT}/build_files/zfs/build-kmod-zfs.sh"
    [ "${status}" -eq 0 ]
    [ "${output}" = "1" ]
    run awk '/^if ! \.\/configure \\$/ { f = 1 } f { print } f && /ZFS_CONFIGURE_ARGS_ARRAY/ { exit }' "${REPO_ROOT}/build_files/zfs/build-kmod-zfs.sh"
    [[ "${output}" == 'if ! ./configure \'* && "${output}" == *'ZFS_CONFIGURE_ARGS_ARRAY'* ]]
}

# --- build-kmod-zfs.sh: the rpm-kmod spec edit ---------------------------------

# Prints the spec-file edit: the `if [[ -n "${ZFS_CONFIGURE_ARGS}" ]]` line
# directly above `for spec in rpm/...`, through its closing `fi`.
extract_zfs_spec_edit() {
    local out
    out="$(awk '
        f { print; if (/^fi$/) exit; next }
        /^    for spec in rpm\// && prev ~ /^if \[\[ -n "\$\{ZFS_CONFIGURE_ARGS\}" \]\]; then$/ { f = 1; print prev; print; next }
        { prev = $0 }
    ' "${REPO_ROOT}/build_files/zfs/build-kmod-zfs.sh")"
    [[ "${out}" == 'if [[ -n "${ZFS_CONFIGURE_ARGS}" ]]; then'* && "${out}" == *'sed -i '* && "${out}" == *$'\nfi' ]] || {
        echo "rpm spec edit not found in build-kmod-zfs.sh" >&2
        return 1
    }
    printf '%s\n' "${out}"
}

# Writes the tail of an OpenZFS zfs-kmod.spec.in %configure call.
write_spec() {
    mkdir -p "$(dirname "$1")"
    printf '%s\n' '    %configure \' '        --with-config=kernel \' '        %{?kernel_cross} \' '        %{?kernel_arch}' '    make %{?_smp_mflags}' >"$1"
}

# run_zfs_spec_edit <value> — runs the edit in a scratch cwd with
# ZFS_CONFIGURE_ARGS=<value>. Spec fixtures must already be under $SPEC_CWD.
run_zfs_spec_edit() {
    local snippet="${BATS_TEST_TMPDIR}/spec-edit.sh"
    {
        printf 'set -euo pipefail\n'
        extract_zfs_spec_edit
    } >"${snippet}" || return 1
    cd "${SPEC_CWD}" || return 1
    ZFS_CONFIGURE_ARGS="$1" run bash "${snippet}"
}

setup_spec_cwd() {
    SPEC_CWD="${BATS_TEST_TMPDIR}/zfs-src"
    write_spec "${SPEC_CWD}/rpm/generic/zfs-kmod.spec.in"
    write_spec "${SPEC_CWD}/rpm/redhat/zfs-kmod.spec.in"
}

# covers: T1
@test "T1: with the flag set, both kmod spec files get --enable-linux-experimental" {
    setup_spec_cwd
    run_zfs_spec_edit "--enable-linux-experimental"
    [ "${status}" -eq 0 ]
    local spec
    for spec in generic redhat; do
        run grep -c -- '--enable-linux-experimental' "${SPEC_CWD}/rpm/${spec}/zfs-kmod.spec.in"
        [ "${output}" = "1" ]
        run grep -Fx '        %{?kernel_arch} --enable-linux-experimental' "${SPEC_CWD}/rpm/${spec}/zfs-kmod.spec.in"
        [ "${status}" -eq 0 ]
        run grep -Fx '        %{?kernel_cross} \' "${SPEC_CWD}/rpm/${spec}/zfs-kmod.spec.in"
        [ "${status}" -eq 0 ]
    done
}

# covers: T1
@test "T1: with no flag, the kmod spec files are left untouched" {
    setup_spec_cwd
    cp "${SPEC_CWD}/rpm/generic/zfs-kmod.spec.in" "${BATS_TEST_TMPDIR}/expected.spec"
    run_zfs_spec_edit ""
    [ "${status}" -eq 0 ]
    cmp "${BATS_TEST_TMPDIR}/expected.spec" "${SPEC_CWD}/rpm/generic/zfs-kmod.spec.in"
    cmp "${BATS_TEST_TMPDIR}/expected.spec" "${SPEC_CWD}/rpm/redhat/zfs-kmod.spec.in"
}

# covers: T1
@test "T1: the spec edit fails loudly when a spec file or its %{?kernel_arch} line is missing" {
    setup_spec_cwd
    rm "${SPEC_CWD}/rpm/redhat/zfs-kmod.spec.in"
    run_zfs_spec_edit "--enable-linux-experimental"
    [ "${status}" -eq 1 ]
    [[ "${output}" == *"Unable to add ZFS configure arguments to rpm/redhat/zfs-kmod.spec.in"* ]]

    setup_spec_cwd
    sed -i 's|%{?kernel_arch}|%{?kernel_arch} \\|' "${SPEC_CWD}/rpm/generic/zfs-kmod.spec.in"
    run_zfs_spec_edit "--enable-linux-experimental"
    [ "${status}" -eq 1 ]
    [[ "${output}" == *"Unable to add ZFS configure arguments to rpm/generic/zfs-kmod.spec.in"* ]]
}

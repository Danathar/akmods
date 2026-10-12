#!/usr/bin/env bats
# `just generate-workflows` must reproduce the committed build-akmods-*.yml files.
# The generator picks a RANDOM cron minute per file, so that one value (and its
# `# 00MM UTC` comment) is normalised before comparing. Runs in a scratch copy;
# the checkout is never modified.

load helpers

setup() {
    require_tools yq jq
    require_tools "${JUST_BIN}"
    make_scratch_repo
}

normalize_cron() {
    # Comment spacing after the cron value has drifted between template revisions
    # in the committed files, so it is collapsed too.
    sed -E "s/^( *- cron: ')[0-9]{2} 0( \* \* \*')[[:space:]]+# 00[0-9]{2}( UTC)/\1MM 0\2 # 00MM\3/" "$1"
}

# covers: GEN
@test "generate-workflows output matches committed workflows modulo cron minute" {
    (cd "${WORK}" && "${JUST_BIN}" generate-workflows)
    local generated committed name count=0
    for generated in "${WORK}"/.github/workflows/build-akmods-*.yml; do
        name="$(basename "${generated}")"
        committed="${REPO_ROOT}/.github/workflows/${name}"
        [ -f "${committed}" ] || { echo "generated ${name} is not committed"; return 1; }
        run diff <(normalize_cron "${committed}") <(normalize_cron "${generated}")
        [ "${status}" -eq 0 ] || { echo "drift in ${name}:"; echo "${output}"; return 1; }
        count=$((count + 1))
    done
    # Every committed build workflow must also still be generated.
    [ "${count}" -eq "$(find "${REPO_ROOT}/.github/workflows" -name 'build-akmods-*.yml' | wc -l)" ]
    [ "${count}" -ge 1 ]
}

# covers: GEN
@test "generate-workflows leaves the real checkout untouched" {
    before="$(find "${REPO_ROOT}/.github/workflows" -type f -exec sha256sum {} + | sort)"
    (cd "${WORK}" && "${JUST_BIN}" generate-workflows)
    after="$(find "${REPO_ROOT}/.github/workflows" -type f -exec sha256sum {} + | sort)"
    [ "${before}" = "${after}" ]
}

#!/usr/bin/env bats
# Every job that runs steps must set `timeout-minutes`, so a hang fails in minutes
# instead of holding a runner for GitHub's 360 minute default (#304). Jobs that
# only call a reusable workflow (`uses:`) cannot set one and are skipped.
# Read-only against the checkout.

load helpers

setup() {
    require_tools yq
}

# covers: T13
@test "T13: every workflow job that runs steps sets timeout-minutes" {
    local f missing="" count=0
    for f in "${REPO_ROOT}"/.github/workflows/*.yml; do
        run yq -r '.jobs | to_entries | .[] | select(.value.uses == null and .value."timeout-minutes" == null) | .key' "${f}"
        [ "${status}" -eq 0 ]
        [ -z "${output}" ] || missing+="$(basename "${f}"): ${output//$'\n'/, }"$'\n'
        count=$((count + 1))
    done
    [ "${count}" -ge 1 ]
    [ -z "${missing}" ] || { echo "jobs without timeout-minutes:"; echo "${missing}"; return 1; }
}

# covers: T13
@test "T13: the generated check job template sets timeout-minutes" {
    run grep -c '^    timeout-minutes: ' "${REPO_ROOT}/workflow-templates/check-status.yaml.in"
    [ "${status}" -eq 0 ]
    [ "${output}" -eq 1 ]
}

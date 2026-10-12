#!/usr/bin/env bats
# .github/scripts/check-upstream-sync.sh, the policy-check step that stops the
# Hive from squash-merging an upstream sync (#66). Runs against a throwaway git
# graph with UPSTREAM_REF set, so nothing is fetched:
#
#   root ── up1 ── up2             (upstream)
#     └──── fork ── ordinary       (fork main, an unrelated PR)
#             └──── sync           (merges up2 into fork)

load helpers

GUARD="${REPO_ROOT}/.github/scripts/check-upstream-sync.sh"

setup() {
    require_tools git
    cd "${BATS_TEST_TMPDIR}" || return
    git init -q -b main graph
    cd graph || return
    commit() { git -c user.name=t -c user.email=t@t commit -q --allow-empty -m "$1"; git rev-parse HEAD; }
    commit root >/dev/null
    git switch -q -c upstream
    commit up1 >/dev/null
    UP="$(commit up2)"
    git switch -q main
    FORK="$(commit fork)"
    git switch -q -c ordinary
    ORDINARY="$(commit ordinary)"
    git switch -q -c sync main
    git -c user.name=t -c user.email=t@t merge -q --no-edit "${UP}"
    SYNC="$(git rev-parse HEAD)"
    export UPSTREAM_REF="${UP}" BASE_SHA="${FORK}" PR_TITLE="" PR_HEAD_REF="" PR_LABELS=""
}

@test "upstream-sync guard: a sync titled like #66 with no marker fails" {
    HEAD_SHA="${SYNC}" PR_TITLE="chore: sync with upstream ublue-os/akmods" \
        PR_HEAD_REF="scanner/fix-59" PR_LABELS="area/ci,area/zfs" run "${GUARD}"
    [ "${status}" -eq 1 ]
    [[ "${output}" == *"merges 2 ublue-os/akmods commit(s)"* ]]
}

@test "upstream-sync guard: 'sync upstream' must be whole words" {
    HEAD_SHA="${SYNC}" PR_TITLE="resync upstreams" run "${GUARD}"
    [ "${status}" -eq 1 ]
}

@test "upstream-sync guard: each Hive marker classifies a sync" {
    HEAD_SHA="${SYNC}" PR_TITLE="chore: Sync Upstream ublue-os/akmods" run "${GUARD}"
    [ "${status}" -eq 0 ]
    HEAD_SHA="${SYNC}" PR_LABELS="area/ci,Upstream-Sync" run "${GUARD}"
    [ "${status}" -eq 0 ]
    HEAD_SHA="${SYNC}" PR_HEAD_REF="upstream-sync/2026-10-12" run "${GUARD}"
    [ "${status}" -eq 0 ]
}

@test "upstream-sync guard: a PR without upstream commits passes unmarked" {
    HEAD_SHA="${ORDINARY}" PR_TITLE="fix: unrelated" run "${GUARD}"
    [ "${status}" -eq 0 ]
    [[ "${output}" == "No upstream commits in this PR." ]]
}

@test "upstream-sync guard: upstream commits already on main do not trip it" {
    BASE_SHA="${SYNC}" HEAD_SHA="${SYNC}" run "${GUARD}"
    [ "${status}" -eq 0 ]
    git switch -q -c after-sync "${SYNC}"
    after="$(git -c user.name=t -c user.email=t@t commit -q --allow-empty -m after && git rev-parse HEAD)"
    BASE_SHA="${SYNC}" HEAD_SHA="${after}" PR_TITLE="fix: unrelated" run "${GUARD}"
    [ "${status}" -eq 0 ]
}

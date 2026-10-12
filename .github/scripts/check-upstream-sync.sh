#!/usr/bin/env bash
# Fails a PR that brings in ublue-os/akmods commits unless the Hive classifies it
# as an upstream sync. The Hive squash-merges every other PR, and a squashed sync
# drops upstream's ancestry, so the next sync re-merges from a stale base (#66).
#
# Mirrors hive's IsUpstreamSyncPR (src/pkg/github/pullrequest.go): label
# `upstream-sync`, head branch `upstream-sync/...`, or a title containing
# "sync upstream" (case-insensitive, whole words).
#
# Env: BASE_SHA, HEAD_SHA, PR_TITLE, PR_HEAD_REF, PR_LABELS (comma-separated).
# UPSTREAM_REF defaults to a fresh fetch of ublue-os/akmods main.
set -euo pipefail

: "${BASE_SHA:?}" "${HEAD_SHA:?}"
title="${PR_TITLE:-}"
head_ref="${PR_HEAD_REF:-}"
labels="${PR_LABELS:-}"

upstream="${UPSTREAM_REF:-}"
if [[ -z "${upstream}" ]]; then
    git fetch --quiet --no-tags https://github.com/ublue-os/akmods.git main
    upstream="$(git rev-parse FETCH_HEAD)"
fi

# Upstream commits the base lacks, minus those the head still lacks: anything
# left over is an upstream commit this PR merges in.
missing_from_base="$(git rev-list --count "${upstream}" "^${BASE_SHA}")"
missing_from_head="$(git rev-list --count "${upstream}" "^${HEAD_SHA}")"
brought=$((missing_from_base - missing_from_head))

if ((brought <= 0)); then
    echo "No upstream commits in this PR."
    exit 0
fi

title_re='(^|[^[:alnum:]_])sync[[:space:]]+upstream([^[:alnum:]_]|$)'
if [[ ",${labels,,}," == *,upstream-sync,* ]] ||
    [[ "${head_ref}" == upstream-sync/* ]] ||
    [[ "${title,,}" =~ ${title_re} ]]; then
    echo "PR merges ${brought} upstream commit(s) and is classified as an upstream sync."
    exit 0
fi

cat >&2 <<EOF
::error::This PR merges ${brought} ublue-os/akmods commit(s) but the Hive will squash it, which drops upstream's ancestry.
Make it recognisable as an upstream sync: put "sync upstream" in the title (e.g. "chore: sync upstream ublue-os/akmods"),
add the upstream-sync label, or use an upstream-sync/... branch. See AGENTS.md "Upstream merge procedure".
EOF
exit 1

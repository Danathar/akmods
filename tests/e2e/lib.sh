# Tiny assertion helpers for tests/e2e/run.sh. Sourced, not executed.

E2E_PASS=0
E2E_FAIL=0

e2e_ok() {
    E2E_PASS=$((E2E_PASS + 1))
    echo "ok   - $*"
}

e2e_fail() {
    E2E_FAIL=$((E2E_FAIL + 1))
    echo "FAIL - $*" >&2
}

# e2e_eq <description> <expected> <actual>
e2e_eq() {
    if [[ "$2" == "$3" ]]; then
        e2e_ok "$1"
    else
        e2e_fail "$1 (expected '$2', got '$3')"
    fi
}

# e2e_stage <title> — section header, grouped in the Actions log.
e2e_stage() {
    if [[ -n "${GITHUB_ACTIONS:-}" ]]; then
        echo "::group::$*"
    else
        echo "== $* =="
    fi
}

e2e_endstage() {
    if [[ -n "${GITHUB_ACTIONS:-}" ]]; then
        echo "::endgroup::"
    fi
}

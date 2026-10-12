#!/usr/bin/env bash
# Runs shellcheck over every tracked shell script, in two tiers (see
# .shellcheckrc for the rationale):
#   * fork-owned files  -> strict: every finding fails the run.
#   * upstream-owned    -> `--severity=error` only, so merging upstream never
#                          turns CI red over style findings we may not edit.
# Usage: tests/lint-shellcheck.sh   (from anywhere inside the checkout)
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

strict=()
relaxed=()
while IFS= read -r -d '' f; do
    [[ -f "${f}" && ! -L "${f}" ]] || continue
    case "${f}" in
        *.sh | *.bash | *.bats) ;;
        *)
            # Extensionless scripts: only those with a shell shebang.
            head -n1 "${f}" 2>/dev/null | grep -qE '^#!.*(ba)?sh' || continue
            ;;
    esac
    case "${f}" in
        tests/* | scripts/* | .github/scripts/* | .claude/*) strict+=("${f}") ;;
        *) relaxed+=("${f}") ;;
    esac
done < <(git ls-files -z --cached --others --exclude-standard)

echo "shellcheck: ${#strict[@]} fork-owned file(s) (all severities)"
shellcheck "${strict[@]}"
echo "shellcheck: ${#relaxed[@]} upstream-owned file(s) (severity=error)"
shellcheck --severity=error "${relaxed[@]}"
echo "shellcheck: OK"

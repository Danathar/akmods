#!/usr/bin/env bash
set -euo pipefail

sarif_file="${1:-results.sarif}"

echo "# OpenSSF Scorecard summary"
echo

if [[ ! -s "${sarif_file}" ]]; then
    echo "No SARIF report was found at \`${sarif_file}\`."
    exit 0
fi

total_findings="$(jq '[.runs[].results[]?] | length' "${sarif_file}")"

echo "Scorecard completed and uploaded \`${sarif_file}\` for GitHub code scanning."
echo
echo "- This summary lists the SARIF findings in a readable form."
echo "- Code scanning uses the SARIF report for maintainer alert triage."
echo "- A successful workflow means Scorecard ran; it does not mean every check scored 10/10."
echo
echo "Total SARIF findings: **${total_findings}**"
echo

if [[ "${total_findings}" == "0" ]]; then
    echo "No Scorecard findings were reported in SARIF."
    exit 0
fi

echo "## Findings by check"
echo
echo "| Check | Findings |"
echo "| --- | ---: |"
jq -r '
def rule_name($run; $id):
  (($run.tool.driver.rules[]? | select(.id == $id) | .name) // $id);

[
  .runs[] as $run
  | $run.results[]?
  | {rule: rule_name($run; .ruleId)}
]
| group_by(.rule)
| map({rule: .[0].rule, count: length})
| sort_by(-.count, .rule)
| .[]
| "| \(.rule) | \(.count) |"
' "${sarif_file}"

echo
echo "## First finding per check"
echo
echo "| Check | Finding |"
echo "| --- | --- |"
jq -r '
def clean:
  gsub("[\r\n\t]+"; " ")
  | gsub("[ ]+"; " ")
  | gsub("\\|"; "&#124;");

def rule_name($run; $id):
  (($run.tool.driver.rules[]? | select(.id == $id) | .name) // $id);

[
  .runs[] as $run
  | $run.results[]?
  | {
      rule: rule_name($run; .ruleId),
      message: ((.message.text // "") | clean)
    }
]
| group_by(.rule)
| map({rule: .[0].rule, message: .[0].message})
| sort_by(.rule)
| .[]
| .message as $message
| "| \(.rule) | \($message[0:280])\(if ($message | length) > 280 then "..." else "" end) |"
' "${sarif_file}"

echo
echo "## Reading notes"
echo
echo "- \`Token-Permissions\` can produce many entries because each workflow or job permission is reported separately."
echo "- \`Maintained\`, \`Code-Review\`, and \`CI-Tests\` can read oddly on forks or push-only runs."
echo "- The SARIF artifact remains available for deeper debugging while it is retained by the workflow run."

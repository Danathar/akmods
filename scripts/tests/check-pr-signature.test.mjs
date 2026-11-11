import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { main } from '../check-pr-signature.mjs';
import { AGENT_LOGINS, findSignature } from '../ai-audit-report.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const WORKFLOW = path.resolve(here, '..', '..', '.github', 'workflows', 'agent-signature.yml');
const SIG = '— hive: agent=scanner backend=claude model=opus';

function run(body) {
    const out = [];
    const err = [];
    const env = body === undefined ? {} : { PR_BODY: body };
    const code = main(env, { write: (s) => out.push(s) }, { write: (s) => err.push(s) });
    return { code, out: out.join(''), err: err.join('') };
}

test('a body with the signature line passes', () => {
    const r = run(`**Summary:** x\n\nRefs #3\n\n${SIG}\n`);
    assert.equal(r.code, 0);
    assert.equal(r.err, '');
});

test('a body without the line, an empty body and no body fail with an error annotation', () => {
    for (const body of ['Filed by the scanner agent', '', undefined, '— hive:', 'see — hive: agent=x']) {
        const r = run(body);
        assert.equal(r.code, 1, JSON.stringify(body));
        assert.match(r.err, /^::error::/);
    }
});

test('the other attribution markers the audit accepts pass too', () => {
    assert.equal(run('Body\n\nCo-Authored-By: Claude <noreply@anthropic.com>').code, 0);
    assert.equal(run('Body\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)').code, 0);
});

test('a signature only inside a code fence does not count, as in the audit', () => {
    assert.equal(run(`Example:\n\`\`\`\n${SIG}\n\`\`\``).code, 1);
});

test('the body is never echoed into the log', () => {
    const body = `::warning::injected\n${SIG}`;
    const ok = run(body);
    assert.ok(!ok.out.includes('injected') && !ok.err.includes('injected'));
    const bad = run('::warning::injected');
    assert.ok(!bad.out.includes('injected') && !bad.err.includes('injected'));
});

test('the PR-time check agrees with the audit on every body', () => {
    for (const body of [
        SIG,
        `  ${SIG}  `,
        `x\r\n${SIG}\r\n`,
        '— hive: backend=claude agent=x',
        '— hive: agent=',
        '- hive: agent=x',
        'Co-Authored-By: Claude Opus <noreply@anthropic.com>',
        '🤖 Generated with [Claude Code](https://claude.com/claude-code)',
        'Co-Authored-By: someone else',
        `~~~\n${SIG}\n~~~`,
        `\`\`\`\n${SIG}\n\`\`\`\n${SIG}`,
        'nothing here',
    ]) {
        assert.equal(run(body).code, findSignature(body) ? 0 : 1, JSON.stringify(body));
    }
});

// The workflow is plain YAML; these read it as text, which is enough to hold
// the properties that make it safe and keep it tied to this script.
const wf = () => fs.readFileSync(WORKFLOW, 'utf8');
const code = () => wf().split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

test('the workflow runs on pull_request only, read-only, and never on pull_request_target', () => {
    const c = code();
    assert.match(c, /^on:\n {2}pull_request:\n {4}types: \[opened, edited, reopened, synchronize\]\n/m);
    assert.doesNotMatch(c, /pull_request_target/);
    assert.match(c, /^permissions:\n {2}contents: read\n\n/m);
    assert.doesNotMatch(c, /: write\b|secrets\./);
});

test('the workflow gates on the audit\'s Hive App login or an ai-fix/ branch', () => {
    const m = /^ {4}if: (.*)$/m.exec(code());
    assert.ok(m, 'job signature has no if:');
    const logins = [...m[1].matchAll(/user\.login == '([^']+)'/g)].map((x) => x[1]);
    assert.deepEqual(logins, ['danathar-atomic-hive[bot]']);
    assert.ok(AGENT_LOGINS.includes(logins[0]));
    assert.match(m[1], /startsWith\(github\.event\.pull_request\.head\.ref, 'ai-fix\/'\)/);
});

test('the workflow passes the body through env: and runs this script', () => {
    const c = code();
    assert.match(c, /^jobs:\n {2}signature:\n/m);
    assert.match(c, /^ {10}PR_BODY: \$\{\{ github\.event\.pull_request\.body \}\}$/m);
    const runs = [...c.matchAll(/^\s*run: (.*)$/gm)].map((x) => x[1]);
    assert.deepEqual(runs, ['node scripts/check-pr-signature.mjs']);
});

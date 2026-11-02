// The "Signals" table of docs/quality.md lists where this fork's quality
// signals come from: each check, the workflow it lives in, and the first thing
// to run when it fails. Nothing read the table. It had no row for the weekly
// Auto issues and Auto-QA workflows that #58 added, and its shellcheck row said
// to run plain `shellcheck` on a file while CI runs tests/lint-shellcheck.sh,
// which holds upstream-owned files only to errors. These tests hold the table
// to .github/workflows/ and .github/rulesets/main.json, so a workflow or a job
// added, a required check renamed, or a CI command changed has to be written
// into the table in the same change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

const PAGE = 'docs/quality.md';
const WORKFLOWS = '.github/workflows';

// Workflows that check nothing here, so the table has no row for them.
const NOT_A_SIGNAL = new Map([
    ['ai-fix.yml', 'starts an agent when an issue or pull request asks for one'],
    ['build-akmods-*.yml', 'upstream builds, disabled in this fork (see "Important context")'],
    ['claude.yml', 'answers @claude mentions'],
    ['cleanup.yml', 'upstream image cleanup, disabled in this fork'],
    ['labeler.yml', 'labels pull requests by the paths they change'],
    ['reusable-build.yml', 'called only by the disabled build workflows'],
    ['reusable-cache-kernel.yml', 'called only by the disabled build workflows'],
]);

// Job rows whose first action is reading something, not running a command.
const FIRST_ACTION_NOT_A_COMMAND = new Map([
    ['Coverage gate', 'the fix is adding tests'],
    ['Mutation check on changed lines (advisory)', 'the step summary lists the survivors; the section below gives the command'],
    ['policy-check', 'the check message names the policy'],
]);

const codeSpans = (text) => [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
const globRegExp = (glob) => new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`);

function workflowFiles() {
    return fs.readdirSync(path.join(repoRoot, WORKFLOWS)).filter((f) => /\.ya?ml$/.test(f)).sort();
}

// What a workflow runs on, and each job's display name and run lines. Enough
// YAML for the files here: two-space indents, `on:` as a block, `name:` per
// job, and `run:` either inline or as a `|` block.
export function parseWorkflow(text) {
    const events = [];
    const jobs = [];
    let section = null;
    let job = null;
    let block = null;
    for (const line of text.split('\n')) {
        let m;
        if (block !== null) {
            if (line.trim() === '' || line.search(/\S/) > block) {
                if (line.trim()) job.run.push(line.trim());
                continue;
            }
            block = null;
        }
        if ((m = /^(\S[^:]*):/.exec(line))) {
            section = m[1].replace(/^['"]|['"]$/g, '');
            continue;
        }
        if (section === 'on' && (m = /^ {2}([\w-]+):/.exec(line))) events.push(m[1]);
        if (section !== 'jobs') continue;
        if ((m = /^ {2}([\w-]+):\s*$/.exec(line))) {
            job = { id: m[1], name: m[1], run: [] };
            jobs.push(job);
        } else if (job && (m = /^ {4}name: *(.+?) *$/.exec(line))) {
            job.name = m[1].replace(/^(['"])(.*)\1$/, '$2');
        } else if (job && (m = /^( +)(?:- )?run: *(.*?) *$/.exec(line))) {
            if (/^[|>]-?$/.test(m[2])) block = m[1].length;
            else job.run.push(m[2]);
        }
    }
    return { events, jobs };
}

const workflow = (file) => parseWorkflow(read(`${WORKFLOWS}/${file}`));

function section(heading) {
    const lines = read(PAGE).split('\n');
    const start = lines.indexOf(heading);
    assert.notEqual(start, -1, `${PAGE} has no ${JSON.stringify(heading)} heading`);
    const end = lines.findIndex((l, i) => i > start && /^#{1,3} /.test(l));
    return lines.slice(start + 1, end === -1 ? undefined : end).join('\n');
}

// A table row's cells, split on `|` outside code spans.
function cells(row) {
    const out = [];
    let cell = '';
    let code = false;
    for (const c of row.slice(1)) {
        if (c === '`') code = !code;
        if (c === '|' && !code) {
            out.push(cell.trim());
            cell = '';
        } else cell += c;
    }
    return out;
}

function signalRows() {
    const rows = section('## Signals').split('\n').filter((l) => l.startsWith('|'));
    const [header, rule, ...body] = rows.map(cells);
    assert.deepEqual(header, ['Signal', 'Where', 'What a failure means', 'First action']);
    assert.ok(rule.every((c) => /^-+$/.test(c)));
    return body.map(([signal, where, , action]) => ({
        signal,
        check: /^`([^`]+)`$/.exec(signal)?.[1] ?? null,
        where,
        action,
        files: codeSpans(where)
            .map((s) => /^(?:\.github\/workflows\/)?([\w*.-]+\.ya?ml)$/.exec(s)?.[1])
            .filter(Boolean),
    }));
}

const matching = (pattern) => workflowFiles().filter((w) => globRegExp(pattern).test(w));
const rowJobs = (row) => row.files.flatMap(matching).flatMap((f) => workflow(f).jobs);

function requiredChecks() {
    const ruleset = JSON.parse(read('.github/rulesets/main.json'));
    const rule = ruleset.rules.find((r) => r.type === 'required_status_checks');
    return rule.parameters.required_status_checks.map((c) => c.context).sort();
}

test('every workflow is in a row of the table or is listed as checking nothing', () => {
    const named = new Set(signalRows().flatMap((r) => r.files.flatMap(matching)));
    const exempt = [...NOT_A_SIGNAL.keys()].flatMap(matching);
    const missing = workflowFiles().filter((f) => !named.has(f) && !exempt.includes(f));
    assert.deepEqual(missing, [], `workflows ${PAGE} has no row for; add a row, or add the file to NOT_A_SIGNAL with the reason`);
});

test('every workflow the table or NOT_A_SIGNAL names exists, and none is both', () => {
    for (const row of signalRows()) {
        for (const f of row.files) assert.ok(matching(f).length, `${row.signal}: no workflow matches ${f}`);
    }
    for (const f of NOT_A_SIGNAL.keys()) assert.ok(matching(f).length, `NOT_A_SIGNAL names ${f}, which matches no workflow`);
    const named = new Set(signalRows().flatMap((r) => r.files.flatMap(matching)));
    assert.deepEqual([...NOT_A_SIGNAL.keys()].flatMap(matching).filter((f) => named.has(f)), []);
});

test('every check a row names is a job of the workflow it names', () => {
    for (const row of signalRows().filter((r) => r.check)) {
        assert.ok(row.files.length, `${row.signal}: names no workflow`);
        assert.ok(rowJobs(row).some((j) => j.name === row.check), `${row.signal} is not a job of ${row.files.join(', ')}`);
    }
});

test('every job of a pull request workflow the table names has its own row', () => {
    const checks = new Set(signalRows().map((r) => r.check));
    const files = [...new Set(signalRows().flatMap((r) => r.files.flatMap(matching)))];
    const pr = files.filter((f) => workflow(f).events.includes('pull_request'));
    assert.ok(pr.length >= 4, `only ${pr.join(', ')} run on pull requests`);
    for (const f of pr) {
        const missing = workflow(f).jobs.map((j) => j.name).filter((n) => !checks.has(n));
        assert.deepEqual(missing, [], `jobs of ${f} with no row in ${PAGE}`);
    }
});

test('the required checks have rows, and only rows that say so are not required', () => {
    const required = requiredChecks();
    const checks = signalRows().filter((r) => r.check);
    assert.deepEqual(required.filter((c) => !checks.some((r) => r.check === c)), [], 'required checks with no row');
    for (const row of checks) {
        const optional = /never required/.test(row.where);
        assert.equal(optional, !required.includes(row.check), `${row.signal}: "never required" in its Where cell must match the ruleset`);
    }
});

// The first code span of a job row's first action is a command the job runs,
// as the job writes it (`bash ` dropped), so the local command is the CI one.
test('the first action of a job row is a command its job runs', () => {
    for (const row of signalRows().filter((r) => r.check && !FIRST_ACTION_NOT_A_COMMAND.has(r.check))) {
        const [command] = codeSpans(row.action);
        assert.ok(command, `${row.signal}: first action names no command; add one, or add the row to FIRST_ACTION_NOT_A_COMMAND`);
        const run = rowJobs(row)
            .filter((j) => j.name === row.check)
            .flatMap((j) => j.run)
            .map((l) => l.replace(/^bash /, ''));
        assert.ok(run.includes(command), `${row.signal}: ${JSON.stringify(command)} is not a line its job runs (${run.join(' / ')})`);
    }
    for (const name of FIRST_ACTION_NOT_A_COMMAND.keys()) {
        assert.ok(signalRows().some((r) => r.check === name), `FIRST_ACTION_NOT_A_COMMAND names ${name}, which has no row`);
    }
});

test('parseWorkflow reads events, job names and inline and block run lines', () => {
    const yaml = [
        'name: X',
        'on:',
        '  pull_request:',
        '    branches: [main]',
        '  push:',
        'jobs:',
        '  a:',
        '    name: Job A',
        '    steps:',
        '      - name: one',
        '        run: bash tests/e2e/run.sh',
        '      - name: two',
        '        run: |',
        '          first',
        '',
        '          second',
        '      - uses: x',
        '  b:',
        '    steps:',
        '      - run: only',
        '',
    ].join('\n');
    assert.deepEqual(parseWorkflow(yaml), {
        events: ['pull_request', 'push'],
        jobs: [
            { id: 'a', name: 'Job A', run: ['bash tests/e2e/run.sh', 'first', 'second'] },
            { id: 'b', name: 'b', run: ['only'] },
        ],
    });
});

test('the workflow reader finds the jobs the table relies on', () => {
    const ci = workflow('ci.yml');
    assert.deepEqual(ci.events, ['pull_request', 'push']);
    assert.deepEqual(ci.jobs.map((j) => j.name), ['Lint (shellcheck)', 'Lint (actionlint)', 'Unit tests (bats)', 'E2E (fedora container)']);
    assert.ok(ci.jobs[0].run.includes('tests/lint-shellcheck.sh'));
    assert.deepEqual(workflow('auto-issues.yml').jobs.map((j) => j.name), ['signals']);
});

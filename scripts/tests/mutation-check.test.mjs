// Tests for scripts/mutation-check.mjs, the advisory mutation check on changed
// lines (#192). The pure parts are tested directly; the exit status the CI
// job reads (0 nothing new, 1 a new survivor, 2 could not run) is tested by
// running the script against Stryker JSON reports in a throwaway directory
// (--report) and against a throwaway git repository (--dry-run and the paths
// that stop before Stryker), so no Stryker install is needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    HASH_PIN_TESTS,
    HOOK_TESTS,
    LEDGER,
    budgetNotice,
    evaluate,
    formatSurvivor,
    groupFor,
    isAccepted,
    ledgerEntry,
    originalText,
    parseDiff,
    planRuns,
    summarize,
    survivors,
    testCommand,
    validateLedger,
} from '../mutation-check.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'mutation-check.mjs');

// ------------------------------------------------------------ diff reading

const DIFF = [
    'diff --git a/.claude/hooks/shell-reader.mjs b/.claude/hooks/shell-reader.mjs',
    'index 1111111..2222222 100644',
    '--- a/.claude/hooks/shell-reader.mjs',
    '+++ b/.claude/hooks/shell-reader.mjs',
    '@@ -10,0 +11,3 @@ function a() {',
    '+one',
    '+two',
    '+three',
    '@@ -20 +24 @@ function b() {',
    '-old',
    '+new',
    '@@ -30,2 +33,0 @@ function c() {',
    '-gone',
    '-gone too',
    'diff --git a/scripts/new-tool.mjs b/scripts/new-tool.mjs',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/scripts/new-tool.mjs',
    '@@ -0,0 +1,2 @@',
    '+export const x = 1;',
    '+export const y = 2;',
    '',
].join('\n');

test('parseDiff keeps added and changed lines, 1-based and inclusive', () => {
    const r = parseDiff(DIFF);
    assert.deepEqual(r.get('.claude/hooks/shell-reader.mjs'), [
        { start: 11, end: 13 },
        { start: 24, end: 24 },
    ]);
    assert.deepEqual(r.get('scripts/new-tool.mjs'), [{ start: 1, end: 2 }]);
});

test('parseDiff drops hunks that only delete lines', () => {
    const r = parseDiff(['+++ b/scripts/a.mjs', '@@ -5,3 +4,0 @@', '-x', '-y', '-z'].join('\n'));
    assert.equal(r.has('scripts/a.mjs'), false);
});

test('parseDiff merges adjacent and overlapping ranges but not separate ones', () => {
    const r = parseDiff(
        [
            '+++ b/scripts/a.mjs',
            '@@ -1 +1,2 @@',
            '-a',
            '+a',
            '+b',
            '@@ -3 +3 @@',
            '-c',
            '+c',
            '@@ -9 +5,1 @@',
            '-d',
            '+d',
            '@@ -12 +10,3 @@',
            '-e',
            '+e',
            '+f',
            '+g',
            '@@ -14 +11 @@',
            '-h',
            '+h',
        ].join('\n'),
    );
    assert.deepEqual(r.get('scripts/a.mjs'), [
        { start: 1, end: 3 },
        { start: 5, end: 5 },
        { start: 10, end: 12 },
    ]);
});

test('parseDiff reads quoted paths and ignores deleted files', () => {
    const r = parseDiff(
        ['+++ "b/scripts/odd \\"name\\".mjs"', '@@ -1 +1 @@', '-a', '+b', '+++ /dev/null', '@@ -1 +0,0 @@', '-x'].join('\n'),
    );
    assert.deepEqual([...r.keys()], ['scripts/odd "name".mjs']);
});

test('parseDiff merges ranges whatever order the hunks come in', () => {
    const r = parseDiff(
        ['+++ b/scripts/a.mjs', '@@ -9 +9 @@', '-x', '+x', '@@ -1 +1 @@', '-y', '+y', '@@ -5 +5 @@', '-z', '+z'].join('\n'),
    );
    assert.deepEqual(r.get('scripts/a.mjs'), [
        { start: 1, end: 1 },
        { start: 5, end: 5 },
        { start: 9, end: 9 },
    ]);
});

test('parseDiff reads counts of 10 or more and ignores a header-like line that does not start one', () => {
    const r = parseDiff(
        [
            '+++ b/scripts/a.mjs',
            'x @@ -1 +40 @@',
            '@@ -10,10 +12,11 @@',
            ...Array.from({ length: 10 }, () => '-old'),
            ...Array.from({ length: 11 }, () => '+new'),
        ].join('\n'),
    );
    assert.deepEqual(r.get('scripts/a.mjs'), [{ start: 12, end: 22 }]);
});

test('parseDiff keeps a path that has no b/ prefix as it is, and ignores a hunk before any file', () => {
    const r = parseDiff(['@@ -1 +1 @@', '-a', '+b', '+++ scripts/lib/x.mjs', '@@ -1 +1 @@', '-a', '+b'].join('\n'));
    assert.deepEqual([...r.keys()], ['scripts/lib/x.mjs']);
});

test('parseDiff counts context lines but not removed lines or no-newline markers', () => {
    // Each fake header below is an added line ("++ b/...") inside a hunk; the
    // hunk after it still belongs to scripts/a.mjs.
    const withContext = parseDiff(
        [
            '+++ b/scripts/a.mjs',
            '@@ -1,2 +1,3 @@',
            ' keep',
            '+++ b/scripts/other.mjs',
            '-old',
            '+new',
            '@@ -9 +10 @@',
            '-x',
            '+y',
        ].join('\n'),
    );
    assert.deepEqual([...withContext.keys()], ['scripts/a.mjs']);
    assert.deepEqual(withContext.get('scripts/a.mjs'), [
        { start: 1, end: 3 },
        { start: 10, end: 10 },
    ]);
    const withMarker = parseDiff(
        [
            '+++ b/scripts/a.mjs',
            '@@ -1 +1 @@',
            '-old',
            '\\ No newline at end of file',
            '+++ b/scripts/other.mjs',
            '@@ -9 +10 @@',
            '-x',
            '+y',
        ].join('\n'),
    );
    assert.deepEqual([...withMarker.keys()], ['scripts/a.mjs']);
    assert.deepEqual(withMarker.get('scripts/a.mjs'), [
        { start: 1, end: 1 },
        { start: 10, end: 10 },
    ]);
    // A context line can be the last one a hunk owes; the next header after
    // it is real.
    const contextLast = parseDiff(
        [
            '+++ b/scripts/a.mjs',
            '@@ -1,2 +1,2 @@',
            '+++ b/scripts/other.mjs',
            ' keep',
            '-old',
            '+++ b/scripts/b.mjs',
            '@@ -1 +1 @@',
            '-x',
            '+y',
        ].join('\n'),
    );
    assert.deepEqual([...contextLast.entries()], [
        ['scripts/a.mjs', [{ start: 1, end: 2 }]],
        ['scripts/b.mjs', [{ start: 1, end: 1 }]],
    ]);
});

test('parseDiff reads an added line that looks like a header as content', () => {
    const r = parseDiff(
        [
            '+++ b/scripts/a.mjs',
            '@@ -1,0 +2,3 @@',
            '+++ b/scripts/other.mjs',
            '+@@ -1 +1 @@',
            '+ok',
            '\\ No newline at end of file',
        ].join('\n'),
    );
    assert.deepEqual([...r.keys()], ['scripts/a.mjs']);
    assert.deepEqual(r.get('scripts/a.mjs'), [{ start: 2, end: 4 }]);
});

// ------------------------------------------------------- what runs against what

const TESTS = [
    'scripts/tests/check-policies.test.mjs',
    'scripts/tests/gate-refusal-corpus.test.mjs',
    'scripts/tests/shell-reader.test.mjs',
];

test('hook files run against the hook tests and the refusal corpus', () => {
    for (const f of ['.claude/hooks/guard-bash.mjs', '.claude/hooks/shell-reader.mjs']) {
        assert.deepEqual(groupFor(f, TESTS), { name: 'hooks', tests: HOOK_TESTS }, f);
    }
    assert.deepEqual(HOOK_TESTS, ['.claude/hooks/tests/guard-bash.test.mjs', 'scripts/tests/gate-refusal-corpus.test.mjs']);
});

test('a script runs against its own test file only', () => {
    assert.deepEqual(groupFor('scripts/check-policies.mjs', TESTS), {
        name: 'scripts-check-policies',
        tests: ['scripts/tests/check-policies.test.mjs'],
    });
    assert.deepEqual(groupFor('scripts/pr-metrics.mjs', TESTS), { name: 'scripts-pr-metrics', tests: [] });
});

test('the reader hash pin is never a test command, even for a script of that name', () => {
    assert.ok(HASH_PIN_TESTS.has('scripts/tests/shell-reader.test.mjs'));
    assert.deepEqual(groupFor('scripts/shell-reader.mjs', TESTS).tests, []);
    assert.ok(!HOOK_TESTS.some((t) => HASH_PIN_TESTS.has(t)));
});

test('tests, docs, config and nested files are not mutated', () => {
    for (const f of [
        '.claude/hooks/tests/guard-bash.test.mjs',
        '.claude/settings.json',
        '.claude/hooks/README.md',
        'scripts/tests/check-policies.test.mjs',
        'scripts/lib/x.mjs',
        'scripts/x.js',
        '.github/scripts/check-upstream-sync.sh',
        'stryker.config.mjs',
        'x/.claude/hooks/guard-bash.mjs',
        '.claude/hooks/guard-bash.mjs.orig',
        'x/scripts/a.mjs',
        'scripts/a.mjs.orig',
        'docs/quality.md',
        'Justfile',
    ]) {
        assert.equal(groupFor(f, TESTS), null, f);
    }
});

test('the hook test files exist and the Stryker config defaults to the same command', () => {
    for (const t of HOOK_TESTS) assert.ok(existsSync(join(ROOT, t)), t);
    // Read as text: importing the config would pick up MUTATION_TEST_COMMAND,
    // which Stryker sets in this test's own environment during a run.
    const config = readFileSync(join(ROOT, 'stryker.config.mjs'), 'utf8');
    assert.ok(config.includes(`'${testCommand(HOOK_TESTS)}'`), 'stryker.config.mjs default command');
    assert.doesNotMatch(config.replace(/^\s*\/\/.*$/gm, ''), /shell-reader\.test\.mjs/);
});

test('planRuns builds one Stryker run per test command, sorted by file', () => {
    const changed = new Map([
        ['scripts/check-policies.mjs', [{ start: 7, end: 7 }]],
        ['.claude/hooks/shell-reader.mjs', [{ start: 1, end: 3 }, { start: 9, end: 9 }]],
        ['.claude/hooks/guard-bash.mjs', [{ start: 2, end: 4 }]],
        ['scripts/pr-metrics.mjs', [{ start: 1, end: 1 }]],
        ['scripts/tests/check-policies.test.mjs', [{ start: 1, end: 1 }]],
        ['docs/quality.md', [{ start: 1, end: 1 }]],
    ]);
    assert.deepEqual(planRuns(changed, TESTS), {
        runs: [
            {
                name: 'hooks',
                command: 'node --test .claude/hooks/tests/guard-bash.test.mjs scripts/tests/gate-refusal-corpus.test.mjs',
                mutate: [
                    '.claude/hooks/guard-bash.mjs:2-4',
                    '.claude/hooks/shell-reader.mjs:1-3',
                    '.claude/hooks/shell-reader.mjs:9-9',
                ],
            },
            {
                name: 'scripts-check-policies',
                command: 'node --test scripts/tests/check-policies.test.mjs',
                mutate: ['scripts/check-policies.mjs:7-7'],
            },
        ],
        untested: ['scripts/pr-metrics.mjs'],
    });
});

test('planRuns is empty when only tests and docs change', () => {
    assert.deepEqual(planRuns(parseDiff('+++ b/scripts/tests/x.test.mjs\n@@ -1 +1 @@\n-a\n+b\n'), TESTS), {
        runs: [],
        untested: [],
    });
});

// ------------------------------------------------------------ report reading

test('originalText slices one line or several, columns 1-based and end exclusive', () => {
    const src = 'const a = 1;\nif (a > 0) {\n    run();\n}\n';
    assert.equal(originalText(src, { start: { line: 2, column: 5 }, end: { line: 2, column: 10 } }), 'a > 0');
    assert.equal(originalText(src, { start: { line: 2, column: 12 }, end: { line: 4, column: 2 } }), '{\n    run();\n}');
    const tail = 'if (a) {\n    run();\n} else {\n';
    assert.equal(originalText(tail, { start: { line: 1, column: 8 }, end: { line: 3, column: 2 } }), '{\n    run();\n}');
});

const at = (line, column, endLine, endColumn) => ({ start: { line, column }, end: { line: endLine, column: endColumn } });
const REPORT = {
    files: {
        'scripts/a.mjs': {
            source: 'function f(x) {\n    return x > 0;\n}\n',
            mutants: [
                { id: '1', mutatorName: 'EqualityOperator', replacement: 'x >= 0', status: 'Survived', location: at(2, 12, 2, 17) },
                { id: '2', mutatorName: 'BooleanLiteral', replacement: 'true', status: 'Killed', location: at(2, 12, 2, 17) },
                { id: '3', mutatorName: 'BlockStatement', replacement: '{}', status: 'NoCoverage', location: at(1, 15, 3, 2) },
                { id: '4', mutatorName: 'X', replacement: 'y', status: 'Timeout', location: at(1, 1, 1, 2) },
                { id: '5', mutatorName: 'X', replacement: 'y', status: 'RuntimeError', location: at(1, 1, 1, 2) },
                { id: '6', mutatorName: 'X', replacement: 'y', status: 'CompileError', location: at(1, 1, 1, 2) },
                { id: '7', mutatorName: 'X', replacement: 'y', status: 'Ignored', location: at(1, 1, 1, 2) },
            ],
        },
    },
};

test('survivors keeps only Survived and NoCoverage mutants, in file and line order', () => {
    const s = survivors(REPORT, '/repo');
    assert.deepEqual(
        s.map((m) => [m.line, m.status, m.mutator, m.original, m.replacement]),
        [
            [1, 'NoCoverage', 'BlockStatement', '{\n    return x > 0;\n}', '{}'],
            [2, 'Survived', 'EqualityOperator', 'x > 0', 'x >= 0'],
        ],
    );
    assert.ok(s.every((m) => m.file === 'scripts/a.mjs'));
});

test('survivors makes absolute report paths relative to the root', () => {
    const abs = { files: { '/repo/scripts/a.mjs': REPORT.files['scripts/a.mjs'] } };
    assert.equal(survivors(abs, '/repo')[0].file, 'scripts/a.mjs');
});

test('survivors of an empty report is empty', () => {
    assert.deepEqual(survivors({ files: {} }), []);
});

test('survivors sorts by file, then line, then column, and fills a missing replacement', () => {
    const src = 'a(1); b(2);\nc(3); d(4);\n';
    const r = {
        files: {
            // Neither in order nor in reverse order, by file or within one,
            // and a later file has an earlier line.
            'scripts/b.mjs': { source: src, mutants: [{ mutatorName: 'M', replacement: 'x', status: 'Survived', location: at(2, 1, 2, 5) }] },
            'scripts/c.mjs': { source: src, mutants: [{ mutatorName: 'M', replacement: 'x', status: 'Survived', location: at(1, 1, 1, 5) }] },
            'scripts\\a.mjs': {
                source: src,
                mutants: [
                    { mutatorName: 'M', replacement: 'x', status: 'Survived', location: at(2, 7, 2, 11) },
                    { mutatorName: 'M', status: 'Survived', location: at(1, 7, 1, 11) },
                    { mutatorName: 'M', replacement: 'x', status: 'Survived', location: at(2, 1, 2, 5) },
                ],
            },
        },
    };
    assert.deepEqual(
        survivors(r, '/repo').map((m) => [m.file, m.line, m.column, m.original, m.replacement]),
        [
            ['scripts/a.mjs', 1, 7, 'b(2)', ''],
            ['scripts/a.mjs', 2, 1, 'c(3)', 'x'],
            ['scripts/a.mjs', 2, 7, 'd(4)', 'x'],
            ['scripts/b.mjs', 2, 1, 'c(3)', 'x'],
            ['scripts/c.mjs', 1, 1, 'a(1)', 'x'],
        ],
    );
});

// -------------------------------------------------------------------- ledger

const SURVIVOR = {
    file: 'scripts/a.mjs',
    line: 2,
    column: 12,
    status: 'Survived',
    mutator: 'EqualityOperator',
    original: 'x > 0',
    replacement: 'x >= 0',
};
const entry = (over = {}) => ({ ...ledgerEntry(SURVIVOR), reason: 'x is never 0', ...over });

test('a ledger entry accepts a survivor on file, mutator, original and replacement', () => {
    assert.equal(isAccepted(SURVIVOR, { survivors: [entry()] }), true);
    assert.equal(isAccepted({ ...SURVIVOR, line: 99, column: 1 }, { survivors: [entry()] }), true);
    assert.equal(isAccepted(SURVIVOR, { survivors: [entry({ original: '  x  >\n0 ' })] }), true);
});

test('a ledger entry that differs in any matched field does not accept the survivor', () => {
    for (const over of [
        { file: 'scripts/b.mjs' },
        { mutator: 'ConditionalExpression' },
        { original: 'x < 0' },
        { replacement: 'x <= 0' },
    ]) {
        assert.equal(isAccepted(SURVIVOR, { survivors: [entry(over)] }), false, JSON.stringify(over));
    }
    assert.equal(isAccepted(SURVIVOR, { survivors: [] }), false);
});

test('evaluate splits survivors into new and accepted', () => {
    const other = { ...SURVIVOR, mutator: 'ConditionalExpression', replacement: 'true' };
    const r = evaluate([SURVIVOR, other], { survivors: [entry()] });
    assert.deepEqual(r.accepted, [SURVIVOR]);
    assert.deepEqual(r.fresh, [other]);
});

test('validateLedger accepts an empty ledger and complete entries', () => {
    assert.deepEqual(validateLedger({ survivors: [] }), []);
    assert.deepEqual(validateLedger({ survivors: [entry()] }), []);
    assert.deepEqual(validateLedger({ survivors: [entry({ replacement: '' })] }), []);
});

test('validateLedger rejects a missing list and entries without a reason or field', () => {
    assert.match(validateLedger({})[0], /no "survivors" array/);
    assert.match(validateLedger(null)[0], /no "survivors" array/);
    assert.match(validateLedger({ survivors: [entry({ reason: ' ' })] })[0], /survivors\[0\]: "reason"/);
    const { mutator, ...noMutator } = entry();
    assert.equal(mutator, 'EqualityOperator');
    assert.match(validateLedger({ survivors: [noMutator] })[0], /"mutator"/);
    assert.equal(validateLedger({ survivors: [null] }).length, 5);
});

test("the repository's ledger is valid", () => {
    const ledger = JSON.parse(readFileSync(join(ROOT, LEDGER), 'utf8'));
    assert.deepEqual(validateLedger(ledger), []);
});

test('ledgerEntry has every field validateLedger needs and a reason to fill in', () => {
    const e = ledgerEntry(SURVIVOR);
    assert.deepEqual(validateLedger({ survivors: [e] }), []);
    assert.match(e.reason, /^TODO/);
    assert.equal(isAccepted(SURVIVOR, { survivors: [e] }), true);
});

test('formatSurvivor names the place, mutator, status and both texts on one line', () => {
    assert.equal(
        formatSurvivor({ ...SURVIVOR, original: 'a\n  b' }),
        'scripts/a.mjs:2:12 EqualityOperator (Survived): `a b` -> `x >= 0`',
    );
    assert.equal(
        formatSurvivor({ ...SURVIVOR, original: 'x'.repeat(100), replacement: 'y'.repeat(81) }),
        `scripts/a.mjs:2:12 EqualityOperator (Survived): \`${'x'.repeat(80)}\` -> \`${'y'.repeat(80)}\``,
    );
});

test('summarize writes exactly this text', () => {
    assert.equal(
        summarize([], [SURVIVOR]),
        '## Mutation check on changed lines (advisory)\n\nNo new surviving mutants (1 accepted in the ledger).',
    );
    assert.equal(
        summarize([], [], ['scripts/x.mjs']),
        [
            '## Mutation check on changed lines (advisory)',
            '',
            'Changed scripts with no `scripts/tests/<name>.test.mjs` to run, so no line of them is checked:',
            '',
            '- scripts/x.mjs',
            '',
            '',
            '0 survivor(s) accepted in the ledger.',
        ].join('\n'),
    );
    assert.equal(
        summarize([SURVIVOR], [SURVIVOR, SURVIVOR]),
        [
            '## Mutation check on changed lines (advisory)',
            '',
            '1 mutant(s) on changed lines survived: the line can be broken this way without any test failing.',
            '',
            `- ${formatSurvivor(SURVIVOR)}`,
            '',
            'Add a test that fails on each. If a survivor is equivalent (behaves the same) or harmless ' +
                'over-refusal, add its entry below to `.mutation-survivors.json` with a real reason instead.',
            '',
            '```json',
            JSON.stringify([ledgerEntry(SURVIVOR)], null, 4),
            '```',
            '',
            '2 survivor(s) accepted in the ledger.',
        ].join('\n'),
    );
});

test('summarize lists new survivors with ledger entries, and untested scripts', () => {
    const clean = summarize([], [SURVIVOR]);
    assert.match(clean, /No new surviving mutants \(1 accepted in the ledger\)/);
    const text = summarize([SURVIVOR], [], ['scripts/pr-metrics.mjs']);
    assert.match(text, /1 mutant\(s\) on changed lines survived/);
    assert.ok(text.includes(`- ${formatSurvivor(SURVIVOR)}`));
    assert.match(text, /```json\n\[\n {4}\{\n {8}"file": "scripts\/a\.mjs"/);
    assert.match(text, /"reason": "TODO/);
    assert.match(text, /- scripts\/pr-metrics\.mjs/);
    assert.doesNotMatch(summarize([], [], ['scripts/x.mjs']), /```json/);
});

test('budgetNotice names the budget, the group that was cut off and the groups never started', () => {
    assert.equal(
        budgetNotice({ minutes: 35, cut: null, skipped: [] }),
        'mutation run stopped at its time budget (35 min); results are incomplete',
    );
    assert.equal(
        budgetNotice({ minutes: 35, cut: 'hooks', skipped: ['scripts-a', 'scripts-b'] }),
        'mutation run stopped at its time budget (35 min); results are incomplete: ' +
            'hooks was cut off and none of its mutants are counted; scripts-a, scripts-b not run',
    );
    assert.equal(
        budgetNotice({ minutes: 0.5, cut: null, skipped: ['scripts-a'] }),
        'mutation run stopped at its time budget (0.5 min); results are incomplete: scripts-a not run',
    );
});

test('summarize says the results are incomplete when the budget stopped the run', () => {
    const stopped = { minutes: 35, cut: 'hooks', skipped: [] };
    const none = summarize([], [], [], stopped);
    assert.ok(none.startsWith('## Mutation check on changed lines (advisory)\n\n**mutation run stopped at'), none);
    assert.match(none, /results are incomplete: hooks was cut off/);
    assert.match(none, /No new surviving mutants among those that ran \(0 accepted in the ledger\)\./);
    assert.doesNotMatch(none, /No new surviving mutants \(/);
    const some = summarize([SURVIVOR], [], [], stopped);
    assert.match(some, /results are incomplete/);
    assert.match(some, /1 mutant\(s\) on changed lines survived/);
    assert.equal(summarize([SURVIVOR], [], [], null), summarize([SURVIVOR], []));
});

// ------------------------------------------------------------ the CLI, end to end

function layout(files) {
    const dir = mkdtempSync(join(tmpdir(), 'mutation-check-'));
    for (const [rel, body] of Object.entries(files)) {
        const p = join(dir, rel);
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body));
    }
    return dir;
}

function run(args, cwd, extraEnv = {}) {
    const env = { ...process.env, ...extraEnv };
    // The runner sets both; a test that wants them passes them explicitly.
    for (const k of ['GITHUB_ACTIONS', 'GITHUB_STEP_SUMMARY']) if (!(k in extraEnv)) delete env[k];
    return spawnSync(process.execPath, [SCRIPT, ...args], { cwd, env, encoding: 'utf8' });
}

const SOURCE = 'function f(x) {\n    return x > 0;\n}\n';
const mutant = (status, mutatorName = 'EqualityOperator', replacement = 'x >= 0') => ({
    id: `${status}-${mutatorName}`,
    mutatorName,
    replacement,
    status,
    location: at(2, 12, 2, 17),
});
const report = (...mutants) => ({
    schemaVersion: '2',
    files: { 'scripts/a.mjs': { language: 'javascript', source: SOURCE, mutants } },
});
const ACCEPT = {
    file: 'scripts/a.mjs',
    mutator: 'EqualityOperator',
    original: 'x > 0',
    replacement: 'x >= 0',
    reason: 'x is never 0 here',
};

test('exits 0 when every mutant in the report is killed', () => {
    const dir = layout({ 'r.json': report(mutant('Killed'), mutant('Timeout')) });
    try {
        const r = run(['--report', 'r.json'], dir);
        assert.equal(r.status, 0, r.stderr);
        assert.match(r.stdout, /No new surviving mutants \(0 accepted in the ledger\)/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('exits 1 on a survivor not in the ledger and writes it, with a ledger entry, to the step summary', () => {
    const dir = layout({ 'r.json': report(mutant('Survived')) });
    const summary = join(dir, 'summary.md');
    try {
        const r = run(['--report', 'r.json'], dir, { GITHUB_STEP_SUMMARY: summary });
        assert.equal(r.status, 1, r.stderr);
        assert.match(r.stdout, /scripts\/a\.mjs:2:12 EqualityOperator \(Survived\): `x > 0` -> `x >= 0`/);
        const written = readFileSync(summary, 'utf8');
        assert.match(written, /^## Mutation check on changed lines \(advisory\)/);
        assert.match(written, /"replacement": "x >= 0"/);
        assert.match(written, /"reason": "TODO/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('exits 1 on a changed line no test runs at all (NoCoverage)', () => {
    const dir = layout({ 'r.json': report(mutant('NoCoverage')) });
    try {
        assert.equal(run(['--report', 'r.json'], dir).status, 1);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('exits 0 when the only survivor is accepted in the default ledger', () => {
    const dir = layout({ 'r.json': report(mutant('Survived')), [LEDGER]: { survivors: [ACCEPT] } });
    try {
        const r = run(['--report', 'r.json'], dir);
        assert.equal(r.status, 0, r.stdout + r.stderr);
        assert.match(r.stdout, /1 accepted in the ledger/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('still exits 1 when one survivor is accepted and another is not', () => {
    const dir = layout({
        'r.json': report(mutant('Survived'), mutant('Survived', 'ConditionalExpression', 'true')),
        'ledger.json': { survivors: [ACCEPT] },
    });
    try {
        const r = run(['--report', 'r.json', '--ledger', 'ledger.json'], dir);
        assert.equal(r.status, 1);
        assert.match(r.stdout, /ConditionalExpression/);
        assert.doesNotMatch(r.stdout, /EqualityOperator \(Survived\)/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('reads several reports and fails on a survivor in any of them', () => {
    const dir = layout({ 'a.json': report(mutant('Killed')), 'b.json': report(mutant('Survived')) });
    try {
        assert.equal(run(['--report', 'a.json', '--report', 'b.json'], dir).status, 1);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('exits 2 on a malformed ledger, a missing report and bad arguments', () => {
    const dir = layout({
        'r.json': report(mutant('Killed')),
        'bad.json': { survivors: [{ ...ACCEPT, reason: '' }, { ...ACCEPT, file: '' }] },
        'broken.json': '{ not json',
    });
    try {
        const bad = run(['--report', 'r.json', '--ledger', 'bad.json'], dir);
        assert.equal(bad.status, 2);
        assert.match(bad.stderr, /bad\.json is malformed:\n {2}survivors\[0\]: "reason" must be a non-empty string\n {2}survivors\[1\]: "file"/);
        const broken = run(['--report', 'r.json', '--ledger', 'broken.json'], dir);
        assert.equal(broken.status, 2);
        assert.match(broken.stderr, /cannot read ledger .*broken\.json: /);
        const missing = run(['--report', 'missing.json'], dir);
        assert.equal(missing.status, 2);
        assert.match(missing.stderr, /cannot read Stryker report .*missing\.json: /);
        const unknown = run(['--frobnicate'], dir);
        assert.equal(unknown.status, 2);
        assert.match(unknown.stderr, /unknown argument --frobnicate/);
        const noBase = run(['--base'], dir);
        assert.equal(noBase.status, 2);
        assert.match(noBase.stderr, /--base needs a value/);
        const noStryker = run(['--stryker', '--dry-run'], dir);
        assert.equal(noStryker.status, 2);
        assert.match(noStryker.stderr, /--stryker needs a value/);
        const noBudget = run(['--budget-minutes'], dir);
        assert.equal(noBudget.status, 2);
        assert.match(noBudget.stderr, /--budget-minutes needs a value/);
        for (const bad of ['0', 'abc', '1e3', '0.0', '1.']) {
            const r = run(['--budget-minutes', bad, '--dry-run'], dir);
            assert.equal(r.status, 2, bad);
            assert.match(r.stderr, new RegExp(`--budget-minutes needs a positive number of minutes, got ${bad}`));
        }
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

const git = (cwd, ...args) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], {
        cwd,
        encoding: 'utf8',
    });

function repo() {
    const dir = layout({
        '.claude/hooks/guard-bash.mjs': 'const a = 1;\nconst b = 2;\n',
        'scripts/tool.mjs': 'export const t = 1;\n',
        'scripts/tests/tool.test.mjs': 'test();\n',
        'scripts/tests/shell-reader.test.mjs': 'pin();\n',
        'docs/x.md': 'one\n',
    });
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'base');
    git(dir, 'checkout', '-q', '-b', 'pr');
    return dir;
}

function commit(dir, files) {
    for (const [rel, body] of Object.entries(files)) {
        mkdirSync(dirname(join(dir, rel)), { recursive: true });
        writeFileSync(join(dir, rel), body);
    }
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'change');
}

test('--dry-run prints the Stryker runs for the lines the branch changed', () => {
    const dir = repo();
    try {
        commit(dir, {
            '.claude/hooks/guard-bash.mjs': 'const a = 1;\nconst b = 3;\nconst c = 4;\n',
            '.claude/hooks/tests/guard-bash.test.mjs': 'test();\n',
            'scripts/tool.mjs': 'export const t = 2;\n',
            'scripts/tests/tool.test.mjs': 'test(2);\n',
            'scripts/shell-reader.mjs': 'export const r = 1;\n',
        });
        const r = run(['--base', 'main', '--dry-run'], dir);
        assert.equal(r.status, 0, r.stderr);
        assert.deepEqual(JSON.parse(r.stdout), {
            runs: [
                { name: 'hooks', command: testCommand(HOOK_TESTS), mutate: ['.claude/hooks/guard-bash.mjs:2-3'] },
                { name: 'scripts-tool', command: 'node --test scripts/tests/tool.test.mjs', mutate: ['scripts/tool.mjs:1-1'] },
            ],
            untested: ['scripts/shell-reader.mjs'],
        });
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('exits 0 without Stryker when no hook or script line changed', () => {
    const dir = repo();
    try {
        commit(dir, { 'docs/x.md': 'two\n', 'scripts/tests/tool.test.mjs': 'test(3);\n' });
        const r = run(['--base', 'main'], dir);
        assert.equal(r.status, 0, r.stderr);
        assert.match(r.stdout, /nothing to mutate/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('exits 1 without Stryker when the only changed script has no test file', () => {
    const dir = repo();
    try {
        commit(dir, { 'scripts/untested.mjs': 'export const u = 1;\n' });
        const r = run(['--base', 'main'], dir);
        assert.equal(r.status, 1, r.stderr);
        assert.match(r.stdout, /- scripts\/untested\.mjs/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('exits 2 when a run is needed and Stryker is not given or not there', () => {
    const dir = repo();
    try {
        commit(dir, { 'scripts/tool.mjs': 'export const t = 5;\n' });
        const none = run(['--base', 'main'], dir);
        assert.equal(none.status, 2);
        assert.match(none.stderr, /pass --stryker/);
        const missing = run(['--base', 'main', '--stryker', 'no/such/stryker'], dir);
        assert.equal(missing.status, 2);
        assert.match(missing.stderr, /does not exist/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('exits 2 when the base ref does not exist', () => {
    const dir = repo();
    try {
        const r = run(['--base', 'no-such-ref'], dir);
        assert.equal(r.status, 2);
        assert.match(r.stderr, /git diff against no-such-ref failed/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('--base defaults to origin/main and --root sets the repository', () => {
    const dir = repo();
    try {
        git(dir, 'update-ref', 'refs/remotes/origin/main', 'main');
        commit(dir, { 'scripts/tool.mjs': 'export const t = 2;\n' });
        const r = run(['--root', dir, '--dry-run'], tmpdir());
        assert.equal(r.status, 0, r.stderr);
        assert.deepEqual(JSON.parse(r.stdout).runs, [
            { name: 'scripts-tool', command: 'node --test scripts/tests/tool.test.mjs', mutate: ['scripts/tool.mjs:1-1'] },
        ]);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

// A stand-in for the Stryker binary: it records how it was started, prints a
// line, and then does what FAKE_STRYKER says.
const FAKE_STRYKER = `
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
writeFileSync('stryker-call.json', JSON.stringify({
    argv: process.argv.slice(2),
    command: process.env.MUTATION_TEST_COMMAND,
    report: process.env.MUTATION_REPORT,
    path: process.env.PATH,
}));
console.log('fake stryker ran');
const mode = process.env.FAKE_STRYKER;
if (mode === 'exit') process.exit(3);
if (mode === 'survivor' || mode === 'broken') {
    mkdirSync(dirname(process.env.MUTATION_REPORT), { recursive: true });
    writeFileSync(process.env.MUTATION_REPORT, mode === 'broken' ? '{ not json' : JSON.stringify(${JSON.stringify(
        report(mutant('Survived')),
    ).replaceAll('scripts/a.mjs', 'scripts/tool.mjs')}));
}
`;

function strykerRepo() {
    const dir = repo();
    commit(dir, { 'scripts/tool.mjs': 'a();\nexport const t = 1;\nb();\n' });
    writeFileSync(join(dir, 'fake-stryker.mjs'), FAKE_STRYKER);
    return dir;
}

const strykerRun = (dir, mode) =>
    run(['--root', dir, '--base', 'main', '--stryker', 'fake-stryker.mjs'], tmpdir(), { FAKE_STRYKER: mode });

test('runs Stryker in the repository with the config, the ranges, the test command and the report path', () => {
    const dir = strykerRepo();
    try {
        const r = strykerRun(dir, 'survivor');
        assert.equal(r.status, 1, r.stderr);
        const call = JSON.parse(readFileSync(join(dir, 'stryker-call.json'), 'utf8'));
        assert.deepEqual(call, {
            argv: ['run', 'stryker.config.mjs', '--mutate', 'scripts/tool.mjs:1-1,scripts/tool.mjs:3-3'],
            command: 'node --test scripts/tests/tool.test.mjs',
            report: 'reports/mutation/scripts-tool.json',
            path: process.env.PATH,
        });
        assert.ok(
            r.stdout.startsWith(
                '\n== scripts-tool: mutating 2 range(s) against `node --test scripts/tests/tool.test.mjs`\n' +
                    '   scripts/tool.mjs:1-1\n   scripts/tool.mjs:3-3\nfake stryker ran\n',
            ),
            r.stdout,
        );
        assert.match(r.stdout, /scripts\/tool\.mjs:2:12 EqualityOperator \(Survived\)/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('a stale report from an earlier run is removed, and no report means no survivor', () => {
    const dir = strykerRepo();
    try {
        assert.equal(strykerRun(dir, 'survivor').status, 1);
        const r = strykerRun(dir, 'none');
        assert.equal(r.status, 0, r.stdout + r.stderr);
        assert.equal(existsSync(join(dir, 'reports/mutation/scripts-tool.json')), false);
        assert.match(r.stdout, /No new surviving mutants/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('exits 2 when Stryker fails or writes an unreadable report', () => {
    const dir = strykerRepo();
    try {
        const failed = strykerRun(dir, 'exit');
        assert.equal(failed.status, 2);
        assert.match(failed.stderr, /Stryker \(scripts-tool\) exited with 3/);
        const broken = strykerRun(dir, 'broken');
        assert.equal(broken.status, 2);
        assert.match(broken.stderr, /cannot read Stryker report .*scripts-tool\.json: /);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

// ------------------------------------------------------------ the time budget (#216)

// A stand-in for Stryker that logs each start. For the group named in
// FAKE_HANG it starts a child process of its own (as Stryker starts the test
// processes), records that child's pid and then never finishes; every other
// group writes a report with one survivor and exits.
const FAKE_BUDGET_STRYKER = `
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
const name = process.env.MUTATION_REPORT.split('/').pop().replace('.json', '');
appendFileSync('stryker-starts.log', name + '\\n');
if (name === process.env.FAKE_HANG) {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    writeFileSync('child.pid', String(child.pid));
    setInterval(() => {}, 1000);
} else {
    mkdirSync(dirname(process.env.MUTATION_REPORT), { recursive: true });
    writeFileSync(process.env.MUTATION_REPORT, JSON.stringify(${JSON.stringify(
        report(mutant('Survived')),
    ).replaceAll('scripts/a.mjs', 'scripts/aaa.mjs')}));
}
`;

// Three groups, run in this order: scripts-aaa, scripts-tool, scripts-zzz.
function budgetRepo() {
    const dir = repo();
    commit(dir, {
        'scripts/aaa.mjs': 'a();\nexport const t = 1;\nb();\n',
        'scripts/tests/aaa.test.mjs': 'test();\n',
        'scripts/tool.mjs': 'a();\nexport const t = 1;\nb();\n',
        'scripts/zzz.mjs': 'a();\nexport const t = 1;\nb();\n',
        'scripts/tests/zzz.test.mjs': 'test();\n',
    });
    writeFileSync(join(dir, 'fake-stryker.mjs'), FAKE_BUDGET_STRYKER);
    return dir;
}

const budgetRun = (dir, budget, env = {}) =>
    run(
        ['--root', dir, '--base', 'main', '--stryker', 'fake-stryker.mjs', ...(budget === null ? [] : ['--budget-minutes', budget])],
        tmpdir(),
        env,
    );

const starts = (dir) => readFileSync(join(dir, 'stryker-starts.log'), 'utf8').trim().split('\n');

const alive = (pid) => {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
};

test('a run that finishes inside its budget behaves as it does without one', () => {
    const dir = budgetRepo();
    try {
        const withBudget = budgetRun(dir, '5', { FAKE_HANG: 'none' });
        assert.equal(withBudget.status, 1, withBudget.stderr);
        assert.deepEqual(starts(dir), ['scripts-aaa', 'scripts-tool', 'scripts-zzz']);
        assert.doesNotMatch(withBudget.stdout, /time budget|incomplete/);
        rmSync(join(dir, 'stryker-starts.log'));
        const without = budgetRun(dir, null, { FAKE_HANG: 'none' });
        assert.equal(without.status, 1, without.stderr);
        assert.equal(without.stdout, withBudget.stdout);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('at the budget the running group is killed with its child processes, the rest is skipped, and the survivors so far are reported', async () => {
    const dir = budgetRepo();
    const summary = join(dir, 'summary.md');
    try {
        const r = budgetRun(dir, '0.03', { FAKE_HANG: 'scripts-tool', GITHUB_ACTIONS: 'true', GITHUB_STEP_SUMMARY: summary });
        const notice =
            'mutation run stopped at its time budget (0.03 min); results are incomplete: ' +
            'scripts-tool was cut off and none of its mutants are counted; scripts-zzz not run';
        // The survivor of the group that finished is a normal finding, so the usual exit status 1.
        assert.equal(r.status, 1, r.stdout + r.stderr);
        assert.deepEqual(starts(dir), ['scripts-aaa', 'scripts-tool']);
        assert.ok(r.stdout.includes(`\n${notice}\n`), r.stdout);
        assert.ok(r.stdout.includes(`\n::warning::${notice}\n`), r.stdout);
        assert.match(r.stdout, /scripts\/aaa\.mjs:2:12 EqualityOperator \(Survived\)/);
        assert.match(readFileSync(summary, 'utf8'), /\*\*mutation run stopped at its time budget/);
        const pid = Number(readFileSync(join(dir, 'child.pid'), 'utf8'));
        for (let i = 0; i < 40 && alive(pid); i++) await new Promise((done) => setTimeout(done, 50));
        assert.equal(alive(pid), false, 'the child process of the killed Stryker run is still running');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('a budget stop with nothing new to report exits 0 and says so, without an annotation outside GitHub', () => {
    const dir = budgetRepo();
    try {
        // The first group hangs, so nothing finished and nothing survived.
        const r = budgetRun(dir, '0.03', { FAKE_HANG: 'scripts-aaa' });
        assert.equal(r.status, 0, r.stdout + r.stderr);
        assert.deepEqual(starts(dir), ['scripts-aaa']);
        assert.match(r.stdout, /results are incomplete: scripts-aaa was cut off and none of its mutants are counted; scripts-tool, scripts-zzz not run/);
        assert.match(r.stdout, /No new surviving mutants among those that ran/);
        assert.doesNotMatch(r.stdout, /::warning::/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('a budget used up before any group starts skips them all', () => {
    const dir = budgetRepo();
    try {
        const r = budgetRun(dir, '0.00001', { FAKE_HANG: 'none' });
        assert.equal(r.status, 0, r.stdout + r.stderr);
        assert.equal(existsSync(join(dir, 'stryker-starts.log')), false);
        assert.match(r.stdout, /results are incomplete: scripts-aaa, scripts-tool, scripts-zzz not run/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('a budget stop still fails on a changed script that has no test file', () => {
    const dir = budgetRepo();
    try {
        commit(dir, { 'scripts/untested.mjs': 'export const u = 1;\n' });
        const r = budgetRun(dir, '0.00001', { FAKE_HANG: 'none' });
        assert.equal(r.status, 1, r.stdout + r.stderr);
        assert.match(r.stdout, /- scripts\/untested\.mjs/);
        assert.match(r.stdout, /results are incomplete/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

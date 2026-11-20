// Every glob in .github/labeler.yml must match at least one tracked file, or
// the rule is dead and nothing notices. Dependency-free: a tiny glob matcher
// (`**`, `*`, `?`) over `git ls-files` (plus untracked, so a fresh checkout of unstaged work behaves the same), matching actions/labeler's minimatch
// semantics closely enough for the patterns used here (dotfiles included).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const ROOT = new URL('../../', import.meta.url).pathname;

export function globToRegExp(glob) {
    let re = '';
    for (let i = 0; i < glob.length; i++) {
        const c = glob[i];
        if (c === '*') {
            if (glob[i + 1] === '*') {
                // `**/` = zero or more directories; trailing `**` = anything.
                if (glob[i + 2] === '/') {
                    re += '(?:.*/)?';
                    i += 2;
                } else {
                    re += '.*';
                    i += 1;
                }
            } else {
                re += '[^/]*';
            }
        } else if (c === '?') {
            re += '[^/]';
        } else {
            re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
        }
    }
    return new RegExp(`^${re}$`);
}

/** Quoted glob strings from labeler.yml (label keys end in `:` and are skipped). */
export function readGlobs(text) {
    const globs = [];
    for (const line of text.split('\n')) {
        // Three shapes: `- 'glob'`, `any-glob-to-any-file: 'glob'`, and the
        // combined `- any-glob-to-any-file: 'glob'`.
        const m = /^\s*(?:-\s+)?(?:any-glob-to-any-file:\s+)?'([^']+)'\s*$/.exec(line);
        if (m) globs.push(m[1]);
    }
    return globs;
}

/**
 * Independent count of glob entries: every non-comment line whose content ends
 * in a quoted string and is not a `'label':` key. Compared with readGlobs() so
 * a glob written in a shape the reader does not know cannot go unchecked.
 */
export function countGlobEntries(text) {
    return text.split('\n').filter((line) => !/^\s*#/.test(line) && /'[^']+'\s*$/.test(line)).length;
}

/** Top-level (unindented) keys of labeler.yml, unquoted: the label names. */
export function readLabelNames(text) {
    const names = [];
    for (const line of text.split('\n')) {
        const m = /^(?:'([^']+)'|"([^"]+)"|([^\s#'"-][^:]*)):\s*$/.exec(line);
        if (m) names.push(m[1] ?? m[2] ?? m[3]);
    }
    return names;
}

/** Label names the path labeler must never apply (issue and agent provenance labels). */
export function isReservedLabel(name) {
    return ['quality', 'security', 'testing'].includes(name) || name.startsWith('hive/') || name.startsWith('agent/');
}

/**
 * Problems with the labeler workflow's write-token safety rules: triggers on
 * `pull_request` only, the `label` job is skipped for fork PRs, and no step
 * checks out code or runs a shell command.
 */
export function checkLabelerWorkflow(text) {
    const problems = [];
    const lines = text.split('\n').filter((l) => !/^\s*#/.test(l));

    const onAt = lines.findIndex((l) => /^on:\s*$/.test(l));
    if (onAt < 0) {
        problems.push('no block-style top-level `on:`');
    } else {
        const triggers = [];
        for (const l of lines.slice(onAt + 1)) {
            if (/^\S/.test(l)) break;
            const m = /^ {2}([A-Za-z_]+):/.exec(l);
            if (m) triggers.push(m[1]);
        }
        if (triggers.join(',') !== 'pull_request') {
            problems.push(`triggers must be exactly pull_request, got: ${triggers.join(',') || 'none'}`);
        }
    }

    const labelAt = lines.findIndex((l) => /^ {2}label:\s*$/.test(l));
    if (labelAt < 0) {
        problems.push('no `label` job');
    } else {
        const job = [];
        for (const l of lines.slice(labelAt + 1)) {
            if (/^ {0,2}\S/.test(l)) break;
            job.push(l);
        }
        if (!job.some((l) => /^ {4}if:\s*github\.event\.pull_request\.head\.repo\.full_name\s*==\s*github\.repository\s*$/.test(l))) {
            problems.push('label job lacks the fork-PR `if: github.event.pull_request.head.repo.full_name == github.repository`');
        }
        if (job.some((l) => /\buses:\s*['"]?actions\/checkout\b/.test(l))) {
            problems.push('label job must not check out code (actions/checkout)');
        }
        if (job.some((l) => /^\s*(?:-\s+)?run:/.test(l))) {
            problems.push('label job must not have a `run:` step');
        }
    }
    return problems;
}

const tracked = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' });
const files = tracked.stdout.split('\n').filter(Boolean);
const labelerText = readFileSync(`${ROOT}.github/labeler.yml`, 'utf8');
const globs = readGlobs(labelerText);

test('git ls-files works and the labeler config has globs', () => {
    assert.equal(tracked.status, 0, tracked.stderr);
    assert.ok(files.length > 0);
    assert.ok(globs.length >= 10, `only ${globs.length} globs parsed`);
});

test('globToRegExp semantics', () => {
    assert.ok(globToRegExp('a/**').test('a/b/c.sh'));
    assert.ok(globToRegExp('*.md').test('README.md'));
    assert.ok(!globToRegExp('*.md').test('docs/x.md'));
    assert.ok(globToRegExp('.github/workflows/build-akmods-*.yml').test('.github/workflows/build-akmods-main.yml'));
    assert.ok(!globToRegExp('Justfile').test('Justfile.bak'));
    assert.ok(globToRegExp('x/**/y.sh').test('x/y.sh'));
});

for (const glob of new Set(globs)) {
    test(`labeler glob matches a tracked file: ${glob}`, () => {
        const re = globToRegExp(glob);
        assert.ok(files.some((f) => re.test(f)), `no tracked file matches ${glob}`);
    });
}

test('readGlobs reads every shape a glob can be written in', () => {
    const text = [
        "'area/a':",
        '  - changed-files:',
        "      - any-glob-to-any-file: 'one/**'",
        '  - changed-files:',
        '      - any-glob-to-any-file:',
        "          - 'two/**'",
        '  - changed-files:',
        "      - 'three/**'",
        "# - 'commented/**'",
    ].join('\n');
    assert.deepEqual(readGlobs(text), ['one/**', 'two/**', 'three/**']);
    assert.equal(countGlobEntries(text), 3);
});

test('every glob entry in labeler.yml is parsed and therefore checked', () => {
    assert.equal(globs.length, countGlobEntries(labelerText), 'readGlobs skips some glob entries');
});

test('labeler.yml never applies a reserved label name', () => {
    const names = readLabelNames(labelerText);
    assert.ok(names.length > 0, 'no label names parsed');
    const reserved = names.filter(isReservedLabel);
    assert.deepEqual(reserved, [], `reserved label names: ${reserved.join(', ')}`);
    assert.ok(isReservedLabel('quality') && isReservedLabel('security') && isReservedLabel('testing'));
    assert.ok(isReservedLabel('hive/claimed') && isReservedLabel('agent/quality'));
    assert.ok(!isReservedLabel('area/zfs'));
    assert.deepEqual(readLabelNames("quality:\n  - changed-files:\n'area/x':\n"), ['quality', 'area/x']);
});

const GOOD_WORKFLOW = [
    'name: Labeler',
    'on:',
    '  pull_request:',
    '    types: [opened]',
    'jobs:',
    '  label:',
    '    if: github.event.pull_request.head.repo.full_name == github.repository',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - uses: actions/labeler@abc',
    '',
].join('\n');

test('labeler workflow keeps its write-token safety rules', () => {
    const problems = checkLabelerWorkflow(readFileSync(`${ROOT}.github/workflows/labeler.yml`, 'utf8'));
    assert.deepEqual(problems, []);
});

test('checkLabelerWorkflow accepts a safe workflow and refuses each unsafe edit', () => {
    assert.deepEqual(checkLabelerWorkflow(GOOD_WORKFLOW), []);
    const bad = {
        'pull_request_target': GOOD_WORKFLOW.replace('  pull_request:', '  pull_request_target:'),
        'extra trigger': GOOD_WORKFLOW.replace('  pull_request:', '  push:\n  pull_request:'),
        'missing fork if': GOOD_WORKFLOW.replace(/ {4}if:.*\n/, ''),
        'checkout step': GOOD_WORKFLOW.replace('    steps:\n', '    steps:\n      - uses: actions/checkout@abc\n'),
        'run step': GOOD_WORKFLOW.replace('    steps:\n', '    steps:\n      - run: echo injected\n'),
    };
    for (const [name, text] of Object.entries(bad)) {
        assert.notDeepEqual(checkLabelerWorkflow(text), [], `${name} was not refused`);
    }
});

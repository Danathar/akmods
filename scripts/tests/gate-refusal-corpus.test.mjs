// Runs the fleet's shared refusal corpus against this repository's Bash gate.
//
// Each repository in the fleet keeps its own PreToolUse gate, and the copies
// are separate code: a bypass fixed in one says nothing about the others.
// tests/fixtures/gate-refusal-corpus.json is the one table they share. Each
// row is a command, the verdict every gate has to reach, and the command
// prefixes the row depends on; a row runs here only when this repository's
// allow list covers every one of those prefixes. The canonical copy lives in
// Danathar/atomic-image-builder (docs/gate-refusal-corpus.md), so the file is
// pinned by hash and never edited here.
//
// KNOWN_GAPS lists the rows this gate does not refuse yet. Each one is
// asserted to still get through, so fixing a gap fails this test until its id
// is removed, and a row that is not listed can never regress silently.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CORPUS_PATH = `${ROOT}tests/fixtures/gate-refusal-corpus.json`;
const CORPUS_SHA256 = '8a4bf0f7118af630f2549633cb91d33a324312d5750bbc83e0f0a8489700cf71';
const settings = JSON.parse(readFileSync(`${ROOT}.claude/settings.json`, 'utf8'));
const raw = readFileSync(CORPUS_PATH);
const corpus = JSON.parse(raw.toString('utf8'));

const KNOWN_GAPS = new Set([
    'plain-file-two-operands',
    'plain-file-after-dashdash',
    'redirect-write',
    'redirect-write-before-command',
    'stdin-redirect',
    'brace-expansion',
    'brace-expansion-flag',
    'tilde-operand',
    'command-substitution',
    'backtick-substitution',
    'wrapper-timeout',
    'later-line',
    'later-separator',
]);

// The command prefix each wildcard Bash(...) allow rule covers. The fleet
// spells a prefix rule three ways (`git diff:*`, `git diff *`, `git diff*`);
// a rule with no wildcard allows one exact command and covers no prefix.
function allowPrefixes(config) {
    const prefixes = [];
    for (const rule of config.permissions?.allow ?? []) {
        if (!rule.startsWith('Bash(') || !rule.endsWith(')')) continue;
        const body = rule.slice('Bash('.length, -1);
        const suffix = [':*', ' *', '*'].find((s) => body.endsWith(s));
        if (suffix) prefixes.push(body.slice(0, -suffix.length));
    }
    return prefixes;
}

const covered = (prefix, prefixes) =>
    prefixes.some((rule) => prefix === rule || prefix.startsWith(`${rule} `));

const PREFIXES = allowPrefixes(settings);
const applies = (row) => row.requires.every((prefix) => covered(prefix, PREFIXES));

function hookCommand() {
    const entry = (settings.hooks?.PreToolUse ?? []).find((e) => e.matcher === 'Bash');
    assert.ok(entry, '.claude/settings.json registers no PreToolUse hook for Bash');
    return entry.hooks[0].command;
}

// Run the hook the way Claude Code does: the registered command, the tool
// call as JSON on stdin. Exit 2, or a "deny" decision on stdout, refuses.
function decide(command) {
    const result = spawnSync('bash', ['-c', hookCommand()], {
        input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }),
        cwd: ROOT,
        env: { ...process.env, CLAUDE_PROJECT_DIR: ROOT.replace(/\/$/, '') },
        encoding: 'utf8',
    });
    return result.status === 2 || result.stdout.includes('"deny"') ? 'refuse' : 'allow';
}

const rowsById = new Map(corpus.rows.map((row) => [row.id, row]));

test('the corpus is the canonical copy', () => {
    assert.equal(createHash('sha256').update(raw).digest('hex'), CORPUS_SHA256,
        'tests/fixtures/gate-refusal-corpus.json differs from the pinned copy; change it in atomic-image-builder and copy it again');
    assert.equal(corpus.schema, 1);
});

test('each fleet spelling of a prefix rule covers the prefix, at a word boundary', () => {
    for (const rule of ['Bash(git diff:*)', 'Bash(git diff *)', 'Bash(git diff*)']) {
        assert.ok(covered('git diff', allowPrefixes({ permissions: { allow: [rule] } })), rule);
    }
    assert.ok(!covered('git diff', allowPrefixes({ permissions: { allow: ['Bash(git diff)'] } })));
    assert.ok(!covered('git diffx', allowPrefixes({ permissions: { allow: ['Bash(git diff:*)'] } })));
});

test('every known gap names a reachable refuse row', () => {
    for (const id of KNOWN_GAPS) {
        const row = rowsById.get(id);
        assert.ok(row, `KNOWN_GAPS names ${id}, which is not in the corpus`);
        assert.equal(row.verdict, 'refuse', `${id} is not a refuse row`);
        assert.ok(applies(row), `${id} does not run here; remove it from KNOWN_GAPS`);
    }
});

for (const row of corpus.rows.filter(applies)) {
    test(`${row.verdict} ${row.id}: ${row.command}`, () => {
        const got = decide(row.command);
        if (KNOWN_GAPS.has(row.id)) {
            assert.equal(got, 'allow',
                `the gate now refuses ${row.id}; remove it from KNOWN_GAPS`);
        } else {
            assert.equal(got, row.verdict, `${row.id}: ${row.why}`);
        }
    });
}

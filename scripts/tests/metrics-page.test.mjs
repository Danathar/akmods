// docs/metrics.md says which pull requests scripts/pr-metrics.mjs counts, how
// each number is defined and how to run the script. Nothing read the page:
// pr-metrics.test.mjs tests the script but never opens it. So the page still
// told readers to run `node --test scripts/tests`, which fails on the Node 22
// CI uses, and it named four of the six flags. These tests hold the page to
// the script and to the weekly pr-metrics.yml run, and they run the page's
// commands as written, with a stand-in for `gh`.
//
// What no test can read: the Known limits bullet that this fork's build
// workflows are disabled. That is a repository setting, not a file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    AGENT_BRANCH_PREFIXES,
    AGENT_LABELS,
    DEFAULT_REPO,
    computeMetrics,
    isAgentPR,
    isRevert,
} from '../pr-metrics.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

const PAGE = 'docs/metrics.md';
const SCRIPT = 'scripts/pr-metrics.mjs';
const WORKFLOW = '.github/workflows/pr-metrics.yml';

const codeSpans = (text) => [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
const oneLine = (text) => text.replace(/\s+/g, ' ');

function section(heading) {
    const lines = read(PAGE).split('\n');
    const start = lines.indexOf(heading);
    assert.notEqual(start, -1, `${PAGE} has no ${JSON.stringify(heading)} heading`);
    const end = lines.findIndex((l, i) => i > start && /^#{1,3} /.test(l));
    return lines.slice(start + 1, end === -1 ? undefined : end).join('\n');
}

// The Metrics table as { name: definition }, names without their bold marks.
function metricRows() {
    const rows = section('## Metrics').split('\n').filter((l) => l.startsWith('|'));
    assert.ok(rows.length > 2, `${PAGE}: no table under ## Metrics`);
    return Object.fromEntries(rows.slice(2).map((row) => {
        const [name, definition] = row.slice(1, -1).split('|').map((c) => c.trim());
        return [name.replace(/\*\*/g, ''), definition];
    }));
}

// The lines of the fenced block under ## Running it, each split into its
// words and the comment after `#`.
function pageCommands() {
    const fence = /```\n([\s\S]*?)```/.exec(section('## Running it'));
    assert.ok(fence, `${PAGE}: no fenced block under ## Running it`);
    return fence[1].trim().split('\n').map((line) => {
        const [command, note = ''] = line.split(/\s+#\s+/);
        return { words: command.trim().split(/\s+/), note };
    });
}

function pageCommand(note) {
    const found = pageCommands().filter((c) => c.note.includes(note));
    assert.equal(found.length, 1, `${PAGE}: expected one command noted ${JSON.stringify(note)}`);
    return found[0].words;
}

// Flags the script's parseArgs accepts.
function scriptFlags() {
    const flags = [...read(SCRIPT).matchAll(/a === '(--[\w-]+)'/g)].map((m) => m[1]);
    assert.ok(flags.length > 0, `${SCRIPT}: the flag reader found no flags`);
    return flags.sort();
}

const pr = (number, o = {}) => ({
    number,
    title: `PR ${number}`,
    user: { login: 'Danathar', type: 'User' },
    head: { ref: `fix/${number}` },
    labels: [],
    body: '',
    created_at: '2026-10-02T00:00:00Z',
    closed_at: '2026-10-02T02:00:00Z',
    merged_at: '2026-10-02T02:00:00Z',
    ...o,
});

// A PR that took `h` hours to merge.
const mergedAfter = (number, h) => pr(number, {
    closed_at: new Date(Date.parse('2026-10-02T00:00:00Z') + h * 3_600_000).toISOString(),
    merged_at: new Date(Date.parse('2026-10-02T00:00:00Z') + h * 3_600_000).toISOString(),
});

// Runs a page command in a scratch directory, with a `gh` that logs its
// arguments and prints `pulls` as one slurped page. Returns what it printed,
// what gh was asked and the files it wrote.
function runPageCommand(words, pulls = []) {
    assert.deepEqual(words.slice(0, 2), ['node', SCRIPT]);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metrics-page-'));
    try {
        const bin = path.join(dir, 'bin');
        const cwd = path.join(dir, 'cwd');
        const outDir = path.join(dir, 'out');
        fs.mkdirSync(bin);
        fs.mkdirSync(cwd);
        const log = path.join(dir, 'gh.log');
        const reply = path.join(dir, 'reply.json');
        fs.writeFileSync(reply, JSON.stringify([pulls]));
        fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\necho "$*" >> '${log}'\ncat '${reply}'\n`, { mode: 0o755 });
        fs.writeFileSync(path.join(cwd, 'prs.json'), JSON.stringify(pulls));
        const args = words.slice(2).map((w) => (w === '/tmp/m' ? outDir : w));
        const stdout = execFileSync(process.execPath, [path.join(repoRoot, SCRIPT), ...args], {
            cwd,
            encoding: 'utf8',
            env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` },
        });
        const listing = (root) => (fs.existsSync(root) ? fs.readdirSync(root, { recursive: true }).sort() : []);
        return {
            stdout,
            gh: fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '',
            cwdFiles: listing(cwd).filter((f) => f !== 'prs.json'),
            outFiles: listing(outDir),
        };
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

test('Population: closed pull requests of this repository, merged or not, optionally since a date', () => {
    const text = oneLine(section('## Population'));
    assert.ok(text.includes(`Every **closed** pull request in \`${DEFAULT_REPO}\` (merged or not), optionally limited by \`--since\`.`));
    assert.ok(scriptFlags().includes('--since'));
    const prs = [
        pr(1),
        pr(2, { merged_at: null }),
        pr(3, { closed_at: '2026-09-01T00:00:00Z', merged_at: '2026-09-01T00:00:00Z' }),
    ];
    assert.equal(computeMetrics(prs).overall.closed, 3);
    assert.equal(computeMetrics(prs, { since: '2026-10-01' }).overall.closed, 2);
});

test('Population: --since goes by the closing date, not the opening date', () => {
    const openedEarlier = pr(1, { created_at: '2026-09-01T00:00:00Z' });
    assert.equal(computeMetrics([openedEarlier], { since: '2026-10-01' }).overall.closed, 1);
});

test('Population: open pull requests are never counted', () => {
    assert.match(section('## Population'), /Open PRs are never counted\./);
    const open = pr(1, { closed_at: null, merged_at: null });
    assert.equal(computeMetrics([open]).overall.closed, 0);
});

test('Population: the section gives no pull request count, which would go stale', () => {
    assert.doesNotMatch(section('## Population'), /single digits|handful|\b\d+ (closed )?(PRs|pull requests)\b/);
});

test('Metrics: the table has a row for each thing the script reports, and no other', () => {
    assert.deepEqual(Object.keys(metricRows()), [
        'Acceptance rate',
        'Time to merge (TTM)',
        'Agent vs human split',
        'Agent share',
        'Reverts',
    ]);
    // A new field fails here until the table says what it means.
    const metrics = computeMetrics([]);
    assert.deepEqual(Object.keys(metrics).sort(), [
        'agent',
        'agent_share_of_closed',
        'generated_at',
        'human',
        'overall',
        'repo',
        'revert_rate',
        'reverts',
        'since',
        'window',
    ]);
    assert.deepEqual(Object.keys(metrics.overall).sort(), [
        'acceptance_rate',
        'closed',
        'closed_unmerged',
        'merged',
        'reverts',
        'time_to_merge_hours',
    ]);
});

test('Metrics: acceptance rate is merged over closed', () => {
    assert.deepEqual(codeSpans(metricRows()['Acceptance rate']), ['merged / closed']);
    const metrics = computeMetrics([pr(1), pr(2), pr(3), pr(4, { merged_at: null })]);
    assert.equal(metrics.overall.acceptance_rate, 0.75);
});

test('Metrics: time to merge is hours from opening to merging, as median, p90 and max over merged PRs', () => {
    const cell = metricRows()['Time to merge (TTM)'];
    assert.deepEqual(codeSpans(cell), ['merged_at − created_at']);
    assert.match(cell, /in hours; reported as median, p90, max over merged PRs\./);
    const hours = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 100];
    const prs = [...hours.map((h, i) => mergedAfter(i + 1, h)), pr(99, { merged_at: null, closed_at: '2026-12-01T00:00:00Z' })];
    assert.deepEqual(computeMetrics(prs).overall.time_to_merge_hours, { median: 6, p90: 10, max: 100 });
});

test('Metrics: the agent branch prefixes and labels the page lists are the ones the script reads', () => {
    const cell = metricRows()['Agent vs human split'];
    const prefixes = /head branch starts with (.*?);/.exec(cell);
    assert.ok(prefixes, `${PAGE}: no branch prefix list`);
    assert.deepEqual(codeSpans(prefixes[1]), AGENT_BRANCH_PREFIXES);
    for (const prefix of codeSpans(prefixes[1])) {
        assert.equal(isAgentPR(pr(1, { head: { ref: `${prefix}x` } })), true, prefix);
    }
    const labels = /label (.*?);/.exec(cell);
    assert.ok(labels, `${PAGE}: no label list`);
    assert.deepEqual(codeSpans(labels[1]), AGENT_LABELS);
    for (const name of codeSpans(labels[1])) {
        assert.equal(isAgentPR(pr(1, { labels: [{ name }] })), true, name);
    }
});

test('Metrics: the bot account and trailer signals the page lists are agent-authored, and anything else is human', () => {
    const cell = metricRows()['Agent vs human split'];
    assert.ok(codeSpans(cell).includes('type: Bot'));
    assert.equal(isAgentPR(pr(1, { user: { login: 'someone', type: 'Bot' } })), true);
    assert.ok(codeSpans(cell).includes('[bot]'));
    assert.equal(isAgentPR(pr(1, { user: { login: 'someone[bot]', type: 'User' } })), true);
    const trailer = codeSpans(cell).find((s) => s.startsWith('Co-Authored-By: '));
    assert.equal(trailer, 'Co-Authored-By: Claude/Copilot/Codex');
    for (const name of trailer.slice('Co-Authored-By: '.length).split('/')) {
        assert.equal(isAgentPR(pr(1, { body: `Co-Authored-By: ${name} <x@example.com>` })), true, name);
    }
    assert.match(cell, /or "Generated with Claude"\./);
    assert.equal(isAgentPR(pr(1, { body: 'Generated with Claude' })), true);
    assert.match(cell, /Everything else is human\./);
    assert.equal(isAgentPR(pr(1)), false);
});

test('Metrics: agent share is agent closed over all closed', () => {
    assert.deepEqual(codeSpans(metricRows()['Agent share']), ['agent closed / all closed']);
    const metrics = computeMetrics([pr(1, { head: { ref: 'hive/x' } }), pr(2), pr(3), pr(4, { merged_at: null })]);
    assert.equal(metrics.agent_share_of_closed, 0.25);
});

test('Metrics: a revert is a closed PR titled Revert in any case, and the rate is over merged PRs', () => {
    const cell = metricRows().Reverts;
    assert.match(cell, /Closed PRs whose title starts with `Revert` \(case-insensitive\)\./);
    assert.equal(isRevert({ title: 'Revert "a change"' }), true);
    assert.equal(isRevert({ title: 'REVERT a change' }), true);
    assert.equal(isRevert({ title: 'Do not revert this' }), false);
    assert.match(cell, /\*\*Revert rate\*\* = `reverts \/ merged`\./);
    const metrics = computeMetrics([pr(1, { title: 'revert a change' }), pr(2), pr(3, { merged_at: null })]);
    assert.equal(metrics.overall.reverts, 1);
    assert.equal(metrics.revert_rate, 0.5);
});

test('Known limits: agent detection goes by the signals alone, whoever really wrote the PR', () => {
    const text = oneLine(section('## Known limits'));
    assert.ok(text.includes('A human PR with a Claude trailer counts as agent;'));
    assert.equal(isAgentPR(pr(1, { body: 'Co-Authored-By: Claude <x@example.com>' })), true);
    assert.ok(text.includes('an agent PR from a plain branch with no trailer counts as human.'));
    assert.equal(isAgentPR(pr(1, { head: { ref: 'plain-branch' } })), false);
});

test('Known limits: time to merge counts from opening, so draft time is included', () => {
    assert.ok(oneLine(section('## Known limits')).includes('TTM includes time a PR sat as a draft'));
    const wasDraft = mergedAfter(1, 48);
    wasDraft.draft = true;
    assert.equal(computeMetrics([wasDraft]).overall.time_to_merge_hours.max, 48);
});

test('Known limits: revert detection reads the title and nothing else', () => {
    assert.ok(oneLine(section('## Known limits')).includes('Revert detection is title-based;'));
    assert.equal(computeMetrics([pr(1, { body: 'This reverts commit abc123.' })]).overall.reverts, 0);
});

test('Known limits: the FORK-PATCHES section the page sends readers to exists', () => {
    assert.ok(section('## Known limits').includes('[FORK-PATCHES.md](../FORK-PATCHES.md) "Operational state"'));
    assert.match(read('FORK-PATCHES.md'), /^## Operational state/m);
});

test('Running it: the commands name every flag the script takes, and no other', () => {
    const commands = pageCommands().filter((c) => c.words[1] === SCRIPT);
    const named = new Set(commands.flatMap((c) => c.words.filter((w) => w.startsWith('--'))));
    assert.deepEqual([...named].sort(), scriptFlags());
});

test('Running it: the plain command reads this repository through gh and writes both snapshot files', () => {
    const today = () => new Date().toISOString().slice(0, 10);
    const before = today();
    const { gh, cwdFiles, stdout } = runPageCommand(pageCommand('gh api, writes docs/metrics/<today>.{md,json}'), [pr(1)]);
    const after = today();
    assert.ok(gh.startsWith('api '), gh);
    assert.ok(gh.includes(`repos/${DEFAULT_REPO}/pulls?state=closed`), gh);
    assert.equal(stdout, '');
    assert.ok([before, after].some((date) => cwdFiles.includes(path.join('docs', 'metrics', `${date}.md`))), cwdFiles.join());
    assert.ok([before, after].some((date) => cwdFiles.includes(path.join('docs', 'metrics', `${date}.json`))), cwdFiles.join());
});

test('Running it: --stdout prints the report and writes nothing', () => {
    const { stdout, cwdFiles } = runPageCommand(pageCommand('print only'), [pr(1)]);
    assert.match(stdout, /since 2026-10-01/);
    assert.ok(stdout.startsWith(`# PR metrics — ${DEFAULT_REPO}\n`), stdout);
    assert.deepEqual(cwdFiles, []);
});

test('Running it: --input reads a REST pull request array offline, into --out-dir', () => {
    const { gh, outFiles, cwdFiles } = runPageCommand(pageCommand('offline, REST pull-request array'), [pr(1)]);
    assert.equal(gh, '', 'the offline command called gh');
    assert.equal(outFiles.filter((f) => f.endsWith('.md')).length, 1, outFiles.join());
    assert.equal(outFiles.filter((f) => f.endsWith('.json')).length, 1, outFiles.join());
    assert.deepEqual(cwdFiles, []);
});

test('Running it: --repo reads another repository and --date names the files', () => {
    const words = pageCommand('another repository, files named for that date');
    const { gh, cwdFiles } = runPageCommand(words, [pr(1)]);
    const repo = words[words.indexOf('--repo') + 1];
    const date = words[words.indexOf('--date') + 1];
    assert.ok(gh.includes(`repos/${repo}/pulls`), gh);
    assert.ok(cwdFiles.includes(path.join('docs', 'metrics', `${date}.md`)), cwdFiles.join());
    assert.ok(cwdFiles.includes(path.join('docs', 'metrics', `${date}.json`)), cwdFiles.join());
});

test('Running it: the test command is the one CI runs', () => {
    const ci = /^ +run: (node --test.*)$/m.exec(read('.github/workflows/agent-tooling.yml'));
    assert.ok(ci, 'agent-tooling.yml has no node --test step');
    assert.equal(pageCommand('tests').join(' '), ci[1]);
});

test('the weekly run the page links is weekly, passes only flags the script takes and writes nothing to the repository', () => {
    const page = read(PAGE);
    assert.ok(page.includes('Weekly run: [`.github/workflows/pr-metrics.yml`](../.github/workflows/pr-metrics.yml).'));
    const workflow = read(WORKFLOW);
    assert.match(workflow, /cron: '\d+ \d+ \* \* [0-6]'/);
    assert.match(workflow, /node scripts\/pr-metrics\.mjs "\$\{args\[@\]\}"/);
    const passed = [...workflow.matchAll(/args(?:\+)?=\((.*)\)/g)].flatMap((m) => m[1].match(/--[\w-]+/g) ?? []);
    assert.ok(passed.length > 0, `${WORKFLOW}: no args found`);
    assert.deepEqual(passed.filter((f) => !scriptFlags().includes(f)), []);
    assert.doesNotMatch(workflow, /:\s*write\b/);
});

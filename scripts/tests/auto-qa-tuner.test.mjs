import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { windowRuns, summarize, judge, propose, renderReport, jsonLineDiff } from '../auto-qa-tuner.mjs';

const rules = { window_runs: 30, min_runs: 10, flaky_ratio_to_add_retry: 0.1, broken_ratio: 0.5, max_retries: 2 };
const NIGHTLY = 'nightly-compliance.yml';
const tuning = (retries = 0) => ({
    flaky: rules,
    workflows: { [NIGHTLY]: { tunable: true, retries }, 'ci.yml': { tunable: false } },
});
const run = (sha, conclusion, extra = {}) => ({ head_sha: sha, conclusion, run_attempt: 1, event: 'schedule', ...extra });
const greens = (n, from = 0) => Array.from({ length: n }, (_, i) => run(`sha${from + i}`, 'success'));

test('windowRuns drops cancelled/skipped and keeps newest first within the window', () => {
    const runs = [run('a', 'cancelled'), run('b', 'success'), run('c', 'skipped'), run('d', 'failure'), run('e', 'success')];
    assert.deepEqual(windowRuns(runs, 2).map((r) => r.head_sha), ['b', 'd']);
    assert.deepEqual(windowRuns(undefined, 5), []);
});

test('summarize counts failures and flaky commits (fail+pass on one sha, or pass on re-run)', () => {
    const s = summarize([
        run('a', 'success'),
        run('a', 'failure'),
        run('b', 'success', { run_attempt: 2 }),
        run('c', 'success'),
        run('d', 'timed_out'),
    ]);
    assert.equal(s.runs, 5);
    assert.equal(s.commits, 4);
    assert.equal(s.failures, 2);
    assert.equal(s.flakyCommits, 2);
    assert.equal(s.flakyRatio, 0.5);
});

test('fewer than min_runs: no change', () => {
    const stats = summarize(windowRuns([...greens(5), run('x', 'failure')], 30));
    assert.deepEqual(judge(stats, 0, rules), { verdict: 'insufficient-data', proposed: 0 });
});

test('consistently failing is broken: no retry added', () => {
    const runs = Array.from({ length: 12 }, (_, i) => run(`s${i}`, i % 2 ? 'failure' : 'success'));
    const r = propose(tuning(0), { [NIGHTLY]: runs });
    assert.equal(r.rows[0].verdict, 'broken');
    assert.equal(r.changes.length, 0);
});

test('flaky at the threshold adds one retry', () => {
    // 10 commits, one flaky (fail then pass on the same sha) = exactly 10%.
    const runs = [...greens(9), run('flake', 'success'), run('flake', 'failure')];
    const r = propose(tuning(0), { [NIGHTLY]: runs });
    assert.equal(r.rows[0].verdict, 'flaky');
    assert.deepEqual(r.changes, [{ file: NIGHTLY, from: 0, to: 1, verdict: 'flaky' }]);
    assert.equal(r.proposed.workflows[NIGHTLY].retries, 1);
});

test('retries never exceed max_retries', () => {
    const runs = [...greens(9), run('flake', 'success'), run('flake', 'failure')];
    const r = propose(tuning(2), { [NIGHTLY]: runs });
    assert.equal(r.changes.length, 0);
    assert.equal(r.proposed.workflows[NIGHTLY].retries, 2);
});

test('a clean window drops one retry, never below zero', () => {
    assert.equal(propose(tuning(2), { [NIGHTLY]: greens(12) }).proposed.workflows[NIGHTLY].retries, 1);
    assert.equal(propose(tuning(0), { [NIGHTLY]: greens(12) }).changes.length, 0);
});

test('non-tunable workflows are reported but never changed', () => {
    const flaky = [...greens(9), run('f', 'success'), run('f', 'failure')];
    const r = propose(tuning(0), { [NIGHTLY]: greens(12), 'ci.yml': flaky });
    const ci = r.rows.find((x) => x.file === 'ci.yml');
    assert.equal(ci.verdict, 'flaky');
    assert.equal(ci.proposed, null);
    assert.equal(r.changes.length, 0);
    assert.match(renderReport(r, rules), /\| ci\.yml \| 11 \| 1 \(9%\) \| 1\/10 \(10%\) \| flaky \| n\/a \| n\/a \|/);
});

test('report and diff show the change', () => {
    const runs = [...greens(9), run('flake', 'success'), run('flake', 'failure')];
    const r = propose(tuning(0), { [NIGHTLY]: runs });
    assert.match(renderReport(r, rules), /1 proposed change/);
    const d = jsonLineDiff(tuning(0), r.proposed);
    assert.match(d, /^-.*"retries": 0/m);
    assert.match(d, /^\+.*"retries": 1/m);
    assert.match(renderReport({ rows: [], changes: [] }, rules), /No tuning change warranted/);
});

test('CLI end to end: writes report and issue body, never touches the tuning file', () => {
    const root = mkdtempSync(join(tmpdir(), 'akmods-tuner-'));
    mkdirSync(join(root, '.github'));
    const tj = join(root, '.github/auto-qa-tuning.json');
    writeFileSync(tj, JSON.stringify(tuning(0), null, 4));
    const runsPath = join(root, 'runs.json');
    writeFileSync(runsPath, JSON.stringify({ [NIGHTLY]: [...greens(9), run('flake', 'success'), run('flake', 'failure')] }));
    const before = readFileSync(tj, 'utf8');
    const out = join(root, 'out');
    const outputFile = join(root, 'gh-output');
    const res = spawnSync(
        process.execPath,
        [new URL('../auto-qa-tuner.mjs', import.meta.url).pathname, '--root', root, '--runs', runsPath, '--out-dir', out],
        { encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: outputFile } }
    );
    assert.equal(res.status, 0, res.stderr);
    assert.equal(readFileSync(outputFile, 'utf8'), 'propose=true\n');
    assert.match(readFileSync(join(out, 'issue-body.md'), 'utf8'), /```diff[\s\S]*\+.*"retries": 1/);
    assert.equal(readFileSync(tj, 'utf8'), before);
});

test('CLI without --runs exits 2', () => {
    const res = spawnSync(process.execPath, [new URL('../auto-qa-tuner.mjs', import.meta.url).pathname], { encoding: 'utf8' });
    assert.equal(res.status, 2);
});

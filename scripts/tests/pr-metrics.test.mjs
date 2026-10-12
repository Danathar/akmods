import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeMetrics, isAgentPR, isRevert, median, parseArgs, renderMarkdown, run } from '../pr-metrics.mjs';

const pr = (n, o = {}) => ({
  number: n,
  title: `PR ${n}`,
  user: { login: 'Danathar', type: 'User' },
  head: { ref: `fix/${n}` },
  labels: [],
  body: '',
  created_at: '2026-10-01T00:00:00Z',
  closed_at: '2026-10-01T02:00:00Z',
  merged_at: '2026-10-01T02:00:00Z',
  ...o,
});

test('isAgentPR detects bot, branch prefix, label, trailer', () => {
  assert.equal(isAgentPR(pr(1)), false);
  assert.equal(isAgentPR(pr(2, { user: { login: 'x[bot]', type: 'Bot' } })), true);
  assert.equal(isAgentPR(pr(3, { head: { ref: 'acmm/d2' } })), true);
  assert.equal(isAgentPR(pr(4, { labels: [{ name: 'AI-Generated' }] })), true);
  assert.equal(isAgentPR(pr(5, { body: 'Co-Authored-By: Claude <x>' })), true);
});

test('isRevert matches Revert titles only at start', () => {
  assert.equal(isRevert({ title: 'Revert "foo"' }), true);
  assert.equal(isRevert({ title: 'Do not revert this' }), false);
});

test('median handles empty/even/odd', () => {
  assert.equal(median([]), null);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
});

test('computeMetrics: acceptance, ttm, split, reverts, ignores open', () => {
  const prs = [
    pr(1),
    pr(2, { head: { ref: 'acmm/a' }, created_at: '2026-10-01T00:00:00Z', merged_at: '2026-10-01T10:00:00Z', closed_at: '2026-10-01T10:00:00Z' }),
    pr(3, { merged_at: null }),
    pr(4, { title: 'Revert "PR 1"' }),
    { ...pr(5), closed_at: null, merged_at: null },
  ];
  const m = computeMetrics(prs, { generatedAt: 'T' });
  assert.equal(m.overall.closed, 4);
  assert.equal(m.overall.merged, 3);
  assert.equal(m.overall.acceptance_rate, 0.75);
  assert.equal(m.overall.time_to_merge_hours.median, 2);
  assert.equal(m.overall.time_to_merge_hours.max, 10);
  assert.equal(m.agent.closed, 1);
  assert.equal(m.human.closed, 3);
  assert.equal(m.overall.reverts, 1);
  assert.equal(m.revert_rate, 0.3333);
  assert.equal(m.agent_share_of_closed, 0.25);
});

test('computeMetrics: since filter and empty input', () => {
  const m = computeMetrics([pr(1)], { since: '2026-11-01' });
  assert.equal(m.overall.closed, 0);
  assert.equal(m.overall.acceptance_rate, null);
  assert.match(renderMarkdown(m), /n\/a/);
});

test('parseArgs validates', () => {
  assert.throws(() => parseArgs(['--bogus']));
  assert.throws(() => parseArgs(['--date', 'nope']));
  assert.throws(() => parseArgs(['--repo', 'bad']));
  assert.throws(() => parseArgs(['--repo']));
  assert.equal(parseArgs(['--stdout']).stdout, true);
});

test('run reads a file input and writes md + json', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prm-'));
  const input = join(dir, 'prs.json');
  writeFileSync(input, JSON.stringify([pr(1), pr(2, { merged_at: null })]));
  const { metrics } = run(['--input', input, '--out-dir', dir, '--date', '2026-10-11'], { now: () => new Date('2026-10-11T00:00:00Z') });
  assert.equal(metrics.overall.acceptance_rate, 0.5);
  assert.match(readFileSync(join(dir, '2026-10-11.md'), 'utf8'), /Acceptance/);
  assert.equal(JSON.parse(readFileSync(join(dir, '2026-10-11.json'), 'utf8')).repo, 'Danathar/akmods');
});

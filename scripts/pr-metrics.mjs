#!/usr/bin/env node
// PR metrics for this fork: acceptance rate, time-to-merge, agent vs human split, reverts.
// Dependency-free ESM. Definitions live in docs/metrics.md — keep the two in sync.
//
// Usage:
//   node scripts/pr-metrics.mjs [--repo OWNER/REPO] [--input prs.json] [--out-dir DIR]
//                               [--date YYYY-MM-DD] [--since YYYY-MM-DD] [--stdout]
//
// --input takes a JSON array in the shape of `gh api repos/:owner/:repo/pulls?state=closed`
// (REST pull objects). Without --input the script calls `gh api --paginate`.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_REPO = 'Danathar/akmods';
export const AGENT_BRANCH_PREFIXES = ['acmm/', 'claude/', 'copilot/', 'codex/', 'ai-fix/', 'hive/', 'agent/'];
export const AGENT_LABELS = ['agent', 'ai-generated', 'ai-fix', 'hive'];

export function parseArgs(argv) {
  const opts = { repo: DEFAULT_REPO, input: null, outDir: 'docs/metrics', date: null, since: null, stdout: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`missing value for ${a}`);
      return argv[++i];
    };
    if (a === '--repo') opts.repo = next();
    else if (a === '--input') opts.input = next();
    else if (a === '--out-dir') opts.outDir = next();
    else if (a === '--date') opts.date = next();
    else if (a === '--since') opts.since = next();
    else if (a === '--stdout') opts.stdout = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  for (const k of ['date', 'since']) {
    if (opts[k] && !/^\d{4}-\d{2}-\d{2}$/.test(opts[k])) throw new Error(`--${k} must be YYYY-MM-DD`);
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(opts.repo)) throw new Error('--repo must be OWNER/REPO');
  return opts;
}

/** True when the PR looks agent-authored (bot account, agent branch prefix, agent label, or agent trailer). */
export function isAgentPR(pr) {
  const user = pr.user ?? {};
  if (user.type === 'Bot' || /\[bot\]$/i.test(user.login ?? '')) return true;
  const ref = pr.head?.ref ?? pr.headRefName ?? '';
  if (AGENT_BRANCH_PREFIXES.some((p) => ref.startsWith(p))) return true;
  const labels = (pr.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name ?? '').toLowerCase());
  if (labels.some((l) => AGENT_LABELS.includes(l))) return true;
  return /co-authored-by:\s*(claude|copilot|codex)|generated with \[?claude/i.test(pr.body ?? '');
}

export function isRevert(pr) {
  return /^revert\b/i.test((pr.title ?? '').trim());
}

const hours = (from, to) => (Date.parse(to) - Date.parse(from)) / 3_600_000;

export function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function percentile(values, p) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
}

const round = (n, d = 2) => (n === null ? null : Math.round(n * 10 ** d) / 10 ** d);
const rate = (num, den) => (den ? round(num / den, 4) : null);

function group(prs) {
  const merged = prs.filter((p) => p.merged_at);
  const closedUnmerged = prs.length - merged.length;
  const ttm = merged.map((p) => hours(p.created_at, p.merged_at)).filter((h) => h >= 0);
  return {
    closed: prs.length,
    merged: merged.length,
    closed_unmerged: closedUnmerged,
    acceptance_rate: rate(merged.length, prs.length),
    time_to_merge_hours: {
      median: round(median(ttm)),
      p90: round(percentile(ttm, 90)),
      max: round(ttm.length ? Math.max(...ttm) : null),
    },
    reverts: prs.filter(isRevert).length,
  };
}

/** prs: REST pull objects. Open PRs (state !== 'closed') are ignored. */
export function computeMetrics(prs, { repo = DEFAULT_REPO, since = null, generatedAt = null } = {}) {
  const sinceMs = since ? Date.parse(`${since}T00:00:00Z`) : null;
  const closed = prs.filter((p) => p.closed_at && (sinceMs === null || Date.parse(p.closed_at) >= sinceMs));
  const agent = closed.filter(isAgentPR);
  const human = closed.filter((p) => !isAgentPR(p));
  const all = group(closed);
  return {
    repo,
    generated_at: generatedAt,
    since,
    window: {
      first_closed: closed.length ? closed.map((p) => p.closed_at).sort()[0] : null,
      last_closed: closed.length ? closed.map((p) => p.closed_at).sort().at(-1) : null,
    },
    overall: all,
    agent: group(agent),
    human: group(human),
    agent_share_of_closed: rate(agent.length, closed.length),
    revert_rate: rate(all.reverts, all.merged),
    reverts: closed.filter(isRevert).map((p) => ({ number: p.number, title: p.title })),
  };
}

const pct = (r) => (r === null ? 'n/a' : `${(r * 100).toFixed(1)}%`);
const hr = (h) => (h === null ? 'n/a' : `${h}h`);

export function renderMarkdown(m) {
  const row = (name, g) =>
    `| ${name} | ${g.closed} | ${g.merged} | ${g.closed_unmerged} | ${pct(g.acceptance_rate)} | ${hr(g.time_to_merge_hours.median)} | ${hr(g.time_to_merge_hours.p90)} | ${g.reverts} |`;
  const lines = [
    `# PR metrics — ${m.repo}`,
    '',
    `Generated: ${m.generated_at ?? 'n/a'}${m.since ? ` · since ${m.since}` : ''} · window: ${m.window.first_closed ?? 'n/a'} → ${m.window.last_closed ?? 'n/a'}`,
    '',
    'Definitions: [docs/metrics.md](../metrics.md). Only closed PRs are counted.',
    '',
    '| Group | Closed | Merged | Closed unmerged | Acceptance | TTM median | TTM p90 | Reverts |',
    '|---|---:|---:|---:|---:|---:|---:|---:|',
    row('All', m.overall),
    row('Agent', m.agent),
    row('Human', m.human),
    '',
    `- Agent share of closed PRs: **${pct(m.agent_share_of_closed)}**`,
    `- Revert rate (reverts / merged): **${pct(m.revert_rate)}**`,
  ];
  if (m.reverts.length) {
    lines.push('', '## Reverts', '', ...m.reverts.map((r) => `- #${r.number} ${r.title}`));
  }
  return `${lines.join('\n')}\n`;
}

function fetchPulls(repo) {
  const out = execFileSync('gh', ['api', '--paginate', '--slurp', `repos/${repo}/pulls?state=closed&per_page=100`], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  return JSON.parse(out).flat();
}

export function run(argv, { now = () => new Date() } = {}) {
  const opts = parseArgs(argv);
  const prs = opts.input ? JSON.parse(readFileSync(opts.input, 'utf8')) : fetchPulls(opts.repo);
  if (!Array.isArray(prs)) throw new Error('input must be a JSON array of pull requests');
  const ts = now();
  const date = opts.date ?? ts.toISOString().slice(0, 10);
  const metrics = computeMetrics(prs, { repo: opts.repo, since: opts.since, generatedAt: ts.toISOString() });
  const md = renderMarkdown(metrics);
  if (opts.stdout) process.stdout.write(md);
  else {
    mkdirSync(opts.outDir, { recursive: true });
    writeFileSync(join(opts.outDir, `${date}.md`), md);
    writeFileSync(join(opts.outDir, `${date}.json`), `${JSON.stringify(metrics, null, 2)}\n`);
  }
  return { metrics, md, date };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    run(process.argv.slice(2));
  } catch (e) {
    console.error(`pr-metrics: ${e.message}`);
    process.exit(1);
  }
}

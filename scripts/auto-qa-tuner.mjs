#!/usr/bin/env node
// Auto-QA flaky-check tuner. Reads recent workflow-run history (collected by
// .github/workflows/auto-qa.yml with `gh api`) and proposes bounded changes to
// the per-workflow `retries` values in .github/auto-qa-tuning.json. It never
// writes that file or commits anything: output goes to --out-dir for the
// workflow to publish as a step summary and a tracking issue. Rules (and
// their bounds) are documented in the "flaky.note" field of the tuning file.
//
// runs.json shape: { "<workflow file>": [ { conclusion, head_sha, run_attempt, event } ... ] }
// newest first, as returned by the GitHub REST API.
//
// Usage: node scripts/auto-qa-tuner.mjs --runs runs.json [--root <dir>] [--out-dir <dir>]
import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const COMPLETED = new Set(['success', 'failure', 'timed_out']);
const FAILED = new Set(['failure', 'timed_out']);

/** Completed runs inside the window (newest first), cancelled/skipped dropped. */
export function windowRuns(runs, windowRuns) {
    return (runs ?? []).filter((r) => COMPLETED.has(r?.conclusion)).slice(0, windowRuns);
}

/**
 * @returns {{runs:number, commits:number, failures:number, failureRatio:number,
 *            flakyCommits:number, flakyRatio:number}}
 */
export function summarize(runs) {
    const bySha = new Map();
    let failures = 0;
    for (const r of runs) {
        const e = bySha.get(r.head_sha) ?? { fail: false, pass: false, rerunPass: false };
        if (FAILED.has(r.conclusion)) {
            failures += 1;
            e.fail = true;
        } else {
            e.pass = true;
            if (Number(r.run_attempt) > 1) e.rerunPass = true;
        }
        bySha.set(r.head_sha, e);
    }
    let flakyCommits = 0;
    for (const e of bySha.values()) if ((e.fail && e.pass) || e.rerunPass) flakyCommits += 1;
    const commits = bySha.size;
    return {
        runs: runs.length,
        commits,
        failures,
        failureRatio: runs.length ? failures / runs.length : 0,
        flakyCommits,
        flakyRatio: commits ? flakyCommits / commits : 0,
    };
}

/**
 * Applies the rules to one workflow. `current` is its retries value or null
 * when the workflow is not tunable. Returns the verdict and the proposed value.
 */
export function judge(stats, current, rules) {
    if (stats.runs < rules.min_runs) {
        return { verdict: 'insufficient-data', proposed: current };
    }
    if (stats.failureRatio >= rules.broken_ratio) {
        return { verdict: 'broken', proposed: current };
    }
    if (stats.flakyRatio >= rules.flaky_ratio_to_add_retry) {
        const proposed = current === null ? null : Math.min(current + 1, rules.max_retries);
        return { verdict: 'flaky', proposed };
    }
    if (stats.failures === 0 && current !== null && current > 0) {
        return { verdict: 'stable', proposed: Math.max(current - 1, 0) };
    }
    return { verdict: 'ok', proposed: current };
}

/**
 * @param {object} tuning parsed .github/auto-qa-tuning.json
 * @param {Record<string, object[]>} runsByWorkflow
 */
export function propose(tuning, runsByWorkflow) {
    const rules = tuning.flaky;
    const proposed = structuredClone(tuning);
    const rows = [];
    const changes = [];
    for (const [file, cfg] of Object.entries(tuning.workflows)) {
        const stats = summarize(windowRuns(runsByWorkflow[file], rules.window_runs));
        const current = cfg.tunable ? Number(cfg.retries ?? 0) : null;
        const { verdict, proposed: next } = judge(stats, current, rules);
        rows.push({ file, stats, verdict, current, proposed: next });
        if (cfg.tunable && next !== current) {
            changes.push({ file, from: current, to: next, verdict });
            proposed.workflows[file].retries = next;
        }
    }
    return { rows, changes, proposed };
}

const pct = (x) => `${Math.round(x * 100)}%`;

export function renderReport({ rows, changes }, rules) {
    const out = [
        '## Auto-QA flaky-check tuning',
        '',
        `Window: last ${rules.window_runs} completed runs on main per workflow (at least ${rules.min_runs} needed). Retries stay within 0..${rules.max_retries}, change by at most 1 per run, and are never applied automatically.`,
        '',
        '| workflow | runs | failed | flaky commits | verdict | retries now | proposed |',
        '| --- | ---: | ---: | ---: | --- | ---: | ---: |',
    ];
    for (const r of rows) {
        const cur = r.current === null ? 'n/a' : r.current;
        const next = r.current === null ? 'n/a' : r.proposed;
        out.push(
            `| ${r.file} | ${r.stats.runs} | ${r.stats.failures} (${pct(r.stats.failureRatio)}) | ${r.stats.flakyCommits}/${r.stats.commits} (${pct(r.stats.flakyRatio)}) | ${r.verdict} | ${cur} | ${next} |`
        );
    }
    out.push('', changes.length ? `${changes.length} proposed change(s).` : 'No tuning change warranted.');
    const broken = rows.filter((r) => r.verdict === 'broken').map((r) => r.file);
    if (broken.length) {
        out.push('', `Broken (not flaky), needs a fix rather than a retry: ${broken.join(', ')}.`);
    }
    return out.join('\n') + '\n';
}

/** Line diff of two JSON documents with identical shape (same key order). */
export function jsonLineDiff(before, after) {
    const a = JSON.stringify(before, null, 4).split('\n');
    const b = JSON.stringify(after, null, 4).split('\n');
    const out = [];
    a.forEach((line, i) => {
        if (line !== b[i]) out.push(`-${line}`, `+${b[i]}`);
    });
    return out.join('\n');
}

function main(argv) {
    const arg = (name, dflt) => {
        const i = argv.indexOf(name);
        return i >= 0 ? argv[i + 1] : dflt;
    };
    const root = resolve(arg('--root', process.cwd()));
    const outDir = resolve(arg('--out-dir', 'auto-qa-out'));
    const runsPath = arg('--runs', null);
    if (!runsPath) {
        process.stderr.write('auto-qa-tuner: --runs <runs.json> is required\n');
        process.exit(2);
    }
    const tuning = JSON.parse(readFileSync(resolve(root, '.github/auto-qa-tuning.json'), 'utf8'));
    const runs = JSON.parse(readFileSync(resolve(runsPath), 'utf8'));
    const result = propose(tuning, runs);
    const report = renderReport(result, tuning.flaky);
    mkdirSync(outDir, { recursive: true });
    let issueBody = '';
    if (result.changes.length) {
        issueBody =
            report +
            '\nProposed change to `.github/auto-qa-tuning.json` (apply by hand in a pull request):\n\n```diff\n' +
            jsonLineDiff(tuning, result.proposed) +
            '\n```\n';
    }
    writeFileSync(resolve(outDir, 'report.md'), report);
    writeFileSync(resolve(outDir, 'issue-body.md'), issueBody);
    process.stdout.write(report);
    if (process.env.GITHUB_OUTPUT) {
        appendFileSync(process.env.GITHUB_OUTPUT, `propose=${result.changes.length > 0}\n`);
    }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
    main(process.argv.slice(2));
}

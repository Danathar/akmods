#!/usr/bin/env node
// Mutation check on the lines a pull request changes (advisory, #192).
//
// A guard-hook fix can merge with every test green and still have lines no
// test notices when they are broken; until now a later hand mutation audit
// found those, and a test-only PR pinned them. This script does that audit
// for the changed lines of each pull request:
//   1. `git diff -U0 <base>...HEAD` gives the added and changed lines of the
//      guard hook and its shared reader (.claude/hooks/*.mjs) and of the
//      helper scripts (scripts/*.mjs). Tests are never mutated.
//   2. Each group runs StrykerJS once with its built-in `command` test runner
//      and `--mutate file:start-end` ranges: hook files against the hook
//      tests and the shared refusal corpus, a script against its own
//      scripts/tests/<name>.test.mjs. scripts/tests/shell-reader.test.mjs is
//      never in a command: it pins the reader's hash, so it fails for every
//      mutant and would count each one as killed.
//   3. Every mutant the tests did not notice (Survived or NoCoverage) that is
//      not an accepted entry in .mutation-survivors.json is reported, with a
//      ready-to-fill ledger entry, on stdout and in the step summary.
// Exit status: 0 nothing new, 1 a new survivor (or a changed script with no
// test file), 2 the check could not run (bad arguments, git or Stryker
// failure, unreadable ledger or report).
// Usage: node scripts/mutation-check.mjs [--base <ref>] [--stryker <bin>]
//        [--ledger <file>] [--root <dir>] [--budget-minutes <n>] [--dry-run]
//        [--report <json>]...
// --dry-run prints the Stryker runs it would start and stops. --report skips
// git and Stryker and checks existing Stryker JSON reports against the ledger.
// --budget-minutes is a wall-clock limit for the whole run (#216). A run of
// hundreds of mutants can outlast the CI job, and a job cut off by its own
// timeout reports `cancelled`, which blocks the merge even though the job is
// advisory. At the budget the Stryker run in progress is killed with its
// whole process group, the remaining groups are skipped, a notice says the
// results are incomplete, and the survivors of the groups that finished are
// reported with the usual exit status. Without the option there is no limit.
// Stryker is not a dependency of this repository: CI installs a pinned copy
// outside the checkout and passes its binary with --stryker. See
// docs/quality.md.
import { appendFileSync, existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';

export const LEDGER = '.mutation-survivors.json';
export const CONFIG = 'stryker.config.mjs';
export const SURVIVING = new Set(['Survived', 'NoCoverage']);

// The tests that exercise the guard hook and its reader. shell-reader.test.mjs
// is left out on purpose (see the header).
export const HOOK_TESTS = ['.claude/hooks/tests/guard-bash.test.mjs', 'scripts/tests/gate-refusal-corpus.test.mjs'];
export const HASH_PIN_TESTS = new Set(['scripts/tests/shell-reader.test.mjs']);

const HOOK_SOURCE = /^\.claude\/hooks\/[^/]+\.mjs$/;
const SCRIPT_SOURCE = /^scripts\/([^/]+)\.mjs$/;

function unquote(path) {
    if (!path.startsWith('"')) return path;
    return JSON.parse(path);
}

/**
 * Added or changed line ranges per file from `git diff -U0` output. Hunks
 * that only delete lines add nothing: there is no new line to mutate.
 * Adjacent or overlapping ranges are merged.
 * @param {string} diff
 * @returns {Map<string, {start: number, end: number}[]>} 1-based, inclusive
 */
export function parseDiff(diff) {
    const out = new Map();
    let file = null;
    // New-side lines still owed to the current hunk, so an added line that
    // itself starts with "++ " is read as content, not as a file header.
    // Removed lines and "\ No newline" markers never look like a header, so
    // only added and context lines are counted.
    let newLeft = 0;
    for (const line of diff.split('\n')) {
        if (newLeft > 0 && (line.startsWith('+') || line.startsWith(' '))) {
            newLeft--;
            continue;
        }
        if (line.startsWith('+++ ')) {
            // A deleted file's target is /dev/null; its hunks add no line.
            file = unquote(line.slice(4)).replace(/^b\//, '');
            continue;
        }
        const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
        if (!hunk) continue;
        newLeft = hunk[2] === undefined ? 1 : Number(hunk[2]);
        if (file === null || newLeft === 0) continue;
        const start = Number(hunk[1]);
        const ranges = out.get(file) ?? [];
        ranges.push({ start, end: start + newLeft - 1 });
        out.set(file, ranges);
    }
    for (const [f, ranges] of out) {
        ranges.sort((a, b) => a.start - b.start);
        const merged = [];
        for (const r of ranges) {
            const last = merged.at(-1);
            if (last && r.start <= last.end + 1) {
                last.end = Math.max(last.end, r.end);
            } else {
                merged.push({ ...r });
            }
        }
        out.set(f, merged);
    }
    return out;
}

/**
 * Which tests a changed file is mutated against.
 * @param {string} file repository-relative path
 * @param {string[]} testFiles repository-relative scripts/tests/*.test.mjs files that exist
 * @returns {{name: string, tests: string[]}|null} null when the file is not mutated;
 *   a script with no test file gets an empty `tests`
 */
export function groupFor(file, testFiles) {
    if (HOOK_SOURCE.test(file)) return { name: 'hooks', tests: [...HOOK_TESTS] };
    const m = SCRIPT_SOURCE.exec(file);
    if (!m) return null;
    const own = `scripts/tests/${m[1]}.test.mjs`;
    const tests = testFiles.includes(own) && !HASH_PIN_TESTS.has(own) ? [own] : [];
    return { name: `scripts-${m[1]}`, tests };
}

/** The shell command Stryker's command runner runs for each mutant. */
export function testCommand(tests) {
    return `node --test ${tests.join(' ')}`;
}

/**
 * The Stryker runs for a set of changed lines, one per test command, and the
 * changed scripts that have no test file to run.
 * @param {Map<string, {start: number, end: number}[]>} changed from parseDiff
 * @param {string[]} testFiles see groupFor
 * @returns {{runs: {name: string, command: string, mutate: string[]}[], untested: string[]}}
 */
export function planRuns(changed, testFiles) {
    const runs = new Map();
    const untested = [];
    for (const file of [...changed.keys()].sort()) {
        const ranges = changed.get(file);
        const group = groupFor(file, testFiles);
        if (!group) continue;
        if (!group.tests.length) {
            untested.push(file);
            continue;
        }
        const run = runs.get(group.name) ?? { name: group.name, command: testCommand(group.tests), mutate: [] };
        for (const r of ranges) run.mutate.push(`${file}:${r.start}-${r.end}`);
        runs.set(group.name, run);
    }
    return { runs: [...runs.values()], untested };
}

const norm = (s) => s.replace(/\s+/g, ' ').trim();

/**
 * The source text a mutant replaced. Report locations are 1-based lines and
 * 1-based columns, end exclusive.
 */
export function originalText(source, location) {
    const lines = source.split('\n');
    const { start, end } = location;
    if (start.line === end.line) {
        return lines[start.line - 1].slice(start.column - 1, end.column - 1);
    }
    const parts = [lines[start.line - 1].slice(start.column - 1)];
    for (let l = start.line; l < end.line - 1; l++) parts.push(lines[l]);
    parts.push(lines[end.line - 1].slice(0, end.column - 1));
    return parts.join('\n');
}

/**
 * Surviving mutants in a Stryker JSON report (mutation-testing-report-schema).
 * @param {object} report parsed JSON report
 * @param {string} root repository root, to make absolute report paths relative
 */
export function survivors(report, root = process.cwd()) {
    const out = [];
    // `files`, `source` and `mutants` are required by the report schema.
    for (const [key, entry] of Object.entries(report.files)) {
        const file = (isAbsolute(key) ? relative(root, key) : key).replace(/\\/g, '/');
        for (const m of entry.mutants) {
            if (!SURVIVING.has(m.status)) continue;
            out.push({
                file,
                line: m.location.start.line,
                column: m.location.start.column,
                status: m.status,
                mutator: m.mutatorName,
                original: originalText(entry.source, m.location),
                replacement: m.replacement ?? '',
            });
        }
    }
    return out.sort((a, b) =>
        a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line || a.column - b.column,
    );
}

/**
 * Check the ledger's shape. Every entry names the file, mutator, original and
 * replacement text, and a reason it is accepted.
 * @returns {string[]} problems; empty when the ledger is usable
 */
export function validateLedger(ledger) {
    if (!ledger || !Array.isArray(ledger.survivors)) {
        return ['ledger has no "survivors" array'];
    }
    const problems = [];
    ledger.survivors.forEach((e, i) => {
        for (const key of ['file', 'mutator', 'original', 'replacement', 'reason']) {
            if (typeof e?.[key] !== 'string' || (key !== 'replacement' && !e[key].trim())) {
                problems.push(`survivors[${i}]: "${key}" must be a non-empty string`);
            }
        }
    });
    return problems;
}

/**
 * A ledger entry accepts a survivor when file, mutator, original text and
 * replacement all match (whitespace collapsed). Line numbers are not part of
 * the match, so an entry survives edits elsewhere in the file.
 */
export function isAccepted(survivor, ledger) {
    return ledger.survivors.some(
        (e) =>
            e.file === survivor.file &&
            e.mutator === survivor.mutator &&
            norm(e.original) === norm(survivor.original) &&
            norm(e.replacement) === norm(survivor.replacement),
    );
}

/** @returns {{fresh: object[], accepted: object[]}} */
export function evaluate(found, ledger) {
    const fresh = [];
    const accepted = [];
    for (const s of found) (isAccepted(s, ledger) ? accepted : fresh).push(s);
    return { fresh, accepted };
}

export function formatSurvivor(s) {
    const one = (t) => norm(t).slice(0, 80);
    return `${s.file}:${s.line}:${s.column} ${s.mutator} (${s.status}): \`${one(s.original)}\` -> \`${one(s.replacement)}\``;
}

export function ledgerEntry(s) {
    return {
        file: s.file,
        mutator: s.mutator,
        original: s.original,
        replacement: s.replacement,
        reason: 'TODO: why this survivor is equivalent or harmless over-refusal',
    };
}

/**
 * The one-line notice for a run that hit its budget.
 * @param {{minutes: number, cut: string|null, skipped: string[]}} stopped the
 *   budget, the group that was killed mid-run (if any) and the groups never started
 */
export function budgetNotice(stopped) {
    const left = [];
    if (stopped.cut) left.push(`${stopped.cut} was cut off and none of its mutants are counted`);
    if (stopped.skipped.length) left.push(`${stopped.skipped.join(', ')} not run`);
    return (
        `mutation run stopped at its time budget (${stopped.minutes} min); results are incomplete` +
        (left.length ? `: ${left.join('; ')}` : '')
    );
}

/**
 * The step-summary text: what is new, how to resolve it, and the ledger
 * entries to fill in when a survivor is accepted rather than tested.
 */
export function summarize(fresh, accepted, untested = [], stopped = null) {
    const lines = ['## Mutation check on changed lines (advisory)', ''];
    if (stopped) lines.push(`**${budgetNotice(stopped)}**`, '');
    if (!fresh.length && !untested.length) {
        lines.push(
            stopped
                ? `No new surviving mutants among those that ran (${accepted.length} accepted in the ledger).`
                : `No new surviving mutants (${accepted.length} accepted in the ledger).`,
        );
        return lines.join('\n');
    }
    if (untested.length) {
        lines.push(
            'Changed scripts with no `scripts/tests/<name>.test.mjs` to run, so no line of them is checked:',
            '',
            ...untested.map((f) => `- ${f}`),
            '',
        );
    }
    if (fresh.length) {
        lines.push(
            `${fresh.length} mutant(s) on changed lines survived: the line can be broken this way without any test failing.`,
            '',
            ...fresh.map((s) => `- ${formatSurvivor(s)}`),
            '',
            'Add a test that fails on each. If a survivor is equivalent (behaves the same) or harmless ' +
                `over-refusal, add its entry below to \`${LEDGER}\` with a real reason instead.`,
            '',
            '```json',
            JSON.stringify(fresh.map(ledgerEntry), null, 4),
            '```',
        );
    }
    lines.push('', `${accepted.length} survivor(s) accepted in the ledger.`);
    return lines.join('\n');
}

function fail(message) {
    console.error(`mutation-check: ${message}`);
    process.exit(2);
}

function parseArgs(argv) {
    const opts = {
        base: 'origin/main',
        ledger: LEDGER,
        root: process.cwd(),
        stryker: null,
        budgetMinutes: null,
        dryRun: false,
        reports: [],
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const value = () => {
            const v = argv[++i];
            if (v === undefined || v.startsWith('--')) fail(`${a} needs a value`);
            return v;
        };
        if (a === '--base') opts.base = value();
        else if (a === '--ledger') opts.ledger = value();
        else if (a === '--root') opts.root = value();
        else if (a === '--stryker') opts.stryker = value();
        else if (a === '--budget-minutes') {
            const v = value();
            opts.budgetMinutes = Number(v);
            if (!/^\d+(\.\d+)?$/.test(v) || !(opts.budgetMinutes > 0)) {
                fail(`--budget-minutes needs a positive number of minutes, got ${v}`);
            }
        } else if (a === '--report') opts.reports.push(value());
        else if (a === '--dry-run') opts.dryRun = true;
        else fail(`unknown argument ${a}`);
    }
    opts.root = resolve(opts.root);
    return opts;
}

function readJson(path, what) {
    try {
        return JSON.parse(readFileSync(path, 'utf8'));
    } catch (e) {
        return fail(`cannot read ${what} ${path}: ${e.message}`);
    }
}

function changedLines(root, base) {
    try {
        const diff = execFileSync(
            'git',
            ['diff', '-U0', '--no-color', '--no-ext-diff', '--no-renames', '--diff-filter=AM', `${base}...HEAD`],
            { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
        );
        return parseDiff(diff);
    } catch (e) {
        return fail(`git diff against ${base} failed: ${e.message}`);
    }
}

function listTests(root) {
    // scripts/tests always exists: it holds this script's own tests.
    const dir = resolve(root, 'scripts/tests');
    // groupFor only looks for scripts/tests/<name>.test.mjs, so other entries
    // (fixtures, helpers) are harmless.
    return readdirSync(dir).map((n) => `scripts/tests/${n}`);
}

const KILL_GRACE_MS = 5000;

/**
 * Stryker for one group, killed with its process group (the test processes it
 * starts too) if it is still running after `limitMs`.
 * @returns {Promise<{report: object, cut: boolean}>} `cut` when the budget
 *   killed it; none of its mutants are counted then
 */
async function runStryker(root, bin, run, limitMs) {
    const report = `reports/mutation/${run.name}.json`;
    rmSync(resolve(root, report), { force: true });
    console.log(`\n== ${run.name}: mutating ${run.mutate.length} range(s) against \`${run.command}\``);
    for (const m of run.mutate) console.log(`   ${m}`);
    const env = { ...process.env, MUTATION_TEST_COMMAND: run.command, MUTATION_REPORT: report };
    // With a budget Stryker gets a process group of its own, so that the budget
    // can end it with its test processes. Without one it stays in ours, and
    // Ctrl-C in a terminal stops it as usual.
    const detached = limitMs !== null;
    let child;
    let timer = null;
    let cut = false;
    const killGroup = (signal) => {
        try {
            process.kill(-child.pid, signal);
        } catch {
            // The group is already gone.
        }
    };
    let status;
    let signal;
    try {
        child = spawn(process.execPath, [bin, 'run', CONFIG, '--mutate', run.mutate.join(',')], {
            cwd: root,
            env,
            stdio: 'inherit',
            detached,
        });
        if (detached) {
            timer = setTimeout(() => {
                cut = true;
                killGroup('SIGTERM');
                timer = setTimeout(() => killGroup('SIGKILL'), KILL_GRACE_MS);
            }, limitMs);
        }
        [status, signal] = await once(child, 'close');
    } catch (e) {
        // spawn throws for some failures (E2BIG: the ranges do not fit in one
        // argument), and `once` rejects on the 'error' event of the others.
        fail(`cannot start Stryker (${run.name}): ${e.message}`);
    }
    clearTimeout(timer);
    // Children Stryker started may outlive it; end whatever is left of the group.
    if (detached) killGroup('SIGKILL');
    // Stryker writes its report at the end, so a run that was cut off has none.
    if (cut) return { report: { files: {} }, cut };
    if (status !== 0) fail(`Stryker (${run.name}) exited with ${status ?? signal}`);
    const path = resolve(root, report);
    // Stryker writes no report when the ranges hold no code it can mutate.
    return { report: existsSync(path) ? readJson(path, 'Stryker report') : { files: {} }, cut };
}

async function main(argv) {
    const started = Date.now();
    const opts = parseArgs(argv);
    const ledgerPath = resolve(opts.root, opts.ledger);
    const ledger = existsSync(ledgerPath) ? readJson(ledgerPath, 'ledger') : { survivors: [] };
    const problems = validateLedger(ledger);
    if (problems.length) fail(`${opts.ledger} is malformed:\n  ${problems.join('\n  ')}`);

    const reports = [];
    let untested = [];
    let stopped = null;
    if (opts.reports.length) {
        for (const p of opts.reports) reports.push(readJson(resolve(opts.root, p), 'Stryker report'));
    } else {
        const plan = planRuns(changedLines(opts.root, opts.base), listTests(opts.root));
        untested = plan.untested;
        if (opts.dryRun) {
            console.log(JSON.stringify(plan, null, 2));
            return;
        }
        if (!plan.runs.length && !untested.length) {
            console.log(`No hook or script lines changed against ${opts.base}; nothing to mutate.`);
            return;
        }
        if (plan.runs.length) {
            if (!opts.stryker) {
                fail('pass --stryker <path to the stryker binary> (CI installs a pinned copy; see docs/quality.md)');
            }
            const bin = resolve(opts.root, opts.stryker);
            if (!existsSync(bin)) fail(`Stryker binary ${bin} does not exist`);
            const budgetMs = opts.budgetMinutes === null ? null : opts.budgetMinutes * 60_000;
            const queue = [...plan.runs];
            while (queue.length) {
                const run = queue.shift();
                const left = budgetMs === null ? null : started + budgetMs - Date.now();
                if (left !== null && left <= 0) {
                    stopped = { minutes: opts.budgetMinutes, cut: null, skipped: [run, ...queue].map((r) => r.name) };
                    break;
                }
                const result = await runStryker(opts.root, bin, run, left);
                reports.push(result.report);
                if (result.cut) {
                    stopped = { minutes: opts.budgetMinutes, cut: run.name, skipped: queue.map((r) => r.name) };
                    break;
                }
            }
        }
    }

    const { fresh, accepted } = evaluate(
        reports.flatMap((r) => survivors(r, opts.root)),
        ledger,
    );
    const text = summarize(fresh, accepted, untested, stopped);
    console.log(`\n${text}`);
    if (stopped) {
        console.log(`\n${budgetNotice(stopped)}`);
        if (process.env.GITHUB_ACTIONS === 'true') console.log(`::warning::${budgetNotice(stopped)}`);
    }
    if (process.env.GITHUB_STEP_SUMMARY) {
        try {
            appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
        } catch {
            // The summary is a convenience; the exit status is the result.
        }
    }
    if (fresh.length || untested.length) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    await main(process.argv.slice(2));
}

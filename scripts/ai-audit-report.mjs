#!/usr/bin/env node
/**
 * Audit trail report for agent activity in Danathar/akmods: merged pull
 * requests (audited against the rules below) and commits on main (listed).
 *
 * PR input: JSON array from
 *   gh pr list --repo Danathar/akmods --state merged --limit 500 \
 *     --json number,title,author,body,mergedAt,mergedBy,labels,url,baseRefName,headRefName,closingIssuesReferences
 * `closingIssuesReferences` and `baseRefName` are required for the base and
 * link checks; a PR without them is reported as a violation, not assumed fine.
 * `commits` may be present but is not read (asking `gh` for it with
 * --limit 500 exceeds GitHub's GraphQL node limit).
 *
 * A PR is agent-authored when ANY of these holds:
 *   - its author is a known agent app (AGENT_LOGINS: the Hive GitHub App, in
 *     `gh` spelling `app/...` or REST spelling `...[bot]`);
 *   - its body carries an agent marker: a `— hive: agent=<name> ...` line, a
 *     `Co-Authored-By: Claude` trailer, or a "Generated with Claude Code" line
 *     (lines inside fenced code blocks are examples and are ignored);
 *   - it carries the `ai-fix-requested` label (the AI-fix workflow acted on it)
 *     or its head branch starts with `claude/` (branches the Claude Code
 *     action creates).
 * Everything else is counted as non-agent and listed only as a number, so a
 * window with zero agent PRs reads as "nothing was audited", not as a pass.
 * Renovate, Dependabot and github-actions PRs are automation, not agents,
 * unless they carry one of the markers above.
 *
 * Requirements checked per agent PR:
 *   linked-issue   GitHub's resolved closingIssuesReferences name an issue of
 *                  Danathar/akmods (body text is not consulted; a missing
 *                  field counts as no link)
 *   attribution    body carries an agent marker (see above), so a reader of
 *                  the PR can tell which agent wrote it
 *   human-merge    merged by a human account or by the Hive App itself (the
 *                  Hive lane, counted separately). A merge by any other bot,
 *                  or with no recorded merger, is a violation.
 *   base           base branch is `main` of Danathar/akmods (never upstream)
 *
 * Commit input (optional, --commits): JSON array from
 *   gh api --paginate repos/Danathar/akmods/commits?sha=main&since=<date> --jq '[.[] | ...]'
 * with objects { sha, message, author_login, html_url }. A commit is
 * agent-made when its author is an agent app or its message has an agent
 * marker. Commits are listed, never failed on: squash-merging a PR is how an
 * agent commit normally reaches main, and the PR audit covers that path.
 *
 * Usage:
 *   node scripts/ai-audit-report.mjs --input merged.json [--commits commits.json]
 *        [--since YYYY-MM-DD] [--strict] [--limit N] [--output report.md]
 *
 * Exit codes: 0 report written (and, with --strict, no violations);
 * 1 --strict and at least one violation (zero agent PRs is reported, never a
 * violation); 2 bad usage or unreadable/truncated input.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const REPO = 'Danathar/akmods';
export const PR_URL_PREFIX = `https://github.com/${REPO}/pull/`;
export const AGENT_LOGINS = [
    'app/danathar-atomic-hive',
    'danathar-atomic-hive[bot]',
];

export const AGENT_LABEL = 'ai-fix-requested';
export const AGENT_BRANCH_PREFIX = 'claude/';

// One marker per line. `— hive:` signature, Claude co-author trailer, or the
// Claude Code "Generated with" footer.
const MARKER_LINES = [
    /^— hive:.*(^|\s)agent=\S+/,
    /^co-authored-by:\s*claude\b.*$/i,
    /^(?:🤖\s*)?generated with \[?claude code\]?/i,
];

function lines(body) {
    return String(body ?? '').split(/\r?\n/);
}

/**
 * First agent marker line of the body, or null. Lines inside fenced
 * code blocks are examples, not a marker, and are skipped.
 */
export function findSignature(body) {
    let fence = null;
    for (const line of lines(body)) {
        const trimmed = line.trim();
        const open = /^(`{3,}|~{3,})(.*)$/.exec(trimmed);
        if (open) {
            const [, marker, rest] = open;
            if (fence === null) {
                fence = marker;
                continue;
            }
            // CommonMark: a closing fence is the same character, at least as
            // long as the opener, and has no info string.
            if (
                marker[0] === fence[0] &&
                marker.length >= fence.length &&
                rest.trim() === ''
            ) {
                fence = null;
            }
            continue;
        }
        if (fence === null && MARKER_LINES.some((re) => re.test(trimmed))) {
            return trimmed;
        }
    }
    return null;
}

/** @returns {{agent: boolean, reason: 'app-author'|'signature'|'label'|'branch'|null}} */
export function classify(pr) {
    if (AGENT_LOGINS.includes(pr?.author?.login)) {
        return { agent: true, reason: 'app-author' };
    }
    if (findSignature(pr?.body)) {
        return { agent: true, reason: 'signature' };
    }
    if ((pr?.labels ?? []).some((l) => l?.name === AGENT_LABEL)) {
        return { agent: true, reason: 'label' };
    }
    if (String(pr?.headRefName ?? '').startsWith(AGENT_BRANCH_PREFIX)) {
        return { agent: true, reason: 'branch' };
    }
    return { agent: false, reason: null };
}

/**
 * True when GitHub's resolved `closingIssuesReferences` name an issue of this
 * repository. Body text is never consulted: `Closes #999999`, or an example in
 * a code fence, is not a link. Input without the field is treated as having no
 * link, so a caller that forgot to request it gets violations, not a false pass.
 */
export function hasLinkedIssue(pr) {
    if (!Array.isArray(pr?.closingIssuesReferences)) return false;
    return pr.closingIssuesReferences.some(
        (ref) =>
            `${ref?.repository?.owner?.login}/${ref?.repository?.name}`.toLowerCase() ===
            REPO.toLowerCase()
    );
}

export function isBotAccount(user) {
    if (!user || !user.login) return false;
    return (
        user.is_bot === true ||
        user.login.endsWith('[bot]') ||
        user.login.startsWith('app/')
    );
}

/** True for the Hive GitHub App, in either `gh` or REST spelling. */
export function isHiveApp(user) {
    return AGENT_LOGINS.includes(user?.login);
}

/**
 * Checks one agent PR. Returns the list of violated requirement ids.
 * @param {object} pr
 */
export function auditPr(pr) {
    const violations = [];

    if (!hasLinkedIssue(pr)) violations.push('linked-issue');
    if (!findSignature(pr.body)) violations.push('attribution');

    // The Hive App merging an agent PR is the hive-serialized lane: allowed.
    // Any other bot, or no recorded merger, is a violation.
    const mergedBy = pr.mergedBy;
    if (!mergedBy || !mergedBy.login) {
        violations.push('human-merge');
    } else if (isBotAccount(mergedBy) && !isHiveApp(mergedBy)) {
        violations.push('human-merge');
    }

    const urlOk =
        typeof pr.url === 'string' && pr.url.startsWith(PR_URL_PREFIX);
    if (pr.baseRefName !== 'main' || !urlOk) violations.push('base');

    return violations;
}

/**
 * Agent-made commits on main: author is an agent app or the message carries an
 * agent marker. Listed for the audit trail; never a violation (see header).
 * @param {object[]} commits { sha, message, author_login, html_url }
 */
export function agentCommits(commits) {
    const out = [];
    for (const c of commits ?? []) {
        const byApp = AGENT_LOGINS.includes(c?.author_login);
        const marker = findSignature(c?.message);
        if (!byApp && !marker) continue;
        out.push({
            sha: String(c.sha ?? '').slice(0, 7),
            subject: String(c.message ?? '').split(/\r?\n/)[0],
            author: c.author_login ?? 'unknown',
            url: c.html_url ?? '',
            detected: byApp ? 'app-author' : 'marker',
        });
    }
    return out;
}

/**
 * @param {object[]} prs merged PRs
 * @param {{since?: string}} [options]
 */
export function buildReport(prs, options = {}) {
    const since = options.since ?? null;
    const inWindow = prs.filter(
        (pr) => !since || (pr.mergedAt ?? '').slice(0, 10) >= since
    );
    const rows = [];
    let nonAgent = 0;
    for (const pr of inWindow) {
        const c = classify(pr);
        if (!c.agent) {
            nonAgent += 1;
            continue;
        }
        rows.push({
            number: pr.number,
            title: pr.title ?? '',
            url: pr.url ?? '',
            detected: c.reason,
            author: pr.author?.login ?? 'unknown',
            mergedBy: pr.mergedBy?.login ?? 'unknown',
            mergedAt: (pr.mergedAt ?? '').slice(0, 10),
            violations: auditPr(pr),
            hiveLane: isHiveApp(pr.mergedBy),
        });
    }
    const violating = rows.filter((r) => r.violations.length > 0);
    return {
        since,
        total: inWindow.length,
        agent: rows.length,
        nonAgent,
        rows,
        violationCount: violating.length,
        hiveLane: rows.filter((r) => r.hiveLane).length,
    };
}

const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

function renderPrs(report) {
    const out = [];
    out.push(
        `### Agent audit trail${report.since ? `: merged since ${report.since}` : ''}`,
        '',
        `${report.total} merged PR(s) in the window: ${report.agent} classified as agent-authored and audited, ${report.nonAgent} classified as non-agent and not audited.`,
        ''
    );
    if (report.agent === 0) {
        out.push(
            '**No agent-authored PRs were found, so nothing was audited.** This is not a pass of the audit-trail rules; check the window and the classification (an agent app author, a `— hive: agent=...` / `Co-Authored-By: Claude` / "Generated with Claude Code" body line, the `ai-fix-requested` label, or a `claude/` head branch).',
            ''
        );
        return out.join('\n');
    }
    out.push(
        '| PR | Merged | Detected by | Author | Merged by | Result |',
        '| --- | --- | --- | --- | --- | --- |'
    );
    for (const r of report.rows) {
        const result =
            r.violations.length === 0
                ? 'ok'
                : `violates: ${r.violations.join(', ')}`;
        out.push(
            `| [#${r.number}](${r.url}) ${cell(r.title)} | ${r.mergedAt} | ${r.detected} | ${cell(r.author)} | ${cell(r.mergedBy)}${r.hiveLane ? ' (Hive lane)' : ''} | ${result} |`
        );
    }
    out.push(
        '',
        `${report.hiveLane} of ${report.agent} audited agent PR(s) were merged by the Hive lane (the Hive App itself, allowed).`,
        '',
        report.violationCount === 0
            ? 'All audited agent PRs meet the audit-trail requirements.'
            : `${report.violationCount} of ${report.agent} audited agent PR(s) violate at least one requirement.`,
        ''
    );
    return out.join('\n');
}

export function renderMarkdown(report, commits = null) {
    const out = [renderPrs(report)];
    if (commits !== null) {
        out.push('', '### Agent commits on main', '');
        if (commits.length === 0) {
            out.push('No agent-made commits found in the commit list.', '');
        } else {
            out.push('| Commit | Author | Detected by |', '| --- | --- | --- |');
            for (const c of commits) {
                out.push(`| [${c.sha}](${c.url}) ${cell(c.subject)} | ${cell(c.author)} | ${c.detected} |`);
            }
            out.push('');
        }
    }
    return out.join('\n');
}

/** YYYY-MM-DD that round-trips, so 2026-02-30 is rejected, not read as March. */
export function isRealDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const d = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export function parseArgs(argv) {
    const opts = {
        input: null,
        commits: null,
        since: null,
        strict: false,
        limit: null,
        output: null,
    };
    const need = (i, name) => {
        if (i + 1 >= argv.length) throw new Error(`${name} needs a value`);
        return argv[i + 1];
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        switch (a) {
            case '--input':
                opts.input = need(i++, a);
                break;
            case '--commits':
                opts.commits = need(i++, a);
                break;
            case '--since':
                opts.since = need(i++, a);
                if (!isRealDate(opts.since)) {
                    throw new Error('--since must be a real date, YYYY-MM-DD');
                }
                break;
            case '--strict':
                opts.strict = true;
                break;
            case '--limit': {
                const n = Number(need(i++, a));
                if (!Number.isInteger(n) || n < 1) {
                    throw new Error('--limit must be a positive integer');
                }
                opts.limit = n;
                break;
            }
            case '--output':
                opts.output = need(i++, a);
                break;
            default:
                throw new Error(`unknown argument ${a}`);
        }
    }
    return opts;
}

/** Runs the CLI; returns the exit code. */
export function main(argv, readInput = readFileSync, write = writeFileSync) {
    let opts;
    let prs;
    try {
        opts = parseArgs(argv);
        const raw = readInput(opts.input ?? 0, 'utf8');
        prs = JSON.parse(raw);
        if (!Array.isArray(prs)) throw new Error('input must be a JSON array');
        if (opts.limit !== null && prs.length >= opts.limit) {
            throw new Error(
                `${prs.length} PRs reached the --limit of ${opts.limit}; the list may be truncated, audit a narrower window`
            );
        }
    } catch (err) {
        process.stderr.write(`ai-audit-report: ${err.message}\n`);
        return 2;
    }
    const report = buildReport(prs, opts);
    let commits = null;
    if (opts.commits) {
        try {
            const parsed = JSON.parse(readInput(opts.commits, 'utf8'));
            if (!Array.isArray(parsed)) throw new Error('--commits input must be a JSON array');
            commits = agentCommits(parsed);
        } catch (err) {
            process.stderr.write(`ai-audit-report: ${err.message}\n`);
            return 2;
        }
    }
    const md = renderMarkdown(report, commits);
    if (opts.output) write(opts.output, md);
    else process.stdout.write(md + '\n');
    if (opts.strict && report.violationCount > 0) return 1;
    return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    process.exitCode = main(process.argv.slice(2));
}

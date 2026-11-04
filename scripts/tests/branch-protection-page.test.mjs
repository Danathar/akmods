// docs/branch-protection.md says what protects `main`: the rules of the
// committed ruleset, the seven checks it requires and the workflow each comes
// from. docs/review-rubric.md and AGENTS.md repeat the check names. `main` is
// the build source for signed images, so a reader of these pages decides what
// is safe to merge from them, and nothing read them: scripts/check-policies.mjs
// holds the ruleset to policies/ruleset.json, not the pages to either. These
// tests hold the pages to .github/rulesets/main.json and .github/workflows/, so
// a rule or a required check changed in one has to be written into the other
// in the same change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

const PAGE = 'docs/branch-protection.md';
const ADVISORY_JOB = 'Mutation check on changed lines (advisory)';
const COUNT_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

const ruleset = JSON.parse(read('.github/rulesets/main.json'));
const rule = (type) => ruleset.rules.find((r) => r.type === type);
const requiredChecks = () => rule('required_status_checks').parameters.required_status_checks;
const requiredNames = () => requiredChecks().map((c) => c.context).sort();
const codeSpans = (text) => [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1]);

// The text under a heading, up to the next heading of any level.
function section(page, heading) {
    const lines = read(page).split('\n');
    const start = lines.indexOf(heading);
    assert.notEqual(start, -1, `${page} has no ${JSON.stringify(heading)} heading`);
    const end = lines.findIndex((l, i) => i > start && /^#{1,3} /.test(l));
    return lines.slice(start + 1, end === -1 ? undefined : end).join('\n');
}

// The top-level bullets of a section, each with its wrapped lines and what is
// nested under it, and the bold words it opens with.
function bullets(text) {
    const found = [];
    for (const line of text.split('\n')) {
        if (line.startsWith('- ')) found.push(line);
        else if (found.length && /^\s+\S/.test(line)) found[found.length - 1] += `\n${line}`;
    }
    return found.map((body) => ({ lead: /^- \*\*(.+?)\*\*/.exec(body)?.[1] ?? null, body }));
}

const rulesetSection = () => section(PAGE, '## The ruleset');

function bullet(leadPattern) {
    const hits = bullets(rulesetSection()).filter((b) => leadPattern.test(b.lead ?? ''));
    assert.equal(hits.length, 1, `${PAGE}: want one "## The ruleset" bullet opening ${leadPattern}`);
    return hits[0];
}

// The rows of the required-check table: the checks in the first cell and the
// workflow in the second.
function tableRows() {
    const rows = bullet(/required checks$/).body.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('|'));
    const [header, , ...body] = rows;
    assert.match(header, /^\| Check \| Source workflow \|$/);
    return body.map((row) => {
        const [checks, source] = row.split('|').slice(1, -1);
        const [file, ...more] = codeSpans(source);
        assert.deepEqual(more, [], `${row}: one workflow per row`);
        return { checks: codeSpans(checks), file };
    });
}

// What a workflow's `pull_request` trigger sets, and each job's display name
// and job-level `if:`. Enough YAML for the files here: two-space indents, `on:`
// as a block, and `name:` and `if:` four spaces in.
function parseWorkflow(text) {
    const trigger = {};
    const jobs = [];
    let top = null;
    let event = null;
    let job = null;
    for (const line of text.split('\n')) {
        let m;
        if ((m = /^(\S[^:]*):/.exec(line))) {
            top = m[1].replace(/^['"]|['"]$/g, '');
            continue;
        }
        if (top === 'on') {
            if ((m = /^ {2}([\w-]+):/.exec(line))) event = m[1];
            else if (event === 'pull_request' && (m = /^ {4}([\w-]+): *(.*?) *$/.exec(line))) trigger[m[1]] = m[2];
        }
        if (top !== 'jobs') continue;
        if ((m = /^ {2}([\w-]+):\s*$/.exec(line))) {
            job = { name: m[1], if: null };
            jobs.push(job);
        } else if (job && (m = /^ {4}name: *(.+?) *$/.exec(line))) {
            job.name = m[1].replace(/^(['"])(.*)\1$/, '$2');
        } else if (job && (m = /^ {4}if: *(.+?) *$/.exec(line))) {
            job.if = m[1];
        }
    }
    return { trigger, jobs };
}

const workflow = (file) => parseWorkflow(read(`.github/workflows/${file}`));

test('the table lists exactly the checks the ruleset requires', () => {
    assert.deepEqual(tableRows().flatMap((r) => r.checks).sort(), requiredNames());
});

test('every check in the table is a job of the workflow its row names', () => {
    for (const { checks, file } of tableRows()) {
        const names = workflow(file).jobs.map((j) => j.name);
        for (const check of checks) assert.ok(names.includes(check), `${check} is not a job of ${file} (${names.join(', ')})`);
    }
});

test('the count and the integration id the pages state are the ruleset\'s', () => {
    const count = COUNT_WORDS[requiredChecks().length];
    assert.equal(bullet(/required checks$/).lead.toLowerCase(), `${count} required checks`);
    assert.match(section(PAGE, '## Status'), new RegExp(`all ${count} required checks`));
    assert.match(read('policies/README.md'), new RegExp(`the ${count} required checks`));
    const [id, ...more] = [...new Set(requiredChecks().map((c) => c.integration_id))];
    assert.deepEqual(more, [], 'the page states one integration id for every check');
    assert.match(bullet(/required checks$/).body, new RegExp(`\`integration_id\` ${id}\\)`));
});

test('required checks run on every pull request to main, unfiltered', () => {
    assert.match(bullet(/required checks$/).body, /All run on every pull request to `main` with no path filter/);
    for (const { checks, file } of tableRows()) {
        const { trigger, jobs } = workflow(file);
        assert.equal(trigger.branches, '[main]', `${file}: pull_request branches`);
        for (const key of ['paths', 'paths-ignore', 'branches-ignore']) {
            assert.ok(!(key in trigger), `${file}: pull_request has ${key}, so a required check may never start`);
        }
        if ('types' in trigger) {
            const types = trigger.types.replace(/[[\]\s]/g, '').split(',');
            for (const type of ['opened', 'synchronize', 'reopened']) {
                assert.ok(types.includes(type), `${file}: pull_request types leaves out ${type}`);
            }
        }
        for (const check of checks) {
            assert.equal(jobs.find((j) => j.name === check).if, null, `${check} has a job-level if:, so it can be skipped`);
        }
    }
});

test('the advisory job is what the page says it is', () => {
    const text = bullet(/required checks$/).body.replace(/\s+/g, ' ');
    assert.ok(text.includes(`The advisory \`${ADVISORY_JOB}\` job in \`agent-tooling.yml\` is deliberately not required`));
    assert.match(text, /it runs on pull requests only, is skipped for upstream syncs/);
    assert.ok(!requiredNames().includes(ADVISORY_JOB), 'the ruleset requires the advisory job');
    const job = workflow('agent-tooling.yml').jobs.find((j) => j.name === ADVISORY_JOB);
    assert.ok(job, `agent-tooling.yml has no job named ${ADVISORY_JOB}`);
    assert.ok(job.if?.includes("github.event_name == 'pull_request'"), `not limited to pull requests: ${job.if}`);
    assert.ok(job.if?.includes("!contains(github.event.pull_request.title, 'chore: sync upstream')"), `upstream syncs not skipped: ${job.if}`);
});

test('the bullets state the ruleset\'s target, bypass list and approvals', () => {
    assert.deepEqual(codeSpans(bullet(/^Targets/).lead), ruleset.conditions.ref_name.include);
    assert.deepEqual(ruleset.conditions.ref_name.exclude, [], 'the page states no excluded branch');
    assert.equal(bullet(/bypass actors/).lead, 'No bypass actors.');
    assert.deepEqual(ruleset.bypass_actors, [], `${PAGE} says the ruleset has no bypass actors`);
    const approvals = /^`pull_request` with (\d+) approvals\.$/.exec(bullet(/^`pull_request`/).lead)?.[1];
    assert.equal(Number(approvals), rule('pull_request').parameters.required_approving_review_count);
    assert.match(bullet(/^Up-to-date/).body, /`strict_required_status_checks_policy: true`/);
    assert.equal(rule('required_status_checks').parameters.strict_required_status_checks_policy, true);
    assert.equal(ruleset.enforcement, 'active', `${PAGE} says the ruleset is active`);
});

test('every rule type of the ruleset has its bullet, and every bullet is read here', () => {
    const named = new Map([
        ['deletion', /`deletion` and `non_fast_forward`/],
        ['non_fast_forward', /`deletion` and `non_fast_forward`/],
        ['pull_request', /^`pull_request` with/],
        ['required_status_checks', /required checks$/],
    ]);
    assert.deepEqual(ruleset.rules.map((r) => r.type).sort(), [...named.keys()].sort(), 'a rule type the page does not state');
    for (const [type, lead] of named) assert.ok(bullet(lead), type);
    const leads = [/^Targets/, /bypass actors/, /^Up-to-date/, ...named.values()];
    const unread = bullets(rulesetSection()).filter((b) => !leads.some((lead) => lead.test(b.lead ?? '')));
    assert.deepEqual(unread.map((b) => b.lead), [], 'a bullet no test here reads');
});

test('the merge queue section is right that the ruleset has no merge queue rule', () => {
    assert.match(section(PAGE, '## Merge queue (#45)').replace(/\s+/g, ' '), /the ruleset has no `merge_queue` rule/);
    assert.equal(rule('merge_queue'), undefined);
});

test('the settings the second-reviewer section changes are ones the ruleset sets', () => {
    const params = rule('pull_request').parameters;
    const spans = codeSpans(section(PAGE, '## When there is a second reviewer'));
    assert.deepEqual(spans, ['required_approving_review_count', 'require_last_push_approval']);
    assert.equal(params.required_approving_review_count, 0);
    assert.equal(params.require_last_push_approval, false);
});

test('the review rubric lists exactly the required checks', () => {
    const item = /^11\. \*\*CI contract green\.\*\*[^]*?(?=^12\. )/m.exec(section('docs/review-rubric.md', '## Should-fix'));
    assert.ok(item, 'docs/review-rubric.md has no "CI contract green" item');
    assert.deepEqual(codeSpans(item[0]).sort(), requiredNames());
});

test('the AGENTS.md CI sentence names the jobs of ci.yml and the other required workflows', () => {
    const sentence = /^CI \(`\.github\/workflows\/ci\.yml`:[^]*?\) runs on every PR to\n?\s*`main`\./m.exec(section('AGENTS.md', '## How to test'));
    assert.ok(sentence, 'AGENTS.md has no "CI (...) runs on every PR" sentence');
    const [first, ...rest] = codeSpans(sentence[0].replace(/`main`\.$/, ''));
    assert.equal(first, '.github/workflows/ci.yml');
    const files = rest.filter((s) => s.endsWith('.yml'));
    assert.deepEqual(rest.filter((s) => !s.endsWith('.yml')), workflow('ci.yml').jobs.map((j) => j.name));
    assert.deepEqual([...files].sort(), tableRows().map((r) => r.file).filter((f) => f !== 'ci.yml').sort());
});

test('parseWorkflow reads the pull_request trigger, job names and job-level if', () => {
    const yaml = [
        'name: X',
        'on:',
        '  push:',
        '    branches: [other]',
        '  pull_request:',
        '    branches: [main]',
        '    paths: [a]',
        'jobs:',
        '  one:',
        '    name: "One job"',
        '    if: always()',
        '    steps:',
        '      - if: never()',
        '  two:',
        '    runs-on: x',
    ].join('\n');
    assert.deepEqual(parseWorkflow(yaml), {
        trigger: { branches: '[main]', paths: '[a]' },
        jobs: [{ name: 'One job', if: 'always()' }, { name: 'two', if: null }],
    });
});

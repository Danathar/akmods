// Holds every section of the documentation pages to a row in
// docs/section-map.txt, which gives each `##`/`###` heading either `joined:`
// and the check that reads it, or `prose:` and a reason.
//
// Pages here state facts about the fork (which workflows hold write tokens,
// which files agents may not touch, what each check runs) and go stale when
// those change. The security policy's list of workflows holding write scopes
// had missed every fork-local one since the day they landed, with every check
// green, because leaving a section unchecked is the silent default. With the
// map, a new or renamed section has to be classified in the pull request that
// adds it, so an unchecked section of machine claims is a visible
// `prose: unchecked:` line in a reviewed diff.
//
// This proves no sentence true, and a `joined:` row only means the check opens
// the page: whether it reads that section is the reviewer's call, made once,
// when the row is written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const MAP = 'docs/section-map.txt';
const THIS_TEST = 'scripts/tests/docs-section-map.test.mjs';

// Root-level pages, docs/ and docs/security/ (not the dated metrics, agent-task
// and reflection ledgers), and the Copilot brief.
const TRACKED_PAGE = /^(?:[^/]+|docs\/[^/]+|docs\/security\/[^/]+)\.md$/;
const EXTRA_PAGES = new Set(['.github/copilot-instructions.md']);

// Where a joined check may live: the three test suites CI runs, the policy
// checker, which reads docs/risk-tiers.md itself in the required policy-check,
// and the Coverage gate's config, through which the required Coverage gate
// reads FORK-PATCHES.md's patch headings.
const JOIN_TARGET = /^(?:tests\/unit\/[^/]+\.bats|scripts\/tests\/[^/]+\.test\.mjs|\.claude\/hooks\/tests\/[^/]+\.test\.mjs|scripts\/check-policies\.mjs|\.coverage-thresholds\.json)$/;

const HEADING = /^(#{2,3}) +(.+?)(?: +#+)? *$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const PAGE_LINE = /^\[(?<page>[^\]]+)\]$/;
const ROW_LINE = /^ {2}(?<kind>joined|prose): *(?<value>.*)$/;

function trackedPages(root) {
    const listing = spawnSync('git', ['-C', root, 'ls-files', '-z', '--', '*.md'], { encoding: 'utf8' });
    assert.equal(listing.status, 0, listing.stderr);
    const names = listing.stdout.split('\0').filter(Boolean);
    return new Set(names.filter((n) => TRACKED_PAGE.test(n) || EXTRA_PAGES.has(n)));
}

// `##`/`###` headings outside fenced blocks, as `## Text`.
function headings(text) {
    const found = [];
    let fence = '';
    for (const line of text.split(/\r?\n/)) {
        const opened = FENCE.exec(line);
        if (opened) {
            const marker = opened[1];
            if (!fence) fence = marker;
            else if (marker[0] === fence[0] && marker.length >= fence.length) fence = '';
            continue;
        }
        if (fence) continue;
        const m = HEADING.exec(line);
        if (m) found.push(`${m[1]} ${m[2]}`);
    }
    return found;
}

// page -> Map(heading -> [kind, value]). Throws on any line it cannot place.
function parseMap(text) {
    const pages = new Map();
    let page = null;
    let heading = null;
    text.split(/\r?\n/).forEach((line, i) => {
        const where = `${MAP}:${i + 1}`;
        if (!line.trim() || (line.startsWith('#') && !HEADING.test(line))) return;
        if (heading !== null && !ROW_LINE.test(line)) {
            throw new Error(`${where}: ${JSON.stringify(heading)} has no joined:/prose: line under it`);
        }
        let m;
        if ((m = PAGE_LINE.exec(line))) {
            page = m.groups.page;
            if (pages.has(page)) throw new Error(`${where}: [${page}] is listed twice`);
            pages.set(page, new Map());
        } else if (HEADING.test(line)) {
            if (page === null) throw new Error(`${where}: heading before any [page] line`);
            if (pages.get(page).has(line)) throw new Error(`${where}: ${JSON.stringify(line)} is listed twice under [${page}]`);
            heading = line;
        } else if ((m = ROW_LINE.exec(line))) {
            if (heading === null) throw new Error(`${where}: classification with no heading above it`);
            const value = m.groups.value.trim();
            if (!value) throw new Error(`${where}: ${m.groups.kind}: needs a value`);
            pages.get(page).set(heading, [m.groups.kind, value]);
            heading = null;
        } else {
            throw new Error(`${where}: neither a [page], a heading nor a classification: ${JSON.stringify(line)}`);
        }
    });
    if (heading !== null) throw new Error(`${MAP}: ${JSON.stringify(heading)} has no joined:/prose: line under it`);
    return pages;
}

// Whether a test names the page outside its comments. The file name is what is
// looked for, since tests spell a path whole or joined from parts.
function opensPage(testText, suffix, page) {
    const name = path.basename(page);
    if (suffix === '.bats') {
        return testText.split(/\r?\n/).some((l) => !l.trimStart().startsWith('#') && l.includes(name));
    }
    const code = testText.replace(/\/\*[\s\S]*?\*\//g, '').split(/\r?\n/).filter((l) => !l.trimStart().startsWith('//'));
    return code.some((l) => l.includes(name));
}

function pageMismatch(rows, pages) {
    return [[...pages].filter((p) => !rows.has(p)).sort(), [...rows.keys()].filter((p) => !pages.has(p)).sort()];
}

function unclassified(rows, root) {
    const found = {};
    for (const [page, pageRows] of [...rows].sort()) {
        const missing = headings(fs.readFileSync(path.join(root, page), 'utf8')).filter((h) => !pageRows.has(h));
        if (missing.length) found[page] = missing;
    }
    return found;
}

function stale(rows, root) {
    const found = {};
    for (const [page, pageRows] of [...rows].sort()) {
        const have = new Set(headings(fs.readFileSync(path.join(root, page), 'utf8')));
        const gone = [...pageRows.keys()].filter((h) => !have.has(h)).sort();
        if (gone.length) found[page] = gone;
    }
    return found;
}

// Why a `joined:` row does not hold, or null when it does.
function badJoin(page, heading, target, root) {
    if (target === THIS_TEST) return 'this test reads headings, not what a section says';
    const file = path.join(root, target);
    if (!JOIN_TARGET.test(target) || !fs.existsSync(file)) {
        return `${page} ${JSON.stringify(heading)} is joined to ${target}, which is not a test file CI runs`;
    }
    if (!opensPage(fs.readFileSync(file, 'utf8'), path.extname(target), page)) {
        return `${page} ${JSON.stringify(heading)} is joined to ${target}, which never opens ${page}`;
    }
    return null;
}

test('headings: reads both levels and nothing else', () => {
    assert.deepEqual(headings('# Title\n## One\ntext\n### Two\n#### Three\n##No space\n'), ['## One', '### Two']);
});

test('headings: skips headings inside a fence, closed only by its own marker at least as long', () => {
    assert.deepEqual(
        headings('## Out\n```bash\n## not a heading\n```\n~~~~\n### nor this\n```\n~~~~\n### Back\n'),
        ['## Out', '### Back'],
    );
    assert.deepEqual(headings('````\n```\n## in\n````\n## Out\n'), ['## Out']);
    assert.deepEqual(headings('```\n~~~\n## in\n```\n## Out\n'), ['## Out']);
});

test('headings: drops a closing hash sequence', () => {
    assert.deepEqual(headings('## Closed ##\n'), ['## Closed']);
});

test('parseMap: reads rows and skips comments', () => {
    const rows = parseMap('# comment\n\n[a.md]\n## One\n  joined: tests/unit/x.bats\n### Two\n  prose: narrative: why\n\n[b.md]\n');
    assert.deepEqual([...rows.keys()], ['a.md', 'b.md']);
    assert.deepEqual([...rows.get('a.md')], [['## One', ['joined', 'tests/unit/x.bats']], ['### Two', ['prose', 'narrative: why']]]);
    assert.equal(rows.get('b.md').size, 0);
});

test('parseMap: refuses a missing or empty classification, a duplicate, and a stray line', () => {
    for (const text of [
        '[a.md]\n## One\n## Two\n  prose: x\n',
        '[a.md]\n## One\n',
        '[a.md]\n## One\n  prose:\n',
        '[a.md]\n[a.md]\n',
        '[a.md]\n## One\n  prose: x\n## One\n  prose: y\n',
        '## One\n  prose: x\n',
        '[a.md]\n  prose: x\n',
        '[a.md]\n## One\njoined: tests/unit/x.bats\n',
    ]) {
        assert.throws(() => parseMap(text), Error, JSON.stringify(text));
    }
});

test('opensPage: a path in code opens the page, a comment does not', () => {
    assert.ok(opensPage("const doc = read('docs/risk-tiers.md');\n", '.mjs', 'docs/risk-tiers.md'));
    assert.ok(opensPage("path.join(root, 'docs', 'risk-tiers.md')\n", '.mjs', 'docs/risk-tiers.md'));
    assert.ok(!opensPage('// reads docs/risk-tiers.md\n/* and risk-tiers.md\n */\nconst x = 1;\n', '.mjs', 'docs/risk-tiers.md'));
    assert.ok(opensPage('#!/usr/bin/env bats\n  run grep -c x "$REPO_ROOT/README.md"\n', '.bats', 'README.md'));
    assert.ok(!opensPage('#!/usr/bin/env bats\n# reads README.md\n  # and README.md\n@test "x" { :; }\n', '.bats', 'README.md'));
});

test('the checks fire on a small repository built for them', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'section-map-'));
    try {
        fs.mkdirSync(path.join(root, 'scripts/tests'), { recursive: true });
        fs.writeFileSync(path.join(root, 'page.md'), '# Page\n## Kept\n## New\n');
        fs.writeFileSync(path.join(root, 'scripts/tests/reads.test.mjs'), "read('page.md');\n");
        fs.writeFileSync(path.join(root, 'scripts/tests/other.test.mjs'), "// page.md\nread('other.md');\n");
        fs.writeFileSync(path.join(root, 'elsewhere.mjs'), "read('page.md');\n");

        const kept = new Map([['## Kept', ['prose', 'x']]]);
        assert.deepEqual(unclassified(new Map([['page.md', kept]]), root), { 'page.md': ['## New'] });

        const extra = new Map([['## Kept', ['prose', 'x']], ['## New', ['prose', 'x']], ['## Gone', ['prose', 'x']]]);
        assert.deepEqual(stale(new Map([['page.md', extra]]), root), { 'page.md': ['## Gone'] });
        assert.deepEqual(unclassified(new Map([['page.md', extra]]), root), {});

        assert.equal(badJoin('page.md', '## Kept', 'scripts/tests/reads.test.mjs', root), null);
        assert.match(badJoin('page.md', '## Kept', 'elsewhere.mjs', root), /not a test file CI runs/);
        assert.match(badJoin('page.md', '## Kept', 'scripts/tests/absent.test.mjs', root), /not a test file CI runs/);
        assert.match(badJoin('page.md', '## Kept', THIS_TEST, root), /reads headings/);
        assert.match(badJoin('page.md', '## Kept', 'scripts/tests/other.test.mjs', root), /never opens page\.md/);

        assert.deepEqual(pageMismatch(new Map([['a.md', new Map()], ['b.md', new Map()]]), new Set(['a.md', 'c.md'])), [['c.md'], ['b.md']]);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

const rows = parseMap(fs.readFileSync(path.join(repoRoot, MAP), 'utf8'));

test(`${MAP} lists exactly the tracked pages`, () => {
    const [unlisted, untracked] = pageMismatch(rows, trackedPages(repoRoot));
    assert.deepEqual(unlisted, [], `tracked pages with no [page] block in ${MAP}; add one with a row per heading`);
    assert.deepEqual(untracked, [], `${MAP} lists pages that are not tracked documentation pages`);
});

test('every heading of a tracked page has a row', () => {
    assert.deepEqual(
        unclassified(rows, repoRoot),
        {},
        `sections ${MAP} does not classify; give each a joined: line naming the test that reads it, or a prose: line saying why none does`,
    );
});

test('every row names a heading the page still has', () => {
    assert.deepEqual(stale(rows, repoRoot), {}, `${MAP} classifies headings the page no longer has; rename or drop the rows`);
});

test('every joined test exists and opens the page', () => {
    for (const [page, pageRows] of rows) {
        for (const [heading, [kind, target]] of pageRows) {
            if (kind === 'joined') assert.equal(badJoin(page, heading, target, repoRoot), null);
        }
    }
});

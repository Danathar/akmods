// Holds docs/security/SECURITY-AI.md section 4 ("Token scopes: least
// privilege") to the write scopes the workflows actually grant.
//
// The section is where a reader learns which workflows hold a write token. It
// once said only the upstream build and cleanup workflows did, and stayed that
// way after the fork-local agent, labeler and issue workflows landed with
// `contents: write`, `issues: write` and `pull-requests: write`, because
// nothing read it. Each statement of the section (a bullet, cut at `. ` and
// `; `) names workflows and the scopes they hold; this test fails when a
// workflow's write scope is not named in a statement that names the workflow,
// when a named workflow holds no write scope, or when a statement names a
// scope none of its workflows hold.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const PAGE = 'docs/security/SECURITY-AI.md';
const SECTION = '## 4. Token scopes: least privilege';
const WORKFLOWS = '.github/workflows';

const SCOPE_LINE = /^\s*([a-z-]+):\s*write\s*(?:#.*)?$/;
const NAMED_SCOPE = /`([a-z-]+): write`/g;
const NAMED_WORKFLOW = /`([\w.*-]+\.ya?ml)`/g;

// Write scopes a workflow grants, at any level; `write-all` counts as one. A
// commented-out scope never matches, since the line starts with `#`.
export function writeScopes(yaml) {
    const scopes = new Set();
    for (const line of yaml.split(/\r?\n/)) {
        const m = SCOPE_LINE.exec(line);
        if (m) scopes.add(m[1]);
        if (/^\s*permissions:\s*write-all\s*(?:#.*)?$/.test(line)) scopes.add('write-all');
    }
    return scopes;
}

// The text of one `##` section, without its heading.
export function section(markdown, heading) {
    const lines = markdown.split(/\r?\n/);
    const start = lines.indexOf(heading);
    assert.notEqual(start, -1, `${PAGE} has no ${JSON.stringify(heading)} heading`);
    const rest = lines.slice(start + 1);
    const end = rest.findIndex((l) => /^#{1,2} /.test(l));
    return rest.slice(0, end === -1 ? rest.length : end).join('\n');
}

// Top-level `- ` bullets with their continuation lines, each cut into
// sentences and `;` clauses, so a scope counts only beside the workflows its
// own statement names.
export function statements(text) {
    const found = [];
    for (const line of text.split(/\r?\n/)) {
        if (line.startsWith('- ')) found.push(line);
        else if (found.length && /^\s+\S/.test(line)) found[found.length - 1] += `\n${line}`;
    }
    return found.flatMap((b) => b.split(/[.;]\s+/));
}

const globRe = (name) => new RegExp(`^${name.replace(/[.]/g, '\\.').replace(/\*/g, '[^/]*')}$`);

// Mismatches between the statements and a map of workflow file name -> write scopes.
export function mismatches(sectionText, workflows) {
    const problems = [];
    const named = statements(sectionText).map((b) => ({
        files: [...b.matchAll(NAMED_WORKFLOW)].map((m) => m[1]),
        scopes: new Set([...b.matchAll(NAMED_SCOPE)].map((m) => m[1])),
    }));
    const covers = (pattern, file) => globRe(pattern).test(file);
    for (const [file, scopes] of [...workflows].sort()) {
        const said = new Set(named.filter((b) => b.files.some((p) => covers(p, file))).flatMap((b) => [...b.scopes]));
        for (const scope of [...scopes].sort()) {
            if (!said.has(scope)) problems.push(`${file} holds \`${scope}: write\`, which no statement naming ${file} says`);
        }
    }
    for (const b of named) {
        const held = new Set();
        for (const pattern of b.files) {
            const matching = [...workflows].filter(([file]) => covers(pattern, file));
            if (!matching.some(([, scopes]) => scopes.size)) problems.push(`${pattern} is named but holds no write scope`);
            for (const [, scopes] of matching) for (const s of scopes) held.add(s);
        }
        for (const scope of [...b.scopes].sort()) {
            if (b.files.length && !held.has(scope)) {
                problems.push(`\`${scope}: write\` is named beside ${b.files.join(', ')}, none of which holds it`);
            }
        }
    }
    return problems;
}

test('writeScopes: reads write lines at any level and skips comments', () => {
    const yaml = 'permissions:\n  contents: read\njobs:\n  a:\n    permissions:\n      issues: write # why\n      # contents: write\n      packages: read\n';
    assert.deepEqual([...writeScopes(yaml)], ['issues']);
    assert.deepEqual([...writeScopes('permissions: write-all\n')], ['write-all']);
});

test('section and statements: stop at the next heading, keep continuation lines, cut at . and ;', () => {
    const text = section('## 3. x\n- no\n## 4. y\nintro\n- one `a.yml`\n  more; two. Three\n- four\n\n## 5. z\n- no\n', '## 4. y');
    assert.deepEqual(statements(text), ['- one `a.yml`\n  more', 'two', 'Three', '- four']);
});

test('mismatches: each direction is caught', () => {
    const wf = new Map([
        ['build-a.yml', new Set(['packages'])],
        ['build-b.yml', new Set(['packages'])],
        ['bot.yml', new Set(['issues', 'contents'])],
        ['ci.yml', new Set()],
    ]);
    const good = '- `build-*.yml` hold `packages: write`.\n- `bot.yml` holds `issues: write`\n  and `contents: write`.\n';
    assert.deepEqual(mismatches(good, wf), []);
    assert.match(mismatches('- `build-*.yml` hold `packages: write`.\n- `bot.yml` holds `issues: write`.\n', wf).join('\n'), /bot\.yml holds `contents: write`/);
    assert.match(mismatches('- `build-*.yml` hold `packages: write`.\n', wf).join('\n'), /bot\.yml holds `contents: write`/);
    assert.match(mismatches(`${good}- \`ci.yml\` is fine.\n`, wf).join('\n'), /ci\.yml is named but holds no write scope/);
    assert.match(mismatches(`${good}- \`gone.yml\` is fine.\n`, wf).join('\n'), /gone\.yml is named but holds no write scope/);
    assert.match(mismatches('- `build-*.yml` hold `packages: write` and `id-token: write`.\n- `bot.yml` holds `issues: write` and `contents: write`.\n', wf).join('\n'), /`id-token: write` is named beside build-\*\.yml/);
    // One bullet, two statements: a scope counts only in its own statement.
    assert.match(mismatches('- `build-*.yml` hold `packages: write` and `contents: write`; `bot.yml` holds `issues: write`.\n', wf).join('\n'), /`contents: write` is named beside build-\*\.yml/);
});

test(`${PAGE} section 4 names every workflow write scope, and only those`, () => {
    const workflows = new Map(
        fs.readdirSync(path.join(repoRoot, WORKFLOWS))
            .filter((f) => /\.ya?ml$/.test(f))
            .map((f) => [f, writeScopes(fs.readFileSync(path.join(repoRoot, WORKFLOWS, f), 'utf8'))]),
    );
    assert.ok([...workflows.values()].some((s) => s.size), 'no workflow holds a write scope; the reader is broken');
    const text = section(fs.readFileSync(path.join(repoRoot, PAGE), 'utf8'), SECTION);
    assert.deepEqual(mismatches(text, workflows), []);
});

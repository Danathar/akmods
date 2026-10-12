import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRegistry, parseBats, evaluate, renderTable } from '../coverage-gate.mjs';

const registryMd = `
### P1 — org
### P3 — README
### T2 — *(retired 2026-07-30)* ZFS akmod
### T3 — Hardened discovery
Not a heading: ### T9 inline
`;

const cfg = {
    patches: { floor: { percent: 100 }, exempt: { P3: 'prose' }, extraTags: ['GEN'] },
    bats: { floor: { tests: 2 } },
};

test('parseRegistry reads P/T headings and flags retired ones', () => {
    assert.deepEqual(parseRegistry(registryMd), [
        { id: 'P1', retired: false },
        { id: 'P3', retired: false },
        { id: 'T2', retired: true },
        { id: 'T3', retired: false },
    ]);
});

test('parseBats attributes covers tags only to the @test directly below', () => {
    const r = parseBats(['# covers: P1, T3', '@test "a" {', '}', '# covers: P3', '', 'helper() {', '}', '@test "b" {', '}'].join('\n'));
    assert.equal(r.tests, 2);
    assert.deepEqual([...r.tags].sort(), ['P1', 'T3']);
});

test('passes when every required patch is tagged and the test floor is met', () => {
    const r = evaluate(cfg, parseRegistry(registryMd), new Set(['P1', 'T3', 'GEN']), 2);
    assert.deepEqual(r.failures, []);
    assert.match(renderTable(r.rows), /\| fork patches with a bats test \| 100\.00% \(2\/2\) \| 100% \| ok \|/);
});

test('retired and exempt patches are not required', () => {
    const r = evaluate(cfg, parseRegistry(registryMd), new Set(['P1', 'T3']), 2);
    assert.deepEqual(r.failures, []);
});

test('an untested patch fails and is named', () => {
    const r = evaluate(cfg, parseRegistry(registryMd), new Set(['P1']), 2);
    assert.equal(r.failures.length, 1);
    assert.match(r.failures[0], /50\.00% is below the 100% floor; untested: T3/);
    assert.match(renderTable(r.rows), /BELOW FLOOR/);
});

test('a tag naming no known patch fails (typos, patches removed from the registry)', () => {
    const r = evaluate(cfg, parseRegistry(registryMd), new Set(['P1', 'T3', 'T99']), 2);
    assert.match(r.failures.join('\n'), /unknown patch 'T99'/);
});

test('an exempt id that is not in the registry fails', () => {
    const r = evaluate({ ...cfg, patches: { ...cfg.patches, exempt: { P3: 'x', P7: 'y' } } }, parseRegistry(registryMd), new Set(['P1', 'T3']), 2);
    assert.match(r.failures.join('\n'), /exempt patch P7 is not in the registry/);
});

test('too few bats tests fails', () => {
    const r = evaluate(cfg, parseRegistry(registryMd), new Set(['P1', 'T3']), 1);
    assert.match(r.failures.join('\n'), /bats: 1 tests is below the 2 floor/);
});

test('missing floors fail instead of passing silently', () => {
    const r = evaluate({ patches: {}, bats: {} }, parseRegistry(registryMd), new Set(), 0);
    assert.equal(r.failures.length, 2);
    assert.match(r.failures.join('\n'), /no floor configured/);
});

test('CLI exits 1 on a root with an untested patch', () => {
    const root = mkdtempSync(join(tmpdir(), 'cov-gate-'));
    try {
        mkdirSync(join(root, 'tests', 'unit'), { recursive: true });
        writeFileSync(join(root, 'FORK-PATCHES.md'), '### P1 — org\n### T1 — zfs\n');
        writeFileSync(join(root, 'tests', 'unit', 'a.bats'), '# covers: P1\n@test "x" {\n}\n');
        writeFileSync(
            join(root, '.coverage-thresholds.json'),
            JSON.stringify({ registry: 'FORK-PATCHES.md', testsDir: 'tests/unit', patches: { floor: { percent: 100 } }, bats: { floor: { tests: 1 } } })
        );
        const r = spawnSync('node', [resolve(dirname(fileURLToPath(import.meta.url)), '..', 'coverage-gate.mjs'), '--root', root], { encoding: 'utf8' });
        assert.equal(r.status, 1);
        assert.match(r.stderr, /untested: T1/);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

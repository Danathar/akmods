#!/usr/bin/env node
// Coverage gate for the shell-heavy akmods fork.
//
// Line coverage (kcov) says little here: the fork's behaviour lives in Justfile
// recipes and container-only build scripts. What protects the fork is that every
// patch in FORK-PATCHES.md that can be tested has a bats test pinning it. So the
// gate measures:
//   1. patch coverage: active, non-exempt patches (### P1 / ### T3 headings in
//      FORK-PATCHES.md) that have at least one `# covers: <id>` tag directly above
//      an `@test` in tests/unit/*.bats, against a percentage floor;
//   2. a floor on the total number of bats tests (guards against deleting tests);
//   3. tags that name no known patch (typos, patches removed from the registry)
//      are failures, so tags cannot rot.
// Thresholds live in .coverage-thresholds.json.
// Usage: node scripts/coverage-gate.mjs [--config <file>] [--root <dir>]
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** @returns {{id: string, retired: boolean}[]} patches from FORK-PATCHES.md headings */
export function parseRegistry(markdown) {
    const patches = [];
    for (const line of markdown.split('\n')) {
        const m = /^###\s+([PT]\d+)\b(.*)$/.exec(line);
        if (!m) continue;
        patches.push({ id: m[1], retired: /retired/i.test(m[2]) });
    }
    return patches;
}

/**
 * @param {string} bats contents of one .bats file
 * @returns {{tags: Set<string>, tests: number}} tags that sit directly above an @test, and the @test count
 */
export function parseBats(bats) {
    const tags = new Set();
    let tests = 0;
    let pending = [];
    for (const line of bats.split('\n')) {
        const cover = /^#\s*covers:\s*(.+?)\s*$/.exec(line);
        if (cover) {
            pending.push(...cover[1].split(/[\s,]+/).filter(Boolean));
            continue;
        }
        if (/^@test\s/.test(line)) {
            tests += 1;
            for (const t of pending) tags.add(t);
            pending = [];
        } else if (line.trim() !== '') {
            pending = [];
        }
    }
    return { tags, tests };
}

/**
 * @param {object} cfg parsed .coverage-thresholds.json
 * @param {{id: string, retired: boolean}[]} patches
 * @param {Set<string>} tags
 * @param {number} testCount
 */
export function evaluate(cfg, patches, tags, testCount) {
    const failures = [];
    const rows = [];
    const exempt = cfg.patches?.exempt ?? {};
    const extra = new Set(cfg.patches?.extraTags ?? []);
    const known = new Set(patches.map((p) => p.id));

    for (const id of Object.keys(exempt)) {
        if (!known.has(id)) failures.push(`exempt patch ${id} is not in the registry`);
    }
    for (const t of tags) {
        if (!known.has(t) && !extra.has(t)) {
            failures.push(`tests tag unknown patch '${t}' (not in the registry or extraTags)`);
        }
    }

    const required = patches.filter((p) => !p.retired && !(p.id in exempt));
    const covered = required.filter((p) => tags.has(p.id));
    const missing = required.filter((p) => !tags.has(p.id)).map((p) => p.id);
    const pct = required.length === 0 ? 0 : (covered.length / required.length) * 100;
    const pctFloor = cfg.patches?.floor?.percent;
    if (typeof pctFloor !== 'number') {
        failures.push('patches.floor.percent: no floor configured');
    } else {
        const ok = pct >= pctFloor;
        rows.push({ area: 'fork patches with a bats test', measured: `${pct.toFixed(2)}% (${covered.length}/${required.length})`, floor: `${pctFloor}%`, ok });
        if (!ok) {
            failures.push(`patches: ${pct.toFixed(2)}% is below the ${pctFloor}% floor; untested: ${missing.join(', ')}`);
        }
    }

    const testFloor = cfg.bats?.floor?.tests;
    if (typeof testFloor !== 'number') {
        failures.push('bats.floor.tests: no floor configured');
    } else {
        const ok = testCount >= testFloor;
        rows.push({ area: 'bats tests', measured: String(testCount), floor: String(testFloor), ok });
        if (!ok) failures.push(`bats: ${testCount} tests is below the ${testFloor} floor`);
    }
    return { rows, failures };
}

export function renderTable(rows) {
    const lines = ['| area | measured | floor | status |', '| --- | ---: | ---: | --- |'];
    for (const r of rows) {
        lines.push(`| ${r.area} | ${r.measured} | ${r.floor} | ${r.ok ? 'ok' : 'BELOW FLOOR'} |`);
    }
    return lines.join('\n');
}

function loadBats(dir) {
    const tags = new Set();
    let tests = 0;
    for (const name of readdirSync(dir).filter((n) => n.endsWith('.bats')).sort()) {
        const r = parseBats(readFileSync(join(dir, name), 'utf8'));
        r.tags.forEach((t) => tags.add(t));
        tests += r.tests;
    }
    return { tags, tests };
}

function main(argv) {
    const arg = (name, dflt) => {
        const i = argv.indexOf(name);
        return i >= 0 ? argv[i + 1] : dflt;
    };
    const root = resolve(arg('--root', process.cwd()));
    const cfg = JSON.parse(readFileSync(resolve(root, arg('--config', '.coverage-thresholds.json')), 'utf8'));
    const patches = parseRegistry(readFileSync(resolve(root, cfg.registry), 'utf8'));
    const { tags, tests } = loadBats(resolve(root, cfg.testsDir));
    const { rows, failures } = evaluate(cfg, patches, tags, tests);
    console.log(renderTable(rows));
    if (failures.length) {
        console.error('\nCoverage gate FAILED:');
        for (const f of failures) console.error(`  - ${f}`);
        process.exit(1);
    }
    console.log('\nCoverage gate passed.');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
    main(process.argv.slice(2));
}

// `node --test` with no arguments skips dot-directories, so the hook tests in
// .claude/**/*.test.mjs would never run, locally or in agent-tooling.yml.
// Importing them here registers their tests in this file's run and keeps
// bare `node --test` the one command for every Node test in the repository.
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.claude');
const files = readdirSync(dir, { recursive: true })
    .filter((rel) => rel.endsWith('.test.mjs'))
    .sort();

test('.claude test files are found (a move would silently drop them)', () => {
    assert.ok(files.length > 0, `no *.test.mjs under ${dir}`);
});

for (const rel of files) {
    await import(pathToFileURL(join(dir, rel)).href);
}

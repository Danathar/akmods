// Every glob in .github/labeler.yml must match at least one tracked file, or
// the rule is dead and nothing notices. Dependency-free: a tiny glob matcher
// (`**`, `*`, `?`) over `git ls-files` (plus untracked, so a fresh checkout of unstaged work behaves the same), matching actions/labeler's minimatch
// semantics closely enough for the patterns used here (dotfiles included).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const ROOT = new URL('../../', import.meta.url).pathname;

export function globToRegExp(glob) {
    let re = '';
    for (let i = 0; i < glob.length; i++) {
        const c = glob[i];
        if (c === '*') {
            if (glob[i + 1] === '*') {
                // `**/` = zero or more directories; trailing `**` = anything.
                if (glob[i + 2] === '/') {
                    re += '(?:.*/)?';
                    i += 2;
                } else {
                    re += '.*';
                    i += 1;
                }
            } else {
                re += '[^/]*';
            }
        } else if (c === '?') {
            re += '[^/]';
        } else {
            re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
        }
    }
    return new RegExp(`^${re}$`);
}

/** Quoted glob strings from labeler.yml (label keys end in `:` and are skipped). */
export function readGlobs(text) {
    const globs = [];
    for (const line of text.split('\n')) {
        const m = /^\s*(?:-\s+|any-glob-to-any-file:\s+)'([^']+)'\s*$/.exec(line);
        if (m) globs.push(m[1]);
    }
    return globs;
}

const tracked = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' });
const files = tracked.stdout.split('\n').filter(Boolean);
const globs = readGlobs(readFileSync(`${ROOT}.github/labeler.yml`, 'utf8'));

test('git ls-files works and the labeler config has globs', () => {
    assert.equal(tracked.status, 0, tracked.stderr);
    assert.ok(files.length > 0);
    assert.ok(globs.length >= 10, `only ${globs.length} globs parsed`);
});

test('globToRegExp semantics', () => {
    assert.ok(globToRegExp('a/**').test('a/b/c.sh'));
    assert.ok(globToRegExp('*.md').test('README.md'));
    assert.ok(!globToRegExp('*.md').test('docs/x.md'));
    assert.ok(globToRegExp('.github/workflows/build-akmods-*.yml').test('.github/workflows/build-akmods-main.yml'));
    assert.ok(!globToRegExp('Justfile').test('Justfile.bak'));
    assert.ok(globToRegExp('x/**/y.sh').test('x/y.sh'));
});

for (const glob of new Set(globs)) {
    test(`labeler glob matches a tracked file: ${glob}`, () => {
        const re = globToRegExp(glob);
        assert.ok(files.some((f) => re.test(f)), `no tracked file matches ${glob}`);
    });
}

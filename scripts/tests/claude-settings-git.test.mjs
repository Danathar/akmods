// The `env` block in .claude/settings.json sets git's safe.bareRepository to
// `explicit` for every command an agent runs. Without it, a bare repository
// committed as ordinary files in a checked-out branch is picked up by
// pre-approved git commands (`git -C dir fetch`, or `git fetch` after `cd dir`),
// and its config can name a program for git to run (remote.*.uploadpack,
// core.sshCommand, core.fsmonitor, ...) with no permission prompt. The guard
// hook cannot see that config, so git itself has to refuse the repository.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SETTINGS = fileURLToPath(new URL('../../.claude/settings.json', import.meta.url));
const settingsEnv = JSON.parse(readFileSync(SETTINGS, 'utf8')).env ?? {};

// A clean git environment: no user or system config, no inherited GIT_* overrides.
function baseEnv(home) {
    return { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
}

function git(cwd, env, ...args) {
    return spawnSync('git', args, { cwd, env, encoding: 'utf8' });
}

// Builds a clone whose tree carries a committed bare repository `evil/` whose
// upload-pack writes `marker`. Returns the clone's path.
function plantedClone(dir, marker) {
    const env = baseEnv(dir);
    const src = join(dir, 'src');
    const evil = join(src, 'evil');
    assert.equal(git(dir, env, 'init', '-q', src).status, 0);
    assert.equal(git(src, env, 'init', '-q', '--bare', 'evil').status, 0);
    writeFileSync(join(evil, 'refs', 'heads', '.keep'), '');
    writeFileSync(join(evil, 'objects', '.keep'), '');
    assert.equal(git(evil, env, 'config', 'remote.origin.url', src).status, 0);
    assert.equal(git(evil, env, 'config', 'remote.origin.uploadpack', `touch '${marker}'; git-upload-pack`).status, 0);
    assert.equal(git(src, env, 'add', 'evil').status, 0);
    assert.equal(git(src, env, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'x').status, 0);
    assert.equal(git(dir, env, 'clone', '-q', src, 'victim').status, 0);
    return join(dir, 'victim');
}

test('settings.json sets safe.bareRepository=explicit through GIT_CONFIG_* for agent commands', () => {
    assert.deepEqual(settingsEnv, {
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'safe.bareRepository',
        GIT_CONFIG_VALUE_0: 'explicit',
    });
});

test('a committed bare repository cannot make a pre-approved git fetch run a program', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'bare-repo-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const marker = join(dir, 'ran');
    const victim = plantedClone(dir, marker);
    const agentEnv = { ...baseEnv(dir), ...settingsEnv };

    // The planted program does run without the setting, so the check below is real.
    git(victim, baseEnv(dir), '-C', 'evil', 'fetch', 'origin');
    assert.ok(existsSync(marker), 'precondition: without safe.bareRepository the planted upload-pack runs');
    rmSync(marker);

    for (const [cwd, args] of [
        [victim, ['-C', 'evil', 'fetch', 'origin']],
        [join(victim, 'evil'), ['fetch', 'origin']],
    ]) {
        const r = git(cwd, agentEnv, ...args);
        assert.notEqual(r.status, 0, `git ${args.join(' ')} should refuse the bare repository`);
        assert.match(r.stderr, /safe\.bareRepository/);
        assert.ok(!existsSync(marker), `git ${args.join(' ')} ran the planted program`);
    }

    // The checkout's own repository (.git/, not bare) still works with the setting.
    assert.equal(git(victim, agentEnv, 'status', '--short').status, 0);
    assert.equal(git(victim, agentEnv, 'log', '-1', '--format=%s').stdout.trim(), 'x');
});

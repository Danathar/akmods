#!/usr/bin/env node
// PreToolUse hook for Claude Code's Bash tool (wired up in .claude/settings.json).
//
// Threat model: this hook prevents an agent that is following instructions
// from carelessly or accidentally (a) writing to the wrong GitHub repository,
// most importantly the read-only upstream ublue-os/akmods, (b) running
// destructive git commands, (c) running builds, kernel downloads, pushes,
// `sudo`, package installs, local containers or signing on the developer's
// workstation, and (d) writing real signing keys into certs/. It is NOT a
// sandbox against deliberate obfuscation (eval of built strings, shell
// variables, scripts written to disk and executed, aliases, ...). The real
// boundaries are token scope, repository access and review of the changes;
// findings that need deliberate obfuscation are out of scope here.
//
// Why: this repository (Danathar/akmods) is a fork of ublue-os/akmods. A bare
// `gh` write in a clone resolves its target from git remotes or gh's default,
// which is how an agent files an issue or PR on the upstream. And the
// Justfile's `build`/`test`/`fetch-kernel` recipes download kernels and run
// podman builds, `sudo`/dnf-based scripts install packages: on an immutable
// Fedora workstation that is real damage, and the fork's verification belongs
// in GitHub Actions. See FORK-PATCHES.md for the fork's operational state.
//
// Protocol (https://docs.anthropic.com/en/docs/claude-code/hooks): the hook
// receives JSON on stdin ({ tool_name, tool_input: { command } }). Exit 0 lets
// the call proceed; exit 2 blocks it and feeds stderr back to the model.
//
// Rule list (fail closed when unsure):
//   GitHub
//   G1  gh pr|issue|discussion|release|workflow|run|label|repo|secret|variable|
//       ruleset|cache|codespace writes that are not read-only and do not target
//       Danathar/akmods via --repo/-R or a GH_REPO= prefix; a write naming a
//       github.com URL of another repository (ublue-os/akmods included).
//   G2  gh groups outside the read-only allowlist (unknown groups, `gh alias`).
//   G3  gh api with a mutating method (or -f/-F/--input body) outside
//       repos/Danathar/akmods; GraphQL mutations or opaque queries.
//   G4  gh pr create without an explicit --base main and --head <branch>.
//   G5  Repository-settings writes even on Danathar/akmods: gh secret|variable
//       writes, gh ruleset writes, gh workflow enable|disable, gh repo
//       edit|delete|archive|rename, and gh api writes to actions/secrets,
//       actions/variables, workflow enable/disable, rulesets, branch
//       protection, hooks, keys, collaborators.
//   git
//   T1  git push with force, --mirror, --repo, a remote other than `origin`
//       (so `git push upstream` and pushing to any URL, the ublue-os/akmods
//       URL included, are refused), or no explicit remote.
//   T2  git config / git remote changes that re-point `origin`, give any
//       remote a push URL other than DISABLE, or touch url.*/credential.*.
//   T3  git options that write a file, read outside the repository or run a
//       program on the pre-approved read commands (--output, --no-index,
//       --ext-diff, git grep -O, --exec-path, `-c diff.external=` ...);
//       --upload-pack (and its abbreviations such as --upl), --exec and
//       clone/ls-remote -u on git fetch|pull|clone|ls-remote|archive, which
//       run the named program; `-c protocol.*` (protocol.ext.allow=always);
//       GIT_* / PAGER / EDITOR variables other than identity and no-op pagers.
//   T4  git, node or a shell run through xargs (run-time arguments).
//   T5  `bash -n` with a word starting with + or one bash could expand into one.
//   node
//   N1  `node --test` with any option outside the test-runner allowlist, and
//       node with NODE_OPTIONS or another NODE_* variable. `node --test` after a
//       directory change (see C1).
//   Host safety
//   H1  just: only read-only evaluation (`--list`, `--evaluate`, `--dry-run`,
//       `--show`, `--summary`, `--dump`, `--fmt --check`, bare `just`). Naming
//       any recipe without a read flag is refused: build, test, fetch-kernel,
//       push, manifest, clean, generate-workflows, ... `--edit`, `--command`,
//       `--shell*`, `--init`, `--choose` are refused. Variable overrides
//       (`--set NAME VALUE`, `--set=...`, `NAME=VALUE` before or after `--`)
//       are refused too: the Justfile builds `shell()` commands from its
//       variables while evaluating, so overriding one (e.g. `yq`) runs any
//       program even under `--evaluate`/`--dry-run`. So is choosing another
//       justfile or environment file (`--justfile`/`-f` other than this
//       checkout's Justfile, `--justfile-name`, `-g`, `-d`, `--dotenv-path`,
//       `--dotenv-filename`, a `DIR/recipe` argument, any JUST_* variable):
//       evaluation runs every backtick and shell() in it. `--dotenv-command`
//       runs its command outright. Any `just` after a directory change (C1).
//   H2  Executing fetch-kernel.sh, build_files/**/*.sh or tests/e2e/**/*.sh:
//       directly, via a shell, source, `.`, wrappers, systemd-run, stdin, or
//       as a bats operand or --setup-suite-file (bats runs the top level of
//       every file it is given; a glob, brace or $ in those words is refused
//       too). `find -exec` with `{}` where a host script would run is refused
//       (`-exec {} ;`, `-exec bash {} ;`): {} can be any file find reaches.
//       shellcheck, `bash -n`, cat, grep, bats on tests/unit are fine.
//   H3  sudo / doas / pkexec / run0 / su / runuser in any position of a
//       wrapper chain, behind `find -exec` included; distrobox enter /
//       toolbox run|enter (the real container).
//   H4  dnf/dnf5/yum/microdnf subcommands other than read-only queries;
//       rpm install/upgrade/freshen/erase modes; rpm-ostree / bootc / pkcon
//       subcommands other than read-only ones.
//   H5  podman/docker/nerdctl (and `container|image|system ...` groups): only
//       read-only queries (ps, images, inspect, ls, ...); build, run, push,
//       pull, login, exec, system prune and the rest are refused.
//   H6  cosign other than verification (sign, attest, generate-key-pair,
//       login, ...); skopeo other than inspect/list-tags.
//   Pre-approved linters and test runners
//   L1  Options that make them run a program they are handed or write files:
//       actionlint -shellcheck/-pyflakes with a value (an empty value, which
//       turns the integration off, is fine); yq -i/--inplace, -s/--split-exp,
//       --split-exp-file and --security-enable-system-operator; bats (also
//       through npx) -F/--formatter or --report-formatter naming anything but
//       a built-in formatter, and --parallel-binary-name.
//   Working directory
//   C1  just, `node --test` and bats (also through npx) when the working
//       directory may differ from the checkout root: `cd`, `pushd` or `popd`
//       anywhere in the same command line (a `( cd DIR && ... )` subshell or a
//       substitution included, or reached through eval, a `function` body or an
//       expanded command name such as `$X`), `env -C DIR`, chroot, nsenter,
//       `unshare --wd|--root`, or `find -execdir|-okdir`. just looks for its justfile from the
//       current directory upwards, so `cd sub && just --evaluate` evaluates
//       sub/justfile, and `--justfile Justfile`, `node --test .claude/hooks/tests`
//       and `bats tests/unit` name files relative to it: the pre-approved forms
//       would run another directory's code. Run them from the checkout root.
//   Signing material
//   K1  Writes (redirect, tee, cp, mv, install, ln, truncate, dd of=,
//       openssl -out/-keyout) to certs/ files other than *.test, or to any
//       .priv/.key/.pem/.p12/.pfx file.
//
// Parsing notes: redirections (`>log`, `2>&1`, `&>f`, `<file`) end the word
// and are not arguments, but `>` targets are remembered for K1. A shell with
// no script operand that reads a host-modifying script on stdin counts as
// running it. Quoted heredoc bodies are data. Wrappers (env, timeout, xargs,
// time, flock, watch, taskset, chrt, unshare, nsenter, setpriv, chroot,
// busybox, exec -a, ...) are looked through to the command they run, not to
// a later argument; so are `find -exec|-execdir|-ok|-okdir CMD ... ;`, the
// body after `function NAME` and the command after `coproc`. Behind any
// other program (`setarch x86_64`, `prlimit`, `strace -o log`,
// `script -qc '...'`), each later word naming a command this hook checks, and
// each command string a word carries, is checked as though it stood alone; a
// host-modifying script named there is not, since `less fetch-kernel.sh` and
// a program that runs it look alike. A command name is read as the shell
// builds it: `$'...'` escapes are decoded (`$'\x67it'` is git), a brace group
// that can expand to a checked command (`{git,}`) is refused, and a wildcard
// (`/usr/bin/g?t`, or `g?t` beside a file named git) is read as the checked
// program it matches; a command name made only of wildcards (`*`) is refused. Read-only gh
// commands (view, list, status, diff, checks, api GET, ...) are always
// allowed. The command is split into segments on && || ; | & newlines,
// subshells and command substitutions; shell -c, eval, watch and
// `flock FILE -c` strings are analysed recursively. Quoted text is data, so
// a quoted "sudo" inside an `echo` is fine.
//
// Layout: the reading described in these notes (words, quotes, `$'...'`,
// substitutions and heredocs, brace and wildcard names, wrappers and the
// commands they run, shell and fish command strings, the git option, config
// and environment rules, the time budget) lives in shell-reader.mjs. That file
// names no repository and is kept byte-identical in every repository that
// carries this guard (its sha256 is pinned by scripts/tests/shell-reader.test.mjs);
// a reading fix is made in Danathar/akmods first and then copied. This file
// holds this repository's rules (the list above), its messages and the hook's
// entry point, and imports the reader.

import { basename, resolve } from 'node:path';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
// Reading the command line as the shell would is shared with the other
// repositories that carry this guard; see shell-reader.mjs.
import {
    ARGUMENT_ONLY_PROGRAMS, BUDGET_MS, changesDirectory, CHDIR, COMMAND_STRING_SEPARATORS, commandNameReader,
    commandStrings, EXEC_GIT_CONFIG, expandWrapperOptions, extractSubstitutions, FIND_EXEC, firstWord, fishScripts,
    GIT_EXEC_OPTION, GIT_SHORT_UPLOAD_PACK, GIT_UPLOAD_PACK_OPTION, GIT_UPLOAD_PACK_SUBCOMMANDS, isAssignment,
    KEYWORDS, MAX_UNLISTED_INNER, OverBudget, REFUSED_GIT_OPTION, RISKY_GIT_CONFIG, riskyEnv, SAFE_ENV, SHELLS,
    spend, startBudget, tokenize, unquoted, WATCHED_ENV, WRAPPERS, wrapperTarget,
} from './shell-reader.mjs';

// Kept importable from here, where they were defined before the split.
export { BUDGET_MS, extractSubstitutions, tokenize } from './shell-reader.mjs';

export const REPO = 'danathar/akmods';
export const UPSTREAM = 'ublue-os/akmods';

const GUIDANCE =
    'Hard rules for this repository: never run `just build|test|fetch-kernel|push|manifest|clean`, sudo, a package install, ' +
    '`podman build|push|login|system prune` or `cosign sign` on this workstation (container and build verification run in ' +
    'GitHub Actions on the pull request), and never write real signing keys into certs/. ' +
    'GitHub writes go to Danathar/akmods (add `--repo Danathar/akmods`); ublue-os/akmods is the read-only upstream. ' +
    'Git pushes only to `origin`.';

/** True for the read-only upstream (ublue-os/akmods) in any repo spelling. */
function isUpstream(value) {
    return normalizeRepo(value) === UPSTREAM;
}

// Non-read gh actions that change repository settings even on the target repo.
const GH_SETTINGS_WRITES = {
    secret: ['*'],
    variable: ['*'],
    ruleset: ['*'],
    workflow: ['enable', 'disable'],
    repo: ['edit', 'delete', 'archive', 'unarchive', 'rename'],
};
const GH_API_SETTINGS = /^(actions\/(secrets|variables)|actions\/workflows\/[^/]+\/(enable|disable)|rulesets|branches\/[^/]+\/protection|hooks|keys|collaborators)(\/|\?|$)/i;

// gh command groups whose non-read actions mutate a repository.
// Value = actions that are read-only (or purely local) and need no --repo.
const GH_GROUPS = {
    pr: ['view', 'list', 'status', 'diff', 'checks', 'checkout'],
    issue: ['view', 'list', 'status'],
    release: ['view', 'list', 'download', 'verify', 'verify-asset'],
    workflow: ['view', 'list'],
    run: ['view', 'list', 'watch', 'download'],
    label: ['list'],
    repo: ['view', 'list', 'clone', 'gitignore', 'license'],
    secret: ['list'],
    variable: ['list', 'get'],
    ruleset: ['list', 'view', 'check'],
    cache: ['list'],
    discussion: ['view', 'list'],
    codespace: ['list', 'view', 'logs', 'ports'],
};

// gh groups outside GH_GROUPS that may run without a repo target.
// true = every action is read-only or local; array = only those actions.
const GH_OTHER_READONLY = {
    auth: ['status'],
    browse: true,
    search: true,
    status: true,
    config: ['get', 'list'],
    alias: ['list'],
    extension: ['list', 'search', 'browse'],
    'ssh-key': ['list'],
    'gpg-key': ['list'],
    org: ['list'],
    project: ['list', 'view', 'field-list', 'item-list'],
    attestation: ['verify', 'inspect', 'trusted-root'],
    completion: true,
    help: true,
    version: true,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Normalise OWNER/REPO, HOST/OWNER/REPO, or a github URL to "owner/repo". */
export function normalizeRepo(value) {
    return String(value)
        .trim()
        .toLowerCase()
        .replace(/^(?:https?:\/\/|git@|ssh:\/\/git@)?github\.com[/:]/, '')
        .replace(/\.git$/, '')
        .replace(/\/+$/, '');
}

/** True if a word is a github.com URL (or git@/ssh form) for a repository other than REPO. */
export function namesOtherRepo(word) {
    const m = /^(?:https?:\/\/|git@|ssh:\/\/git@)github\.com[/:]([^/\s]+\/[^/\s]+?)(?:\.git)?(?:\/.*)?$/i.exec(
        String(word)
    );
    return m !== null && m[1].toLowerCase() !== REPO;
}

function isTarget(value) {
    return normalizeRepo(value) === REPO;
}

/**
 * Extract the effective --repo/-R value from gh args, or null. gh honours the
 * LAST repeated flag, so a fork flag followed by another repo must not pass:
 * if any value is not the fork, that one is returned; otherwise the last.
 */
function repoFlag(args) {
    const values = [];
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '--repo' || a === '-R') values.push(args[++i] ?? '');
        else if (a.startsWith('--repo=')) values.push(a.slice(7));
        else if (a.startsWith('-R') && a.length > 2 && !a.startsWith('--')) values.push(a.slice(2));
    }
    if (!values.length) return null;
    return values.find((v) => !isTarget(v)) ?? values[values.length - 1];
}

const block = (reason) => ({ blocked: true, reason: `${reason}\n${GUIDANCE}` });

// ---------------------------------------------------------------------------
// gh
// ---------------------------------------------------------------------------

function checkGhApi(args) {
    let method = null;
    let hasBody = false;
    const positionals = [];
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '-X' || a === '--method') method = (args[++i] ?? '').toUpperCase();
        else if (a.startsWith('--method=')) method = a.slice(9).toUpperCase();
        else if (/^-X./.test(a)) method = a.slice(2).toUpperCase();
        else if (['-f', '-F', '--field', '--raw-field', '--input'].includes(a)) {
            hasBody = true;
            i++;
        } else if (/^--(field|raw-field|input)=/.test(a) || /^-[fF]./.test(a)) hasBody = true;
        else if (['-H', '--header', '--hostname', '-q', '--jq', '-t', '--template', '--cache'].includes(a)) i++;
        else if (!a.startsWith('-')) positionals.push(a);
    }
    const endpoint = (positionals[0] ?? '').replace(/^\/+/, '');
    const mutating = method ? !['GET', 'HEAD'].includes(method) : hasBody;
    const isGraphql = endpoint.toLowerCase() === 'graphql';

    if (isGraphql) {
        // GraphQL is always POST; allow queries, refuse mutations (target unknowable).
        if (args.some((a) => /\bmutation\b/i.test(a))) {
            return block('Blocked: `gh api graphql` mutation. The target repository cannot be verified.');
        }
        // The query must be a visible literal: a body from a file/stdin (--input,
        // query=@file) or a shell variable could hide a mutation.
        const query = args.map((a) => /^query=([\s\S]*)$/.exec(a)).find(Boolean);
        const opaque =
            args.some((a) => a === '--input' || a.startsWith('--input=')) ||
            !query ||
            /^[@$]/.test(query[1]);
        if (opaque) {
            return block('Blocked: `gh api graphql` without an inline literal `-f query=...`; the request cannot be inspected for mutations.');
        }
        return null;
    }
    if (!mutating) return null;

    // `{owner}/{repo}` placeholders resolve to gh's default repo, which may be a different repository.
    const m = /^repos\/([^/]+\/[^/?#]+)(?:[/?#]|$)/i.exec(endpoint);
    if (m && m[1].toLowerCase() === REPO) {
        const sub = endpoint.slice(m[0].length);
        if (GH_API_SETTINGS.test(sub)) {
            return block(`Blocked: mutating \`gh api\` call to "${endpoint}" changes secrets, rulesets, branch protection or workflow enablement; ask the owner.`);
        }
        return null;
    }

    return block(
        `Blocked: mutating \`gh api\` call (${method ?? 'implicit POST'}) to "${endpoint || '?'}"; ` +
            'only paths under repos/Danathar/akmods are allowed.' +
            (m && m[1].toLowerCase() === UPSTREAM ? ` ${UPSTREAM} is the read-only upstream.` : '')
    );
}

function checkGh(args, envRepo) {
    // Locate group and action (first two non-flag words).
    // The value of --repo/-R is not a command word, wherever the flag sits
    // (`gh -R chrisvel/tududi pr create` must still resolve to group "pr").
    const plain = args.filter((a, n) => !a.startsWith('-') && !['--repo', '-R'].includes(args[n - 1]));
    const group = plain[0];
    if (!group) return null;

    if (group === 'api') return checkGhApi(args.slice(args.indexOf('api') + 1));
    if (!Object.hasOwn(GH_GROUPS, group)) {
        // Fail closed: groups outside GH_GROUPS pass only via the explicit
        // read-only allowlist (GH_OTHER_READONLY). This also covers `gh alias set`,
        // which could define an alias that hides a write.
        const allowed = GH_OTHER_READONLY[group];
        if (allowed === true || (Array.isArray(allowed) && allowed.includes(plain[1] ?? ''))) return null;
        return block(
            `Blocked: \`gh ${group} ${plain[1] ?? ''}\` is not on the read-only allowlist ` +
                '(unknown or mutating gh command; the target repository cannot be verified).'
        );
    }

    const action = plain[1] ?? '';
    const flagRepo = repoFlag(args);
    const target = flagRepo ?? envRepo;

    if (group === 'repo' && action === 'set-default') {
        const rest = plain.slice(2);
        if (args.includes('--view') || args.includes('-v')) return null;
        if (rest.length === 1 && isTarget(rest[0])) return null;
        return block('Blocked: `gh repo set-default` must be `gh repo set-default Danathar/akmods` (or --view).');
    }

    if (GH_GROUPS[group].includes(action)) return null; // read-only
    if (GH_SETTINGS_WRITES[group]?.includes(action) || GH_SETTINGS_WRITES[group]?.includes('*')) {
        return block(
            `Blocked: \`gh ${group} ${action}\` changes repository settings, secrets or workflow enablement ` +
                '(the Build workflows are disabled on purpose; see FORK-PATCHES.md). Ask the owner.'
        );
    }

    // A write whose arguments name another repository's github.com URL
    // (`gh pr merge https://github.com/other/x/pull/1`): gh uses the URL, not
    // --repo, so it is refused even when --repo points at this repository.
    const other = args.find(namesOtherRepo);
    if (other !== undefined) {
        return block(
            `Blocked: \`gh ${group} ${action}\` names another repository ("${other}").` +
                (isUpstream(other) ? ` ${UPSTREAM} is the read-only upstream.` : '')
        );
    }

    if (group === 'repo') {
        // Repo-scoped writes take the repo as a positional argument.
        const positional = plain.slice(2);
        if (isTarget(flagRepo ?? '') || (positional.length && isTarget(positional[0])) || isTarget(envRepo ?? '')) return null;
        return block(`Blocked: \`gh repo ${action}\` without an explicit Danathar/akmods target.`);
    }

    if (target === null) {
        return block(`Blocked: \`gh ${group} ${action}\` has no --repo/-R/GH_REPO; gh would resolve the repository from git remotes or its default.`);
    }
    if (!isTarget(target)) {
        return block(
            `Blocked: \`gh ${group} ${action}\` targets "${target}", not Danathar/akmods.` +
                (isUpstream(target) ? ` ${UPSTREAM} is the read-only upstream: never open PRs, issues or comments there.` : '')
        );
    }
    if (group === 'pr' && action === 'create') return checkPrCreate(args);
    return null;
}

/** Convention: PRs are created with an explicit `--base main` and `--head <branch>`. */
function checkPrCreate(args) {
    // Flags whose value must be skipped so e.g. `--body "-Bump deps"` is not read as `-B`.
    const takesValue = new Set([
        '--title', '-t', '--body', '-b', '--body-file', '-F', '--label', '-l', '--assignee', '-a',
        '--reviewer', '-r', '--milestone', '-m', '--project', '-p', '--template', '-T',
    ]);
    const flagValue = (long, short) => {
        let found = null;
        for (let i = 0; i < args.length; i++) {
            const a = args[i];
            if (a === long || a === short) found = args[i + 1] ?? '';
            else if (a.startsWith(`${long}=`)) found = a.slice(long.length + 1);
            else if (a.startsWith(short) && a.length > 2 && !a.startsWith('--')) found = a.slice(2); // -Bdevelop
            if (a === long || a === short || takesValue.has(a)) i++; // skip this flag's value
        }
        return found; // gh honours the last occurrence of a repeated flag
    };
    const base = flagValue('--base', '-B');
    const head = flagValue('--head', '-H');
    if (base !== 'main') {
        return block('Blocked: `gh pr create` needs an explicit `--base main`.');
    }
    if (!head) {
        return block('Blocked: `gh pr create` needs an explicit `--head <branch>`.');
    }
    return null;
}

// ---------------------------------------------------------------------------
// git (the option, config and environment rules are in shell-reader.mjs)
// ---------------------------------------------------------------------------

function checkGit(args, inlineEnv = {}, exported = {}) {
    // Walk global options to find the subcommand, vetting `-c key=value`.
    let i = 0;
    while (i < args.length && args[i].startsWith('-')) {
        const a = args[i];
        let configKey = null;
        if (a === '-c' || a === '--config-env') configKey = (args[i + 1] ?? '').split('=')[0];
        else if (a.startsWith('--config-env=')) configKey = a.slice(13).split('=')[0];
        if (configKey !== null && RISKY_GIT_CONFIG.test(configKey)) {
            return block(`Blocked: \`git ${a} ${configKey}=...\` could redirect pushes or credentials.`);
        }
        if (configKey !== null && EXEC_GIT_CONFIG.test(configKey)) {
            return block(`Blocked: \`git ${a} ${configKey}=...\` makes git run a program or read other config.`);
        }
        if (a.startsWith('--exec-path=')) {
            return block('Blocked: `git --exec-path=DIR` runs git commands from another directory.');
        }
        i += ['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env'].includes(a) ? 2 : 1;
    }
    const sub = args[i];
    const rest = args.slice(i + 1);

    const env = { ...exported, ...inlineEnv };
    if (sub === 'push') {
        const pushKey = Object.keys(env).find((k) => /^(GIT_CONFIG_|GIT_SSH)/i.test(k));
        if (pushKey) return block(`Blocked: \`git push\` with ${pushKey}= could redirect the push.`);
    }
    const envKey = riskyEnv(env);
    if (envKey) {
        return block(
            `Blocked: \`git\` with ${envKey} set; it can make git run a program, write a file or read another repository/config. ` +
                'Only GIT_AUTHOR_*/GIT_COMMITTER_* identity and PAGER/GIT_PAGER/GIT_EDITOR=cat|true are allowed.'
        );
    }
    const refused = args.find((a) => REFUSED_GIT_OPTION.test(a)) ?? (sub === 'grep' ? rest.find((a) => /^-[a-zA-Z]*O/.test(a)) : undefined);
    if (refused !== undefined) {
        return block(
            `Blocked: \`git ${sub ?? ''} ${refused}\` writes a file, reads outside the repository or runs a program. ` +
                'Read the output on stdout instead (pipe it, or use the Write tool to save it).'
        );
    }
    if (GIT_UPLOAD_PACK_SUBCOMMANDS.has(sub)) {
        const program = rest.find(
            (a) =>
                GIT_UPLOAD_PACK_OPTION.test(a) ||
                ((sub === 'ls-remote' || sub === 'archive') && GIT_EXEC_OPTION.test(a)) ||
                ((sub === 'clone' || sub === 'ls-remote') && GIT_SHORT_UPLOAD_PACK.test(a))
        );
        if (program !== undefined) {
            return block(
                `Blocked: \`git ${sub} ${program}\` runs the program it names (--upload-pack, --exec, clone/ls-remote -u). ` +
                    'Use plain `git fetch [remote]`.'
            );
        }
    }
    if (sub === 'push') return checkGitPush(rest);
    if (sub === 'remote') return checkGitRemote(rest);
    if (sub === 'config') return checkGitConfig(rest);
    return null;
}

/** Writes to push-redirecting config keys (`git config remote.origin.url ...`). */
function checkGitConfig(rest) {
    // Only flags that pick a read mode. --show-origin/--show-scope are display
    // modifiers: `git config --show-scope remote.origin.url URL` still writes.
    const readOnly = ['--get', '--get-all', '--get-regexp', '--get-urlmatch', '--list', '-l'];
    if (rest.some((a) => readOnly.includes(a))) return null;

    // Collect positionals, skipping the values of options that take one
    // (`git config -f .git/config remote.origin.url <url>`).
    const valueFlags = ['-f', '--file', '--blob', '--type', '--default', '--comment', '--value', '--url'];
    const positionals = [];
    for (let k = 0; k < rest.length; k++) {
        const a = rest[k];
        if (valueFlags.includes(a)) k++;
        else if (!a.startsWith('-')) positionals.push(a);
    }

    // Modern syntax: `git config set|unset|replace-all|... <key> [value]`.
    const verbs = ['set', 'unset', 'replace-all', 'add', 'rename-section', 'remove-section', 'edit'];
    const readVerbs = ['get', 'list'];
    let modifies = false;
    const verbRenames = positionals[0] === 'rename-section';
    if (positionals.length && readVerbs.includes(positionals[0])) return null;
    if (positionals.length && verbs.includes(positionals[0])) {
        if (positionals[0] === 'edit') {
            return block('Blocked: `git config edit` could redirect pushes or credentials.');
        }
        positionals.shift();
        modifies = true;
    }
    const key = positionals[0];
    // Legacy syntax: a write is `key value`, or --unset/--add/--replace-all/section edits.
    modifies =
        modifies ||
        positionals.length > 1 ||
        rest.some((a) => /^--(unset|unset-all|add|replace-all|remove-section|rename-section)$/.test(a));
    if (key !== undefined && RISKY_GIT_CONFIG.test(key) && modifies) {
        return block(`Blocked: \`git config ${key}\` write could redirect pushes or credentials.`);
    }
    // Section renames move settings between names: check both the old and the new
    // section (`git config rename-section foo remote.origin` adopts foo.pushurl).
    const renames = verbRenames || rest.includes('--rename-section');
    if (renames && positionals.some((p) => RISKY_GIT_CONFIG.test(`${p}.x`))) {
        return block('Blocked: `git config rename-section` involving a remote/url/credential section could redirect pushes.');
    }
    if (rest.includes('--edit') || rest.includes('-e')) {
        return block('Blocked: `git config --edit` could redirect pushes or credentials.');
    }
    return null;
}

function checkGitPush(rest) {
    const positionals = [];
    for (let i = 0; i < rest.length; i++) {
        const a = rest[i];
        if (['-o', '--push-option', '--receive-pack', '--exec'].includes(a)) i++;
        else if (a === '--repo' || a.startsWith('--repo=')) {
            return block('Blocked: `git push --repo` redirects the push; name the remote `origin` instead.');
        } else if (a === '--force' || a.startsWith('--force-with-lease') || a === '--force-if-includes') {
            return block('Blocked: force push.');
        } else if (a === '--mirror') {
            return block('Blocked: `git push --mirror` overwrites the remote.');
        } else if (/^-[a-zA-Z]*f[a-zA-Z]*$/.test(a)) {
            return block('Blocked: force push (-f).');
        } else if (!a.startsWith('-')) positionals.push(a);
    }
    const [remote, ...refspecs] = positionals;
    if (remote === undefined) {
        return block('Blocked: `git push` without an explicit remote; use `git push origin <branch>`.');
    }
    if (remote !== 'origin') {
        const upstream = remote === 'upstream' || normalizeRepo(remote) === UPSTREAM || namesOtherRepo(remote);
        return block(
            upstream
                ? `Blocked: \`git push ${remote}\` targets the read-only upstream ${UPSTREAM} (or another repository); only \`origin\` (Danathar/akmods) may be pushed to.`
                : `Blocked: \`git push ${remote}\`; only the \`origin\` remote may be pushed to.`
        );
    }
    if (refspecs.some((r) => r.startsWith('+'))) {
        return block('Blocked: force push via "+" refspec.');
    }
    return null;
}

function checkGitRemote(rest) {
    const sub = rest[0];
    const flags = [];
    const plain = [];
    for (let k = 1; k < rest.length; k++) {
        const a = rest[k];
        if (a.startsWith('-')) {
            flags.push(a);
            if (['-t', '-m', '--track', '--master'].includes(a)) k++; // option takes a value
        } else plain.push(a);
    }
    const [name, url] = plain;
    const originHint =
        '`origin` is https://github.com/Danathar/akmods; it must not be removed, renamed or re-pointed.';

    // Anything that could remove, replace or re-point `origin` would defeat the
    // "push only to origin" rule (`git push origin` would then reach another repo).
    if (['remove', 'rm', 'rename'].includes(sub) && plain.includes('origin')) {
        return block(`Blocked: \`git remote ${sub}\` involving origin. ${originHint}`);
    }
    if (sub === 'add' && name === 'origin' && !isTarget(url ?? '')) {
        return block(`Blocked: \`git remote add origin\` with a URL that is not this repository. ${originHint}`);
    }
    if (sub !== 'set-url') return null;
    if (url === undefined) return null;
    const push = flags.includes('--push');
    if (push && url !== 'DISABLE' && !(name === 'origin' && isTarget(url))) {
        return block(
            `Blocked: \`git remote set-url --push ${name}\` to a real URL. ` +
                'Use `DISABLE`, or the Danathar/akmods URL for origin (the `upstream` remote, ublue-os/akmods, must never get a push URL).'
        );
    }
    if (name === 'origin' && !isTarget(url)) {
        return block(`Blocked: \`origin\` may only point at https://github.com/Danathar/akmods.`);
    }
    return null;
}

// ---------------------------------------------------------------------------
// node --test
// ---------------------------------------------------------------------------

// `node --test` is pre-approved in .claude/settings.json, but node options load
// and run any code (`--import`, `--require`/`-r`, `--loader`, a module
// `--test-reporter`, `--test-global-setup`, `--experimental-config-file`) or
// write files (`--test-reporter-destination=FILE`, `--cpu-prof-dir`,
// `--redirect-warnings`). In test mode only the test-runner options below are
// allowed; everything else, and any NODE_* variable such as NODE_OPTIONS, is
// refused. Value: null = any value, RegExp = the value must match.
const NODE_TEST_OPTIONS = {
    '--test': false,
    '--test-only': false,
    '--watch': false,
    '--test-force-exit': false,
    '--experimental-test-coverage': false,
    '--no-warnings': false,
    '--enable-source-maps': false,
    '--test-name-pattern': null,
    '--test-skip-pattern': null,
    '--test-coverage-include': null,
    '--test-coverage-exclude': null,
    '--test-concurrency': /^\d+$/,
    '--test-timeout': /^\d+$/,
    '--test-shard': /^\d+\/\d+$/,
    '--test-isolation': /^(process|none)$/,
    '--experimental-test-isolation': /^(process|none)$/,
    '--test-coverage-lines': /^\d+(\.\d+)?$/,
    '--test-coverage-branches': /^\d+(\.\d+)?$/,
    '--test-coverage-functions': /^\d+(\.\d+)?$/,
    '--test-reporter': /^(spec|tap|dot|junit|lcov)$/,
    '--test-reporter-destination': /^(stdout|stderr)$/,
};

function checkNode(cmd, args, env) {
    const envKey = Object.keys(env).find((k) => /^NODE_/.test(k) && !SAFE_ENV.has(k));
    if (envKey) {
        return block(`Blocked: \`${cmd}\` with ${envKey} set; NODE_OPTIONS and other NODE_* variables can load code or write files.`);
    }
    if (!args.includes('--test')) return null; // not the pre-approved test runner; Claude Code asks
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (!a.startsWith('-') || a === '-' || a === '--') continue; // test files / patterns
        const eq = a.indexOf('=');
        const name = eq === -1 ? a : a.slice(0, eq);
        const rule = Object.hasOwn(NODE_TEST_OPTIONS, name) ? NODE_TEST_OPTIONS[name] : undefined;
        let ok = rule !== undefined;
        if (ok && rule === false) ok = eq === -1;
        else if (ok) {
            const value = eq === -1 ? args[++i] : a.slice(eq + 1);
            ok = value !== undefined && (rule === null || rule.test(value));
        }
        if (!ok) {
            return block(
                `Blocked: \`${cmd} --test ... ${a}\`; only test-runner options (name/skip pattern, concurrency, timeout, shard, ` +
                    'isolation, coverage, --watch, --test-only, reporters spec|tap|dot|junit|lcov to stdout|stderr) are allowed. ' +
                    'Other node options can run code (--import, --require, --loader, module reporters) or write files.'
            );
        }
    }
    return null;
}

// ---------------------------------------------------------------------------
// Host-modifying commands (scripts, package managers, containers, signing)
// ---------------------------------------------------------------------------

const PRIVILEGE = new Set(['sudo', 'doas', 'pkexec', 'run0', 'su', 'runuser']);
const DNF = new Set(['dnf', 'dnf5', 'dnf-3', 'yum', 'microdnf']);
const CONTAINER_ENTER = new Set(['distrobox', 'distrobox-enter', 'distrobox-host-exec', 'toolbox']);
const CONTAINER_ENGINES = new Set(['podman', 'docker', 'nerdctl']);
// Words a wrapper (env, timeout, xargs, ...) can hide; we look through the wrapper to them.
const LOOKTHROUGH = new Set([
    'gh', 'git', 'node', 'nodejs', ...SHELLS, 'eval', 'source', 'rpm', 'rpm-ostree', 'bootc', 'pkcon', 'just', 'cosign',
    'skopeo', 'tee', 'cp', 'mv', 'install', 'ln', 'dd', 'openssl', 'truncate', 'actionlint', 'yq', 'bats', 'npx',
    ...PRIVILEGE, 'flatpak-spawn', ...DNF, ...CONTAINER_ENTER, ...CONTAINER_ENGINES,
    // They run a command from a string (watch, `flock FILE -c`) or after -exec (find).
    'watch', 'flock', 'find',
]);

/**
 * Scripts that install packages, download kernels or build/sign images when
 * run: fetch-kernel.sh, everything under build_files/, and the tests/e2e
 * harness (it starts containers; CI runs it). Reading, linting (shellcheck)
 * and syntax-checking (`bash -n`) them is fine; executing them is not.
 */
function isHostScript(word) {
    const w = String(word);
    if (basename(w) === 'fetch-kernel.sh') return true;
    return /(^|\/)(build_files|tests\/e2e)\/.+\.sh$/.test(w);
}

/** True if a tokenized segment names a host-modifying script as an argument or reads it with `<`. */
function segmentReadsHostScript(seg) {
    return seg.some(isHostScript) || (seg.stdinFrom !== undefined && isHostScript(seg.stdinFrom));
}

/** True if a command line (a substitution body) reads or names a host-modifying script. */
function readsHostScript(commandLine) {
    return tokenize(commandLine).some(segmentReadsHostScript);
}

function blockHostScript(what) {
    return block(
        `Blocked: ${what} would execute a script that installs packages, downloads kernels or builds containers on this ` +
            'machine (fetch-kernel.sh, build_files/**, tests/e2e/**). Verify with shellcheck, `bash -n`, ' +
            '`npx --yes bats@1.11.1 tests/unit`; container/e2e runs happen in GitHub Actions on the pull request.'
    );
}

/** C1: a path-relative pre-approved command run after the working directory may have changed. */
function refuseMovedCwd(what) {
    return block(
        `Blocked: \`${what}\` after a directory change (cd, pushd, popd, env -C). just finds its justfile from the ` +
            'current directory, and the pre-approved `just`, `node --test` and bats forms name files relative to it, ' +
            'so from another directory they would evaluate or run that directory\'s code. Run them from the checkout ' +
            'root, with no cd/pushd/popd in the same command line.'
    );
}

/** `distrobox enter`, `toolbox run|enter`: the real container, always refused; `distrobox-host-exec cmd`: cmd is analysed as running for real. */
function checkContainerEnter(cmd, args, state) {
    const sub = args.find((a) => !a.startsWith('-'));
    if (cmd === 'distrobox-enter' || (cmd === 'distrobox' && sub === 'enter') || (cmd === 'toolbox' && (sub === 'run' || sub === 'enter'))) {
        return block(`Blocked: \`${cmd}${sub ? ` ${sub}` : ''}\` enters the developer's real long-lived container (real rpm database, working sudo).`);
    }
    if (cmd !== 'distrobox-host-exec') return null; // other distrobox/toolbox subcommands (create, list, ephemeral, ...) run nothing of ours
    const at = args.findIndex((a) => !a.startsWith('-'));
    const inner = at === -1 ? [] : args.slice(at);
    if (!inner.length) {
        return block('Blocked: `distrobox-host-exec` with no command starts a shell on the host, which runs whatever reaches its stdin; name the command to run.');
    }
    return checkSegment(inner, state);
}

const DNF_READ = ['list', 'info', 'search', 'repoquery', 'provides', 'whatprovides', 'check-update', 'check-upgrade', 'repolist', 'repoinfo', 'help'];

function checkDnf(cmd, args) {
    const { sub, rest } = firstWord(args, [
        '-c', '--config', '--installroot', '--releasever', '-x', '--exclude', '--repo', '--enablerepo',
        '--disablerepo', '--forcearch', '--destdir', '--downloaddir',
    ]);
    if (sub === undefined || DNF_READ.includes(sub)) return null;
    if ((sub === 'history' || sub === 'repo') && ['list', 'info'].includes(rest[0])) return null;
    return block(`Blocked: \`${cmd} ${sub}\` changes packages on this machine; only read-only queries (${DNF_READ.join(', ')}) are allowed.`);
}

function checkRpm(args) {
    const longs = args.filter((a) => a.startsWith('--'));
    const shorts = args.filter((a) => /^-[a-zA-Z]+$/.test(a));
    const writesLong = ['--install', '--upgrade', '--freshen', '--erase', '--reinstall', '--import', '--rebuilddb'];
    const queryLong = longs.some((l) => ['--query', '--verify', '--checksig'].includes(l));
    // -U/-F/-e change packages wherever they appear, even next to -q; -i is
    // "info" only when a query/verify/checksig flag is also present
    // (`rpm -qi`, `rpm -q -i`).
    const queryMode = queryLong || shorts.some((s) => /[qVK]/.test(s));
    const writes = shorts.some((s) => /[UFe]/.test(s) || (/i/.test(s) && !queryMode));
    if (longs.some((l) => writesLong.includes(l)) || writes) {
        return block('Blocked: `rpm` install/upgrade/erase modes change packages on this machine; query (-q), verify (-V) and checksig (-K) are fine.');
    }
    return null;
}


function checkImageTool(cmd, args) {
    const { sub } = firstWord(args, []);
    const readOnly = {
        'rpm-ostree': ['status', 'db', 'help'],
        bootc: ['status', 'help'],
        pkcon: ['search', 'resolve', 'what-provides', 'get-details', 'get-files', 'get-packages', 'get-updates', 'get-update-detail', 'repo-list', 'help'],
    }[cmd];
    if (sub === undefined || readOnly.includes(sub)) return null;
    return block(`Blocked: \`${cmd} ${sub}\` changes the booted image or installed packages; only ${readOnly.join('/')} are allowed.`);
}

// ---------------------------------------------------------------------------
// just: read-only evaluation only
// ---------------------------------------------------------------------------

// Every Justfile recipe here builds, downloads a kernel, pushes, or rewrites
// workflows, so a recipe may only be *named* under --dry-run. Fail closed:
// the six recipes in the task brief are called out, but any other recipe is
// refused too.
const JUST_NAMED_RECIPES = ['build', 'test', 'fetch-kernel', 'push', 'manifest', 'clean'];
const JUST_READ_LONG = new Set([
    '--list', '--evaluate', '--dry-run', '--summary', '--show', '--variables', '--dump', '--help', '--version',
    '--groups', '--changelog', '--completions', '--usage',
]);
const JUST_READ_SHORT = new Set(['l', 'n', 's', 'h', 'V']);
// Options that run something else, edit files or change the shell used for backticks.
const JUST_REFUSED_LONG = new Set(['--edit', '--init', '--command', '--choose', '--chooser', '--shell', '--shell-arg', '--shell-command']);
const JUST_REFUSED_SHORT = new Set(['e', 'c']);
// Options that pick which justfile is evaluated or what goes into the
// environment of its backticks and shell() calls. `--evaluate`/`--dry-run`
// still run every backtick and shell() in the chosen justfile, and
// `--dotenv-command CMD` runs CMD outright, so each one turns a read-only
// evaluation into running a program. `--justfile`/`-f` stays allowed for this
// checkout's own Justfile (JUST_OWN_JUSTFILE).
const JUST_SOURCE_LONG = new Set([
    '--justfile', '--justfile-name', '--global-justfile', '--working-directory',
    '--dotenv-command', '--dotenv-path', '--dotenv-filename',
]);
const JUST_SOURCE_SHORT = new Set(['f', 'g', 'd', 'E', 'F']);
const JUST_OWN_JUSTFILE = new Set(['Justfile', './Justfile']);
const JUST_VALUE_LONG = new Set([
    '--color', '--command-color', '--dump-format', '--list-heading', '--list-prefix', '--tempdir',
    '--timestamp-format', '--ceiling', '--alias-style', '--cygpath',
]);
// The same choices made through just's environment variables
// (JUST_JUSTFILE, JUST_DOTENV_COMMAND, ...); every JUST_* setting is refused.
const JUST_ENV = /^JUST_/;

function refuseJustSource(option) {
    return block(
        `Blocked: \`just ${option}\` picks another justfile or environment file, or runs a command to load one. ` +
            '`--evaluate` and `--dry-run` still run every backtick and shell() call in the justfile they load, and ' +
            '`--dotenv-command` runs its command outright, so only this checkout\'s own Justfile may be evaluated ' +
            '(`just --evaluate`, or `--justfile Justfile`).'
    );
}

function checkJust(args, env = {}) {
    const envKey = Object.keys(env).find((k) => JUST_ENV.test(k));
    if (envKey) return refuseJustSource(`with ${envKey}=`);
    let read = false;
    let fmt = false;
    let check = false;
    const recipes = [];
    const overrides = [];
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '--') {
            for (const x of args.slice(i + 1)) (isAssignment(x) ? overrides : recipes).push(x);
            break;
        }
        if (a.startsWith('--')) {
            const name = a.split('=')[0];
            if (JUST_REFUSED_LONG.has(name)) {
                return block(`Blocked: \`just ${name}\` runs another command, edits files or changes the shell; only read-only evaluation is allowed.`);
            }
            if (JUST_SOURCE_LONG.has(name)) {
                const value = a.includes('=') ? a.slice(a.indexOf('=') + 1) : args[i + 1];
                if (name !== '--justfile' || !JUST_OWN_JUSTFILE.has(value)) return refuseJustSource(name);
                if (!a.includes('=')) i++;
                continue;
            }
            if (name === '--fmt') fmt = true;
            else if (name === '--check') check = true;
            else if (JUST_READ_LONG.has(name)) read = true;
            else if (name === '--set') {
                overrides.push(a);
                i += a.includes('=') ? 1 : 2;
            }
            else if (JUST_VALUE_LONG.has(name) && !a.includes('=')) i++;
            continue;
        }
        if (/^-[a-zA-Z]/.test(a)) {
            for (let k = 1; k < a.length; k++) {
                const ch = a[k];
                if (JUST_REFUSED_SHORT.has(ch)) {
                    return block(`Blocked: \`just -${ch}\` edits the Justfile or runs another command; only read-only evaluation is allowed.`);
                }
                if (JUST_READ_SHORT.has(ch)) read = true;
                if (JUST_SOURCE_SHORT.has(ch)) {
                    // A value may be attached (`-fPATH`, `-f=PATH`) or be the next word.
                    const attached = a.slice(k + 1).replace(/^=/, '');
                    const value = k === a.length - 1 ? args[i + 1] : attached;
                    if (ch !== 'f' || !JUST_OWN_JUSTFILE.has(value)) return refuseJustSource(`-${ch}`);
                    if (k === a.length - 1) i++;
                    break;
                }
            }
            continue;
        }
        (isAssignment(a) ? overrides : recipes).push(a);
    }
    // `just DIR/recipe` (any argument with a slash) searches DIR for a justfile
    // and evaluates that one instead of this checkout's.
    const searched = recipes.find((r) => r.includes('/'));
    if (searched) return refuseJustSource(searched);
    if (fmt && !check && !read) {
        return block('Blocked: `just --fmt` rewrites the Justfile; use `just --fmt --check` or `just --dump`.');
    }
    if (read || fmt || recipes.length === 0) {
        if (overrides.length === 0) return null; // bare `just` runs `just --list`
        return block(
            `Blocked: \`just\` variable override (${overrides[0]}) is refused. The Justfile builds shell() commands from its ` +
                'variables while evaluating, so an override can run any program even under --evaluate/--dry-run. ' +
                'Select an image with the AKMODS_KERNEL / AKMODS_VERSION / AKMODS_TARGET environment variables instead, ' +
                'e.g. `AKMODS_KERNEL=main just --evaluate version`.'
        );
    }
    const named = recipes.filter((r) => JUST_NAMED_RECIPES.includes(r));
    return block(
        `Blocked: \`just ${recipes.join(' ')}\` would run ${named.length ? `the host-heavy recipe(s) ${named.join(', ')}` : 'a recipe'} ` +
            'on this workstation (builds, kernel downloads, pushes, workflow regeneration). Read-only forms are fine: ' +
            '`just --list`, `just --evaluate [VAR]`, `just --dry-run <recipe>`, `just --show <recipe>`.'
    );
}

// ---------------------------------------------------------------------------
// Container engines, cosign, skopeo
// ---------------------------------------------------------------------------

const ENGINE_VALUE_FLAGS = [
    '--root', '--runroot', '--storage-driver', '--storage-opt', '--log-level', '--url', '--connection', '-c', '-H', '--host',
    '--config', '--context', '--cgroup-manager', '--events-backend', '--network-cmd-path', '--tmpdir', '--imagestore',
    '--hooks-dir', '--conmon', '--runtime', '--module', '--identity',
];
const ENGINE_READ_TOP = ['ps', 'images', 'inspect', 'version', 'info', 'search', 'logs', 'top', 'stats', 'port', 'diff', 'history', 'help'];
const ENGINE_READ_GROUPS = ['image', 'container', 'volume', 'network', 'pod', 'system', 'manifest', 'machine', 'secret'];
const ENGINE_READ_SUB = ['ls', 'list', 'ps', 'inspect', 'exists', 'df', 'info', 'version', 'history', 'diff', 'logs'];

/** podman/docker/nerdctl: read-only queries only; no local containers or builds on this workstation. */
function checkContainerEngine(cmd, args) {
    const { sub, rest } = firstWord(args, ENGINE_VALUE_FLAGS);
    if (sub === undefined) return null; // `podman --version`, `podman`
    if (ENGINE_READ_TOP.includes(sub)) return null;
    if (ENGINE_READ_GROUPS.includes(sub)) {
        const second = rest.find((a) => !a.startsWith('-'));
        if (second === undefined || ENGINE_READ_SUB.includes(second)) return null;
        return block(`Blocked: \`${cmd} ${sub} ${second}\` changes local container state; only ${ENGINE_READ_SUB.join('/')} are allowed under \`${sub}\`.`);
    }
    return block(
        `Blocked: \`${cmd} ${sub}\` would build, run, push, pull or log in with containers on this workstation ` +
            '(podman build|push|login|system prune and friends). Container verification runs in GitHub Actions on the pull request.'
    );
}

const COSIGN_READ = [
    'verify', 'verify-blob', 'verify-attestation', 'verify-blob-attestation', 'tree', 'triangulate', 'public-key',
    'version', 'download', 'help', 'completion',
];

/** cosign: verification only; signing and key generation are the release pipeline's job. */
function checkCosign(args) {
    const { sub } = firstWord(args, ['--output-file', '--timeout', '-d']);
    if (sub === undefined || COSIGN_READ.includes(sub)) return null;
    return block(`Blocked: \`cosign ${sub}\` signs, uploads or manages keys; only ${COSIGN_READ.join('/')} are allowed. Signing runs in CI with the repository secrets.`);
}

/** skopeo: inspect/list-tags only (copy, sync, delete and login write to registries). */
function checkSkopeo(args) {
    const { sub } = firstWord(args, ['--policy', '--registries.d', '--override-arch', '--override-os', '--override-variant', '--command-timeout', '--tmpdir']);
    if (sub === undefined || ['inspect', 'list-tags', 'help'].includes(sub)) return null;
    return block(`Blocked: \`skopeo ${sub}\` writes to or authenticates against a registry; only inspect and list-tags are allowed.`);
}

// ---------------------------------------------------------------------------
// Pre-approved linters and test runners (L1)
// ---------------------------------------------------------------------------
// settings.json allows `actionlint`, `yq` and `npx --yes bats@1.11.1 tests/unit`
// with any trailing arguments. Each has options that turn it into a launcher or
// a file writer: actionlint runs whatever -shellcheck/-pyflakes name (and pipes
// `run:` scripts to it), yq -i rewrites images.yaml, workflows or
// .claude/settings.json past their `ask` rules, and bats runs a formatter given
// by path.

/** Value of a Go-style flag (`-name v`, `-name=v`, `--name=v`) at args[i], or undefined if args[i] is not that flag. */
function goFlagValue(args, i, name) {
    const m = /^--?([^=]+)(?:=(.*))?$/s.exec(args[i]);
    if (!m || m[1] !== name) return undefined;
    return m[2] !== undefined ? m[2] : (args[i + 1] ?? '');
}

/** actionlint: -shellcheck/-pyflakes name the executable it runs. An empty value disables the integration. */
function checkActionlint(args) {
    for (let i = 0; i < args.length; i++) {
        for (const name of ['shellcheck', 'pyflakes']) {
            const value = goFlagValue(args, i, name);
            if (value === undefined || value === '') continue;
            return block(
                `Blocked: \`actionlint -${name} ${value}\` makes actionlint run "${value}" and feed it the workflows' ` +
                    '`run:` scripts. Run plain `actionlint` (it finds shellcheck on PATH), or pass ' +
                    `\`-${name}=\` to switch the integration off.`
            );
        }
    }
    return null;
}

// yq short options that take a value: the rest of a cluster (`-oyaml`) is that value.
const YQ_VALUE_SHORT = new Set(['p', 'o', 'I', 'f']);
const YQ_REFUSED_LONG = new Set(['--inplace', '--split-exp', '--split-exp-file', '--security-enable-system-operator']);

/** yq: reads only; in-place edits, split-file output and the system operator are refused. */
function checkYq(args) {
    const refuse = (what) =>
        block(
            `Blocked: \`yq ${what}\` writes files or runs commands. Pre-approved yq is for reading; make edits with ` +
                'the Edit tool so the ask rules for images.yaml, workflows and .claude/ still apply.'
        );
    for (const a of args) {
        if (a.startsWith('--')) {
            const name = a.split('=')[0];
            if (YQ_REFUSED_LONG.has(name)) return refuse(name);
            continue;
        }
        if (!/^-[a-zA-Z0-9]/.test(a)) continue;
        for (let k = 1; k < a.length; k++) {
            const ch = a[k];
            if (ch === 'i' || ch === 's') return refuse(`-${ch}`);
            if (YQ_VALUE_SHORT.has(ch)) break;
        }
    }
    return null;
}

const BATS_FORMATTERS = new Set(['pretty', 'tap', 'tap13', 'junit']);

// bats 1.11.1 options that take the next word as their value. bats parses no
// `--name=value` form, and a short value flag is only accepted last in a pack.
const BATS_VALUE_LONG = new Set([
    '--filter', '--formatter', '--report-formatter', '--output', '--jobs', '--parallel-binary-name', '--tempdir',
    '--gather-test-outputs-in', '--setup-suite-file', '--code-quote-style', '--filter-status', '--filter-tags',
    '--line-reference-format',
]);
const BATS_VALUE_SHORT = /^-[a-zA-Z]*[fFoj]$/;

/**
 * bats sources every file operand and the --setup-suite-file value as shell
 * code, so their top level runs: `bats fetch-kernel.sh` runs fetch-kernel.sh.
 * A word the shell could expand into a host script (`fetch-kerne?.sh`,
 * `build_files/{zfs,x}/*.sh`, `$F`) is refused too, since the expansion
 * happens after this check reads the word.
 */
function checkBatsSourced(word) {
    if (isHostScript(word)) return blockHostScript(`\`bats ${word}\` (bats runs the top level of every file it is given)`);
    if (/[*?[{}$`]/.test(word)) {
        return block(
            `Blocked: \`bats ${word}\`; bats runs the top level of every file it is given, and the shell expands ` +
                'this word before the guard can tell whether it names a host-modifying script. Name the test ' +
                'directory or the .bats files literally (`npx --yes bats@1.11.1 tests/unit`).'
        );
    }
    return null;
}

/** A formatter outside the built-in set is a path to a program bats runs. */
function checkBatsFormatter(value) {
    if (BATS_FORMATTERS.has(value)) return null;
    return block(
        `Blocked: \`bats\` formatter "${value}" is a program bats runs. Use a built-in formatter ` +
            `(${[...BATS_FORMATTERS].join(', ')}).`
    );
}

/** bats: a formatter given by path, a parallel binary, or a sourced host script is a program bats runs. */
function checkBats(args) {
    // Read the words in order, as bats does: a value option consumes the next
    // word whatever it looks like, so `-f --filter x` makes x an operand.
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        let r = null;
        if (BATS_VALUE_LONG.has(a) || BATS_VALUE_SHORT.test(a)) {
            const value = args[++i] ?? '';
            if (a === '--parallel-binary-name') r = block('Blocked: `bats --parallel-binary-name` names a program bats runs.');
            else if (a === '--setup-suite-file') r = checkBatsSourced(value);
            else if (a === '--formatter' || a === '--report-formatter' || a.endsWith('F')) r = checkBatsFormatter(value);
        } else if (!a.startsWith('-')) {
            r = checkBatsSourced(a);
        } else if (a.startsWith('--parallel-binary-name=')) {
            r = block('Blocked: `bats --parallel-binary-name` names a program bats runs.');
        } else {
            // Spellings bats itself rejects today, refused anyway in case a later release accepts them.
            const m = /^(?:--formatter=|--report-formatter=|-F)(.+)$/s.exec(a);
            if (m) r = checkBatsFormatter(m[1]);
        }
        if (r) return r;
    }
    return null;
}

/** npx: check the bats command line when npx runs bats (and C1 when the directory may have changed). */
function checkNpx(args, moved = false) {
    const at = args.findIndex((a) => /^bats(@[^/\s]*)?$/.test(a));
    if (at === -1) return null;
    return checkBats(args.slice(at + 1)) ?? (moved ? refuseMovedCwd(`npx ${args[at]}`) : null);
}

// ---------------------------------------------------------------------------
// Writes of signing material
// ---------------------------------------------------------------------------

/**
 * certs/ holds the repository's signing keys (committed empty or as public
 * `.test` keys; the real ones are repository secrets written by CI). Writing
 * anything but a `.test` file there, or any private-key-looking file anywhere,
 * would put real signing material on disk, or recreate the 1-byte-key failure
 * documented in FORK-PATCHES.md.
 */
function checkWriteTarget(path) {
    const p = String(path);
    if (p === '' || p.startsWith('/dev/')) return null;
    const name = basename(p);
    const inCerts = /(^|\/)certs(\/[^/]+)?\/?$/.test(p) && !name.endsWith('.test');
    const keyLike = /\.(priv|key|pem|p12|pfx)$/i.test(name);
    if (!inCerts && !keyLike) return null;
    return block(
        `Blocked: writing "${p}" would put real signing material on this machine (certs/ files other than *.test, or any ` +
            '.priv/.key/.pem file). Signing keys come from repository secrets in CI; an empty or partial key written to ' +
            'certs/private_key.priv defeats the build\'s test-key fallback.'
    );
}

/** Commands whose operands are write destinations (tee, cp, mv, install, ln, truncate, dd of=, openssl -out). */
function checkWriteCommand(cmd, args) {
    const plain = args.filter((a) => !a.startsWith('-'));
    let targets = [];
    if (cmd === 'tee' || cmd === 'truncate') targets = plain;
    else if (['cp', 'mv', 'install', 'ln'].includes(cmd)) {
        targets = plain.slice(-1);
        args.forEach((a, n) => {
            if (a === '-t' || a === '--target-directory') targets.push(args[n + 1] ?? '');
            else if (a.startsWith('--target-directory=')) targets.push(a.slice(19));
        });
    } else if (cmd === 'dd') targets = args.filter((a) => a.startsWith('of=')).map((a) => a.slice(3));
    else if (cmd === 'openssl') {
        args.forEach((a, n) => {
            if (a === '-out' || a === '-keyout') targets.push(args[n + 1] ?? '');
        });
    }
    for (const t of targets) {
        const r = checkWriteTarget(t);
        if (r) return r;
    }
    return null;
}

// ---------------------------------------------------------------------------
// Segment / command analysis
// ---------------------------------------------------------------------------

/**
 * `find ... -exec|-execdir|-ok|-okdir CMD ARGS ;` (or `{} +`) runs CMD for each
 * file: analyse each such command like a segment of its own. -execdir and
 * -okdir run it from the directory of each file (C1). `{}` is replaced by
 * each file found, which may be fetch-kernel.sh or a build_files/ script, so
 * the command is checked a second time as if {} named one (H2).
 */
function checkFindExec(args, state, moved) {
    for (let i = 0; i < args.length; i++) {
        if (!FIND_EXEC.includes(args[i])) continue;
        let end = i + 1;
        while (end < args.length && args[end] !== ';' && !(args[end] === '+' && args[end - 1] === '{}')) end++;
        const inner = args.slice(i + 1, end);
        const st = () => Object.assign(Object.create(state), moved || args[i].endsWith('dir') ? { cwdMoved: true } : {});
        const r = checkSegment(inner, st());
        if (r) return r;
        if (inner.some((x) => x.includes('{}')) && checkSegment(inner.map((x) => x.replaceAll('{}', 'fetch-kernel.sh')), st())) {
            return blockHostScript(`\`find ${args[i]} ${inner.join(' ')}\` (run on each file find reaches)`);
        }
        i = end;
    }
    return null;
}

// Every name checkSegment() checks or looks through.
const CHECKED_NAMES = new Set([...LOOKTHROUGH, 'systemd-run']);
// How the shell may build one of those names out of a word (brace groups,
// wildcards); see commandNameReader() in shell-reader.mjs.
const { builtCommandName, namesCheckedCommand } = commandNameReader(CHECKED_NAMES);

/**
 * For a segment whose command is a program this hook neither checks nor steps
 * over (`setarch x86_64 sudo dnf ...`, `prlimit ...`, `script -qc '...'`), the
 * refusal for the checked command it would run, or null. Each later word that
 * names a checked command is checked from there to the end, with the
 * assignments in front of the program, and each command string a later word
 * carries is checked as a command line of its own. A command that passes alone
 * still passes behind any program. Only over-refusing is guessed at: an option
 * value that reads as a checked command (`man sudo`) is refused too. A
 * host-modifying script named behind such a program is not read: the hook
 * cannot tell `less fetch-kernel.sh` from a program that runs it.
 */
function checkUnlistedProgram(w, inlineEnv, state) {
    const cmd = w[0];
    if (ARGUMENT_ONLY_PROGRAMS.has(cmd)) return null;
    const env = Object.entries(inlineEnv).map(([name, value]) => `${name}=${value}`);
    let checked = 0;
    for (let n = 1; n < w.length; n++) {
        spend();
        let refusal = null;
        if (namesCheckedCommand(w[n])) {
            if (++checked > MAX_UNLISTED_INNER) {
                return block(
                    `Blocked: more than ${MAX_UNLISTED_INNER} commands this hook checks behind \`${basename(cmd)}\`, ` +
                        'too many to read. Run them as commands of their own.'
                );
            }
            let start = n;
            while (start > 1 && isAssignment(w[start - 1])) start--;
            // A glob in a path is read as each checked program it may match:
            // `ls /usr/bin/g*` passes as `gh` and `git` alone do.
            for (const name of builtCommandName(w[n])?.globs ?? [w[n]]) {
                refusal = checkSegment([...env, ...w.slice(start, n), name, ...w.slice(n + 1)], state());
                if (refusal) break;
            }
        }
        if (!refusal) {
            for (const text of commandStrings(w[n])) {
                spend();
                const names = (t) => t.split(COMMAND_STRING_SEPARATORS).some((piece) => piece && namesCheckedCommand(piece));
                // Tokenized too, so `$'\x67it'` is read as the `git` it decodes to,
                // and the first word of each command in it as one the shell runs (`* push`).
                const segments = tokenize(text);
                if (
                    !names(text) &&
                    !names(unquoted(text)) &&
                    !segments.flat().some(namesCheckedCommand) &&
                    !segments.some((seg) => seg.length && builtCommandName(seg[0], true) !== null)
                )
                    continue;
                refusal = checkCommand(text, state());
                if (refusal) break;
            }
        }
        if (refusal) {
            return {
                ...refusal,
                reason:
                    `\`${basename(cmd)}\` runs a command that is refused on its own, and bypass and auto modes ` +
                    `prompt for neither, so it is checked as though it stood alone. ${refusal.reason}`,
            };
        }
    }
    return null;
}

function checkSegment(words, state) {
    spend();
    for (const out of words.outs ?? []) {
        const r = checkWriteTarget(out);
        if (r) return r;
    }
    const { pipedFrom, stdinFrom, hereString, heredocBody } = words;
    let w = words.slice();
    const inlineEnv = {};
    // Set once the segment runs through xargs: xargs appends words it reads at
    // run time, so no argument check below sees the real command line.
    let xargsFed = false;
    // C1: the working directory may differ from the checkout root.
    let moved = Boolean(state.cwdMoved);
    for (;;) {
        while (w.length && (isAssignment(w[0]) || KEYWORDS.has(w[0]) || w[0] === 'function' || w[0] === 'coproc')) {
            if (isAssignment(w[0])) {
                const eq = w[0].indexOf('=');
                inlineEnv[w[0].slice(0, eq)] = w[0].slice(eq + 1);
            }
            // `function NAME { CMD; }`: the body follows the name. `coproc NAME { CMD; }`
            // names a compound command; `coproc CMD` runs CMD.
            if (w[0] === 'function' || (w[0] === 'coproc' && w[2] === '{')) w.shift();
            w.shift();
        }
        if (!w.length) return null;
        // A name the shell builds (#171): braces are refused, since the words
        // they add are not modelled here; a wildcard is read as the one
        // checked program it can match, so `/usr/bin/g?t diff` and `g?t diff`
        // are `git diff`.
        const built = builtCommandName(w[0], true);
        if (built?.braces || built?.globs.length > 1) {
            return block(
                `Blocked: \`${w[0]}\` is a command name the shell expands (brace groups, or a wildcard in a path) ` +
                    'before it runs it, and it can expand to a command this hook checks only when the name is ' +
                    'spelled out. Spell the command name out.'
            );
        }
        if (built) w = [built.globs[0], ...w.slice(1)];
        const cmd = basename(w[0]);
        if (PRIVILEGE.has(cmd)) {
            return block(`Blocked: \`${cmd}\` (privilege escalation) is never run by agents in this repository.`);
        }
        if (!WRAPPERS.has(cmd)) break;
        w = expandWrapperOptions(cmd, w);
        // `env -S 'gh pr create'` / `--split-string=...` runs a command string.
        // Only env's own leading options and NAME=value words are scanned; the
        // wrapped command's arguments (e.g. `--title -Sx`) are not env options.
        if (cmd === 'env') {
            for (let k = 1; k < w.length; k++) {
                const a = w[k];
                if (isAssignment(a)) continue;
                if (!a.startsWith('-')) break; // first word of the wrapped command
                if (a === '-C' || a === '--chdir' || /^-C./.test(a) || a.startsWith('--chdir=')) moved = true;
                if (['-u', '--unset', '-C', '--chdir', '-a', '--argv0'].includes(a)) {
                    k++;
                    continue;
                }
                let script = null;
                let rest = k + 1;
                if (a === '-S' || a === '--split-string') {
                    script = w[k + 1] ?? '';
                    rest = k + 2;
                } else if (a.startsWith('--split-string=')) script = a.slice(15);
                else if (/^-S./.test(a)) script = a.slice(2);
                if (script === null) continue;
                // Check the string on its own, then as the head of the command
                // that still has the remaining words appended.
                const st = moved ? Object.assign(Object.create(state), { cwdMoved: true }) : state;
                const alone = checkCommand(script, st);
                if (alone) return alone;
                const head = tokenize(script).flat();
                return checkSegment([...head, ...w.slice(rest)], st);
            }
        }
        // Look through the wrapper to the command it runs: skip its own options
        // (and their values), NAME=value words, and operands such as timeout's duration.
        const idx = wrapperTarget(w);
        for (const x of w.slice(1, idx === -1 ? w.length : idx)) {
            if (isAssignment(x)) {
                const eq = x.indexOf('=');
                inlineEnv[x.slice(0, eq)] = x.slice(eq + 1);
            }
        }
        if (idx === -1) return null;
        // C1: chroot changes to its new root, nsenter can enter another mount
        // namespace or working directory, unshare -w/--wd/-R/--root moves too.
        if (cmd === 'chroot' || cmd === 'nsenter') moved = true;
        if (cmd === 'unshare' && w.slice(1, idx).some((a) => /^(?:-[wR]|--wd|--root)(?:=|$)|^-[wR]./.test(a))) moved = true;
        // `watch CMD...` joins its words and runs them with `sh -c` (with -x it runs
        // them directly; the words are also looked through below, so both readings
        // are checked). `flock FILE -c CMD` runs CMD with `sh -c`.
        const inner = () => Object.assign(Object.create(state), moved ? { cwdMoved: true } : {});
        if (cmd === 'watch') {
            const r = checkCommand(w.slice(idx).join(' '), inner());
            if (r) return r;
        } else if (cmd === 'flock' && (w[idx] === '-c' || w[idx] === '--command')) {
            return checkCommand(w[idx + 1] ?? '', inner());
        }
        if (cmd === 'xargs') xargsFed = true;
        w = w.slice(idx);
    }

    const cmd = basename(w[0]);
    const args = w.slice(1);
    // C1 (checkCommand has usually set this already for the whole command line).
    if (CHDIR.has(cmd)) {
        state.cwdMoved = true;
        return null;
    }
    // `printf '%s\n' --output=FILE | xargs git log` and
    // `printf '%s\n' +n -c CMD | xargs bash -n` reach git and bash with
    // options this hook never sees, under the git log and bash -n allow rules.
    if (xargsFed && (cmd === 'git' || cmd === 'node' || cmd === 'nodejs' || SHELLS.has(cmd))) {
        return block(
            `Blocked: \`xargs ${cmd}\`; xargs adds arguments read at run time, so this hook cannot check the ` +
                `${cmd} command line the allow rules pre-approve. Write the ${cmd} command out in full instead.`
        );
    }
    // Nested analysis (`bash -c '...'`, `eval`) sees the same exported state, but
    // anything it exports stays inside it, as in a real subshell.
    // A directory change (env -C) carries into it.
    const nested = (extra = {}) => Object.assign(Object.create(state), moved ? { cwdMoved: true } : {}, extra);

    if (cmd === 'export' || ((cmd === 'declare' || cmd === 'typeset') && args.some((a) => /^-[a-zA-Z]*x/.test(a)))) {
        for (const a of args) {
            if (a.startsWith('GH_REPO=')) state.exportedGhRepo = a.slice(8);
            // (PATH is not tracked: this repository has no stub exemption.)
            // `export NAME` without a value exports an earlier assignment: value unknown (null).
            const eq = a.indexOf('=');
            const name = eq === -1 ? a : a.slice(0, eq);
            if (/^(GIT_CONFIG_|GIT_SSH)/i.test(name) || WATCHED_ENV.test(name) || JUST_ENV.test(name)) {
                (state.exportedEnv ??= {})[name] = eq === -1 ? null : a.slice(eq + 1);
            }
        }
        return null;
    }
    if (cmd === 'gh') {
        const envRepo = inlineEnv.GH_REPO ?? state.exportedGhRepo ?? null;
        return checkGh(args, envRepo);
    }
    if (cmd === 'git') return checkGit(args, inlineEnv, state.exportedEnv ?? {});
    if (cmd === 'node' || cmd === 'nodejs') {
        const r = checkNode(cmd, args, { ...(state.exportedEnv ?? {}), ...inlineEnv });
        return r ?? (moved && args.includes('--test') ? refuseMovedCwd(`${cmd} --test`) : null);
    }
    if (isHostScript(w[0])) return blockHostScript(`Running ${w[0]}`);
    if (cmd === 'source' || cmd === '.') {
        return args.some(isHostScript) ? blockHostScript(`Sourcing ${args.find(isHostScript)}`) : null;
    }
    const writeBlock = checkWriteCommand(cmd, args);
    if (writeBlock) return writeBlock;
    if (cmd === 'find') return checkFindExec(args, state, moved);
    if (SHELLS.has(cmd)) {
        // `bash -n` is pre-approved in .claude/settings.json because -n parses a
        // script without running it, but a later `+n` or `+o noexec` turns -n off
        // again: `bash -n +n -c 'cmd'` runs cmd with no prompt. Refuse any word
        // beginning with + in a -n invocation, and any word bash could rewrite
        // into one first (`{+,+}n`, `?n` beside a file named +n, `$X`).
        if (args.some((a) => /^-[a-zA-Z]*n[a-zA-Z]*$/.test(a))) {
            const bad = args.find((a) => a.startsWith('+') || /[{}*?[$`]/.test(a));
            if (bad !== undefined) {
                return block(
                    `Blocked: \`${cmd} -n ... ${bad}\`; -n only parses a script, and +n or +o noexec turns that off ` +
                        'so the command would run under the syntax-check allow rule. Check syntax with `bash -n FILE` only; ' +
                        'run a script as itself so the permission rules see it.'
                );
            }
        }
        let scripts;
        if (cmd === 'fish') {
            // fish takes code from -c/--command and -C/--init-command (each may repeat,
            // with the value attached or in the next word); every one of them runs.
            scripts = fishScripts(args);
        } else {
            const c = args.findIndex((a) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a));
            // The script is the first non-option word after -c (`sh -c -- 'cmd'`, `sh -c -x 'cmd'`).
            const script = c === -1 ? undefined : args.slice(c + 1).find((a) => !a.startsWith('-'));
            scripts = script === undefined ? [] : [script];
        }
        if (scripts.length) {
            for (const script of scripts) {
                // `bash -c "$(cat fetch-kernel.sh)"`: the whole script text is the host-modifying script.
                if (/^\$\([\s\S]*\)$|^`[\s\S]*`$/.test(script.trim()) && extractSubstitutions(script).some(readsHostScript)) {
                    return blockHostScript(`\`${cmd} -c\` reading a host-modifying script`);
                }
                const r = checkCommand(script, nested());
                if (r) return r;
            }
            return null;
        }
        // `bash -n file` only parses the file; any other shell invocation runs it.
        const syntaxOnly = args.some((a) => /^-[a-zA-Z]*n[a-zA-Z]*$/.test(a));
        const target = args.find(isHostScript);
        if (!syntaxOnly && target !== undefined) return blockHostScript(`\`${cmd} ${target}\``);
        // No script operand: the shell reads its program from stdin
        // (`cat fetch-kernel.sh | bash`, `bash -s < fetch-kernel.sh`).
        if (!syntaxOnly && !args.some((a) => !a.startsWith('-'))) {
            // `bash <<< "$(cat fetch-kernel.sh)"`: the here-string expands to the host-modifying script.
            const hereReads = hereString !== undefined && extractSubstitutions(hereString).some(readsHostScript);
            let pipeReads = false;
            const feeders = [];
            for (let p = pipedFrom; p; p = p.pipedFrom) {
                feeders.push(p);
                if (segmentReadsHostScript(p)) pipeReads = true;
            }
            const reads = hereReads || (stdinFrom !== undefined && isHostScript(stdinFrom)) || pipeReads;
            if (reads) return blockHostScript(`\`${cmd}\` reading a host-modifying script on stdin`);
            // A heredoc or here-string fed to a shell is a script it runs.
            // The same holds for text piped in (`cat <<'EOF' | bash`).
            // A literal `echo`/`printf` payload piped in is a script too.
            const literal = (f) => {
                const name = basename(f[0] ?? '');
                if (name !== 'echo' && name !== 'printf') return undefined;
                const rest = f.slice(1).filter((a) => !a.startsWith('-'));
                if (name === 'printf') rest.shift(); // the format string
                return rest.join(' ');
            };
            for (const text of [heredocBody, hereString, ...feeders.flatMap((f) => [f.heredocBody, f.hereString, literal(f)])]) {
                if (text === undefined) continue;
                const r = checkCommand(text, nested());
                if (r) return r;
            }
        }
        return null;
    }
    if (cmd === 'eval') return checkCommand(args.join(' '), nested());
    if (DNF.has(cmd)) return checkDnf(cmd, args);
    if (cmd === 'rpm') return checkRpm(args);
    if (cmd === 'rpm-ostree' || cmd === 'bootc' || cmd === 'pkcon') return checkImageTool(cmd, args);
    if (cmd === 'just') return checkJust(args, { ...(state.exportedEnv ?? {}), ...inlineEnv }) ?? (moved ? refuseMovedCwd('just') : null);
    if (cmd === 'systemd-run' || cmd === 'flatpak-spawn') {
        // They run a command outside this shell's cwd: look through to it.
        const at = args.findIndex((a) => isHostScript(a) || LOOKTHROUGH.has(basename(a)));
        if (at !== -1) {
            const r = checkSegment(args.slice(at), moved ? nested() : state);
            if (r) return r;
        }
        const target = args.find(isHostScript);
        return target === undefined ? null : blockHostScript(`\`${cmd} ${target}\``);
    }
    if (CONTAINER_ENTER.has(cmd)) return checkContainerEnter(cmd, args, state);
    if (CONTAINER_ENGINES.has(cmd)) return checkContainerEngine(cmd, args);
    if (cmd === 'cosign') return checkCosign(args);
    if (cmd === 'skopeo') return checkSkopeo(args);
    if (cmd === 'actionlint') return checkActionlint(args);
    if (cmd === 'yq') return checkYq(args);
    if (cmd === 'bats') return checkBats(args) ?? (moved ? refuseMovedCwd('bats') : null);
    if (cmd === 'npx') return checkNpx(args, moved);
    return checkUnlistedProgram(w, inlineEnv, nested);
}

/** Analyse a command line. Returns null if allowed, else { blocked, reason }. */
export function checkCommand(command, state = {}) {
    // C1: a directory change anywhere in the command line counts for all of it.
    // Substitutions are checked before the segments around them (so
    // `cd sub && echo "$(just --evaluate)"` must already know about the cd), and
    // `( cd DIR && ... )` ends at the `)` but is not tracked as a scope: fail
    // closed rather than follow subshell nesting and execution order.
    const segments = tokenize(command);
    if (segments.some(changesDirectory)) state.cwdMoved = true;
    for (const sub of extractSubstitutions(command)) {
        const r = checkCommand(sub, state);
        if (r) return r;
    }
    for (const words of segments) {
        const r = checkSegment(words, state);
        if (r) return r;
    }
    return null;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function main(check = checkCommand, budgetMs = BUDGET_MS) {
    // Claude Code blocks only on exit 2; any other failure (an uncaught
    // exception exits 1) lets the command run. So nothing may escape this function.
    try {
        let payload;
        try {
            payload = JSON.parse(readFileSync(0, 'utf8'));
        } catch {
            process.stderr.write('guard-bash: could not parse hook input as JSON; blocking (fail closed).\n');
            process.exit(2);
        }
        if (payload?.tool_name && payload.tool_name !== 'Bash') process.exit(0);
        const command = payload?.tool_input?.command;
        if (typeof command !== 'string' || !command.trim()) process.exit(0);

        startBudget(budgetMs);
        const result = check(command);
        if (result) {
            process.stderr.write(`guard-bash: ${result.reason}\n`);
            process.exit(2);
        }
    } catch (err) {
        if (err instanceof OverBudget) {
            process.stderr.write(`guard-bash: ${err.message}\n${GUIDANCE}\n`);
            process.exit(2);
        }
        process.stderr.write(`guard-bash: internal error (${err?.message ?? err}); blocking (fail closed).\n`);
        process.exit(2);
    }
    process.exit(0);
}

/** True when this file is the program being run (also through a symlink); never fails open. */
function isMain() {
    const arg = process.argv[1];
    if (!arg) return false;
    const self = fileURLToPath(import.meta.url);
    if (resolve(arg) === self) return true;
    try {
        return realpathSync(arg) === self;
    } catch {
        // Cannot tell: assume we are the hook if the file is named like it.
        return basename(arg) === 'guard-bash.mjs';
    }
}

if (isMain()) main();

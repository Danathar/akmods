// Shell reading for the PreToolUse Bash guard (.claude/hooks/guard-bash.mjs).
//
// This file is the part of the guard that reads a command line the way the
// shell would: it splits words and segments, resolves quotes and backslashes,
// decodes `$'...'`, finds substitutions and heredoc bodies, expands the brace
// groups and wildcards a command name may be built from, steps over wrapper
// programs (env, timeout, xargs, flock, watch, chrt, ...) to the command they
// run, finds the command strings a shell, fish, `find -exec` or another
// program is handed, and holds the git option, config and environment rules
// and the time budget. It names no repository and holds no repository policy:
// what is refused, and why, is decided in guard-bash.mjs, which imports this.
//
// Several repositories carry this guard, and each keeps its own policy in its
// own guard-bash.mjs. This file is the same in all of them: the canonical copy
// lives in Danathar/akmods, a reading fix lands there first, and the other
// copies are replaced with it byte for byte. In every repository a test next
// to the shared refusal-corpus test pins its sha256, so a copy that drifts, or
// a fix made in one copy only, fails CI.
//
// Like the guard, this is an approximation of shell parsing that fails closed
// when unsure: reading more words than the shell would can only refuse more.

import { basename } from 'node:path';

// Shell redirection operators (`>`, `>>`, `>&`, `>|`, `&>`, `&>>`, `<`, `<&`, `<>`, `<<<`; `<<` heredocs are handled separately).
export const REDIRECT = /^(?:&>>?|<<<|<&|<>|>>|>&|>\||<|>)/;

// Words that may precede the real command and carry no meaning for us.
export const KEYWORDS = new Set(['{', '}', '!', 'if', 'then', 'else', 'elif', 'do', 'while', 'until']);
// Wrappers that run another command; we look through them for gh/git/shells.
// `time` is here rather than in KEYWORDS: the keyword takes `-p` and `--`, and
// /usr/bin/time takes options too, so its own options must be skipped.
export const WRAPPERS = new Set([
    'env', 'command', 'builtin', 'exec', 'nohup', 'sudo', 'nice', 'xargs',
    'timeout', 'setsid', 'stdbuf', 'ionice', 'chronic', 'time',
    'flock', 'watch', 'taskset', 'chrt', 'unshare', 'nsenter', 'setpriv', 'chroot', 'busybox',
]);
export const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'mksh', 'ash', 'yash', 'posh', 'fish', 'csh', 'tcsh']);
// No list of programs that run a command is complete: `setarch x86_64 sudo
// dnf install`, `prlimit` and `strace -o log` run the words after them, and
// `script -qc '...'` hands a shell one string. Behind any program this hook
// neither checks nor steps over, the checked command it would run is checked
// as a command of its own; see checkUnlistedProgram() in guard-bash.mjs.
// These print, match or look up their arguments and never run them, so they
// are not read at all, which keeps `grep -rn 'sudo dnf' docs` and `which sudo`
// working.
// Only the bare spelling counts, and leaving a program out can only over-refuse.
export const ARGUMENT_ONLY_PROGRAMS = new Set(['echo', 'printf', 'grep', 'egrep', 'fgrep', 'which', 'whereis']);
// Each checked command behind such a program is checked from where it starts
// to the end of the segment, so the work grows with the square of the words.
// Past this many the command is refused unread; no real invocation runs that many.
export const MAX_UNLISTED_INNER = 8;
// What separates the words of a command string a program hands to a shell:
// whitespace, the shell's own punctuation and quotes. Splitting on all of them
// reads more words than the shell would, which can only over-refuse.
export const COMMAND_STRING_SEPARATORS = /[\s;&|()<>`'"]+/;
// How long one decision may take. Claude Code runs the command when the hook
// times out or dies, and reading every tail of a short-option cluster grows
// with the square of the word. A command still being read past this is
// refused instead; see spend().
export const BUDGET_MS = 5000;
let deadline = null;

/** Thrown once a decision has run past BUDGET_MS; main() refuses with it. */
export class OverBudget extends Error {}

export function spend() {
    if (deadline !== null && Date.now() > deadline) {
        throw new OverBudget(
            `Blocked: this hook could not finish checking the command within ${BUDGET_MS / 1000} seconds, and ` +
                'Claude Code runs a command whose hook times out, so it is refused rather than left half-read. ' +
                'Split it into shorter commands.'
        );
    }
}

/** Start the clock for one decision: spend() throws OverBudget once `ms` have passed. */
export function startBudget(ms) {
    deadline = Date.now() + ms;
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

/**
 * Split a shell command line into segments of words.
 * Quotes and backslashes are resolved; operators and parentheses end a segment;
 * heredoc bodies are skipped. This is a deliberately small approximation of
 * shell parsing, good enough to find command names and their flags.
 */
export function tokenize(input) {
    const segments = [];
    let words = [];
    let word = null; // null = no word in progress ('' = empty quoted word)
    const pendingHeredocs = [];

    let skip = null; // 'in' | 'out': the next word is a redirection target
    let stdinFrom; // target of `< file` for the current segment
    let hereString; // word of `<<< word` for the current segment
    let outs = []; // targets of `> file` / `>> file` for the current segment
    let pendingPipe = null; // previous segment when this one is the right side of `|`
    const endWord = () => {
        if (word !== null) {
            if (skip === 'in') stdinFrom = word;
            else if (skip === 'here') hereString = word;
            else if (skip === 'out') outs.push(word);
            else if (skip === null) words.push(word);
            skip = null;
        }
        word = null;
    };
    const endSegment = (pipe = false) => {
        endWord();
        skip = null;
        if (words.length || stdinFrom !== undefined || outs.length) {
            words.stdinFrom = stdinFrom;
            words.hereString = hereString;
            words.pipedFrom = pendingPipe;
            words.outs = outs;
            segments.push(words);
            pendingPipe = pipe ? words : null;
        }
        stdinFrom = undefined;
        hereString = undefined;
        outs = [];
        words = [];
    };
    const append = (ch) => {
        word = (word ?? '') + ch;
    };

    let i = 0;
    while (i < input.length) {
        const c = input[i];

        if (c === "'") {
            const end = input.indexOf("'", i + 1);
            const stop = end === -1 ? input.length : end;
            append(input.slice(i + 1, stop));
            i = stop + 1;
        } else if (c === '"') {
            i++;
            append('');
            while (i < input.length && input[i] !== '"') {
                if (input[i] === '$' && input[i + 1] === '(') {
                    // A substitution body may contain quotes of its own; it is analysed separately.
                    // Its text stays in the word (a `bash -c "$(cat x)"` script is re-analysed from it).
                    const end = closeParen(input, i + 2);
                    append(input.slice(i, end));
                    i = end;
                    continue;
                }
                if (input[i] === '\\' && i + 1 < input.length) {
                    const next = input[i + 1];
                    if ('"\\$`'.includes(next)) i++;
                    else if (next === '\n') {
                        i += 2;
                        continue;
                    }
                }
                append(input[i]);
                i++;
            }
            i++;
        } else if (c === '\\') {
            if (input[i + 1] === '\n') {
                i += 2; // line continuation
            } else {
                append(input[i + 1] ?? '');
                i += 2;
            }
        } else if (c === '#' && word === null) {
            while (i < input.length && input[i] !== '\n') i++; // comment
        } else if (c === '\n') {
            endSegment();
            i++;
            // Skip the bodies of heredocs started on the line that just ended.
            // The body is kept on the segment that started the heredoc: a shell
            // reading it runs it, so it is analysed as a command line.
            while (pendingHeredocs.length) {
                const { delim, seg } = pendingHeredocs.shift();
                const bodyStart = i;
                let bodyEnd = input.length;
                while (i < input.length) {
                    let eol = input.indexOf('\n', i);
                    if (eol === -1) eol = input.length;
                    const lineStart = i;
                    const line = input.slice(i, eol).replace(/^\t+/, '');
                    i = eol + 1;
                    if (line === delim) {
                        bodyEnd = lineStart;
                        break;
                    }
                }
                seg.heredocBody = (seg.heredocBody ?? '') + input.slice(bodyStart, bodyEnd);
            }
        } else if (c === '<' && input[i + 1] === '<' && input[i + 2] !== '<') {
            const { delim, next } = readHeredocStart(input, i);
            i = next;
            endWord();
            if (delim) pendingHeredocs.push({ delim, seg: words });
        } else if ((c === '<' || c === '>') && input[i + 1] === '(') {
            // Process substitution `<(cmd)` / `>(cmd)`: an argument; its body is analysed separately.
            append('/dev/fd/N');
            i = closeParen(input, i + 2);
        } else if ((c === '<' || c === '>' || c === '&') && REDIRECT.test(input.slice(i, i + 3))) {
            // Redirections end the word and are not arguments: `./x.sh>log`, `2>&1`,
            // `&>f`, `<file`. The target word is consumed (and remembered for `<`).
            const op = REDIRECT.exec(input.slice(i, i + 3))[0];
            if (word !== null && /^\d+$/.test(word)) word = null; // fd number: `2>`
            endWord();
            skip = op === '<<<' ? 'here' : op.startsWith('<') ? 'in' : 'out';
            i += op.length;
        } else if (c === ' ' || c === '\t') {
            endWord();
            i++;
        } else if (c === '|') {
            const dbl = input[i + 1] === '|';
            endSegment(!dbl);
            i += dbl || input[i + 1] === '&' ? 2 : 1;
        } else if (c === '&' || c === ';' || c === '(' || c === ')') {
            endSegment();
            i++;
        } else if (c === '`') {
            // Substitution contents are analysed separately; the enclosing
            // command line carries on after the closing backtick.
            append('$()');
            const end = input.indexOf('`', i + 1);
            i = end === -1 ? input.length : end + 1;
        } else if (c === '$' && input[i + 1] === '(') {
            append('$()');
            i = closeParen(input, i + 2);
        } else if (c === '$' && input[i + 1] === "'") {
            // `$'git'` (ANSI-C quoting): the shell drops the `$` and decodes the
            // escapes, so `$'\x67it'` is `git` and `$'it\'s'` is one word.
            const { text, next } = readAnsiC(input, i + 2);
            append(text);
            i = next;
        } else if (c === '$' && input[i + 1] === '"') {
            // `$"git"` (locale quoting) quotes like `"git"`: the word is `git`, not `$git`.
            i++;
        } else {
            append(c);
            i++;
        }
    }
    endSegment();
    return segments;
}

// One-letter escapes of `$'...'` and the characters they stand for.
export const ANSI_C_ESCAPES = { a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\', "'": "'", '"': '"', '?': '?' };
// Numeric escapes of `$'...'`: what each reads after the `\`, the base, and how many letters lead the digits.
export const ANSI_C_NUMERIC = [
    [/^[0-7]{1,3}/, 8, 0],
    [/^x[0-9a-fA-F]{1,2}/, 16, 1],
    [/^u[0-9a-fA-F]{1,4}/, 16, 1],
    [/^U[0-9a-fA-F]{1,8}/, 16, 1],
];

/**
 * Decode the body of a `$'...'` string starting at input[i] (just past the
 * opening quote) the way bash does: `\xHH`, `\NNN`, `\uHHHH`, `\UHHHHHHHH`,
 * `\cX` and the one-letter escapes. A NUL ends the text, as it does in bash.
 * Returns { text, next } (next = index after the closing quote).
 */
export function readAnsiC(input, i) {
    let text = '';
    let ended = false;
    const add = (s) => {
        if (s === '\0') ended = true;
        if (!ended) text += s;
    };
    while (i < input.length && input[i] !== "'") {
        if (input[i] !== '\\' || i + 1 >= input.length) {
            add(input[i++]);
            continue;
        }
        const rest = input.slice(i + 1, i + 10);
        const numeric = ANSI_C_NUMERIC.map(([re, base, skip]) => [re.exec(rest), base, skip]).find(([m]) => m);
        if (numeric) {
            const [[escape], base, skip] = numeric;
            const code = parseInt(escape.slice(skip), base);
            add(code <= 0x10ffff ? String.fromCodePoint(base === 8 ? code & 0xff : code) : `\\${escape}`);
            i += 1 + escape.length;
        } else if (rest[0] === 'c' && rest.length > 1) {
            add(String.fromCharCode(rest.charCodeAt(1) & 0x1f));
            i += 3;
        } else if (Object.hasOwn(ANSI_C_ESCAPES, rest[0])) {
            add(ANSI_C_ESCAPES[rest[0]]);
            i += 2;
        } else {
            add(`\\${rest[0]}`);
            i += 2;
        }
    }
    return { text, next: i + 1 };
}

/**
 * Find the bodies of $(...) and `...` substitutions, including ones inside
 * double quotes (but not single quotes), so they can be analysed as commands.
 */
export function extractSubstitutions(input) {
    const found = [];
    let inSingle = false;
    let inDouble = false;
    const pending = []; // heredocs started on the current line
    for (let i = 0; i < input.length; i++) {
        const c = input[i];
        if (c === '\\' && !inSingle) {
            i++;
        } else if (c === '$' && input[i + 1] === "'" && !inSingle && !inDouble) {
            // `$'...'` holds no substitution, and `\'` does not end it.
            i = readAnsiC(input, i + 2).next - 1;
        } else if (c === "'" && !inDouble) {
            inSingle = !inSingle;
        } else if (c === '"' && !inSingle) {
            inDouble = !inDouble;
        } else if (!inSingle && !inDouble && c === '<' && input[i + 1] === '<' && input[i + 2] !== '<') {
            const h = readHeredocStart(input, i);
            if (h.delim) pending.push(h);
            i = h.next - 1;
        } else if (!inSingle && !inDouble && c === '\n' && pending.length) {
            // A quoted heredoc body is data (Markdown backticks in a PR body are not
            // commands). An unquoted body is expanded by the shell, so it is scanned.
            while (pending.length && pending[0].quoted) i = skipHeredocBody(input, i + 1, pending.shift().delim) - 1;
            pending.length = 0;
        } else if (!inSingle && (c === '$' || (!inDouble && (c === '<' || c === '>'))) && input[i + 1] === '(') {
            const j = closeParen(input, i + 2);
            found.push(input.slice(i + 2, j - 1));
            i = j - 1; // nested substitutions are found by the recursive analysis
        } else if (!inSingle && c === '`') {
            const end = input.indexOf('`', i + 1);
            const stop = end === -1 ? input.length : end;
            found.push(input.slice(i + 1, stop));
            i = stop;
        }
    }
    return found;
}

/**
 * Index just past the `)` that closes a substitution whose body starts at `j`,
 * ignoring parens in quotes, escaped, or in heredoc bodies.
 */
export function closeParen(input, j) {
    let depth = 1;
    let q = null;
    const inner = [];
    for (; j < input.length && depth > 0; j++) {
        const d = input[j];
        if (d === '\\' && q !== "'") j++;
        else if (q) {
            if (d === q) q = null;
        } else if (d === "'" || d === '"') q = d;
        else if (d === '<' && input[j + 1] === '<' && input[j + 2] !== '<') {
            const h = readHeredocStart(input, j);
            if (h.delim) inner.push(h);
            j = h.next - 1;
        } else if (d === '\n' && inner.length) {
            while (inner.length) j = skipHeredocBody(input, j + 1, inner.shift().delim) - 1;
        } else if (d === '(') depth++;
        else if (d === ')') depth--;
    }
    return j;
}

/** Parse `<<[-]['"]DELIM['"]` at input[i]; returns { delim, quoted, next } (next = index after it). */
export function readHeredocStart(input, i) {
    i += 2;
    if (input[i] === '-') i++;
    while (input[i] === ' ' || input[i] === '\t') i++;
    let delim = '';
    let quote = null;
    let quoted = false;
    while (i < input.length) {
        const d = input[i];
        if (quote) {
            if (d === quote) quote = null;
            else delim += d;
        } else if (d === "'" || d === '"') {
            quote = d;
            quoted = true;
        } else if (d === '\\') {
            quoted = true;
            delim += input[i + 1] ?? '';
            i++;
        } else if (/[\s;&|()<>]/.test(d)) break;
        else delim += d;
        i++;
    }
    return { delim, quoted, next: i };
}

/** Index just past the line that closes a heredoc whose body starts at `i`. */
export function skipHeredocBody(input, i, delim) {
    while (i < input.length) {
        let eol = input.indexOf('\n', i);
        if (eol === -1) eol = input.length;
        const line = input.slice(i, eol).replace(/^\t+/, '');
        i = eol + 1;
        if (line === delim) break;
    }
    return i;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export const isAssignment = (w) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(w);

// ---------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------

// git config keys that can redirect where a push goes or how it authenticates.
// (push.* keys such as push.default or push.autoSetupRemote cannot change the target.)
export const RISKY_GIT_CONFIG = /^(remote\.|url\.|credential\.|core\.sshcommand$)/i;
// `-c` keys that make git run a program or read config from elsewhere
// (`git -c diff.external=prog diff`, `-c core.pager=...`, `-c alias.x=!cmd`).
export const EXEC_GIT_CONFIG =
    /^(core\.(pager|editor|fsmonitor|hookspath|askpass|gitproxy|attributesfile)$|diff\.|pager\.|alias\.|sequence\.editor$|gpg\.|filter\.|merge\.|interactive\.|include\.|includeif\.|uploadpack\.|protocol\.)/i;
// Options that turn a read-only git command (`git diff|log|show`, allow-listed in
// .claude/settings.json) into a file write (`--output=FILE`), a read of any path
// on disk (`--no-index`) or a program run (`--ext-diff`, git grep's
// `--open-files-in-pager`). git rejects abbreviations of these diff options
// (`--outp=` exits 128/129 and writes nothing), so the full spelling is enough;
// `--output-indicator-*` and `--no-ext-diff` do not match.
export const REFUSED_GIT_OPTION = /^--(?:output|no-index|ext-diff|open-files-in-pager)(?:=|$)/;
// Options that make a network read command (`git fetch`, allow-listed in
// .claude/settings.json) run the program they name against a local path or ssh
// remote: `--upload-pack=CMD`, `--exec=CMD` (ls-remote, archive --remote) and
// `-u CMD` (clone, ls-remote). Unlike the diff options above, git's option
// parser accepts any unique prefix (`--upl=CMD` works), so match every prefix
// from `--upl` on; `--update-head-ok` and `--exit-code` do not match.
export const GIT_UPLOAD_PACK_SUBCOMMANDS = new Set(['fetch', 'pull', 'clone', 'ls-remote', 'archive']);
export const GIT_UPLOAD_PACK_OPTION = /^--upl(?:o(?:a(?:d(?:-(?:p(?:a(?:ck?)?)?)?)?)?)?)?(?:=|$)/;
export const GIT_EXEC_OPTION = /^--e(?:x(?:ec?)?)?(?:=|$)/;
export const GIT_SHORT_UPLOAD_PACK = /^-[a-zA-Z]*u/;

// Environment variables git or node read to run a program, load code, write a
// file or switch repository/config (`GIT_EXTERNAL_DIFF=prog git diff`,
// `GIT_TRACE=FILE`, `GIT_DIR=...`, `NODE_OPTIONS=--import=...`,
// `NODE_V8_COVERAGE=DIR`). Fail closed: every GIT_* / NODE_* name is refused
// unless SAFE_ENV lists it.
export const WATCHED_ENV = /^(GIT_|NODE_|PAGER$|EDITOR$|VISUAL$|LESSOPEN$|LESSCLOSE$)/;
export const SAFE_ENV = new Set([
    'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_AUTHOR_DATE', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL',
    'GIT_COMMITTER_DATE', 'GIT_TERMINAL_PROMPT', 'GIT_OPTIONAL_LOCKS', 'GIT_MERGE_AUTOEDIT', 'GIT_FLUSH',
    'NODE_ENV', 'NODE_NO_WARNINGS', 'NODE_DISABLE_COLORS',
]);
// Program-valued variables that are harmless only with a no-op value (`GIT_PAGER=cat`).
export const PROGRAM_ENV = new Set(['GIT_PAGER', 'PAGER', 'GIT_EDITOR', 'GIT_SEQUENCE_EDITOR', 'EDITOR', 'VISUAL']);
export const NOOP_PROGRAMS = new Set(['', 'cat', 'true', ':']);

/** Name of the first risky variable in an env map ({ NAME: value | null }), or undefined. */
export function riskyEnv(env) {
    return Object.keys(env).find((k) => {
        if (!WATCHED_ENV.test(k) || SAFE_ENV.has(k)) return false;
        if (PROGRAM_ENV.has(k)) return !NOOP_PROGRAMS.has(env[k]);
        return true;
    });
}

// ---------------------------------------------------------------------------
// Directory changes
// ---------------------------------------------------------------------------

// Commands that change the shell's working directory (C1).
export const CHDIR = new Set(['cd', 'pushd', 'popd']);

/**
 * C1: true if a tokenized segment runs cd/pushd/popd (also as `builtin cd`,
 * `command cd`, or after `if`/`{`/NAME=value words).
 */
export function changesDirectory(words) {
    let k = 0;
    while (k < words.length) {
        const x = words[k];
        // `function f { cd sub; }`: the body runs in this shell when f is called.
        if (x === 'function') k += 2;
        else if (isAssignment(x) || KEYWORDS.has(x) || WRAPPERS.has(basename(x)) || x.startsWith('-')) k++;
        else break;
    }
    if (k >= words.length) return false;
    const cmd = words[k];
    // eval runs its words in this shell: `eval cd sub` moves it too.
    if (basename(cmd) === 'eval') return tokenize(words.slice(k + 1).join(' ')).some(changesDirectory);
    // A command name the shell expands (`$X sub`, `$(echo cd) sub`, `{cd,} sub`,
    // `c? sub` beside a file named cd) could be cd.
    if (CHDIR.has(basename(cmd)) || /[$`]/.test(cmd)) return true;
    const forms = BRACE_GROUP.test(cmd) ? braceForms(cmd) : [cmd];
    if (forms === null) return true;
    return forms.some((f) => [...CHDIR].some((d) => basename(f) === d || (GLOB.test(basename(f)) && globMatches(basename(f), d))));
}

/** The first word that is not an option (skipping the values of `valueFlags`), and the words after it. */
export function firstWord(args, valueFlags) {
    for (let i = 0; i < args.length; i++) {
        if (valueFlags.includes(args[i])) i++;
        else if (!args[i].startsWith('-')) return { sub: args[i], rest: args.slice(i + 1) };
    }
    return { sub: undefined, rest: [] };
}

// ---------------------------------------------------------------------------
// Wrappers and the commands they run
// ---------------------------------------------------------------------------

// Options of wrapper commands that take a separate value word. Only options
// with a required value belong here: listing a flag would skip the command word.
export const WRAPPER_VALUE_OPTS = {
    timeout: ['-s', '--signal', '-k', '--kill-after'],
    nice: ['-n', '--adjustment'],
    xargs: ['-n', '-I', '-L', '-P', '-s', '-d', '-E', '-a', '--max-args', '--max-procs', '--max-chars', '--delimiter', '--arg-file', '--process-slot-var'],
    stdbuf: ['-i', '-o', '-e', '--input', '--output', '--error'],
    ionice: ['-c', '-n', '-p', '-P', '-u', '--class', '--classdata', '--pid', '--pgid', '--uid'],
    env: ['-u', '--unset', '-C', '--chdir', '-a', '--argv0'],
    exec: ['-a'],
    time: ['-f', '--format', '-o', '--output'],
    flock: ['-w', '--timeout', '--wait', '-E', '--conflict-exit-code', '--start', '--length'],
    watch: ['-n', '--interval', '-q', '--equexit', '--eqexit', '-s', '--shotsdir'],
    chrt: ['-T', '--sched-runtime', '-P', '--sched-period', '-D', '--sched-deadline'],
    unshare: [
        '-S', '--setuid', '-G', '--setgid', '-R', '--root', '-w', '--wd', '-l', '--load-interp', '--owner', '--propagation',
        '--setgroups', '--monotonic', '--boottime', '--map-user', '--map-group', '--map-users', '--map-groups',
    ],
    // nsenter's -W/--wdns value is optional (`-W/path`, `--wdns=/path`), so the next word is never it.
    nsenter: ['-t', '--target', '-S', '--setuid', '-G', '--setgid', '-N', '--net-socket'],
    setpriv: [
        '--ambient-caps', '--inh-caps', '--bounding-set', '--ruid', '--euid', '--rgid', '--egid', '--reuid', '--regid',
        '--groups', '--securebits', '--pdeathsig', '--selinux-label', '--apparmor-profile', '--landlock-access',
        '--landlock-rule', '--seccomp-filter', '--ptracer',
    ],
    chroot: ['--userspec', '--groups'],
};
// Operand words a wrapper takes before the command: timeout's duration,
// taskset's CPU mask, flock's lock file, chroot's new root.
export const WRAPPER_OPERANDS = { timeout: 1, taskset: 1, flock: 1, chroot: 1 };
// Options that make taskset/chrt act on a running process (-p) or only print
// (chrt -m): the words after them are not a command.
export const NO_COMMAND_OPTS = {
    taskset: /^(?:--pid$|-[a-zA-Z]*p)/,
    chrt: /^(?:--pid$|--max$|-[a-zA-Z]*[pm])/,
};

// Each wrapper's options as getopt reads them: the short letters that take a
// value, the short letters whose value is optional (`-i[R]`: only the rest of
// the same word, never the next word), and every long name (getopt_long
// accepts any unambiguous prefix).
export const WRAPPER_GETOPT = {
    env: { value: 'uCSa', long: ['ignore-environment', 'null', 'unset', 'chdir', 'argv0', 'split-string', 'block-signal', 'default-signal', 'ignore-signal', 'list-signal-handling', 'debug'] },
    timeout: { value: 'sk', long: ['signal', 'kill-after', 'foreground', 'preserve-status', 'verbose'] },
    nice: { value: 'n', long: ['adjustment'] },
    stdbuf: { value: 'ioe', long: ['input', 'output', 'error'] },
    ionice: { value: 'cnpPu', long: ['class', 'classdata', 'pid', 'pgid', 'uid', 'ignore'] },
    xargs: { value: 'adEILnPs', optional: 'eil', long: ['arg-file', 'delimiter', 'eof', 'replace', 'max-lines', 'max-args', 'max-procs', 'max-chars', 'process-slot-var', 'null', 'open-tty', 'interactive', 'no-run-if-empty', 'verbose', 'exit', 'show-limits'] },
    exec: { value: 'a', long: [] },
    time: { value: 'fo', long: ['format', 'output', 'append', 'portability', 'verbose', 'quiet', 'help', 'version'] },
    // util-linux, procps and coreutils option tables.
    flock: {
        value: 'wE',
        long: ['shared', 'exclusive', 'unlock', 'nonblocking', 'nb', 'timeout', 'wait', 'conflict-exit-code', 'close', 'no-fork', 'verbose', 'fcntl', 'start', 'length', 'help', 'version'],
    },
    watch: {
        value: 'nqs',
        optional: 'd',
        long: ['color', 'no-color', 'differences', 'help', 'interval', 'beep', 'errexit', 'follow', 'chgexit', 'equexit', 'exec', 'precise', 'no-rerun', 'shotsdir', 'no-title', 'no-wrap', 'version'],
    },
    chrt: {
        value: 'DPT',
        long: ['all-tasks', 'batch', 'deadline', 'ext', 'fifo', 'idle', 'pid', 'help', 'max', 'other', 'rr', 'sched-runtime', 'sched-period', 'sched-deadline', 'reset-on-fork', 'verbose', 'version'],
    },
    taskset: { value: '', long: ['all-tasks', 'pid', 'cpu-list', 'help', 'version'] },
    unshare: {
        value: 'RwSGl',
        long: [
            'help', 'version', 'mount', 'uts', 'ipc', 'net', 'pid', 'user', 'cgroup', 'time', 'fork', 'kill-child', 'forward-signals', 'mount-proc',
            'mount-binfmt', 'map-user', 'map-users', 'map-group', 'map-groups', 'map-root-user', 'map-current-user', 'map-auto', 'map-subids',
            'owner', 'propagation', 'setgroups', 'keep-caps', 'monotonic', 'boottime', 'load-interp', 'setuid', 'setgid', 'root', 'wd',
        ],
    },
    nsenter: {
        value: 'tNSG',
        optional: 'muinpCUTrwW',
        long: [
            'all', 'help', 'version', 'target', 'mount', 'uts', 'ipc', 'net', 'net-socket', 'pid', 'user', 'cgroup', 'time', 'setuid', 'setgid',
            'root', 'wd', 'wdns', 'env', 'no-fork', 'join-cgroup', 'preserve-credentials', 'keep-caps', 'user-parent', 'follow-context',
        ],
    },
    setpriv: {
        value: '',
        long: [
            'dump', 'nnp', 'no-new-privs', 'inh-caps', 'ambient-caps', 'list-caps', 'ruid', 'euid', 'rgid', 'egid', 'reuid', 'regid', 'clear-groups',
            'keep-groups', 'init-groups', 'groups', 'bounding-set', 'securebits', 'pdeathsig', 'ptracer', 'selinux-label', 'apparmor-profile',
            'landlock-access', 'landlock-rule', 'seccomp-filter', 'help', 'reset-env', 'version',
        ],
    },
    chroot: { value: '', long: ['groups', 'userspec', 'skip-chdir', 'help', 'version'] },
};

/**
 * Rewrite a wrapper's leading options into the one-option-per-word, full-name
 * form the checks below match: `env -iu X` -> `env -i -u X`, `timeout -vk 5`
 * -> `timeout -v -k 5`, `env --uns X` -> `env --unset X`. Otherwise the value
 * of a packed or abbreviated option is taken for the command the wrapper runs.
 */
export function expandWrapperOptions(cmd, w) {
    const spec = WRAPPER_GETOPT[cmd];
    if (!spec) return w;
    const takesValue = WRAPPER_VALUE_OPTS[cmd] ?? [];
    const out = [w[0]];
    let k = 1;
    for (; k < w.length; k++) {
        const a = w[k];
        // A lone `-` is env's old spelling of -i; anywhere else it ends the options.
        if (a === '-' && cmd === 'env') {
            out.push(a);
            continue;
        }
        if (a === '--' || a === '-' || !a.startsWith('-')) break;
        if (a.startsWith('--')) {
            const eq = a.indexOf('=');
            const name = a.slice(2, eq === -1 ? undefined : eq);
            const hits = spec.long.filter((l) => l.startsWith(name));
            const full = `--${spec.long.includes(name) || hits.length !== 1 ? name : hits[0]}`;
            if (eq !== -1) out.push(full + a.slice(eq));
            else {
                out.push(full);
                if (takesValue.includes(full) && k + 1 < w.length) out.push(w[++k]);
            }
            continue;
        }
        for (let i = 1; i < a.length; i++) {
            // `xargs -iE cmd`: E is -i's replace string, not a packed -E.
            if (spec.optional?.includes(a[i])) {
                out.push(`-${a[i]}${a.slice(i + 1)}`);
                break;
            }
            if (!spec.value.includes(a[i])) {
                out.push(`-${a[i]}`);
            } else if (i + 1 < a.length) {
                out.push(`-${a[i]}${a.slice(i + 1)}`);
                break;
            } else {
                out.push(`-${a[i]}`);
                if (k + 1 < w.length) out.push(w[++k]);
            }
        }
    }
    return [...out, ...w.slice(k)];
}

/** Index of the command a wrapper (env, timeout, xargs, ...) runs, or -1 if there is none to analyse. */
export function wrapperTarget(w) {
    const cmd = basename(w[0]);
    if (cmd === 'command' && w.some((a) => /^-[a-zA-Z]*[vV]/.test(a))) return -1; // lookup only
    const valueOpts = WRAPPER_VALUE_OPTS[cmd] ?? [];
    let operands = WRAPPER_OPERANDS[cmd] ?? 0;
    let priority = cmd === 'chrt'; // chrt's scheduling priority may be left out
    // After `--` every word is an operand or the command, even one starting with `-`
    // (`flock -- -lock CMD`: -lock is the lock file).
    let options = true;
    for (let k = 1; k < w.length; k++) {
        const a = w[k];
        // flock reads no options after its lock file: `flock FILE -c CMD` is its command form.
        if (cmd === 'flock' && operands === 0) return k;
        if (isAssignment(a)) continue;
        if (options && a === '--') {
            options = false;
            continue;
        }
        if (options && a === '-' && cmd === 'env') continue;
        if (options && a.startsWith('-') && a.length > 1) {
            if (NO_COMMAND_OPTS[cmd]?.test(a)) return -1;
            if (valueOpts.includes(a)) k++;
            continue;
        }
        if (operands > 0) {
            operands--;
            continue;
        }
        // chrt reads the priority with strtol, so leading blanks and a sign are
        // part of it: `chrt -o +0 CMD` and `chrt -o -- -0 CMD` run CMD.
        if (priority && /^[ \t\n\v\f\r]*[+-]?\d+$/.test(a)) {
            priority = false;
            continue;
        }
        return k;
    }
    return -1;
}

export const FIND_EXEC = ['-exec', '-execdir', '-ok', '-okdir'];

// fish's long options (getopt accepts any unambiguous prefix) and the ones taking a value.
export const FISH_LONG = [
    'command', 'debug', 'debug-output', 'debug-stack-frames', 'features', 'help', 'init-command', 'interactive', 'login',
    'no-config', 'no-execute', 'print-debug-categories', 'print-rusage-self', 'private', 'profile', 'profile-startup', 'version',
];
export const FISH_LONG_VALUE = new Set(['command', 'init-command', 'debug', 'debug-output', 'debug-stack-frames', 'features', 'profile', 'profile-startup']);
// fish's short options taking a value: the rest of the word, or else the next word.
export const FISH_SHORT_VALUE = 'cCdDfop';

/**
 * Every code string a fish invocation runs: the values of -c/--command and
 * -C/--init-command, attached (`-cCMD`, `--command=CMD`) or in the next word,
 * in a short cluster (`-ic CMD`) or behind an abbreviated long name (`--comm`).
 * Words that are not options are skipped rather than ending the scan, so an
 * option after a script name is still inspected.
 */
export function fishScripts(args) {
    const scripts = [];
    for (let k = 0; k < args.length; k++) {
        const a = args[k];
        if (a === '--') break;
        if (!a.startsWith('-') || a === '-') continue;
        if (a.startsWith('--')) {
            const eq = a.indexOf('=');
            const name = a.slice(2, eq === -1 ? undefined : eq);
            const hits = FISH_LONG.filter((o) => o.startsWith(name));
            const opt = hits.includes(name) ? name : hits.length === 1 ? hits[0] : null;
            if (!FISH_LONG_VALUE.has(opt)) continue;
            const value = eq === -1 ? args[++k] : a.slice(eq + 1);
            if ((opt === 'command' || opt === 'init-command') && value !== undefined) scripts.push(value);
            continue;
        }
        for (let j = 1; j < a.length; j++) {
            if (!FISH_SHORT_VALUE.includes(a[j])) continue;
            const value = j + 1 < a.length ? a.slice(j + 1) : args[++k];
            if ((a[j] === 'c' || a[j] === 'C') && value !== undefined) scripts.push(value);
            break;
        }
    }
    return scripts;
}

// ---------------------------------------------------------------------------
// Command names the shell builds
// ---------------------------------------------------------------------------

// A command name the shell builds before it looks it up. Bash expands
// a word's brace groups (`{git,}` is `git`, `g{i,x}t` is `git gxt`), and
// matches a word holding a wildcard against the filesystem (`/usr/bin/g?t` is
// `/usr/bin/git`; `g?t` is `git` once a file named git sits in the working
// directory, and bash then finds git on the PATH), so the word as typed is not
// the program that runs. A word with more brace forms than this is not expanded: it is
// read as though it could name any checked command.
export const MAX_BRACE_FORMS = 32;
export const BRACE_GROUP = /\{([^{}]*,[^{}]*)\}/;
export const GLOB = /[*?[]/;

/** Every word brace expansion could make of `word`, or null past MAX_BRACE_FORMS. */
export function braceForms(word) {
    const forms = [word];
    const pending = [word];
    while (pending.length) {
        const form = pending.pop();
        const group = BRACE_GROUP.exec(form);
        if (!group) continue;
        for (const alternative of group[1].split(',')) {
            const expanded = form.slice(0, group.index) + alternative + form.slice(group.index + group[0].length);
            if (forms.push(expanded) > MAX_BRACE_FORMS) return null;
            pending.push(expanded);
        }
    }
    return forms;
}

/**
 * Whether the glob `pattern` (`*`, `?`, `[...]`) matches all of `name`. The
 * match runs in time linear in the two lengths, so a word cannot stall the hook
 * past its timeout (Claude Code runs the command when the hook times out): a
 * pattern of many `*` compiled to a regexp (`.*.*.*…`) backtracks exponentially
 * against a name it does not fit. This is the classic single-star-pointer
 * match: on a mismatch it falls back only to the latest `*`, never to an
 * earlier one.
 */
export function globMatches(pattern, name) {
    const tokens = [];
    const lastClose = pattern.lastIndexOf(']');
    for (let i = 0; i < pattern.length; i++) {
        const c = pattern[i];
        const close = c === '[' && lastClose >= i + 2 ? pattern.indexOf(']', i + 2) : -1;
        if (c === '*') {
            if (tokens.length === 0 || tokens[tokens.length - 1].kind !== 'star') tokens.push({ kind: 'star' });
        } else if (c === '?') tokens.push({ kind: 'any' });
        else if (close !== -1) {
            // A bracket expression holds at least one character (a leading `]` is
            // part of the set), then runs to the first `]` after it.
            const body = pattern.slice(i + 1, close);
            const negate = body[0] === '!' || body[0] === '^';
            const set = negate ? body.slice(1) : body;
            const ranges = [];
            for (let j = 0; j < set.length; j++) {
                const isRange = j + 2 < set.length && set[j + 1] === '-';
                const hi = isRange ? set[j + 2] : set[j];
                if (set[j] > hi) return true; // a range we cannot read could match anything
                ranges.push([set[j], hi]);
                if (isRange) j += 2;
            }
            tokens.push({ kind: 'set', negate, ranges });
            i = close;
        } else tokens.push({ kind: 'char', c });
    }
    const fits = (token, ch) =>
        token.kind === 'any' ||
        (token.kind === 'char' && token.c === ch) ||
        (token.kind === 'set' && token.ranges.some(([lo, hi]) => lo <= ch && ch <= hi) !== token.negate);
    let p = 0;
    let t = 0;
    let star = -1;
    let mark = 0;
    while (t < name.length) {
        const token = tokens[p];
        if (token && token.kind === 'star') {
            star = p;
            mark = t;
            p++;
        } else if (token && fits(token, name[t])) {
            p++;
            t++;
        } else if (star !== -1) {
            p = star + 1;
            t = ++mark;
        } else return false;
    }
    while (p < tokens.length && tokens[p].kind === 'star') p++;
    return p === tokens.length;
}

/**
 * The readers of a command name the shell builds, bound to `checkedNames`: the
 * Set of every program name the guard checks or looks through. Each guard
 * passes its own list; the reading is the same in all of them.
 */
export function commandNameReader(checkedNames) {
    /**
     * How the shell could build a checked command name out of a word it would
     * run, when the word is not that name spelled out: { braces: true } when its
     * brace groups can expand to one (or have too many forms to read), or
     * { globs: [names] } when it holds a wildcard that may match them, with or
     * without a `/`: a file named git in the working directory makes `g?t` run
     * the git on the PATH. A name made only of `*` and `?` (`*`, `???`) can match
     * any program, so it is read as every checked name it fits when `commandWord`
     * says the shell runs the word; a later word made only of wildcards (`ls *`)
     * is left alone, since reading it as each checked program would refuse every
     * such listing. Otherwise null. Quotes are gone from the words by now, so a
     * quoted `{` or `*` reads as an unquoted one, which can only refuse more.
     */
    function builtCommandName(word, commandWord = false) {
        if (!/[{}*?[]/.test(word)) return null;
        const forms = BRACE_GROUP.test(word) ? braceForms(word) : [word];
        if (forms === null) return { braces: true };
        const globs = new Set();
        for (const form of forms) {
            if (/\s/.test(form)) continue; // a word with a blank in it names no program
            const name = basename(form);
            if (checkedNames.has(name) && form !== word) return { braces: true };
            if (!GLOB.test(name) || (!commandWord && /^[*?]+$/.test(name))) continue;
            for (const checked of checkedNames) if (globMatches(name, checked)) globs.add(checked);
        }
        if (!globs.size) return null;
        return forms.length > 1 ? { braces: true } : { globs: [...globs] };
    }

    /** Whether this word names a command the guard checks or looks through, also once the shell has expanded it. */
    function namesCheckedCommand(a) {
        return checkedNames.has(basename(a)) || builtCommandName(a) !== null;
    }
    return { builtCommandName, namesCheckedCommand };
}

/**
 * The word as the shell would look it up: quotes, backslashes and the `$` of
 * `$'...'` removed. A shell drops them before it looks a name up, so `s""udo`,
 * `su\do` and `$'sudo'` inside a command string all run sudo. Removing more
 * can only refuse more.
 */
export function unquoted(a) {
    return a.replace(/[$"'\\]/g, '');
}

/**
 * The command strings a word may hand to a shell: the word itself when it
 * holds more than one word of its own (`script -c 'sudo dnf install x'`), or a
 * value attached to an option in the same word: after the `=` of a long
 * option, or after any letter of a short-option cluster (`script -qc'sudo id'`).
 * Which letter takes a value is not modelled, so every one is tried. Yielded
 * one at a time: a long cluster has as many tails as letters, each nearly as
 * long as the word.
 */
export function* commandStrings(word) {
    if (COMMAND_STRING_SEPARATORS.test(word)) yield word;
    if (word.startsWith('--')) {
        const eq = word.indexOf('=');
        if (eq !== -1) yield word.slice(eq + 1);
    } else {
        const cluster = /^-[A-Za-z0-9]+/.exec(word);
        if (cluster) for (let cut = 2; cut <= cluster[0].length; cut++) yield word.slice(cut);
    }
}

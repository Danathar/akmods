#!/usr/bin/env node
/**
 * Policy-as-code checker for Danathar/akmods. Evaluates the JSON policies in
 * policies/ and the risk-tier table against the files in a repository tree.
 *
 *   node scripts/check-policies.mjs                 check this repository
 *   node scripts/check-policies.mjs --root <dir>    check another tree (tests)
 *   node scripts/check-policies.mjs --classify <path>...
 *                                                   print the risk tier of paths
 *
 * Checks:
 *   1. policies/signing-keys.json         certs/*.priv stay 0 bytes, no private
 *                                         key material, signing secrets only in
 *                                         the two reusable build workflows
 *   2. policies/workflow-permissions.json trigger, permission and pin hygiene
 *   3. policies/repo-target.json          gh writes name Danathar/akmods
 *   4. policies/fork-patches.json         P1/P2/T3/T6 patches still present
 *   5. policies/ruleset.json              .github/rulesets/main.json shape
 *   6. docs/risk-tiers.md vs risk-config.json: table drift, and every
 *      risk-config path matches a tracked file (except `pending` globs)
 *
 * Node built-ins only. Exit code 1 when any violation is found.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'coverage']);

// ---------------------------------------------------------------- helpers

/** Convert a glob (`**`, `*`, `?`) to an anchored RegExp over posix paths. */
export function globToRegExp(glob) {
    let re = '';
    for (let i = 0; i < glob.length; i++) {
        const c = glob[i];
        if (c === '*') {
            if (glob[i + 1] === '*') {
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

export function matchesAny(globs, file) {
    return globs.some((g) => globToRegExp(g).test(file));
}

/** All files under root as posix relative paths. */
export function walk(root, rel = '') {
    const out = [];
    for (const entry of fs.readdirSync(path.join(root, rel), {
        withFileTypes: true,
    })) {
        const r = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
            if (!SKIP_DIRS.has(entry.name)) out.push(...walk(root, r));
        } else if (entry.isFile()) {
            out.push(r);
        }
    }
    return out.sort();
}

function readJson(root, rel, violations) {
    const file = path.join(root, rel);
    if (!fs.existsSync(file)) {
        violations.push(`${rel}: missing`);
        return null;
    }
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
        violations.push(`${rel}: invalid JSON (${err.message})`);
        return null;
    }
}

const readText = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8');

// ------------------------------------------------------- 1. signing keys

export function checkSigningKeys(root, policy, files) {
    const v = [];
    for (const f of files) {
        if (matchesAny(policy.emptyPlaceholderGlobs, f)) {
            const size = fs.statSync(path.join(root, f)).size;
            if (size !== 0) {
                v.push(
                    `${f}: private-key placeholder must be 0 bytes (found ${size}); real keys come from repository secrets at build time`,
                );
            }
            continue;
        }
        if (matchesAny(policy.privateKeyAllowedGlobs, f)) continue;
        const stat = fs.statSync(path.join(root, f));
        if (stat.size === 0 || stat.size > policy.privateKeyScanMaxBytes) continue;
        const buf = fs.readFileSync(path.join(root, f));
        if (buf.includes(0)) continue; // binary (e.g. .der public certs)
        if (new RegExp(policy.privateKeyPattern).test(buf.toString('utf8'))) {
            v.push(`${f}: contains private key material`);
        }
    }

    const s = policy.signingSecrets;
    const secretRe = new RegExp(s.pattern);
    for (const f of files) {
        if (!matchesAny(s.scanGlobs, f) || s.allowedFiles.includes(f)) continue;
        readText(root, f)
            .split(/\r?\n/)
            .forEach((line, i) => {
                if (secretRe.test(line)) {
                    v.push(
                        `${f}:${i + 1}: signing secret referenced outside ${s.allowedFiles.join(' and ')}`,
                    );
                }
            });
    }
    return v;
}

// -------------------------------------------------------- 2. workflows

const indentOf = (l) => l.match(/^\s*/)[0].length;
const isBlank = (l) => l.trim() === '';

/**
 * Top-level `permissions:` must exist and must not grant write access
 * (`write-all` or any `<scope>: write`); wider scopes belong on a job.
 */
export function checkTopLevelPermissions(f, code, policy) {
    const at = code.findIndex((l) => /^permissions\s*:/.test(l));
    if (at === -1) {
        return [`${f}: no top-level "permissions:" (the token would get the repository default)`];
    }
    const v = [];
    const inline = code[at].replace(/^permissions\s*:/, '').trim();
    if (policy.forbidTopLevelWrite !== false) {
        if (/\bwrite\b/.test(inline)) {
            v.push(`${f}:${at + 1}: top-level permissions grant write`);
        }
        for (let j = at + 1; j < code.length; j++) {
            if (isBlank(code[j])) continue;
            if (indentOf(code[j]) === 0) break;
            if (/:\s*write\b/.test(code[j])) {
                v.push(
                    `${f}:${j + 1}: top-level permissions grant write ("${code[j].trim()}"); grant it on the job that needs it`,
                );
            }
        }
    }
    return v;
}

/** Reject attacker-controlled event expressions inside `run:` scripts. */
export function checkRunExpressions(f, code, policy) {
    const v = [];
    // Contexts are case-insensitive and `a['b']` equals `a.b`.
    const bad = new RegExp(policy.forbiddenRunExpressions, 'i');
    for (let i = 0; i < code.length; i++) {
        const m = code[i].match(/^(\s*(?:-\s+)?)run\s*:\s*(.*)$/);
        if (!m) continue;
        const indent = m[1].length;
        const body = [m[2]];
        for (let j = i + 1; j < code.length; j++) {
            if (!isBlank(code[j]) && indentOf(code[j]) <= indent) break;
            body.push(code[j]);
        }
        body.forEach((b, k) => {
            for (const e of b.matchAll(/\$\{\{([^}]*)\}\}/g)) {
                const norm = e[1].replace(/\[\s*(['"])(.*?)\1\s*\]/g, '.$2');
                if (bad.test(norm)) {
                    v.push(
                        `${f}:${i + 1 + k}: \${{${e[1]}}} in a run script; pass it through env: and use "$VAR"`,
                    );
                }
            }
        });
    }
    return v;
}

export function checkWorkflows(root, policy, upstreamGlobs, files) {
    const v = [];
    const pin = new RegExp(policy.pinPattern);
    const workflows = files.filter((f) => matchesAny(policy.workflowGlobs, f));

    for (const f of workflows) {
        const forkLocal = !matchesAny(upstreamGlobs, f);
        const code = readText(root, f)
            .split(/\r?\n/)
            .map((l) => l.replace(/(^|\s)#.*$/, ''));

        code.forEach((l, i) => {
            for (const trigger of policy.forbiddenTriggers) {
                if (new RegExp(`\\b${trigger}\\b`).test(l)) {
                    v.push(`${f}:${i + 1}: forbidden trigger ${trigger}`);
                }
            }
            if (/^\s*permissions\s*:\s*write-all\b/.test(l)) {
                v.push(`${f}:${i + 1}: permissions: write-all`);
            }
            if (!forkLocal) return;
            const m = l.match(/\buses\s*:\s*['"]?([^\s'"]+)/);
            if (!m) return;
            const ref = m[1];
            if (ref.startsWith('./') || ref.startsWith('docker://')) return;
            const [name, version = ''] = ref.split('@');
            if (!pin.test(version)) {
                v.push(
                    `${f}:${i + 1}: action ${name} must be pinned to a full commit SHA (found "${version || 'no ref'}")`,
                );
            }
        });

        if (!forkLocal) continue;
        if (policy.requireTopLevelPermissions) {
            v.push(...checkTopLevelPermissions(f, code, policy));
        }
        if (policy.forbiddenRunExpressions) {
            v.push(...checkRunExpressions(f, code, policy));
        }
    }
    return v;
}

// --------------------------------------------------- 3. repo-target policy

/**
 * Split text into logical lines, joining shell continuations (trailing
 * backslash) so a multi-line `gh` command is judged as one command.
 * Returns [{ line, text }] where line is the 1-based first physical line.
 */
export function logicalLines(text) {
    const out = [];
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
        let joined = lines[i];
        const start = i + 1;
        while (/\\\s*$/.test(joined) && i + 1 < lines.length) {
            joined = joined.replace(/\\\s*$/, ' ') + lines[++i].trim();
        }
        out.push({ line: start, text: joined });
    }
    return out;
}

export function checkRepoTarget(root, policy, upstreamGlobs, files) {
    const v = [];
    const literal = policy.requiredLiteral;
    const repoRe = new RegExp(policy.repoFlagPattern);
    const writeRe = new RegExp(policy.writeCommandPattern, 'g');
    const gqlRe = new RegExp(policy.graphqlMutationPattern);

    for (const f of files.filter((x) => matchesAny(policy.directionGlobs, x))) {
        if (!readText(root, f).includes(literal)) {
            v.push(
                `${f}: agent-directions file must contain the literal "${literal}" (PRs and issues go to this repository only)`,
            );
        }
    }

    for (const f of files) {
        if (!matchesAny(policy.scanGlobs, f)) continue;
        if (matchesAny(policy.excludeGlobs, f) || matchesAny(upstreamGlobs, f)) continue;
        for (const { line, text } of logicalLines(readText(root, f))) {
            const cmd = [...text.matchAll(writeRe)][0];
            if (gqlRe.test(text) && !text.includes(literal)) {
                // GraphQL has no --repo flag; the mutation must name the repository.
                v.push(`${f}:${line}: gh api graphql mutation without ${literal} in the command`);
            } else if (cmd && !repoRe.test(text)) {
                v.push(
                    `${f}:${line}: "${cmd[0]}" without ${literal} (a bare gh command targets whatever repository the clone defaults to)`,
                );
            }
        }
    }
    return v;
}

// -------------------------------------------------- 4. fork-patches policy

export function checkForkPatches(root, policy) {
    const v = [];
    for (const r of policy.rules) {
        const file = path.join(root, r.file);
        if (!fs.existsSync(file)) {
            v.push(`${r.file}: missing (${r.id}: ${r.message})`);
            continue;
        }
        const text = fs.readFileSync(file, 'utf8');
        if (!new RegExp(r.mustMatch, 'm').test(text)) {
            v.push(`${r.file}: ${r.id} missing: ${r.message}`);
        }
        if (r.mustNotMatch && new RegExp(r.mustNotMatch, 'm').test(text)) {
            v.push(`${r.file}: ${r.id} reverted: ${r.message}`);
        }
    }
    return v;
}

// ------------------------------------------------------- 5. ruleset policy

export function checkRuleset(root, policy) {
    const v = [];
    const file = policy.file;
    const rs = readJson(root, file, v);
    if (!rs) return v;
    if (rs.enforcement !== 'active') v.push(`${file}: enforcement must be "active"`);
    if (!Array.isArray(rs.bypass_actors) || rs.bypass_actors.length > 0) {
        v.push(`${file}: bypass_actors must be an empty array`);
    }
    if (!rs.conditions?.ref_name?.include?.includes('~DEFAULT_BRANCH')) {
        v.push(`${file}: must target ~DEFAULT_BRANCH`);
    }
    const rules = rs.rules ?? [];
    for (const type of policy.requiredRuleTypes) {
        if (!rules.some((r) => r.type === type)) v.push(`${file}: missing rule "${type}"`);
    }
    const rsc = rules.find((r) => r.type === 'required_status_checks');
    if (rsc) {
        if (rsc.parameters?.strict_required_status_checks_policy !== true) {
            v.push(`${file}: strict_required_status_checks_policy must be true`);
        }
        const checks = rsc.parameters?.required_status_checks ?? [];
        for (const name of policy.requiredChecks) {
            if (!checks.some((c) => c.context === name)) {
                v.push(`${file}: required check "${name}" is missing`);
            }
        }
        for (const c of checks) {
            if (!policy.requiredChecks.includes(c.context)) {
                v.push(`${file}: required check "${c.context}" is not in policies/ruleset.json`);
            }
            if (c.integration_id !== policy.integrationId) {
                v.push(`${file}: check "${c.context}" must have integration_id ${policy.integrationId}`);
            }
        }
    }
    return v;
}

// ------------------------------------------------------ 6. risk-tier drift

export function classify(config, file) {
    let best = null;
    for (const t of config.tiers) {
        if (matchesAny(t.paths, file) && (best === null || t.tier < best.tier)) {
            best = t;
        }
    }
    return best ?? config.tiers.find((t) => t.tier === config.default_tier);
}

const ticks = (s) => [...s.matchAll(/`([^`]+)`/g)].map((m) => m[1]);

export function parseTierTable(markdown) {
    const rows = [];
    for (const raw of markdown.split(/\r?\n/)) {
        if (!/^\|\s*\d+\s*\|/.test(raw)) continue;
        const cells = raw.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
        if (cells.length !== 5) {
            rows.push({ malformed: raw });
            continue;
        }
        rows.push({
            tier: Number(cells[0]),
            name: cells[1],
            paths: ticks(cells[2]),
            commands: ticks(cells[3]),
            review: ticks(cells[4])[0] ?? cells[4],
        });
    }
    return rows;
}

const diff = (a, b) => a.filter((x) => !b.includes(x));

export function checkRiskTiers(config, markdown, files) {
    const v = [];
    const doc = 'docs/risk-tiers.md';
    const json = 'risk-config.json';
    if (!Array.isArray(config.tiers) || config.tiers.length === 0) {
        return [`${json}: "tiers" must be a non-empty array`];
    }
    const nums = config.tiers.map((t) => t.tier);
    if (new Set(nums).size !== nums.length) v.push(`${json}: duplicate tier numbers`);
    if (!nums.includes(config.default_tier)) {
        v.push(`${json}: default_tier ${config.default_tier} is not a defined tier`);
    }
    const pending = config.pending ?? [];
    for (const t of config.tiers) {
        for (const g of t.paths) {
            if (pending.includes(g)) continue;
            if (!files.some((f) => globToRegExp(g).test(f))) {
                v.push(`${json}: tier ${t.tier} path "${g}" matches no file (fix the glob or add it to "pending")`);
            }
        }
    }
    const rows = parseTierTable(markdown);
    for (const r of rows.filter((r) => r.malformed)) {
        v.push(`${doc}: malformed tier row "${r.malformed}" (need 5 columns)`);
    }
    const docRows = rows.filter((r) => !r.malformed);
    for (const t of config.tiers) {
        const row = docRows.find((r) => r.tier === t.tier);
        if (!row) {
            v.push(`${doc}: tier ${t.tier} (${t.name}) is in ${json} but not in the table`);
            continue;
        }
        if (row.name !== t.name) {
            v.push(`${doc}: tier ${t.tier} is named "${row.name}", ${json} says "${t.name}"`);
        }
        const sets = [
            ['paths', row.paths, t.paths],
            ['required commands', row.commands, t.required_commands],
        ];
        for (const [label, d, j] of sets) {
            for (const x of diff(j, d)) {
                v.push(`${doc}: tier ${t.tier} ${label}: "${x}" is in ${json} but not in the table`);
            }
            for (const x of diff(d, j)) {
                v.push(`${doc}: tier ${t.tier} ${label}: "${x}" is in the table but not in ${json}`);
            }
        }
        if (row.review !== t.review) {
            v.push(`${doc}: tier ${t.tier} review is "${row.review}", ${json} says "${t.review}"`);
        }
    }
    for (const r of docRows) {
        if (!nums.includes(r.tier)) v.push(`${doc}: tier ${r.tier} is in the table but not in ${json}`);
    }
    return v;
}

// ------------------------------------------------------------------- main

export function checkAll(root) {
    const violations = [];
    const files = walk(root);

    const upstream = readJson(root, 'policies/upstream-owned.json', violations);
    const upstreamGlobs = upstream?.globs ?? [];

    const keys = readJson(root, 'policies/signing-keys.json', violations);
    if (keys) violations.push(...checkSigningKeys(root, keys, files));

    const wf = readJson(root, 'policies/workflow-permissions.json', violations);
    if (wf) violations.push(...checkWorkflows(root, wf, upstreamGlobs, files));

    const target = readJson(root, 'policies/repo-target.json', violations);
    if (target) violations.push(...checkRepoTarget(root, target, upstreamGlobs, files));

    const patches = readJson(root, 'policies/fork-patches.json', violations);
    if (patches) violations.push(...checkForkPatches(root, patches));

    const ruleset = readJson(root, 'policies/ruleset.json', violations);
    if (ruleset) violations.push(...checkRuleset(root, ruleset));

    const config = readJson(root, 'risk-config.json', violations);
    if (!fs.existsSync(path.join(root, 'docs/risk-tiers.md'))) {
        violations.push('docs/risk-tiers.md: missing');
    } else if (config) {
        violations.push(...checkRiskTiers(config, readText(root, 'docs/risk-tiers.md'), files));
    }
    return violations;
}

function main(argv) {
    const here = path.dirname(fileURLToPath(import.meta.url));
    let root = path.resolve(here, '..');
    const rootIdx = argv.indexOf('--root');
    if (rootIdx !== -1) root = path.resolve(argv[rootIdx + 1]);

    const classifyIdx = argv.indexOf('--classify');
    if (classifyIdx !== -1) {
        const config = JSON.parse(readText(root, 'risk-config.json'));
        for (const p of argv.slice(classifyIdx + 1)) {
            const t = classify(config, p.replace(/^\.\//, ''));
            console.log(`${p}: tier ${t.tier} (${t.name}), review: ${t.review}`);
        }
        return 0;
    }

    const violations = checkAll(root);
    if (violations.length > 0) {
        console.error(`check-policies: ${violations.length} violation(s)`);
        for (const x of violations) console.error(`  ${x}`);
        return 1;
    }
    console.log('check-policies: all policies satisfied');
    return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    process.exit(main(process.argv.slice(2)));
}

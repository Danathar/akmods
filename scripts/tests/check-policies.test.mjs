import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    checkAll,
    checkForkPatches,
    checkRepoTarget,
    checkRiskTiers,
    checkRuleset,
    checkSigningKeys,
    checkWorkflows,
    classify,
    globToRegExp,
    walk,
} from '../check-policies.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const load = (rel) => JSON.parse(fs.readFileSync(path.join(repo, rel), 'utf8'));
const policy = (name) => load(`policies/${name}.json`);
const upstream = policy('upstream-owned').globs;
const PEM = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ');

/** Write { relPath: content } into a fresh temp dir and return it and its file list. */
function tree(files) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-'));
    after(() => fs.rmSync(root, { recursive: true, force: true }));
    for (const [rel, content] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
        fs.writeFileSync(path.join(root, rel), content);
    }
    return { root, files: walk(root) };
}

const GOOD_WF = `name: x
on:
  pull_request:
permissions:
  contents: read
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      - run: echo hi
`;

test('the real repository satisfies every policy', () => {
    assert.deepEqual(checkAll(repo), []);
});

test('globToRegExp: * stays in a directory, ** crosses', () => {
    assert.ok(globToRegExp('certs/*.priv').test('certs/a.priv'));
    assert.ok(!globToRegExp('certs/*.priv').test('certs/x/a.priv'));
    assert.ok(globToRegExp('docs/**').test('docs/a/b.md'));
    assert.ok(!globToRegExp('*.md').test('docs/a.md'));
});

// ------------------------------------------------------------ signing keys

test('signing-keys: 0-byte placeholders and the test keys pass', () => {
    const { root, files } = tree({
        'certs/private_key.priv': '',
        'certs/private_key.priv.test': `${PEM}\nabc\n`,
        'certs/public_key.der': 'x',
        '.github/workflows/reusable-build.yml': 'k: ${{ secrets.KERNEL_PRIVKEY }}\n',
    });
    assert.deepEqual(checkSigningKeys(root, policy('signing-keys'), files), []);
});

test('signing-keys: non-empty certs/*.priv fails', () => {
    const { root, files } = tree({ 'certs/private_key.priv': 'secret' });
    const v = checkSigningKeys(root, policy('signing-keys'), files);
    assert.equal(v.length, 1);
    assert.match(v[0], /0 bytes/);
});

test('signing-keys: private key block in another file fails', () => {
    const { root, files } = tree({ 'notes/key.txt': `${PEM}\nabc\n` });
    const v = checkSigningKeys(root, policy('signing-keys'), files);
    assert.match(v.join('\n'), /private key material/);
});

test('signing-keys: signing secret outside the two reusable workflows fails', () => {
    const { root, files } = tree({
        '.github/workflows/other.yml': 'x: ${{ secrets.SIGNING_SECRET }}\n',
    });
    const v = checkSigningKeys(root, policy('signing-keys'), files);
    assert.match(v.join('\n'), /outside/);
});

// --------------------------------------------------------------- workflows

test('workflows: a clean fork-local workflow passes', () => {
    const { root, files } = tree({ '.github/workflows/ok.yml': GOOD_WF });
    assert.deepEqual(checkWorkflows(root, policy('workflow-permissions'), upstream, files), []);
});

test('workflows: pull_request_target fails (also in upstream-owned files)', () => {
    const { root, files } = tree({
        '.github/workflows/reusable-build.yml': 'on:\n  pull_request_target:\n',
    });
    const v = checkWorkflows(root, policy('workflow-permissions'), upstream, files);
    assert.match(v.join('\n'), /forbidden trigger pull_request_target/);
});

test('workflows: missing top-level permissions fails for fork-local only', () => {
    const body = GOOD_WF.replace('permissions:\n  contents: read\n', '');
    const local = tree({ '.github/workflows/new.yml': body });
    const v = checkWorkflows(local.root, policy('workflow-permissions'), upstream, local.files);
    assert.match(v.join('\n'), /no top-level "permissions:"/);
    const up = tree({ '.github/workflows/reusable-build.yml': body });
    assert.deepEqual(checkWorkflows(up.root, policy('workflow-permissions'), upstream, up.files), []);
});

test('workflows: top-level write and write-all fail', () => {
    const w = tree({
        '.github/workflows/a.yml': GOOD_WF.replace('contents: read', 'contents: write'),
        '.github/workflows/b.yml': GOOD_WF.replace('permissions:\n  contents: read', 'permissions: write-all'),
    });
    const v = checkWorkflows(w.root, policy('workflow-permissions'), upstream, w.files).join('\n');
    assert.match(v, /a\.yml:\d+: top-level permissions grant write/);
    assert.match(v, /b\.yml:\d+: permissions: write-all/);
});

test('workflows: job-level write is allowed', () => {
    const body = GOOD_WF.replace('    runs-on', '    permissions:\n      packages: write\n    runs-on');
    const { root, files } = tree({ '.github/workflows/ok.yml': body });
    assert.deepEqual(checkWorkflows(root, policy('workflow-permissions'), upstream, files), []);
});

test('workflows: unpinned action in a fork-local workflow fails', () => {
    const { root, files } = tree({
        '.github/workflows/new.yml': GOOD_WF.replace(/@[0-9a-f]{40} # v7.0.1/, '@v7'),
    });
    const v = checkWorkflows(root, policy('workflow-permissions'), upstream, files);
    assert.match(v.join('\n'), /must be pinned to a full commit SHA/);
});

test('workflows: event text in a run script fails; env passthrough passes', () => {
    const bad = tree({
        '.github/workflows/new.yml': GOOD_WF.replace('echo hi', 'echo "${{ github.event.issue.title }}"'),
    });
    assert.match(
        checkWorkflows(bad.root, policy('workflow-permissions'), upstream, bad.files).join('\n'),
        /in a run script/,
    );
    const ok = tree({
        '.github/workflows/new.yml': GOOD_WF.replace(
            '      - run: echo hi',
            '      - run: echo "$T"\n        env:\n          T: ${{ github.event.issue.title }}',
        ),
    });
    assert.deepEqual(checkWorkflows(ok.root, policy('workflow-permissions'), upstream, ok.files), []);
});

// ------------------------------------------------------------- repo target

test('repo-target: gh writes with the repo flag pass', () => {
    const { root, files } = tree({
        'docs/a.md': 'Run `gh pr create -R Danathar/akmods --base main`.\n' +
            'gh issue comment 5 \\\n  --repo Danathar/akmods --body x\n' +
            'gh api --method POST repos/Danathar/akmods/rulesets\n' +
            'gh pr view 5\n',
    });
    assert.deepEqual(checkRepoTarget(root, policy('repo-target'), upstream, files), []);
});

test('repo-target: bare, wrong-repo and bare gh api write fail', () => {
    const { root, files } = tree({
        'docs/a.md': 'gh pr create --base main\n' +
            'gh issue comment 5 -R ublue-os/akmods\n' +
            'gh api -X DELETE repos/ublue-os/akmods/x\n',
    });
    assert.equal(checkRepoTarget(root, policy('repo-target'), upstream, files).length, 3);
});

test('repo-target: gh api graphql mutation must name the repository', () => {
    const bad = tree({ 'docs/a.md': "gh api graphql -f query='mutation { x }'\n" });
    assert.equal(checkRepoTarget(bad.root, policy('repo-target'), upstream, bad.files).length, 1);
    const ok = tree({ 'docs/a.md': "gh api graphql -F repo=Danathar/akmods -f query='mutation { x }'\n" });
    assert.deepEqual(checkRepoTarget(ok.root, policy('repo-target'), upstream, ok.files), []);
});

test('repo-target: upstream-owned files and AGENTS.md literal', () => {
    const up = tree({ 'CHANGELOG.md': 'gh pr create\n' });
    assert.deepEqual(checkRepoTarget(up.root, policy('repo-target'), upstream, up.files), []);
    const a = tree({ 'AGENTS.md': 'no repo named\n' });
    assert.match(checkRepoTarget(a.root, policy('repo-target'), upstream, a.files).join('\n'), /Danathar\/akmods/);
    const b = tree({ 'AGENTS.md': 'Danathar/akmods only\n' });
    assert.deepEqual(checkRepoTarget(b.root, policy('repo-target'), upstream, b.files), []);
});

// ------------------------------------------------------------ fork patches

const GOOD_PATCHES = {
    'images.yaml': 'base: &b\n  org: danathar\n',
    Justfile: `akmods_name := env('AKMODS_IMAGE_NAME', shell(yq + ' ".images.$1[\\"$2\\"].$3.name" images.yaml'))\n`,
    'Containerfile.in': '    --mount=type=secret,id=github_token \\\n',
    'build_files/zfs/build-kmod-zfs.sh': 'curl_args+=(-H "Authorization: Bearer ${t}")\n',
    'build_files/prep/build-prep.sh': 'RPMS_TO_INSTALL+=(\n    git\n)\n',
};

test('fork-patches: all patches present passes', () => {
    const { root } = tree(GOOD_PATCHES);
    assert.deepEqual(checkForkPatches(root, policy('fork-patches')), []);
});

test('fork-patches: reverted P1 (org: ublue-os) fails', () => {
    const { root } = tree({ ...GOOD_PATCHES, 'images.yaml': 'base: &b\n  org: ublue-os\n' });
    const v = checkForkPatches(root, policy('fork-patches')).join('\n');
    assert.match(v, /P1 missing/);
    assert.match(v, /P1 reverted/);
});

test('fork-patches: missing P2 name lookup / env override fails', () => {
    const { root } = tree({ ...GOOD_PATCHES, Justfile: 'akmods_name := "x"\n' });
    const v = checkForkPatches(root, policy('fork-patches')).join('\n');
    assert.match(v, /P2-env-override/);
    assert.match(v, /P2-images-yaml-lookup/);
});

test('fork-patches: missing file fails', () => {
    const { root } = tree({});
    assert.equal(checkForkPatches(root, policy('fork-patches')).length, policy('fork-patches').rules.length);
});

// ----------------------------------------------------------------- ruleset

function rulesetTree(mutate) {
    const rs = load('.github/rulesets/main.json');
    mutate(rs);
    return tree({ '.github/rulesets/main.json': JSON.stringify(rs) }).root;
}

test('ruleset: the committed ruleset passes', () => {
    assert.deepEqual(checkRuleset(repo, policy('ruleset')), []);
});

test('ruleset: bypass actor, missing check and wrong integration fail', () => {
    const root = rulesetTree((rs) => {
        rs.bypass_actors.push({ actor_id: 1, actor_type: 'Integration', bypass_mode: 'always' });
        const c = rs.rules.find((r) => r.type === 'required_status_checks').parameters;
        c.required_status_checks = c.required_status_checks.filter((x) => x.context !== 'policy-check');
        c.required_status_checks[0].integration_id = 1;
    });
    const v = checkRuleset(root, policy('ruleset')).join('\n');
    assert.match(v, /bypass_actors/);
    assert.match(v, /"policy-check" is missing/);
    assert.match(v, /integration_id/);
});

test('ruleset: missing non_fast_forward and non-strict fail', () => {
    const root = rulesetTree((rs) => {
        rs.rules = rs.rules.filter((r) => r.type !== 'non_fast_forward');
        rs.rules.find((r) => r.type === 'required_status_checks').parameters.strict_required_status_checks_policy = false;
    });
    const v = checkRuleset(root, policy('ruleset')).join('\n');
    assert.match(v, /non_fast_forward/);
    assert.match(v, /strict_required_status_checks_policy/);
});

// -------------------------------------------------------------- risk tiers

const config = load('risk-config.json');
const doc = fs.readFileSync(path.join(repo, 'docs/risk-tiers.md'), 'utf8');
const repoFiles = walk(repo);

test('risk tiers: real config and doc agree', () => {
    assert.deepEqual(checkRiskTiers(config, doc, repoFiles), []);
});

test('risk tiers: a path only in the config, or only in the doc, fails', () => {
    const cfg = structuredClone(config);
    cfg.tiers[3].paths.push('docs/**/*.txt');
    cfg.pending = [...(cfg.pending ?? []), 'docs/**/*.txt'];
    assert.match(checkRiskTiers(cfg, doc, repoFiles).join('\n'), /in risk-config\.json but not in the table/);
    const edited = doc.replace('`.gitignore`', '`.gitignore`, `extra.txt`');
    assert.match(checkRiskTiers(config, edited, repoFiles).join('\n'), /in the table but not in risk-config\.json/);
});

test('risk tiers: a glob matching no file fails unless pending', () => {
    const cfg = structuredClone(config);
    cfg.tiers[2].paths.push('nonexistent/**');
    assert.match(checkRiskTiers(cfg, doc, repoFiles).join('\n'), /matches no file/);
    // The doc table now differs too; only the "matches no file" rule is under test,
    // and listing it as pending silences exactly that rule.
    cfg.pending = [...(cfg.pending ?? []), 'nonexistent/**'];
    assert.doesNotMatch(checkRiskTiers(cfg, doc, repoFiles).join('\n'), /matches no file/);
});

test('risk tiers: tier name and review drift fail', () => {
    const cfg = structuredClone(config);
    cfg.tiers[0].name = 'severe';
    cfg.tiers[1].review = 'ci';
    const v = checkRiskTiers(cfg, doc, repoFiles).join('\n');
    assert.match(v, /tier 1 is named "critical"/);
    assert.match(v, /tier 2 review is "owner"/);
});

test('classify: most dangerous matching tier wins; unknown is the default tier', () => {
    assert.equal(classify(config, 'certs/public_key.der').tier, 1);
    assert.equal(classify(config, 'Justfile').tier, 2);
    assert.equal(classify(config, 'build_files/prep/build-prep.sh').tier, 2);
    assert.equal(classify(config, 'build_files/zfs/build-kmod-zfs.sh').tier, 2);
    assert.equal(classify(config, 'build_files/common/build-kmod-wl.sh').tier, 3);
    assert.equal(classify(config, 'fetch-kernel.sh').tier, 3);
    assert.equal(classify(config, 'docs/risk-tiers.md').tier, 2);
    assert.equal(classify(config, 'docs/metrics.md').tier, 4);
    assert.equal(classify(config, 'README.md').tier, 4);
    assert.equal(classify(config, 'something/unknown.bin').tier, config.default_tier);
});

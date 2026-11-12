import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import {
    checkAll,
    checkForkPatches,
    checkRepoTarget,
    checkRiskTiers,
    checkRuleset,
    checkSecretArgv,
    checkSigningKeys,
    checkWorkflows,
    classify,
    globToRegExp,
    secretArgvFindings,
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
        'certs/test/KSIGN_TEST_A.key': `${PEM}\nabc\n`,
        'certs/public_key.der': 'x',
        '.github/workflows/reusable-build.yml': 'k: ${{ secrets.KSIGN_20240711 }}\n',
    });
    assert.deepEqual(checkSigningKeys(root, policy('signing-keys'), files), []);
});

test('signing-keys: a production key written next to its certificate fails', () => {
    const { root, files } = tree({ 'certs/production/KSIGN_20240711.key': `${PEM}\nabc\n` });
    const v = checkSigningKeys(root, policy('signing-keys'), files);
    assert.match(v.join('\n'), /private key material/);
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

test('signing-keys: a KSIGN_ production key secret outside the two reusable workflows fails', () => {
    const { root, files } = tree({
        '.github/workflows/other.yml': 'x: ${{ secrets.KSIGN_20240711 }}\n',
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

test('workflows: a trigger named only in a trailing comment passes', () => {
    const { root, files } = tree({
        '.github/workflows/ok.yml': GOOD_WF.replace('  pull_request:', '  pull_request: # not pull_request_target'),
    });
    assert.deepEqual(checkWorkflows(root, policy('workflow-permissions'), upstream, files), []);
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

// ------------------------------------------------------------- secret argv

// The `@login` recipe as it was before #248: the shell expands the token into
// podman's argv, which /proc/<pid>/cmdline shows to every process.
const OLD_LOGIN = '    {{ podman }} login {{ registry }} -u "$REGISTRY_ACTOR"  -p "$REGISTRY_TOKEN"';
const NEW_LOGIN = `    printf '%s' "$REGISTRY_TOKEN" | {{ podman }} login {{ registry }} -u "$REGISTRY_ACTOR" --password-stdin`;

test('secret-argv: the old @login recipe fails (regression for #248)', () => {
    const { root, files } = tree({ Justfile: `# Login to Registry\n@login:\n${OLD_LOGIN}\n` });
    const v = checkSecretArgv(root, policy('secret-argv'), files);
    assert.equal(v.length, 1);
    assert.match(v[0], /^Justfile:3: secret on a command line \(-p "\$REGISTRY_TOKEN"\)/);
});

test('secret-argv: the @login recipe piping the token to --password-stdin passes', () => {
    const { root, files } = tree({ Justfile: `# Login to Registry\n@login:\n${NEW_LOGIN}\n` });
    assert.deepEqual(checkSecretArgv(root, policy('secret-argv'), files), []);
});

test('secret-argv: a secret as a credential flag or in a URL is reported', () => {
    for (const line of [
        OLD_LOGIN,
        'docker login -u me -p ${{ github.token }} ghcr.io',
        'docker login -u me -p${{ secrets.PAT }} ghcr.io',
        'podman login --password "$DB_PASSWORD" quay.io',
        'podman login --password=$REGISTRY_SECRET quay.io',
        'deploy --registry-password "$token" x',
        'skopeo copy --creds "me:$GH_TOKEN" docker://a docker://b',
        'skopeo copy --src-creds=me:${SRC_TOKEN} a b',
        "skopeo copy --dest-creds me:${{ secrets['GHCR_PAT'] }} a b",
        'podman login -u me -p {{ registry_token }} ghcr.io',
        'git push https://x-access-token:$GITHUB_TOKEN@github.com/o/r',
        'git clone "https://oauth2:${{ secrets.GITLAB_TOKEN }}@gitlab.com/o/r"',
        'curl -fsS https://${API_TOKEN}@example.com/x',
    ]) {
        assert.equal(secretArgvFindings(line, policy('secret-argv')).length, 1, line);
    }
});

test('secret-argv: stdin, a file, comments and non-secret values pass', () => {
    for (const line of [
        NEW_LOGIN,
        `printf '%s' "$GH_TOKEN" | podman login ghcr.io -u me --password-stdin`,
        `printf '%s' "\${{ secrets.PAT }}" > "$RUNNER_TEMP/token"`,
        'podman login -u "$REGISTRY_ACTOR" --password-stdin ghcr.io',
        'mkdir -p certs "$RUNNER_TEMP/actionlint"',
        'psql -p "$PGPORT" -U "$PGUSER"',
        'skopeo copy "docker://$IMAGE:$TAG" "dir:$destination"',
        '# never: podman login -p "$REGISTRY_TOKEN"',
    ]) {
        assert.deepEqual(secretArgvFindings(line, policy('secret-argv')), [], line);
    }
});

test('secret-argv: workflow run scripts are checked, env: and continuations included', () => {
    const body = GOOD_WF.replace('      - run: echo hi', [
        '      - run: docker login ghcr.io -u me -p "${{ secrets.REGISTRY_PASSWORD }}"',
        '      - name: multi',
        '        env:',
        '          GH_TOKEN: ${{ github.token }}',
        '        run: |',
        '          skopeo copy \\',
        '            --creds "me:$GH_TOKEN" docker://a docker://b',
        '          git clone "https://x-access-token:${GH_TOKEN}@github.com/o/r"',
        '          podman login --password=$REGISTRY_SECRET quay.io',
        '          deploy --registry-password "$TOKEN" x',
        `          printf '%s' "$GH_TOKEN" | podman login ghcr.io -u me --password-stdin`,
        `          printf '%s' "$GH_TOKEN" > "$RUNNER_TEMP/token"`,
        '          mkdir -p certs',
        '          # never: podman login -p "$GH_TOKEN"',
    ].join('\n'));
    // Upstream-owned workflows are held to this rule too.
    const { root, files } = tree({ '.github/workflows/reusable-build.yml': body });
    const v = checkSecretArgv(root, policy('secret-argv'), files);
    assert.deepEqual(v.map((x) => x.match(/^[^:]+:(\d+):/)[1]).map(Number), [11, 16, 18, 19, 20]);
});

test('secret-argv: the real Justfile and workflows pass', () => {
    assert.deepEqual(checkSecretArgv(repo, policy('secret-argv'), walk(repo)), []);
});

/** Line numbers of the secret-argv findings for one workflow body. */
function secretArgvLines(body) {
    const { root, files } = tree({ '.github/workflows/new.yml': body });
    return checkSecretArgv(root, policy('secret-argv'), files).map((x) => Number(x.match(/^[^:]+:(\d+):/)[1]));
}

test('secret-argv: run-key spellings YAML allows are still read as scripts', () => {
    // GOOD_WF's run step is line 11, so a finding on it reports 11.
    for (const step of [
        '      -   run: podman login -u me -p "$TOKEN"',
        '      - run : podman login -u me -p "$TOKEN"',
    ]) {
        assert.deepEqual(secretArgvLines(GOOD_WF.replace('      - run: echo hi', step)), [11], step);
    }
    // A bare `run:` whose script is the indented plain scalar on the next lines.
    const plain = GOOD_WF.replace('      - run: echo hi', '      - run:\n          podman login -u me -p "$TOKEN"');
    assert.deepEqual(secretArgvLines(plain), [12]);
});

test('secret-argv: a run block reads past blank lines and stops at its own end', () => {
    const body = GOOD_WF.replace('      - run: echo hi', [
        '      - run: |',
        '          echo one',
        '',
        '          podman login -u me -p "$TOKEN"',
        '      - run: echo two',
        '      - run: podman login -u me --password "$TOKEN"',
    ].join('\n'));
    assert.deepEqual(secretArgvLines(body), [14, 16]);
});

test('secret-argv: only a trailing backslash continues a line, and the halves keep a space', () => {
    const body = GOOD_WF.replace('      - run: echo hi', [
        '      - run: |',
        "          printf 'logging in\\n'",
        '          podman login -u me -p "$TOKEN"',
        "          echo 'a\\b'; podman login ghcr.io -u me\\",
        '            -p "$TOKEN"',
        '          podman login ghcr.io -u me \\',
    ].join('\n')).trimEnd();
    // The file's last line ends in a backslash with nothing after it: no crash.
    assert.deepEqual(secretArgvLines(body), [13, 14]);
});

test('secret-argv: a trailing comment does not hide the command before it', () => {
    assert.equal(secretArgvFindings('podman login -u me -p "$TOKEN" # TODO stdin', policy('secret-argv')).length, 1);
});

test('secret-argv: each finding names what leaked and how to pass it instead', () => {
    const { root, files } = tree({
        Justfile: '@push:\n    git push https://x:$GITHUB_TOKEN@github.com/o/r\n',
    });
    const v = checkSecretArgv(root, policy('secret-argv'), files);
    assert.equal(v.length, 1);
    assert.match(v[0], /^Justfile:2: secret on a command line \(:\$GITHUB_TOKEN@ in a URL\); pass it on stdin .*--password-stdin/);
});

test('secret-argv: files that are neither a Justfile nor a workflow are not scanned', () => {
    const { root, files } = tree({
        'docs/example.md': '    - run: podman login -u me -p "$REGISTRY_TOKEN"\n',
    });
    assert.deepEqual(checkSecretArgv(root, policy('secret-argv'), files), []);
});

test('secret-argv: checkAll runs the rule, and reports a missing policy file without crashing', () => {
    const justfile = `# Login to Registry\n@login:\n${OLD_LOGIN}\n`;
    const policyText = fs.readFileSync(path.join(repo, 'policies/secret-argv.json'), 'utf8');
    const on = tree({ Justfile: justfile, 'policies/secret-argv.json': policyText });
    assert.match(checkAll(on.root).join('\n'), /Justfile:3: secret on a command line/);
    const off = tree({ Justfile: justfile });
    const v = checkAll(off.root);
    assert.ok(v.includes('policies/secret-argv.json: missing'), v.join('\n'));
    assert.doesNotMatch(v.join('\n'), /secret on a command line/);
});

// ------------------------------------------------------------ fork patches

const GOOD_PATCHES = {
    'images.yaml': 'base: &b\n  org: danathar\n',
    Justfile: `akmods_name := env('AKMODS_IMAGE_NAME', shell(yq + ' ".images.$1[\\"$2\\"].$3.name" images.yaml'))\n`,
    'build_files/prep/build-prep.sh': 'RPMS_TO_INSTALL+=(\n    git\n)\n',
    'build_files/zfs/build-kmod-zfs.sh': 'gpg --batch --import /tmp/openzfs-release-keys.asc\n',
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

test('fork-patches: a short key ID for the OpenZFS keys fails (T7)', () => {
    for (const line of ['--recv D4598027', '--recv-keys 0xD4598027', '--recv-keys d4598027 # T']) {
        const { root } = tree({ ...GOOD_PATCHES, 'build_files/zfs/build-kmod-zfs.sh': `gpg --keyserver k ${line}\n` });
        const v = checkForkPatches(root, policy('fork-patches')).join('\n');
        assert.match(v, /T7-zfs-key-fingerprints missing/, line);
        assert.match(v, /T7-zfs-key-fingerprints reverted/, line);
    }
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

// ------------------------------------------------ shared regression corpus
//
// policies/check-policies-corpus.json is the one table every copy of this
// checker in the fleet shares (dns-failover, akmods, openaudible-autoupdate,
// tududi, appbox). Each row is a workflow and the run-expression violations
// the checker has to report for it, so a bypass fixed in one copy becomes a
// row, and every copy without the fix fails here (Danathar/akmods#245). The
// canonical copy lives in Danathar/dns-failover, so the file is pinned by hash
// and never edited here; the nightly job compares it with that copy on main.

const CORPUS_FILE = '.github/workflows/check-policies-corpus.yml';
const CORPUS_SHA256 = '7e21db1330eaa6e2ffa0173c7e673cc4f1107fbf2c5a51a254c6f0660506b8df';
const corpusRaw = fs.readFileSync(path.join(repo, 'policies/check-policies-corpus.json'));
const corpus = JSON.parse(corpusRaw.toString('utf8'));

/** The run-expression violations checkWorkflows reports for one corpus workflow. */
function corpusFindings(workflow) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-policies-corpus-'));
    try {
        const file = path.join(dir, CORPUS_FILE);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, `${workflow.join('\n')}\n`);
        return checkWorkflows(dir, policy('workflow-permissions'), upstream, [CORPUS_FILE])
            .map((v) => v.match(/^(.+?):(\d+): \$\{\{\s*(.*?)\s*\}\} in a run script/))
            .filter((m) => m && m[1] === CORPUS_FILE)
            .map((m) => ({ line: Number(m[2]), expression: m[3] }));
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

test('corpus: the file is the dns-failover copy', () => {
    assert.equal(createHash('sha256').update(corpusRaw).digest('hex'), CORPUS_SHA256,
        'policies/check-policies-corpus.json differs from the pinned copy; change it in Danathar/dns-failover and copy it again');
});

test('corpus: every row is well formed and has a unique id', () => {
    assert.equal(corpus.schema, 1);
    assert.ok(corpus.rows.length > 0);
    const ids = new Set();
    for (const row of corpus.rows) {
        assert.match(row.id, /^[a-z0-9-]+$/);
        assert.ok(!ids.has(row.id), `duplicate corpus id ${row.id}`);
        ids.add(row.id);
        assert.equal(typeof row.why, 'string', `${row.id}: why`);
        assert.ok(row.workflow.every((l) => typeof l === 'string'), `${row.id}: workflow`);
        for (const v of row.violations) {
            assert.ok(Number.isInteger(v.line) && v.line >= 1 && v.line <= row.workflow.length, `${row.id}: line`);
            assert.ok(row.workflow[v.line - 1].includes(v.expression), `${row.id}: line ${v.line} names ${v.expression}`);
        }
    }
});

for (const row of corpus.rows) {
    test(`corpus ${row.id}`, () => {
        assert.deepEqual(corpusFindings(row.workflow), row.violations, `${row.id}: ${row.why}`);
    });
}

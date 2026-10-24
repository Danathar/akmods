// StrykerJS configuration for the advisory mutation check on changed lines
// (#192). scripts/mutation-check.mjs runs Stryker once per test command,
// setting MUTATION_TEST_COMMAND and MUTATION_REPORT and passing the changed
// line ranges with `--mutate`. The defaults below are only for a hand run
// (`stryker run stryker.config.mjs`), which mutates the whole guard hook and
// its reader and takes hours. Stryker is not a dependency of this repository;
// see docs/quality.md for how CI installs it.
//
// The default command never includes scripts/tests/shell-reader.test.mjs: it
// pins the reader's sha256, so it fails for every mutant and would count each
// one as killed.

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
    // Built into @stryker-mutator/core: no test-framework plugin, and the
    // tests stay plain `node --test` files.
    testRunner: 'command',
    commandRunner: {
        command:
            process.env.MUTATION_TEST_COMMAND ??
            'node --test .claude/hooks/tests/guard-bash.test.mjs scripts/tests/gate-refusal-corpus.test.mjs',
    },
    // The command runner cannot tell which test covers which mutant.
    coverageAnalysis: 'off',
    mutate: ['.claude/hooks/*.mjs'],
    // The guard tests take about 19 s per run and run once per mutant.
    concurrency: 4,
    timeoutMS: 60000,
    ignorePatterns: ['/build', '/reports'],
    reporters: ['clear-text', 'progress', 'json'],
    jsonReporter: { fileName: process.env.MUTATION_REPORT ?? 'reports/mutation/mutation.json' },
    // mutation-check.mjs decides the result from the report and the survivors
    // ledger, so Stryker's own score threshold never fails the run.
    thresholds: { high: 80, low: 60, break: null },
    tempDirName: '.stryker-tmp',
    cleanTempDir: true,
};

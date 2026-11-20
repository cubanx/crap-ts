# crap-ts

Small CRAP-score audit helper for TypeScript projects.

`crap-ts` computes CRAP scores from TypeScript cyclomatic complexity plus
Istanbul/V8 coverage data.

CRAP stands for **Change Risk Anti-Patterns**, from Alberto Savoia and Bob
Evans' work on combining cyclomatic complexity with test coverage. Savoia
explains the metric in Google's testing blog post, ["This Code is
CRAP"](https://testing.googleblog.com/2011/02/this-code-is-crap.html), and the
old [Crap4J FAQ](https://www.crap4j.org/faq.html) uses the same expansion.
Risky code plus weak tests, now with a name your manager will remember.

## Works Out Of The Box With

- TypeScript source files (`.ts`, `.tsx`, `.mts`, `.cts`)
- Istanbul-format `coverage-final.json` with statement and function maps:
  Vitest (V8 or Istanbul provider), Jest, nyc/Istanbul
- Consumer-provided TypeScript versions `>=5.9 <8`, including TypeScript 7
- npm, Bun, pnpm, or any runner that can produce coverage before `crap-ts` reads
  it

No Biome required. No framework plugin. Bring coverage JSON, get CRAP. Very
glamorous work, obviously.

## Install

```sh
npm install --save-dev crap-ts
```

`crap-ts` uses your project's installed TypeScript peer dependency, so
TypeScript 7 projects do not get a nested TypeScript 5.x install.

## Usage

```sh
npx crap-ts score --coverage-command "npm run test:coverage -- --coverage.reporter=json" --coverage-file coverage/unit/coverage-final.json --include src/ --exclude .test.ts
```

Add package scripts:

```json
{
  "scripts": {
    "check:crap": "crap-ts score --report-only",
    "check:crap:strict": "crap-ts score"
  }
}
```

`check:crap` is useful while calibrating. `check:crap:strict` is the gate.

Put the long bits in `.crap-ts.json`:

```json
{
  "coverageCommand": "npm run test:coverage -- --coverage.reporter=json",
  "coverageFile": "coverage/unit/coverage-final.json",
  "include": ["src/"],
  "exclude": [".test.ts"],
  "max": 30,
  "warn": 25
}
```

`warn` gives you an early heads-up: functions above 25 are flagged `WARN` and
reported on stderr, but only scores above `max` fail the build. Leave it out to
skip warnings.

In CI, keep the machine-readable report even when the gate fails:

```sh
npx crap-ts score --json > crap-report.json
```

The report is printed in full before `crap-ts` exits non-zero, and the coverage
command's own output is sent to stderr so stdout stays valid JSON.

## How Scoring Works

```text
crap = complexity^2 * (1 - coverage)^3 + complexity
```

Scores are compared unrounded: with `max` 30, a score of exactly 30 passes and
30.01 fails.

### Source inventory

`crap-ts score` walks the working directory for `.ts`, `.tsx`, `.mts` and
`.cts` files, skipping `node_modules`, directories whose name starts with `.`,
symbolic links and `.d.ts` declarations. `include` and `exclude` filter that
inventory by path substring (relative to the working directory, `/`
separators). Files named in the coverage JSON that pass the same filters are
analyzed too, even when their extension is not in the list above.

An inventoried file with no coverage entry **fails the gate** if it contains a
function body or an executable module-level statement. Declaration-only files
are exempt: type aliases, interfaces, `declare` statements, re-exports
(`export … from`), binding imports (`import { x } from`) and namespaces that
hold only those. A side-effect import (`import "./setup"`) counts as
executable. The functions in such a file
are still listed, with `evidence: "missing"`.

Use `exclude` for tests, fixtures and tooling that your coverage run does not
instrument.

### Coverage

Coverage is per function, from Istanbul statement counters:

- A statement belongs to the innermost function whose source range contains
  the statement's start position. Nested functions and callbacks get their own
  rows and never count toward their parent. A statement that starts exactly at
  a function's first token, such as Istanbul's initializer counter for
  `const f = () => …`, belongs to the enclosing scope: it runs when the
  enclosing code does, not when the function is called.
- `coverage` = executed owned statements / owned statements. Only positive
  counters count as executed.
- A function with no owned statements (for example `() => {}`) uses its own
  Istanbul function counter instead (`evidence: "function"`): 100% if it ran,
  0% if not. A counter inside the function is preferred; one placed exactly
  at the function's first token (as per-line V8 converters do) is used when
  there is none inside.
- A function with no counter at all is reported at 0% with
  `evidence: "missing"` and **fails the gate**: its file has no coverage
  entry, or the function was added after coverage ran.
- The exception is code under a coverage ignore comment, which coverage tools
  leave without counters on purpose. Such a function is listed with
  `evidence: "ignored"` and level `ignored`, never fails or warns, and sorts
  after every other row. Its `coverage` (0) and `crap` are shown for
  reference only. crap-ts recognises `istanbul`, `v8` and `c8` comments
  (block or line):
  - `ignore next` covers the next statement or declaration, including any
    functions inside it.
  - `ignore next N` covers the next N lines.
  - `ignore start` … `ignore stop` covers the region between them.
  - `ignore file` covers the whole file, which then needs no coverage entry.

  An ignore comment only exempts a function that has no counters. If the
  coverage tool still measured it, its counters are used.
- Module-level statements belong to no function.

Pass `--coverage-file` more than once (or a `coverageFile` array) to merge
runs, such as Node and browser suites. Entries for the same file are merged by
each counter's original source position, never by counter id or by averaging
percentages.

`crap-ts` refuses coverage whose statements start outside the current source
(a line that does not exist, or a column past the end of the line): re-run
coverage after changing the source. This is a cheap staleness guard, not a
content hash; edits that keep every statement position valid are not detected.
Malformed coverage (a top-level value that is not an object, missing maps,
negative or non-integer counters, invalid or reversed positions) is an error,
not a silent zero.

V8-based coverage (for example Vitest's default provider) reports one
statement per line, so a function's coverage is line-granular there. Use the
Istanbul provider when you need statement precision.

### Complexity

Each function starts at 1 and adds 1 for each:

- `if` (an `else if` is another `if`)
- ternary `?:`
- `for`, `for…in`, `for…of`, `while`, `do…while`
- `catch`
- `case` in a `switch` (`default` does not count)
- `&&`, `||`, `??`
- logical assignment `&&=`, `||=`, `??=`
- default values: parameters (`a = 1`), destructuring in declarations and
  parameters (`const { a = 1 } = x`, `[a = 1]`), and shorthand defaults in
  assignment patterns (`({ a = 1 } = x)`)

These add nothing: `else`, `finally`, `default:`, optional chaining (`?.`),
early `return`/`break`/`continue`, JSX, and anything at the type level (type
annotations, conditional types). Decisions inside a nested function count only
toward that nested function.

Functions are declarations, function expressions, arrow functions, methods,
constructors, getters and setters that have a body. Overload signatures and
abstract methods have no body and no row. Unnamed functions are reported as
`<anonymous>`; their file, line and column identify them.

### Rows and thresholds

`minLines` (default 10) hides functions shorter than that many lines from both
reports and the gate. A function fails when its score is above `max` or its
evidence is `missing`. Functions with evidence `ignored` never fail or warn.

When the CRAP check flags a hotspot:

1. Name the affected function or file in the review.
2. Confirm there is direct test coverage for that path.
3. Add or tighten tests if behavior is unclear.
4. Refactor only after the expected behavior is pinned down.

The point is not to chase a number for sport. The point is to make hard-to-read
branching visible before it becomes a maintenance tax.

## CLI

```sh
crap-ts score [options]
crap-ts help
```

`score` is required: running `crap-ts` with options but no command is a usage
error.

- `--config <path>`: read config from a JSON file. Defaults to `.crap-ts.json`
  when present.
- `--coverage-file <path>`: Istanbul `coverage-final.json`. Repeat to merge
  several runs. Defaults to `coverage/unit/coverage-final.json`.
- `--coverage-command <cmd>`: run a coverage command before scoring.
- `--include <text>`: only analyze source files whose path contains this text.
  Repeatable.
- `--exclude <text>`: skip source files whose path contains this text.
  Repeatable.
- `--json`: print the JSON report instead of the text report.
- `--all`: print every analyzed function instead of applying `--limit`.
- `--limit <n>`: number of text report rows to print. Defaults to `20`.
- `--max <n>`: fail when any score is above this. Defaults to `30`.
- `--warn <n>`: warn, without failing, when a score is above this. Must not
  exceed `--max`. Off by default.
- `--min-lines <n>`: ignore functions shorter than this. Defaults to `10`.
- `--report-only`: print results without failing on the gate.
- `--skip-coverage`: do not run the coverage command.

Exit codes: `0` passed (or `--report-only`), `1` gate failed, coverage
command failed, or coverage input is missing, malformed or stale, `2` usage or
config error (unknown
command or flag, invalid value, unreadable or invalid config file).

When the coverage command fails, `crap-ts` exits `1` before scoring and
prints no report, not even with `--json`.

The text report is for people and may change in any release. Parse `--json`
instead.

## Configuration

`.crap-ts.json` (or the file passed to `--config`) is a JSON object with these
keys. Unknown keys are an error, so a typo or a removed option never fails
silently. CLI flags override config. Naturally. The command line gets the last
word, because you'd be mad at me if it didn't, and I'd also be mad at me.

| Key | Type | CLI flag | Default |
| --- | --- | --- | --- |
| `coverageCommand` | string | `--coverage-command` | none |
| `coverageFile` | string or string[] | `--coverage-file` | `coverage/unit/coverage-final.json` |
| `include` | string or string[] | `--include` | everything |
| `exclude` | string or string[] | `--exclude` | nothing |
| `json` | boolean | `--json` | `false` |
| `all` | boolean | `--all` | `false` |
| `limit` | number | `--limit` | `20` |
| `max` | number | `--max` | `30` |
| `warn` | number | `--warn` | none |
| `minLines` | number | `--min-lines` | `10` |
| `reportOnly` | boolean | `--report-only` | `false` |
| `skipCoverage` | boolean | `--skip-coverage` | `false` |

## JSON Report

`crap-ts score --json` prints one JSON document to stdout. Schema version `1`
is stable for crap-ts 1.x: fields are only added, never renamed, removed or
changed in meaning. A breaking change bumps `schemaVersion`.

```json
{
  "schemaVersion": 1,
  "thresholds": { "max": 30, "warn": 25, "minLines": 10 },
  "summary": {
    "files": 28,
    "functions": 126,
    "aboveMax": 0,
    "warning": 2,
    "missingEvidence": 0,
    "ignored": 0,
    "missingFiles": 0,
    "passed": true
  },
  "functions": [
    {
      "file": "src/station/docking.ts",
      "name": "assignDockingPort",
      "line": 12,
      "column": 8,
      "endLine": 41,
      "lines": 30,
      "complexity": 6,
      "coverage": 87.5,
      "statements": 16,
      "coveredStatements": 14,
      "evidence": "statements",
      "crap": 6.0703125,
      "level": "ok"
    }
  ],
  "missingFiles": []
}
```

- `thresholds.warn` is `null` when no warn threshold is set.
- `summary.files`: source files analyzed. `functions`: rows listed.
  `aboveMax`: rows with `crap > max`, not counting `ignored` rows. `warning`: rows with level `warn`.
  `missingEvidence`: rows with evidence `missing`. `ignored`: rows with
  evidence `ignored`. `missingFiles`: length of `missingFiles`.
- `summary.passed` is the gate verdict, `aboveMax`, `missingEvidence` and
  `missingFiles` all zero, and ignores `--report-only`.
- `functions` lists every function at or above `minLines`, never truncated by
  `--limit`, sorted by `crap` descending, then `file`, `line`, `column`, with
  `ignored` rows after all others.
- `file` is relative to the working directory with `/` separators. `line` and
  `column` are one-based and point at the function's first token.
- `coverage` is a percentage from 0 to 100. `crap` and `coverage` are
  unrounded.
- `evidence` is `statements`, `function`, `ignored` or `missing` (see
  [Coverage](#coverage)).
- `level` is `fail` (above `max`, or missing evidence), `warn` (above `warn`),
  `ignored` (evidence `ignored`) or `ok`. For `ignored` rows, `coverage` is 0
  and `crap` is the score at 0% coverage, for reference only.
- `missingFiles` lists inventoried files with executable code and no coverage
  entry, sorted.

## Programmatic API

The package root is the only entry point. These exports, and the types in
`src/index.d.ts`, are the 1.x API:

- `runCrapAudit(options?: CrapAuditOptions): Promise<number>` runs the same
  audit as the CLI and resolves to its exit code (`2` for invalid options,
  `1` for a failed gate or missing coverage file). It rejects with an `Error`
  when coverage or source input is malformed or stale. Options mirror the config
  keys: `coverageCommand`, `coveragePaths`, `cwd`, `includes`, `excludes`,
  `json`, `all`, `limit`, `maxScore`, `warnScore`, `minLines`, `reportOnly`,
  `skipCoverage`.
- `analyzeFileRisk({ filePath, sourceText, coverage?, minLines?, sourceFilePath? }): Promise<FunctionRisk[]>`
  scores the functions in one source text. `coverage` is that file's entry
  from `coverage-final.json`; without it every row has `evidence: "missing"`.
  `minLines` defaults to 1.
- `calculateCyclomaticComplexity(node): number` applies the complexity rules
  above to a TypeScript AST node from the consumer's `typescript` package.
- `calculateCrapScore({ complexity, coverage }): number` is the formula, with
  `coverage` as a percentage from 0 to 100.

Everything else under `src/` is internal and may change in any release.

## Upgrading From 0.x

1.0 changes scores and removes an unused mode. Expect different numbers.

- Coverage is now owned-statement coverage per function, not the 0/100
  function-called flag. Partially tested functions score lower; a function
  whose callback never runs no longer looks covered.
- Nested functions no longer add their decisions to the parent. Parameter and
  destructuring defaults and logical assignment now add decisions.
  Constructors, getters and setters now get rows.
- Source files without coverage entries, and functions without any coverage
  counter, now fail the gate, unless a coverage ignore comment covers them. Add `exclude` entries for tests and tooling
  (for example `"exclude": [".test.ts", "vitest.config"]`) if your `include`
  matches them.
- `--metrics`, `--max-crap`, the `metrics` and `maxCrap` config keys, and
  running without the `score` command are gone, along with the
  `buildCrapScores` and `getCoverageForFile` exports.
- The `crap-ts/crap-analysis`, `crap-ts/crap-runner` and `crap-ts/crap-score`
  subpath exports are gone; import from `crap-ts`. `extractCoverageFunctions`
  and `formatRiskLine` are no longer exported, and `analyzeFileRisk` takes an
  Istanbul `coverage` entry instead of `coverageFunctions`.
- `CrapAuditOptions.coveragePath` is now `coveragePaths` (an array).
- Unknown `.crap-ts.json` keys are an error.

## Replacing Local CRAP Scripts

For a Bun/Vitest app that already writes coverage to `coverage/unit`, local
scripts can usually shrink to:

```json
{
  "scripts": {
    "check:crap": "crap-ts score --report-only",
    "check:crap:strict": "crap-ts score"
  }
}
```

With `.crap-ts.json`:

```json
{
  "coverageCommand": "bun x vitest run --coverage --coverage.reporter=json",
  "coverageFile": "coverage/unit/coverage-final.json",
  "include": ["app/", "scripts/"],
  "exclude": [".test.ts"]
}
```

After that, repo-local CRAP analyzer scripts and tests can be deleted. Keep the
project's coverage test config; that remains the source of truth for coverage
instrumentation.

## Contributing

Pull requests are welcome. Keep them focused, add tests when behavior changes,
and see [CONTRIBUTING.md](CONTRIBUTING.md) sullying my code ;)

## License

MIT

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

- TypeScript source files listed in an Istanbul-style `coverage-final.json`
- Consumer-provided TypeScript versions `>=5.9 <8`, including TypeScript 7
- Vitest V8 coverage, Jest coverage, or nyc/Istanbul coverage that includes
  function maps
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

Run the built-in TypeScript AST audit against coverage-final data:

```sh
npx crap-ts score --coverage-command "npm run test:coverage -- --coverage.reporter=json" --coverage-file coverage/unit/coverage-final.json --include src
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
  "coverageCommand": "npm run test:coverage -- --coverage.reporter=json --coverage.reporter=json-summary",
  "coverageFile": "coverage/unit/coverage-final.json",
  "include": ["src"],
  "max": 30,
  "minLines": 10,
  "limit": 20
}
```

You can also compute CRAP scores from an external metrics file and coverage
summary:

```sh
npx crap-ts --metrics fixtures/complexity-metrics.json --coverage-file fixtures/coverage-summary.json
```

## Workflow

The direct CRAP audit:

- reads function coverage from Istanbul/V8 `coverage-final.json`
- calculates function cyclomatic complexity from the TypeScript AST
- prints the highest-risk functions
- fails strict mode when any score is above the configured threshold

CRAP combines complexity and coverage:

```text
crap = complexity^2 * (1 - coverage)^3 + complexity
```

For direct audits, `coverage` is function coverage from `coverage-final.json`.
For metrics-file scoring, `coverage` is read from an Istanbul-style
`coverage-summary.json` file.

When the complexity or CRAP check flags a hotspot:

1. Name the affected function or file in the review.
2. Confirm there is direct test coverage for that path.
3. Add or tighten tests if behavior is unclear.
4. Refactor only after the expected behavior is pinned down.

The point is not to chase a number for sport. The point is to make hard-to-read
branching visible before it becomes a maintenance tax.

## CLI

```sh
crap-ts score [--coverage-file coverage/unit/coverage-final.json] [--coverage-command "npm run test:coverage"]
crap-ts --metrics complexity-metrics.json --coverage-file coverage/coverage-summary.json
```

Options:

- `--config <path>`: read config from a JSON file. Defaults to `.crap-ts.json`
  when present.
- `--coverage-file <path>`: read coverage from a coverage JSON file.
- `--coverage-command <cmd>`: run a coverage command before scoring.
- `--all`: print every analyzed function instead of applying `--limit`.
- `--include <text>`: only analyze coverage files whose path contains this text.
- `--limit <n>`: number of report rows to print. Defaults to `20`.
- `--max <n>`: strict CRAP threshold for direct audit. Defaults to `30`.
- `--min-lines <n>`: ignore functions shorter than this. Defaults to `10`.
- `--metrics <path>`: read complexity metrics from JSON.
- `--report-only`: print CRAP results without failing on threshold.
- `--skip-coverage`: use an existing coverage file.

Metrics files use this shape:

```json
[
  {
    "file": "src/example.ts",
    "name": "chooseValue",
    "complexity": 12
  }
]
```

Config files use camelCase keys:

```json
{
  "coverageCommand": "npm run test:coverage",
  "coverageFile": "coverage/unit/coverage-final.json",
  "include": ["src"],
  "all": false,
  "limit": 20,
  "max": 30,
  "minLines": 10,
  "reportOnly": false,
  "skipCoverage": false
}
```

CLI flags override config. Naturally. The command line gets the last word,
because you'd be mad at me if it didn't, and I'd also be mad at me.

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
  "coverageCommand": "bun x vitest run --coverage --coverage.reporter=json --coverage.reporter=json-summary",
  "coverageFile": "coverage/unit/coverage-final.json",
  "include": ["/app/", "/scripts/"]
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

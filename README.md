# crap-ts

Small CRAP-score audit helper for TypeScript projects.

`crap-ts` computes CRAP scores from TypeScript cyclomatic complexity plus
Istanbul/V8 coverage data.

## Install

```powershell
npm install --save-dev crap-ts
```

## Usage

Run the built-in TypeScript AST audit against coverage-final data:

```powershell
npx crap-ts score --coverage-command "npm run test:coverage -- --coverage.reporter=json" --coverage-file coverage/unit/coverage-final.json --include src
```

Add package scripts:

```json
{
  "scripts": {
    "check:crap": "crap-ts score --report-only --coverage-command \"npm run test:coverage -- --coverage.reporter=json --coverage.reporter=json-summary\" --coverage-file coverage/unit/coverage-final.json --include src",
    "check:crap:strict": "crap-ts score --coverage-command \"npm run test:coverage -- --coverage.reporter=json --coverage.reporter=json-summary\" --coverage-file coverage/unit/coverage-final.json --include src"
  }
}
```

`check:crap` is useful while calibrating. `check:crap:strict` is the gate.

You can also compute CRAP scores from an external metrics file and coverage
summary:

```powershell
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

```powershell
crap-ts score [--coverage-file coverage/unit/coverage-final.json] [--coverage-command "npm run test:coverage"]
crap-ts --metrics complexity-metrics.json --coverage-file coverage/coverage-summary.json
```

Options:

- `--coverage-file <path>`: read coverage from a coverage JSON file.
- `--coverage-command <cmd>`: run a coverage command before scoring.
- `--all`: print every analyzed function instead of applying `--limit`.
- `--include <text>`: only analyze coverage files whose path contains this text.
- `--limit <n>`: number of report rows to print. Defaults to `20`.
- `--max <n>`: strict CRAP threshold for direct audit. Defaults to `30`.
- `--min-lines <n>`: ignore functions shorter than this. Defaults to `10`.
- `--metrics <path>`: read complexity metrics from JSON.
- `--json`: print the resolved command before running it.
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

## Replacing Local CRAP Scripts

For a Bun/Vitest app that already writes coverage to `coverage/unit`, local
scripts can usually shrink to:

```json
{
  "scripts": {
    "check:crap": "crap-ts score --report-only --coverage-command \"bun x vitest run --coverage --coverage.reporter=json --coverage.reporter=json-summary\" --coverage-file coverage/unit/coverage-final.json --include /app/ --include /scripts/",
    "check:crap:strict": "crap-ts score --coverage-command \"bun x vitest run --coverage --coverage.reporter=json --coverage.reporter=json-summary\" --coverage-file coverage/unit/coverage-final.json --include /app/ --include /scripts/"
  }
}
```

After that, repo-local CRAP analyzer scripts and tests can be deleted. Keep the
project's coverage test config; that remains the source of truth for coverage
instrumentation.

## License

This repository includes a placeholder license file. Choose the final license
before publishing.

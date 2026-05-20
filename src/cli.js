#!/usr/bin/env node

import { readFileSync, realpathSync } from "node:fs";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

import { runCrapAudit } from "./crap-runner.js";
import { buildCrapScores } from "./crap-score.js";

const helpText = `crap-ts

Run a focused TypeScript quality audit.

Usage:
  crap-ts score [--coverage-file coverage/unit/coverage-final.json] [--coverage-command "npm run test:coverage"]
  crap-ts score --metrics complexity-metrics.json --coverage-file coverage/coverage-summary.json [--max-crap 30]

Legacy:
  crap-ts --metrics complexity-metrics.json --coverage-file coverage/coverage-summary.json

Options:
  --coverage-file <path>
                    Istanbul coverage JSON path.
  --coverage-command <cmd>
                    Command to generate coverage before scoring.
  --all            Print every analyzed function instead of applying --limit.
  --include <text> Only analyze coverage files whose path contains this text.
  --limit <n>      Number of rows to print for direct CRAP audit. Defaults to 20.
  --metrics <path>  JSON file with [{ "file", "name", "complexity" }] entries.
  --min-lines <n>  Ignore functions shorter than this. Defaults to 10.
  --max <n>        Fail direct CRAP audit when any row is above this score. Defaults to 30.
  --max-crap <n>    Fail CRAP scoring when any row is above this score.
  --report-only    Print CRAP report without failing on threshold.
  --skip-coverage  Do not run the coverage command.
  --json           Print the resolved command before running it.
  --help           Show this help.
`;

export function parseCliArgs(argv) {
  const command = getCommand(argv);
  const args = command === "legacy" ? argv : argv.slice(1);
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      all: { type: "boolean" },
      "coverage-file": { type: "string" },
      "coverage-command": { type: "string" },
      help: { type: "boolean", short: "h" },
      include: { type: "string", multiple: true },
      json: { type: "boolean" },
      limit: { type: "string" },
      max: { type: "string" },
      "max-crap": { type: "string" },
      metrics: { type: "string" },
      "min-lines": { type: "string" },
      "report-only": { type: "boolean" },
      "skip-coverage": { type: "boolean" },
    },
  });

  return {
    command,
    all: values.all ?? false,
    coverageCommand: values["coverage-command"],
    coveragePath: values["coverage-file"],
    help: values.help ?? false,
    includes: values.include ?? [],
    json: values.json ?? false,
    limit: parseOptionalNumber(values.limit, "--limit"),
    maxCrap: parseOptionalNumber(values["max-crap"], "--max-crap"),
    maxScore: parseOptionalNumber(values.max, "--max"),
    metricsPath: values.metrics,
    minLines: parseOptionalNumber(values["min-lines"], "--min-lines"),
    paths: positionals,
    reportOnly: values["report-only"] ?? false,
    skipCoverage: values["skip-coverage"] ?? false,
  };
}

export function main(argv = process.argv.slice(2)) {
  const options = parseCliArgs(argv);

  if (options.help) {
    console.log(helpText);
    return 0;
  }

  if (options.command === "score" || options.metricsPath || options.coveragePath) {
    return runScore(options);
  }

  if (options.command !== "legacy") {
    console.error(`Unknown command: ${options.command}`);
    return 2;
  }

  console.error("Usage error: run `crap-ts score --help` for supported commands.");
  return 2;
}

function runScore(options) {
  if (!options.metricsPath) {
    return runCrapAudit({
      coverageCommand: options.coverageCommand,
      coveragePath: options.coveragePath,
      all: options.all,
      includes: options.includes,
      limit: options.limit,
      maxScore: options.maxScore,
      minLines: options.minLines,
      reportOnly: options.reportOnly,
      skipCoverage: options.skipCoverage,
    });
  }

  if (!options.metricsPath || !options.coveragePath) {
    console.error("CRAP scoring requires both --metrics and --coverage.");
    return 2;
  }

  const metrics = JSON.parse(readFileSync(options.metricsPath, "utf8"));
  const coverageSummary = JSON.parse(readFileSync(options.coveragePath, "utf8"));
  const scores = buildCrapScores({ coverageSummary, metrics });
  const failingScores = options.maxCrap
    ? scores.filter((score) => score.crap > options.maxCrap)
    : [];

  console.log(JSON.stringify(scores, null, 2));

  if (failingScores.length > 0) {
    console.error(
      `CRAP threshold failed: ${failingScores.length} row(s) exceeded ${options.maxCrap}.`,
    );
    return 1;
  }

  return 0;
}

function getCommand(argv) {
  const firstArg = argv[0];

  if (firstArg === "score" || firstArg === "help") {
    return firstArg === "help" ? "legacy" : firstArg;
  }

  return "legacy";
}

function parseOptionalNumber(value, label) {
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    throw new TypeError(`${label} must be a finite number.`);
  }

  return parsed;
}

if (isDirectExecution()) {
  process.exitCode = main();
}

function isDirectExecution() {
  if (!process.argv[1]) {
    return false;
  }

  return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
}

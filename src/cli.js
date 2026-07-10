#!/usr/bin/env node

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

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
  --config <path>  Config file path. Defaults to .crap-ts.json when present.
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
  --help           Show this help.
`;

const defaultConfigPath = ".crap-ts.json";

export function parseCliArgs(argv, { cwd = process.cwd() } = {}) {
	const command = getCommand(argv);
	const args = command === "legacy" ? argv : argv.slice(1);
	const { positionals, values } = parseArgs({
		args,
		allowPositionals: true,
		options: {
			all: { type: "boolean" },
			config: { type: "string" },
			"coverage-file": { type: "string" },
			"coverage-command": { type: "string" },
			help: { type: "boolean", short: "h" },
			include: { type: "string", multiple: true },
			limit: { type: "string" },
			max: { type: "string" },
			"max-crap": { type: "string" },
			metrics: { type: "string" },
			"min-lines": { type: "string" },
			"report-only": { type: "boolean" },
			"skip-coverage": { type: "boolean" },
		},
	});
	const config =
		command === "help" || values.help ? {} : readConfig(values.config, cwd);

	return applyDefaults(
		mergeConfigWithCli(config, {
			command,
			all: values.all,
			configPath: values.config,
			coverageCommand: values["coverage-command"],
			coveragePath: values["coverage-file"],
			help: values.help,
			includes: values.include,
			limit: parseOptionalNumber(values.limit, "--limit"),
			maxCrap: parseOptionalNumber(values["max-crap"], "--max-crap"),
			maxScore: parseOptionalNumber(values.max, "--max"),
			metricsPath: values.metrics,
			minLines: parseOptionalNumber(values["min-lines"], "--min-lines"),
			paths: positionals,
			reportOnly: values["report-only"],
			skipCoverage: values["skip-coverage"],
		}),
	);
}

export async function main(argv = process.argv.slice(2)) {
	const options = parseCliArgs(argv);

	if (options.help || options.command === "help") {
		console.log(helpText);
		return 0;
	}

	if (
		options.command === "score" ||
		options.metricsPath ||
		options.coveragePath
	) {
		return runScore(options);
	}

	if (options.command !== "legacy") {
		console.error(`Unknown command: ${options.command}`);
		return 2;
	}

	console.error(
		"Usage error: run `crap-ts score --help` for supported commands.",
	);
	return 2;
}

async function runScore(options) {
	if (!options.metricsPath) {
		return runCrapAudit(options);
	}

	if (!options.coveragePath) {
		console.error("CRAP scoring requires both --metrics and --coverage-file.");
		return 2;
	}

	const metrics = JSON.parse(readFileSync(options.metricsPath, "utf8"));
	const coverageSummary = JSON.parse(
		readFileSync(options.coveragePath, "utf8"),
	);
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
		return firstArg;
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

function readConfig(configPath, cwd) {
	const resolvedPath = resolveConfigPath(configPath, cwd);

	if (!resolvedPath) {
		return {};
	}

	return JSON.parse(readFileSync(resolvedPath, "utf8"));
}

function resolveConfigPath(configPath, cwd) {
	if (configPath) {
		return resolve(cwd, configPath);
	}

	const defaultPath = resolve(cwd, defaultConfigPath);
	return existsSync(defaultPath) ? defaultPath : null;
}

function mergeConfigWithCli(config, cliOptions) {
	return {
		...normalizeConfig(config),
		...stripUndefined(cliOptions),
	};
}

function normalizeConfig(config) {
	return stripUndefined({
		all: config.all,
		coverageCommand: config.coverageCommand,
		coveragePath: config.coverageFile,
		includes: normalizeConfigList(config.include, "include"),
		limit: parseConfigNumber(config.limit, "limit"),
		maxCrap: parseConfigNumber(config.maxCrap, "maxCrap"),
		maxScore: parseConfigNumber(config.max, "max"),
		metricsPath: config.metrics,
		minLines: parseConfigNumber(config.minLines, "minLines"),
		reportOnly: config.reportOnly,
		skipCoverage: config.skipCoverage,
	});
}

function parseConfigNumber(value, label) {
	if (value === undefined) {
		return undefined;
	}

	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new TypeError(
			`${label} must be a finite number in ${defaultConfigPath}.`,
		);
	}

	return value;
}

function normalizeConfigList(value, label) {
	if (value === undefined) {
		return undefined;
	}

	if (typeof value === "string") {
		return [value];
	}

	if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
		return value;
	}

	throw new TypeError(
		`${label} must be a string or string array in ${defaultConfigPath}.`,
	);
}

function applyDefaults(options) {
	return {
		...options,
		all: options.all ?? false,
		help: options.help ?? false,
		includes: options.includes ?? [],
		reportOnly: options.reportOnly ?? false,
		skipCoverage: options.skipCoverage ?? false,
	};
}

function stripUndefined(values) {
	return Object.fromEntries(
		Object.entries(values).filter(([, value]) => value !== undefined),
	);
}

if (isDirectExecution()) {
	process.exitCode = await main();
}

function isDirectExecution() {
	if (!process.argv[1]) {
		return false;
	}

	return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
}

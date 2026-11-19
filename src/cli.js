#!/usr/bin/env node

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { runCrapAudit } from "./crap-runner.js";

const helpText = `crap-ts

Run a focused TypeScript quality audit.

Usage:
  crap-ts score [--coverage-file coverage/unit/coverage-final.json] [--coverage-command "npm run test:coverage"]

Options:
  --config <path>  Config file path. Defaults to .crap-ts.json when present.
  --coverage-file <path>
                    Istanbul coverage-final.json path. Repeat to merge several runs.
  --coverage-command <cmd>
                    Command to generate coverage before scoring.
  --all            Print every analyzed function instead of applying --limit.
  --include <text> Only analyze source files whose path contains this text.
  --exclude <text> Skip source files whose path contains this text.
  --json           Print the full JSON report (schema version 1) instead of text.
  --limit <n>      Number of rows to print in the text report. Defaults to 20.
  --min-lines <n>  Ignore functions shorter than this. Defaults to 10.
  --max <n>        Fail when any function's CRAP score is above this. Defaults to 30.
  --warn <n>       Warn, without failing, when any row is above this score.
  --report-only    Print CRAP report without failing on threshold.
  --skip-coverage  Do not run the coverage command.
  --help           Show this help.
`;

const defaultConfigPath = ".crap-ts.json";

export function parseCliArgs(argv, { cwd = process.cwd() } = {}) {
	const [command, ...args] = argv;
	const { values } = parseArgs({
		args,
		options: {
			all: { type: "boolean" },
			config: { type: "string" },
			"coverage-file": { type: "string", multiple: true },
			"coverage-command": { type: "string" },
			exclude: { type: "string", multiple: true },
			help: { type: "boolean", short: "h" },
			include: { type: "string", multiple: true },
			json: { type: "boolean" },
			limit: { type: "string" },
			max: { type: "string" },
			"min-lines": { type: "string" },
			"report-only": { type: "boolean" },
			"skip-coverage": { type: "boolean" },
			warn: { type: "string" },
		},
	});
	const config = values.help ? {} : readConfig(values.config, cwd);

	return applyDefaults(
		mergeConfigWithCli(config, {
			command,
			all: values.all,
			configPath: values.config,
			coverageCommand: values["coverage-command"],
			coveragePaths: values["coverage-file"],
			excludes: values.exclude,
			help: values.help,
			includes: values.include,
			json: values.json,
			limit: parseOptionalNumber(values.limit, "--limit"),
			maxScore: parseOptionalNumber(values.max, "--max"),
			minLines: parseOptionalNumber(values["min-lines"], "--min-lines"),
			reportOnly: values["report-only"],
			skipCoverage: values["skip-coverage"],
			warnScore: parseOptionalNumber(values.warn, "--warn"),
		}),
	);
}

export async function main(argv = process.argv.slice(2)) {
	const [command] = argv;

	if (!command || ["help", "--help", "-h"].includes(command)) {
		console.log(helpText);
		return 0;
	}

	if (command !== "score") {
		console.error(
			`Unknown command: ${command}. Run \`crap-ts score\`; see \`crap-ts --help\`.`,
		);
		return 2;
	}

	let options;

	try {
		options = parseCliArgs(argv);
	} catch (error) {
		console.error(`Usage error: ${error.message}`);
		return 2;
	}

	if (options.help) {
		console.log(helpText);
		return 0;
	}

	return runCrapAudit(options);
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

const configKeys = new Set([
	"all",
	"coverageCommand",
	"coverageFile",
	"exclude",
	"include",
	"json",
	"limit",
	"max",
	"minLines",
	"reportOnly",
	"skipCoverage",
	"warn",
]);

function normalizeConfig(config) {
	if (!config || typeof config !== "object" || Array.isArray(config)) {
		throw new TypeError(`${defaultConfigPath} must contain a JSON object.`);
	}

	const unknownKeys = Object.keys(config).filter((key) => !configKeys.has(key));

	if (unknownKeys.length > 0) {
		throw new TypeError(
			`Unknown ${defaultConfigPath} key(s): ${unknownKeys.join(", ")}.`,
		);
	}

	return stripUndefined({
		all: config.all,
		coverageCommand: config.coverageCommand,
		coveragePaths: normalizeConfigList(config.coverageFile, "coverageFile"),
		excludes: normalizeConfigList(config.exclude, "exclude"),
		includes: normalizeConfigList(config.include, "include"),
		json: config.json,
		limit: parseConfigNumber(config.limit, "limit"),
		maxScore: parseConfigNumber(config.max, "max"),
		minLines: parseConfigNumber(config.minLines, "minLines"),
		reportOnly: config.reportOnly,
		skipCoverage: config.skipCoverage,
		warnScore: parseConfigNumber(config.warn, "warn"),
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
		excludes: options.excludes ?? [],
		includes: options.includes ?? [],
		json: options.json ?? false,
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

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { main, parseCliArgs } from "../src/cli.js";

test("help subcommand prints help", async () => {
	const messages = await captureConsole(async () => {
		assert.equal(await main(["help"]), 0);
	});

	assert.match(messages.logs.join("\n"), /Usage:/);
	assert.match(messages.logs.join("\n"), /--coverage-file/);
});

test("parses direct audit flags", () => {
	const options = parseCliArgs([
		"score",
		"--coverage-file",
		"coverage/unit/coverage-final.json",
		"--include",
		"/app/",
		"--include",
		"/scripts/",
		"--all",
		"--fail-on-ignored",
		"--allow-empty-coverage",
		"--include-tests",
		"--report-only",
		"--max",
		"40",
		"--warn",
		"35",
		"--coverage-file",
		"coverage/browser/coverage-final.json",
		"--exclude",
		".test.ts",
		"--json",
	]);

	assert.equal(options.command, "score");
	assert.deepEqual(options.coveragePaths, [
		"coverage/unit/coverage-final.json",
		"coverage/browser/coverage-final.json",
	]);
	assert.deepEqual(options.includes, ["/app/", "/scripts/"]);
	assert.deepEqual(options.excludes, [".test.ts"]);
	assert.equal(options.json, true);
	assert.equal(options.all, true);
	assert.equal(options.failOnIgnored, true);
	assert.equal(options.allowEmptyCoverage, true);
	assert.equal(options.includeTests, true);
	assert.equal(options.reportOnly, true);
	assert.equal(options.maxScore, 40);
	assert.equal(options.warnScore, 35);
});

test("rejects non-numeric thresholds", () => {
	assert.throws(
		() => parseCliArgs(["score", "--max", "loud"]),
		/--max must be a finite number/,
	);
});

test("loads default .crap-ts.json config", () => {
	const cwd = mkdtempSync(join(tmpdir(), "crap-cli-default-config-"));
	writeFileSync(
		join(cwd, ".crap-ts.json"),
		JSON.stringify({
			coverageCommand: "npm run coverage",
			coverageFile: ["coverage/node.json", "coverage/browser.json"],
			exclude: ".test.ts",
			failOnIgnored: true,
			include: ["src", "scripts"],
			json: true,
			limit: 7,
			max: 42,
			minLines: 3,
			reportOnly: true,
			allowEmptyCoverage: true,
			includeTests: true,
			skipCoverage: true,
			warn: 35,
		}),
	);

	const options = parseCliArgs(["score"], { cwd });

	rmSync(cwd, { force: true, recursive: true });

	assert.equal(options.coverageCommand, "npm run coverage");
	assert.deepEqual(options.coveragePaths, [
		"coverage/node.json",
		"coverage/browser.json",
	]);
	assert.deepEqual(options.excludes, [".test.ts"]);
	assert.equal(options.failOnIgnored, true);
	assert.deepEqual(options.includes, ["src", "scripts"]);
	assert.equal(options.json, true);
	assert.equal(options.limit, 7);
	assert.equal(options.maxScore, 42);
	assert.equal(options.minLines, 3);
	assert.equal(options.reportOnly, true);
	assert.equal(options.allowEmptyCoverage, true);
	assert.equal(options.includeTests, true);
	assert.equal(options.skipCoverage, true);
	assert.equal(options.warnScore, 35);
});

test("leaves test files out by default", () => {
	assert.equal(parseCliArgs(["score"]).includeTests, false);
});

test("loads explicit config path", () => {
	const cwd = mkdtempSync(join(tmpdir(), "crap-cli-explicit-config-"));
	writeFileSync(
		join(cwd, "crap-config.json"),
		JSON.stringify({
			coverageFile: "coverage/explicit.json",
			include: "src",
		}),
	);

	const options = parseCliArgs(["score", "--config", "crap-config.json"], {
		cwd,
	});

	rmSync(cwd, { force: true, recursive: true });

	assert.deepEqual(options.coveragePaths, ["coverage/explicit.json"]);
	assert.deepEqual(options.includes, ["src"]);
});

test("CLI flags override config values", () => {
	const cwd = mkdtempSync(join(tmpdir(), "crap-cli-override-config-"));
	writeFileSync(
		join(cwd, ".crap-ts.json"),
		JSON.stringify({
			coverageFile: "coverage/from-config.json",
			include: ["from-config"],
			max: 30,
		}),
	);

	const options = parseCliArgs(
		[
			"score",
			"--coverage-file",
			"coverage/from-cli.json",
			"--include",
			"from-cli",
			"--max",
			"10",
		],
		{ cwd },
	);

	rmSync(cwd, { force: true, recursive: true });

	assert.deepEqual(options.coveragePaths, ["coverage/from-cli.json"]);
	assert.deepEqual(options.includes, ["from-cli"]);
	assert.equal(options.maxScore, 10);
});

test("requires the score subcommand", async () => {
	const messages = await captureConsole(async () => {
		assert.equal(
			await main(["--coverage-file", "coverage/coverage-final.json"]),
			2,
		);
	});

	assert.match(messages.errors.join("\n"), /Unknown command: --coverage-file/);
});

test("no longer accepts the metrics mode flags", () => {
	assert.throws(
		() => parseCliArgs(["score", "--metrics", "complexity-metrics.json"]),
		/Unknown option '--metrics'/,
	);
	assert.throws(
		() => parseCliArgs(["score", "--max-crap", "30"]),
		/Unknown option '--max-crap'/,
	);
});

test("rejects unknown config keys", () => {
	const cwd = mkdtempSync(join(tmpdir(), "crap-cli-unknown-config-"));
	writeFileSync(
		join(cwd, ".crap-ts.json"),
		JSON.stringify({ maxCrap: 30, metrics: "complexity-metrics.json" }),
	);

	try {
		assert.throws(
			() => parseCliArgs(["score"], { cwd }),
			/Unknown \.crap-ts\.json key\(s\): maxCrap, metrics/,
		);
	} finally {
		rmSync(cwd, { force: true, recursive: true });
	}
});

async function captureConsole(callback) {
	const logs = [];
	const errors = [];
	const originalLog = console.log;
	const originalError = console.error;

	console.log = (...args) => logs.push(args.join(" "));
	console.error = (...args) => errors.push(args.join(" "));

	try {
		await callback();
	} finally {
		console.log = originalLog;
		console.error = originalError;
	}

	return { errors, logs };
}

test("reports invalid flags as usage errors", async () => {
	const messages = await captureConsole(async () => {
		assert.equal(await main(["score", "--max", "loud"]), 2);
	});

	assert.deepEqual(messages.errors, [
		"Usage error: --max must be a finite number.",
	]);
});

test("points positional directories to --include", async () => {
	const messages = await captureConsole(async () => {
		assert.equal(await main(["score", "src", "scripts"]), 2);
	});

	assert.equal(messages.errors.length, 1);
	assert.match(messages.errors[0], /^Usage error: Unexpected argument 'src'/);
	assert.match(messages.errors[0], /--include 'src\/\*\*'/);
});

test("rejects an empty run by default and allows an explicit opt-out", () => {
	const cwd = mkdtempSync(join(tmpdir(), "crap-cli-empty-coverage-"));
	const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));

	try {
		const source = "export const station = () => 'Deep Space Nine';";
		writeFileSync(join(cwd, "node.json"), "{}");
		writeFileSync(join(cwd, "ops.ts"), source);
		writeFileSync(
			join(cwd, "browser.json"),
			JSON.stringify({
				"ops.ts": {
					f: { 0: 1 },
					fnMap: {
						0: {
							loc: {
								start: { line: 1, column: 23 },
								end: { line: 1, column: source.length - 1 },
							},
						},
					},
					s: { 0: 1 },
					statementMap: {
						0: {
							start: { line: 1, column: 0 },
							end: { line: 1, column: source.length },
						},
					},
				},
			}),
		);
		const args = [
			cli,
			"score",
			"--coverage-file",
			"node.json",
			"--coverage-file",
			"browser.json",
			"--min-lines",
			"1",
			"--json",
		];
		const normal = spawnSync(process.execPath, args, { cwd, encoding: "utf8" });
		assert.equal(normal.status, 1);
		assert.equal(normal.stdout, "");
		assert.match(normal.stderr, /Empty coverage JSON: .*node\.json/);

		const allowed = spawnSync(
			process.execPath,
			[...args, "--allow-empty-coverage"],
			{ cwd, encoding: "utf8" },
		);
		assert.equal(allowed.status, 0, allowed.stderr);
		assert.equal(JSON.parse(allowed.stdout).summary.passed, true);

		const nonempty = spawnSync(
			process.execPath,
			[cli, "score", "--coverage-file", "browser.json", "--min-lines", "1"],
			{ cwd, encoding: "utf8" },
		);
		assert.equal(nonempty.status, 0, nonempty.stderr);
	} finally {
		rmSync(cwd, { force: true, recursive: true });
	}
});

test("rejects non-boolean and non-string config values", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "crap-cli-typed-config-"));

	try {
		for (const [config, message] of [
			[{ failOnIgnored: "true" }, /failOnIgnored must be a boolean/],
			[{ reportOnly: "false" }, /reportOnly must be a boolean/],
			[{ allowEmptyCoverage: 1 }, /allowEmptyCoverage must be a boolean/],
			[{ includeTests: "yes" }, /includeTests must be a boolean/],
			[{ skipCoverage: 1 }, /skipCoverage must be a boolean/],
			[
				{ coverageCommand: ["npm", "test"] },
				/coverageCommand must be a string/,
			],
		]) {
			writeFileSync(join(cwd, ".crap-ts.json"), JSON.stringify(config));
			assert.throws(() => parseCliArgs(["score"], { cwd }), message);
		}

		const messages = await captureConsole(async () => {
			assert.equal(
				await main(["score", "--config", join(cwd, ".crap-ts.json")]),
				2,
			);
		});

		assert.match(
			messages.errors.join("\n"),
			/^Usage error: coverageCommand must be a string/,
		);
	} finally {
		rmSync(cwd, { force: true, recursive: true });
	}
});

test("reports invalid coverage as an input error without a stack trace", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "crap-cli-bad-coverage-"));
	const coveragePath = join(cwd, "coverage-final.json");
	writeFileSync(coveragePath, "{ not json");

	try {
		const messages = await captureConsole(async () => {
			assert.equal(
				await main([
					"score",
					"--coverage-file",
					coveragePath,
					"--skip-coverage",
				]),
				1,
			);
		});

		assert.equal(messages.errors.length, 1);
		assert.match(messages.errors[0], /^Error: .*JSON/);
	} finally {
		rmSync(cwd, { force: true, recursive: true });
	}
});

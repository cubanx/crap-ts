import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

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
			include: ["src", "scripts"],
			json: true,
			limit: 7,
			max: 42,
			minLines: 3,
			reportOnly: true,
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
	assert.deepEqual(options.includes, ["src", "scripts"]);
	assert.equal(options.json, true);
	assert.equal(options.limit, 7);
	assert.equal(options.maxScore, 42);
	assert.equal(options.minLines, 3);
	assert.equal(options.reportOnly, true);
	assert.equal(options.skipCoverage, true);
	assert.equal(options.warnScore, 35);
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

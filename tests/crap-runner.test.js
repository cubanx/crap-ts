import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { runCrapAudit } from "../src/crap-runner.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const location = (line, start = 0, end = 100) => ({
	end: { column: end, line },
	start: { column: start, line },
});

const firstSource = `
function first(value) {
  if (value) {
    return "yes";
  }

  return "no";
}
`;
const secondSource = `
function second(value) {
  if (value > 2) {
    return "high";
  }

  return "low";
}
`;

// Statements of `first`/`second` above: the `if` (line 3), its return (line 4)
// and the final return (line 7).
function branchCoverage(counts) {
	return {
		b: {},
		branchMap: {},
		f: { 0: 1 },
		fnMap: {
			0: {
				loc: { end: { column: 1, line: 8 }, start: { column: 22, line: 2 } },
			},
		},
		s: { 0: counts[0], 1: counts[1], 2: counts[2] },
		statementMap: {
			0: location(3, 2, 3),
			1: location(4, 4, 17),
			2: location(7, 2, 14),
		},
	};
}

function withProject(files, callback) {
	const cwd = mkdtempSync(join(tmpdir(), "crap-runner-"));

	for (const [path, contents] of Object.entries(files)) {
		mkdirSync(dirname(join(cwd, path)), { recursive: true });
		writeFileSync(
			join(cwd, path),
			typeof contents === "string" ? contents : JSON.stringify(contents),
		);
	}

	return Promise.resolve(callback(cwd)).finally(() =>
		rmSync(cwd, { force: true, recursive: true }),
	);
}

test("reports missing coverage file with coverage-file wording", async () => {
	await withProject({}, async (cwd) => {
		const messages = await captureConsole(() =>
			runCrapAudit({ cwd, skipCoverage: true }),
		);

		assert.equal(messages.result, 1);
		assert.match(messages.errors.join("\n"), /--coverage-file/);
	});
});

test("normalizes include paths and honors --all", async () => {
	await withProject(
		{
			"coverage-final.json": {
				"./first.ts": branchCoverage([1, 1, 1]),
				"second.ts": branchCoverage([1, 1, 1]),
			},
			"first.ts": firstSource,
			"second.ts": secondSource,
		},
		async (cwd) => {
			const options = {
				coveragePaths: ["coverage-final.json"],
				cwd,
				limit: 1,
				minLines: 1,
				reportOnly: true,
				skipCoverage: true,
			};
			const limited = await captureConsole(() =>
				runCrapAudit({ ...options, includes: ["./first"] }),
			);
			const all = await captureConsole(() =>
				runCrapAudit({ ...options, all: true }),
			);

			assert.equal(limited.result, 0);
			assert.match(limited.logs.join("\n"), /1 functions checked/);
			assert.match(limited.logs.join("\n"), /first\.ts:2 \| first/);
			assert.doesNotMatch(limited.logs.join("\n"), /second/);
			assert.equal(all.result, 0);
			assert.match(all.logs.join("\n"), /first\.ts:2 \| first/);
			assert.match(all.logs.join("\n"), /second\.ts:2 \| second/);
		},
	);
});

test("merges several coverage files by source position, not counter id", async () => {
	const nodeRun = branchCoverage([1, 0, 1]);
	// The browser run numbers the same statements differently.
	const browserRun = {
		...branchCoverage([0, 0, 0]),
		s: { 0: 1, 1: 0, 2: 0 },
		statementMap: {
			0: location(4, 4, 17),
			1: location(7, 2, 14),
			2: location(3, 2, 3),
		},
	};

	await withProject(
		{
			"browser.json": { "first.ts": browserRun },
			"first.ts": firstSource,
			"node.json": { "first.ts": nodeRun },
		},
		async (cwd) => {
			const single = await captureConsole(() =>
				runCrapAudit({
					coveragePaths: ["node.json"],
					cwd,
					json: true,
					minLines: 1,
					skipCoverage: true,
				}),
			);
			const merged = await captureConsole(() =>
				runCrapAudit({
					coveragePaths: ["node.json", "browser.json"],
					cwd,
					json: true,
					minLines: 1,
					skipCoverage: true,
				}),
			);

			assert.equal(
				JSON.parse(single.logs.join("\n")).functions[0].coveredStatements,
				2,
			);
			assert.deepEqual(
				pick(JSON.parse(merged.logs.join("\n")).functions[0], [
					"coverage",
					"coveredStatements",
					"statements",
				]),
				{ coverage: 100, coveredStatements: 3, statements: 3 },
			);
		},
	);
});

test("matches real-path coverage keys from a symlinked working directory", async () => {
	await withProject({ "first.ts": firstSource }, async (realCwd) => {
		const linkedCwd = `${realCwd}-linked`;
		symlinkSync(realCwd, linkedCwd);
		writeFileSync(
			join(realCwd, "coverage-final.json"),
			JSON.stringify({
				[join(realpathSync(realCwd), "first.ts")]: branchCoverage([1, 1, 1]),
			}),
		);

		try {
			const messages = await captureConsole(() =>
				runCrapAudit({
					coveragePaths: ["coverage-final.json"],
					cwd: linkedCwd,
					json: true,
					minLines: 1,
					skipCoverage: true,
				}),
			);
			const report = JSON.parse(messages.logs.join("\n"));

			assert.equal(messages.result, 0);
			assert.deepEqual(
				report.functions.map((row) => [row.file, row.evidence]),
				[["first.ts", "statements"]],
			);
		} finally {
			rmSync(linkedCwd, { force: true });
		}
	});
});

test("matches coverage keys when the working directory differs only in case", async (t) => {
	await withProject({ "Station.ts": firstSource }, async (realCwd) => {
		const casedCwd = join(dirname(realCwd), basename(realCwd).toUpperCase());

		if (!existsSync(casedCwd)) {
			t.skip("file system is case-sensitive");
			return;
		}

		writeFileSync(
			join(realCwd, "coverage-final.json"),
			JSON.stringify({
				[join(realpathSync.native(realCwd), "Station.ts")]: branchCoverage([
					1, 1, 1,
				]),
			}),
		);

		const messages = await captureConsole(() =>
			runCrapAudit({
				coveragePaths: ["coverage-final.json"],
				cwd: casedCwd,
				json: true,
				minLines: 1,
				skipCoverage: true,
			}),
		);
		const report = JSON.parse(messages.logs.join("\n"));

		assert.equal(messages.result, 0);
		assert.deepEqual(
			report.functions.map((row) => [row.file, row.evidence]),
			[["Station.ts", "statements"]],
		);
	});
});

test("fails source files without coverage evidence and exempts declaration-only files", async () => {
	await withProject(
		{
			"coverage-final.json": { "src/first.ts": branchCoverage([1, 1, 1]) },
			"src/first.ts": firstSource,
			"src/first.test.ts": "test('first', () => {});",
			"src/odo.ts": "export const form = shapeshift();",
			"src/side-effect.ts": 'import "./odo";',
			"src/types.ts":
				'export type Rank = "captain";\nexport { form } from "./odo";',
			"src/types.d.ts": "declare const quark: string;",
			"node_modules/ferengi/index.ts": "export const rule = 1;",
			"scripts/tool.ts": "run();",
		},
		async (cwd) => {
			const messages = await captureConsole(() =>
				runCrapAudit({
					coveragePaths: ["coverage-final.json"],
					cwd,
					excludes: [".test.ts"],
					includes: ["src/"],
					json: true,
					minLines: 1,
					skipCoverage: true,
				}),
			);
			const report = JSON.parse(messages.logs.join("\n"));

			assert.equal(messages.result, 1);
			assert.deepEqual(report.missingFiles, [
				"src/odo.ts",
				"src/side-effect.ts",
			]);
			assert.equal(report.summary.missingFiles, 2);
			assert.equal(report.summary.passed, false);
			assert.match(
				messages.errors.join("\n"),
				/Missing coverage evidence for 2 source file\(s\)/,
			);
			assert.match(messages.errors.join("\n"), /CRAP check failed/);
		},
	);
});

test("lists functions in files without coverage as missing evidence", async () => {
	await withProject(
		{
			"coverage-final.json": {},
			"first.ts": firstSource,
		},
		async (cwd) => {
			const messages = await captureConsole(() =>
				runCrapAudit({
					coveragePaths: ["coverage-final.json"],
					cwd,
					minLines: 1,
					skipCoverage: true,
				}),
			);

			assert.equal(messages.result, 1);
			assert.match(
				messages.logs.join("\n"),
				/1 functions checked, 0 above 30, 1 without coverage evidence/,
			);
			assert.match(
				messages.logs.join("\n"),
				/^FAIL first\.ts:2 \| first \| CRAP 6\.0 \| complexity 2 \| coverage missing/m,
			);
		},
	);
});

test("prints the full JSON report before failing the gate", async () => {
	await withProject(
		{
			"coverage-final.json": {
				"first.ts": branchCoverage([1, 1, 1]),
				"second.ts": branchCoverage([0, 0, 0]),
			},
			"first.ts": firstSource,
			"second.ts": secondSource,
		},
		async (cwd) => {
			const messages = await captureConsole(() =>
				runCrapAudit({
					coveragePaths: ["coverage-final.json"],
					cwd,
					json: true,
					limit: 1,
					maxScore: 5,
					minLines: 1,
					skipCoverage: true,
					warnScore: 2,
				}),
			);

			assert.equal(messages.result, 1);
			assert.deepEqual(JSON.parse(messages.logs.join("\n")), {
				schemaVersion: 1,
				thresholds: { max: 5, warn: 2, minLines: 1 },
				summary: {
					files: 2,
					functions: 2,
					aboveMax: 1,
					warning: 0,
					missingEvidence: 0,
					ignored: 0,
					missingFiles: 0,
					passed: false,
				},
				functions: [
					{
						file: "second.ts",
						name: "second",
						line: 2,
						column: 1,
						endLine: 8,
						lines: 7,
						complexity: 2,
						coverage: 0,
						statements: 3,
						coveredStatements: 0,
						evidence: "statements",
						crap: 6,
						level: "fail",
					},
					{
						file: "first.ts",
						name: "first",
						line: 2,
						column: 1,
						endLine: 8,
						lines: 7,
						complexity: 2,
						coverage: 100,
						statements: 3,
						coveredStatements: 3,
						evidence: "statements",
						crap: 2,
						level: "ok",
					},
				],
				missingFiles: [],
			});
			assert.match(messages.errors.join("\n"), /CRAP check failed/);
		},
	);
});

test("keeps coverage command output off stdout in JSON mode", async () => {
	await withProject(
		{
			"coverage-final.json": { "first.ts": branchCoverage([1, 1, 1]) },
			"first.ts": firstSource,
		},
		async (cwd) => {
			const { spawnSync } = await import("node:child_process");
			const result = spawnSync(
				process.execPath,
				[
					join(repoRoot, "src/cli.js"),
					"score",
					"--coverage-command",
					"echo vitest noise",
					"--coverage-file",
					"coverage-final.json",
					"--min-lines",
					"1",
					"--json",
				],
				{ cwd, encoding: "utf8" },
			);

			assert.equal(result.status, 0);
			assert.equal(JSON.parse(result.stdout).summary.passed, true);
			assert.match(result.stderr, /vitest noise/);
		},
	);
});

test("rejects malformed coverage counters", async () => {
	await withProject(
		{
			"coverage-final.json": {
				"first.ts": { ...branchCoverage([1, 1, 1]), s: { 0: -1, 1: 0, 2: 0 } },
			},
			"first.ts": firstSource,
		},
		async (cwd) => {
			await assert.rejects(
				runCrapAudit({
					coveragePaths: ["coverage-final.json"],
					cwd,
					skipCoverage: true,
				}),
				/Invalid coverage counter: .*first\.ts\) statement 0/,
			);
		},
	);
});

test("rejects coverage JSON that is not an object of file entries", async () => {
	await withProject(
		{ "coverage-final.json": [], "first.ts": firstSource },
		async (cwd) => {
			await assert.rejects(
				runCrapAudit({
					coveragePaths: ["coverage-final.json"],
					cwd,
					reportOnly: true,
					skipCoverage: true,
				}),
				/Invalid coverage data: .*coverage-final\.json/,
			);
		},
	);
});

test("rejects statement ranges that end before they start", async () => {
	const reversed = branchCoverage([1, 1, 1]);
	reversed.statementMap[0] = {
		end: { column: 1, line: 3 },
		start: { column: 9, line: 3 },
	};

	await withProject(
		{
			"coverage-final.json": { "first.ts": reversed },
			"first.ts": firstSource,
		},
		async (cwd) => {
			await assert.rejects(
				runCrapAudit({
					coveragePaths: ["coverage-final.json"],
					cwd,
					skipCoverage: true,
				}),
				/Invalid coverage position: .*statement 0/,
			);
		},
	);
});

test("maps a failing coverage command to exit code 1", async () => {
	await withProject({}, async (cwd) => {
		const messages = await captureConsole(() =>
			runCrapAudit({ coverageCommand: "exit 7", cwd }),
		);

		assert.equal(messages.result, 1);
		assert.match(
			messages.errors.join("\n"),
			/Coverage command failed with exit code 7/,
		);
	});
});

test("lists ignored functions last without failing the gate", async () => {
	const ignoredSource = `/* istanbul ignore next */${firstSource}`;

	await withProject(
		{
			"coverage-final.json": {
				"first.ts": {
					...branchCoverage([1, 1, 1]),
					f: {},
					fnMap: {},
					s: {},
					statementMap: {},
				},
				"second.ts": branchCoverage([1, 1, 1]),
			},
			"first.ts": ignoredSource,
			"second.ts": secondSource,
		},
		async (cwd) => {
			const options = {
				coveragePaths: ["coverage-final.json"],
				cwd,
				minLines: 1,
				skipCoverage: true,
			};
			const messages = await captureConsole(() =>
				runCrapAudit({ ...options, json: true }),
			);
			const text = await captureConsole(() =>
				runCrapAudit({ ...options, limit: 1 }),
			);
			const report = JSON.parse(messages.logs.join("\n"));

			assert.equal(messages.result, 0);
			assert.equal(report.summary.ignored, 1);
			assert.equal(report.summary.passed, true);
			// The ignored row scores higher (0% coverage) but sorts last.
			assert.deepEqual(
				report.functions.map((row) => [row.name, row.evidence, row.level]),
				[
					["second", "statements", "ok"],
					["first", "ignored", "ignored"],
				],
			);
			assert.match(text.logs.join("\n"), /second\.ts:2 \| second/);
			assert.doesNotMatch(text.logs.join("\n"), /first\.ts/);
		},
	);
});

test("fails functions without counters that no ignore comment covers", async () => {
	await withProject(
		{
			"coverage-final.json": {
				"first.ts": {
					...branchCoverage([1, 1, 1]),
					f: {},
					fnMap: {},
					s: {},
					statementMap: {},
				},
			},
			"first.ts": firstSource,
		},
		async (cwd) => {
			const messages = await captureConsole(() =>
				runCrapAudit({
					coveragePaths: ["coverage-final.json"],
					cwd,
					minLines: 1,
					skipCoverage: true,
				}),
			);

			assert.equal(messages.result, 1);
			assert.match(
				messages.logs.join("\n"),
				/FAIL first\.ts:2 \| first .*coverage missing/,
			);
		},
	);
});

test("exempts files with a file-level ignore comment from missing evidence", async () => {
	await withProject(
		{
			"coverage-final.json": {},
			"holosuite.ts":
				"/* istanbul ignore file */\nexport const program = vicFontaine();\n",
		},
		async (cwd) => {
			const messages = await captureConsole(() =>
				runCrapAudit({
					coveragePaths: ["coverage-final.json"],
					cwd,
					json: true,
					skipCoverage: true,
				}),
			);

			assert.equal(messages.result, 0);
			assert.deepEqual(JSON.parse(messages.logs.join("\n")).missingFiles, []);
		},
	);
});

test("fails strict mode and passes report-only mode for high-CRAP fixture", async () => {
	const options = {
		coveragePaths: ["fixtures/risky-coverage-final.json"],
		cwd: repoRoot,
		includes: ["fixtures/risky"],
		maxScore: 5,
		minLines: 1,
		skipCoverage: true,
	};
	const strict = await captureConsole(() => runCrapAudit(options));
	const reportOnly = await captureConsole(() =>
		runCrapAudit({ ...options, reportOnly: true }),
	);

	assert.equal(strict.result, 1);
	assert.match(strict.logs.join("\n"), /riskyDecision/);
	assert.match(strict.errors.join("\n"), /CRAP check failed/);
	assert.equal(reportOnly.result, 0);
	assert.match(reportOnly.logs.join("\n"), /1 functions checked, 1 above 5/);
});

test("warns without failing when a score is between warn and max", async () => {
	const messages = await captureConsole(() =>
		runCrapAudit({
			coveragePaths: ["fixtures/risky-coverage-final.json"],
			cwd: repoRoot,
			includes: ["fixtures/risky"],
			maxScore: 100,
			minLines: 1,
			skipCoverage: true,
			warnScore: 50,
		}),
	);

	assert.equal(messages.result, 0);
	assert.match(
		messages.logs.join("\n"),
		/1 functions checked, 0 above 100, 1 above 50 \(warn\)/,
	);
	assert.match(
		messages.logs.join("\n"),
		/^WARN fixtures\/risky.ts:1 \| riskyDecision/m,
	);
	assert.match(
		messages.errors.join("\n"),
		/CRAP warning: 1 function\(s\) above 50/,
	);
});

test("marks failing rows when a score is above max", async () => {
	const messages = await captureConsole(() =>
		runCrapAudit({
			coveragePaths: ["fixtures/risky-coverage-final.json"],
			cwd: repoRoot,
			includes: ["fixtures/risky"],
			maxScore: 50,
			minLines: 1,
			skipCoverage: true,
			warnScore: 25,
		}),
	);

	assert.equal(messages.result, 1);
	assert.match(messages.logs.join("\n"), /0 above 25 \(warn\)/);
	assert.match(
		messages.logs.join("\n"),
		/^FAIL fixtures\/risky.ts:1 \| riskyDecision/m,
	);
	assert.doesNotMatch(messages.errors.join("\n"), /CRAP warning/);
});

test("rejects non-finite numeric options before running coverage", async () => {
	for (const options of [
		{ maxScore: Number.NaN },
		{ warnScore: Number.POSITIVE_INFINITY },
		{ minLines: Number.NaN },
		{ limit: Number.NaN },
	]) {
		const messages = await captureConsole(() =>
			runCrapAudit({
				coverageCommand: "echo should-not-run",
				coveragePaths: ["fixtures/risky-coverage-final.json"],
				cwd: repoRoot,
				...options,
			}),
		);

		assert.equal(messages.result, 2);
		assert.match(messages.errors.join("\n"), /must be a finite number/);
	}
});

test("rejects a warn threshold above max", async () => {
	const messages = await captureConsole(() =>
		runCrapAudit({
			coveragePaths: ["fixtures/risky-coverage-final.json"],
			cwd: repoRoot,
			maxScore: 25,
			skipCoverage: true,
			warnScore: 30,
		}),
	);

	assert.equal(messages.result, 2);
	assert.match(
		messages.errors.join("\n"),
		/warn \(30\) must not exceed max \(25\)/,
	);
});

function pick(object, keys) {
	return Object.fromEntries(keys.map((key) => [key, object[key]]));
}

async function captureConsole(callback) {
	const logs = [];
	const errors = [];
	const originalLog = console.log;
	const originalError = console.error;
	let result;

	console.log = (...args) => logs.push(args.join(" "));
	console.error = (...args) => errors.push(args.join(" "));

	try {
		result = await callback();
	} finally {
		console.log = originalLog;
		console.error = originalError;
	}

	return { errors, logs, result };
}

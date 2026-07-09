import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runCrapAudit } from "../src/crap-runner.js";

test("reports missing coverage file with coverage-file wording", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "crap-runner-missing-"));
	const messages = await captureConsole(async () => {
		assert.equal(await runCrapAudit({ cwd, skipCoverage: true }), 1);
	});

	rmSync(cwd, { force: true, recursive: true });

	assert.match(messages.errors.join("\n"), /--coverage-file/);
});

test("normalizes include paths and honors --all", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "crap-runner-all-"));
	writeFileSync(
		join(cwd, "first.ts"),
		`
function first(value) {
  if (value) {
    return "yes";
  }

  return "no";
}
`,
	);
	writeFileSync(
		join(cwd, "second.ts"),
		`
function second(value) {
  if (value > 2) {
    return "high";
  }

  return "low";
}
`,
	);
	writeFileSync(
		join(cwd, "coverage-final.json"),
		JSON.stringify({
			"./first.ts": {
				f: { 0: 1 },
				fnMap: {
					0: { loc: { end: { line: 8 }, start: { line: 2 } }, line: 2 },
				},
			},
			"second.ts": {
				f: { 0: 1 },
				fnMap: {
					0: { loc: { end: { line: 8 }, start: { line: 2 } }, line: 2 },
				},
			},
		}),
	);

	const limited = await captureConsole(async () => {
		assert.equal(
			await runCrapAudit({
				coveragePath: "coverage-final.json",
				cwd,
				includes: ["./first"],
				limit: 1,
				minLines: 1,
				reportOnly: true,
				skipCoverage: true,
			}),
			0,
		);
	});
	const full = await captureConsole(async () => {
		assert.equal(
			await runCrapAudit({
				all: true,
				coveragePath: "coverage-final.json",
				cwd,
				limit: 1,
				minLines: 1,
				reportOnly: true,
				skipCoverage: true,
			}),
			0,
		);
	});

	rmSync(cwd, { force: true, recursive: true });

	assert.match(limited.logs.join("\n"), /1 functions checked/);
	assert.match(limited.logs.join("\n"), /first/);
	assert.doesNotMatch(limited.logs.join("\n"), /second/);
	assert.match(full.logs.join("\n"), /2 functions checked/);
	assert.match(full.logs.join("\n"), /first/);
	assert.match(full.logs.join("\n"), /second/);
});

test("runs coverage command before auditing", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "crap-runner-cmd-"));
	writeFileSync(join(cwd, "coverage-final.json"), JSON.stringify({}));

	const messages = await captureConsole(() =>
		runCrapAudit({
			coverageCommand: "true",
			coveragePath: "coverage-final.json",
			cwd,
			minLines: 1,
			reportOnly: true,
		}),
	);

	rmSync(cwd, { force: true, recursive: true });

	assert.equal(messages.result, 0);
	assert.match(messages.logs.join("\n"), /0 functions checked/);
});

test("returns non-zero when coverage command fails", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "crap-runner-fail-"));

	const messages = await captureConsole(() =>
		runCrapAudit({
			coverageCommand: "false",
			cwd,
		}),
	);

	rmSync(cwd, { force: true, recursive: true });

	assert.equal(messages.result, 1);
});

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

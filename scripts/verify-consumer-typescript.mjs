import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const versions = process.env.TYPESCRIPT_VERSION
	? [process.env.TYPESCRIPT_VERSION]
	: ["5.9.3", "6.0.3", "7.0.2"];

for (const version of versions) {
	verifyConsumerTypescript(version);
}

function verifyConsumerTypescript(version) {
	const workspace = mkdtempSync(join(tmpdir(), `crap-ts-consumer-${version}-`));

	try {
		const tarball = packPackage(workspace);
		const consumer = join(workspace, "consumer");

		mkdirSync(consumer);
		run("npm", ["init", "-y"], { cwd: consumer });
		run("npm", ["pkg", "set", "type=module"], { cwd: consumer });
		run("npm", ["install", "--silent", tarball, `typescript@${version}`], {
			cwd: consumer,
		});
		writeFixtureFiles(consumer);

		const strict = run(
			binPath(consumer, "crap-ts"),
			[
				"score",
				"--coverage-file",
				"coverage-final.json",
				"--min-lines",
				"1",
				"--max",
				"5",
			],
			{ allowFailure: true, cwd: consumer },
		);
		assert.equal(strict.status, 1);
		assert.match(`${strict.stdout}\n${strict.stderr}`, /riskyDecision/);
		assert.match(
			strict.stdout,
			/sample\.ts:1 \| riskyDecision \| CRAP 90\.0 \| complexity 9 \| coverage 0% \| 19 lines/,
		);
		assert.match(strict.stderr, /CRAP check failed/);

		const reportOnly = run(
			binPath(consumer, "crap-ts"),
			[
				"score",
				"--coverage-file",
				"coverage-final.json",
				"--min-lines",
				"1",
				"--max",
				"5",
				"--report-only",
			],
			{ cwd: consumer },
		);
		assert.match(reportOnly.stdout, /1 functions checked, 1 above 5/);
		assert.match(
			reportOnly.stdout,
			/sample\.ts:1 \| riskyDecision \| CRAP 90\.0 \| complexity 9 \| coverage 0% \| 19 lines/,
		);
		assert.doesNotMatch(reportOnly.stderr, /CRAP check failed/);

		run(
			binPath(consumer, "tsc"),
			[
				"--target",
				"es2022",
				"--module",
				"nodenext",
				"--moduleResolution",
				"nodenext",
				"--noEmit",
				"index.ts",
			],
			{ cwd: consumer },
		);

		const nestedNodeModules = join(
			consumer,
			"node_modules",
			"crap-ts",
			"node_modules",
		);
		assert.equal(
			existsSync(nestedNodeModules) &&
				readdirSync(nestedNodeModules, { withFileTypes: true }).some(
					(entry) => entry.name === "typescript",
				),
			false,
		);

		console.log(`typescript@${version}: consumer CRAP check passed`);
	} finally {
		rmSync(workspace, { force: true, recursive: true });
	}
}

function packPackage(workspace) {
	run("npm", ["pack", "--pack-destination", workspace], { cwd: repoRoot });
	const tarball = readdirSync(workspace).find((file) => file.endsWith(".tgz"));

	if (!tarball) {
		throw new Error("npm pack did not create a tarball");
	}

	return join(workspace, tarball);
}

function writeFixtureFiles(consumer) {
	writeFileSync(
		join(consumer, "sample.ts"),
		`export function riskyDecision(value: number, flags: string[]): string {
\tif (value > 100 && flags.includes("vip")) {
\t\treturn "vip-high";
\t}

\tif (value > 75 || flags.includes("manual-review")) {
\t\treturn "review";
\t}

\tif (value > 50) {
\t\treturn flags.includes("trusted") ? "trusted-medium" : "medium";
\t}

\tif (value > 0) {
\t\treturn "low";
\t}

\treturn flags.length > 0 ? "flagged-empty" : "empty";
}
`,
	);
	writeFileSync(
		join(consumer, "coverage-final.json"),
		JSON.stringify(
			{
				"sample.ts": {
					f: { 0: 0 },
					fnMap: {
						0: {
							line: 1,
							loc: { end: { line: 18 }, start: { line: 1 } },
						},
					},
				},
			},
			null,
			"\t",
		),
	);
	writeFileSync(
		join(consumer, "index.ts"),
		`import { analyzeFileRisk } from "crap-ts/crap-analysis";

const risks = await analyzeFileRisk({
\tcoverageFunctions: [],
\tfilePath: "sample.ts",
\tminLines: 1,
\tsourceFilePath: "sample.ts",
\tsourceText: "function f() { return 1; }",
});

console.log(risks.length);
`,
	);
}

function binPath(cwd, command) {
	return join(
		cwd,
		"node_modules",
		".bin",
		process.platform === "win32" ? `${command}.cmd` : command,
	);
}

function run(command, args, { allowFailure = false, cwd = repoRoot } = {}) {
	const result = spawnSync(command, args, {
		cwd,
		encoding: "utf8",
		shell: false,
	});

	if (!allowFailure && result.status !== 0) {
		throw new Error(
			[
				`${command} ${args.join(" ")} failed with ${result.status}`,
				result.stdout,
				result.stderr,
			]
				.filter(Boolean)
				.join("\n"),
		);
	}

	return result;
}

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
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
				"--include",
				"sample.ts",
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
				"--include",
				"sample.ts",
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

		const json = run(
			binPath(consumer, "crap-ts"),
			[
				"score",
				"--coverage-file",
				"coverage-final.json",
				"--include",
				"sample.ts",
				"--min-lines",
				"1",
				"--json",
			],
			{ allowFailure: true, cwd: consumer },
		);
		const report = JSON.parse(json.stdout);
		assert.equal(json.status, 1);
		assert.equal(report.schemaVersion, 1);
		assert.deepEqual(
			report.functions.map(({ complexity, crap, evidence, name }) => ({
				complexity,
				crap,
				evidence,
				name,
			})),
			[
				{
					complexity: 9,
					crap: 90,
					evidence: "statements",
					name: "riskyDecision",
				},
			],
		);

		// Vitest V8 coverage lists side-effect imports such as CSS under
		// absolute keys; only TypeScript and JavaScript sources may reach the
		// parser.
		const sideEffect = run(
			binPath(consumer, "crap-ts"),
			[
				"score",
				"--coverage-file",
				"side-effect-coverage.json",
				"--include",
				"src/**",
				"--min-lines",
				"1",
			],
			{ allowFailure: true, cwd: consumer },
		);
		assert.equal(sideEffect.status, 0, sideEffect.stderr);
		assert.match(sideEffect.stdout, /2 functions checked, 0 above 30/);
		assert.match(
			sideEffect.stdout,
			/src\/legacy\.js:3 \| legacyClass \| CRAP 6\.0 \| complexity 2 \| coverage 0%/,
		);
		assert.match(
			sideEffect.stdout,
			/src\/portrait\.ts:3 \| portraitClass \| CRAP 2\.0 \| complexity 2 \| coverage 100%/,
		);
		assert.doesNotMatch(sideEffect.stderr, /panic|ScriptKind/);

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
		run("node", ["api-check.mjs"], { cwd: consumer });

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
	const riskyCoverage = JSON.parse(
		readFileSync(join(repoRoot, "fixtures/risky-coverage-final.json"), "utf8"),
	)["fixtures/risky.ts"];
	writeFileSync(
		join(consumer, "coverage-final.json"),
		JSON.stringify(
			{ "sample.ts": { ...riskyCoverage, path: "sample.ts" } },
			null,
			"\t",
		),
	);
	mkdirSync(join(consumer, "src"));
	writeFileSync(
		join(consumer, "src", "portrait.ts"),
		`import "./portrait.css";

export function portraitClass(active: boolean): string {
\treturn active ? "portrait active" : "portrait";
}
`,
	);
	writeFileSync(
		join(consumer, "src", "legacy.js"),
		`import "./portrait.css";

export function legacyClass(active) {
\treturn active ? "legacy active" : "legacy";
}
`,
	);
	writeFileSync(
		join(consumer, "src", "portrait.css"),
		".odo { color: amber; }\n",
	);
	const root = realpathSync(consumer);
	const portraitCoverage = {
		f: { 0: 1 },
		fnMap: {
			0: {
				loc: { end: { column: 1, line: 5 }, start: { column: 52, line: 3 } },
			},
		},
		s: { 0: 1 },
		statementMap: {
			0: { end: { column: 48, line: 4 }, start: { column: 1, line: 4 } },
		},
	};
	writeFileSync(
		join(consumer, "side-effect-coverage.json"),
		JSON.stringify({
			[join(root, "src", "portrait.ts")]: portraitCoverage,
			[join(root, "src", "legacy.js")]: {
				f: { 0: 0 },
				fnMap: {
					0: {
						loc: {
							end: { column: 1, line: 5 },
							start: { column: 36, line: 3 },
						},
					},
				},
				s: { 0: 0 },
				statementMap: {
					0: { end: { column: 44, line: 4 }, start: { column: 1, line: 4 } },
				},
			},
			[join(root, "src", "portrait.css")]: {
				f: {},
				fnMap: {},
				s: {},
				statementMap: {},
			},
		}),
	);
	writeFileSync(
		join(consumer, "index.ts"),
		`import { analyzeFileRisk, type FunctionRisk } from "crap-ts";

const risks = await analyzeFileRisk({
\tfilePath: "sample.ts",
\tsourceFilePath: "sample.ts",
\tsourceText: "function f() { return 1; }",
});
const evidence: FunctionRisk["evidence"] | undefined = risks[0]?.evidence;

console.log(risks.length, evidence);
`,
	);
	writeFileSync(
		join(consumer, "api-check.mjs"),
		`import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import {
\tanalyzeFileRisk,
\tcalculateCrapScore,
\tcalculateCyclomaticComplexity,
\trunCrapAudit,
} from "crap-ts";

assert.equal(calculateCrapScore({ complexity: 10, coverage: 50 }), 22.5);
assert.equal(typeof runCrapAudit, "function");

const complexitySource = \`function choose(value, list) {
\twhile (value > 0) {
\t\tvalue -= 1;
\t}

\tfor (const item of list) {
\t\ttry {
\t\t\tif (item.enabled && (item.name || item.alias ?? value)) {
\t\t\t\treturn item.name ? item.name : "fallback";
\t\t\t}
\t\t} catch {
\t\t\treturn "error";
\t\t}
\t}

\treturn "none";
}
\`;

if (ts.createSourceFile) {
\tconst sourceFile = ts.createSourceFile(
\t\t"api-sample.ts",
\t\tcomplexitySource,
\t\tts.ScriptTarget.Latest,
\t\ttrue,
\t);

\tassert.equal(calculateCyclomaticComplexity(sourceFile.statements[0].body), 9);
} else {
\tconst { API } = await import("typescript/unstable/sync");
\tconst apiSamplePath = join(process.cwd(), "api-sample.ts");

\twriteFileSync(apiSamplePath, complexitySource);

\tconst api = new API();

\ttry {
\t\tconst snapshot = api.updateSnapshot({ openFiles: [apiSamplePath] });
\t\tconst sourceFile = snapshot
\t\t\t.getDefaultProjectForFile(apiSamplePath)
\t\t\t?.program.getSourceFile(apiSamplePath);

\t\tassert.equal(calculateCyclomaticComplexity(sourceFile.statements[0].body), 9);
\t} finally {
\t\tapi.close();
\t}
}

const risks = await analyzeFileRisk({
\tfilePath: "in-memory.ts",
\tsourceFilePath: "sample.ts",
\tsourceText: "function fromMemory() { return 1; }",
});

assert.deepEqual(
\trisks.map((risk) => risk.name),
\t["fromMemory"],
);
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

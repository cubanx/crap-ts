import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

import { analyzeSource } from "./crap-analysis.js";
import { normalizePath } from "./path-utils.js";

const reportSchemaVersion = 1;

const sourceFilePattern = /\.[cm]?tsx?$/;
// The inventory walk finds TypeScript only, but JavaScript sources named in
// coverage are scored too, as in 2.0.
const javaScriptFilePattern = /\.[cm]?jsx?$/;
const declarationFilePattern = /\.d\.[cm]?ts$/;
// The test files Vitest and Jest find by default: `*.test.*`, `*.spec.*`
// (and Vitest's `*.test-d.*` type tests), and anything under `__tests__/`.
const testFilePattern =
	/(?:^|\/)__tests__\/|\.(?:test|spec)(?:-d)?\.[cm]?[jt]sx?$/;

export async function runCrapAudit({
	all = false,
	allowEmptyCoverage = false,
	coverageCommand,
	coveragePaths = ["coverage/unit/coverage-final.json"],
	cwd = process.cwd(),
	excludes = [],
	failOnIgnored = false,
	includes = [],
	includeTests = false,
	json = false,
	limit = 20,
	maxScore = 30,
	minLines = 10,
	reportOnly = false,
	skipCoverage = false,
	warnScore,
} = {}) {
	for (const [label, value] of [
		["max", maxScore],
		["warn", warnScore ?? 0],
		["minLines", minLines],
		["limit", limit],
	]) {
		if (!Number.isFinite(value)) {
			console.error(`CRAP ${label} must be a finite number.`);
			return 2;
		}
	}

	if (warnScore !== undefined && warnScore > maxScore) {
		console.error(
			`CRAP warn (${warnScore}) must not exceed max (${maxScore}).`,
		);
		return 2;
	}

	const unsupportedPattern = [...includes, ...excludes].find((pattern) =>
		normalizePath(pattern)
			.replace(/\/\*\*$/, "")
			.includes("*"),
	);
	if (unsupportedPattern !== undefined) {
		console.error(
			`Unsupported path pattern ${JSON.stringify(unsupportedPattern)}. Use a substring or a directory pattern such as src/**.`,
		);
		return 2;
	}

	if (!skipCoverage && coverageCommand) {
		const result = spawnSync(coverageCommand, {
			cwd,
			shell: true,
			// Keep stdout clean for the JSON report.
			stdio: ["inherit", json ? 2 : "inherit", "inherit"],
		});

		if (result.status !== 0) {
			console.error(
				result.status === null
					? `Coverage command failed: ${result.error?.message ?? `killed by ${result.signal}`}`
					: `Coverage command failed with exit code ${result.status}.`,
			);
			return 1;
		}
	}

	const resolvedCoveragePaths = coveragePaths.map((path) => resolve(cwd, path));
	const missingCoveragePath = resolvedCoveragePaths.find(
		(path) => !existsSync(path),
	);

	if (missingCoveragePath) {
		console.error(`Missing coverage JSON: ${missingCoveragePath}`);
		console.error(
			"Run coverage first, pass --coverage-file, or use a valid --coverage-command.",
		);
		return 1;
	}

	// Coverage tools report real paths; compare everything in the file
	// system's canonical form (`.native` also canonicalises letter case).
	const root = realpathSync.native(cwd);
	const coverageByFile = readCoverageFiles(
		resolvedCoveragePaths,
		root,
		allowEmptyCoverage,
	);
	const matchesFilters = (path) => {
		const relativePath = relative(root, path);
		return (
			matchesAny(relativePath, includes, true) &&
			!matchesAny(relativePath, excludes, false)
		);
	};
	const isTestFile = (path) =>
		testFilePattern.test(normalizePath(relative(root, path)));
	const candidatePaths = new Set(
		listSourceFiles(root, namedDotDirectories(includes)).filter(matchesFilters),
	);

	// Coverage tools also list non-source modules (CSS, JSON) and even
	// directories; only TypeScript and JavaScript sources can be scored.
	for (const path of coverageByFile.keys()) {
		if (
			isCoverageSourceFile(path) &&
			existsSync(path) &&
			matchesFilters(path)
		) {
			candidatePaths.add(path);
		}
	}

	const sourcePaths = new Set(
		[...candidatePaths].filter((path) => includeTests || !isTestFile(path)),
	);

	if (sourcePaths.size === 0) {
		const testHint =
			candidatePaths.size > 0
				? ` The ${candidatePaths.size} matching file(s) were skipped as test files; pass --include-tests to analyze them.`
				: "";
		console.error(
			`No source files matched under ${root}. Check --include and --exclude; patterns are relative to the working directory, for example --include 'src/**'.${testHint}`,
		);
		return 1;
	}

	const functions = [];
	const missingFiles = [];

	for (const sourceFilePath of [...sourcePaths].sort()) {
		const filePath = normalizePath(relative(root, sourceFilePath));
		const coverage = coverageByFile.get(sourceFilePath);
		const analysis = await analyzeSource({
			coverage,
			failOnIgnored,
			filePath,
			sourceFilePath,
			sourceText: readFileSync(sourceFilePath, "utf8"),
		});

		if (!coverage && analysis.executable) {
			missingFiles.push(filePath);
		}

		functions.push(
			...analysis.functions.filter((risk) => risk.lineCount >= minLines),
		);
	}

	const report = buildReport({
		failOnIgnored,
		files: sourcePaths.size,
		functions,
		maxScore,
		minLines,
		missingFiles,
		warnScore,
	});

	if (json) {
		console.log(JSON.stringify(report, null, 2));
	} else {
		printTextReport({ all, limit, maxScore, report, warnScore });
	}

	const { summary } = report;

	if (summary.warning > 0) {
		console.error("");
		console.error(
			`CRAP warning: ${summary.warning} function(s) above ${warnScore}. Add coverage or simplify them before they cross ${maxScore}.`,
		);
	}

	if (summary.functions === 0) {
		console.error("");
		console.error(
			`No functions checked in ${summary.files} source file(s). Check --include, --exclude and --min-lines (${minLines}).`,
		);
	}

	if (missingFiles.length > 0) {
		console.error("");
		console.error(
			`Missing coverage evidence for ${missingFiles.length} source file(s):`,
		);

		for (const filePath of missingFiles) {
			console.error(`  ${filePath}`);
		}
	}

	if (!summary.passed && !reportOnly) {
		console.error("");
		console.error(
			"CRAP check failed. Use --report-only while calibrating, or lower complexity / add coverage for the listed functions and files.",
		);
		return 1;
	}

	return 0;
}

function buildReport({
	failOnIgnored,
	files,
	functions,
	maxScore,
	minLines,
	missingFiles,
	warnScore,
}) {
	const rows = functions
		.sort(
			(left, right) =>
				// Keep ignored scores below rows that use coverage to score the gate.
				Number(left.evidence === "ignored") -
					Number(right.evidence === "ignored") ||
				right.crapScore - left.crapScore ||
				left.filePath.localeCompare(right.filePath) ||
				left.startLine - right.startLine ||
				left.startColumn - right.startColumn,
		)
		.map((risk) => ({
			file: risk.filePath,
			name: risk.name,
			line: risk.startLine,
			column: risk.startColumn,
			endLine: risk.endLine,
			lines: risk.lineCount,
			complexity: risk.complexity,
			coverage: risk.coveragePercent,
			statements: risk.statements,
			coveredStatements: risk.coveredStatements,
			evidence: risk.evidence,
			crap: risk.crapScore,
			level: getRiskLevel(risk, { failOnIgnored, maxScore, warnScore }),
		}));
	const count = (predicate) => rows.filter(predicate).length;
	const summary = {
		files,
		functions: rows.length,
		aboveMax: count((row) => row.evidence !== "ignored" && row.crap > maxScore),
		warning: count((row) => row.level === "warn"),
		missingEvidence: count((row) => row.evidence === "missing"),
		ignored: count((row) => row.evidence === "ignored"),
		missingFiles: missingFiles.length,
	};

	return {
		schemaVersion: reportSchemaVersion,
		thresholds: { max: maxScore, warn: warnScore ?? null, minLines },
		summary: {
			...summary,
			// A gate that checks nothing must not pass.
			passed:
				summary.functions > 0 &&
				summary.aboveMax === 0 &&
				summary.missingEvidence === 0 &&
				summary.missingFiles === 0 &&
				(!failOnIgnored || summary.ignored === 0),
		},
		functions: rows,
		missingFiles,
	};
}

function printTextReport({ all, limit, maxScore, report, warnScore }) {
	const { functions, summary } = report;
	const warningSummary =
		warnScore === undefined
			? ""
			: `, ${summary.warning} above ${warnScore} (warn)`;
	const missingSummary =
		summary.missingEvidence === 0
			? ""
			: `, ${summary.missingEvidence} without coverage evidence`;
	const ignoredSummary =
		summary.ignored === 0 ? "" : `, ${summary.ignored} ignored by coverage`;

	console.log();
	console.log(
		`CRAP report: ${summary.functions} functions checked, ${summary.aboveMax} above ${maxScore}${warningSummary}${missingSummary}${ignoredSummary}.`,
	);

	const visibleRows = all ? functions : functions.slice(0, limit);
	for (const row of visibleRows) {
		console.log(formatReportRow(row));
	}
	for (const row of functions.slice(visibleRows.length)) {
		if (row.evidence === "ignored" && row.level === "fail") {
			console.log(formatReportRow(row));
		}
	}
}

const rowTags = { fail: "FAIL", ignored: "SKIP", ok: "  ok", warn: "WARN" };

function formatReportRow(row) {
	return [
		`${rowTags[row.level]} ${row.file}:${row.line}`,
		row.name,
		`CRAP ${row.crap.toFixed(1)}`,
		`complexity ${row.complexity}`,
		row.evidence === "missing" || row.evidence === "ignored"
			? `coverage ${row.evidence}`
			: `coverage ${row.coverage.toFixed(0)}%`,
		`${row.lines} lines`,
	].join(" | ");
}

function getRiskLevel(risk, { failOnIgnored, maxScore, warnScore }) {
	if (risk.evidence === "ignored") {
		return failOnIgnored ? "fail" : "ignored";
	}

	if (risk.crapScore > maxScore || risk.evidence === "missing") {
		return "fail";
	}

	if (warnScore !== undefined && risk.crapScore > warnScore) {
		return "warn";
	}

	return "ok";
}

function readCoverageFiles(coveragePaths, root, allowEmptyCoverage) {
	const coverageByFile = new Map();

	for (const coveragePath of coveragePaths) {
		const coverageJson = parseCoverageJson(coveragePath);
		assertObject(coverageJson, coveragePath);
		const entries = Object.entries(coverageJson);

		if (!allowEmptyCoverage && entries.length === 0) {
			throw new Error(`Empty coverage JSON: ${coveragePath}`);
		}

		for (const [key, entry] of entries) {
			const label = `${coveragePath} (${key})`;
			validateFileCoverage(entry, label);

			const resolvedKey = isAbsolute(key) ? key : resolve(root, key);
			const sourcePath = existsSync(resolvedKey)
				? realpathSync.native(resolvedKey)
				: resolvedKey;
			coverageByFile.set(
				sourcePath,
				mergeFileCoverage(
					coverageByFile.get(sourcePath) ?? emptyCoverage(),
					entry,
				),
			);
		}
	}

	return coverageByFile;
}

function parseCoverageJson(coveragePath) {
	try {
		return JSON.parse(readFileSync(coveragePath, "utf8"));
	} catch (error) {
		throw new Error(`Invalid coverage JSON ${coveragePath}: ${error.message}`, {
			cause: error,
		});
	}
}

// Merge by original source position, never by counter id: separate runs
// number their counters independently.
function mergeFileCoverage(target, entry) {
	mergeCounters(
		target.statementMap,
		target.s,
		entry.statementMap,
		entry.s,
		(location) => locationKey(location),
	);
	mergeCounters(target.fnMap, target.f, entry.fnMap, entry.f, (metadata) =>
		locationKey(metadata.loc),
	);

	return target;
}

function mergeCounters(targetMap, targetCounts, map, counts, getKey) {
	const idsByKey = new Map(
		Object.entries(targetMap).map(([id, value]) => [getKey(value), id]),
	);

	for (const [id, value] of Object.entries(map)) {
		const key = getKey(value);
		const existingId = idsByKey.get(key);

		if (existingId === undefined) {
			const newId = String(idsByKey.size);
			idsByKey.set(key, newId);
			targetMap[newId] = value;
			targetCounts[newId] = counts[id];
		} else {
			targetCounts[existingId] += counts[id];
		}
	}
}

function emptyCoverage() {
	return { f: {}, fnMap: {}, s: {}, statementMap: {} };
}

function locationKey({ end, start }) {
	return `${start.line}:${start.column}-${end.line}:${end.column}`;
}

function validateFileCoverage(entry, label) {
	assertObject(entry, label);

	for (const key of ["statementMap", "s", "fnMap", "f"]) {
		assertObject(entry[key], `${label} ${key}`);
	}

	for (const [map, counts, name] of [
		[entry.statementMap, entry.s, "statement"],
		[entry.fnMap, entry.f, "function"],
	]) {
		for (const [id, value] of Object.entries(map)) {
			assertRange(
				name === "function" ? value?.loc : value,
				`${label} ${name} ${id}`,
			);

			if (!Number.isSafeInteger(counts[id]) || counts[id] < 0) {
				throw new Error(`Invalid coverage counter: ${label} ${name} ${id}`);
			}
		}
	}
}

function assertObject(value, label) {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`Invalid coverage data: ${label}`);
	}
}

function assertRange(range, label) {
	assertObject(range, label);
	assertObject(range.start, label);
	assertObject(range.end, label);

	const { end, start } = range;
	// Source-mapped Istanbul data serializes an end-of-line column as null.
	const validEndColumn =
		end.column === null || (Number.isInteger(end.column) && end.column >= 0);

	if (
		!Number.isInteger(start.line) ||
		start.line < 1 ||
		!Number.isInteger(start.column) ||
		start.column < 0 ||
		!Number.isInteger(end.line) ||
		!validEndColumn ||
		// A null end column means end of line, which never precedes the start.
		comparePositions(end, start, Number.POSITIVE_INFINITY) < 0
	) {
		throw new Error(`Invalid coverage position: ${label}`);
	}
}

function comparePositions(left, right, nullColumn) {
	return (
		left.line - right.line ||
		(left.column ?? nullColumn) - (right.column ?? nullColumn)
	);
}

// Dot directories that an include pattern names as a full path segment, such
// as `.railway` in `.railway/**` or `apps/.railway/`. The walk enters only
// these; the include and exclude filters still decide which files count.
function namedDotDirectories(includes) {
	return new Set(
		includes.flatMap((pattern) =>
			normalizePath(pattern)
				.replace(/\/\*\*$/, "")
				.split("/")
				.filter(
					(segment) =>
						segment.startsWith(".") && segment !== "." && segment !== "..",
				),
		),
	);
}

function listSourceFiles(directory, dotDirectories) {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);

		if (entry.isDirectory()) {
			const skipped =
				entry.name === "node_modules" ||
				(entry.name.startsWith(".") && !dotDirectories.has(entry.name));
			return skipped ? [] : listSourceFiles(path, dotDirectories);
		}

		return entry.isFile() && isSourceFile(entry.name) ? [path] : [];
	});
}

function isSourceFile(path) {
	return sourceFilePattern.test(path) && !declarationFilePattern.test(path);
}

function isCoverageSourceFile(path) {
	return isSourceFile(path) || javaScriptFilePattern.test(path);
}

function matchesAny(path, patterns, emptyResult) {
	if (patterns.length === 0) {
		return emptyResult;
	}

	const normalizedPath = normalizePath(path);

	return patterns.some((pattern) => {
		const normalizedPattern = normalizePath(pattern);

		if (normalizedPattern.endsWith("/**")) {
			return (
				!isAbsolute(path) &&
				normalizedPath !== ".." &&
				!normalizedPath.startsWith("../") &&
				normalizedPath.startsWith(normalizedPattern.slice(0, -2))
			);
		}

		return normalizedPath.includes(normalizedPattern);
	});
}

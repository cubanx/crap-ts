import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

import { analyzeSource } from "./crap-analysis.js";
import { normalizePath } from "./path-utils.js";

const reportSchemaVersion = 1;

const sourceFilePattern = /\.[cm]?tsx?$/;
const declarationFilePattern = /\.d\.[cm]?ts$/;

export async function runCrapAudit({
	all = false,
	coverageCommand,
	coveragePaths = ["coverage/unit/coverage-final.json"],
	cwd = process.cwd(),
	excludes = [],
	includes = [],
	json = false,
	limit = 20,
	maxScore = 30,
	minLines = 10,
	reportOnly = false,
	skipCoverage = false,
	warnScore,
} = {}) {
	if (warnScore !== undefined && warnScore > maxScore) {
		console.error(
			`CRAP warn (${warnScore}) must not exceed max (${maxScore}).`,
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
	const coverageByFile = readCoverageFiles(resolvedCoveragePaths, root);
	const isSelected = (path) => {
		const relativePath = relative(root, path);
		return (
			matchesAny(relativePath, includes, true) &&
			!matchesAny(relativePath, excludes, false)
		);
	};
	const sourcePaths = new Set(listSourceFiles(root).filter(isSelected));

	for (const path of coverageByFile.keys()) {
		if (existsSync(path) && isSelected(path)) {
			sourcePaths.add(path);
		}
	}

	const functions = [];
	const missingFiles = [];

	for (const sourceFilePath of [...sourcePaths].sort()) {
		const filePath = normalizePath(relative(root, sourceFilePath));
		const coverage = coverageByFile.get(sourceFilePath);
		const analysis = await analyzeSource({
			coverage,
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
				// Ignored rows never gate, so keep them below every gated row.
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
			level: getRiskLevel(risk, { maxScore, warnScore }),
		}));
	const count = (predicate) => rows.filter(predicate).length;
	const summary = {
		files,
		functions: rows.length,
		aboveMax: count((row) => row.level !== "ignored" && row.crap > maxScore),
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
			passed:
				summary.aboveMax === 0 &&
				summary.missingEvidence === 0 &&
				summary.missingFiles === 0,
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

	for (const row of all ? functions : functions.slice(0, limit)) {
		console.log(formatReportRow(row));
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

function getRiskLevel(risk, { maxScore, warnScore }) {
	if (risk.evidence === "ignored") {
		return "ignored";
	}

	if (risk.crapScore > maxScore || risk.evidence === "missing") {
		return "fail";
	}

	if (warnScore !== undefined && risk.crapScore > warnScore) {
		return "warn";
	}

	return "ok";
}

function readCoverageFiles(coveragePaths, root) {
	const coverageByFile = new Map();

	for (const coveragePath of coveragePaths) {
		const coverageJson = parseCoverageJson(coveragePath);
		assertObject(coverageJson, coveragePath);

		for (const [key, entry] of Object.entries(coverageJson)) {
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

function listSourceFiles(directory) {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);

		if (entry.isDirectory()) {
			return entry.name === "node_modules" || entry.name.startsWith(".")
				? []
				: listSourceFiles(path);
		}

		return entry.isFile() &&
			sourceFilePattern.test(entry.name) &&
			!declarationFilePattern.test(entry.name)
			? [path]
			: [];
	});
}

function matchesAny(path, patterns, emptyResult) {
	if (patterns.length === 0) {
		return emptyResult;
	}

	const normalizedPath = normalizePath(path);

	return patterns.some((pattern) =>
		normalizedPath.includes(normalizePath(pattern)),
	);
}

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import ts from "typescript";

import { calculateCrapScore } from "./crap-score.js";

// TypeScript 7 has no `createSourceFile`; its AST lives behind the unstable API.
const ts7Ast = ts.createSourceFile
	? null
	: await import("typescript/unstable/ast");
const defaultAdapter = ts7Ast
	? { SyntaxKind: ts7Ast.SyntaxKind, forEachChild: forEachTs7Child }
	: { SyntaxKind: ts.SyntaxKind, forEachChild: ts.forEachChild };

export async function analyzeFileRisk({
	coverage,
	filePath,
	minLines = 1,
	sourceFilePath,
	sourceText,
}) {
	const { functions } = await analyzeSource({
		coverage,
		filePath,
		sourceFilePath,
		sourceText,
	});

	return functions.filter((risk) => risk.lineCount >= minLines);
}

export async function analyzeSource({
	coverage,
	filePath,
	sourceFilePath,
	sourceText,
}) {
	const sourceFile = await parseSourceFile({
		filePath,
		sourceFilePath,
		sourceText,
	});
	const adapter = { ...defaultAdapter, sourceFile };
	const ignore = findIgnoreComments(sourceText, collectLiteralRanges(adapter));
	const functions = collectFunctions(adapter, filePath, ignore);

	if (coverage) {
		assertStatementsInSource(coverage, sourceText, filePath);
		assignStatementCoverage(functions, coverage);
	}

	return {
		executable:
			!ignore.file &&
			(functions.length > 0 || hasExecutableModuleStatements(adapter)),
		functions: functions.map(({ ignored, risk }) => {
			// No counters is only acceptable where an ignore comment removed them.
			if (ignored && risk.evidence === "missing") {
				risk.evidence = "ignored";
			}

			risk.crapScore = calculateCrapScore({
				complexity: risk.complexity,
				coverage: risk.coveragePercent,
			});
			return risk;
		}),
	};
}

export function calculateCyclomaticComplexity(node, adapter = defaultAdapter) {
	let complexity = 1;

	function visit(child) {
		// Nested functions get their own rows; never charge their decisions here.
		if (isFunctionLikeNode(adapter, child)) {
			return;
		}

		if (addsDecisionPath(adapter, child)) {
			complexity += 1;
		}

		adapter.forEachChild(child, visit);
	}

	if (isFunctionLikeNode(adapter, node)) {
		adapter.forEachChild(node, visit);
	} else {
		visit(node);
	}

	return complexity;
}

function addsDecisionPath({ SyntaxKind }, node) {
	switch (node.kind) {
		case SyntaxKind.IfStatement:
		case SyntaxKind.ConditionalExpression:
		case SyntaxKind.ForStatement:
		case SyntaxKind.ForInStatement:
		case SyntaxKind.ForOfStatement:
		case SyntaxKind.WhileStatement:
		case SyntaxKind.DoStatement:
		case SyntaxKind.CaseClause:
		case SyntaxKind.CatchClause:
			return true;
		case SyntaxKind.BinaryExpression:
			return [
				SyntaxKind.AmpersandAmpersandToken,
				SyntaxKind.BarBarToken,
				SyntaxKind.QuestionQuestionToken,
				SyntaxKind.AmpersandAmpersandEqualsToken,
				SyntaxKind.BarBarEqualsToken,
				SyntaxKind.QuestionQuestionEqualsToken,
			].includes(node.operatorToken.kind);
		case SyntaxKind.Parameter:
		case SyntaxKind.BindingElement:
			return Boolean(node.initializer);
		case SyntaxKind.ShorthandPropertyAssignment:
			return Boolean(node.objectAssignmentInitializer);
		default:
			return false;
	}
}

function collectFunctions(adapter, filePath, ignore) {
	const { SyntaxKind, sourceFile } = adapter;
	const functions = [];

	function visit(node) {
		const start = toPosition(sourceFile, node.getStart(sourceFile));

		const targetKey = positionKey(start);
		const directive = ignore.nextTargets.get(targetKey);

		// An `ignore next|if|else` comment applies to the outermost node after it.
		if (directive && node.kind !== SyntaxKind.SourceFile) {
			ignore.nextTargets.delete(targetKey);
			const target =
				directive === "next"
					? node
					: node.kind === SyntaxKind.IfStatement
						? node[directive === "if" ? "thenStatement" : "elseStatement"]
						: undefined;

			if (target) {
				ignore.ranges.push({
					end: toPosition(sourceFile, target.getEnd()),
					start: toPosition(sourceFile, target.getStart(sourceFile)),
				});
			}
		}

		if (isFunctionLikeNode(adapter, node) && node.body) {
			const end = toPosition(sourceFile, node.getEnd());

			functions.push({
				bodyStart: toPosition(sourceFile, node.body.getStart(sourceFile)),
				ignored: isIgnored(ignore, start),
				range: { end, start },
				risk: {
					complexity: calculateCyclomaticComplexity(node, adapter),
					coveragePercent: 0,
					coveredStatements: 0,
					crapScore: 0,
					endLine: end.line,
					evidence: "missing",
					filePath,
					lineCount: end.line - start.line + 1,
					name: getFunctionName(adapter, node),
					startColumn: start.column + 1,
					startLine: start.line,
					statements: 0,
				},
			});
		}

		adapter.forEachChild(node, visit);
	}

	visit(sourceFile);

	return functions;
}

function assignStatementCoverage(functions, coverage) {
	for (const [id, location] of Object.entries(coverage.statementMap)) {
		const owner = findOwner(functions, location.start);

		// Module-level statements belong to no function row.
		if (!owner) {
			continue;
		}

		owner.risk.statements += 1;
		owner.risk.coveredStatements += coverage.s[id] > 0 ? 1 : 0;
	}

	const counterStarts = new Set(
		Object.values(coverage.fnMap).map(({ loc }) => positionKey(loc.start)),
	);
	const countersByOwner = groupCountersBy(coverage.fnMap, (start) =>
		findCounterOwner(functions, start, counterStarts),
	);

	for (const fn of functions) {
		const { risk } = fn;

		if (risk.statements > 0) {
			risk.coveragePercent = (risk.coveredStatements / risk.statements) * 100;
			risk.evidence = "statements";
			continue;
		}

		const counters = countersByOwner.get(fn) ?? [];

		if (counters.length === 1) {
			risk.coveragePercent = coverage.f[counters[0]] > 0 ? 100 : 0;
			risk.evidence = "function";
		}
	}
}

// Istanbul places a function counter at the function's body; per-line V8
// converters place it at the function's first token. The two positions meet
// only where an arrow is another arrow's expression body (`a => b => 1`):
// there the outer arrow owns the counter, unless it has a first-token counter
// of its own, which marks the V8 layout.
function findCounterOwner(functions, start, counterStarts) {
	const startingHere = functions.findLast(
		(fn) => comparePositions(fn.range.start, start) === 0,
	);

	if (!startingHere) {
		// A nested function's counter must never stand in for its parent's.
		return findOwner(functions, start);
	}

	const parent = functions.find(
		(fn) => comparePositions(fn.bodyStart, start) === 0,
	);

	return parent && !counterStarts.has(positionKey(parent.range.start))
		? parent
		: startingHere;
}

function groupCountersBy(fnMap, getFunction) {
	const groups = new Map();

	for (const [id, metadata] of Object.entries(fnMap)) {
		const fn = getFunction(metadata.loc.start);

		if (fn) {
			groups.set(fn, [...(groups.get(fn) ?? []), id]);
		}
	}

	return groups;
}

// Functions are collected in preorder, so the last match is the innermost.
function findOwner(functions, position) {
	return functions.findLast((fn) => containsPosition(fn.range, position));
}

// The start is exclusive: Istanbul places initializer counters and an outer
// arrow's expression body at a function's first token, and those belong to
// the enclosing scope.
function containsPosition(range, position) {
	return (
		comparePositions(range.start, position) < 0 &&
		comparePositions(position, range.end) < 0
	);
}

function comparePositions(left, right) {
	return left.line - right.line || left.column - right.column;
}

// The line terminators TypeScript and Babel recognise.
const lineTerminatorPattern = /\r\n|[\n\r\u2028\u2029]/g;
const commentPattern = /\/\*([\s\S]*?)\*\/|\/\/([^\n\r\u2028\u2029]*)/g;
const ignoreDirectivePattern =
	/^\s*(?:istanbul|v8|c8)\s+ignore\s+(next|if|else|start|stop|file)(?:\s+(\d+))?(?=\W|$)/;
const triviaPattern = /(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n\r\u2028\u2029]*)*/y;

// Coverage tools drop counters for code under these comments:
// `istanbul|v8|c8 ignore next [lines]`, `ignore if|else`, `ignore start` … `ignore stop`,
// `ignore file`.
function findIgnoreComments(sourceText, literalRanges) {
	const lineStarts = [0];

	for (const match of sourceText.matchAll(lineTerminatorPattern)) {
		lineStarts.push(match.index + match[0].length);
	}

	const toSourcePosition = (offset) => {
		const line = lineStarts.findLastIndex((lineStart) => lineStart <= offset);
		return { column: offset - lineStarts[line], line: line + 1 };
	};
	const toOffset = ({ column, line }) => lineStarts[line - 1] + column;
	const literals = literalRanges.map(({ end, start }) => ({
		end: toOffset(end),
		start: toOffset(start),
	}));
	const ignore = {
		file: false,
		lineRanges: [],
		nextTargets: new Map(),
		ranges: [],
	};
	let regionStart;

	commentPattern.lastIndex = 0;

	for (
		let match = commentPattern.exec(sourceText);
		match;
		match = commentPattern.exec(sourceText)
	) {
		const literal = literals.find(
			({ end, start }) => start <= match.index && match.index < end,
		);

		// Comment-like text inside a literal is not a comment; resume after it.
		if (literal) {
			commentPattern.lastIndex = literal.end;
			continue;
		}

		const directive = ignoreDirectivePattern.exec(match[1] ?? match[2]);

		if (!directive) {
			continue;
		}

		const [, kind, lineCount] = directive;
		const commentEnd = match.index + match[0].length;

		if (kind === "file") {
			ignore.file = true;
		} else if (kind === "start") {
			regionStart ??= toSourcePosition(commentEnd);
		} else if (kind === "stop" && regionStart) {
			ignore.ranges.push({
				end: toSourcePosition(match.index),
				start: regionStart,
			});
			regionStart = undefined;
		} else if (kind === "next" && lineCount) {
			// c8 style: the next N lines.
			const { line } = toSourcePosition(commentEnd);
			ignore.lineRanges.push([line + 1, line + Number(lineCount)]);
		} else if (kind === "next" || kind === "if" || kind === "else") {
			triviaPattern.lastIndex = commentEnd;
			triviaPattern.exec(sourceText);
			ignore.nextTargets.set(
				positionKey(toSourcePosition(triviaPattern.lastIndex)),
				kind,
			);
		}
	}

	if (regionStart) {
		ignore.ranges.push({
			end: { column: 0, line: Number.POSITIVE_INFINITY },
			start: regionStart,
		});
	}

	return ignore;
}

// Strings, templates, regex literals and JSX text can contain `/*` or `//`.
function collectLiteralRanges(adapter) {
	const { SyntaxKind, sourceFile } = adapter;
	const literalKinds = new Set([
		SyntaxKind.StringLiteral,
		SyntaxKind.NoSubstitutionTemplateLiteral,
		SyntaxKind.TemplateHead,
		SyntaxKind.TemplateMiddle,
		SyntaxKind.TemplateTail,
		SyntaxKind.RegularExpressionLiteral,
		SyntaxKind.JsxText,
	]);
	const ranges = [];

	function visit(node) {
		if (literalKinds.has(node.kind)) {
			ranges.push({
				end: toPosition(sourceFile, node.getEnd()),
				// JSX text has no leading trivia; its full start is its text.
				start: toPosition(
					sourceFile,
					node.kind === SyntaxKind.JsxText
						? node.pos
						: node.getStart(sourceFile),
				),
			});
		}

		adapter.forEachChild(node, visit);
	}

	visit(sourceFile);

	return ranges;
}

function isIgnored(ignore, position) {
	return (
		ignore.file ||
		ignore.ranges.some(
			(range) =>
				comparePositions(range.start, position) <= 0 &&
				comparePositions(position, range.end) < 0,
		) ||
		ignore.lineRanges.some(
			([first, last]) => position.line >= first && position.line <= last,
		)
	);
}

function positionKey({ column, line }) {
	return `${line}:${column}`;
}

function assertStatementsInSource(coverage, sourceText, filePath) {
	const lines = sourceText.split(lineTerminatorPattern);

	for (const { start } of Object.values(coverage.statementMap)) {
		const line = lines[start.line - 1];

		if (line === undefined || start.column > line.length) {
			throw new Error(
				`Coverage for ${filePath} does not match its current source (statement at ${start.line}:${start.column + 1}). Re-run coverage.`,
			);
		}
	}
}

function hasExecutableModuleStatements({ SyntaxKind, sourceFile }) {
	return hasExecutableStatements(SyntaxKind, sourceFile.statements);
}

function hasExecutableStatements(SyntaxKind, statements) {
	return statements.some((statement) => {
		if (
			statement.modifiers?.some(
				(modifier) => modifier.kind === SyntaxKind.DeclareKeyword,
			)
		) {
			return false;
		}

		switch (statement.kind) {
			case SyntaxKind.ImportEqualsDeclaration:
				return !statement.isTypeOnly;
			case SyntaxKind.ImportDeclaration:
				// Side-effect imports (`import "./x"`) run code; binding imports do not.
				return !statement.importClause;
			case SyntaxKind.ModuleDeclaration:
				// TypeScript emits a namespace only when its body has runtime code.
				return isExecutableNamespace(SyntaxKind, statement);
			case SyntaxKind.ExportDeclaration:
			case SyntaxKind.InterfaceDeclaration:
			case SyntaxKind.TypeAliasDeclaration:
			case SyntaxKind.FunctionDeclaration:
			case SyntaxKind.EmptyStatement:
				return false;
			default:
				return true;
		}
	});
}

function isExecutableNamespace(SyntaxKind, declaration) {
	const { body } = declaration;

	if (!body) {
		return false;
	}

	// `namespace A.B {}` nests one ModuleDeclaration per name.
	return body.kind === SyntaxKind.ModuleDeclaration
		? isExecutableNamespace(SyntaxKind, body)
		: hasExecutableStatements(SyntaxKind, body.statements);
}

function toPosition(sourceFile, offset) {
	const { character, line } = sourceFile.getLineAndCharacterOfPosition(offset);

	return { column: character, line: line + 1 };
}

function getFunctionName({ SyntaxKind, sourceFile }, node) {
	if (node.kind === SyntaxKind.Constructor) {
		return "constructor";
	}

	if (node.name) {
		return node.name.getText(sourceFile);
	}

	const parent = node.parent;

	if (
		(parent?.kind === SyntaxKind.VariableDeclaration ||
			parent?.kind === SyntaxKind.PropertyAssignment ||
			parent?.kind === SyntaxKind.PropertyDeclaration) &&
		parent.name
	) {
		return parent.name.getText(sourceFile);
	}

	return "<anonymous>";
}

function isFunctionLikeNode({ SyntaxKind }, node) {
	switch (node.kind) {
		case SyntaxKind.FunctionDeclaration:
		case SyntaxKind.FunctionExpression:
		case SyntaxKind.ArrowFunction:
		case SyntaxKind.MethodDeclaration:
		case SyntaxKind.Constructor:
		case SyntaxKind.GetAccessor:
		case SyntaxKind.SetAccessor:
			return true;
		default:
			return false;
	}
}

function forEachTs7Child(node, visitor) {
	ts7Ast.visitEachChild(node, visitor, null);
}

async function parseSourceFile({ filePath, sourceFilePath, sourceText }) {
	if (!ts7Ast) {
		return ts.createSourceFile(
			filePath,
			sourceText,
			ts.ScriptTarget.Latest,
			true,
		);
	}

	const { API } = await import("typescript/unstable/sync");
	const temporaryDirectory = mkdtempSync(join(tmpdir(), "crap-ts-"));
	const resolvedPath = join(
		temporaryDirectory,
		basename(sourceFilePath ?? filePath),
	);

	writeFileSync(resolvedPath, sourceText);

	const api = new API();

	try {
		const snapshot = api.updateSnapshot({ openFiles: [resolvedPath] });
		const project = snapshot.getDefaultProjectForFile(resolvedPath);
		const sourceFile = project?.program.getSourceFile(resolvedPath);

		if (!sourceFile) {
			throw new Error(`Unable to parse TypeScript source file: ${filePath}`);
		}

		return sourceFile;
	} finally {
		api.close();

		rmSync(temporaryDirectory, { force: true, recursive: true });
	}
}

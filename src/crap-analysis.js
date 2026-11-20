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
	const functions = collectFunctions(adapter, filePath);

	if (coverage) {
		assertStatementsInSource(coverage, sourceText, filePath);
		assignStatementCoverage(functions, coverage);
	}

	return {
		executable: functions.length > 0 || hasExecutableModuleStatements(adapter),
		functions: functions.map(({ risk }) => {
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

function collectFunctions(adapter, filePath) {
	const { sourceFile } = adapter;
	const functions = [];

	function visit(node) {
		if (isFunctionLikeNode(adapter, node) && node.body) {
			const start = toPosition(sourceFile, node.getStart(sourceFile));
			const end = toPosition(sourceFile, node.getEnd());

			functions.push({
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

	const countersByOwner = groupCountersBy(coverage.fnMap, (start) =>
		findOwner(functions, start),
	);
	// Per-line V8 converters place a function's counter at its first token.
	const countersAtStart = groupCountersBy(coverage.fnMap, (start) =>
		functions.findLast((fn) => comparePositions(fn.range.start, start) === 0),
	);

	for (const fn of functions) {
		const { risk } = fn;

		if (risk.statements > 0) {
			risk.coveragePercent = (risk.coveredStatements / risk.statements) * 100;
			risk.evidence = "statements";
			continue;
		}

		// A nested function's counter must never stand in for its parent's.
		const ownedCounters = countersByOwner.get(fn) ?? [];
		const counters =
			ownedCounters.length > 0
				? ownedCounters
				: (countersAtStart.get(fn) ?? []);

		if (counters.length === 1) {
			risk.coveragePercent = coverage.f[counters[0]] > 0 ? 100 : 0;
			risk.evidence = "function";
		} else if (counters.length === 0) {
			// Instrumented file, no counters: an ignore hint removed them.
			risk.evidence = "ignored";
		}
	}
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

function assertStatementsInSource(coverage, sourceText, filePath) {
	// The line terminators TypeScript and Babel recognise.
	const lines = sourceText.split(/\r\n|[\n\r\u2028\u2029]/);

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

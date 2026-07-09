import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import ts from "typescript";

import { calculateCrapScoreFromPercent } from "./crap-score.js";

export function extractCoverageFunctions(coverageJson) {
  const coverageByFile = new Map();

  for (const [filePath, coverage] of Object.entries(coverageJson)) {
    const functions = Object.entries(coverage.fnMap ?? {}).flatMap(([id, metadata]) => {
      const startLine = metadata.loc?.start?.line;
      const endLine = metadata.loc?.end?.line;

      if (!startLine || !endLine) {
        return [];
      }

      return [
        {
          coveragePercent: (coverage.f?.[id] ?? 0) > 0 ? 100 : 0,
          declarationLine: metadata.line ?? startLine,
          endLine,
          startLine,
        },
      ];
    });

    coverageByFile.set(filePath, functions);
  }

  return coverageByFile;
}

export async function analyzeFileRisk({
  coverageFunctions,
  filePath,
  minLines,
  sourceFilePath,
  sourceText,
}) {
  const adapter = await getTypescriptAdapter({ filePath, sourceFilePath, sourceText });
  const { sourceFile } = adapter;
  const risks = [];

  function visit(node) {
    if (isFunctionLikeNode(adapter, node) && node.body) {
      const startLine =
        sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
      const endLine = sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
      const lineCount = endLine - startLine + 1;

      if (lineCount >= minLines) {
        const complexity = calculateCyclomaticComplexity(node.body, adapter);
        const coveragePercent = getFunctionCoveragePercent({
          coverageFunctions,
          endLine,
          startLine,
        });

        risks.push({
          complexity,
          coveragePercent,
          crapScore: calculateCrapScoreFromPercent(complexity, coveragePercent),
          endLine,
          filePath,
          lineCount,
          name: getFunctionName(adapter, node, sourceFile),
          startLine,
        });
      }
    }

    adapter.forEachChild(node, visit);
  }

  visit(sourceFile);

  return risks;
}

export function formatRiskLine(risk) {
  return [
    `${risk.filePath}:${risk.startLine}`,
    risk.name,
    `CRAP ${risk.crapScore.toFixed(1)}`,
    `complexity ${risk.complexity}`,
    `coverage ${risk.coveragePercent.toFixed(0)}%`,
    `${risk.lineCount} lines`,
  ].join(" | ");
}

export function calculateCyclomaticComplexity(node, adapter = getTs5Adapter()) {
  let complexity = 1;

  function visit(child) {
    if (addsDecisionPath(adapter, child)) {
      complexity += 1;
    }

    adapter.forEachChild(child, visit);
  }

  visit(node);

  return complexity;
}

function addsDecisionPath(adapter, node) {
  if (
    adapter.isIfStatement(node) ||
    adapter.isForStatement(node) ||
    adapter.isForInStatement(node) ||
    adapter.isForOfStatement(node) ||
    adapter.isWhileStatement(node) ||
    adapter.isDoStatement(node) ||
    adapter.isCaseClause(node) ||
    adapter.isCatchClause(node) ||
    adapter.isConditionalExpression(node)
  ) {
    return true;
  }

  return (
    adapter.isBinaryExpression(node) &&
    (node.operatorToken.kind === adapter.SyntaxKind.AmpersandAmpersandToken ||
      node.operatorToken.kind === adapter.SyntaxKind.BarBarToken ||
      node.operatorToken.kind === adapter.SyntaxKind.QuestionQuestionToken)
  );
}

function getFunctionCoveragePercent({ coverageFunctions, endLine, startLine }) {
  const exactMatch = coverageFunctions.find(
    (coverageFunction) =>
      coverageFunction.declarationLine === startLine ||
      (coverageFunction.startLine === startLine && coverageFunction.endLine === endLine),
  );

  if (exactMatch) {
    return exactMatch.coveragePercent;
  }

  const containingMatch = coverageFunctions.find(
    (coverageFunction) =>
      (coverageFunction.declarationLine >= startLine &&
        coverageFunction.declarationLine <= endLine) ||
      (coverageFunction.startLine <= endLine && coverageFunction.endLine >= startLine),
  );

  return containingMatch?.coveragePercent ?? 0;
}

function getFunctionName(adapter, node, sourceFile) {
  if ((adapter.isFunctionDeclaration(node) || adapter.isFunctionExpression(node)) && node.name) {
    return node.name.getText(sourceFile);
  }

  if (adapter.isMethodDeclaration(node) && node.name) {
    return node.name.getText(sourceFile);
  }

  const parent = node.parent;

  if (adapter.isVariableDeclaration(parent) && parent.name) {
    return parent.name.getText(sourceFile);
  }

  if (adapter.isPropertyAssignment(parent) && parent.name) {
    return parent.name.getText(sourceFile);
  }

  return "<anonymous>";
}

function isFunctionLikeNode(adapter, node) {
  return (
    adapter.isFunctionDeclaration(node) ||
    adapter.isFunctionExpression(node) ||
    adapter.isArrowFunction(node) ||
    adapter.isMethodDeclaration(node)
  );
}

function getTs5Adapter() {
  return {
    ...ts,
    forEachChild: ts.forEachChild,
  };
}

async function getTypescriptAdapter({ filePath, sourceFilePath, sourceText }) {
  if (ts.createSourceFile) {
    return {
      ...getTs5Adapter(),
      sourceFile: ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true),
    };
  }

  const [{ API }, ast] = await Promise.all([
    import("typescript/unstable/sync"),
    import("typescript/unstable/ast"),
  ]);
  const temporaryDirectory = sourceFilePath ? null : mkdtempSync(join(tmpdir(), "crap-ts-"));
  const resolvedPath = sourceFilePath
    ? resolve(sourceFilePath)
    : join(temporaryDirectory, basename(filePath));

  if (temporaryDirectory) {
    writeFileSync(resolvedPath, sourceText);
  }

  const api = new API();

  try {
    const snapshot = api.updateSnapshot({ openFiles: [resolvedPath] });
    const project = snapshot.getDefaultProjectForFile(resolvedPath);
    const sourceFile = project?.program.getSourceFile(resolvedPath);

    if (!sourceFile) {
      throw new Error(`Unable to parse TypeScript source file: ${filePath}`);
    }

    return {
      ...ast,
      forEachChild(node, visitor) {
        ast.visitEachChild(node, visitor, null);
      },
      sourceFile,
    };
  } finally {
    api.close();

    if (temporaryDirectory) {
      rmSync(temporaryDirectory, { force: true, recursive: true });
    }
  }
}

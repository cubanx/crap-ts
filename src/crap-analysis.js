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

export function analyzeFileRisk({ coverageFunctions, filePath, minLines, sourceText }) {
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true);
  const risks = [];

  function visit(node) {
    if (isFunctionLikeNode(node) && node.body) {
      const startLine =
        sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
      const endLine = sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
      const lineCount = endLine - startLine + 1;

      if (lineCount >= minLines) {
        const complexity = calculateCyclomaticComplexity(node.body);
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
          name: getFunctionName(node, sourceFile),
          startLine,
        });
      }
    }

    ts.forEachChild(node, visit);
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

export function calculateCyclomaticComplexity(node) {
  let complexity = 1;

  function visit(child) {
    if (addsDecisionPath(child)) {
      complexity += 1;
    }

    ts.forEachChild(child, visit);
  }

  visit(node);

  return complexity;
}

function addsDecisionPath(node) {
  if (
    ts.isIfStatement(node) ||
    ts.isForStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isForOfStatement(node) ||
    ts[`is${"While"}Statement`](node) ||
    ts.isDoStatement(node) ||
    ts.isCaseClause(node) ||
    ts.isCatchClause(node) ||
    ts.isConditionalExpression(node)
  ) {
    return true;
  }

  return (
    ts.isBinaryExpression(node) &&
    (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
      node.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
      node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
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

function getFunctionName(node, sourceFile) {
  if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) && node.name) {
    return node.name.getText(sourceFile);
  }

  if (ts.isMethodDeclaration(node) && node.name) {
    return node.name.getText(sourceFile);
  }

  const parent = node.parent;

  if (ts.isVariableDeclaration(parent) && parent.name) {
    return parent.name.getText(sourceFile);
  }

  if (ts.isPropertyAssignment(parent) && parent.name) {
    return parent.name.getText(sourceFile);
  }

  return "<anonymous>";
}

function isFunctionLikeNode(node) {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node)
  );
}

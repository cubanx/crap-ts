import ts from "typescript";

export interface FunctionRisk {
  complexity: number;
  coveragePercent: number;
  crapScore: number;
  endLine: number;
  filePath: string;
  lineCount: number;
  name: string;
  startLine: number;
}

export interface CoverageFunction {
  coveragePercent: number;
  declarationLine: number;
  endLine: number;
  startLine: number;
}

export function extractCoverageFunctions(
  coverageJson: Record<string, unknown>,
): Map<string, CoverageFunction[]>;

export function analyzeFileRisk(input: {
  coverageFunctions: CoverageFunction[];
  filePath: string;
  minLines: number;
  sourceText: string;
}): FunctionRisk[];

export function formatRiskLine(risk: FunctionRisk): string;

export function calculateCyclomaticComplexity(node: ts.Node): number;

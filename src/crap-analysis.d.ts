interface SourcePosition {
	line: number;
	column: number;
}

interface SourceRange {
	start: SourcePosition;
	end: { line: number; column: number | null };
}

/** One file's entry from an Istanbul `coverage-final.json`. Branch data is ignored. */
export interface FileCoverage {
	statementMap: Record<string, SourceRange>;
	s: Record<string, number>;
	fnMap: Record<string, { loc: SourceRange }>;
	f: Record<string, number>;
}

export interface FunctionRisk {
	filePath: string;
	name: string;
	/** One-based line of the function's first token. */
	startLine: number;
	/** One-based column of the function's first token. */
	startColumn: number;
	endLine: number;
	lineCount: number;
	complexity: number;
	/** Percentage in [0, 100]. */
	coveragePercent: number;
	/** Statements whose start lies in this function and not in a nested one. */
	statements: number;
	coveredStatements: number;
	/** `statements`: owned statement counters; `function`: the function's own counter (no owned statements); `ignored`: no counter, under a coverage ignore comment; `missing`: no coverage for the file. */
	evidence: "statements" | "function" | "ignored" | "missing";
	crapScore: number;
}

/**
 * Score every function with a body in one source file.
 * Without `coverage`, every row reports `evidence: "missing"` and 0% coverage.
 */
export function analyzeFileRisk(input: {
	coverage?: FileCoverage;
	filePath: string;
	/** Drop functions shorter than this many lines. Defaults to 1. */
	minLines?: number;
	sourceFilePath?: string;
	sourceText: string;
}): Promise<FunctionRisk[]>;

/** 1 plus one per decision point in `node`, excluding nested functions. */
export function calculateCyclomaticComplexity(node: unknown): number;

export interface ComplexityMetric {
	file: string;
	name: string;
	complexity: number;
}

export interface CrapScore {
	file: string;
	name: string;
	complexity: number;
	coverage: number;
	crap: number;
}

export function calculateCrapScore(input: {
	complexity: number;
	coverage: number;
}): number;

export function calculateCrapScoreFromPercent(
	complexity: number,
	coveragePercent: number,
): number;

export function buildCrapScores(input: {
	coverageSummary: Record<string, unknown>;
	metrics: ComplexityMetric[];
}): CrapScore[];

export function getCoverageForFile(
	coverageSummary: Record<string, unknown>,
	file: string,
): number;

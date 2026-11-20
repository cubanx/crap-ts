/**
 * CRAP = complexity² × (1 − coverage/100)³ + complexity.
 * `coverage` is a percentage in [0, 100]; values outside are clamped.
 */
export function calculateCrapScore(input: {
	complexity: number;
	coverage: number;
}): number;

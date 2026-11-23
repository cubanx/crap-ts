export function calculateCrapScore({ complexity, coverage }) {
	assertFiniteNumber(complexity, "complexity");
	assertFiniteNumber(coverage, "coverage");

	const uncoveredRatio = 1 - clamp(coverage, 0, 100) / 100;
	return complexity ** 2 * uncoveredRatio ** 3 + complexity;
}

function clamp(value, min, max) {
	return Math.min(Math.max(value, min), max);
}

function assertFiniteNumber(value, label) {
	if (!Number.isFinite(value)) {
		throw new TypeError(`${label} must be a finite number.`);
	}
}

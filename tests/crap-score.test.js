import assert from "node:assert/strict";
import { test } from "node:test";

import { calculateCrapScore } from "../src/crap-score.js";

test("calculates CRAP from complexity and coverage percent", () => {
	assert.equal(calculateCrapScore({ complexity: 10, coverage: 100 }), 10);
	assert.equal(calculateCrapScore({ complexity: 10, coverage: 50 }), 22.5);
	assert.equal(calculateCrapScore({ complexity: 10, coverage: 0 }), 110);
});

test("rejects non-finite inputs", () => {
	assert.throws(
		() => calculateCrapScore({ complexity: Number.NaN, coverage: 0 }),
		/complexity must be a finite number/,
	);
});

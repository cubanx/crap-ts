import assert from "node:assert/strict";
import { test } from "node:test";

import { buildCrapScores, calculateCrapScore, getCoverageForFile } from "../src/crap-score.js";

test("calculates CRAP from complexity and coverage", () => {
  assert.equal(calculateCrapScore({ complexity: 10, coverage: 100 }), 10);
  assert.equal(calculateCrapScore({ complexity: 10, coverage: 0 }), 110);
});

test("reads file line coverage from coverage summary data", () => {
  const summary = {
    "/repo/src/example.ts": {
      lines: { pct: 87.5 },
    },
  };

  assert.equal(getCoverageForFile(summary, "src/example.ts"), 87.5);
});

test("builds rounded CRAP score rows", () => {
  const scores = buildCrapScores({
    coverageSummary: {
      "src/example.ts": {
        lines: { pct: 80 },
      },
    },
    metrics: [{ complexity: 12, file: "src/example.ts", name: "chooseValue" }],
  });

  assert.deepEqual(scores, [
    {
      complexity: 12,
      coverage: 80,
      crap: 13.15,
      file: "src/example.ts",
      name: "chooseValue",
    },
  ]);
});

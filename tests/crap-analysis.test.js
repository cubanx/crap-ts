import assert from "node:assert/strict";
import { test } from "node:test";

import { analyzeFileRisk, extractCoverageFunctions, formatRiskLine } from "../src/crap-analysis.js";

test("extracts function coverage from Istanbul coverage-final data", () => {
  const coverage = extractCoverageFunctions({
    "/tmp/example.ts": {
      f: { 0: 1, 1: 0 },
      fnMap: {
        0: { loc: { end: { line: 4 }, start: { line: 1 } } },
        1: { loc: { end: { line: 10 }, start: { line: 6 } } },
      },
    },
  });

  assert.deepEqual(coverage.get("/tmp/example.ts"), [
    { coveragePercent: 100, declarationLine: 1, endLine: 4, startLine: 1 },
    { coveragePercent: 0, declarationLine: 6, endLine: 10, startLine: 6 },
  ]);
});

test("analyzes complex uncovered functions", () => {
  const risks = analyzeFileRisk({
    coverageFunctions: [{ coveragePercent: 0, declarationLine: 2, endLine: 13, startLine: 2 }],
    filePath: "/tmp/example.ts",
    minLines: 1,
    sourceText: `
function choose(value) {
  if (value > 10) {
    return "big";
  }

  if (value > 0 && value < 5) {
    return "small";
  }

  return "other";
}
`,
  });

  assert.equal(risks[0].complexity, 4);
  assert.equal(risks[0].coveragePercent, 0);
  assert.equal(risks[0].name, "choose");
});

test("formats a risk line for terminal reports", () => {
  assert.equal(
    formatRiskLine({
      complexity: 4,
      coveragePercent: 0,
      crapScore: 20,
      endLine: 12,
      filePath: "src/example.ts",
      lineCount: 11,
      name: "choose",
      startLine: 2,
    }),
    "src/example.ts:2 | choose | CRAP 20.0 | complexity 4 | coverage 0% | 11 lines",
  );
});

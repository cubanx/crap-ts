export {
  analyzeFileRisk,
  type CoverageFunction,
  calculateCyclomaticComplexity,
  extractCoverageFunctions,
  type FunctionRisk,
  formatRiskLine,
} from "./crap-analysis.js";
export { type CrapAuditOptions, runCrapAudit } from "./crap-runner.js";
export {
  buildCrapScores,
  type ComplexityMetric,
  type CrapScore,
  calculateCrapScore,
  getCoverageForFile,
} from "./crap-score.js";

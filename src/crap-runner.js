import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

import { analyzeFileRisk, extractCoverageFunctions, formatRiskLine } from "./crap-analysis.js";

export function runCrapAudit({
  all = false,
  coverageCommand,
  coveragePath = "coverage/unit/coverage-final.json",
  cwd = process.cwd(),
  includes = [],
  limit = 20,
  maxScore = 30,
  minLines = 10,
  reportOnly = false,
  skipCoverage = false,
} = {}) {
  if (!skipCoverage && coverageCommand) {
    const result = spawnSync(coverageCommand, {
      cwd,
      shell: true,
      stdio: "inherit",
    });

    if (result.status !== 0) {
      return result.status ?? 1;
    }
  }

  const resolvedCoveragePath = resolve(cwd, coveragePath);

  if (!existsSync(resolvedCoveragePath)) {
    console.error(`Missing coverage JSON: ${resolvedCoveragePath}`);
    console.error("Run coverage first, pass --coverage, or use a valid --coverage-command.");
    return 1;
  }

  const coverageJson = JSON.parse(readFileSync(resolvedCoveragePath, "utf8"));
  const coverageByFile = extractCoverageFunctions(coverageJson);
  const risks = [];

  for (const [coverageFilePath, coverageFunctions] of coverageByFile.entries()) {
    if (!shouldIncludePath(coverageFilePath, includes)) {
      continue;
    }

    const sourceFilePath = isAbsolute(coverageFilePath)
      ? coverageFilePath
      : resolve(cwd, coverageFilePath);

    if (!existsSync(sourceFilePath)) {
      continue;
    }

    const sourceText = readFileSync(sourceFilePath, "utf8");
    const relativeFilePath = relative(cwd, sourceFilePath);

    risks.push(
      ...analyzeFileRisk({
        coverageFunctions,
        filePath: relativeFilePath,
        minLines,
        sourceText,
      }),
    );
  }

  const sortedRisks = risks.sort((left, right) => right.crapScore - left.crapScore);
  const failingRisks = sortedRisks.filter((risk) => risk.crapScore > maxScore);

  console.log("");
  console.log(
    `CRAP report: ${sortedRisks.length} functions checked, ${failingRisks.length} above ${maxScore}.`,
  );

  const printedRisks = all ? sortedRisks : sortedRisks.slice(0, limit);

  for (const risk of printedRisks) {
    console.log(formatRiskLine(risk));
  }

  if (failingRisks.length > 0 && !reportOnly) {
    console.error("");
    console.error(
      "CRAP check failed. Use --report-only while calibrating, or lower complexity / add coverage for the listed functions.",
    );
    return 1;
  }

  return 0;
}

function shouldIncludePath(filePath, includes) {
  if (includes.length === 0) {
    return true;
  }

  const normalizedPath = normalizePath(filePath);

  return includes.some((include) => normalizedPath.includes(normalizePath(include)));
}

function normalizePath(path) {
  return path.replaceAll("\\", "/");
}

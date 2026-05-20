export function calculateCrapScore({ complexity, coverage }) {
  assertFiniteNumber(complexity, "complexity");
  assertFiniteNumber(coverage, "coverage");

  const uncoveredRatio = 1 - clamp(coverage, 0, 100) / 100;
  return complexity ** 2 * uncoveredRatio ** 3 + complexity;
}

export function calculateCrapScoreFromPercent(complexity, coveragePercent) {
  return calculateCrapScore({ complexity, coverage: coveragePercent });
}

export function buildCrapScores({ coverageSummary, metrics }) {
  return metrics.map((metric) => {
    const coverage = getCoverageForFile(coverageSummary, metric.file);
    const score = calculateCrapScore({
      complexity: metric.complexity,
      coverage,
    });

    return {
      file: metric.file,
      name: metric.name,
      complexity: metric.complexity,
      coverage,
      crap: Number(score.toFixed(2)),
    };
  });
}

export function getCoverageForFile(coverageSummary, file) {
  const entry = findCoverageEntry(coverageSummary, file);

  if (!entry?.lines || typeof entry.lines.pct !== "number") {
    return 0;
  }

  return entry.lines.pct;
}

function findCoverageEntry(coverageSummary, file) {
  if (coverageSummary[file]) {
    return coverageSummary[file];
  }

  const normalizedFile = normalizePath(file);
  const match = Object.entries(coverageSummary).find(([key]) => {
    const normalizedKey = normalizePath(key);
    return normalizedKey === normalizedFile || normalizedKey.endsWith(`/${normalizedFile}`);
  });

  return match?.[1];
}

function normalizePath(path) {
  return path.replaceAll("\\", "/").replace(/^\.?\//, "");
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function assertFiniteNumber(value, label) {
  if (!Number.isFinite(value)) {
    throw new TypeError(`${label} must be a finite number.`);
  }
}

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { main, parseCliArgs } from "../src/cli.js";

test("score with metrics but no coverage file returns a usage error", () => {
  const messages = captureConsole(() => {
    assert.equal(main(["score", "--metrics", "missing.json"]), 2);
  });

  assert.deepEqual(messages.errors, [
    "CRAP scoring requires both --metrics and --coverage-file.",
  ]);
});

test("help subcommand prints help", () => {
  const messages = captureConsole(() => {
    assert.equal(main(["help"]), 0);
  });

  assert.match(messages.logs.join("\n"), /Usage:/);
  assert.match(messages.logs.join("\n"), /--coverage-file/);
});

test("parses direct audit flags", () => {
  const options = parseCliArgs([
    "score",
    "--coverage-file",
    "coverage/unit/coverage-final.json",
    "--include",
    "/app/",
    "--include",
    "/scripts/",
    "--all",
    "--report-only",
    "--max",
    "40",
  ]);

  assert.equal(options.command, "score");
  assert.equal(options.coveragePath, "coverage/unit/coverage-final.json");
  assert.deepEqual(options.includes, ["/app/", "/scripts/"]);
  assert.equal(options.all, true);
  assert.equal(options.reportOnly, true);
  assert.equal(options.maxScore, 40);
});

test("rejects non-numeric thresholds", () => {
  assert.throws(() => parseCliArgs(["score", "--max", "loud"]), /--max must be a finite number/);
});

test("loads default .crap-ts.json config", () => {
  const cwd = mkdtempSync(join(tmpdir(), "crap-cli-default-config-"));
  writeFileSync(
    join(cwd, ".crap-ts.json"),
    JSON.stringify({
      coverageCommand: "npm run coverage",
      coverageFile: "coverage/custom.json",
      include: ["src", "scripts"],
      limit: 7,
      max: 42,
      minLines: 3,
      reportOnly: true,
      skipCoverage: true,
    }),
  );

  const options = parseCliArgs(["score"], { cwd });

  rmSync(cwd, { force: true, recursive: true });

  assert.equal(options.coverageCommand, "npm run coverage");
  assert.equal(options.coveragePath, "coverage/custom.json");
  assert.deepEqual(options.includes, ["src", "scripts"]);
  assert.equal(options.limit, 7);
  assert.equal(options.maxScore, 42);
  assert.equal(options.minLines, 3);
  assert.equal(options.reportOnly, true);
  assert.equal(options.skipCoverage, true);
});

test("loads explicit config path", () => {
  const cwd = mkdtempSync(join(tmpdir(), "crap-cli-explicit-config-"));
  writeFileSync(
    join(cwd, "crap-config.json"),
    JSON.stringify({
      coverageFile: "coverage/explicit.json",
      include: "src",
    }),
  );

  const options = parseCliArgs(["score", "--config", "crap-config.json"], { cwd });

  rmSync(cwd, { force: true, recursive: true });

  assert.equal(options.coveragePath, "coverage/explicit.json");
  assert.deepEqual(options.includes, ["src"]);
});

test("CLI flags override config values", () => {
  const cwd = mkdtempSync(join(tmpdir(), "crap-cli-override-config-"));
  writeFileSync(
    join(cwd, ".crap-ts.json"),
    JSON.stringify({
      coverageFile: "coverage/from-config.json",
      include: ["from-config"],
      max: 30,
    }),
  );

  const options = parseCliArgs(
    [
      "score",
      "--coverage-file",
      "coverage/from-cli.json",
      "--include",
      "from-cli",
      "--max",
      "10",
    ],
    { cwd },
  );

  rmSync(cwd, { force: true, recursive: true });

  assert.equal(options.coveragePath, "coverage/from-cli.json");
  assert.deepEqual(options.includes, ["from-cli"]);
  assert.equal(options.maxScore, 10);
});

function captureConsole(callback) {
  const logs = [];
  const errors = [];
  const originalLog = console.log;
  const originalError = console.error;

  console.log = (...args) => logs.push(args.join(" "));
  console.error = (...args) => errors.push(args.join(" "));

  try {
    callback();
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }

  return { errors, logs };
}

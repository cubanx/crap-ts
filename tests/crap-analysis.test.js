import assert from "node:assert/strict";
import { test } from "node:test";
import ts from "typescript";
import {
	analyzeFileRisk,
	analyzeSource,
	calculateCyclomaticComplexity,
} from "../src/crap-analysis.js";

const location = (line, start = 0, end = 100) => ({
	end: { column: end, line },
	start: { column: start, line },
});

function coverage({ fnMap = {}, f = {}, statements = [] } = {}) {
	return {
		f,
		fnMap,
		s: Object.fromEntries(statements.map(([, count], id) => [id, count])),
		statementMap: Object.fromEntries(statements.map(([loc], id) => [id, loc])),
	};
}

test("maps owned statement counters to function coverage", async () => {
	const [risk] = await analyzeFileRisk({
		coverage: coverage({
			statements: [
				[location(2, 1, 21), 1],
				[location(3, 1, 10), 0],
			],
		}),
		filePath: "sisko.ts",
		sourceText:
			"function sisko(ready: boolean) {\n if (ready) return 1;\n return 0;\n}",
	});

	assert.equal(risk.name, "sisko");
	assert.equal(risk.complexity, 2);
	assert.equal(risk.coveragePercent, 50);
	assert.equal(risk.crapScore, 2.5);
	assert.equal(risk.statements, 2);
	assert.equal(risk.coveredStatements, 1);
	assert.equal(risk.evidence, "statements");
	assert.equal(risk.startLine, 1);
	assert.equal(risk.startColumn, 1);
});

test("isolates nested function complexity and statement ownership", async () => {
	const risks = await analyzeFileRisk({
		coverage: coverage({
			statements: [
				[location(3, 1, 10), 1],
				[location(4, 1, 10), 0],
				[location(6, 1, 10), 1],
			],
		}),
		filePath: "sisko.ts",
		sourceText:
			"function sisko() {\n function dax() {\n if (true) return 1;\n return 0;\n }\n return dax();\n}",
	});

	assert.deepEqual(
		risks.map(({ complexity, coveragePercent, name }) => ({
			complexity,
			coveragePercent,
			name,
		})),
		[
			{ complexity: 1, coveragePercent: 100, name: "sisko" },
			{ complexity: 2, coveragePercent: 50, name: "dax" },
		],
	);
});

test("falls back to the function counter when a function owns no statements", async () => {
	const [risk] = await analyzeFileRisk({
		coverage: coverage({
			f: { 0: 1 },
			fnMap: { 0: { loc: location(1, 15, 17) } },
		}),
		filePath: "dax.ts",
		sourceText: "function dax() {}",
	});

	assert.equal(risk.coveragePercent, 100);
	assert.equal(risk.evidence, "function");
});

test("never uses a nested function's counter for its parent", async () => {
	const [parent, child] = await analyzeFileRisk({
		coverage: coverage({
			f: { 0: 1 },
			fnMap: { 0: { loc: location(1, 30, 32) } },
		}),
		filePath: "odo.ts",
		sourceText: "function odo() { return () => {}; }",
	});

	assert.equal(parent.evidence, "missing");
	assert.equal(child.evidence, "function");
});

test("keeps uninstrumented functions visible with pessimistic risk", async () => {
	const [risk] = await analyzeFileRisk({
		filePath: "quark.ts",
		sourceText: "const quark = (latinum: boolean) => latinum ? 1 : 0;",
	});

	assert.equal(risk.name, "quark");
	assert.equal(risk.complexity, 2);
	assert.equal(risk.coveragePercent, 0);
	assert.equal(risk.crapScore, 6);
	assert.equal(risk.evidence, "missing");
});

test("rejects coverage that does not match the current source", async () => {
	await assert.rejects(
		analyzeFileRisk({
			coverage: coverage({ statements: [[location(9, 1, 10), 1]] }),
			filePath: "garak.ts",
			sourceText: "function garak() {\n return 1;\n}",
		}),
		/Coverage for garak\.ts does not match its current source/,
	);
});

test("counts loops, catches, switch cases, logical operators and defaults", async () => {
	const [risk] = await analyzeFileRisk({
		filePath: "odo.ts",
		sourceText:
			"function odo(a = 1) { try { for (;a;) { if ((a && a || a) ?? a) a--; } switch(a) { case 1: break; default: break; } } catch { return 0; } }",
	});

	assert.equal(risk.complexity, 9);
});

test("counts logical assignment and destructuring defaults", async () => {
	const [risk] = await analyzeFileRisk({
		filePath: "kira.ts",
		sourceText: `function kira(options, [first = 0] = []) {
	const { rank = "major" } = options;
	({ sector = 1 } = options);
	options.a &&= 1;
	options.b ||= 2;
	options.c ??= 3;
}`,
	});

	// 1 + param default + array default + rank + sector + three assignments.
	assert.equal(risk.complexity, 8);
});

test("does not count else, finally, optional chaining or type-level conditionals", async () => {
	const [risk] = await analyzeFileRisk({
		filePath: "bashir.ts",
		sourceText: `function bashir(patient?: { name?: string }) {
	type Name<T> = T extends string ? T : never;
	if (patient?.name) {
		return patient.name;
	} else {
		try {
			return "unknown";
		} finally {
			patient = undefined;
		}
	}
}`,
	});

	assert.equal(risk.complexity, 2);
});

test("names methods, constructors, accessors and anonymous functions", async () => {
	const risks = await analyzeFileRisk({
		filePath: "station.ts",
		sourceText: `
class Station {
  constructor(private sector: number) {}
  get name() { return "Deep Space Nine"; }
  set name(value) {}
  dock(value) {
    return value ? "yes" : "no";
  }
  overload(): void;
  overload() {}
}

export default function (value) {
  return value || "fallback";
}
`,
	});

	assert.deepEqual(
		risks.map((risk) => risk.name),
		["constructor", "name", "name", "dock", "overload", "<anonymous>"],
	);
});

test("filters rows below minLines but keeps ownership for short functions", async () => {
	const risks = await analyzeFileRisk({
		coverage: coverage({
			statements: [
				[location(2, 1, 33), 1],
				[location(2, 21, 30), 0],
				[location(3, 1, 10), 0],
			],
		}),
		filePath: "rom.ts",
		minLines: 3,
		sourceText:
			"function rom() {\n const nog = () => { return 1; };\n return nog;\n}",
	});

	assert.equal(risks.length, 1);
	assert.equal(risks[0].name, "rom");
	// The filtered `nog` arrow still owns its `return 1` statement.
	assert.equal(risks[0].statements, 2);
});

test("classifies declaration-only modules as not executable", async () => {
	const executable = async (sourceText) =>
		(await analyzeSource({ filePath: "module.ts", sourceText })).executable;

	assert.equal(await executable('export { worf } from "./klingon";'), false);
	assert.equal(await executable('export type { Rank } from "./types";'), false);
	assert.equal(
		await executable("export declare const station: string;"),
		false,
	);
	assert.equal(await executable('import { helper } from "./helper";'), false);
	assert.equal(
		await executable("export interface Odo { form: string }"),
		false,
	);
	assert.equal(await executable('import "./runtime-side-effect";'), true);
	assert.equal(await executable("const plugin = registerGuard();"), true);
	assert.equal(await executable("function untested() { return true; }"), true);
});

test("calculates complexity for a function body node", () => {
	const sourceFile = ts.createSourceFile(
		"/tmp/example.ts",
		`
function choose(value, list) {
  while (value > 0) {
    value -= 1;
  }

  for (const item of list) {
    try {
      if (item.enabled && (item.name || item.alias ?? value)) {
        return item.name ? item.name : "fallback";
      }
    } catch {
      return "error";
    }
  }

  return list.map((entry) => entry ? 1 : 0);
}
`,
		ts.ScriptTarget.Latest,
		true,
	);

	assert.equal(calculateCyclomaticComplexity(sourceFile.statements[0].body), 9);
	assert.equal(calculateCyclomaticComplexity(sourceFile.statements[0]), 9);
});

test("leaves statements that start at a function's own first token to the enclosing scope", async () => {
	// Positions from istanbul-lib-instrument: the declarator counter (s0, s4)
	// starts at the arrow itself, and the curried outer arrow's rewritten
	// `return` (s5) and its function body (f1) start at the inner arrow.
	const sourceText = `export const handler = (x: number) => {
  if (x) {
    return 1;
  }
  return 2;
};
export const make = (a: number) => (b: number) => {
  return a + b;
};
`;
	const statementMap = {
		0: location(1, 23, 1),
		1: location(2, 2, 3),
		2: location(3, 4, 13),
		3: location(5, 2, 11),
		4: location(7, 20, 1),
		5: location(7, 35, 1),
		6: location(8, 2, 15),
	};
	const fnMap = {
		0: { loc: location(1, 38, 1) },
		1: { loc: location(7, 35, 1) },
		2: { loc: location(7, 50, 1) },
	};
	const moduleLoadOnly = await analyzeFileRisk({
		coverage: {
			f: { 0: 0, 1: 0, 2: 0 },
			fnMap,
			s: { 0: 1, 1: 0, 2: 0, 3: 0, 4: 1, 5: 0, 6: 0 },
			statementMap,
		},
		filePath: "garak.ts",
		sourceText,
	});
	const fullyCovered = await analyzeFileRisk({
		coverage: {
			f: { 0: 1, 1: 1, 2: 1 },
			fnMap,
			s: { 0: 1, 1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1 },
			statementMap,
		},
		filePath: "garak.ts",
		sourceText,
	});
	const summarize = (risks) =>
		risks.map(({ coveredStatements, evidence, name, statements }) => [
			name,
			statements,
			coveredStatements,
			evidence,
		]);

	assert.deepEqual(summarize(moduleLoadOnly), [
		["handler", 3, 0, "statements"],
		["make", 1, 0, "statements"],
		["<anonymous>", 1, 0, "statements"],
	]);
	assert.deepEqual(summarize(fullyCovered), [
		["handler", 3, 3, "statements"],
		["make", 1, 1, "statements"],
		["<anonymous>", 1, 1, "statements"],
	]);
});

test("keeps a curried arrow's body counter with the outer arrow inside an object literal", async () => {
	const [outer, inner] = await analyzeFileRisk({
		coverage: {
			f: { 0: 1, 1: 1 },
			fnMap: { 0: { loc: location(1, 34, 1) }, 1: { loc: location(1, 41, 1) } },
			s: {},
			statementMap: {},
		},
		filePath: "nog.ts",
		sourceText: "export const api = { make: (a) => (b) => {} };",
	});

	assert.equal(outer.evidence, "function");
	assert.equal(inner.evidence, "function");
});

export interface CrapAuditOptions {
	all?: boolean;
	coverageCommand?: string;
	/** Istanbul `coverage-final.json` files, merged by source position. Defaults to `["coverage/unit/coverage-final.json"]`. */
	coveragePaths?: string[];
	cwd?: string;
	/** Skip source files whose path contains any of these substrings. */
	excludes?: string[];
	/** Only analyze source files whose path contains one of these substrings. */
	includes?: string[];
	/** Print the JSON report (schema version 1) to stdout instead of the text report. */
	json?: boolean;
	limit?: number;
	maxScore?: number;
	minLines?: number;
	reportOnly?: boolean;
	skipCoverage?: boolean;
	/** Report, without failing, functions whose CRAP score is above this and at or below `maxScore`. */
	warnScore?: number;
}

/**
 * Resolves to the process exit code: 0 pass, 1 gate failure, failed coverage command or missing coverage file, 2 usage error (including non-finite numeric options).
 * Rejects when coverage or source input is malformed or stale.
 */
export function runCrapAudit(options?: CrapAuditOptions): Promise<number>;

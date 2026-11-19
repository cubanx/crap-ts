export interface CrapAuditOptions {
	all?: boolean;
	coverageCommand?: string;
	coveragePath?: string;
	cwd?: string;
	includes?: string[];
	limit?: number;
	maxScore?: number;
	minLines?: number;
	reportOnly?: boolean;
	skipCoverage?: boolean;
	/** Report, without failing, functions whose CRAP score is above this and at or below `maxScore`. */
	warnScore?: number;
}

export function runCrapAudit(options?: CrapAuditOptions): Promise<number>;

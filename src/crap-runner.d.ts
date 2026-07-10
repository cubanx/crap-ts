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
}

export function runCrapAudit(options?: CrapAuditOptions): Promise<number>;

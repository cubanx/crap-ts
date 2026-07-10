export function riskyDecision(value: number, flags: string[]): string {
	if (value > 100 && flags.includes("vip")) {
		return "vip-high";
	}

	if (value > 75 || flags.includes("manual-review")) {
		return "review";
	}

	if (value > 50) {
		return flags.includes("trusted") ? "trusted-medium" : "medium";
	}

	if (value > 0) {
		return "low";
	}

	return flags.length > 0 ? "flagged-empty" : "empty";
}

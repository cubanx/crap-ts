export function classifySignal(input: {
	active: boolean;
	score: number;
	tags: string[];
}): string {
	if (!input.active) {
		return "inactive";
	}

	if (input.score > 90) {
		if (input.tags.includes("verified")) {
			return "verified-high";
		}

		if (input.tags.includes("manual-review")) {
			return "review-high";
		}

		return "high";
	}

	if (input.score > 60) {
		return input.tags.length > 2 ? "busy-medium" : "medium";
	}

	return "low";
}

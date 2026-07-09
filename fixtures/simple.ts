export function describeCount(count: number): string {
	if (count === 0) {
		return "none";
	}

	return count === 1 ? "one" : "many";
}

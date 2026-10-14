/**
 * Which of `count` highlights (in document order) `] h` / `[ h` go to (`by` 1 / -1): after
 * `current`, the one gone to last, while the view hasn't moved since; otherwise the first starting
 * below `ref` (the line a jump puts a highlight on), or the last starting above it. `top(i)` is
 * where highlight `i` starts on screen (growing in document order). null: none that way.
 */
export function stepHighlight(count: number, by: 1 | -1, current: number | null, top: (i: number) => number, ref: number): number | null {
	if (current !== null) {
		const i = current + by;
		return i >= 0 && i < count ? i : null;
	}
	/** The first highlight whose top passes `test` (`count` if none); after it, every one does */
	const first = (test: (top: number) => boolean) => {
		let lo = 0;
		let hi = count;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (test(top(mid))) hi = mid;
			else lo = mid + 1;
		}
		return lo;
	};
	// A pixel either way: one sitting on the line is where the view is, not ahead of it
	if (by > 0) {
		const i = first((t) => t > ref + 1);
		return i < count ? i : null;
	}
	const i = first((t) => t >= ref - 1) - 1;
	return i >= 0 ? i : null;
}

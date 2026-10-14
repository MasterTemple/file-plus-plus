/** A place in a document: its path and a locator. */
export interface Place {
	path: string;
	locator: string;
}

const same = (a: Place, b: Place) => a.path === b.path && a.locator === b.locator;

/**
 * Vim's jump list: places jumped from, oldest first, each once (at its latest). `back` / `forward`
 * (Ctrl+O / Ctrl+I) go through it; leaving its end first adds where you are, to come back to.
 * No dependency on Obsidian (unit tested).
 */
export class JumpList {
	private list: Place[] = [];
	/** Where back / forward have got to; `list.length` while not going through the list. */
	private index = 0;

	constructor(private max = 100) {}

	private add(place: Place): void {
		this.list = this.list.filter((p) => !same(p, place));
		this.list.push(place);
		if (this.list.length > this.max) this.list.shift();
	}

	/** About to jump from `place`. */
	jumpedFrom(place: Place): void {
		this.add(place);
		this.index = this.list.length;
	}

	/** Where Ctrl+O goes from `current`, if anywhere. */
	back(current: Place | null): Place | null {
		if (this.index === this.list.length) {
			if (!this.list.length) return null;
			if (current) this.add(current);
			const at = this.list.length - 2;
			if (at < 0) return null;
			this.index = at;
			return this.list[at];
		}
		if (this.index === 0) return null;
		return this.list[--this.index];
	}

	/** Where Ctrl+I goes, if anywhere. */
	forward(): Place | null {
		if (this.index >= this.list.length - 1) return null;
		return this.list[++this.index];
	}
}

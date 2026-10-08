/**
 * Placing annotations in an annotation file (pure text logic, no Obsidian imports).
 *
 * An annotation file has a heading per TOC entry, each linking to its position (a point locator). A
 * new annotation goes into the section whose heading is the last one at or before the selection, and
 * inside that section between the blocks (blank-line separated) before and after it in the document.
 *
 * Positions are compared through keys the format defines (`PositionScheme`); `keyOf` finds the key of
 * the first locator in some markdown (and may resolve text fragments through a reader).
 */

export interface Block {
	/** First and last line index (inclusive). */
	start: number;
	end: number;
	text: string;
}

export interface Heading<K> {
	line: number;
	level: number;
	text: string;
	key: K | null;
}

/** The position of the first locator in some markdown, or null. */
export type KeyOf<K> = (markdown: string) => K | null;

export interface Ordering<K> {
	keyOf: KeyOf<K>;
	compare(a: K, b: K): number;
}

/** Index of the first line after YAML frontmatter (0 when there is none). */
export function frontmatterEnd(lines: string[]): number {
	if (lines[0]?.trim() !== '---') return 0;
	for (let i = 1; i < lines.length; i++) if (lines[i].trim() === '---') return i + 1;
	return 0;
}

/** Visible text of a heading (link aliases instead of link targets). */
export function headingLabel(text: string): string {
	return text
		.replace(/\[\[[^\]|]*\|([^\]]*)\]\]/g, '$1')
		.replace(/\[\[([^\]]*)\]\]/g, '$1')
		.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
		.trim();
}

export function parseHeadings<K>(lines: string[], from = 0, keyOf: KeyOf<K> = () => null): Heading<K>[] {
	const out: Heading<K>[] = [];
	let fence = false;
	for (let i = from; i < lines.length; i++) {
		if (/^\s*(```|~~~)/.test(lines[i])) fence = !fence;
		if (fence) continue;
		const m = /^(#{1,6})\s+(.*)$/.exec(lines[i]);
		if (!m) continue;
		out.push({ line: i, level: m[1].length, text: m[2], key: keyOf(m[2]) });
	}
	return out;
}

/** Blank-line separated blocks in [from, to). */
export function blocksIn(lines: string[], from: number, to: number): Block[] {
	const out: Block[] = [];
	let start = -1;
	for (let i = from; i <= to; i++) {
		const blank = i === to || lines[i].trim() === '';
		if (!blank && start === -1) start = i;
		if (blank && start !== -1) {
			out.push({ start, end: i - 1, text: lines.slice(start, i).join('\n') });
			start = -1;
		}
	}
	return out;
}

export interface Placement {
	/** Line index to insert before. */
	line: number;
	/** Label of the section heading, or null when inserted outside any heading. */
	heading: string | null;
	/** True when the position inside the section was unclear and the block was appended. */
	appended: boolean;
}

/** Where to insert an annotation for a selection starting at `sel`. */
export function findPlacement<K>(lines: string[], sel: K, order: Ordering<K>): Placement {
	const { compare } = order;
	const fm = frontmatterEnd(lines);
	const headings = parseHeadings(lines, fm, order.keyOf);

	// Section: the heading with the greatest position at or before the selection.
	let chosen = -1;
	for (let i = 0; i < headings.length; i++) {
		const k = headings[i].key;
		if (k !== null && compare(k, sel) <= 0 && (chosen === -1 || compare(k, headings[chosen].key!) >= 0)) chosen = i;
	}
	let from: number;
	let to: number;
	if (chosen === -1) {
		from = fm;
		// Before the first chapter heading, or the whole file when no heading has a position.
		const firstKeyed = headings.find((h) => h.key !== null);
		to = firstKeyed ? headings[0].line : lines.length;
	} else {
		from = headings[chosen].line + 1;
		to = headings[chosen + 1]?.line ?? lines.length;
	}
	const heading = chosen === -1 ? null : headingLabel(headings[chosen].text);

	// Position inside the section: binary search over blocks by their locator.
	const blocks = blocksIn(lines, from, to);
	const keys = new Map<number, K | null>();
	const keyOf = (i: number): K | null => {
		if (!keys.has(i)) keys.set(i, order.keyOf(blocks[i].text));
		return keys.get(i)!;
	};
	let lo = 0;
	let hi = blocks.length;
	let unclear = false;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		const k = keyOf(mid);
		if (k === null) {
			unclear = true;
			break;
		}
		if (compare(k, sel) <= 0) lo = mid + 1;
		else hi = mid;
	}
	const idx = unclear ? blocks.length : lo;
	const line = idx < blocks.length ? blocks[idx].start : blocks.length ? blocks[blocks.length - 1].end + 1 : from;
	return { line, heading, appended: unclear };
}

/** Insert `block` (markdown) at a line, keeping one blank line around it. */
export function insertAt(lines: string[], line: number, block: string): string[] {
	const before = lines.slice(0, line);
	const after = lines.slice(line);
	while (before.length && before[before.length - 1].trim() === '' && before.length > 0) before.pop();
	while (after.length && after[0].trim() === '') after.shift();
	const out = [...before];
	if (out.length) out.push('');
	out.push(...block.replace(/\s+$/, '').split('\n'));
	if (after.length) out.push('', ...after);
	else out.push('');
	return out;
}

export function insertAnnotation<K>(data: string, sel: K, block: string, order: Ordering<K>): { data: string; placement: Placement } {
	const lines = data.split('\n');
	const placement = findPlacement(lines, sel, order);
	return { data: insertAt(lines, placement.line, block).join('\n'), placement };
}

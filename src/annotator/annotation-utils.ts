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

/** Top-level keys of YAML frontmatter lines (`key:` at the start of a line). */
function frontmatterEntries(lines: string[]): { key: string; lines: string[] }[] {
	const out: { key: string; lines: string[] }[] = [];
	for (const line of lines) {
		const m = /^([^\s#-][^:]*):/.exec(line);
		if (m) out.push({ key: m[1].trim(), lines: [line] });
		else if (out.length) out[out.length - 1].lines.push(line);
	}
	return out;
}

/**
 * Merge annotation file `other` into `base` (both texts of annotation files of one document): blocks
 * of `other` not already in `base` (same text) go to their place by position, or, without one, to the
 * end of the section with the same heading (the end of the file when `base` has none, under that
 * heading). Frontmatter keys only `other` has are added. Returns `base` unchanged when nothing is new.
 */
export function mergeAnnotationText<K>(base: string, other: string, order: Ordering<K>): string {
	let lines = base.split('\n');
	const otherLines = other.split('\n');
	const baseFm = frontmatterEnd(lines);
	const otherFm = frontmatterEnd(otherLines);

	// Frontmatter: keys of `other` that `base` lacks.
	if (otherFm) {
		const have = new Set(frontmatterEntries(lines.slice(1, baseFm - 1)).map((e) => e.key));
		const extra = frontmatterEntries(otherLines.slice(1, otherFm - 1)).filter((e) => !have.has(e.key)).flatMap((e) => e.lines);
		if (extra.length) lines = baseFm ? [...lines.slice(0, baseFm - 1), ...extra, ...lines.slice(baseFm - 1)] : ['---', ...extra, '---', ...lines];
	}

	const norm = (text: string) => text.trim().replace(/[ \t]+$/gm, '');
	const existing = new Set(blocksIn(lines, frontmatterEnd(lines), lines.length).map((b) => norm(b.text)));
	const isHeading = (b: Block) => /^#{1,6}\s/.test(b.text) && !b.text.includes('\n');

	// The blocks of `other`, each with the label of its section (null: before the first heading).
	const headings = parseHeadings(otherLines, otherFm);
	const sections: { label: string | null; heading: string | null; from: number; to: number }[] = [
		{ label: null, heading: null, from: otherFm, to: headings[0]?.line ?? otherLines.length },
		...headings.map((h, i) => ({ label: headingLabel(h.text), heading: otherLines[h.line], from: h.line + 1, to: headings[i + 1]?.line ?? otherLines.length })),
	];
	/** Sections `base` lacks, appended at the end: heading line and blocks. */
	const added = new Map<string, string[]>();
	for (const section of sections) {
		for (const block of blocksIn(otherLines, section.from, section.to)) {
			const text = norm(block.text);
			if (isHeading(block) || existing.has(text)) continue;
			existing.add(text);
			const key = order.keyOf(text);
			if (key !== null) {
				lines = insertAnnotation(lines.join('\n'), key, text, order).data.split('\n');
				continue;
			}
			const own = parseHeadings(lines, frontmatterEnd(lines));
			let at: number | null = null;
			if (section.label === null) at = own[0]?.line ?? lines.length;
			else {
				const i = own.findIndex((h) => headingLabel(h.text) === section.label);
				if (i !== -1) {
					// After the section's last block.
					at = own[i + 1]?.line ?? lines.length;
					while (at > own[i].line + 1 && lines[at - 1].trim() === '') at--;
				}
			}
			if (at !== null) lines = insertAt(lines, at, text);
			else {
				const list = added.get(section.heading!) ?? [];
				list.push(text);
				added.set(section.heading!, list);
			}
		}
	}
	for (const [heading, blocks] of added) lines = insertAt(lines, lines.length, [heading, ...blocks].join('\n\n'));
	return lines.join('\n');
}

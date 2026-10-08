import type { LocatorScheme } from './locator';

/**
 * Line/column locators for line-based documents (plain text, code, subtitles…), GitHub style:
 * `L12` (a line), `L12-L14` (lines), `L12C5-L14C3` (from line 12, column 5 through line 14, column 3).
 * Lines and columns count from 1; the end column is included.
 *
 * A reader using them renders each line as an element with `data-fpp-line="<n>"` holding exactly
 * that line's text (see `resolveLines` / `linesFromRange`).
 */
export interface LinePosition {
	line: number;
	/** 1-based; null for "the whole line" (start of line at the start, end of line at the end). */
	column: number | null;
}

export interface LineLocator {
	start: LinePosition;
	end: LinePosition;
}

const LINE_RE = /^L(\d+)(?:C(\d+))?(?:-L?(\d+)(?:C(\d+))?)?/;

export const lineScheme: LocatorScheme = {
	id: 'line',
	match(s) {
		const m = LINE_RE.exec(s);
		return m ? { locator: m[0], rest: s.slice(m[0].length) } : null;
	},
	isRange: () => true,
};

export function parseLineLocator(s: string): LineLocator | null {
	const m = LINE_RE.exec(s);
	if (!m) return null;
	const start = { line: Number(m[1]), column: m[2] ? Number(m[2]) : null };
	const end = m[3] ? { line: Number(m[3]), column: m[4] ? Number(m[4]) : null } : { line: start.line, column: m[2] && !m[3] ? start.column : null };
	if (start.line < 1 || end.line < start.line) return null;
	return { start, end };
}

export function formatLineLocator(loc: LineLocator): string {
	const pos = (p: LinePosition) => `L${p.line}${p.column !== null ? `C${p.column}` : ''}`;
	const same = loc.start.line === loc.end.line && loc.start.column === null && loc.end.column === null;
	return same ? pos(loc.start) : `${pos(loc.start)}-${pos(loc.end)}`;
}

/** Elements of the rendered lines, by line number. */
function lineElement(root: ParentNode, line: number): Element | null {
	return root.querySelector(`[data-fpp-line="${line}"]`);
}

/** The text node and offset at a 0-based character offset inside an element (clamped). */
function pointIn(el: Element, offset: number): { node: Node; offset: number } {
	const walker = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT);
	let last: Text | null = null;
	for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
		if (offset <= n.length) return { node: n, offset };
		offset -= n.length;
		last = n;
	}
	return last ? { node: last, offset: last.length } : { node: el, offset: el.childNodes.length };
}

/** The DOM range of a line locator, or null when its lines aren't rendered. */
export function resolveLines(root: ParentNode, loc: LineLocator, doc: Document): Range | null {
	const a = lineElement(root, loc.start.line);
	const b = lineElement(root, loc.end.line);
	if (!a || !b) return null;
	const range = doc.createRange();
	const s = pointIn(a, loc.start.column === null ? 0 : loc.start.column - 1);
	range.setStart(s.node, s.offset);
	if (loc.end.column === null) range.setEnd(b, b.childNodes.length);
	else {
		const e = pointIn(b, loc.end.column);
		range.setEnd(e.node, e.offset);
	}
	return range;
}

/** The line locator of a range over rendered lines (whole lines are written without columns). */
export function linesFromRange(range: Range): LineLocator | null {
	const pos = (node: Node, offset: number, isEnd: boolean): LinePosition | null => {
		const el = (node.nodeType === 1 ? (node as Element) : node.parentElement)?.closest('[data-fpp-line]');
		if (!el) return null;
		const before = el.ownerDocument.createRange();
		before.selectNodeContents(el);
		before.setEnd(node, offset);
		const chars = before.toString().length;
		const length = el.textContent?.length ?? 0;
		const line = Number(el.getAttribute('data-fpp-line'));
		if (!isEnd && chars === 0) return { line, column: null };
		if (isEnd && chars >= length) return { line, column: null };
		return { line, column: isEnd ? chars : chars + 1 };
	};
	const start = pos(range.startContainer, range.startOffset, false);
	const end = range.collapsed ? start : pos(range.endContainer, range.endOffset, true);
	return start && end ? { start, end } : null;
}

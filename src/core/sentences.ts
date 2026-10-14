/** Sentences within a block of text: what a triple click selects. */

/** Spans [start, end) of a text that are note references (footnote markers), not part of the sentence's words */
export type NoteSpans = [number, number][];

/** Where each sentence of `text` starts, and its end (exclusive). A note reference after a sentence's end belongs to it. */
export function sentenceBounds(text: string, lang?: string, notes: NoteSpans = []): [number, number][] {
	// Line breaks in the source aren't sentence breaks in the rendered text. Nor do note references
	// join sentences: "thing.4 This" reads as a decimal number to the segmenter.
	const flat = withoutNotes(text.replace(/\s/g, ' '), notes);
	const out: [number, number][] = [];
	const Segmenter = (Intl as { Segmenter?: typeof Intl.Segmenter }).Segmenter;
	if (Segmenter) {
		let segmenter: Intl.Segmenter;
		try {
			segmenter = new Segmenter(lang || undefined, { granularity: 'sentence' });
		} catch {
			segmenter = new Segmenter(undefined, { granularity: 'sentence' });
		}
		for (const s of segmenter.segment(flat)) out.push([s.index, s.index + s.segment.length]);
	} else {
		const re = /[.!?…]+["'”’)\]]*\s+/g;
		let start = 0;
		for (let m = re.exec(flat); m; m = re.exec(flat)) {
			out.push([start, m.index + m[0].length]);
			start = m.index + m[0].length;
		}
		if (start < flat.length) out.push([start, flat.length]);
	}
	// Without the spaces around it, with the note references right after it
	return out.map(([a, b]) => {
		while (a < b && flat[a] === ' ') a++;
		while (b > a && flat[b - 1] === ' ') b--;
		if (b > a) for (let n = notes.find(([x]) => x === b); n; n = notes.find(([x]) => x === b)) b = n[1];
		return [a, b] as [number, number];
	});
}

/** Whether an element is a note reference: marked as one, or a link in a superscript (or the reverse) */
function isNoteRef(el: Element): boolean {
	const types = `${el.getAttribute('role') ?? ''} ${el.getAttribute('epub:type') ?? ''}`.split(/\s+/);
	if (types.includes('doc-noteref') || types.includes('noteref')) return true;
	if (el.localName === 'sup') return !!el.querySelector('a[href]');
	if (el.localName === 'a' && el.hasAttribute('href')) {
		const only = el.firstElementChild;
		return !!el.closest('sup') || (el.childElementCount === 1 && only!.localName === 'sup' && el.textContent!.trim() === only!.textContent!.trim());
	}
	return false;
}

/** `text` with its note references blanked out */
function withoutNotes(text: string, notes: NoteSpans = []): string {
	for (const [a, b] of notes) text = text.slice(0, a) + ' '.repeat(b - a) + text.slice(b);
	return text;
}

/** A block's text, as the sentence functions see it: its text nodes (not scripts, styles or ruby annotations), their note references */
export function blockText(block: Element): { texts: Text[]; starts: number[]; text: string; notes: NoteSpans; offset(node: Node, offset: number): number } {
	const doc = block.ownerDocument;
	const texts: Text[] = [];
	const walker = doc.createTreeWalker(block, NodeFilter.SHOW_TEXT);
	for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
		if (!n.parentElement?.closest('script, style, rt, rp')) texts.push(n);
	}
	const starts: number[] = [];
	const notes: NoteSpans = [];
	let total = 0;
	for (const t of texts) {
		starts.push(total);
		let note = false;
		for (let e = t.parentElement; e && e !== block && block.contains(e); e = e.parentElement) {
			if (isNoteRef(e)) {
				note = true;
				break;
			}
		}
		if (note && t.data.length) {
			// One span for a reference split across text nodes
			const last = notes[notes.length - 1];
			if (last && last[1] === total) last[1] = total + t.data.length;
			else notes.push([total, total + t.data.length]);
		}
		total += t.data.length;
	}
	return {
		texts,
		starts,
		text: texts.map((t) => t.data).join(''),
		notes,
		offset(node, offset) {
			const i = texts.indexOf(node as Text);
			if (i >= 0) return starts[i] + Math.min(offset, texts[i].data.length);
			// An element position (or a skipped text node): the text after it (or the end, when none follows)
			const probe = doc.createRange();
			probe.setStart(node, offset);
			probe.collapse(true);
			const k = texts.findIndex((t) => probe.comparePoint(t, 0) >= 0);
			return k < 0 ? total : starts[k];
		},
	};
}

/** The sentence of `block` around a text position in it (null when it's only whitespace) */
export function sentenceRange(block: Element, node: Node, offset: number, lang?: string): Range | null {
	const { texts, starts, text, notes, offset: offsetOf } = blockText(block);
	if (!texts.length) return null;
	const at = offsetOf(node, offset);
	const bounds = sentenceBounds(text, lang, notes).filter(([a, b]) => b > a);
	if (!bounds.length) return null;
	// The last sentence starting at or before the position (spaces after one belong to it)
	const [a, b] = [...bounds].reverse().find(([start]) => start <= at) ?? bounds[0];
	const point = (pos: number, end: boolean): [Text, number] => {
		for (let i = 0; i < texts.length; i++) {
			const len = texts[i].data.length;
			if (end ? pos <= starts[i] + len : pos < starts[i] + len) return [texts[i], pos - starts[i]];
		}
		const last = texts[texts.length - 1];
		return [last, last.data.length];
	};
	const range = block.ownerDocument.createRange();
	range.setStart(...point(a, false));
	range.setEnd(...point(b, true));
	return range;
}

/** What a selection of whole sentences may leave out at its start: spaces, opening quotes and brackets, dashes. */
const LEADING = /^[\s"'“‘„‚«‹([{¿¡—–-]*$/u;
/** …and at its end: spaces, closing quotes and brackets, final punctuation. */
const TRAILING = /^[\s"'”’»›)\]}.!?…:;,—–-]*$/u;

/** Where the sentence of `text` that a selection starting at `at` starts in; with the sentence before it (null: none in `text`) */
export function sentenceStartAt(text: string, at: number, lang?: string, notes?: NoteSpans): { start: number; whole: boolean; prev: [number, number] | null } {
	const bounds = sentenceBounds(text, lang, notes).filter(([a, b]) => b > a);
	// The first sentence ending after the position (a position between sentences starts the next one)
	const i = bounds.findIndex(([, b]) => b > at);
	if (i < 0) return { start: at, whole: true, prev: bounds.length ? bounds[bounds.length - 1] : null };
	const start = Math.min(bounds[i][0], at);
	return { start, whole: LEADING.test(withoutNotes(text, notes).slice(start, at)), prev: i > 0 ? bounds[i - 1] : null };
}

/** Where the sentence of `text` that a selection ending at `at` ends; with the sentence after it (null: none in `text`) */
export function sentenceEndAt(text: string, at: number, lang?: string, notes?: NoteSpans): { end: number; whole: boolean; next: [number, number] | null } {
	const bounds = sentenceBounds(text, lang, notes).filter(([a, b]) => b > a);
	// The last sentence starting before the position (a position between sentences ends the one before)
	let i = -1;
	for (let k = 0; k < bounds.length; k++) if (bounds[k][0] < at) i = k;
	if (i < 0) return { end: at, whole: true, next: bounds.length ? bounds[0] : null };
	const end = Math.max(bounds[i][1], at);
	return { end, whole: TRAILING.test(withoutNotes(text, notes).slice(at, end)), next: i + 1 < bounds.length ? bounds[i + 1] : null };
}

/**
 * The context of a selection [start, end) of `text`: the sentences it's in, or, when it covers whole
 * sentences (leaving out quotes and final punctuation still counts), those and the sentences before
 * and after. `needPrev` / `needNext`: the sentence before or after would be outside `text`.
 */
export function sentenceContext(text: string, start: number, end: number, lang?: string, notes?: NoteSpans): { start: number; end: number; needPrev: boolean; needNext: boolean } {
	const s = sentenceStartAt(text, start, lang, notes);
	const e = sentenceEndAt(text, end, lang, notes);
	if (!(s.whole && e.whole)) return { start: s.start, end: e.end, needPrev: false, needNext: false };
	return { start: s.prev?.[0] ?? s.start, end: e.next?.[1] ?? e.end, needPrev: !s.prev, needNext: !e.next };
}

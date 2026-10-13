/** Sentences within a block of text: what a triple click selects. */

/** Where each sentence of `text` starts, and its end (exclusive) */
export function sentenceBounds(text: string, lang?: string): [number, number][] {
	// Line breaks in the source aren't sentence breaks in the rendered text.
	const flat = text.replace(/\s/g, ' ');
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
	// Without the spaces around it
	return out.map(([a, b]) => {
		while (a < b && flat[a] === ' ') a++;
		while (b > a && flat[b - 1] === ' ') b--;
		return [a, b] as [number, number];
	});
}

/** The sentence of `block` around a text position in it (null when it's only whitespace) */
export function sentenceRange(block: Element, node: Node, offset: number, lang?: string): Range | null {
	const doc = block.ownerDocument;
	const texts: Text[] = [];
	const walker = doc.createTreeWalker(block, NodeFilter.SHOW_TEXT);
	for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
		if (!n.parentElement?.closest('script, style, rt, rp')) texts.push(n);
	}
	if (!texts.length) return null;
	// The position as an offset into the block's text
	let at = -1;
	let total = 0;
	const starts: number[] = [];
	for (const t of texts) {
		starts.push(total);
		if (t === node) at = total + Math.min(offset, t.data.length);
		total += t.data.length;
	}
	if (at < 0) {
		// An element position: the text after it (or the end, when none follows)
		const probe = doc.createRange();
		probe.setStart(node, offset);
		probe.collapse(true);
		const i = texts.findIndex((t) => probe.comparePoint(t, 0) >= 0);
		at = i < 0 ? total : starts[i];
	}
	const text = texts.map((t) => t.data).join('');
	const bounds = sentenceBounds(text, lang).filter(([a, b]) => b > a);
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
	const range = doc.createRange();
	range.setStart(...point(a, false));
	range.setEnd(...point(b, true));
	return range;
}

import { HintOverlay, hintLabels, wordRanges, type Hint } from '../core';
import type { WordHintFlow } from './settings';
import type { DocumentView } from './view';

/** Picking text in view by its label (reader keys `h` / `c`, `H` / `C`): at most one at a time, in one view. */
interface Session {
	view: DocumentView;
	overlay: HintOverlay;
	typed: string;
	/** The labels' keys are all lowercase: Caps Lock or Shift still types them */
	lowercase: boolean;
	onPick: (range: Range) => void;
	/** Ended without a pick (Escape, scrolling, a click…) */
	onCancel?: () => void;
	cleanup: (() => void)[];
}

let session: Session | null = null;

type Spot = { range: Range; x: number; y: number };

/** How `pickWords` picks: the flow, and whether a passage from a sentence's first word (to its last) takes the punctuation before (after) it */
export interface WordPickOptions {
	flow: WordHintFlow;
	startPunctuation: boolean;
	endPunctuation: boolean;
}

/**
 * Labels `spots` of `view` with keys of `alphabet` (in `color`); typing a label calls `onPick` with its
 * range. Anything else (Escape, scrolling, a click) ends it, with `onCancel`. False: nothing to label.
 */
function pickHint(view: DocumentView, spots: Spot[], alphabet: string, color: string, onPick: (range: Range) => void, onCancel?: () => void): boolean {
	endSentenceHints();
	const reader = view.reader;
	const labels = hintLabels(spots.length, alphabet);
	if (!reader || !labels.length) return false;
	const hints: Hint[] = spots.map((s, i) => ({ ...s, label: labels[i] }));
	const overlay = new HintOverlay(reader.scroller, hints, color);
	const end = () => endSentenceHints();
	const s: Session = { view, overlay, typed: '', lowercase: alphabet === alphabet.toLowerCase(), onPick, onCancel, cleanup: [] };
	const listen = (target: EventTarget, type: string) => {
		target.addEventListener(type, end, { capture: true });
		s.cleanup.push(() => target.removeEventListener(type, end, { capture: true }));
	};
	listen(reader.scroller, 'scroll');
	listen(reader.doc, 'mousedown');
	listen(reader.doc, 'touchstart');
	listen(reader.win, 'resize');
	listen(reader.win, 'blur');
	const ref = view.app.workspace.on('active-leaf-change', end);
	s.cleanup.push(() => view.app.workspace.offref(ref));
	session = s;
	return true;
}

/** Labels the sentences in view; the one picked goes to `onPick`. False: nothing in view. */
export function pickSentence(view: DocumentView, alphabet: string, color: string, onPick: (range: Range) => void): boolean {
	return !!view.reader && pickHint(view, view.reader.visibleSentences(), alphabet, color, onPick);
}

/**
 * Picks a passage from one word to another, by labels: a sentence, its first word, the sentence it
 * ends in, its last word (`flow` `sentence`), or the two words among every word in view (`word`).
 * What's picked so far is shown as selected. False: nothing in view.
 */
export function pickWords(view: DocumentView, alphabet: string, color: string, opts: WordPickOptions, onPick: (range: Range) => void): boolean {
	const { flow } = opts;
	const reader = view.reader;
	if (!reader) return false;
	const show = (range: Range | null) => reader.setPendingSelection(range);
	const cancel = () => show(null);
	const pick = (spots: Spot[], next: (range: Range) => void) => pickHint(view, spots, alphabet, color, next, cancel);
	/** From the start of `a` to the end of `b` */
	const span = (a: Range, b: Range) => {
		const r = reader.doc.createRange();
		r.setStart(a.startContainer, a.startOffset);
		r.setEnd(b.endContainer, b.endOffset);
		return r;
	};
	/** Whether `r` ends after `start` begins (the passage can end there) */
	const after = (start: Range) => (r: Range) => r.comparePoint(start.startContainer, start.startOffset) <= 0;
	/** The sentence in view a word is in */
	const sentenceOf = (word: Range) => reader.visibleSentences().find((s) => s.range.comparePoint(word.startContainer, word.startOffset) === 0)?.range;
	const same = (a: Node, i: number, b: Node, j: number) => a === b && i === j;
	/** From `start` to `end`, with the punctuation before a sentence's first word and after its last, as chosen */
	const finish = (start: Range, end: Range, first = sentenceOf(start), last = sentenceOf(end)) => {
		const range = span(start, end);
		const firstWord = first && wordRanges(first)[0];
		if (opts.startPunctuation && first && firstWord && same(firstWord.startContainer, firstWord.startOffset, start.startContainer, start.startOffset)) range.setStart(first.startContainer, first.startOffset);
		const lastWord = last && wordRanges(last).pop();
		if (opts.endPunctuation && last && lastWord && same(lastWord.endContainer, lastWord.endOffset, end.endContainer, end.endOffset)) range.setEnd(last.endContainer, last.endOffset);
		show(null);
		onPick(range);
	};
	// One word: labels again (e.g. a sentence of a single word) need no second pick
	const endAt = (start: Range, spots: Spot[], then: (end: Range) => void) => {
		const left = spots.filter((s) => after(start)(s.range));
		if (left.length === 1) then(left[0].range);
		else if (!pick(left, then)) cancel();
	};
	const startWord = (spots: Spot[], then: (start: Range) => void): boolean => {
		if (spots.length === 1) then(spots[0].range);
		else if (!pick(spots, then)) return false;
		return true;
	};
	if (flow === 'word')
		return startWord(reader.visibleWords(), (start) => {
			show(start);
			endAt(start, reader.visibleWords(), (end) => finish(start, end));
		});
	return pick(reader.visibleSentences(), (first) => {
		show(first);
		const started = startWord(reader.visibleWords(first), (start) => {
			show(start);
			endAt(start, reader.visibleSentences(), (last) => {
				show(span(start, last));
				endAt(start, reader.visibleWords(last), (end) => finish(start, end, first, last));
			});
		});
		// No words in it (only punctuation)
		if (!started) cancel();
	});
}

export function sentenceHintsShown(): boolean {
	return !!session;
}

/** Puts the labels away (`picked`: for a pick, so not a cancel) */
export function endSentenceHints(picked = false): void {
	const s = session;
	if (!s) return;
	session = null;
	for (const f of s.cleanup) f();
	s.overlay.destroy();
	if (!picked) s.onCancel?.();
}

/** A key while the labels are shown (`chord` as `chordOf` gives it): always used */
export function sentenceHintKey(chord: string): void {
	const s = session;
	if (!s) return;
	if (chord === 'Backspace') {
		s.typed = s.typed.slice(0, -1);
		s.overlay.narrow(s.typed);
		return;
	}
	const key = s.lowercase ? chord.toLowerCase() : chord;
	if ([...key].length !== 1) return endSentenceHints(); // Escape, or any other key
	const left = s.overlay.narrow(s.typed + key);
	// Not a label's next key: ignored
	if (!left.length) return void s.overlay.narrow(s.typed);
	s.typed += key;
	const hit = left.find((h) => h.label === s.typed);
	if (!hit) return;
	endSentenceHints(true);
	s.onPick(hit.range);
}

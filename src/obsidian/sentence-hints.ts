import { HintOverlay, hintLabels, type Hint } from '../core';
import type { DocumentView } from './view';

/** Picking a sentence in view by its label (reader keys `h` / `c`): at most one at a time, in one view. */
interface Session {
	view: DocumentView;
	overlay: HintOverlay;
	typed: string;
	/** The labels' keys are all lowercase: Caps Lock or Shift still types them */
	lowercase: boolean;
	onPick: (range: Range) => void;
	cleanup: (() => void)[];
}

let session: Session | null = null;

/**
 * Labels the sentences in view of `view` with keys of `alphabet` (in `color`); typing a label calls
 * `onPick` with its sentence. Anything else (Escape, scrolling, a click) ends it. False: nothing in view.
 */
export function pickSentence(view: DocumentView, alphabet: string, color: string, onPick: (range: Range) => void): boolean {
	endSentenceHints();
	const reader = view.reader;
	if (!reader) return false;
	const sentences = reader.visibleSentences();
	const labels = hintLabels(sentences.length, alphabet);
	if (!labels.length) return false;
	const hints: Hint[] = sentences.map((s, i) => ({ ...s, label: labels[i] }));
	const overlay = new HintOverlay(reader.scroller, hints, color);
	const end = () => endSentenceHints();
	const s: Session = { view, overlay, typed: '', lowercase: alphabet === alphabet.toLowerCase(), onPick, cleanup: [] };
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

export function sentenceHintsShown(): boolean {
	return !!session;
}

export function endSentenceHints(): void {
	if (!session) return;
	for (const f of session.cleanup) f();
	session.overlay.destroy();
	session = null;
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
	endSentenceHints();
	s.onPick(hit.range);
}

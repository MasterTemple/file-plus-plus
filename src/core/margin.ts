/**
 * Notes in the margin, Google Docs style: elements the app provides (comment cards, …) placed beside
 * the passages they belong to, scrolling with the document.
 *
 * The notes live in the host's light DOM and are slotted into a column inside the reader's scroller, so
 * they scroll with the text and keep the host page's styles (the shadow root isolates the document's).
 * The text moves left to make room; when the reader is too narrow for both, the margin hides itself
 * (`visible` is false) and the app can fall back to other UI.
 */

export interface MarginNote {
	/** Unique among the notes (e.g. the highlight's id). */
	id: string;
	/** The passage the note belongs to; null puts it nowhere (hidden). */
	range: Range | null;
	/** The note's element; the margin positions it (absolutely) and leaves its contents alone. */
	el: HTMLElement;
}

/** What the margin needs from its reader. */
export interface MarginHost {
	readonly host: HTMLElement;
	readonly shadow: ShadowRoot;
	readonly scroller: HTMLElement;
	readonly content: HTMLElement;
	readonly win: Window & typeof globalThis;
	/** Run a change that reflows the text, keeping the reading position. */
	keepPosition(fn: () => void): void;
	/** A fallback position (top, viewport coordinates) for a range without client rects. */
	fallbackTop(range: Range): number | null;
}

export interface MarginOptions {
	/** Widest column, px. */
	maxWidth?: number;
	/** Narrowest column worth showing, px. */
	minWidth?: number;
	/** Narrowest the text may get to make room, px. */
	minText?: number;
	/** Between the text and the column, and between notes, px. */
	gap?: number;
}

const SLOT = 'fpp-margin';

export class Margin {
	private notes: MarginNote[] = [];
	private enabled = true;
	private active: string | null = null;
	private shown = false;
	private width = 0;
	private raf = 0;
	private readonly column: HTMLElement;
	private readonly container: HTMLElement;
	private readonly opts: Required<MarginOptions>;
	private readonly cleanup: (() => void)[] = [];
	/** Called when `visible` changes. */
	onVisibilityChange: ((visible: boolean) => void) | null = null;

	constructor(
		private r: MarginHost,
		opts: MarginOptions = {},
	) {
		this.opts = { maxWidth: 300, minWidth: 200, minText: 320, gap: 20, ...opts };
		const doc = r.host.ownerDocument;
		this.column = doc.createElement('div');
		this.column.className = 'fpp-margin';
		this.column.appendChild(doc.createElement('slot')).setAttribute('name', SLOT);
		r.scroller.appendChild(this.column);
		this.container = doc.createElement('div');
		this.container.className = 'fpp-margin-notes';
		this.container.slot = SLOT;
		r.host.appendChild(this.container);
		if (typeof ResizeObserver !== 'undefined') {
			// The scroller's size (pane resized) and the content's (fonts, sections rendering lazily) move notes.
			const ro = new ResizeObserver(() => this.schedule());
			ro.observe(r.scroller);
			ro.observe(r.content);
			this.cleanup.push(() => ro.disconnect());
		}
	}

	/** True while the notes are shown (enabled, any notes, and room for them). */
	get visible(): boolean {
		return this.shown;
	}

	/** The light-DOM element holding the notes (style notes through it). */
	get element(): HTMLElement {
		return this.container;
	}

	/** Replace the notes. Elements already shown are reused when passed again. */
	set(notes: MarginNote[]): void {
		const keep = new Set(notes.map((n) => n.el));
		for (const n of this.notes) if (!keep.has(n.el)) n.el.remove();
		this.notes = notes;
		for (const n of notes) {
			n.el.classList.add('fpp-margin-note');
			if (n.el.parentElement !== this.container) this.container.appendChild(n.el);
		}
		if (this.active && !notes.some((n) => n.id === this.active)) this.active = null;
		for (const n of notes) n.el.classList.toggle('is-active', n.id === this.active);
		this.layout();
	}

	setEnabled(on: boolean): void {
		if (on === this.enabled) return;
		this.enabled = on;
		this.layout();
	}

	/** Bring a note next to its passage (others make way), or none. */
	setActive(id: string | null): void {
		this.active = id;
		for (const n of this.notes) n.el.classList.toggle('is-active', n.id === id);
		this.layout();
	}

	get activeId(): string | null {
		return this.active;
	}

	/** Re-place the notes on the next frame. */
	schedule(): void {
		if (this.raf) return;
		this.raf = this.r.win.requestAnimationFrame(() => {
			this.raf = 0;
			this.layout();
		});
	}

	/** Reserve room beside the text (or give it back) and place the notes. */
	layout(): void {
		const { scroller, content } = this.r;
		const avail = scroller.clientWidth;
		const { gap, minText, minWidth, maxWidth } = this.opts;
		const width = Math.min(maxWidth, avail - gap - minText);
		const show = this.enabled && this.notes.some((n) => n.range) && avail > 0 && width >= minWidth;
		if (show !== this.shown || (show && width !== this.width)) {
			this.r.keepPosition(() => {
				this.shown = show;
				this.width = show ? width : 0;
				if (show) {
					// Center the text and the notes together, so spare room is split between the outer edges.
					content.style.marginLeft = content.style.marginRight = '';
					const cs = this.r.win.getComputedStyle(content);
					const full = parseFloat(cs.maxWidth) + parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
					const reserve = width + gap;
					const left = isFinite(full) ? Math.max(0, (avail - full - reserve) / 2) : 0;
					content.style.marginLeft = `${left}px`;
					content.style.marginRight = `${reserve}px`;
				} else {
					content.style.marginLeft = content.style.marginRight = '';
				}
				scroller.classList.toggle('fpp-with-margin', show);
			});
			this.onVisibilityChange?.(show);
		}
		this.container.classList.toggle('is-visible', show);
		if (!show) return;
		this.place();
	}

	private place(): void {
		const { scroller, content } = this.r;
		const box = scroller.getBoundingClientRect();
		const cs = this.r.win.getComputedStyle(content);
		const textRight = content.offsetLeft + content.offsetWidth - parseFloat(cs.paddingRight);
		this.column.style.left = `${textRight + this.opts.gap}px`;
		this.column.style.width = `${this.width}px`;

		const items: { note: MarginNote; anchor: number; height: number }[] = [];
		for (const note of this.notes) {
			const top = note.range ? this.topOf(note.range) : null;
			note.el.classList.toggle('is-placed', top !== null);
			if (top === null) continue;
			items.push({ note, anchor: top - box.top + scroller.scrollTop, height: 0 });
		}
		items.sort((a, b) => a.anchor - b.anchor);
		// Read every height before writing any position (one layout pass).
		for (const it of items) it.height = it.note.el.offsetHeight;
		const gap = 8;
		const tops = items.map((it) => it.anchor);
		const a = items.findIndex((it) => it.note.id === this.active);
		const start = a === -1 ? 0 : a;
		// Notes after the active one (or all) move down out of each other's way…
		for (let i = start + 1; i < items.length; i++) tops[i] = Math.max(tops[i], tops[i - 1] + items[i - 1].height + gap);
		// …and those before the active one move up.
		for (let i = start - 1; i >= 0; i--) tops[i] = Math.min(tops[i], tops[i + 1] - items[i].height - gap);
		// Nothing above the top of the document: push down again from there.
		if (tops.length && tops[0] < 0) {
			tops[0] = 0;
			for (let i = 1; i < items.length; i++) tops[i] = Math.max(tops[i], tops[i - 1] + items[i - 1].height + gap);
		}
		items.forEach((it, i) => (it.note.el.style.top = `${Math.round(tops[i])}px`));
	}

	/** Top of a range's first line, in viewport coordinates. */
	private topOf(range: Range): number | null {
		const rects = range.getClientRects();
		for (const rect of Array.from(rects)) if (rect.width || rect.height) return rect.top;
		return this.r.fallbackTop(range);
	}

	destroy(): void {
		this.r.win.cancelAnimationFrame(this.raf);
		for (const fn of this.cleanup) fn();
		this.column.remove();
		this.container.remove();
		this.r.content.style.marginLeft = this.r.content.style.marginRight = '';
		this.notes = [];
	}
}

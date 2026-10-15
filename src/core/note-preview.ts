/**
 * Footnotes shown where they're referenced: hovering a link to a note (desktop) or tapping it (touch)
 * shows the note in a popover over the text; clicking the popover goes to the note.
 */

/** Where notes are: the containers a note link's target may be in, or be */
const NOTE_CONTAINERS = [
	'aside',
	'[data-epub-type~="footnote"]',
	'[data-epub-type~="endnote"]',
	'[data-epub-type~="rearnote"]',
	'[data-epub-type~="note"]',
	'[role="doc-footnote"]',
	'[role="doc-endnote"]',
	'.footnote',
	'.endnote',
	'.footnotes',
	'.endnotes',
].join(', ');

/** What a note's text is in, when its container isn't one of `NOTE_CONTAINERS` (an anchor in a paragraph) */
const BLOCKS = 'li, dd, p, blockquote, div:not(.fpp-body):not(.fpp-section), td';

/** A note longer than this is shown only from its block */
const MAX_NOTE_TEXT = 4000;

/**
 * Whether a link to `target` is a note reference: said so (`epub:type="noteref"`, `role="doc-noteref"`),
 * to a note, or looking like one (superscript, or a short mark: `1`, `[12]`, `*`, `†`) and not to a heading.
 */
export function isNoteLink(a: Element, target: Element): boolean {
	const kind = `${a.getAttribute('data-epub-type') ?? ''} ${a.getAttribute('role') ?? ''}`;
	if (/\b(noteref|doc-noteref|doc-biblioref)\b/.test(kind)) return true;
	if (target.closest(NOTE_CONTAINERS)) return true;
	if (target.closest('h1, h2, h3, h4, h5, h6, nav') || target.querySelector('h1, h2, h3, h4, h5, h6')) return false;
	const text = (a.textContent ?? '').trim();
	return !!a.closest('sup') || /^[[(]?(\d{1,4}|[a-z]|[ivxl]{1,5}|[*†‡§¶#]+)[\])]?\.?$/i.test(text);
}

/** The note a note link points to (`target`: the element with its id): the note's container, or the target's block */
export function noteOf(target: Element): Element {
	const container = target.closest(NOTE_CONTAINERS);
	if (container && !container.matches('.footnotes, .endnotes') && (container.textContent?.length ?? 0) <= MAX_NOTE_TEXT) return container;
	return target.closest(BLOCKS) ?? target;
}

export interface NotePreviewHost {
	doc: Document;
	scroller: HTMLElement;
	content: HTMLElement;
	/** The element an internal href goes to, if it has one (a fragment) */
	target(href: string): Element | null;
	/** Go to an internal href (as a click on its link) */
	follow(href: string, e: MouseEvent): void;
}

/** How long the pointer rests on a note link before its note shows, and may be away before it hides */
const SHOW_DELAY = 250;
const HIDE_DELAY = 300;

/** The popover of one reader (see the file's comment) */
export class NotePreview {
	private el: HTMLElement | null = null;
	/** The link shown (or about to be) */
	private link: Element | null = null;
	private showTimer = 0;
	private hideTimer = 0;

	constructor(private readonly host: NotePreviewHost) {}

	private get win(): Window {
		return this.host.doc.defaultView ?? window;
	}

	/** The note link an event's target is in, with its href and note */
	noteLinkAt(target: EventTarget | null): { a: Element; href: string; note: Element } | null {
		const a = (target as Element | null)?.closest?.('a');
		const href = a?.getAttribute('data-fpp-href');
		if (!a || !href || !this.host.content.contains(a)) return null;
		const t = this.host.target(href);
		if (!t || t.contains(a) || !isNoteLink(a, t)) return null;
		const note = noteOf(t);
		return note.contains(a) ? null : { a, href, note };
	}

	/** Whether a node is in the popover */
	contains(node: Node | null): boolean {
		return !!node && !!this.el?.contains(node);
	}

	/** The pointer moved onto `target` (mouse): a note link shows its note after a moment; elsewhere it hides */
	pointerOver(target: EventTarget | null): void {
		if (this.contains(target as Node)) return this.win.clearTimeout(this.hideTimer);
		const hit = this.noteLinkAt(target);
		if (hit && hit.a === this.link) return this.win.clearTimeout(this.hideTimer);
		this.win.clearTimeout(this.showTimer);
		if (hit) {
			this.showTimer = this.win.setTimeout(() => this.show(hit.a, hit.href, hit.note), this.el ? 0 : SHOW_DELAY);
			return;
		}
		if (this.el) {
			this.win.clearTimeout(this.hideTimer);
			this.hideTimer = this.win.setTimeout(() => this.hide(), HIDE_DELAY);
		}
	}

	/** A click in the popover: a link in it is followed, anywhere else goes to the note */
	click(e: MouseEvent): void {
		const href = (e.target as Element | null)?.closest?.('a')?.getAttribute('data-fpp-href') ?? this.el?.getAttribute('data-href');
		e.preventDefault();
		this.hide();
		if (href) this.host.follow(href, e);
	}

	/** Goes to the note shown */
	followShown(): void {
		const href = this.el?.getAttribute('data-href');
		this.hide();
		if (href) this.host.follow(href, new MouseEvent('click'));
	}

	show(a: Element, href: string, note: Element): void {
		const { doc, scroller } = this.host;
		this.hide();
		this.link = a;
		const el = (this.el = doc.createElement('div'));
		el.className = 'fpp-note-preview';
		el.setAttribute('data-href', href);
		// In copies of its section and body, so the document's styles (scoped to them) apply
		const section = note.closest('.fpp-section');
		const body = note.closest('.fpp-body');
		let inner: HTMLElement = el;
		for (const part of [section, body]) {
			if (!part) continue;
			const copy = part.cloneNode(false) as HTMLElement;
			copy.removeAttribute('style');
			copy.removeAttribute('id');
			copy.removeAttribute('data-fpp-section');
			inner = inner.appendChild(copy);
		}
		const clone = note.cloneNode(true) as HTMLElement;
		clone.classList.add('fpp-note');
		for (const e of [clone, ...Array.from(clone.querySelectorAll('[id]'))]) e.removeAttribute('id');
		inner.appendChild(clone);
		scroller.appendChild(el);

		// Under the link, or over it when there's more room there
		const box = scroller.getBoundingClientRect();
		const r = (Array.from(a.getClientRects()).find((q) => q.width) ?? a.getBoundingClientRect()) as DOMRect;
		const width = el.offsetWidth;
		const height = el.offsetHeight;
		const left = Math.max(8, Math.min(r.left - box.left - width / 2 + r.width / 2, scroller.clientWidth - width - 8));
		const below = box.bottom - r.bottom;
		const top = below >= height + 12 || below >= r.top - box.top ? r.bottom - box.top + 6 : r.top - box.top - height - 6;
		el.style.left = `${left}px`;
		el.style.top = `${top + scroller.scrollTop}px`;
	}

	hide(): void {
		this.win.clearTimeout(this.showTimer);
		this.win.clearTimeout(this.hideTimer);
		this.el?.remove();
		this.el = null;
		this.link = null;
	}

	get shown(): boolean {
		return !!this.el;
	}
}

export const NOTE_PREVIEW_CSS = /* css */ `
.fpp-note-preview {
	position: absolute;
	z-index: 6;
	box-sizing: border-box;
	width: max-content;
	max-width: min(32em, calc(100% - 16px));
	max-height: min(45vh, 24em);
	overflow: auto;
	padding: 0.6em 1em;
	border: 1px solid var(--background-modifier-border, rgba(128, 128, 128, 0.35));
	border-radius: 8px;
	background: var(--fpp-bg);
	color: var(--fpp-fg);
	box-shadow: 0 4px 18px rgba(0, 0, 0, 0.25);
	font-size: var(--fpp-font-size);
	cursor: pointer;
}
.fpp-note-preview .fpp-section { content-visibility: visible; contain-intrinsic-size: none; margin: 0; padding: 0; }
.fpp-note-preview .fpp-body { margin: 0; padding: 0; }
.fpp-note-preview .fpp-note { display: block !important; visibility: visible !important; margin: 0 !important; }
.fpp-note-preview .fpp-note > :first-child { margin-top: 0; }
.fpp-note-preview .fpp-note > :last-child { margin-bottom: 0; }
`;

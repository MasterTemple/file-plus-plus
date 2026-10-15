import { flattenToc, type TocItem } from './toc';
import { isRangeLocator, parseLocator, textFragmentScheme, type LocatorScheme, type ParsedLocator } from './locator';
import { createTextFragment, findTextFragment, parseTextFragment, serializeTextFragment } from './text-fragment';
import { searchIndex, type SearchMatch, type SearchOptions } from './search';
import { TextIndex } from './text-index';
import { Emitter } from './emitter';
import { rangeToMarkdown } from './markdown';
import { blockText, sentenceBounds, sentenceEndAt, sentenceRange, sentenceRanges, sentenceStartAt, wordRanges } from './sentences';
import { BASE_CSS, DEFAULT_SETTINGS, settingsToVars, type ReaderSettings } from './settings';
import { Margin } from './margin';
import { HINT_CSS } from './hints';
import { NOTE_PREVIEW_CSS, NotePreview } from './note-preview';

/** Strength of highlights dimmed while others are focused. */
const DIMMED = 0.3;
/** Length of focus / dim / show / hide transitions of highlights. */
const HIGHLIGHT_TRANSITION_MS = 180;
/** How long the pointer may be off highlights before hover ends (crossing the gap between lines). */
const HOVER_LEAVE_MS = 120;

export interface HighlightSpec<T = unknown> {
	id: string;
	/** Any locator the reader resolves (`epubcfi(...)`, `:~:text=...`, `t=...`). */
	locator: string;
	/** Palette name or any CSS color. */
	color?: string;
	data?: T;
}

/** How an annotation layer is drawn and ordered (see `setLayer`). */
export interface AnnotationLayerOptions {
	/**
	 * CSS declarations for `::highlight()`, given an annotation's resolved color (only `color`,
	 * `background-color`, `text-decoration*`, `text-shadow` and `-webkit-text-*` apply there).
	 * Default: a background like highlights have.
	 */
	style?: (color: string) => string;
	/** Paint order; highlights are 0. Default -1 (below highlights). */
	priority?: number;
	/** Keep the layer (for `describeLayer`) without drawing it or reporting it under the pointer. */
	hidden?: boolean;
}

/** An annotation of a layer, as `describeLayer` lists it. */
export interface LayerItem {
	spec: HighlightSpec;
	/** The annotated text (null when its locator doesn't resolve). */
	text: string | null;
	tocItem: TocItem | null;
	/** With `context`: the text of its block before and after it. */
	before?: string;
	after?: string;
}

/** The elements whose text is an annotation's context: paragraphs, list items, cells, and the like. */
const BLOCKS = 'p, li, dd, dt, blockquote, h1, h2, h3, h4, h5, h6, td, th, pre, figcaption, div';

/** An annotation of a layer under the pointer. */
export interface LayerHit<T = unknown> {
	layer: string;
	spec: HighlightSpec<T>;
}

interface Layer {
	key: number;
	opts: AnnotationLayerOptions;
	items: { spec: HighlightSpec; range: StaticRange | null }[];
	/** Element → indices of items starting, ending or contained in it (for hit-testing). */
	buckets: Map<Element, number[]>;
	resolved: boolean;
	names: string[];
}

export interface SelectionInfo {
	range: Range;
	text: string;
	/** The format's own locator for the range (an EPUB CFI, a timestamp…). */
	locator: string;
	sectionIndex: number;
	tocItem: TocItem | null;
	/** Lazily computed text fragment directive (`:~:text=...`). */
	textFragment(): string | null;
	/** The selection converted to Markdown (emphasis, lists, paragraphs…), computed lazily. */
	markdown(): string;
	/** The sentences around the selection, computed lazily (see `DocumentReader.selectionContext`). */
	context(): SelectionContext;
}

/** A selection in its sentences: the text before it, its own, and after it (paragraphs separated by blank lines). */
export interface SelectionContext {
	before: string;
	text: string;
	after: string;
}

export interface Location {
	/** The format's locator of the reading position (a point). */
	locator: string;
	sectionIndex: number;
	tocItem: TocItem | null;
	/** 0..1 scroll progress through the whole document. */
	progress: number;
}

export interface SearchResult extends SearchMatch {
	/** Live range (created on demand; prefer `staticRange()` for painting many results). */
	range(): Range;
	staticRange(): StaticRange;
	locator(): string;
	tocItem(): TocItem | null;
}

type ReaderEvents = {
	ready: [];
	relocated: [Location];
	'highlight-click': [MouseEvent, HighlightSpec[]];
	/** Fired when the highlights under the pointer change (empty array: left all highlights). */
	'highlight-hover': [MouseEvent, HighlightSpec[]];
	contextmenu: [MouseEvent, { selection: SelectionInfo | null; highlights: HighlightSpec[]; annotations: LayerHit[] }];
	/** A click on annotations of layers (and on no highlight). */
	'annotation-click': [MouseEvent, LayerHit[]];
	/** Fired when the annotations under the pointer change (empty array: left them). */
	'annotation-hover': [MouseEvent, LayerHit[]];
	'external-link': [MouseEvent, string];
	selectionchange: [SelectionInfo | null];
};

export interface ReaderOptions {
	settings?: Partial<ReaderSettings>;
	/** Highlight palette: name → CSS color. */
	palette?: Record<string, string>;
	defaultColor?: string;
	/** Opacity (0..1) of highlight backgrounds. */
	highlightOpacity?: number;
	/** Default look of the temporary highlight shown after jumping to a passage. */
	flash?: FlashOptions;
	/** Called for clicks on links inside the document; return true to handle it yourself (default: goTo). */
	onInternalLink?: (href: string, event: MouseEvent) => boolean;
}

export interface FlashOptions {
	/** Total time on screen in ms, including the fade-out. */
	duration?: number;
	/** Fade-out time in ms at the end of `duration`. */
	fade?: number;
	/** Any CSS color. */
	color?: string;
	/** Peak opacity 0..1. */
	opacity?: number;
}

/**
 * A part of the rendered document (an EPUB chapter, a stretch of a transcript): a wrapper element
 * with class `fpp-section` and `data-fpp-section="<index>"`, around a body element with class
 * `fpp-body` that holds the text. Locators, search results and reading positions refer to sections.
 */
export interface RenderedSection {
	index: number;
	wrapper: HTMLElement;
	body: HTMLElement;
}

let instanceCounter = 0;
/**
 * Differs per load of the code: after a plugin reload, readers of the old and new code coexist for a
 * moment (embeds re-render), and their highlight names must not collide.
 */
const RUN = Math.random().toString(36).slice(2, 6);

/**
 * Renders a document as one continuous scrolling page inside a shadow root (no iframes) and provides
 * navigation, locators, highlights, annotation layers, selection and search. Formats subclass it:
 * they fill `content` with sections (`renderContent`) and map ranges to their own locators.
 */
export abstract class DocumentReader extends Emitter<ReaderEvents> {
	readonly shadow: ShadowRoot;
	readonly scroller: HTMLElement;
	/** The host's document/window (may be an Obsidian popout window, not the global one). */
	readonly doc: Document;
	readonly win: Window & typeof globalThis;
	readonly content: HTMLElement;
	/** Unique per reader (and per plugin, through the prefix): names highlights, fonts… */
	protected readonly id = `${RUN}${++instanceCounter}`;
	private settings: ReaderSettings;
	private palette: Record<string, string>;
	private defaultColor: string;
	private readonly highlightOpacity: number;
	protected sections: RenderedSection[] = [];
	protected sectionByIndex = new Map<number, RenderedSection>();
	/** Inserted before the reader's own highlight styles: formats put the document's CSS here. */
	protected readonly highlightStyle: HTMLStyleElement;
	private _index: TextIndex | null = null;
	private highlights: { spec: HighlightSpec; range: Range | null }[] = [];
	private rangeCache = new Map<string, Range | null>();
	private highlightNames = new Set<string>();
	private tocTargets: { item: TocItem; node: Node }[] | null = null;
	protected cleanup: (() => void)[] = [];
	private rendered = false;
	protected destroyed = false;
	private relocateTimer = 0;
	private flashTimer = 0;
	private flashRaf = 0;
	private flashStyle: HTMLStyleElement;
	private flashDefaults: Required<FlashOptions>;
	private readonly onInternalLink?: (href: string, event: MouseEvent) => boolean;
	/** Reading position to restore when the host is re-attached or resized (DOM moves reset scrollTop). */
	private anchor: Range | null = null;
	private scratchRange: Range | null = null;
	private anchorPosition: 'top' | 'center' = 'top';
	private hostSize = { w: 0, h: 0 };
	private lastHover: string = '';
	private hoverLeaveTimer = 0;
	private lastLayerHover: string = '';
	private layers = new Map<string, Layer>();
	private layerCounter = 0;
	private layerStyle: HTMLStyleElement;
	private hitRange: Range | null = null;

	/** Locator schemes, in the order they are tried (`textFragmentScheme` is a good second). */
	abstract readonly schemes: LocatorScheme[];

	constructor(
		readonly host: HTMLElement,
		opts: ReaderOptions = {},
	) {
		super();
		this.doc = host.ownerDocument;
		this.win = (this.doc.defaultView ?? window) as Window & typeof globalThis;
		this.settings = { ...DEFAULT_SETTINGS, ...opts.settings };
		this.palette = opts.palette ?? { yellow: '#ffd000', red: '#ff5f5f', green: '#5fd068', blue: '#5fa8ff', purple: '#b07cff' };
		this.defaultColor = opts.defaultColor ?? Object.keys(this.palette)[0] ?? 'yellow';
		this.highlightOpacity = opts.highlightOpacity ?? 0.4;
		this.flashDefaults = { duration: 1600, fade: 600, color: '#ffb000', opacity: 0.6, ...opts.flash };
		this.onInternalLink = opts.onInternalLink;

		this.shadow = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
		this.shadow.replaceChildren();
		const base = this.doc.createElement('style');
		base.textContent = BASE_CSS + HINT_CSS + NOTE_PREVIEW_CSS + this.extraCss();
		this.highlightStyle = this.doc.createElement('style');
		this.scroller = this.doc.createElement('div');
		this.scroller.className = 'fpp-scroller';
		this.scroller.tabIndex = 0;
		this.content = this.doc.createElement('div');
		this.content.className = 'fpp-content';
		this.scroller.appendChild(this.content);
		this.flashStyle = this.doc.createElement('style');
		this.layerStyle = this.doc.createElement('style');
		this.shadow.append(base, this.highlightStyle, this.layerStyle, this.flashStyle, this.scroller);
		this.applySettings();
		this.bindEvents();
	}

	private get registry(): HighlightRegistry | undefined {
		return (this.win as any).CSS?.highlights;
	}

	private get HighlightCtor(): typeof Highlight | undefined {
		return (this.win as any).Highlight;
	}

	// ---------------------------------------------------------------------------------------------
	// Format hooks
	// ---------------------------------------------------------------------------------------------

	/** CSS added to the shadow root after `BASE_CSS` (the format's own base styles). */
	protected extraCss(): string {
		return '';
	}

	/**
	 * Build the document into `content` (directly or through a fragment) and `addSection` each part,
	 * in document order. May yield to the browser; return early when `destroyed` becomes true.
	 */
	protected abstract renderContent(): Promise<void>;

	/** The format's locator for a range, or a collapsed range (a position), or null. */
	abstract locatorFromRange(range: Range): string | null;

	/** Resolve a locator of one of the format's schemes (text fragments are handled here). */
	protected abstract resolveLocator(loc: ParsedLocator): Range | null;

	/** Table of contents; items' `href`s are locators. */
	abstract get toc(): TocItem[];

	protected addSection(sec: RenderedSection): void {
		sec.wrapper.classList.add('fpp-section');
		sec.wrapper.setAttribute('data-fpp-section', String(sec.index));
		sec.body.classList.add('fpp-body');
		this.sections.push(sec);
		this.sectionByIndex.set(sec.index, sec);
	}

	// ---------------------------------------------------------------------------------------------
	// Rendering
	// ---------------------------------------------------------------------------------------------

	async render(): Promise<void> {
		if (this.rendered) return;
		await this.renderContent();
		if (this.destroyed) return;
		this.rendered = true;
		this.updateHighlightStyles();
		this.paintLayers();
		this.emit('ready');
	}

	get isRendered(): boolean {
		return this.rendered;
	}

	// ---------------------------------------------------------------------------------------------
	// Settings
	// ---------------------------------------------------------------------------------------------

	getSettings(): ReaderSettings {
		return { ...this.settings };
	}

	/** Apply new settings live (CSS variables only; no re-render). Keeps the reading position. */
	updateSettings(patch: Partial<ReaderSettings>): void {
		const loc = this.rendered ? (this.currentAnchor() ?? this.anchor) : null;
		this.settings = { ...this.settings, ...patch };
		this.applySettings();
		if (loc) this.afterFrameUnlessJumped(() => this.scrollToRange(loc, { flash: false, position: 'top' }));
	}

	private applySettings(): void {
		const hostDark = this.doc.body?.classList.contains('theme-dark') ?? this.win.matchMedia?.('(prefers-color-scheme: dark)').matches;
		const vars = settingsToVars(this.settings, !!hostDark);
		for (const [k, v] of Object.entries(vars)) {
			if (v === null) this.host.style.removeProperty(k);
			else this.host.style.setProperty(k, v);
		}
		this.scroller.classList.toggle('fpp-themed', this.settings.theme !== 'publisher');
	}

	setPalette(palette: Record<string, string>, defaultColor?: string): void {
		this.palette = palette;
		if (defaultColor) this.defaultColor = defaultColor;
		this.refreshHighlights();
		this.paintLayers();
	}

	// ---------------------------------------------------------------------------------------------
	// Locators
	// ---------------------------------------------------------------------------------------------

	get textIndex(): TextIndex {
		if (!this._index) this._index = new TextIndex(this.content);
		return this._index;
	}

	parse(locator: string): ParsedLocator {
		return parseLocator(locator, this.schemes);
	}

	/** True when a locator marks a passage (a highlight) rather than a position. */
	isRangeLocator(locator: string): boolean {
		return isRangeLocator(this.parse(locator), this.schemes);
	}

	/** Resolve any supported locator to a DOM range. */
	resolve(locator: string | null | undefined): Range | null {
		if (!this.rendered || !locator) return null;
		const loc = this.parse(locator);
		if (!loc.locator) return null;
		if (loc.scheme === textFragmentScheme.id) return this.resolveTextFragment(loc.locator);
		return this.resolveLocator(loc);
	}

	/**
	 * The range a text fragment (`:~:text=…`) matches: its first match in the document, or with
	 * `within`, its first match starting inside that range (e.g. the cues of a timestamp).
	 */
	resolveTextFragment(fragment: string, within?: Range): Range | null {
		const tf = parseTextFragment(fragment);
		if (!tf) return null;
		const [from, to] = within ? this.textIndex.rangeToOffsets(within) : [0, Infinity];
		const r = findTextFragment(this.textIndex, tf, from);
		return r && r[0] <= to ? this.textIndex.toRange(r[0], r[1]) : null;
	}

	/** A text fragment for a range: unique in the document, or with `within`, from the start of that range. */
	textFragmentFromRange(range: Range, within?: Range): string | null {
		const [s, e] = this.textIndex.rangeToOffsets(range);
		const from = within ? this.textIndex.rangeToOffsets(within)[0] : 0;
		const tf = createTextFragment(this.textIndex, s, e, from);
		return tf ? serializeTextFragment(tf) : null;
	}

	// ---------------------------------------------------------------------------------------------
	// Units
	// ---------------------------------------------------------------------------------------------
	//
	// Formats whose own locators name whole units (a transcript's cues, a Bible's verses) list where
	// each unit starts; the library then finds the units a selection covers and, when it covers only
	// part of them, the exact words as a text fragment searched from the first unit
	// (`t=109s-120s:~:text=…`, `v=3:16:~:text=…`). Resolving searches the words within the units,
	// and falls back to the whole units when they aren't there (the text changed).

	/**
	 * The elements where each unit starts, in document order: the unit itself (a cue's span) or a
	 * marker before its text (a verse number). Empty: the format has no units. Keep it cached.
	 */
	protected unitElements(): readonly Element[] {
		return [];
	}

	/**
	 * Where unit `i` ends: by default where the next unit starts, when it is in the same section,
	 * else the end of the section's body. A unit that is an element's content ends after it instead.
	 */
	protected unitEnd(i: number): [Node, number] {
		const units = this.unitElements();
		const el = units[i];
		const next = units[i + 1];
		const body = this.sectionOf(el)?.body ?? null;
		if (next && (!body || body.contains(next))) return before(next);
		if (body) return [body, body.childNodes.length];
		return [el.parentNode!, Array.prototype.indexOf.call(el.parentNode!.childNodes, el) + 1];
	}

	/**
	 * The unit a point is in: the last one starting at or before it. A point between units (after
	 * one ends, before the next starts) is in the next one when it starts a range (`end` false) and
	 * in the one before when it ends a range; a range ending exactly where a unit starts ends in the
	 * unit before. Points before every unit are in the first. -1 without units.
	 */
	unitAt(node: Node, offset: number, end = false): number {
		const units = this.unitElements();
		if (!units.length) return -1;
		const point = this.doc.createRange();
		// Both ends: a range made by the document and moved into the shadow root must collapse there
		// (happy-dom keeps the end in the document)
		point.setStart(node, offset);
		point.setEnd(node, offset);
		let lo = 0;
		let hi = units.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			const side = point.comparePoint(...before(units[mid]));
			// Units starting before the point (or at it, unless the point ends a range)
			if (side < 0 || (!end && side === 0)) lo = mid + 1;
			else hi = mid;
		}
		const i = Math.max(0, lo - 1);
		// Past the end of unit i (its end comes before the point)
		if (!end && lo > 0 && i + 1 < units.length && point.comparePoint(...this.unitEnd(i)) < 0) return i + 1;
		return i;
	}

	/** The range over units `first` through `last`. */
	unitRange(first: number, last: number): Range | null {
		const units = this.unitElements();
		if (!units[first] || !units[last] || last < first) return null;
		const range = this.doc.createRange();
		range.setStart(...before(units[first]));
		range.setEnd(...this.unitEnd(last));
		return range;
	}

	/**
	 * The units a range covers (a collapsed range: the unit it is in), and when it covers only part of
	 * them, the exact words: a text fragment (`:~:text=…`) searched from the first unit
	 */
	unitsOfRange(range: Range): { first: number; last: number; text?: string } | null {
		const first = this.unitAt(range.startContainer, range.startOffset);
		if (first === -1) return null;
		if (range.collapsed) return { first, last: first };
		const last = Math.max(first, this.unitAt(range.endContainer, range.endOffset, true));
		const units = this.unitRange(first, last);
		if (!units) return { first, last };
		const [s, e] = this.textIndex.rangeToOffsets(range);
		const [us, ue] = this.textIndex.rangeToOffsets(units);
		if (s <= us && e >= ue) return { first, last };
		const text = this.textFragmentFromRange(range, units);
		return text ? { first, last, text } : { first, last };
	}

	/**
	 * Units `first` through `last`, narrowed to the words of `text` (a `:~:text=` directive) when it
	 * is given and found within them; otherwise the whole units
	 */
	resolveUnits(first: number, last: number, text?: string | null): Range | null {
		const range = this.unitRange(first, last);
		if (!range || !text) return range;
		return this.resolveTextFragment(text, range) ?? range;
	}

	/** The section a node is in. */
	protected sectionOf(node: Node): RenderedSection | null {
		const el = (node.nodeType === 1 ? (node as Element) : node.parentElement)?.closest('[data-fpp-section]');
		if (!el || !this.content.contains(el)) return null;
		return this.sectionByIndex.get(Number(el.getAttribute('data-fpp-section'))) ?? null;
	}

	// ---------------------------------------------------------------------------------------------
	// Margin
	// ---------------------------------------------------------------------------------------------

	private marginLayer: Margin | null = null;

	/** Notes beside the text, Google Docs style (see `Margin`); created on first use. */
	get margin(): Margin {
		if (!this.marginLayer) {
			const reader = this;
			this.marginLayer = new Margin({
				host: this.host,
				shadow: this.shadow,
				scroller: this.scroller,
				content: this.content,
				win: this.win,
				keepPosition(fn) {
					const loc = reader.rendered ? (reader.currentAnchor() ?? reader.anchor) : null;
					fn();
					if (loc) reader.afterFrameUnlessJumped(() => reader.scrollToRange(loc, { flash: false, position: 'top' }));
				},
				fallbackTop: (range) => this.sectionOf(range.startContainer)?.wrapper.getBoundingClientRect().top ?? null,
			});
		}
		return this.marginLayer;
	}

	/** Ensure both ends of a range are inside section bodies. */
	protected clampRange(range: Range): Range | null {
		const r = range.cloneRange();
		const startSec = this.sectionOf(r.startContainer);
		if (!startSec || !startSec.body.contains(r.startContainer)) {
			const next = this.sections.find((s) => r.comparePoint(s.body, 0) >= 0);
			if (!next) return null;
			r.setStart(next.body, 0);
		}
		const endSec = this.sectionOf(r.endContainer);
		if (!endSec || !endSec.body.contains(r.endContainer)) {
			const prev = [...this.sections].reverse().find((s) => r.comparePoint(s.body, s.body.childNodes.length) <= 0);
			if (!prev) return null;
			r.setEnd(prev.body, prev.body.childNodes.length);
		}
		return r;
	}

	sectionIndexOf(node: Node): number {
		return this.sectionOf(node)?.index ?? -1;
	}

	// ---------------------------------------------------------------------------------------------
	// Navigation
	// ---------------------------------------------------------------------------------------------

	/**
	 * Jump to a locator or TOC item. Returns false when it could not be resolved.
	 * `flash`: briefly highlight the target (default: only for range locators).
	 */
	goTo(target: string | TocItem, opts: { flash?: boolean | FlashOptions } = {}): boolean {
		const range = this.resolve(typeof target === 'string' ? target : target.href);
		if (!range) return false;
		const isPoint = range.collapsed || typeof target !== 'string' || !this.isRangeLocator(target);
		this.scrollToRange(range, { flash: opts.flash ?? !isPoint, position: isPoint ? 'top' : 'center' });
		return true;
	}

	/**
	 * Jump to the very start or end (Vim's `g g` / `G`). Sections near the end are laid out
	 * (content-visibility) only once there, changing the height: the end is followed until the
	 * height holds for 10 frames (at most a second), unless another jump comes first.
	 */
	scrollToEdge(edge: 'start' | 'end'): void {
		const seq = ++this.scrollSeq;
		this.win.clearTimeout(this.relocateTimer);
		const el = this.scroller;
		let height = -1;
		let stable = 0;
		const go = (frames: number) => {
			if (seq !== this.scrollSeq) return;
			el.scrollTop = edge === 'start' ? 0 : el.scrollHeight;
			stable = el.scrollHeight === height ? stable + 1 : 0;
			height = el.scrollHeight;
			if (edge === 'end' && frames > 0 && stable < 10) this.win.requestAnimationFrame(() => go(frames - 1));
		};
		go(60);
	}

	/** Bumped by every jump; deferred scrolls of an older jump (or restore) check it and give way. */
	private scrollSeq = 0;

	/** Run `fn` on the next frame unless another jump happened meanwhile. */
	private afterFrameUnlessJumped(fn: () => void): void {
		const seq = this.scrollSeq;
		this.win.requestAnimationFrame(() => {
			if (seq === this.scrollSeq) fn();
		});
	}

	/** How far down the view `scrollToRange` puts a range at `position: 'center'` (a fraction of its height). */
	readonly centerLine = 0.3;

	scrollToRange(range: Range, opts: { flash?: boolean | FlashOptions; position?: 'top' | 'center' } = {}): void {
		const position = opts.position ?? 'center';
		this.anchor = range;
		this.anchorPosition = position;
		const seq = ++this.scrollSeq;
		const doScroll = () => {
			if (seq !== this.scrollSeq) return;
			const rect = rangeRect(range);
			if (!rect) return;
			const box = this.scroller.getBoundingClientRect();
			const offset = position === 'top' ? 16 : box.height * this.centerLine;
			this.scroller.scrollTop += rect.top - box.top - offset;
		};
		doScroll();
		// content-visibility placeholders around the target get laid out after the jump; correct for drift.
		this.win.requestAnimationFrame(() => {
			doScroll();
			this.win.requestAnimationFrame(doScroll);
		});
		if (opts.flash) this.flash(range, typeof opts.flash === 'object' ? opts.flash : {});
	}

	/** Temporarily highlight a range (drawn above regular highlights), fading out at the end. */
	flash(range: Range, opts: FlashOptions = {}): void {
		if (!this.HighlightCtor) return;
		const o = { ...this.flashDefaults, ...opts };
		const name = this.hlName('flash');
		const h = new this.HighlightCtor!(range);
		h.priority = 10;
		this.registry!.set(name, h);
		this.win.clearTimeout(this.flashTimer);
		this.win.cancelAnimationFrame(this.flashRaf);
		const paint = (alpha: number) => {
			this.flashStyle.textContent = `::highlight(${name}) { background-color: color-mix(in srgb, ${o.color} ${Math.round(alpha * 100)}%, transparent); }`;
		};
		paint(o.opacity);
		const fade = Math.min(o.fade, o.duration);
		this.flashTimer = this.win.setTimeout(() => {
			const start = performance.now();
			const step = (now: number) => {
				const t = Math.min(1, (now - start) / Math.max(1, fade));
				paint(o.opacity * (1 - t));
				if (t < 1) this.flashRaf = this.win.requestAnimationFrame(step);
				else {
					this.registry!.delete(name);
					this.flashStyle.textContent = '';
				}
			};
			this.flashRaf = this.win.requestAnimationFrame(step);
		}, Math.max(0, o.duration - fade));
	}

	setFlashDefaults(opts: FlashOptions): void {
		this.flashDefaults = { ...this.flashDefaults, ...opts };
	}

	/** Current reading position (first visible block). */
	getLocation(): Location | null {
		const anchor = this.currentAnchor();
		if (!anchor) return null;
		const locator = this.locatorFromRange(anchor);
		if (!locator) return null;
		const sh = this.scroller.scrollHeight - this.scroller.clientHeight;
		return {
			locator,
			sectionIndex: this.sectionIndexOf(anchor.startContainer),
			tocItem: this.tocItemAt(anchor),
			progress: sh > 0 ? this.scroller.scrollTop / sh : 0,
		};
	}

	/** A collapsed range at the start of the first block intersecting the top of the viewport. */
	protected currentAnchor(): Range | null {
		if (!this.sections.length) return null;
		// Hidden (a tab in the background) or detached, everything measures 0 and the search below
		// would land on the last section: there's no position to read
		if (!this.scroller.isConnected || !this.scroller.clientHeight) return null;
		// Probe just below the 16px gap that scrollToRange(position: 'top') leaves, so restores are stable.
		const at = this.elementAt(this.scroller.getBoundingClientRect().top + 18);
		const range = this.doc.createRange();
		if (at.found) range.setStartBefore(at.found);
		else range.setStart(at.section.body, 0);
		range.collapse(true);
		return range;
	}

	/** The section at a viewport height `top`, and the first block there (as deep as it's still a block, not a page-tall wrapper) */
	private elementAt(top: number): { section: RenderedSection; found: Element | null } {
		// First section extending below the top edge (sections are separated by margins).
		let sec = this.sections[this.sections.length - 1];
		let lo = 0;
		let hi = this.sections.length - 1;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (this.sections[mid].wrapper.getBoundingClientRect().bottom <= top) lo = mid + 1;
			else hi = mid;
		}
		sec = this.sections[lo] ?? sec;
		let parent: Element = sec.body;
		let found: Element | null = null;
		// Descend through blocks: pick the first child whose bottom is below the viewport top.
		for (let depth = 0; depth < 6; depth++) {
			const kids = Array.from(parent.children);
			if (!kids.length) break;
			let lo = 0;
			let hi = kids.length - 1;
			while (lo < hi) {
				const mid = (lo + hi) >> 1;
				if (kids[mid].getBoundingClientRect().bottom <= top) lo = mid + 1;
				else hi = mid;
			}
			const k = kids[lo];
			const r = k.getBoundingClientRect();
			found = k;
			if (r.top >= top - 2 || r.height < this.scroller.clientHeight / 2) break;
			parent = k;
		}
		return { section: sec, found };
	}

	/**
	 * The sentences in view, top to bottom, each with where its first line in view starts (viewport
	 * coordinates): what keys can pick (`HintOverlay`).
	 */
	visibleSentences(): { range: Range; x: number; y: number }[] {
		if (!this.sections.length || !this.scroller.isConnected || !this.scroller.clientHeight) return [];
		const view = this.scroller.getBoundingClientRect();
		const { section, found } = this.elementAt(view.top);
		const out: { range: Range; x: number; y: number }[] = [];
		const done = new Set<Element>();
		const walker = this.doc.createTreeWalker(this.content, NodeFilter.SHOW_TEXT);
		walker.currentNode = found ?? section.body;
		for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
			if (!n.data.trim() || n.parentElement?.closest('script, style, rt, rp')) continue;
			const block = this.blockOf(n);
			if (!block || done.has(block)) continue;
			done.add(block);
			const r = block.getBoundingClientRect();
			if (r.top >= view.bottom) break;
			if (r.bottom <= view.top || !r.height) continue;
			for (const range of sentenceRanges(block, langOf(block))) {
				const line = this.lineInView(range, view);
				if (line) out.push({ range, x: line.left, y: line.top });
			}
		}
		return out;
	}

	/** The words in view (of `within`, else of every sentence in view), each with where it starts, as `visibleSentences` */
	visibleWords(within?: Range): { range: Range; x: number; y: number }[] {
		if (!this.scroller.isConnected || !this.scroller.clientHeight) return [];
		const view = this.scroller.getBoundingClientRect();
		const out: { range: Range; x: number; y: number }[] = [];
		for (const part of within ? [within] : this.visibleSentences().map((s) => s.range)) {
			const block = this.blockOf(part.startContainer);
			for (const range of wordRanges(part, block ? langOf(block) : undefined)) {
				const line = this.lineInView(range, view);
				if (line) out.push({ range, x: line.left, y: line.top });
			}
		}
		return out;
	}

	/** The first line of `range` in view (viewport coordinates), if any */
	lineOnScreen(range: Range): DOMRect | undefined {
		if (!this.scroller.isConnected || !this.scroller.clientHeight) return undefined;
		return this.lineInView(range, this.scroller.getBoundingClientRect());
	}

	/** The first line box of `range` inside the viewport `view` */
	private lineInView(range: Range, view: DOMRect): DOMRect | undefined {
		return Array.from(range.getClientRects()).find((q) => q.width > 0 && q.height > 0 && q.bottom > view.top + 2 && q.top < view.bottom - 2);
	}

	// ---------------------------------------------------------------------------------------------
	// Table of contents
	// ---------------------------------------------------------------------------------------------

	/** Deepest TOC entry at or before the given position. */
	tocItemAt(range: AbstractRange): TocItem | null {
		if (!this.tocTargets) {
			const targets: { item: TocItem; node: Node }[] = [];
			for (const item of flattenToc(this.toc)) {
				const r = item.href ? this.resolve(item.href) : null;
				if (r) targets.push({ item, node: r.startContainer.childNodes[r.startOffset] ?? r.startContainer });
			}
			// Stable sort keeps parents before children that point at the same node.
			targets.sort((x, y) => (x.node === y.node ? 0 : x.node.compareDocumentPosition(y.node) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
			this.tocTargets = targets;
		}
		const point = (this.scratchRange ??= this.doc.createRange());
		point.setStart(range.startContainer, range.startOffset);
		point.collapse(true);
		let best: TocItem | null = null;
		for (const t of this.tocTargets) {
			if (point.comparePoint(t.node, 0) <= 0) best = t.item;
			else break;
		}
		return best;
	}

	// ---------------------------------------------------------------------------------------------
	// Selection
	// ---------------------------------------------------------------------------------------------

	getSelectionRange(): Range | null {
		const sel: Selection | null = (this.shadow as any).getSelection?.() ?? this.doc.getSelection();
		if (!sel) return null;
		// Selections inside shadow roots: Chromium has shadowRoot.getSelection(); WebKit/Gecko use
		// getComposedRanges, whose signature changed ({shadowRoots: [...]} vs. spread roots), so try both
		// and fall back to the plain range. Use the first candidate that lies inside the document.
		const candidates: AbstractRange[] = [];
		const getComposed = (sel as any).getComposedRanges as ((...a: unknown[]) => StaticRange[]) | undefined;
		if (getComposed) {
			for (const args of [[{ shadowRoots: [this.shadow] }], [this.shadow]]) {
				try {
					const ranges = getComposed.apply(sel, args);
					if (ranges?.length) {
						candidates.push(ranges[0]);
						break;
					}
				} catch {
					/* other signature */
				}
			}
		}
		if (sel.rangeCount) candidates.push(sel.getRangeAt(0));
		for (const r of candidates) {
			if (r.collapsed || !this.content.contains(r.startContainer) || !this.content.contains(r.endContainer)) continue;
			const range = this.doc.createRange();
			range.setStart(r.startContainer, r.startOffset);
			range.setEnd(r.endContainer, r.endOffset);
			return range;
		}
		return null;
	}

	describeRange(range: Range): SelectionInfo | null {
		const r = this.clampRange(range);
		if (!r) return null;
		const locator = this.locatorFromRange(r);
		if (!locator) return null;
		let tf: string | null | undefined;
		let md: string | undefined;
		let ctx: SelectionContext | undefined;
		return {
			range: r,
			text: rangeText(r),
			locator,
			sectionIndex: this.sectionIndexOf(r.startContainer),
			tocItem: this.tocItemAt(r),
			textFragment: () => (tf === undefined ? (tf = this.textFragmentFromRange(r)) : tf),
			markdown: () => (md ??= rangeToMarkdown(r)),
			context: () => (ctx ??= this.selectionContext(r)),
		};
	}

	/**
	 * A range in its sentences: the rest of the sentences it starts and ends in or, when it covers
	 * whole sentences (leaving out quotes and final punctuation still counts), also the sentence before
	 * and after, from the neighboring paragraph when it's the first or last of its own (never a heading's).
	 */
	selectionContext(range: Range): SelectionContext {
		let text = rangeText(range);
		const startBlock = this.blockOf(range.startContainer);
		const endBlock = this.blockOf(range.endContainer);
		if (!startBlock || !endBlock) return { before: '', text, after: '' };
		const a = blockText(startBlock);
		const b = startBlock === endBlock ? a : blockText(endBlock);
		const at = a.offset(range.startContainer, range.startOffset);
		const to = b.offset(range.endContainer, range.endOffset);
		const s = sentenceStartAt(a.text, at, langOf(startBlock), a.notes);
		const e = sentenceEndAt(b.text, to, langOf(endBlock), b.notes);
		// Spaces at the selection's edges (`rangeText` trims them) still separate it from what's around it
		if (/\s/.test(a.text[at] ?? '')) text = ` ${text}`;
		if (/\s/.test(b.text[to - 1] ?? '')) text = `${text} `;
		const flat = (t: string) => t.replace(/\s+/g, ' ');
		let before = flat(a.text.slice(s.start, at)).trimStart();
		let after = flat(b.text.slice(to, e.end)).trimEnd();
		if (s.whole && e.whole) {
			if (s.prev) before = `${flat(a.text.slice(s.prev[0], s.start))}${before}`;
			else {
				const prev = this.neighborSentence(startBlock, -1);
				if (prev) before = `${prev}\n\n${before}`;
			}
			if (e.next) after = `${after}${flat(b.text.slice(e.end, e.next[1]))}`;
			else {
				const next = this.neighborSentence(endBlock, 1);
				if (next) after = `${after}\n\n${next}`;
			}
		}
		return { before, text, after };
	}

	/** The paragraph-like block of a node (null: none inside the content) */
	private blockOf(node: Node): Element | null {
		const block = (node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement)?.closest(BLOCKS) ?? null;
		return block && block !== this.content && this.content.contains(block) ? block : null;
	}

	/** The last sentence of the block before `block` (`dir` -1) or the first of the one after (1), in its section; not a heading's */
	private neighborSentence(block: Element, dir: -1 | 1): string | null {
		const walker = this.doc.createTreeWalker(this.content, NodeFilter.SHOW_TEXT);
		if (dir < 0) walker.currentNode = block;
		else {
			const inner = this.doc.createTreeWalker(block, NodeFilter.SHOW_TEXT);
			let last: Node | null = null;
			for (let n = inner.nextNode(); n; n = inner.nextNode()) last = n;
			walker.currentNode = last ?? block;
		}
		const section = this.sectionIndexOf(block);
		for (let n = dir < 0 ? walker.previousNode() : walker.nextNode(); n; n = dir < 0 ? walker.previousNode() : walker.nextNode()) {
			if (!(n as Text).data.trim() || n.parentElement?.closest('script, style, rt, rp')) continue;
			const other = this.blockOf(n);
			if (!other || other.contains(block) || block.contains(other) || /^h[1-6]$/.test(other.localName)) return null;
			if (this.sectionIndexOf(other) !== section) return null;
			const { text, notes } = blockText(other);
			const bounds = sentenceBounds(text, langOf(other), notes).filter(([x, y]) => y > x);
			const [x, y] = (dir < 0 ? bounds[bounds.length - 1] : bounds[0]) ?? [0, 0];
			return text.slice(x, y).replace(/\s+/g, ' ') || null;
		}
		return null;
	}

	getSelection(): SelectionInfo | null {
		const r = this.getSelectionRange();
		return r ? this.describeRange(r) : null;
	}

	clearSelection(): void {
		((this.shadow as any).getSelection?.() ?? this.doc.getSelection())?.removeAllRanges();
	}

	/** Selects `range` (in the document) */
	select(range: Range): void {
		const sel: Selection | null = (this.shadow as any).getSelection?.() ?? this.doc.getSelection();
		sel?.removeAllRanges();
		sel?.addRange(range);
	}

	/**
	 * What the `count`th click in a row at (x, y) selects, from the third on (null: the browser's
	 * own): the sentence, then its paragraph. Formats with other units (verses) override it.
	 */
	protected multiClickRange(count: number, x: number, y: number, target: Element): Range | null {
		const block = target.closest(BLOCKS);
		if (!block || block === this.content || !this.content.contains(block)) return null;
		if (count === 3) {
			const at = this.caretAt(x, y);
			if (at && block.contains(at[0])) {
				const lang = block.closest('[lang], [xml\\:lang]');
				return sentenceRange(block, at[0], at[1], lang?.getAttribute('lang') ?? lang?.getAttribute('xml:lang') ?? undefined);
			}
		}
		const range = this.doc.createRange();
		range.selectNodeContents(block);
		return range;
	}

	/** The text position at (x, y) in the document */
	protected caretAt(x: number, y: number): [Node, number] | null {
		const d = this.doc as Document & { caretPositionFromPoint?(x: number, y: number, opts?: { shadowRoots: ShadowRoot[] }): CaretPosition | null };
		try {
			const pos = d.caretPositionFromPoint?.(x, y, { shadowRoots: [this.shadow] });
			if (pos && this.content.contains(pos.offsetNode)) return [pos.offsetNode, pos.offset];
		} catch {
			/* no shadowRoots option */
		}
		// The word a double click just selected there
		const sel = this.getSelectionRange();
		return sel && rectsContain(sel, x, y) ? [sel.startContainer, sel.startOffset] : null;
	}

	// ---------------------------------------------------------------------------------------------
	// Highlights
	// ---------------------------------------------------------------------------------------------

	setHighlights(specs: HighlightSpec[]): void {
		this.highlights = specs.map((spec) => ({ spec, range: this.cachedRange(spec.locator) }));
		this.refreshHighlights();
	}

	getHighlights(): HighlightSpec[] {
		return this.highlights.map((h) => h.spec);
	}

	private highlightsHidden = false;

	/** Stop drawing highlights (they also stop reacting to the pointer), or draw them again. Ranges stay resolved. */
	setHighlightsHidden(hidden: boolean): void {
		if (hidden === this.highlightsHidden) return;
		this.highlightsHidden = hidden;
		this.refreshHighlights(true);
	}

	get highlightsAreHidden(): boolean {
		return this.highlightsHidden;
	}

	private focused = new Set<string>();

	/**
	 * Draw attention to some highlights (e.g. the one whose comment is being looked at): the others are
	 * dimmed, or, while highlights are hidden, only these are drawn. An empty list ends it.
	 */
	setFocusedHighlights(ids: string[]): void {
		const next = new Set(ids);
		if (next.size === this.focused.size && ids.every((id) => this.focused.has(id))) return;
		this.focused = next;
		this.refreshHighlights(true);
	}

	/** Whether a highlight is drawn (and reacts to the pointer). */
	private isDrawn(id: string): boolean {
		return this.targetLevel(id) > 0;
	}

	private cachedRange(locator: string): Range | null {
		if (!this.rendered) return null;
		if (!this.rangeCache.has(locator)) this.rangeCache.set(locator, this.resolve(locator));
		return this.rangeCache.get(locator)!;
	}

	private hlName(key: string): string {
		return `fpp-${this.id}-${key}`;
	}

	private colorKey(color: string | undefined): { key: string; css: string } {
		const name = color && color in this.palette ? color : !color ? this.defaultColor : null;
		if (name) return { key: `c-${name.replace(/[^\w-]/g, '_')}`, css: this.palette[name] ?? this.palette[this.defaultColor] ?? '#ffd000' };
		const valid = typeof CSS !== 'undefined' && CSS.supports?.('color', color!);
		const cssColor = valid ? color! : (this.palette[this.defaultColor] ?? '#ffd000');
		return { key: `x-${hash(cssColor)}`, css: cssColor };
	}

	/** Strength a highlight should be drawn at: 1 normal, DIMMED when others are focused, 0 not drawn. */
	private targetLevel(id: string): number {
		if (this.highlightsHidden) return this.focused.has(id) ? 1 : 0;
		return this.focused.size && !this.focused.has(id) ? DIMMED : 1;
	}

	/** Strength each highlight was drawn at when the current transition started (or is drawn at, after it). */
	private levels = new Map<string, number>();
	/** The running transition: its groups' strengths ease from `from` to `to`. */
	private transition: { start: number; raf: number } | null = null;
	/** What is painted: one `Highlight` per color and transition (from → to). */
	private paintGroups: { name: string; css: string; from: number; to: number }[] = [];

	/** Strength of a highlight right now (mid-transition, in between). */
	private currentLevel(id: string, target: number): number {
		const g = this.paintGroupOf.get(id);
		if (!g) return this.levels.get(id) ?? target;
		return g.from + (g.to - g.from) * this.progress();
	}
	private paintGroupOf = new Map<string, { from: number; to: number }>();

	private progress(): number {
		if (!this.transition) return 1;
		const t = Math.min(1, (performance.now() - this.transition.start) / HIGHLIGHT_TRANSITION_MS);
		return 1 - (1 - t) * (1 - t); // ease out
	}

	/**
	 * Paint the highlights. With `animate`, each one eases from the strength it is drawn at now to its
	 * new one (focus, dimming, hiding); otherwise they jump there.
	 */
	private refreshHighlights(animate = false): void {
		if (!this.rendered || !this.HighlightCtor) return;
		const groups = new Map<string, { css: string; from: number; to: number; ranges: Range[] }>();
		const levels = new Map<string, number>();
		const groupOf = new Map<string, { from: number; to: number }>();
		for (const h of this.highlights) {
			if (!h.range) h.range = this.cachedRange(h.spec.locator);
			if (!h.range) continue;
			const to = this.targetLevel(h.spec.id);
			const from = animate ? Math.round(this.currentLevel(h.spec.id, to) * 100) / 100 : to;
			levels.set(h.spec.id, from);
			if (!from && !to) continue;
			const color = this.colorKey(h.spec.color);
			const key = `${color.key}-${Math.round(from * 100)}-${Math.round(to * 100)}`;
			let g = groups.get(key);
			if (!g) groups.set(key, (g = { css: color.css, from, to, ranges: [] }));
			g.ranges.push(h.range);
			groupOf.set(h.spec.id, g);
		}
		for (const name of this.highlightNames) this.registry!.delete(name);
		this.highlightNames.clear();
		this.paintGroups = [];
		for (const [key, g] of groups) {
			const name = this.hlName(key);
			this.registry!.set(name, new this.HighlightCtor!(...g.ranges));
			this.highlightNames.add(name);
			this.paintGroups.push({ name, css: g.css, from: g.from, to: g.to });
		}
		this.levels = levels;
		this.paintGroupOf = groupOf;
		if (this.transition) this.win.cancelAnimationFrame(this.transition.raf);
		this.transition = null;
		const moving = this.paintGroups.some((g) => g.from !== g.to);
		if (!moving) return this.updateHighlightStyles();
		this.transition = { start: performance.now(), raf: 0 };
		const frame = () => {
			if (!this.transition) return;
			this.updateHighlightStyles();
			if (this.progress() < 1) this.transition.raf = this.win.requestAnimationFrame(frame);
			else {
				// Settled: remember where everything ended up.
				for (const [id, g] of this.paintGroupOf) this.levels.set(id, g.to);
				this.paintGroupOf.clear();
				for (const g of this.paintGroups) g.from = g.to;
				this.transition = null;
			}
		};
		frame();
	}

	private updateHighlightStyles(): void {
		const pct = this.highlightOpacity * 100;
		const p = this.progress();
		const rules = [
			`::highlight(${this.hlName('search')}) { background-color: rgba(255, 170, 0, 0.35); }`,
			`::highlight(${this.hlName('search-current')}) { background-color: rgba(255, 120, 0, 0.8); color: black; }`,
			`::highlight(${this.hlName('pending')}) { background-color: var(--text-selection, Highlight); }`,
			`::highlight(${this.hlName('hover')}) { text-decoration: underline 2px; text-decoration-color: currentColor; }`,
			`::highlight(${this.hlName('selected')}) { text-decoration: underline 3px; text-decoration-color: var(--interactive-accent, #7c5cff); }`,
			`::highlight(${this.hlName('playing')}) { background-color: color-mix(in srgb, var(--interactive-accent, #7c5cff) 22%, transparent); }`,
		];
		for (const g of this.paintGroups) {
			const level = g.from + (g.to - g.from) * p;
			rules.push(`::highlight(${g.name}) { background-color: color-mix(in srgb, ${g.css} ${(pct * level).toFixed(1)}%, transparent); }`);
		}
		this.highlightStyle.textContent = rules.join('\n');
	}

	/**
	 * Paint a range as if it were selected (or clear it with null). Lets an app drop the native
	 * selection (and with it the OS selection toolbar on mobile) while its own menu is open.
	 */
	setPendingSelection(range: Range | null): void {
		const name = this.hlName('pending');
		if (range && this.HighlightCtor) {
			const h = new this.HighlightCtor(range);
			h.priority = 20;
			this.registry!.set(name, h);
		} else this.registry?.delete(name);
	}

	/** Mark a highlight as the one keys act on (underlined; null: none) */
	setSelectedHighlight(range: Range | null): void {
		const name = this.hlName('selected');
		if (range && this.HighlightCtor) {
			const h = new this.HighlightCtor(range);
			h.priority = 15;
			this.registry!.set(name, h);
		} else this.registry?.delete(name);
	}

	/**
	 * Mark what a media player is reading (a cue, a verse), under the document's highlights; null
	 * clears it. Formats whose units are elements may mark them themselves instead.
	 */
	setPlayingRange(range: AbstractRange | null): void {
		const name = this.hlName('playing');
		if (range && this.HighlightCtor) {
			const h = new this.HighlightCtor(range);
			h.priority = -2;
			this.registry!.set(name, h);
		} else this.registry?.delete(name);
	}

	/** Highlights under a viewport point. */
	highlightsAt(x: number, y: number): HighlightSpec[] {
		const out: HighlightSpec[] = [];
		for (const h of this.highlights) {
			if (h.range && this.isDrawn(h.spec.id) && linesContain(h.range, x, y)) out.push(h.spec);
		}
		return out;
	}

	/** Temporarily emphasize the highlight(s) with the given ids (e.g. when hovering a backlink). */
	setHoveredHighlights(ids: string[]): void {
		const name = this.hlName('hover');
		const ranges = this.highlights.filter((h) => h.range && ids.includes(h.spec.id)).map((h) => h.range!);
		if (ranges.length) this.registry?.set(name, new this.HighlightCtor!(...ranges));
		else this.registry?.delete(name);
	}

	/** The CSS color a highlight is drawn in. */
	highlightColor(id: string): string | null {
		const h = this.highlights.find((h) => h.spec.id === id);
		return h ? this.colorKey(h.spec.color).css : null;
	}

	/** Range for a highlight spec (resolved). */
	highlightRange(id: string): Range | null {
		return this.highlights.find((h) => h.spec.id === id)?.range ?? null;
	}

	// ---------------------------------------------------------------------------------------------
	// Annotation layers
	// ---------------------------------------------------------------------------------------------

	/**
	 * Show a layer of annotations, e.g. ones another tool found in the document. Unlike highlights there
	 * may be thousands, so they are painted with static ranges and hit-tested by element. Calling it
	 * again with the same id replaces the layer.
	 */
	setLayer(id: string, specs: HighlightSpec[], opts: AnnotationLayerOptions = {}): void {
		const prev = this.layers.get(id);
		const layer: Layer = { key: prev?.key ?? ++this.layerCounter, opts, items: specs.map((spec) => ({ spec, range: null })), buckets: new Map(), resolved: false, names: prev?.names ?? [] };
		this.layers.set(id, layer);
		this.paintLayers();
	}

	removeLayer(id: string): void {
		const layer = this.layers.get(id);
		if (!layer) return;
		for (const name of layer.names) this.registry?.delete(name);
		this.layers.delete(id);
		this.paintLayers();
	}

	getLayer(id: string): HighlightSpec[] {
		return this.layers.get(id)?.items.map((i) => i.spec) ?? [];
	}

	/** A live range for an annotation of a layer (null when its locator doesn't resolve). */
	layerRange(layerId: string, specId: string): Range | null {
		const layer = this.layers.get(layerId);
		if (!layer) return null;
		this.resolveLayer(layer);
		const r = layer.items.find((i) => i.spec.id === specId)?.range;
		if (!r) return null;
		const range = this.doc.createRange();
		range.setStart(r.startContainer, r.startOffset);
		range.setEnd(r.endContainer, r.endOffset);
		return range;
	}

	/**
	 * A layer's annotations in document order, each with its text and chapter. Annotations whose locator
	 * doesn't resolve come last, with null text. With `context`, each also has up to that many
	 * characters of its paragraph (or cue, or other block) before and after it.
	 */
	describeLayer(id: string, opts: { context?: number } = {}): LayerItem[] {
		const layer = this.layers.get(id);
		if (!layer) return [];
		this.resolveLayer(layer);
		const a = this.doc.createRange();
		const b = this.doc.createRange();
		const set = (r: Range, s: StaticRange) => {
			r.setStart(s.startContainer, s.startOffset);
			r.setEnd(s.endContainer, s.endOffset);
		};
		const items = layer.items.filter((i) => i.range).sort((x, y) => {
			set(a, x.range!);
			set(b, y.range!);
			return a.compareBoundaryPoints(Range.START_TO_START, b) || a.compareBoundaryPoints(Range.END_TO_END, b);
		});
		const out: LayerItem[] = items.map((i) => {
			set(a, i.range!);
			const item: LayerItem = { spec: i.spec, text: a.toString().replace(/\s+/g, ' ').trim(), tocItem: this.tocItemAt(i.range!) };
			if (opts.context) Object.assign(item, this.textAround(i.range!, opts.context, b));
			return item;
		});
		for (const i of layer.items) if (!i.range) out.push({ spec: i.spec, text: null, tocItem: null });
		a.detach();
		b.detach();
		return out;
	}

	/** Up to `n` characters of a range's block before and after it, whitespace collapsed (`scratch` is reused) */
	private textAround(r: StaticRange, n: number, scratch: Range): { before: string; after: string } {
		const blockOf = (node: Node) => (node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement)?.closest(BLOCKS) ?? null;
		const start = blockOf(r.startContainer);
		const end = blockOf(r.endContainer);
		let before = '';
		let after = '';
		if (start) {
			scratch.setStart(start, 0);
			scratch.setEnd(r.startContainer, r.startOffset);
			before = scratch.toString().replace(/\s+/g, ' ').trimStart();
		}
		if (end) {
			scratch.setStart(r.endContainer, r.endOffset);
			scratch.setEnd(end, end.childNodes.length);
			after = scratch.toString().replace(/\s+/g, ' ').trimEnd();
		}
		// Cut at a word, with an ellipsis where the block goes on
		if (before.length > n) before = `…${before.slice(before.indexOf(' ', before.length - n) + 1)}`;
		if (after.length > n) after = `${after.slice(0, after.lastIndexOf(' ', n) > 0 ? after.lastIndexOf(' ', n) : n)}…`;
		return { before, after };
	}

	private resolveLayer(layer: Layer): void {
		if (layer.resolved || !this.rendered) return;
		layer.resolved = true;
		const add = (el: Element | null, i: number) => {
			if (!el) return;
			const list = layer.buckets.get(el);
			if (list) {
				if (list[list.length - 1] !== i) list.push(i);
			} else layer.buckets.set(el, [i]);
		};
		const elementOf = (n: Node) => (n.nodeType === 1 ? (n as Element) : n.parentElement);
		layer.items.forEach((item, i) => {
			const r = this.cachedRange(item.spec.locator);
			if (!r) return;
			item.range = new StaticRange({ startContainer: r.startContainer, startOffset: r.startOffset, endContainer: r.endContainer, endOffset: r.endOffset });
			add(elementOf(r.startContainer), i);
			add(elementOf(r.endContainer), i);
			add(elementOf(r.commonAncestorContainer), i);
		});
		// Live ranges slow down every DOM mutation; the static ones above are what layers keep.
		for (const item of layer.items) this.rangeCache.delete(item.spec.locator);
	}

	private paintLayers(): void {
		if (!this.rendered || !this.HighlightCtor) return;
		const pct = Math.round(this.highlightOpacity * 100);
		const rules: string[] = [];
		for (const layer of this.layers.values()) {
			this.resolveLayer(layer);
			for (const name of layer.names) this.registry!.delete(name);
			layer.names = [];
			if (layer.opts.hidden) continue;
			const groups = new Map<string, { css: string; ranges: StaticRange[] }>();
			for (const item of layer.items) {
				if (!item.range) continue;
				const { key, css } = this.colorKey(item.spec.color);
				let g = groups.get(key);
				if (!g) groups.set(key, (g = { css, ranges: [] }));
				g.ranges.push(item.range);
			}
			for (const [key, g] of groups) {
				const name = this.hlName(`layer${layer.key}-${key}`);
				const h = new this.HighlightCtor!(...g.ranges);
				h.priority = layer.opts.priority ?? -1;
				this.registry!.set(name, h);
				layer.names.push(name);
				const style = layer.opts.style?.(g.css) ?? `background-color: color-mix(in srgb, ${g.css} ${pct}%, transparent);`;
				rules.push(`::highlight(${name}) { ${style} }`);
			}
		}
		this.layerStyle.textContent = rules.join('\n');
	}

	/** Annotations of all layers under a viewport point. */
	layerHitsAt(x: number, y: number): LayerHit[] {
		if (!this.layers.size) return [];
		let el: Element | null = (this.shadow as unknown as DocumentOrShadowRoot).elementFromPoint?.(x, y) ?? null;
		if (!el || !this.content.contains(el)) return [];
		const chain: Element[] = [];
		for (; el && el !== this.content; el = el.parentElement) chain.push(el);
		const range = (this.hitRange ??= this.doc.createRange());
		const out: LayerHit[] = [];
		for (const [id, layer] of this.layers) {
			if (layer.opts.hidden) continue;
			this.resolveLayer(layer);
			const seen = new Set<number>();
			for (const e of chain) {
				for (const i of layer.buckets.get(e) ?? []) {
					if (seen.has(i)) continue;
					seen.add(i);
					const r = layer.items[i].range!;
					range.setStart(r.startContainer, r.startOffset);
					range.setEnd(r.endContainer, r.endOffset);
					if (rectsContain(range, x, y, 1)) out.push({ layer: id, spec: layer.items[i].spec });
				}
			}
		}
		return out;
	}

	// ---------------------------------------------------------------------------------------------
	// Search
	// ---------------------------------------------------------------------------------------------

	search(query: string, opts: SearchOptions = {}): SearchResult[] {
		if (!this.rendered) return [];
		const index = this.textIndex;
		return searchIndex(index, query, opts).map((m) => {
			let range: Range | null = null;
			let staticRange: StaticRange | null = null;
			const getRange = () => (range ??= index.toRange(m.start, m.end));
			const getStatic = () => (staticRange ??= index.toStaticRange(m.start, m.end));
			return {
				...m,
				range: getRange,
				staticRange: getStatic,
				locator: () => this.locatorFromRange(getRange()) ?? '',
				tocItem: () => this.tocItemAt(getStatic()),
			};
		});
	}

	/** Paint search matches; `current` is emphasized and scrolled into view. */
	showSearchResults(results: SearchResult[], current = -1): void {
		if (!this.HighlightCtor) return;
		const all = this.hlName('search');
		const cur = this.hlName('search-current');
		if (!results.length) {
			this.registry!.delete(all);
			this.registry!.delete(cur);
			return;
		}
		// Static ranges: thousands of live Ranges would slow down every DOM mutation in the window.
		this.registry!.set(all, new this.HighlightCtor!(...results.map((r) => r.staticRange())));
		const c = results[current];
		if (c) {
			this.registry!.set(cur, new this.HighlightCtor!(c.staticRange()));
			this.scrollToRange(c.range(), { flash: false, position: 'center' });
		} else this.registry!.delete(cur);
	}

	// ---------------------------------------------------------------------------------------------
	// Events
	// ---------------------------------------------------------------------------------------------

	private bindEvents(): void {
		// Moving the host in the DOM (e.g. dragging a tab to another pane) or hiding it resets scrollTop,
		// and width changes reflow the text: restore the reading anchor in both cases.
		if (typeof ResizeObserver !== 'undefined') {
			const ro = new ResizeObserver(() => {
				const w = this.host.clientWidth;
				const h = this.host.clientHeight;
				const prev = this.hostSize;
				this.hostSize = { w, h };
				if (!w || !h || !this.rendered || !this.anchor) return;
				if (!prev.w || !prev.h || prev.w !== w) {
					this.win.clearTimeout(this.relocateTimer);
					this.scrollToRange(this.anchor, { position: this.anchorPosition });
				}
			});
			ro.observe(this.host);
			this.cleanup.push(() => ro.disconnect());
		}

		const on = <K extends keyof HTMLElementEventMap>(el: EventTarget, type: K, fn: (e: HTMLElementEventMap[K]) => void, opts?: AddEventListenerOptions) => {
			el.addEventListener(type, fn as EventListener, opts);
			this.cleanup.push(() => el.removeEventListener(type, fn as EventListener, opts));
		};

		/** Follows a link inside the document */
		const follow = (href: string, e: MouseEvent) => {
			if (!this.onInternalLink?.(href, e)) this.goTo(href);
		};
		// Footnotes: shown on hovering (or tapping) their links
		const notes = new NotePreview({
			doc: this.doc,
			scroller: this.scroller,
			content: this.content,
			target: (href) => {
				if (!href.includes('#')) return null;
				const r = this.resolve(href);
				const node = r && !r.collapsed && r.startContainer.childNodes[r.startOffset];
				return node && node.nodeType === 1 ? (node as Element) : null;
			},
			follow,
		});
		this.cleanup.push(() => notes.hide());
		let touchedAt = 0;
		on(this.scroller, 'touchstart', (e) => {
			touchedAt = Date.now();
			if (!notes.contains(e.target as Node)) notes.hide();
		}, { capture: true, passive: true });
		// Mouse events a tap emits don't count
		on(this.scroller, 'mouseover', (e) => {
			if (Date.now() - touchedAt > 800) notes.pointerOver(e.target);
		});
		on(this.scroller, 'mouseleave', () => {
			if (Date.now() - touchedAt > 800) notes.pointerOver(null);
		});
		on(this.scroller, 'scroll', () => notes.hide());

		on(this.scroller, 'click', (e) => {
			if (notes.contains(e.target as Node)) return notes.click(e);
			const a = (e.target as Element | null)?.closest?.('a');
			if (a && this.content.contains(a)) {
				const internal = a.getAttribute('data-fpp-href');
				const external = a.getAttribute('data-fpp-external');
				if (internal || external) {
					e.preventDefault();
					// A tap on a note link shows the note (a tap on it goes there)
					const note = internal && Date.now() - touchedAt < 800 ? notes.noteLinkAt(a) : null;
					if (note) return notes.show(note.a, note.href, note.note);
					notes.hide();
					if (internal) follow(internal, e);
					else if (external) this.emit('external-link', e, external);
					return;
				}
			}
			const sel = this.getSelectionRange();
			if (sel) return;
			const hits = this.highlightsAt(e.clientX, e.clientY);
			if (hits.length) {
				this.emit('highlight-click', e, hits);
				return;
			}
			const annotations = this.layerHitsAt(e.clientX, e.clientY);
			if (annotations.length) this.emit('annotation-click', e, annotations);
		});

		// A triple click selects the sentence, a fourth the paragraph. Counted here: Chromium on Linux
		// starts `detail` again at 1 after a triple click. Taps (their synthetic mousedowns) don't count.
		let clicks = { count: 0, at: 0, x: 0, y: 0 };
		on(this.scroller, 'mousedown', (e) => {
			if (e.button !== 0 || Date.now() - touchedAt < 800) return;
			const now = Date.now();
			const again = e.detail > 1 || (now - clicks.at < 600 && Math.hypot(e.clientX - clicks.x, e.clientY - clicks.y) < 8);
			clicks = { count: again ? Math.max(clicks.count + 1, e.detail) : 1, at: now, x: e.clientX, y: e.clientY };
			if (clicks.count < 3) return;
			const el = e.composedPath()[0];
			if (!(el instanceof Element) || !this.content.contains(el)) return;
			const range = this.multiClickRange(clicks.count, e.clientX, e.clientY, el);
			if (!range) return;
			e.preventDefault();
			this.select(range);
		}, { capture: true });

		on(this.scroller, 'contextmenu', (e) => {
			const range = this.getSelectionRange();
			let selection = range ? this.describeRange(range) : null;
			// Ignore a selection that isn't under the pointer.
			if (selection && !rectsContain(selection.range, e.clientX, e.clientY)) selection = null;
			this.emit('contextmenu', e, { selection, highlights: this.highlightsAt(e.clientX, e.clientY), annotations: this.layerHitsAt(e.clientX, e.clientY) });
		});

		let hoverRaf = 0;
		/** The pointer's last move over the text, to check again what is under it after scrolling. */
		let pointer: MouseEvent | null = null;
		on(this.scroller, 'mouseleave', (e) => {
			pointer = null;
			this.win.clearTimeout(this.hoverLeaveTimer);
			if (this.lastHover) {
				this.lastHover = '';
				this.emit('highlight-hover', e, []);
			}
			if (this.lastLayerHover) {
				this.lastLayerHover = '';
				this.emit('annotation-hover', e, []);
			}
		});
		const checkHover = (e: MouseEvent) => {
			if (hoverRaf || (!this.highlights.length && !this.layers.size)) return;
			hoverRaf = this.win.requestAnimationFrame(() => {
				hoverRaf = 0;
				const hits = this.highlightsAt(e.clientX, e.clientY);
				const annotations = this.layerHitsAt(e.clientX, e.clientY);
				this.scroller.style.cursor = hits.length || annotations.length ? 'pointer' : '';
				const key = hits.map((h) => h.id).join('|');
				this.win.clearTimeout(this.hoverLeaveTimer);
				if (!key && this.lastHover) {
					// Leaving highlights: wait a moment, so crossing to an adjacent one doesn't flash the others.
					this.hoverLeaveTimer = this.win.setTimeout(() => {
						this.lastHover = '';
						this.emit('highlight-hover', e, []);
					}, HOVER_LEAVE_MS);
				} else if (key !== this.lastHover) {
					this.lastHover = key;
					this.emit('highlight-hover', e, hits);
				}
				const layerKey = annotations.map((a) => `${a.layer}:${a.spec.id}`).join('|');
				if (layerKey !== this.lastLayerHover) {
					this.lastLayerHover = layerKey;
					this.emit('annotation-hover', e, annotations);
				}
			});
		};
		on(this.scroller, 'mousemove', (e) => {
			pointer = e;
			checkHover(e);
		});

		on(this.scroller, 'scroll', () => {
			// The text moved under a still pointer: what it is over may have changed.
			if (pointer) checkHover(pointer);
			this.win.clearTimeout(this.relocateTimer);
			this.relocateTimer = this.win.setTimeout(() => {
				// Skip while hidden, detached, or after moving to another window (the owner rebuilds us then).
				if (!this.host.isConnected || !this.host.clientHeight || this.host.ownerDocument !== this.doc) return;
				const a = this.currentAnchor();
				if (a) {
					this.anchor = a;
					this.anchorPosition = 'top';
				}
				const loc = this.getLocation();
				if (loc) this.emit('relocated', loc);
			}, 150);
		}, { passive: true });

		let selTimer = 0;
		on(this.doc, 'selectionchange' as any, () => {
			this.win.clearTimeout(selTimer);
			selTimer = this.win.setTimeout(() => {
				if (this.destroyed) return;
				const r = this.getSelectionRange();
				this.emit('selectionchange', r ? this.describeRange(r) : null);
			}, 250);
		});
	}

	destroy(): void {
		this.destroyed = true;
		this.win.clearTimeout(this.relocateTimer);
		this.win.clearTimeout(this.flashTimer);
		this.win.clearTimeout(this.hoverLeaveTimer);
		this.win.cancelAnimationFrame(this.flashRaf);
		for (const fn of this.cleanup) fn();
		this.marginLayer?.destroy();
		if (this.transition) this.win.cancelAnimationFrame(this.transition.raf);
		for (const name of this.highlightNames) this.registry?.delete(name);
		for (const layer of this.layers.values()) for (const name of layer.names) this.registry?.delete(name);
		for (const k of ['flash', 'search', 'search-current', 'hover', 'pending', 'selected']) this.registry?.delete(this.hlName(k));
		this.shadow.replaceChildren();
		this.removeAllListeners();
	}
}

/** The place right before a node, in its parent */
function before(node: Node): [Node, number] {
	const parent = node.parentNode!;
	return [parent, Array.prototype.indexOf.call(parent.childNodes, node)];
}

/** Lets the browser paint and handle input during long work (rendering a long document in steps). */
export function yieldToBrowser(): Promise<void> {
	return new Promise((r) => setTimeout(r, 0));
}

function hash(s: string): string {
	let h = 0;
	for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
	return (h >>> 0).toString(36);
}

function rangeRect(range: Range): DOMRect | null {
	const rects = range.getClientRects();
	if (rects.length) return rects[0];
	// Collapsed points between blocks (e.g. inside whitespace-only text) have no box: use the nearest
	// rendered element after the point, else before it, else the container.
	const c = range.startContainer;
	const start: Node | null = c.nodeType === 3 ? c.nextSibling : (c.childNodes[range.startOffset] ?? null);
	for (let n = start; n; n = n.nextSibling) if (n.nodeType === 1) return (n as Element).getBoundingClientRect();
	const before: Node | null = c.nodeType === 3 ? c.previousSibling : (c.childNodes[range.startOffset - 1] ?? null);
	for (let n = before; n; n = n.previousSibling) if (n.nodeType === 1) {
		const r = (n as Element).getBoundingClientRect();
		return new DOMRect(r.left, r.bottom, r.width, 0);
	}
	const el = c.nodeType === 1 ? (c as Element) : c.parentElement;
	return el?.getBoundingClientRect() ?? null;
}

function rectsContain(range: Range, x: number, y: number, slack = 2): boolean {
	for (const r of Array.from(range.getClientRects())) if (x >= r.left - slack && x <= r.right + slack && y >= r.top - slack && y <= r.bottom + slack) return true;
	return false;
}

/**
 * Whether a point is on a range, counting the line spacing between its lines (the rects leave it
 * out), so moving from one line of a highlight to the next stays on it.
 */
export function linesContain(range: Range, x: number, y: number, slack = 1): boolean {
	const lines: { top: number; bottom: number; left: number; right: number }[] = [];
	for (const r of Array.from(range.getClientRects())) {
		if (!r.width && !r.height) continue;
		if (x >= r.left - slack && x <= r.right + slack && y >= r.top - slack && y <= r.bottom + slack) return true;
		// Rects that overlap vertically are on the same line.
		const line = lines.find((l) => r.top < l.bottom && r.bottom > l.top);
		if (line) {
			line.top = Math.min(line.top, r.top);
			line.bottom = Math.max(line.bottom, r.bottom);
			line.left = Math.min(line.left, r.left);
			line.right = Math.max(line.right, r.right);
		} else lines.push({ top: r.top, bottom: r.bottom, left: r.left, right: r.right });
	}
	lines.sort((a, b) => a.top - b.top);
	for (let i = 1; i < lines.length; i++) {
		const a = lines[i - 1];
		const b = lines[i];
		// Only bridge line spacing, not a gap between paragraphs or a page.
		if (b.top - a.bottom > Math.min(a.bottom - a.top, b.bottom - b.top)) continue;
		if (y >= a.bottom && y <= b.top && x >= Math.min(a.left, b.left) - slack && x <= Math.max(a.right, b.right) + slack) return true;
	}
	return false;
}

/** A block's language (for sentence breaks) */
function langOf(el: Element): string | undefined {
	const l = el.closest('[lang], [xml\\:lang]');
	return l?.getAttribute('lang') ?? l?.getAttribute('xml:lang') ?? undefined;
}

const BLOCK_RE = /^(p|div|h[1-6]|li|blockquote|section|article|header|footer|pre|tr|dd|dt|figure|figcaption|aside|table|ul|ol)$/;

/** Plain text of a range, with paragraph breaks preserved and whitespace collapsed within blocks. */
export function rangeText(range: Range): string {
	const root = range.commonAncestorContainer;
	const out: string[] = [];
	let lastBlock: Element | null = null;
	const blockOf = (n: Node) => {
		let e = n.parentElement;
		while (e && !BLOCK_RE.test(e.localName) && !e.classList.contains('fpp-body')) e = e.parentElement;
		return e;
	};
	const pushText = (n: Text, s: string) => {
		const b = blockOf(n);
		if (lastBlock && b !== lastBlock) out.push('\n\n');
		lastBlock = b;
		out.push(s);
	};
	if (root.nodeType === 3) {
		pushText(root as Text, (root as Text).data.slice(range.startOffset, range.endOffset));
	} else {
		const walker = (root.ownerDocument ?? document).createTreeWalker(root, NodeFilter.SHOW_TEXT);
		for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
			if (!range.intersectsNode(n)) continue;
			if (n.parentElement?.closest('script,style')) continue;
			let s = n.data;
			if (n === range.endContainer) s = s.slice(0, range.endOffset);
			if (n === range.startContainer) s = s.slice(range.startOffset);
			pushText(n, s);
		}
	}
	return out
		.join('')
		.split('\n\n')
		.map((p) => p.replace(/\s+/g, ' ').trim())
		.filter(Boolean)
		.join('\n\n');
}

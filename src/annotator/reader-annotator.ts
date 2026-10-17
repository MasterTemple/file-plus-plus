import { Component, Menu, Platform } from 'obsidian';
import type { DocumentReader, HighlightSpec, LayerHit, SelectionInfo } from '../core';
import { AnnotationTip } from '../obsidian/annotation-tip';
import { layerId, type Annotation, type AnnotationContext, type AnnotationProvider } from '../obsidian/api';
import type { FilePlusPlusPlugin } from '../obsidian/plugin';
import { CommentCard } from './comment-card';
import type { HighlightEntry } from './highlight-index';
import { addActiveColorRow, addHighlightItems, addSelectionItems, editHighlightComment, type MenuHost } from './menus';
import type { AnnotationTarget } from './target';

/** What a `ReaderAnnotator` annotates: a reader on screen, and where its cards and tips go */
export interface ReaderAnnotatorOptions {
	/** The element comment cards and tooltips are placed in (positioned relative to it) */
	container: HTMLElement;
	/** Providers whose annotations aren't drawn here (by id) */
	hiddenProviders?: string[];
	/** The plugin's own items for a selection, after the copy items */
	extendSelectionMenu?(menu: Menu, info: SelectionInfo): void;
	/** The plugin's own items for a highlight, in its `section` */
	extendHighlightMenu?(menu: Menu, entry: HighlightEntry, section: string): void;
}

/**
 * Highlights in a document that isn't in a tab of its own (an embed, a hover preview, a plugin's
 * rows of passages): drawn from the notes that link to it and kept up to date, their comments on
 * hover (desktop) or a tap, and the same selection and highlight menus as in its tab (a right-click,
 * a click on a highlight, or a selection held a moment on a touch screen), which make, recolor,
 * comment on, and delete highlights. Annotation providers' layers are drawn too, with their
 * tooltips and menus. A child of the embed (or whatever shows the reader): unloaded with it.
 */
export class ReaderAnnotator<Doc = unknown, R extends DocumentReader = DocumentReader> extends Component implements MenuHost<Doc, R> {
	private readonly card: CommentCard;
	private readonly tip: AnnotationTip;
	private selectionTimer = 0;
	/** Over a highlight: its comment card shows, not the tooltips of annotations under it */
	private overHighlight = false;
	/** When a long press last ended (a touch held, or a touch screen's contextmenu): the click its release emits isn't a tap */
	private heldAt = 0;

	constructor(
		readonly plugin: FilePlusPlusPlugin<Doc, R>,
		readonly target: AnnotationTarget<Doc, R>,
		private readonly options: ReaderAnnotatorOptions,
	) {
		super();
		this.card = this.addChild(new CommentCard(plugin.app, options.container));
		this.tip = new AnnotationTip(options.container);
	}

	get activeColor(): string | null {
		const last = this.plugin.settings.lastColor;
		return last === undefined ? this.plugin.settings.defaultColor || null : last;
	}

	setActiveColor(color: string | null): void {
		this.plugin.settings.lastColor = color;
		void this.plugin.saveSettings();
		for (const v of this.plugin.views()) {
			v.activeColor = color;
			v.renderPalette();
		}
	}

	async editComment(entry: HighlightEntry): Promise<void> {
		const quote = this.target.reader?.highlightRange(entry.id)?.toString().replace(/\s+/g, ' ').trim() ?? '';
		await editHighlightComment(this.plugin, entry, quote);
	}

	openSource(entry: HighlightEntry): void {
		void this.plugin.annotator.openSource(entry, this.target);
	}

	extendSelectionMenu(menu: Menu, info: SelectionInfo): void {
		this.options.extendSelectionMenu?.(menu, info);
	}

	extendHighlightMenu(menu: Menu, entry: HighlightEntry, section: string): void {
		this.options.extendHighlightMenu?.(menu, entry, section);
	}

	override onload(): void {
		const reader = this.target.reader;
		if (!reader) return;
		this.plugin.readerAnnotators.add(this);
		this.register(() => this.plugin.readerAnnotators.delete(this));
		this.registerEvent(
			this.plugin.annotator.index.on('changed', (paths) => {
				if (this.target.file && paths.has(this.target.file.path)) this.refreshHighlights();
			}),
		);
		this.refreshHighlights();
		for (const p of this.plugin.providers.values()) void this.updateProvider(p);
		this.bind(reader);
		this.register(() => {
			window.clearTimeout(this.selectionTimer);
			this.tip.destroy();
		});
	}

	/** Draws the highlights again, from the notes that link to the document */
	refreshHighlights(): void {
		const { reader, file } = this.target;
		if (!reader || !file) return;
		const all = this.plugin.annotator.index.get(file.path);
		const entries = this.plugin.settings.noColor === 'none' ? all.filter((e) => e.color) : all;
		reader.setHighlights(entries.map((e) => ({ id: e.id, locator: e.locator, color: e.color, data: e })));
		reader.setHighlightsHidden(this.plugin.settings.hideHighlights);
	}

	/** Draws a provider's annotations of the document (unless the user hid them) */
	async updateProvider(provider: AnnotationProvider<unknown>): Promise<void> {
		const { reader, file } = this.target;
		if (!reader || !file || this.options.hiddenProviders?.includes(provider.id)) return;
		let list: Annotation[];
		try {
			list = await provider.annotations(file);
		} catch (e) {
			console.error(`[fpp] annotation provider ${provider.id} failed`, e);
			list = [];
		}
		if (this.target.reader !== reader || this.plugin.providers.get(provider.id) !== provider) return;
		const specs: HighlightSpec<Annotation>[] = list.map((a) => ({ id: a.id, locator: a.locator, color: a.color ?? provider.color, data: a }));
		reader.setLayer(layerId(provider.id), specs, { style: provider.style, hidden: this.plugin.settings.hiddenProviders.includes(provider.id) });
	}

	removeProvider(id: string): void {
		this.target.reader?.removeLayer(layerId(id));
	}

	private bind(reader: R): void {
		const off = [
			reader.on('highlight-hover', (e, specs) => {
				// Touch screens emit a mouse move for every tap: hover is desktop-only
				if (Platform.isMobile) return;
				this.overHighlight = specs.length > 0;
				if (this.overHighlight) this.tip.hide();
				this.card.hover(e, specs.map((s) => s.data as HighlightEntry));
			}),
			reader.on('highlight-click', (e, specs) => this.held() || this.showHighlightMenu(specs.map((s) => s.data as HighlightEntry), { x: e.clientX, y: e.clientY })),
			reader.on('annotation-hover', (e, hits) => {
				if (Platform.isMobile) return;
				const key = this.overHighlight ? '' : hits.map((h) => `${h.layer}:${h.spec.id}`).join('|');
				this.tip.hover(e, key, () =>
					this.groupHits(hits)
						.flatMap((g) => g.annotations.map((a) => (g.provider.tooltip ? g.provider.tooltip(a, this.context(g.layer, a)) : a.label)))
						.filter((t): t is string => !!t)
						.join('\n'),
				);
			}),
			reader.on('annotation-click', (e, hits) => {
				if (this.held()) return;
				const group = this.groupHits(hits)[0];
				if (!group) return;
				if (group.provider.onClick?.(group.annotations, e, this.context(group.layer, group.annotations[0]))) return;
				this.showMenu(null, [], hits, { x: e.clientX, y: e.clientY });
			}),
			reader.on('contextmenu', (e, { selection, highlights, annotations }) => {
				// A long press on a touch screen: the OS selects the words, unless it's on a highlight or an
				// annotation whose provider wants the hold (a tap opens the others' menus)
				if (Platform.isMobile) this.heldAt = Date.now();
				if (Platform.isMobile && !highlights.length) {
					annotations = annotations.filter((h) => !this.plugin.providers.get(h.layer.replace(/^provider:/, ''))?.holdSelects);
					if (!annotations.length) {
						// Words selected: the selection menu, not the OS toolbar (as in the tab)
						const sel = selection ?? reader.getSelection();
						if (!sel || !this.plugin.settings.selectionBar) return;
						e.preventDefault();
						window.clearTimeout(this.selectionTimer);
						const r = sel.range.getBoundingClientRect();
						return this.showMenu(sel, [], [], { x: r.left + r.width / 2, y: r.bottom + 8 });
					}
				}
				if (!selection && !highlights.length && !annotations.length) return;
				e.preventDefault();
				this.showMenu(selection, highlights.map((h) => h.data as HighlightEntry), annotations, { x: e.clientX, y: e.clientY });
			}),
			// On a touch screen, the menu once a selection stays put a moment (a right-click on a desktop)
			reader.on('selectionchange', (selection) => {
				window.clearTimeout(this.selectionTimer);
				if (!selection || !Platform.isMobile || !this.plugin.settings.selectionBar) return;
				this.selectionTimer = window.setTimeout(() => {
					const now = reader.getSelection();
					if (!now) return;
					const r = now.range.getBoundingClientRect();
					this.showMenu(now, [], [], { x: r.left + r.width / 2, y: r.bottom + 8 });
				}, 600);
			}),
		];
		this.register(() => off.forEach((f) => f()));
		// A touch held a while is a long press, whether or not the browser fired contextmenu for it
		let touchedAt = 0;
		this.registerDomEvent(reader.scroller, 'touchstart', () => (touchedAt = Date.now()), { passive: true, capture: true });
		this.registerDomEvent(reader.scroller, 'touchend', () => {
			if (Date.now() - touchedAt > 450) this.heldAt = Date.now();
		}, { passive: true, capture: true });
	}

	/** Whether a click is the release of a long press on a touch screen */
	private held(): boolean {
		return Platform.isMobile && Date.now() - this.heldAt < 1000;
	}

	/** The highlights' menu, with their comments (a tap on a touch screen has no hover) */
	private showHighlightMenu(entries: HighlightEntry[], at: { x: number; y: number }): void {
		if (!entries.length) return;
		if (Platform.isMobile) void this.card.show(entries, at);
		const menu = new Menu();
		addHighlightItems(this, menu, entries);
		menu.onHide(() => this.card.hide());
		menu.showAtPosition(at);
	}

	/** The selection's items (copy, highlight in a color, the annotation file), the highlights', and the providers' */
	private showMenu(selection: SelectionInfo | null, highlights: HighlightEntry[], annotations: LayerHit[], at: { x: number; y: number }): void {
		const reader = this.target.reader;
		this.tip.hide();
		const menu = new Menu();
		if (selection) {
			// The selected words stay painted while the menu is open (the OS toolbar goes with the native selection)
			reader?.setPendingSelection(selection.range);
			selection.range.startContainer.ownerDocument?.getSelection()?.removeAllRanges();
			addSelectionItems(this, menu, selection);
		}
		if (highlights.length) addHighlightItems(this, menu, highlights);
		for (const g of this.groupHits(annotations)) {
			for (const a of g.annotations) {
				const section = `fpp-ann-${g.provider.id}-${a.id}`;
				addActiveColorRow(this, menu, section);
				menu.addItem((i) =>
					i
						.setTitle('Save as highlight')
						.setIcon('highlighter')
						.setSection(section)
						.onClick(() => this.plugin.annotator.saveAnnotation(this.target, g.layer, a, this.activeColor, false)),
				);
			}
			try {
				g.provider.menu?.(menu, g.annotations, this.context(g.layer, g.annotations[0]));
			} catch (e) {
				console.error(`[fpp] annotation provider ${g.provider.id} menu failed`, e);
			}
		}
		menu.onHide(() => window.setTimeout(() => reader?.setPendingSelection(null), 50));
		menu.showAtPosition(at);
	}

	private groupHits(hits: LayerHit[]): { provider: AnnotationProvider<unknown>; layer: string; annotations: Annotation[] }[] {
		const groups = new Map<string, { provider: AnnotationProvider<unknown>; layer: string; annotations: Annotation[] }>();
		for (const h of hits) {
			const provider = this.plugin.providers.get(h.layer.replace(/^provider:/, ''));
			if (!provider) continue;
			let g = groups.get(h.layer);
			if (!g) groups.set(h.layer, (g = { provider, layer: h.layer, annotations: [] }));
			g.annotations.push(h.spec.data as Annotation);
		}
		return [...groups.values()];
	}

	private context(layer: string, a: Annotation): AnnotationContext {
		const range = this.target.reader?.layerRange(layer, a.id) ?? null;
		return {
			file: this.target.file!,
			text: range?.toString().replace(/\s+/g, ' ').trim() ?? '',
			chapter: (range && this.target.reader?.tocItemAt(range)?.label) || null,
		};
	}
}

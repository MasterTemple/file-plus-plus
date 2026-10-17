import { type DocumentReader, type HighlightSpec, type LayerHit, type SelectionInfo, type TocItem } from '../core';
import { FileView, Menu, Notice, Platform, Scope, TFile, setIcon, type HoverParent, type ViewStateResult, type WorkspaceLeaf } from 'obsidian';
import type { HighlightEntry } from '../annotator/highlight-index';
import type { HighlightGestureAction, LinkPlace } from './settings';
import type { CopyTarget, FilePlusPlusPlugin } from './plugin';
import { AppearancePanel } from './appearance';
import { Sidebar } from './sidebar';
import { CommentCard } from '../annotator/comment-card';
import { ViewAnnotator } from '../annotator/view-annotator';
import { AnnotationTip } from './annotation-tip';
import { MarginComments, type ProviderNotes } from '../annotator/margin-comments';
import { layerId, type Annotation, type AnnotationContext, type AnnotationProvider } from './api';
import { hoverLink } from './hover';
import { JumpList, type Place } from './jump-list';
import { pickHint } from './sentence-hints';
import { addActiveColorRow, addColorRow, addSelectionItems, colorCss, colorTitle, type MenuHost } from '../annotator/menus';

/** Annotations under the pointer, grouped by their provider. */
interface AnnotationGroup {
	provider: AnnotationProvider<unknown>;
	layer: string;
	annotations: Annotation[];
}

/** The plugin of the view being constructed. */
let constructing: FilePlusPlusPlugin<any, any> | null = null;

/**
 * The view of a document: toolbar, sidebar (contents, search, highlights, providers' annotations),
 * the reader, menus and touch gestures. Plugins may subclass it (see `FilePlusPlusPlugin.createView`)
 * to add UI around the reader, e.g. a media player.
 */
export class DocumentView<Doc = unknown, R extends DocumentReader = DocumentReader> extends FileView {
	/** The loaded document (the format's object), or null. */
	document: Doc | null = null;
	reader: R | null = null;
	activeColor: string | null;
	protected hostEl!: HTMLElement;
	protected mainEl!: HTMLElement;
	protected toolbarEl!: HTMLElement;
	private chapterEl!: HTMLElement;
	private progressEl!: HTMLElement;
	private paletteEl!: HTMLElement;
	/** @internal (the annotator) */
	sidebar!: Sidebar;
	private searchNavEl!: HTMLElement;
	commentCard!: CommentCard;
	/** Comments beside the text (see settings: `marginComments`). */
	marginComments!: MarginComments;
	/** Providers' annotations that have notes (shown in the margin), by layer. */
	/** @internal (the annotator) */
	providerNotes = new Map<string, ProviderNotes>();
	private appearance!: AppearancePanel;
	/** Vim's jump list (reader keys' Ctrl+O / Ctrl+I), across the documents this view shows. */
	readonly jumps = new JumpList();
	/** Where the view was before its last jump (reader keys' `''`). */
	lastJump: Place | null = null;
	/** Going through the jump list: leaving a document then isn't a jump. */
	private travelling = false;
	/** The pending subpath is a link's (a jump), not a position restored from history. */
	private pendingJump = false;
	private pendingSubpath: string | null = null;
	/** Whether the pending jump flashes its passage (a link does; a position restored from history doesn't). */
	private pendingFlash = true;
	/** A link to a passage opened this tab before its document showed: `openedByLink` again once it does. */
	private linkPending = false;
	/** Comments in the margin hidden in this tab by a link (`linkOpening`), until shown again here or everywhere. */
	commentsHidden = false;
	private loadToken = 0;
	private offIndex: (() => void) | null = null;
	private annotationTip!: AnnotationTip;

	/** Highlights from notes, comments, the highlight menu (the annotator's part of the view). */
	readonly annotations = new ViewAnnotator<Doc, R>(this);

	constructor(
		leaf: WorkspaceLeaf,
		readonly plugin: FilePlusPlusPlugin<Doc, R>,
	) {
		// Obsidian's constructor asks for the view type, before `plugin` is assigned.
		super((constructing = plugin, leaf));
		constructing = null;
		const last = plugin.settings.lastColor;
		this.activeColor = last === undefined ? plugin.settings.defaultColor || null : last;
		this.scope = new Scope(this.app.scope);
		this.scope.register(['Mod'], 'f', () => {
			this.openSearch();
			return false;
		});
		// Build the UI immediately: Obsidian may call onLoadFile() before onOpen().
		this.buildUi();
	}

	getViewType(): string {
		return (this.plugin ?? constructing!).viewType;
	}

	override getDisplayText(): string {
		return this.file?.basename ?? this.plugin.format.name;
	}

	override getIcon(): string {
		return this.plugin.format.icon;
	}

	override canAcceptExtension(extension: string): boolean {
		return this.plugin.format.extensions.includes(extension.toLowerCase());
	}

	/**
	 * Called once the toolbar, sidebar and reader host exist (on the first `onOpen` or `onLoadFile`,
	 * not in the constructor, so a subclass's fields are initialized): add UI around them.
	 */
	protected buildExtraUi(): void {}

	private extraUiBuilt = false;

	private ensureExtraUi(): void {
		if (this.extraUiBuilt) return;
		this.extraUiBuilt = true;
		this.buildExtraUi();
	}

	/**
	 * True while `reload()` re-renders the same file (in `onTeardown` and `onReaderReady`), so
	 * subclasses can keep their UI, e.g. a playing media player.
	 */
	protected reloading = false;

	/** Re-render the view's file (it changed), at the position it was read at. */
	async reload(): Promise<void> {
		if (!this.file || !this.reader) return;
		this.reloading = true;
		try {
			await this.onLoadFile(this.file);
		} finally {
			this.reloading = false;
		}
	}

	/** Called after a document is rendered (and on every reload of the view's file). */
	protected onReaderReady(_reader: R): void {}

	/** Called before the reader and document are destroyed. */
	protected onTeardown(): void {}

	private buildUi(): void {
		const root = this.contentEl;
		root.empty();
		root.addClass('fpp-view');
		root.toggleClass('fpp-mobile', Platform.isMobile);
		root.toggleClass('fpp-phone', Platform.isPhone);

		const toolbar = (this.toolbarEl = root.createDiv('fpp-toolbar'));
		this.toolbarButton(toolbar, 'list', 'Contents & search', () => this.toggleSidebar());
		const center = toolbar.createDiv('fpp-toolbar-center');
		this.chapterEl = center.createDiv('fpp-toolbar-title');
		this.progressEl = center.createDiv('fpp-toolbar-progress');
		this.paletteEl = toolbar.createDiv('fpp-palette');
		this.renderPalette();
		this.toolbarButton(toolbar, 'search', 'Search', () => this.openSearch());
		this.toolbarButton(toolbar, 'type', 'Appearance', () => this.toggleAppearance());

		this.mainEl = root.createDiv('fpp-main');
		this.sidebar = new Sidebar(this, this.mainEl.createDiv('fpp-sidebar'));
		this.mainEl.createDiv('fpp-sidebar-backdrop').addEventListener('click', () => this.toggleSidebar(false));
		this.hostEl = this.mainEl.createDiv('fpp-reader-host');
		this.searchNavEl = this.mainEl.createDiv('fpp-search-float');
		const navButton = (icon: string, label: string, delta: number) => {
			const b = this.searchNavEl.createDiv({ cls: 'clickable-icon', attr: { 'aria-label': label } });
			setIcon(b, icon);
			b.addEventListener('click', () => this.sidebar.step(delta));
		};
		navButton('chevron-up', 'Previous result', -1);
		navButton('chevron-down', 'Next result', 1);
		this.appearance = new AppearancePanel(this.plugin, this.mainEl.createDiv('fpp-appearance'), () => this.file?.path);
		this.commentCard = this.addChild(new CommentCard(this.app, this.mainEl));
		this.marginComments = this.addChild(new MarginComments(this));
		this.annotationTip = new AnnotationTip(this.mainEl);
		this.register(() => this.annotationTip.destroy());
		// As the sidebar was last opened or closed (on this kind of device)
		this.toggleSidebar(this.plugin.sidebarState().open, false);

		this.offIndex = (() => {
			const ref = this.plugin.annotator.index.on('changed', (paths) => {
				if (this.file && paths.has(this.file.path)) this.refreshHighlights();
			});
			return () => this.plugin.annotator.index.offref(ref);
		})();
		this.registerEvent(this.app.workspace.on('css-change', () => this.reader?.updateSettings({})));
		// Dragging the tab into another window moves our DOM into a different document: rebuild the
		// reader there (highlights and ranges are per-window). Same-window moves are handled by core.
		this.register(
			this.contentEl.onWindowMigrated(() => {
				if (this.file && this.reader) this.onLoadFile(this.file);
			}),
		);
		this.guardTouchGestures();
		// Ctrl/Cmd+C (and the system Copy command) inside the document uses the configured copy action.
		this.registerDomEvent(this.contentEl, 'copy', (e: ClipboardEvent) => this.onCopy(e));
	}

	override async onOpen(): Promise<void> {
		this.ensureExtraUi();
	}

	/** Floating previous/next buttons over the document while there are search results. */
	setSearchNavVisible(visible: boolean): void {
		this.searchNavEl?.toggleClass('is-visible', visible); // the sidebar is built before the nav buttons
	}

	override async onClose(): Promise<void> {
		this.contentEl.doc.body.removeClass('fpp-drawer-open');
		this.appearance?.toggle(false);
		this.offIndex?.();
		this.teardown();
	}

	protected toolbarButton(parent: HTMLElement, icon: string, label: string, onClick: () => void): HTMLElement {
		const b = parent.createDiv({ cls: 'clickable-icon fpp-toolbar-button', attr: { 'aria-label': label } });
		setIcon(b, icon);
		b.addEventListener('click', onClick);
		return b;
	}

	// --------------------------------------------------------------------------------------------
	// Loading
	// --------------------------------------------------------------------------------------------

	override async onLoadFile(file: TFile): Promise<void> {
		this.ensureExtraUi();
		const token = ++this.loadToken;
		this.teardown();
		this.chapterEl.setText('Loading…');
		try {
			const { format } = this.plugin;
			const doc = await format.load(this.app, file);
			if (token !== this.loadToken) return format.unload(doc);
			const s = this.plugin.settings;
			const reader = format.createReader(this.hostEl, doc, {
				settings: this.plugin.readerSettings(file.path),
				palette: this.plugin.paletteRecord(),
				defaultColor: s.defaultColor,
				highlightOpacity: s.highlightOpacity,
				flash: { color: s.jumpHighlightColor, duration: s.jumpHighlightDuration },
				// A link inside the document is a jump
				onInternalLink: () => {
					this.recordJump();
					return false;
				},
			});
			this.document = doc;
			this.reader = reader;
			await reader.render();
			if (token !== this.loadToken) return;
			this.bindReader(reader);
			// Over the text, the sidebar opens as it was last left on phones, and closed in narrow panes on desktop
			if (this.sidebarIsOverlay() && !this.reloading) this.toggleSidebar(Platform.isMobile && this.plugin.sidebarState().open, false);
			if (this.linkPending) {
				this.linkPending = false;
				this.openedByLink();
			}
			this.chapterEl.setText(this.title());
			this.sidebar.setToc(reader.toc);
			this.refreshHighlights();
			for (const p of this.plugin.providers.values()) void this.updateProvider(p);
			this.onReaderReady(reader);
			const pending = this.pendingSubpath;
			const saved = s.positions[file.path];
			const target = pending ?? saved;
			this.pendingSubpath = null;
			// The jump list starts where the document opens; opened by a link, where it would have opened by itself
			const start = pending && this.pendingJump ? saved : target;
			this.recordJump(start ? { path: file.path, locator: start } : undefined);
			if (target) this.navigate(target, !!pending && this.pendingFlash && target !== saved, false);
		} catch (e) {
			console.error('[fpp] failed to open', file.path, e);
			const name = this.plugin.format.name;
			this.chapterEl.setText(`Failed to open ${name}`);
			const error = this.hostEl.createDiv({ cls: 'fpp-error', text: `Could not open this ${name}: ${(e as Error).message}` });
			if (this.plugin.format.plainText) {
				const buttons = error.createDiv('fpp-error-buttons');
				buttons.createEl('button', { text: 'Read as plain text' }).addEventListener('click', () => void this.plugin.toggleSource(this.leaf, 'read'));
				buttons.createEl('button', { text: 'Edit as plain text' }).addEventListener('click', () => void this.plugin.toggleSource(this.leaf, 'edit'));
			}
		}
	}

	override async onUnloadFile(_file: TFile): Promise<void> {
		// Another document in this tab: a jump (unless going through the jump list)
		if (this.reader?.isRendered) this.recordJump();
		this.loadToken++;
		this.teardown();
	}

	override async onRename(file: TFile): Promise<void> {
		await super.onRename(file);
		this.refreshHighlights();
		for (const p of this.plugin.providers.values()) void this.updateProvider(p);
	}

	/** The document's title (or the file name). */
	title(): string {
		const doc = this.document;
		return (doc && this.file && this.plugin.format.info(doc, this.file).title) || this.file?.basename || '';
	}

	private teardown(): void {
		if (this.reader) this.onTeardown();
		this.marginComments?.reset();
		this.reader?.destroy();
		if (this.document) this.plugin.format.unload(this.document);
		this.reader = null;
		this.document = null;
		this.sidebar?.setToc(null);
		this.hostEl?.empty();
	}

	// --------------------------------------------------------------------------------------------
	// Navigation / state
	// --------------------------------------------------------------------------------------------

	/**
	 * The reading position goes into Obsidian's navigation history (and the workspace), so back /
	 * forward return to the place you were at, not the top.
	 */
	override getEphemeralState(): Record<string, unknown> {
		const state = super.getEphemeralState();
		const position = this.reader?.isRendered ? this.reader.getLocation()?.locator : null;
		return position ? { ...state, position } : state;
	}

	override setEphemeralState(state: unknown): void {
		const s = state as { subpath?: string; position?: unknown; link?: boolean } | null;
		if (s?.link && s.subpath) {
			this.openedByLink();
			this.linkPending = !this.reader?.isRendered;
		}
		// A link's subpath wins; otherwise a position from history is restored without a flash.
		const target = s?.subpath || (typeof s?.position === 'string' ? s.position : null);
		if (target) {
			if (this.reader?.isRendered) this.navigate(target, !!s?.subpath, !!s?.subpath);
			else {
				this.pendingSubpath = target;
				this.pendingFlash = !!s?.subpath;
				this.pendingJump = !!s?.subpath;
			}
		}
		super.setEphemeralState(state);
	}

	/**
	 * Jump to a subpath (`#<locator>&color=..`); range locators flash (per settings, in `flashColor`
	 * if given) unless `flash` is false. With `record`, where the view was goes on its jump list.
	 */
	navigate(subpath: string, flash = true, record = true, flashColor?: string): boolean {
		if (!this.reader) {
			this.pendingSubpath = subpath;
			this.pendingFlash = flash;
			this.pendingJump = record;
			return false;
		}
		const loc = this.reader.parse(subpath);
		if (!loc.locator) return false;
		if (record) this.recordJump();
		const jump = this.plugin.jumpFlash();
		const ok = this.reader.goTo(loc.locator, { flash: flash && this.reader.isRangeLocator(loc.locator) && jump && { ...jump, color: flashColor ?? jump.color } });
		if (!ok) console.warn('[fpp] could not resolve', subpath);
		else this.onNavigate(loc.locator);
		return ok;
	}

	/** After a jump to a locator (e.g. a media player seeks to it). */
	protected onNavigate(_locator: string): void {}

	/**
	 * The file that was opened to show this document, when the plugin took it over (see
	 * `FilePlusPlusPlugin.documentFor`; e.g. the video of a transcript), or chosen with `setSource`. Kept in the view state.
	 */
	source: TFile | null = null;

	override getState(): Record<string, unknown> {
		const state = super.getState();
		return this.source ? { ...state, source: this.source.path } : state;
	}

	override async setState(state: unknown, result: ViewStateResult): Promise<void> {
		const s = state as { file?: unknown; source?: unknown } | null;
		const path = typeof s?.source === 'string' ? s.source : null;
		const source = path ? this.app.vault.getFileByPath(path) : null;
		// A new file is loaded with its source; the same file only changes source when one is given.
		const sameFile = typeof s?.file === 'string' && s.file === this.file?.path;
		const changed = source !== this.source && (!sameFile || source !== null);
		if (changed) this.source = source;
		await super.setState(state, result);
		if (changed && sameFile && this.reader) this.onSourceChange();
	}

	/** Change `source` (null: none) and save it with the layout. */
	setSource(file: TFile | null): void {
		if (file === this.source) return;
		this.source = file;
		this.app.workspace.requestSaveLayout();
		if (this.reader) this.onSourceChange();
	}

	/** `source` changed while the document stayed open (on a new document, `onReaderReady` sees the new one). */
	protected onSourceChange(): void {}

	/** Where the view is: its document and the reading position. */
	here(): Place | null {
		const locator = this.reader?.isRendered ? this.reader.getLocation()?.locator : null;
		return this.file && locator ? { path: this.file.path, locator } : null;
	}

	/** About to jump from `place` (where the view is): Ctrl+O and `''` come back to it. */
	recordJump(place: Place | null = this.here()): void {
		if (!place || this.travelling) return;
		this.lastJump = place;
		this.jumps.jumpedFrom(place);
	}

	/** Show a place, in this document or (opening it here) another, without recording a jump. */
	async showPlace(place: Place): Promise<void> {
		if (place.path === this.file?.path) return void this.navigate(place.locator, false, false);
		const file = this.app.vault.getAbstractFileByPath(place.path);
		if (!(file instanceof TFile)) return void this.plugin.notice(`${place.path} is gone.`);
		this.travelling = true;
		try {
			await this.leaf.openFile(file, { eState: { position: place.locator } });
		} finally {
			this.travelling = false;
		}
	}

	goToToc(item: TocItem): void {
		this.recordJump();
		this.reader?.goTo(item);
		if (this.sidebarIsOverlay()) this.toggleSidebar(false, false);
	}

	/** True when the sidebar floats over the text (mobile, or a narrow pane). */
	sidebarIsOverlay(): boolean {
		const sb = this.mainEl.querySelector('.fpp-sidebar');
		return !!sb && getComputedStyle(sb).position === 'absolute';
	}

	private bindReader(reader: R): void {
		reader.on('relocated', (loc) => {
			if (!this.file) return;
			this.plugin.savePosition(this.file.path, loc.locator);
			this.progressEl.setText(`${Math.round(loc.progress * 100)}%`);
			this.chapterEl.setText(loc.tocItem?.label ?? this.title());
			this.sidebar.setCurrent(loc.tocItem);
		});
		reader.scroller.addEventListener('scroll', () => this.marginComments.scrolled(), { passive: true });
		reader.scroller.addEventListener('mousedown', () => {
			if (this.sidebarTransient) this.backToText();
		});
		reader.on('external-link', (_e, url) => window.open(url, '_blank'));
		reader.on('highlight-click', (e, specs) => {
			const entries = specs.map((s) => s.data as HighlightEntry);
			const commented = entries.find((x) => x.comment);
			if (commented) this.marginComments.activateHighlight(commented);
			if (Platform.isMobile) {
				// Wait a moment: this tap may be the first half of a double tap, or the end of a hold.
				const tappedAt = Date.now();
				if (tappedAt - this.lastHold < 1000) return;
				window.setTimeout(() => {
					if (this.lastDoubleTap >= tappedAt) return;
					this.runHighlightGesture(this.plugin.settings.highlightTap, entries, { x: e.clientX, y: e.clientY });
				}, 320);
			} else if (entries.length > 1) {
				const menu = new Menu();
				this.addHighlightItems(menu, entries);
				menu.showAtMouseEvent(e);
			} else this.plugin.annotator.openSource(entries[0], this);
		});
		reader.on('highlight-hover', (e, specs) => {
			// Touch screens emit a mouse move for every tap; hover cards/previews are desktop-only.
			if (Platform.isMobile) return;
			const entries = specs.map((s) => s.data as HighlightEntry);
			// Comments in the margin are already visible: point at them instead of a hover card.
			this.marginComments.hoverHighlights(entries);
			if (this.marginComments.visible) this.commentCard.hide();
			else this.commentCard.hover(e, entries);
			if (!specs.length) return;
			const entry = specs[0].data as HighlightEntry;
			this.app.workspace.trigger('hover-link', {
				event: e,
				source: this.plugin.hoverSource,
				hoverParent: this,
				targetEl: this.hostEl,
				linktext: entry.sourcePath,
				sourcePath: this.file?.path ?? '',
				state: { scroll: entry.position.start.line },
			});
		});
		reader.on('annotation-click', (e, hits) => this.onAnnotationClick(e, hits));
		reader.on('annotation-hover', (e, hits) => {
			if (Platform.isMobile) return;
			const key = hits.map((h) => `${h.layer}:${h.spec.id}`).join('|');
			// A provider's preview (Obsidian's page preview) instead of the tooltip
			const preview = this.annotationPreview(hits);
			if (preview) {
				this.annotationTip.hide();
				if (key === this.lastPreview) return;
				this.lastPreview = key;
				const keyAt = (x: number, y: number) => (this.reader?.layerHitsAt(x, y) ?? []).map((h) => `${h.layer}:${h.spec.id}`).join('|');
				hoverLink(this.app, {
					event: e,
					source: this.plugin.annotationHoverSource,
					hoverParent: this as unknown as HoverParent,
					targetEl: this.hostEl,
					linktext: preview,
					sourcePath: this.file?.path ?? '',
					over: (x, y) => keyAt(x, y) === key,
				});
				return;
			}
			this.lastPreview = key;
			this.annotationTip.hover(e, key, () =>
				this.groupHits(hits)
					.flatMap((g) => g.annotations.map((a) => (g.provider.tooltip ? g.provider.tooltip(a, this.annotationContext(g.layer, a)) : a.label)))
					.filter((t): t is string => !!t)
					.join('\n'),
			);
		});
		reader.on('contextmenu', (e, { selection, highlights, annotations }) => {
			if (Platform.isMobile) {
				// Touch browsers fire contextmenu on long-press and when tapping a selection; that's what opens
				// the OS selection toolbar. After "System menu", leave it alone so the OS menu can open.
				if (this.nativeSelectionMode) return;
				// A long press the view handled (`onTextHold`): no OS menu or selection menu
				if (Date.now() - this.lastHold < 1000) {
					e.preventDefault();
					return;
				}
				if (highlights.length || this.heldAnnotations(annotations).length) {
					// Long-press on a highlight (Android fires contextmenu; the hold timer may have run already).
					e.preventDefault();
					if (Date.now() - this.lastHold > 1000) this.onHold(e.clientX, e.clientY);
					return;
				}
				const sel = selection ?? (this.reader?.getSelection() || null);
				if (sel && this.plugin.settings.selectionBar) {
					e.preventDefault();
					window.clearTimeout(this.selectionMenuTimer);
					if (sel.locator !== this.lastMenuLocator || !this.pendingSelection) {
						this.lastMenuLocator = sel.locator;
						this.showSelectionMenu(sel);
					}
					return;
				}
				if (!highlights.length) return; // plain long-press on text: let the OS select it
			}
			const info = selection ?? this.paragraphAt(e);
			if (!info && !highlights.length && !annotations.length) return;
			e.preventDefault();
			this.annotationTip.hide();
			const menu = new Menu();
			if (info) this.addSelectionItems(menu, info, !selection, !selection && highlights.length > 0);
			if (highlights.length) this.addHighlightItems(menu, highlights.map((h) => h.data as HighlightEntry));
			if (annotations.length) this.addAnnotationItems(menu, annotations);
			menu.showAtMouseEvent(e);
		});
		reader.on('selectionchange', (sel) => this.scheduleSelectionMenu(sel));
	}

	/** Paragraph under the pointer, so right-click works without an explicit selection. */
	private paragraphAt(e: MouseEvent): SelectionInfo | null {
		const el = (e.composedPath()[0] as Element | undefined) ?? null;
		const block = el?.closest?.('p, li, blockquote, h1, h2, h3, h4, h5, h6, dd, dt, figcaption, td, pre');
		if (!block || !this.reader?.content.contains(block)) return null;
		const range = document.createRange();
		range.selectNodeContents(block);
		return this.reader.describeRange(range);
	}

	// --------------------------------------------------------------------------------------------
	// Highlights
	// --------------------------------------------------------------------------------------------



	refreshHighlights(): void {
		this.annotations.refreshHighlights();
	}

	/** Labels the footnote links in view; the one picked shows its note */
	pickFootnote(): void {
		const reader = this.reader;
		if (!reader) return;
		const spots = reader.visibleNoteLinks();
		if (spots.length === 1) return void reader.showNoteOf(spots[0].range);
		if (!spots.length || !pickHint(this as unknown as DocumentView, spots, this.plugin.settings.hintKeys, () => '#d4d4d4', (range) => reader.showNoteOf(range)))
			this.plugin.notice(spots.length ? 'no keys to label footnotes with (Settings → keys).' : 'no footnotes in view.');
	}

	/** Copies the selected text (`y`) */
	yankSelection(): void {
		void this.plugin.annotator.yankSelection(this);
	}

	/** A reader key for a highlight selected in this view (`select-highlight`); true: it was used */
	onReaderKey(chord: string): boolean {
		return this.annotations.handleKey(chord);
	}

	/** Whether this tab shows comments in the margin (when there's room): the setting, unless a link hid them here. */
	showsComments(): boolean {
		return this.plugin.settings.marginComments && !this.commentsHidden;
	}

	/** Shows comments in the margin (here, and everywhere if they're off), or hides them everywhere. */
	async setCommentsShown(on: boolean): Promise<void> {
		if (on && this.plugin.settings.marginComments) {
			this.commentsHidden = false;
			this.refreshHighlights();
		} else await this.plugin.annotator.setMarginComments(on);
	}

	/** Where this tab is, for `linkOpening`: on a phone or tablet, or a desktop pane taking (more than) about half the panes' width. */
	linkPlace(): LinkPlace {
		if (Platform.isMobile) return 'mobile';
		const panes = (this.app.workspace as unknown as { rootSplit?: { containerEl?: HTMLElement } }).rootSplit?.containerEl;
		const width = this.containerEl.offsetWidth;
		const all = panes?.offsetWidth || this.containerEl.win.innerWidth;
		return width > 0 && width <= all * 0.6 ? 'half' : 'desktop';
	}

	/** A link to a passage opened this tab or went to it: close the sidebar and hide comments, as `linkOpening` says for where it is. */
	openedByLink(): void {
		const o = this.plugin.settings.linkOpening[this.linkPlace()];
		if (o.closeSidebar) this.toggleSidebar(false, false);
		if (o.hideComments && !this.commentsHidden) {
			this.commentsHidden = true;
			if (this.reader?.isRendered) this.refreshHighlights();
		}
	}

	/** Show (or hide) comments in the margin, per settings; when there is no room they show on hover. */
	refreshMargin(): void {
		this.annotations.refreshMargin();
	}

	/** Mobile gestures on highlights (see settings). Several overlapping highlights open the menu. */
	runHighlightGesture(action: HighlightGestureAction, entries: HighlightEntry[], at: { x: number; y: number }): void {
		this.annotations.runHighlightGesture(action, entries, at);
	}

	async editComment(entry: HighlightEntry): Promise<void> {
		await this.annotations.editComment(entry);
	}

	addHighlightItems(menu: Menu, entries: HighlightEntry[]): void {
		this.annotations.addHighlightItems(menu, entries);
	}

	// --------------------------------------------------------------------------------------------
	// Annotations from other plugins (see api.ts)
	// --------------------------------------------------------------------------------------------

	/** Fetch a provider's annotations for this document and show them (drawn unless the user hid them). */
	async updateProvider(provider: AnnotationProvider<unknown>): Promise<void> {
		const reader = this.reader;
		const file = this.file;
		if (!reader?.isRendered || !file) return;
		let list: Annotation[];
		try {
			list = await provider.annotations(file);
		} catch (e) {
			console.error(`[fpp] annotation provider ${provider.id} failed`, e);
			list = [];
		}
		if (this.reader !== reader || this.file !== file || this.plugin.providers.get(provider.id) !== provider) return;
		const specs: HighlightSpec<Annotation>[] = list.map((a) => ({ id: a.id, locator: a.locator, color: a.color ?? provider.color, data: a }));
		const hidden = this.plugin.settings.hiddenProviders.includes(provider.id);
		reader.setLayer(layerId(provider.id), specs, { style: provider.style, hidden });
		this.sidebar.setProvider(provider, hidden);
		const withNotes = hidden ? [] : list.filter((a) => a.note);
		const had = this.providerNotes.delete(layerId(provider.id));
		if (withNotes.length) this.providerNotes.set(layerId(provider.id), { provider, layer: layerId(provider.id), annotations: withNotes });
		if (had || withNotes.length) this.refreshMargin();
	}

	removeProvider(id: string): void {
		this.reader?.removeLayer(layerId(id));
		this.sidebar.removeProvider(id);
		if (this.providerNotes.delete(layerId(id))) this.refreshMargin();
	}

	private groupHits(hits: LayerHit[]): AnnotationGroup[] {
		const groups = new Map<string, AnnotationGroup>();
		for (const h of hits) {
			const provider = this.plugin.providers.get(h.layer.replace(/^provider:/, ''));
			if (!provider) continue;
			let g = groups.get(h.layer);
			if (!g) groups.set(h.layer, (g = { provider, layer: h.layer, annotations: [] }));
			g.annotations.push(h.spec.data as Annotation);
		}
		return [...groups.values()];
	}

	annotationContext(layer: string, a: Annotation): AnnotationContext {
		const range = this.reader?.layerRange(layer, a.id) ?? null;
		return {
			file: this.file!,
			text: range?.toString().replace(/\s+/g, ' ').trim() ?? '',
			chapter: (range && this.reader?.tocItemAt(range)?.label) || null,
		};
	}

	/** The annotations last previewed (so moving within them doesn't preview again) */
	private lastPreview = '';

	/** The first link a provider previews for these annotations, if any. */
	private annotationPreview(hits: LayerHit[]): string | null {
		for (const g of this.groupHits(hits)) {
			if (!g.provider.preview) continue;
			for (const a of g.annotations) {
				const link = g.provider.preview(a, this.annotationContext(g.layer, a));
				if (link) return link;
			}
		}
		return null;
	}

	private onAnnotationClick(e: MouseEvent, hits: LayerHit[]): void {
		const group = this.groupHits(hits)[0];
		if (!group) return;
		const handled = () => !!group.provider.onClick?.(group.annotations, e, this.annotationContext(group.layer, group.annotations[0]));
		if (!Platform.isMobile) {
			handled();
			return;
		}
		// As with highlights: this tap may be the first half of a double tap, or the end of a hold.
		const tappedAt = Date.now();
		if (tappedAt - this.lastHold < 1000) return;
		const at = { x: e.clientX, y: e.clientY };
		window.setTimeout(() => {
			if (this.lastDoubleTap >= tappedAt) return;
			if (!handled()) this.showAnnotationMenu(hits, at);
		}, 320);
	}

	/** The annotations a long press opens the menu of: not those whose provider leaves it to select text (`holdSelects`) */
	private heldAnnotations(hits: LayerHit[]): LayerHit[] {
		return hits.filter((h) => !this.plugin.providers.get(h.layer.replace(/^provider:/, ''))?.holdSelects);
	}

	private showAnnotationMenu(hits: LayerHit[], at: { x: number; y: number }): void {
		const menu = new Menu();
		this.addAnnotationItems(menu, hits);
		menu.onHide(() => this.afterMenuHidden());
		menu.showAtPosition(at);
	}

	/** "Save as highlight" / "Save with comment" for each annotation, then the provider's own items. */
	addAnnotationItems(menu: Menu, hits: LayerHit[]): void {
		const groups = this.groupHits(hits);
		const many = groups.reduce((n, g) => n + g.annotations.length, 0) > 1;
		for (const g of groups) {
			for (const a of g.annotations) {
				const section = `fpp-ann-${g.provider.id}-${a.id}`;
				this.addActiveColorRow(menu, section);
				if (many) menu.addItem((i) => (i.setTitle(`${g.provider.name}: ${a.label}`) as any).setIsLabel?.(true).setSection?.(section));
				menu.addItem((i) =>
					i
						.setTitle('Save as highlight')
						.setIcon('highlighter')
						.setSection(section)
						.onClick(() => this.plugin.annotator.saveAnnotation(this, g.layer, a, this.activeColor, false)),
				);
				menu.addItem((i) =>
					i
						.setTitle('Save with comment…')
						.setIcon('message-square-plus')
						.setSection(section)
						.onClick(() => this.plugin.annotator.saveAnnotation(this, g.layer, a, this.activeColor, true)),
				);
			}
			try {
				g.provider.menu?.(menu, g.annotations, this.annotationContext(g.layer, g.annotations[0]));
			} catch (e) {
				console.error(`[fpp] annotation provider ${g.provider.id} menu failed`, e);
			}
		}
	}

	/**
	 * Touch gestures inside the view:
	 * - Vertical: Obsidian mobile opens its pull-down action (command palette) on a downward swipe when
	 *   the view looks scrolled to the top, and our scroller lives in a shadow root, so it always looks
	 *   that way. Keep vertical swipes in the reader unless it really is at the top.
	 * - Horizontal (mobile): a swipe that would open Obsidian's left drawer opens our sidebar first; if
	 *   it's already open, the swipe goes to Obsidian. Swiping back closes our sidebar.
	 */
	private guardTouchGestures(): void {
		let x0 = 0;
		let y0 = 0;
		let t0 = 0;
		let dx = 0;
		let axis: 'x' | 'y' | null = null;
		let inReader = false;
		let mine: 'open' | 'close' | null = null;
		const readerScrolled = () => inReader && !!this.reader && this.reader.scroller.scrollTop > 0;
		const start = (e: TouchEvent) => {
			const t = e.touches[0];
			inReader = this.hostEl.contains(e.target as Node);
			if (inReader) {
				this.touching = true;
				this.lastMenuLocator = null; // a new interaction may reselect the same text
			}
			x0 = t?.clientX ?? 0;
			y0 = t?.clientY ?? 0;
			t0 = Date.now();
			window.clearTimeout(this.holdTimer);
			if (inReader && Platform.isMobile && e.touches.length === 1) {
				const hx = x0;
				const hy = y0;
				this.holdTimer = window.setTimeout(() => {
					if (axis === null && this.touching) this.onHold(hx, hy);
				}, 450);
			}
			dx = 0;
			axis = null;
			mine = null;
		};
		const move = (e: TouchEvent) => {
			const t = e.touches[0];
			if (!t) return;
			dx = t.clientX - x0;
			const dy = t.clientY - y0;
			if (axis === null && Math.abs(dx) + Math.abs(dy) > 8) {
				window.clearTimeout(this.holdTimer);
				axis = Math.abs(dy) > Math.abs(dx) ? 'y' : 'x';
				// A drag that starts after a long press is adjusting a text selection, not a swipe.
				const longPress = Date.now() - t0 > 350 || !!this.reader?.getSelectionRange();
				if (axis === 'x' && Platform.isMobile && !longPress) {
					const open = this.mainEl.hasClass('fpp-sidebar-open');
					mine = dx > 0 ? (open ? null : 'open') : open ? 'close' : null;
				}
			}
			if ((axis === 'y' && readerScrolled()) || mine) e.stopPropagation();
		};
		const end = (e: TouchEvent) => {
			window.clearTimeout(this.holdTimer);
			if (Date.now() - this.lastHold < 1000) {
				// The hold already acted; this release must not count as a tap, nor produce the synthetic
				// mousedown/click that would close the menu it opened.
				e.preventDefault();
				this.touching = false;
				this.lastTap = { t: 0, x: 0, y: 0 };
				return;
			}
			if (axis === null && inReader && Date.now() - t0 < 300 && this.handleTap(e)) {
				this.touching = false;
				return;
			}
			if (e.touches.length === 0 && inReader) {
				this.touching = false;
				this.scheduleSelectionMenu(this.reader?.getSelection() ?? null);
			}
			if (axis === 'y' && readerScrolled()) e.stopPropagation();
			if (mine) {
				e.stopPropagation();
				if (mine === 'open' && dx > 50) this.toggleSidebar(true);
				else if (mine === 'close' && dx < -50) this.toggleSidebar(false);
				mine = null;
			}
		};
		this.registerDomEvent(this.mainEl, 'touchstart', start, { passive: true });
		this.registerDomEvent(this.mainEl, 'touchmove', move, { passive: true });
		// Not passive: a double tap prevents the browser's own double-tap handling (zoom / word select).
		this.registerDomEvent(this.mainEl, 'touchend', end, { passive: false });
		this.registerDomEvent(this.mainEl, 'touchcancel', end, { passive: true });
	}

	private lastTap = { t: 0, x: 0, y: 0 };
	private lastDoubleTap = 0;
	private lastHold = 0;
	private holdTimer = 0;

	/**
	 * A long press on text that isn't a highlight or an annotation (mobile): return true to handle it
	 * (a word's dictionary entry), and the OS's selection of the word and the selection menu are kept
	 * away; false leaves the OS to select the word. `target`: the element under the finger
	 */
	protected onTextHold(_x: number, _y: number, _target: Element | null): boolean {
		return false;
	}

	/** A long press: when it is on a highlight, run the configured action and keep the OS selection away. */
	private onHold(x: number, y: number): void {
		const hits = this.reader?.highlightsAt(x, y) ?? [];
		const annotations = hits.length ? [] : this.heldAnnotations(this.reader?.layerHitsAt(x, y) ?? []);
		const text = !hits.length && !annotations.length;
		if (text && !this.onTextHold(x, y, this.reader?.shadow.elementFromPoint(x, y) ?? null)) return;
		this.lastHold = Date.now();
		window.clearTimeout(this.selectionMenuTimer);
		const doc = this.contentEl.doc;
		// The OS starts selecting the word under a long press; drop that selection.
		for (const ms of [0, 120, 400]) window.setTimeout(() => doc.getSelection()?.removeAllRanges(), ms);
		if (text) return;
		if (annotations.length) return this.showAnnotationMenu(annotations, { x, y });
		this.runHighlightGesture(this.plugin.settings.highlightHold, hits.map((h) => h.data as HighlightEntry), { x, y });
	}


	/** Mobile: a double tap selects the paragraph under the finger and opens the plugin's menu. */
	private handleTap(e: TouchEvent): boolean {
		const touch = e.changedTouches[0];
		if (!touch || !Platform.isMobile || !this.reader) return false;
		const now = Date.now();
		const prev = this.lastTap;
		this.lastTap = { t: now, x: touch.clientX, y: touch.clientY };
		if (now - prev.t > 350 || Math.hypot(touch.clientX - prev.x, touch.clientY - prev.y) > 30) return false;
		this.lastTap = { t: 0, x: 0, y: 0 };
		const hits = this.reader.highlightsAt(touch.clientX, touch.clientY);
		if (hits.length && this.plugin.settings.highlightDoubleTap !== 'select') {
			e.preventDefault();
			this.lastDoubleTap = now;
			this.runHighlightGesture(this.plugin.settings.highlightDoubleTap, hits.map((h) => h.data as HighlightEntry), { x: touch.clientX, y: touch.clientY });
			return true;
		}
		const target = e.composedPath()[0] as Node | undefined;
		const el = target?.nodeType === 1 ? (target as Element) : target?.parentElement;
		const block = el?.closest('p, li, blockquote, h1, h2, h3, h4, h5, h6, dd, dt, figcaption, td, th, pre, div:not(.fpp-body):not(.fpp-section)');
		if (!block || !this.reader.content.contains(block) || !block.textContent?.trim()) return false;
		e.preventDefault();
		this.lastDoubleTap = now;
		this.nativeSelectionMode = false;
		const range = block.ownerDocument.createRange();
		range.selectNodeContents(block);
		const sel = block.ownerDocument.getSelection();
		sel?.removeAllRanges();
		sel?.addRange(range);
		window.clearTimeout(this.selectionMenuTimer);
		window.setTimeout(() => {
			const info = this.reader?.describeRange(range);
			if (!info) return;
			this.lastMenuLocator = info.locator;
			this.showSelectionMenu(info);
		}, 60);
		return true;
	}

	private onCopy(e: ClipboardEvent): void {
		const what = this.plugin.annotator.resolveCopyAction(this.plugin.settings.copyAction);
		if (!what || !e.clipboardData) return; // default browser copy
		const sel = this.reader?.getSelection();
		if (!sel) return;
		if (what === 'text') {
			if (!this.plugin.settings.copyMarkdown) return; // default browser copy
			// Markdown as plain text; keep the document's HTML for rich-text targets.
			const holder = sel.range.startContainer.ownerDocument!.createElement('div');
			holder.appendChild(sel.range.cloneContents());
			e.clipboardData.setData('text/plain', this.plugin.annotator.selectionText(sel));
			e.clipboardData.setData('text/html', holder.innerHTML);
			e.preventDefault();
			return;
		}
		if (this.plugin.annotator.asksForComment(what)) {
			// Needs a prompt first, so it can't fill this (synchronous) copy event.
			e.preventDefault();
			this.plugin.annotator.copy(this, sel, what, this.activeColor);
			return;
		}
		const text = this.plugin.annotator.renderCopy(this, sel, what, this.activeColor);
		e.clipboardData.setData('text/plain', text);
		// Ctrl/Cmd+C always copies; it also inserts when the annotation file's mode asks for it.
		const ann = this.file ? this.plugin.annotator.annotations.find(this.file) : null;
		if (ann && this.plugin.annotator.annotations.mode(ann) !== 'copy') {
			e.preventDefault();
			this.plugin.annotator.addToAnnotationFile(this, ann, sel, text, true);
			return;
		}
		e.preventDefault();
		new Notice(`Copied ${this.plugin.annotator.copyLabel(what)}`);
	}

	/** Re-apply jump-highlight settings to an open reader. */
	applyFlashSettings(): void {
		const s = this.plugin.settings;
		this.reader?.setFlashDefaults({ color: s.jumpHighlightColor, duration: s.jumpHighlightDuration });
	}

	applyPalette(): void {
		this.renderPalette();
		this.reader?.setPalette(this.plugin.paletteRecord(), this.plugin.settings.defaultColor);
	}

	renderPalette(): void {
		const el = this.paletteEl;
		el.empty();
		const add = (name: string | null, color: string, label: string) => {
			const sw = el.createDiv({ cls: 'fpp-swatch', attr: { 'aria-label': label } });
			sw.style.setProperty('--swatch', color);
			if (!name) sw.addClass('fpp-swatch-none');
			sw.toggleClass('is-active', this.activeColor === name);
			sw.addEventListener('click', () => {
				this.setActiveColor(name);
				const sel = this.reader?.getSelection();
				// PDF++-like: clicking a color while text is selected copies a link in that color.
				if (sel) this.plugin.annotator.copy(this, sel, 'link', name);
			});
		};
		for (const p of this.plugin.settings.palette) add(p.name, p.color, p.name);
		add(null, 'transparent', 'No color');
	}

	// --------------------------------------------------------------------------------------------
	// Menus
	// --------------------------------------------------------------------------------------------

	private colorTitle(name: string | null): DocumentFragment {
		return colorTitle(this.plugin, name);
	}

	/** @internal (the annotator) The view as the selection and highlight menus' host (annotator/menus.ts) */
	get menuHost(): MenuHost<Doc, R> {
		const view = this;
		return (this._menuHost ??= {
			plugin: this.plugin,
			target: this,
			get activeColor() {
				return view.activeColor;
			},
			setActiveColor: (c) => this.setActiveColor(c),
			editComment: (entry) => this.editComment(entry),
			openSource: (entry) => void this.plugin.annotator.openSource(entry, this),
			extendSelectionMenu: (menu, info) => this.extendSelectionMenu(menu, info),
			extendHighlightMenu: (menu, entry, section) => this.extendHighlightMenu(menu, entry, section),
		});
	}
	private _menuHost: MenuHost<Doc, R> | null = null;

	/** Remember the color picked last; it is what tapping a colored menu item uses next time. */
	setActiveColor(color: string | null): void {
		this.activeColor = color;
		this.plugin.settings.lastColor = color;
		this.plugin.saveSettings();
		for (const v of this.plugin.views()) v.renderPalette();
	}

	/**
	 * A row of palette swatches (and "No color") as a menu item: one line that scrolls sideways
	 * instead of wrapping. `onPick` runs without closing the menu.
	 */
	/** @internal (the annotator) */
	addColorRow(menu: Menu, section: string, current: () => string | null, onPick: (color: string | null) => void): void {
		addColorRow(this.plugin, menu, section, current, onPick);
	}

	/** The color the selection / annotation items below use (the toolbar's active color). */
	private addActiveColorRow(menu: Menu, section: string): void {
		addActiveColorRow(this.menuHost, menu, section);
	}

	private colorCss(name: string | null): string {
		return colorCss(this.plugin, name);
	}

	/** @internal (the annotator) */
	openColorMenu(at: { x: number; y: number }, checked: string | null, onPick: (color: string | null) => void): void {
		const m = new Menu();
		for (const c of [...this.plugin.settings.palette.map((p) => p.name), null])
			m.addItem((i) => i.setTitle(this.colorTitle(c)).setChecked(c === checked).onClick(() => onPick(c)));
		m.onHide(() => this.afterMenuHidden());
		m.showAtPosition(at);
	}

	/**
	 * Selection menu, in the order and with the items configured in settings. `copyOnly` (the paragraph
	 * under a right-clicked highlight): just a "Copy" heading and items that only copy, no color row.
	 */
	addSelectionItems(menu: Menu, info: SelectionInfo, isParagraph = false, copyOnly = false): void {
		addSelectionItems(this.menuHost, menu, info, isParagraph, copyOnly);
	}

	/** Add the plugin's own items for a highlight to the highlight menu (in the highlight's `section`). */
	/** @internal: lets the annotator call the (protected) hook below */
	extendHighlightMenuFor(menu: Menu, entry: HighlightEntry, section: string): void {
		this.extendHighlightMenu(menu, entry, section);
	}

	protected extendHighlightMenu(_menu: Menu, _entry: HighlightEntry, _section: string): void {}

	/** Add the plugin's own items to the selection menu (after the copy items; not for copy-only menus). */
	protected extendSelectionMenu(_menu: Menu, _info: SelectionInfo): void {}



	override onPaneMenu(menu: Menu, source: string): void {
		super.onPaneMenu(menu, source);
		const opened = this.source;
		if (opened)
			menu.addItem((i) =>
				i
					.setTitle(`Open ${opened.name} by itself`)
					.setIcon('file')
					.setSection('open')
					.onClick(() => void this.plugin.openUntakenOver(this.leaf, opened)),
			);
		if (this.file && this.plugin.format.plainText) {
			menu.addItem((i) =>
				i
					.setTitle('Read as plain text')
					.setIcon('file-code')
					.setSection('open')
					.onClick(() => this.plugin.toggleSource(this.leaf, 'read')),
			);
			menu.addItem((i) =>
				i
					.setTitle('Edit as plain text')
					.setIcon('pencil')
					.setSection('open')
					.onClick(() => this.plugin.toggleSource(this.leaf, 'edit')),
			);
		}
		if (!this.file || !this.reader) return;
		menu.addItem((i) =>
			i
				.setTitle('Comments in the margin')
				.setIcon('message-square-text')
				.setChecked(this.showsComments())
				.setSection('view')
				.onClick(() => void this.setCommentsShown(!this.showsComments())),
		);
		const ann = this.plugin.annotator.annotations.find(this.file);
		menu.addItem((i) =>
			i
				.setTitle(ann ? 'Open annotation file' : 'Create annotation file')
				.setIcon('notebook-pen')
				.setSection('open')
				.onClick(() => this.plugin.annotator.openAnnotationFile(this)),
		);
	}


	// --------------------------------------------------------------------------------------------
	// Selection bar (mobile: there is no right-click)
	// --------------------------------------------------------------------------------------------

	private selectionMenuTimer = 0;
	/** CFI of the selection the menu was last shown for (don't re-open it for the same selection). */
	/** @internal (the annotator) */
	lastMenuLocator: string | null = null;
	private touching = false;
	/** The selection our mobile menu is acting on (drawn by us while the native one is dropped). */
	private pendingSelection: Range | null = null;
	private restoreNativeSelection = false;
	/**
	 * After "System menu", the restored selection belongs to the OS: don't take it over again (a tap on
	 * it would otherwise re-open our menu and drop it) until the selection is cleared.
	 */
	private nativeSelectionMode = false;
	/** Set while one of our menus hands over to another (e.g. the color picker). */
	keepPendingSelection = false;

	/** Mobile has no right-click: open our menu once a selection settles (not while touching). */
	private scheduleSelectionMenu(sel: SelectionInfo | null): void {
		window.clearTimeout(this.selectionMenuTimer);
		if (!Platform.isMobile || !this.plugin.settings.selectionBar) return;
		if (!sel) {
			if (!this.pendingSelection) this.nativeSelectionMode = false;
			return;
		}
		if (this.nativeSelectionMode || Date.now() - this.lastHold < 1500) return;
		this.selectionMenuTimer = window.setTimeout(() => {
			if (this.touching || this.nativeSelectionMode) return; // touchend reschedules
			const cur = this.reader?.getSelection();
			if (!cur || cur.locator === this.lastMenuLocator) return;
			this.lastMenuLocator = cur.locator;
			this.showSelectionMenu(cur);
		}, 500);
	}

	/** Opens the selection menu (Copy / Insert / Both, the formats) on a range, as if it were selected: a verse, a word */
	openSelectionMenu(range: Range): void {
		const info = this.reader?.describeRange(range);
		if (!info) return;
		this.nativeSelectionMode = false;
		this.lastMenuLocator = info.locator;
		window.clearTimeout(this.selectionMenuTimer);
		this.showSelectionMenu(info);
	}

	/** @internal (the annotator) */
	showSelectionMenu(info: SelectionInfo): void {
		// The OS toolbar is tied to the native selection: drop it while our menu is open and paint the
		// selected text ourselves instead.
		this.pendingSelection = info.range;
		this.reader?.setPendingSelection(info.range);
		info.range.startContainer.ownerDocument?.getSelection()?.removeAllRanges();

		const menu = new Menu();
		this.addSelectionItems(menu, info);
		menu.addItem((i) =>
			i
				.setTitle('System menu')
				.setIcon('smartphone')
				.setSection('fpp-system')
				.onClick(() => (this.restoreNativeSelection = true)),
		);
		menu.onHide(() => this.afterMenuHidden());
		const r = info.range.getBoundingClientRect();
		menu.showAtPosition({ x: r.left + r.width / 2, y: r.bottom + 8 });
	}

	/** Called whenever one of our menus closes: finish the selection session unless another menu took over. */
	afterMenuHidden(): void {
		window.setTimeout(() => {
			if (this.keepPendingSelection) {
				this.keepPendingSelection = false;
				return;
			}
			const range = this.pendingSelection;
			this.pendingSelection = null;
			this.reader?.setPendingSelection(null);
			if (range && this.restoreNativeSelection) {
				// After the tap on the menu has fully finished, so it can't collapse the selection again.
				// lastMenuLocator still matches, so this doesn't re-open our menu.
				window.setTimeout(() => {
					const sel = range.startContainer.ownerDocument?.getSelection();
					sel?.removeAllRanges();
					sel?.addRange(range);
					// Only now: "selection cleared" events from the gap before this must not end the mode.
					this.nativeSelectionMode = true;
					new Notice('Tap the selected text to open the system menu', 3000);
				}, 250);
			}
			this.restoreNativeSelection = false;
		}, 50);
	}

	// --------------------------------------------------------------------------------------------
	// Panels
	// --------------------------------------------------------------------------------------------

	/**
	 * Opens or closes the sidebar (toggles it without `open`). With `persist`, for the user's own
	 * opening or closing (not closing the drawer after going to a result), new views open the same way.
	 */
	toggleSidebar(open?: boolean, persist = true): void {
		const isOpen = this.mainEl.hasClass('fpp-sidebar-open');
		const next = open ?? !isOpen;
		// Opened for a moment (search, the outline) though the user closed it: closes again back in the text
		if (persist || !next) this.sidebarTransient = false;
		else if (!isOpen && !this.plugin.sidebarState().open) this.sidebarTransient = true;
		this.mainEl.toggleClass('fpp-sidebar-open', next);
		if (next && !isOpen) this.sidebar?.opened();
		// Obsidian's mobile navbar overlaps the drawer's bottom; hide it while the drawer is open.
		this.contentEl.doc.body.toggleClass('fpp-drawer-open', next && this.sidebarIsOverlay());
		if (persist) this.plugin.rememberSidebar({ open: next });
	}

	private sidebarTransient = false;

	/**
	 * Back in the text from the sidebar (reader keys, a click in the text): key modes end, and a
	 * drawer, or a sidebar opened only for this (see `toggleSidebar`), closes.
	 */
	backToText(): void {
		this.sidebar.setKeyMode(null);
		if (this.mainEl.hasClass('fpp-sidebar-open') && (this.sidebarTransient || this.sidebarIsOverlay())) this.toggleSidebar(false, false);
	}

	/** Adds a tab of the format's own to the sidebar (see `Sidebar.addFormatTab`); call it in `buildExtraUi` */
	addSidebarTab(id: string, icon: string, label: string, onShow?: () => void): HTMLElement {
		return this.sidebar.addFormatTab(id, icon, label, onShow);
	}

	/** Opens the sidebar at a tab (as if picked: new views open on it too) */
	showSidebarTab(id: string): void {
		this.toggleSidebar(true, false);
		this.sidebar.showTab(id);
		this.plugin.rememberSidebar({ tab: id });
	}

	/** Whether a tab of the sidebar shows: the sidebar open, at that tab */
	sidebarTabShown(id: string): boolean {
		return this.mainEl.hasClass('fpp-sidebar-open') && this.sidebar.isActive(id);
	}

	/** The sidebar at the contents, moved through with keys (reader keys) */
	openOutlineKeys(): void {
		this.showSidebarTab('toc');
		this.sidebar.setKeyMode('toc');
	}

	openSearch(): void {
		this.toggleSidebar(true, false);
		this.sidebar.showTab('search');
		const q = this.reader?.getSelection()?.text;
		this.sidebar.focusSearch(q && q.length < 100 ? q : undefined);
	}

	/** The orientation changed (see the plugin): the appearance panel shows the other set. */
	onAppearanceChanged(): void {
		this.appearance?.refresh();
	}

	toggleAppearance(): void {
		this.appearance.toggle();
	}
}

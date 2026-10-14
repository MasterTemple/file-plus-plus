import { type HighlightSpec, type SearchResult, type TocItem } from '../core';
import { Component, MarkdownRenderer, Menu, Platform, Scope, debounce, setIcon, type HoverParent, type HoverPopover, type TFile } from 'obsidian';
import type { HighlightEntry } from '../annotator/highlight-index';
import { layerId, type Annotation, type AnnotationProvider } from './api';
import { titleCase } from './settings';
import { hoverLink } from './hover';
import type { DocumentView } from './view';
import { timeAgo } from '../annotator/margin-comments';

/** `toc`, `search`, `highlights`, or `provider:<id>` for another plugin's annotations. */
type Tab = string;

/** In-view sidebar (PDF++-style): table of contents, search, and highlights in this document. */
export class Sidebar {
	private tabs = new Map<Tab, { button: HTMLElement; panel: HTMLElement }>();
	private tocEl: HTMLElement;
	private tocItems = new Map<string, HTMLElement>();
	private currentToc: string | null = null;
	private searchInput!: HTMLInputElement;
	private searchInfo!: HTMLElement;
	private resultsEl!: HTMLElement;
	private results: SearchResult[] = [];
	private current = -1;
	private opts = { caseSensitive: false, wholeWord: false, regex: false };
	private highlightsEl: HTMLElement;
	private header: HTMLElement;
	private body: HTMLElement;
	private activeTab: Tab = 'toc';
	private providerPanels = new Map<string, ProviderPanel>();
	/** What a format's own tabs (`addFormatTab`) do each time they're shown */
	private formatTabs = new Map<Tab, () => void>();

	constructor(
		private view: DocumentView,
		private el: HTMLElement,
	) {
		const header = (this.header = el.createDiv('fpp-sidebar-tabs'));
		this.body = el.createDiv('fpp-sidebar-body');
		this.tocEl = this.addTab('toc', 'list-tree', 'Contents');
		this.buildSearch(this.addTab('search', 'search', 'Search'));
		this.highlightsEl = this.addTab('highlights', 'highlighter', 'Highlights');
		if (Platform.isMobile) {
			const close = header.createDiv({ cls: 'clickable-icon fpp-sidebar-close', attr: { 'aria-label': 'Close' } });
			setIcon(close, 'x');
			close.addEventListener('click', () => this.view.toggleSidebar(false));
		}
		this.showTab(this.view.plugin.sidebarState().tab);
	}

	/** A tab the user picked: new views open on it */
	private chooseTab(id: Tab): void {
		this.showTab(id);
		this.view.plugin.rememberSidebar({ tab: id });
	}

	private get noun(): string {
		return this.view.plugin.format.noun;
	}

	private addTab(id: Tab, icon: string, label: string): HTMLElement {
		const button = createDiv({ cls: 'clickable-icon fpp-sidebar-tab', attr: { 'aria-label': label } });
		// Provider tabs go after the built-in ones, before the mobile close button.
		this.header.insertBefore(button, this.header.querySelector('.fpp-sidebar-close'));
		setIcon(button, icon);
		button.addEventListener('click', () => this.chooseTab(id));
		// The tab last chosen, once it's there (another plugin's tab is added after the view opens)
		if (this.tabs.size > 0 && this.activeTab !== id && id === this.view.plugin.sidebarState().tab) queueMicrotask(() => this.showTab(id));
		const panel = this.body.createDiv(`fpp-panel fpp-panel-${id.replace(/[^\w-]/g, '_')}`);
		this.tabs.set(id, { button, panel });
		return panel;
	}

	/**
	 * A tab of the format's own (the Bible's commentaries), after the built-in ones: its panel, which
	 * stays across documents; `onShow` runs each time the tab is shown
	 */
	addFormatTab(id: Tab, icon: string, label: string, onShow: () => void = () => {}): HTMLElement {
		const panel = this.addTab(id, icon, label);
		this.formatTabs.set(id, onShow);
		return panel;
	}

	/** The sidebar opened: a format's tab showing is told so (`onShow`) */
	opened(): void {
		this.formatTabs.get(this.activeTab)?.();
	}

	/** Whether a tab is the one showing (in the sidebar, open or not) */
	isActive(id: Tab): boolean {
		return this.activeTab === id;
	}

	/** Add or update the tab of an annotation provider for the current document. */
	setProvider(provider: AnnotationProvider<unknown>, hidden: boolean): void {
		const id = layerId(provider.id);
		let panel = this.providerPanels.get(id);
		if (!panel) {
			panel = new ProviderPanel(this.view, provider, this.addTab(id, provider.icon ?? 'sparkles', provider.name), () => this.activeTab === id);
			this.providerPanels.set(id, panel);
		}
		panel.provider = provider;
		panel.update(hidden);
	}

	removeProvider(providerId: string): void {
		const id = layerId(providerId);
		const t = this.tabs.get(id);
		if (!t) return;
		t.button.remove();
		t.panel.remove();
		this.tabs.delete(id);
		this.providerPanels.delete(id);
		if (this.activeTab === id) this.showTab('toc');
	}

	showTab(id: Tab): void {
		if (!this.tabs.has(id)) id = 'toc';
		this.activeTab = id;
		for (const [k, t] of this.tabs) {
			t.button.toggleClass('is-active', k === id);
			t.panel.toggleClass('is-active', k === id);
		}
		this.formatTabs.get(id)?.();
		const provider = this.providerPanels.get(id);
		this.view.setSearchNavVisible((id === 'search' && this.results.length > 0) || (!!provider && provider.count > 0));
		provider?.render();
		if (id !== 'search') this.view.reader?.showSearchResults([]);
		else {
			if (this.searchInput && this.searchInput.value !== this.lastQuery) this.runSearch();
			else if (this.results.length) this.view.reader?.showSearchResults(this.results, -1);
			this.warmIndex();
		}
	}

	setToc(toc: TocItem[] | null): void {
		this.setKeyMode(null);
		this.tocEl.empty();
		this.tocItems.clear();
		this.results = [];
		this.view.setSearchNavVisible(false);
		this.resultsEl?.empty();
		this.searchInfo?.setText('');
		// Providers re-add their tabs for the next document.
		for (const id of [...this.providerPanels.keys()]) this.removeProvider(id.replace(/^provider:/, ''));
		// The query stays: the next document (or this one, drawn again) is searched for it
		this.lastQuery = '';
		if (!toc) return;
		if (!toc.length) this.tocEl.createDiv({ cls: 'fpp-empty', text: `This ${this.noun} has no table of contents.` });
		this.renderToc(toc, this.tocEl);
		if (this.activeTab === 'search' && this.searchInput?.value.trim()) this.runSearch();
	}

	// --- TOC -------------------------------------------------------------------------------------

	private renderToc(items: TocItem[], parent: HTMLElement): void {
		// Entries without children line up with siblings that have a collapse arrow.
		const arrows = items.some((i) => i.children.length);
		for (const item of items) {
			const wrap = parent.createDiv('tree-item fpp-toc-item');
			const self = wrap.createDiv('tree-item-self is-clickable fpp-toc-self');
			self.style.paddingInlineStart = `${8 + item.depth * 14}px`;
			let childrenEl: HTMLElement | null = null;
			if (item.children.length) {
				const toggle = self.createDiv('tree-item-icon collapse-icon fpp-toc-toggle');
				setIcon(toggle, 'right-triangle');
				toggle.addEventListener('click', (e) => {
					e.stopPropagation();
					wrap.toggleClass('is-collapsed', !wrap.hasClass('is-collapsed'));
				});
				if (item.depth >= 1) wrap.addClass('is-collapsed');
			} else if (arrows) self.createDiv('fpp-toc-spacer');
			self.createDiv({ cls: 'tree-item-inner', text: item.label || '(untitled)' });
			if (item.href) self.addEventListener('click', () => this.view.goToToc(item));
			else self.addClass('is-disabled');
			this.tocItems.set(item.id, self);
			if (item.children.length) {
				childrenEl = wrap.createDiv('tree-item-children');
				this.renderToc(item.children, childrenEl);
			}
		}
	}

	setCurrent(item: TocItem | null): void {
		if (this.currentToc === (item?.id ?? null)) return;
		if (this.currentToc) this.tocItems.get(this.currentToc)?.removeClass('is-active');
		this.currentToc = item?.id ?? null;
		const el = item && this.tocItems.get(item.id);
		if (!el) return;
		el.addClass('is-active');
		// expand ancestors
		for (let p = el.parentElement; p && p !== this.tocEl; p = p.parentElement) if (p.hasClass('is-collapsed')) p.removeClass('is-collapsed');
		el.scrollIntoView({ block: 'nearest' });
	}

	// --- Moving through the TOC with keys (reader keys) ------------------------------------------

	private tocCursor: HTMLElement | null = null;
	private keyMode: 'toc' | 'results' | null = null;

	/** What the reader keys move through: the TOC, the search results, or (null) the document. */
	keysMode(): 'toc' | 'results' | null {
		return this.keyMode;
	}

	/** Move through the TOC (from the current chapter) or the search results with keys, or (null) stop. */
	setKeyMode(mode: 'toc' | 'results' | null): void {
		if (mode === this.keyMode) return;
		this.keyMode = mode;
		this.tocEl.toggleClass('fpp-toc-keys', mode === 'toc');
		this.resultsEl?.toggleClass('fpp-results-keys', mode === 'results');
		if (mode !== 'toc') this.setTocCursor(null);
		if (mode === 'toc') {
			const current = this.currentToc ? this.tocItems.get(this.currentToc) : null;
			this.setTocCursor(current ?? this.visibleTocItems()[0] ?? null);
		}
		if (mode === 'results') {
			if (this.searchInput === activeDocument.activeElement) this.searchInput.blur();
			if (this.current === -1) this.stepResults(1);
		}
	}

	/** The next (`delta` 1) or previous search result, shown in the document; false without results. */
	stepResults(delta: number): boolean {
		if (!this.results.length) return false;
		const n = this.results.length;
		this.select(this.current === -1 ? (delta > 0 ? 0 : n - 1) : (this.current + delta + n) % n);
		return true;
	}

	/** In the results' key mode: the next / previous result (wrapping), or with ±Infinity the first / last one. */
	moveResults(by: number): void {
		if (!this.results.length) return;
		if (Number.isFinite(by)) this.stepResults(by);
		else this.select(by > 0 ? this.results.length - 1 : 0);
	}

	/** TOC entries not inside a collapsed one, in order. */
	private visibleTocItems(): HTMLElement[] {
		return [...this.tocItems.values()].filter((el) => !el.parentElement?.parentElement?.closest('.fpp-toc-item.is-collapsed'));
	}

	private setTocCursor(el: HTMLElement | null): void {
		this.tocCursor?.removeClass('fpp-toc-cursor');
		this.tocCursor = el;
		el?.addClass('fpp-toc-cursor');
		el?.scrollIntoView({ block: 'nearest' });
	}

	moveTocCursor(delta: number): void {
		const items = this.visibleTocItems();
		if (!items.length) return;
		const i = this.tocCursor ? items.indexOf(this.tocCursor) : -1;
		this.setTocCursor(items[Math.max(0, Math.min(items.length - 1, i === -1 ? 0 : i + delta))]);
	}

	/** Expand (`open`) or collapse the entry at the cursor; collapsing a leaf (or a collapsed entry) goes to its parent. */
	foldTocCursor(open: boolean): void {
		const wrap = this.tocCursor?.parentElement;
		if (!wrap) return;
		const parent = wrap.parentElement?.closest<HTMLElement>('.fpp-toc-item');
		const hasChildren = !!wrap.querySelector(':scope > .tree-item-children');
		if (open) {
			if (hasChildren && wrap.hasClass('is-collapsed')) wrap.removeClass('is-collapsed');
			else if (hasChildren) this.moveTocCursor(1);
		} else if (hasChildren && !wrap.hasClass('is-collapsed')) wrap.addClass('is-collapsed');
		else if (parent) this.setTocCursor(parent.querySelector<HTMLElement>(':scope > .fpp-toc-self'));
	}

	/** Go to the entry at the cursor (as a click would), leaving key mode. */
	openTocCursor(): void {
		const el = this.tocCursor;
		this.setKeyMode(null);
		if (el && !el.hasClass('is-disabled')) el.click();
	}

	// --- Search ----------------------------------------------------------------------------------

	private buildSearch(panel: HTMLElement): void {
		const row = panel.createDiv('fpp-search-row search-input-container');
		this.searchInput = row.createEl('input', { type: 'search', attr: { placeholder: `Search ${this.noun}…`, spellcheck: 'false' } });
		const toggles = panel.createDiv('fpp-search-toggles');
		const toggle = (key: keyof typeof this.opts, label: string, title: string) => {
			const b = toggles.createDiv({ cls: 'fpp-search-toggle', text: label, attr: { 'aria-label': title } });
			b.addEventListener('click', () => {
				this.opts[key] = !this.opts[key];
				b.toggleClass('is-active', this.opts[key]);
				this.runSearch();
			});
		};
		toggle('caseSensitive', 'Aa', 'Match case');
		toggle('wholeWord', 'ab', 'Whole word');
		toggle('regex', '.*', 'Regular expression');
		const nav = toggles.createDiv('fpp-search-nav');
		this.searchInfo = nav.createDiv('fpp-search-info');
		const prev = nav.createDiv({ cls: 'clickable-icon', attr: { 'aria-label': 'Previous (Shift+Enter)' } });
		setIcon(prev, 'chevron-up');
		prev.addEventListener('click', () => this.step(-1));
		const next = nav.createDiv({ cls: 'clickable-icon', attr: { 'aria-label': 'Next (Enter)' } });
		setIcon(next, 'chevron-down');
		next.addEventListener('click', () => this.step(1));
		this.resultsEl = panel.createDiv('fpp-search-results');
		this.resultsEl.addEventListener(
			'scroll',
			() => {
				const el = this.resultsEl;
				if (this.renderedCount < this.results.length && el.scrollTop + el.clientHeight > el.scrollHeight - 400) this.renderMoreResults(100);
			},
			{ passive: true },
		);

		// Live search waits for 2+ characters (Enter searches anything); longer pause on mobile.
		const run = debounce(() => {
			const q = this.searchInput.value;
			if (q !== this.lastQuery && (q.trim().length >= 2 || !q.trim())) this.runSearch();
		}, Platform.isMobile ? 450 : 250, true);
		this.searchInput.addEventListener('input', run);
		// With reader keys, Ctrl+N / Ctrl+P step through the results while typing (ahead of Obsidian's
		// hotkeys, as a modal's keys are).
		const app = this.view.plugin.app;
		const scope = new Scope(app.scope);
		for (const [key, delta] of [['n', 1], ['p', -1]] as const)
			scope.register(['Ctrl'], key, () => {
				this.stepResults(delta);
				return false;
			});
		this.searchInput.addEventListener('focus', () => {
			if (this.view.plugin.settings.readerKeysEnabled) app.keymap.pushScope(scope);
		});
		this.searchInput.addEventListener('blur', () => app.keymap.popScope(scope));
		// A pasted query is searched for at once, even one that's already there
		this.searchInput.addEventListener('paste', () => {
			window.setTimeout(() => {
				if (this.searchInput.value.trim()) this.runSearch();
			});
		});
		this.searchInput.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') {
				e.preventDefault();
				if (this.searchInput && this.searchInput.value !== this.lastQuery) this.runSearch();
				// With reader keys, into the results (j / k move through them), from the one shown if any
				if (this.view.plugin.settings.readerKeysEnabled && this.activeTab === 'search' && this.results.length) {
					if (this.current === -1) this.step(e.shiftKey ? -1 : 1);
					this.setKeyMode('results');
				} else this.step(e.shiftKey ? -1 : 1);
			} else if (e.key === 'Escape') {
				// Escape clears the query, and in an empty box goes back to the text
				if (!this.searchInput.value) {
					this.searchInput.blur();
					this.view.backToText();
					return;
				}
				this.searchInput.value = '';
				this.runSearch();
			}
		});
	}

	private lastQuery = '';

	/** Build the text index in the background so the first keystroke doesn't stall (slow phones). */
	private warmIndex(): void {
		const reader = this.view.reader;
		if (!reader) return;
		const idle = (window as any).requestIdleCallback ?? ((cb: () => void) => window.setTimeout(cb, 50));
		idle(() => {
			if (this.view.reader === reader) void reader.textIndex.folded;
		});
	}

	focusSearch(query?: string): void {
		if (query) this.searchInput.value = query;
		if (query || this.searchInput.value !== this.lastQuery) this.runSearch();
		this.searchInput.focus();
		this.searchInput.select();
	}

	private runSearch(): void {
		const reader = this.view.reader;
		const q = this.searchInput.value;
		this.lastQuery = q;
		this.resultsEl.empty();
		this.current = -1;
		if (!reader || !q.trim()) {
			this.results = [];
			this.view.setSearchNavVisible(false);
			this.searchInfo.setText('');
			reader?.showSearchResults([]);
			return;
		}
		this.results = reader.search(q, { ...this.opts, limit: 2000 });
		this.searchInfo.setText(this.results.length >= 2000 ? '2000+ results' : `${this.results.length} result${this.results.length === 1 ? '' : 's'}`);
		reader.showSearchResults(this.results, -1);
		this.view.setSearchNavVisible(this.results.length > 0);

		this.renderedCount = 0;
		this.lastGroupSpine = -1;
		this.renderMoreResults(100);
	}

	private renderedCount = 0;
	private lastGroupSpine = -1;

	/** Results are appended in batches (on scroll) so huge result sets stay cheap to lay out. */
	private renderMoreResults(n: number): void {
		const end = Math.min(this.results.length, this.renderedCount + n);
		const frag = document.createDocumentFragment();
		for (let i = this.renderedCount; i < end; i++) {
			const r = this.results[i];
			if (r.sectionIndex !== this.lastGroupSpine) {
				this.lastGroupSpine = r.sectionIndex;
				frag.createDiv({ cls: 'fpp-search-group', text: r.tocItem()?.label ?? `Section ${r.sectionIndex + 1}` });
			}
			const el = frag.createDiv('fpp-search-result');
			el.dataset.index = String(i);
			el.createSpan({ text: r.excerpt.before });
			el.createEl('mark', { cls: 'fpp-search-match', text: r.excerpt.match });
			el.createSpan({ text: r.excerpt.after });
			el.addEventListener('click', () => this.select(i, true));
			if (i === this.current) el.addClass('is-active');
		}
		this.renderedCount = end;
		this.resultsEl.appendChild(frag);
	}

	step(delta: number): void {
		const provider = this.providerPanels.get(this.activeTab);
		if (provider) return provider.step(delta);
		this.stepResults(delta);
	}

	/** `fromClick`: a result was tapped, so a drawer-style sidebar gets out of the way. */
	private select(i: number, fromClick = false): void {
		if (fromClick) this.view.recordJump();
		this.current = i;
		this.view.reader?.showSearchResults(this.results, i);
		this.searchInfo.setText(`${i + 1} / ${this.results.length}`);
		if (i >= this.renderedCount) this.renderMoreResults(i - this.renderedCount + 50);
		this.resultsEl.querySelector('.is-active')?.removeClass('is-active');
		const el = this.resultsEl.querySelector(`[data-index="${i}"]`) as HTMLElement | null;
		el?.addClass('is-active');
		el?.scrollIntoView({ block: 'nearest' });
		if (fromClick && this.view.sidebarIsOverlay()) this.view.toggleSidebar(false, false);
	}

	// --- Highlights ------------------------------------------------------------------------------

	private hlEntries: HighlightEntry[] = [];
	/** Collapsed group headings in the Highlights tab (`grouping:label`), kept while the view is open. */
	private collapsedGroups = new Set<string>();
	private hlRender: Component | null = null;

	setHighlights(entries: HighlightEntry[]): void {
		this.hlEntries = entries;
		this.renderHighlights();
	}

	/** Highlights tab: filter (all / annotation file / elsewhere), grouping, comments. */
	private renderHighlights(): void {
		const el = this.highlightsEl;
		const scroll = el.scrollTop;
		el.empty();
		const { plugin, reader, file } = this.view;
		const s = plugin.settings;
		const ann = file ? plugin.annotator.annotations.find(file) : null;
		const inAnn = (e: HighlightEntry) => !!ann && e.sourcePath === ann.path;
		// With the places notes mention the document (not in its annotation file, whose headings name it)
		const entries = [...this.hlEntries, ...(file ? plugin.mentionsOf(file).filter((m) => !inAnn(m)) : [])];
		const rangeOf = (e: HighlightEntry) => (e.mention !== undefined ? (reader?.resolve(e.locator) ?? null) : (reader?.highlightRange(e.id) ?? null));

		const bar = el.createDiv('fpp-hl-toolbar');
		const btn = bar.createEl('button', { cls: 'fpp-hl-annotation-button' });
		setIcon(btn.createSpan(), 'notebook-pen');
		btn.createSpan({ text: ann ? 'Open annotation file' : 'Create annotation file' });
		btn.addEventListener('click', () => plugin.annotator.openAnnotationFile(this.view));
		const hidden = s.hideHighlights;
		const eye = bar.createDiv({ cls: 'clickable-icon fpp-hl-eye', attr: { 'aria-label': hidden ? `Show highlights in the ${plugin.format.noun}` : `Hide highlights in the ${plugin.format.noun}` } });
		setIcon(eye, hidden ? 'eye-off' : 'eye');
		eye.addEventListener('click', () => void plugin.annotator.setHighlightsHidden(!hidden));
		const margin = this.view.showsComments();
		const comments = bar.createDiv({ cls: 'clickable-icon fpp-hl-eye', attr: { 'aria-label': margin ? 'Hide comments in the margin' : 'Show comments in the margin' } });
		setIcon(comments, margin ? 'message-square-text' : 'message-square-off');
		comments.addEventListener('click', () => void this.view.setCommentsShown(!margin));

		const counts = { all: entries.length, annotation: entries.filter(inAnn).length, other: entries.filter((e) => !inAnn(e)).length };
		const filters = el.createDiv('fpp-segmented fpp-hl-filters');
		const labels = { all: 'All', annotation: 'Annotation file', other: 'Elsewhere' } as const;
		for (const f of ['all', 'annotation', 'other'] as const) {
			const b = filters.createDiv({ cls: 'fpp-mode-button', text: `${labels[f]} ${counts[f]}` });
			b.toggleClass('is-active', s.highlightsFilter === f);
			b.addEventListener('click', () => {
				s.highlightsFilter = f;
				plugin.saveSettings();
				this.renderHighlights();
			});
		}
		const groupRow = el.createDiv('fpp-hl-group-row');
		groupRow.createSpan({ text: 'Group by' });
		const select = groupRow.createEl('select', { cls: 'dropdown' });
		for (const [v, t] of [
			['book', `${titleCase(this.noun)} order`],
			['chapter', 'Chapter'],
			['note', 'Note'],
		] as const)
			select.createEl('option', { value: v, text: t });
		select.value = s.highlightsGroup;
		select.addEventListener('change', () => {
			s.highlightsGroup = select.value as typeof s.highlightsGroup;
			plugin.saveSettings();
			this.renderHighlights();
		});
		const toggleAll = groupRow.createDiv({ cls: 'clickable-icon fpp-hl-collapse-all' });

		const shown = entries.filter((e) => (s.highlightsFilter === 'all' ? true : s.highlightsFilter === 'annotation' ? inAnn(e) : !inAnn(e)));
		if (!shown.length) {
			const msg =
				s.highlightsFilter === 'annotation'
					? ann
						? 'No annotations in the annotation file yet.'
						: `This ${this.noun} has no annotation file yet.`
					: 'No highlights yet. Select text, right-click and copy a link into a note.';
			el.createDiv({ cls: 'fpp-empty', text: msg });
			return;
		}

		// Document order by resolved position (works for every kind of locator alike).
		const pos = new Map(shown.map((e) => [e, rangeOf(e)]));
		const sorted = [...shown].sort((a, b) => {
			const ra = pos.get(a);
			const rb = pos.get(b);
			if (!ra || !rb) return ra ? -1 : rb ? 1 : 0;
			return ra.compareBoundaryPoints(Range.START_TO_START, rb) || ra.compareBoundaryPoints(Range.END_TO_END, rb);
		});
		const groups = new Map<string, HighlightEntry[]>();
		const groupOf = (e: HighlightEntry): string => {
			if (s.highlightsGroup === 'note') return inAnn(e) ? `\u0000${ann!.basename}` : e.sourcePath.replace(/\.md$/, '');
			if (s.highlightsGroup === 'chapter') {
				const r = pos.get(e);
				return (r && reader?.tocItemAt(r)?.label) || 'Location not found';
			}
			return '';
		};
		for (const e of sorted) {
			const g = groupOf(e);
			if (!groups.has(g)) groups.set(g, []);
			groups.get(g)!.push(e);
		}
		let order = [...groups.keys()];
		if (s.highlightsGroup === 'note') order = order.sort((x, y) => x.localeCompare(y)); // annotation file (\u0000) first

		// Collapse / expand all groups.
		const keyOf = (g: string) => `${s.highlightsGroup}:${g}`;
		const grouped = order.some((g) => g);
		toggleAll.toggle(grouped);
		const allCollapsed = grouped && order.every((g) => this.collapsedGroups.has(keyOf(g)));
		setIcon(toggleAll, allCollapsed ? 'chevrons-up-down' : 'chevrons-down-up');
		toggleAll.setAttr('aria-label', allCollapsed ? 'Expand all' : 'Collapse all');
		toggleAll.onclick = () => {
			const expand = order.every((g) => this.collapsedGroups.has(keyOf(g)));
			for (const g of order) {
				if (expand) this.collapsedGroups.delete(keyOf(g));
				else this.collapsedGroups.add(keyOf(g));
			}
			this.renderHighlights();
		};

		if (this.hlRender) this.view.removeChild(this.hlRender);
		this.hlRender = this.view.addChild(new Component());
		const palette = Object.fromEntries(s.palette.map((p) => [p.name, p.color]));
		for (const g of order) {
			const list = groups.get(g)!;
			let target = el;
			if (g) {
				const key = keyOf(g);
				const collapsed = this.collapsedGroups.has(key);
				const head = el.createDiv({ cls: 'fpp-hl-group is-clickable' });
				head.toggleClass('is-collapsed', collapsed);
				setIcon(head.createSpan('fpp-hl-group-chevron'), 'chevron-down');
				head.createSpan({ text: g.replace('\u0000', '') });
				head.createSpan({ cls: 'fpp-hl-group-count', text: String(list.length) });
				target = el.createDiv('fpp-hl-group-items');
				target.toggle(!collapsed);
				head.addEventListener('click', () => {
					const now = !this.collapsedGroups.has(key);
					if (now) this.collapsedGroups.add(key);
					else this.collapsedGroups.delete(key);
					head.toggleClass('is-collapsed', now);
					target.toggle(!now);
					const every = order.every((x) => this.collapsedGroups.has(keyOf(x)));
					setIcon(toggleAll, every ? 'chevrons-up-down' : 'chevrons-down-up');
				});
			}
			for (const e of list) this.renderHighlightItem(target, e, palette, inAnn(e) ? ann : null, pos.get(e) ?? null);
		}
		el.scrollTop = scroll;
	}

	private renderHighlightItem(el: HTMLElement, e: HighlightEntry, palette: Record<string, string>, ann: TFile | null, range: Range | null): void {
		const s = this.view.plugin.settings;
		const item = el.createDiv('fpp-hl-item');
		item.toggleClass('is-mention', e.mention !== undefined);
		item.style.setProperty('--swatch', e.mention !== undefined ? 'var(--background-modifier-border)' : (e.color && (palette[e.color] ?? e.color)) || palette[s.defaultColor] || 'var(--text-highlight-bg)');
		const text = range?.toString().replace(/\s+/g, ' ').trim();
		item.createDiv({ cls: 'fpp-hl-text', text: text ? (text.length > 220 ? `${text.slice(0, 220)}…` : text) : '(location not found)' });
		// A mention: the note's words around it
		if (e.mention) item.createDiv({ cls: 'fpp-hl-mention', text: e.mention });
		if (e.comment) {
			const c = item.createDiv('fpp-hl-comment markdown-rendered');
			void MarkdownRenderer.render(this.view.app, e.comment, c, e.sourcePath, this.hlRender!);
		}
		const meta = item.createDiv('fpp-hl-meta');
		// In the annotation file the section heading says more than the file path.
		const label = ann ? (e.heading ?? ann.basename) : e.sourcePath.replace(/\.md$/, '');
		const note = meta.createEl('a', { cls: 'fpp-hl-note' });
		if (ann) setIcon(note.createSpan('fpp-hl-note-icon'), 'notebook-pen');
		else if (e.mention !== undefined) setIcon(note.createSpan({ cls: 'fpp-hl-note-icon', attr: { 'aria-label': 'Mentioned, not linked' } }), 'at-sign');
		note.createSpan({ text: label });
		note.setAttr('aria-label', e.sourcePath);
		note.addEventListener('click', (ev) => {
			ev.stopPropagation();
			this.view.plugin.annotator.openSource(e, this.view);
		});
		if (e.updated) meta.createSpan({ cls: 'fpp-hl-time', text: timeAgo(e.updated), attr: { 'aria-label': `Updated ${e.updated.toLocaleString()}` } });
		item.addEventListener('click', (ev) => {
			if ((ev.target as HTMLElement).closest('a')) return; // links inside comments
			// A highlight flashes in its own color
			this.view.navigate(e.locator, true, true, (e.mention === undefined && this.view.reader?.highlightColor(e.id)) || undefined);
			if (this.view.sidebarIsOverlay()) this.view.toggleSidebar(false, false);
		});
	}
}

/**
 * Puts the hover preview of a row in the list beside the list, not below the row, where it would
 * cover the rows under it (`hoverLink` keeps it there as Obsidian places it again)
 */
function placeBeside(popover: HoverPopover, row: HTMLElement): void {
	const win = row.win;
	const list = row.closest('.fpp-search-results') ?? row;
	const r = list.getBoundingClientRect();
	const top = row.getBoundingClientRect().top;
	const gap = 8;
	// The side with more room (the list is usually at the left of the text)
	const right = win.innerWidth - r.right >= r.left;
	const place = () => {
		if (!popover.hoverEl.isConnected) return;
		const width = popover.hoverEl.offsetWidth;
		const x = right ? r.right + gap : Math.max(gap, r.left - gap - width);
		popover.hoverEl.style.left = `${x}px`;
		popover.hoverEl.style.top = `${Math.max(gap, Math.min(top, win.innerHeight - popover.hoverEl.offsetHeight - gap))}px`;
	};
	place();
	// Its width is known once it shows
	if (!right) win.requestAnimationFrame(place);
}

/** How much of the text around an annotation its row shows, on each side */
const CONTEXT = 60;

/** A provider's tab: its annotations in document order, grouped by chapter, with a filter. */
class ProviderPanel {
	private items: { spec: HighlightSpec; annotation: Annotation; text: string | null; before: string; after: string; chapter: string }[] = [];
	private shown: typeof this.items = [];
	private current = -1;
	private filter = '';
	private hidden = false;
	private stale = true;
	private rendered = 0;
	private listEl: HTMLElement | null = null;
	private infoEl: HTMLElement | null = null;
	private collapseAllEl: HTMLElement | null = null;
	/** Runs of shown items in the same chapter: `[start, end)` indexes into `shown`. */
	private groups: { chapter: string; start: number; end: number; items?: HTMLElement; filled?: number }[] = [];
	/** Chapters the user collapsed (kept across filtering and re-renders). */
	private collapsed = new Set<string>();

	constructor(
		private view: DocumentView,
		public provider: AnnotationProvider<unknown>,
		private el: HTMLElement,
		private isActive: () => boolean,
	) {}

	get count(): number {
		return this.items.length;
	}

	/** The annotations in a sentence: "Bible references" */
	private get noun(): string {
		return this.provider.noun ?? this.provider.name.toLowerCase();
	}

	/** The layer changed: re-read it now if the tab is showing, otherwise when it's opened. */
	update(hidden: boolean): void {
		this.hidden = hidden;
		this.stale = true;
		if (this.isActive()) this.render();
	}

	render(): void {
		const reader = this.view.reader;
		if (this.stale && reader) {
			this.stale = false;
			this.items = reader.describeLayer(layerId(this.provider.id), { context: CONTEXT }).map((d) => ({
				spec: d.spec,
				annotation: d.spec.data as Annotation,
				text: d.text,
				before: d.before ?? '',
				after: d.after ?? '',
				chapter: d.tocItem?.label ?? (d.text === null ? 'Location not found' : ''),
			}));
			this.current = -1;
		}
		const el = this.el;
		el.empty();
		el.addClass('fpp-provider-panel');
		if (this.provider.color) el.style.setProperty('--fpp-provider-color', this.provider.color);
		const bar = el.createDiv('fpp-provider-toolbar');
		bar.createDiv({ cls: 'fpp-provider-name', text: this.provider.name });
		const eye = bar.createDiv({ cls: 'clickable-icon', attr: { 'aria-label': this.hidden ? `Show in the ${this.view.plugin.format.noun}` : `Hide in the ${this.view.plugin.format.noun}` } });
		setIcon(eye, this.hidden ? 'eye-off' : 'eye');
		eye.addEventListener('click', () => void this.view.plugin.setProviderHidden(this.provider.id, !this.hidden));
		this.collapseAllEl = bar.createDiv({ cls: 'clickable-icon' });
		this.collapseAllEl.addEventListener('click', () => {
			const chapters = this.groups.map((g) => g.chapter).filter(Boolean);
			const expand = chapters.every((c) => this.collapsed.has(c));
			for (const c of chapters) expand ? this.collapsed.delete(c) : this.collapsed.add(c);
			const scroll = this.listEl?.scrollTop ?? 0;
			this.renderList();
			if (this.listEl) this.listEl.scrollTop = expand ? scroll : 0;
		});

		const row = el.createDiv('fpp-search-row search-input-container');
		const input = row.createEl('input', { type: 'search', attr: { placeholder: `Filter ${this.noun}…`, spellcheck: 'false' } });
		input.value = this.filter;
		const nav = el.createDiv('fpp-search-toggles');
		this.infoEl = nav.createDiv('fpp-search-info');
		const navEl = nav.createDiv('fpp-search-nav');
		for (const [icon, label, delta] of [
			['chevron-up', 'Previous (Shift+Enter)', -1],
			['chevron-down', 'Next (Enter)', 1],
		] as const) {
			const b = navEl.createDiv({ cls: 'clickable-icon', attr: { 'aria-label': label } });
			setIcon(b, icon);
			b.addEventListener('click', () => this.step(delta));
		}
		this.listEl = el.createDiv('fpp-search-results fpp-provider-results');
		this.listEl.addEventListener(
			'scroll',
			() => {
				const l = this.listEl!;
				if (this.rendered < this.shown.length && l.scrollTop + l.clientHeight > l.scrollHeight - 400) this.renderMore(200);
			},
			{ passive: true },
		);
		input.addEventListener(
			'input',
			debounce(() => {
				this.filter = input.value;
				this.current = -1;
				this.renderList();
			}, 150, true),
		);
		input.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') {
				e.preventDefault();
				this.step(e.shiftKey ? -1 : 1);
			}
		});
		this.renderList();
	}

	private renderList(): void {
		const q = this.filter.trim().toLowerCase();
		this.shown = q ? this.items.filter((i) => i.annotation.label.toLowerCase().includes(q) || (i.text ?? '').toLowerCase().includes(q) || i.chapter.toLowerCase().includes(q)) : this.items;
		this.groups = [];
		for (let i = 0; i < this.shown.length; i++) {
			const last = this.groups[this.groups.length - 1];
			if (last && last.chapter === this.shown[i].chapter) last.end = i + 1;
			else this.groups.push({ chapter: this.shown[i].chapter, start: i, end: i + 1 });
		}
		this.listEl!.empty();
		this.rendered = 0;
		this.updateInfo();
		this.updateCollapseAll();
		if (!this.items.length) this.listEl!.createDiv({ cls: 'fpp-empty', text: `No ${this.noun} in this ${this.view.plugin.format.noun}.` });
		this.renderMore(200);
	}

	private updateInfo(): void {
		const n = this.shown.length;
		this.infoEl?.setText(this.current >= 0 ? `${this.current + 1} / ${n}` : `${n}${n === this.items.length ? '' : ` of ${this.items.length}`}`);
	}

	private updateCollapseAll(): void {
		const el = this.collapseAllEl;
		if (!el) return;
		const chapters = this.groups.map((g) => g.chapter).filter(Boolean);
		el.toggle(chapters.length > 0);
		const all = chapters.length > 0 && chapters.every((c) => this.collapsed.has(c));
		setIcon(el, all ? 'chevrons-up-down' : 'chevrons-down-up');
		el.setAttr('aria-label', all ? 'Expand all' : 'Collapse all');
	}

	private groupOf(i: number): (typeof this.groups)[number] | undefined {
		return this.groups.find((g) => i >= g.start && i < g.end);
	}

	/** Render items in document order, ~n at a time (there can be thousands); collapsed chapters are skipped. */
	private renderMore(n: number): void {
		let budget = n;
		let i = this.rendered;
		while (i < this.shown.length && budget > 0) {
			const group = this.groupOf(i)!;
			if (i === group.start) this.renderGroupHead(group);
			if (group.chapter && this.collapsed.has(group.chapter)) {
				i = group.end;
				continue;
			}
			const end = Math.min(group.end, i + budget);
			this.renderItems(group, i, end);
			budget -= end - i;
			i = end;
		}
		this.rendered = i;
	}

	private renderGroupHead(group: (typeof this.groups)[number]): void {
		const list = this.listEl!;
		if (!group.chapter) {
			group.items = list.createDiv();
			return;
		}
		const chapter = group.chapter;
		const head = list.createDiv('fpp-search-group fpp-provider-group');
		head.toggleClass('is-collapsed', this.collapsed.has(chapter));
		setIcon(head.createSpan('fpp-hl-group-chevron'), 'chevron-down');
		head.createSpan({ cls: 'fpp-provider-group-title', text: chapter });
		head.createSpan({ cls: 'fpp-hl-group-count', text: String(group.end - group.start) });
		const items = (group.items = list.createDiv('fpp-provider-group-items'));
		items.toggle(!this.collapsed.has(chapter));
		head.addEventListener('click', () => {
			const collapse = !this.collapsed.has(chapter);
			if (collapse) this.collapsed.add(chapter);
			else this.collapsed.delete(chapter);
			head.toggleClass('is-collapsed', collapse);
			items.toggle(!collapse);
			// Skipped while collapsed: render this chapter's items now.
			if (!collapse && (group.filled ?? group.start) < group.end) this.renderItems(group, group.filled ?? group.start, group.end);
			this.updateCollapseAll();
		});
	}

	private renderItems(group: (typeof this.groups)[number], start: number, end: number): void {
		const frag = document.createDocumentFragment();
		for (let i = start; i < end; i++) {
			const item = this.shown[i];
			const row = frag.createDiv('fpp-search-result fpp-provider-item');
			row.dataset.index = String(i);
			row.createSpan({ cls: 'fpp-provider-label', text: item.annotation.label });
			if (item.text === null) row.createDiv({ cls: 'fpp-provider-text', text: '(location not found)' });
			else if (item.before || item.after || item.text.toLowerCase() !== item.annotation.label.toLowerCase()) {
				// The annotated text in its sentence (or the text alone, unless it only repeats the label)
				const text = row.createDiv('fpp-provider-text');
				text.append(item.before);
				text.createEl('mark', { text: item.text.length > 160 ? `${item.text.slice(0, 160)}…` : item.text });
				text.append(item.after);
			}
			row.addEventListener('contextmenu', (e) => this.menu(e, item));
			if (!Platform.isMobile && this.provider.preview) row.addEventListener('mouseover', (e) => this.preview(e, row, item));
			row.addEventListener('click', () => this.select(i, true));
			if (i === this.current) row.addClass('is-active');
		}
		group.items!.appendChild(frag);
		group.filled = end;
	}

	/** The menu the annotation has in the document: save it as a highlight, and the provider's items. */
	private menu(e: MouseEvent, item: (typeof this.items)[number]): void {
		e.preventDefault();
		const menu = new Menu();
		this.view.addAnnotationItems(menu, [{ layer: layerId(this.provider.id), spec: item.spec }]);
		menu.showAtMouseEvent(e);
	}

	/** The provider's preview of the annotation (Obsidian's page preview), as in the document. */
	private preview(e: MouseEvent, row: HTMLElement, item: (typeof this.items)[number]): void {
		const layer = layerId(this.provider.id);
		const link = this.provider.preview?.(item.annotation, this.view.annotationContext(layer, item.annotation));
		if (!link) return;
		hoverLink(this.view.app, {
			event: e,
			source: this.view.plugin.annotationHoverSource,
			hoverParent: this.view as unknown as HoverParent,
			targetEl: row,
			linktext: link,
			sourcePath: this.view.file?.path ?? '',
			place: (popover) => placeBeside(popover, row),
		});
	}

	step(delta: number): void {
		const n = this.shown.length;
		if (!n) return;
		this.select(this.current === -1 ? (delta > 0 ? 0 : n - 1) : (this.current + delta + n) % n);
	}

	private select(i: number, fromClick = false): void {
		if (fromClick) this.view.recordJump();
		this.current = i;
		this.updateInfo();
		if (i >= this.rendered) this.renderMore(i - this.rendered + 50);
		this.listEl?.querySelector('.is-active')?.removeClass('is-active');
		// Stepping into a collapsed chapter opens it.
		const group = this.groupOf(i);
		if (group?.chapter && this.collapsed.has(group.chapter)) (group.items?.previousElementSibling as HTMLElement | null)?.click();
		const row = this.listEl?.querySelector(`[data-index="${i}"]`) as HTMLElement | null;
		row?.addClass('is-active');
		row?.scrollIntoView({ block: 'nearest' });
		this.view.navigate(this.shown[i].spec.locator, true, fromClick);
		if (fromClick && this.view.sidebarIsOverlay()) this.view.toggleSidebar(false, false);
	}
}

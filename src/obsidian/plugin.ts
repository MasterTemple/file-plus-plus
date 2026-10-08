import { formatLocator, type DocumentReader, type ReaderSettings, type SelectionInfo } from '../core';
import { MarkdownView, Notice, Platform, Plugin, TFile, WorkspaceLeaf, parseLinktext, type PaneType, type ViewState, type Workspace, type OpenViewState } from 'obsidian';
import { around } from './patch';
import { HighlightIndex, resolveFile, type HighlightEntry } from './highlight-index';
import { formatLink, linkAt, renderTemplate, setCalloutColor, setLinkColor } from './link-utils';
import { COMMENT_TEMPLATE, DEFAULT_SETTINGS, needsComment, newFormatId, syncMenus, type AnnotationMode, type AppearancePlatform, type CopyAction, type Orientation, type CopyFormat, type FppSettings, type OpenTarget } from './settings';
import { Annotations } from './annotations';
import { askForComment, confirmDeleteHighlight } from './comment-modal';
import { getComment, removeHighlight, setComment } from './comment-utils';
import { DocumentEmbed, registerEmbeds, type EmbedContext } from './embed';
import { FppSettingTab } from './setting-tab';
import { DocumentView } from './view';
import { SourceView, type SourceMode } from './source-view';
import type { FileFormat } from './format';
import type { Annotation, AnnotationProvider, FileApi } from './api';

export type CopyTarget = CopyFormat | 'link' | 'alt-link' | 'text';

/**
 * The plugin side of the library: a view for the format's files, links into them that open and
 * scroll the view, highlights from those links, copy formats, annotation files, previews and embeds,
 * and an API for other plugins. A plugin subclasses it and provides its `format`.
 */
export abstract class FilePlusPlusPlugin<Doc = unknown, R extends DocumentReader = DocumentReader> extends Plugin {
	abstract readonly format: FileFormat<Doc, R>;
	declare settings: FppSettings;
	index!: HighlightIndex;
	annotations = new Annotations(this as unknown as FilePlusPlusPlugin);
	/** Annotation providers registered by other plugins, by id. */
	readonly providers = new Map<string, AnnotationProvider<unknown>>();
	/** For other plugins: see `api.ts`. */
	api!: FileApi;
	private calloutStyle: HTMLStyleElement | null = null;
	private savePositionsTimer = 0;

	/** View type of the format's files (the plugin id). */
	get viewType(): string {
		return this.manifest.id;
	}

	/** View type of a text format's files shown as plain text (`format.plainText`). */
	get sourceViewType(): string {
		return `${this.manifest.id}-source`;
	}

	/** Page preview source for links into documents (hovering highlights). */
	get hoverSource(): string {
		return this.manifest.id;
	}

	/** Page preview source for links in the editor (plain hover). */
	get editorHoverSource(): string {
		return `${this.manifest.id}-editor`;
	}

	/** `EPUB++: …` notices. */
	notice(message: string, timeout?: number): Notice {
		return new Notice(`${this.manifest.name}: ${message}`, timeout);
	}

	/** The view for a leaf; override to use a subclass of `DocumentView`. */
	createView(leaf: WorkspaceLeaf): DocumentView<Doc, R> {
		return new DocumentView<Doc, R>(leaf, this);
	}

	/** The embed / hover preview of a link; override to use a subclass of `DocumentEmbed`. */
	createEmbed(ctx: EmbedContext, file: TFile, subpath: string): DocumentEmbed<Doc, R> {
		return new DocumentEmbed<Doc, R>(this, ctx, file, subpath);
	}

	/**
	 * Taking over other files (optional): when `file` (e.g. a video) is opened in Obsidian's own view
	 * for its type, show this document instead, or return null to let Obsidian open it. The view
	 * remembers which file was opened (`DocumentView.source`). Called for every file opened, so keep it cheap.
	 */
	documentFor(_file: TFile): TFile | null {
		return null;
	}

	/** The plugin's own settings, shown first in the settings tab (under a heading with the format's name). */
	displaySettings(_containerEl: HTMLElement, _refresh: () => void): void {}

	/** Called at the end of `onload`; plugins add their own commands, settings, events here. */
	protected async onLoaded(): Promise<void> {}

	/** The API object other plugins get; extend it with format-specific functions. */
	protected createApi(): FileApi {
		return this.baseApi();
	}

	/** Settings that differ from the library's defaults for this plugin. */
	protected defaultSettings(): FppSettings {
		const d = structuredClone(DEFAULT_SETTINGS);
		const look = this.format.appearance?.defaults;
		if (look) d.appearance = { desktop: { ...d.appearance.desktop, ...look }, mobile: { ...d.appearance.mobile, ...look } };
		return d;
	}

	override async onload(): Promise<void> {
		await this.loadSettings();
		this.index = new HighlightIndex(this.app, this.format.extensions, this.format.schemes);

		this.registerView(this.viewType, (leaf) => this.createView(leaf));
		this.registerExtensions(this.format.extensions, this.viewType);
		if (this.format.plainText) this.registerView(this.sourceViewType, (leaf) => new SourceView(leaf, this));
		this.registerHoverLinkSource(this.hoverSource, { display: `${this.manifest.name} highlights`, defaultMod: true });
		// Obsidian's own editor previews need Ctrl/Cmd; this source (toggleable under Page preview)
		// previews links in the editor on plain hover, like Reading view does.
		this.registerHoverLinkSource(this.editorHoverSource, { display: `${this.manifest.name}: ${this.format.name} links in the editor`, defaultMod: false });
		this.registerEditorHover();
		this.addSettingTab(new FppSettingTab(this.app, this as unknown as FilePlusPlusPlugin));
		this.patchLinkOpening();
		this.patchViewOpening();
		this.registerIndexEvents();
		this.registerCommands();
		this.updateCalloutStyles();
		this.registerBacklinkHover();
		this.watchOrientation();
		this.updatePreviews();
		this.api = this.createApi();
		await this.onLoaded();
		this.app.workspace.onLayoutReady(() => this.app.workspace.trigger(`${this.manifest.id}:api-ready`, this.api));
	}

	// --------------------------------------------------------------------------------------------
	// API for other plugins (annotation providers)
	// --------------------------------------------------------------------------------------------

	protected baseApi(): FileApi {
		return {
			version: 1,
			registerAnnotationProvider: (provider) => {
				const p = provider as AnnotationProvider<unknown>;
				this.providers.set(p.id, p);
				for (const v of this.views()) v.updateProvider(p);
				return () => {
					if (this.providers.get(p.id) !== p) return;
					this.providers.delete(p.id);
					for (const v of this.views()) v.removeProvider(p.id);
				};
			},
			refreshAnnotations: (providerId, paths) => {
				const p = this.providers.get(providerId);
				if (!p) return;
				for (const v of this.views()) if (v.file && (!paths || paths.includes(v.file.path))) v.updateProvider(p);
			},
			open: (file, locator) => this.openDocument(file, locator ?? ''),
			link: (file, locator, alias, sourcePath) => this.documentLink(file, locator, alias, null, sourcePath),
		};
	}

	/** Show or hide a provider's annotations in documents (the sidebar still lists them). */
	async setProviderHidden(id: string, hidden: boolean): Promise<void> {
		const set = new Set(this.settings.hiddenProviders);
		if (hidden) set.add(id);
		else set.delete(id);
		this.settings.hiddenProviders = [...set];
		await this.saveSettings();
		const p = this.providers.get(id);
		if (p) for (const v of this.views()) v.updateProvider(p);
	}

	/** What "Save as highlight" inserts: the chosen format, else the first one without a comment. */
	saveFormat(): CopyTarget {
		return this.resolveCopyAction(this.settings.saveAnnotationAs) ?? this.settings.copyFormats.find((f) => !needsComment(f.template)) ?? 'link';
	}

	/**
	 * Turn another plugin's annotation into a real highlight: insert it into the document's annotation
	 * file (created if needed), as the "save as" format or, with a comment, the comment format.
	 */
	async saveAnnotation(view: DocumentView<Doc, R>, layerId: string, annotation: Annotation, color: string | null, withComment: boolean): Promise<void> {
		const range = view.reader?.layerRange(layerId, annotation.id);
		const info = range && view.reader?.describeRange(range);
		if (!info || !view.file) {
			this.notice(`could not find this passage in the ${this.format.noun}.`);
			return;
		}
		let what: CopyTarget | null;
		let comment = '';
		if (withComment) {
			const c = await askForComment(this.app, info.text);
			if (c === null) return;
			comment = c;
			what = this.settings.copyFormats.find((f) => needsComment(f.template)) ?? { id: '', name: 'Callout with comment', template: COMMENT_TEMPLATE };
		} else what = this.saveFormat();
		if (what === 'text') what = 'link';
		const text = this.renderCopy(view, info, what, color, comment, { label: annotation.label });
		try {
			let ann = this.annotations.find(view.file);
			if (!ann) {
				ann = await this.annotations.create(view);
				new Notice(`Created ${ann.path}`);
			}
			await this.addToAnnotationFile(view, ann, info, text, false);
		} catch (e) {
			this.notice((e as Error).message);
		}
	}

	/** The format's file a link path points to, if any. */
	resolveLink(path: string, sourcePath: string): TFile | null {
		return resolveFile(this.app, path, sourcePath, this.format.extensions);
	}

	private registerEditorHover(): void {
		this.registerDomEvent(document, 'mouseover', (e) => {
			if (!this.settings.previews || e.ctrlKey || e.metaKey) return; // with a modifier Obsidian handles it
			const el = (e.target as HTMLElement | null)?.closest?.('.cm-hmd-internal-link, .cm-link, .cm-url, .cm-underline');
			if (!el || !el.closest('.markdown-source-view')) return;
			let view: MarkdownView | null = null;
			this.app.workspace.iterateAllLeaves((l) => {
				if (!view && l.view instanceof MarkdownView && l.view.containerEl.contains(el)) view = l.view;
			});
			const mdView = view as MarkdownView | null;
			const cm = (mdView?.editor as any)?.cm;
			if (!mdView?.file || !cm?.posAtDOM) return;
			let linktext: string | null = null;
			try {
				const pos = cm.posAtDOM(el, 0);
				const line = cm.state.doc.lineAt(pos);
				linktext = linkAt(line.text, pos - line.from + 1);
			} catch {
				return;
			}
			if (!linktext) return;
			const { path } = parseLinktext(linktext);
			if (!this.resolveLink(path, mdView.file.path)) return;
			this.app.workspace.trigger('hover-link', {
				event: e,
				source: this.editorHoverSource,
				hoverParent: mdView,
				targetEl: el,
				linktext,
				sourcePath: mdView.file.path,
			});
		});
	}

	/** Register or unregister the embed (used by `![[file#…]]` and link hover previews). */
	updatePreviews(): void {
		this.unregisterEmbeds?.();
		this.unregisterEmbeds = this.settings.previews ? registerEmbeds(this as unknown as FilePlusPlusPlugin) : null;
	}
	private unregisterEmbeds: (() => void) | null = null;

	/** Flash options for jumps, from settings (null when disabled). */
	jumpFlash(): { duration: number; color: string } | false {
		const s = this.settings;
		return s.jumpHighlight ? { duration: s.jumpHighlightDuration, color: s.jumpHighlightColor } : false;
	}

	// --------------------------------------------------------------------------------------------
	// Document cache (previews open the same documents repeatedly)
	// --------------------------------------------------------------------------------------------

	private documents = new Map<string, { mtime: number; doc: Promise<Doc> }>();

	getDocument(file: TFile): Promise<Doc> {
		const hit = this.documents.get(file.path);
		if (hit && hit.mtime === file.stat.mtime) {
			// refresh LRU order
			this.documents.delete(file.path);
			this.documents.set(file.path, hit);
			return hit.doc;
		}
		const doc = this.format.load(this.app, file);
		this.documents.set(file.path, { mtime: file.stat.mtime, doc });
		while (this.documents.size > 3) {
			const [oldest, entry] = this.documents.entries().next().value!;
			this.documents.delete(oldest);
			// Let previews that still use it finish; blob URLs are revoked a bit later.
			entry.doc.then((d) => window.setTimeout(() => this.format.unload(d), 60_000)).catch(() => {});
		}
		doc.catch(() => this.documents.delete(file.path));
		return doc;
	}

	override onunload(): void {
		this.app.workspace.trigger(`${this.manifest.id}:api-unload`);
		this.providers.clear();
		this.calloutStyle?.remove();
		this.unregisterEmbeds?.();
		for (const { doc } of this.documents.values()) doc.then((d) => this.format.unload(d)).catch(() => {});
	}

	// --------------------------------------------------------------------------------------------
	// Settings
	// --------------------------------------------------------------------------------------------

	/** Migrate settings saved by older versions (`data`: what was loaded). Called before the shared migrations. */
	protected migrateSettings(_data: Record<string, any>): void {}

	async loadSettings(): Promise<void> {
		const data = (await this.loadData()) ?? {};
		const defaults = this.defaultSettings();
		// Before v3 one `reader` object served every platform: it becomes both platforms' appearance.
		const appearance = (p: AppearancePlatform) => ({ ...defaults.appearance[p], ...(data.appearance?.[p] ?? data.reader ?? {}) });
		this.settings = { ...defaults, ...data, appearance: { desktop: appearance('desktop'), mobile: appearance('mobile') } };
		delete (this.settings as { reader?: unknown }).reader;
		this.migrateSettings(data);
		// Formats saved before format ids existed.
		for (const f of this.settings.copyFormats) f.id ||= newFormatId();
		const version = data.settingsVersion ?? 1;
		if (version < 2) {
			// v2 added the comment callout format; offer it to existing setups once.
			if (!this.settings.copyFormats.some((f) => needsComment(f.template)))
				this.settings.copyFormats.splice(1, 0, { id: 'callout-comment', name: 'Callout with comment', template: COMMENT_TEMPLATE });
		}
		// v4: link types are the format's own (`primary`) or text fragments.
		if (this.settings.linkType !== 'text') this.settings.linkType = 'primary';
		this.settings.settingsVersion = DEFAULT_SETTINGS.settingsVersion;
		syncMenus(this.settings);
		this.registerDevice();
	}

	/** data.json changed on disk (e.g. synced from another device): reload so saving doesn't undo that. */
	override async onExternalSettingsChange(): Promise<void> {
		await this.loadSettings();
		this.applyReaderSettings();
		this.refreshPalette();
		for (const v of this.views()) v.onAppearanceChanged();
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	/** This device's id, kept in Obsidian's local storage (per vault and device; not synced). */
	deviceId = '';

	private registerDevice(): void {
		const key = `${this.manifest.id}-device`;
		let id = this.app.loadLocalStorage(key) as string | null;
		if (!id) {
			id = newFormatId();
			this.app.saveLocalStorage(key, id);
		}
		this.deviceId = id;
		if (!this.settings.devices[id]) {
			this.settings.devices[id] = { name: defaultDeviceName(), platform: this.platform };
			void this.saveSettings();
		}
	}

	/** Desktop or mobile: where this device's appearance started from. */
	get platform(): AppearancePlatform {
		return Platform.isMobile ? 'mobile' : 'desktop';
	}

	/** The window's shape now. */
	get orientation(): Orientation {
		return window.innerHeight > window.innerWidth ? 'portrait' : 'landscape';
	}

	/** Which appearance applies: a device (default: this one) in an orientation (default: the current one). */
	appearanceKey(device = this.deviceId, orientation = this.orientation): string {
		return `${device}:${orientation}`;
	}

	private platformOfKey(key: string): AppearancePlatform {
		return this.settings.devices[key.split(':')[0]]?.platform ?? this.platform;
	}

	/** All documents' appearance for a device and orientation; until changed there, the platform's. */
	allBooksAppearance(key = this.appearanceKey()): ReaderSettings {
		return this.settings.deviceAppearance[key] ?? this.settings.appearance[this.platformOfKey(key)];
	}

	/** A document's own appearance settings (only those that differ from all documents). */
	bookAppearance(path: string, key = this.appearanceKey()): Partial<ReaderSettings> {
		const book = this.settings.bookAppearance[path];
		// Settings saved per platform (before devices) apply until changed on a device.
		return book?.[key] ?? book?.[this.platformOfKey(key)] ?? {};
	}

	/** Effective appearance: all documents' settings, then the document's own. */
	readerSettings(path?: string, key = this.appearanceKey()): ReaderSettings {
		return { ...this.allBooksAppearance(key), ...(path ? this.bookAppearance(path, key) : {}) };
	}

	/**
	 * Change appearance for all documents (no `path`) or for one, for a device and orientation
	 * (default: this device, now). Applies live to open views and persists.
	 */
	async updateReaderSettings(patch: Partial<ReaderSettings>, scope: { path?: string; key?: string } = {}): Promise<void> {
		const key = scope.key ?? this.appearanceKey();
		if (scope.path) {
			const own = this.bookAppearance(scope.path, key);
			(this.settings.bookAppearance[scope.path] ??= {})[key] = { ...own, ...patch };
		} else {
			this.settings.deviceAppearance[key] = { ...this.allBooksAppearance(key), ...patch };
		}
		this.applyReaderSettings();
		await this.saveSettings();
	}

	/**
	 * Change appearance the way the document is set up: settings it overrides change for it, the rest
	 * for all documents (font size / theme commands).
	 */
	async updateReaderSettingsFor(path: string | undefined, patch: Partial<ReaderSettings>): Promise<void> {
		const own = path ? this.bookAppearance(path) : {};
		const entries = Object.entries(patch) as [keyof ReaderSettings, unknown][];
		const book = Object.fromEntries(entries.filter(([k]) => k in own));
		const all = Object.fromEntries(entries.filter(([k]) => !(k in own)));
		if (path && Object.keys(book).length) await this.updateReaderSettings(book, { path });
		if (Object.keys(all).length) await this.updateReaderSettings(all);
	}

	/** Drop a document's own appearance for a device and orientation (or everywhere). */
	async resetBookAppearance(path: string, key?: string): Promise<void> {
		const book = this.settings.bookAppearance[path];
		if (!book) return;
		if (key) {
			delete book[key];
			// A legacy per-platform entry would apply again: mark this key as "no own settings".
			if (book[this.platformOfKey(key)]) book[key] = {};
		}
		if (!key || !Object.values(book).some((b) => Object.keys(b).length)) delete this.settings.bookAppearance[path];
		this.applyReaderSettings();
		await this.saveSettings();
	}

	/** Forget another device and its appearance. */
	async forgetDevice(id: string): Promise<void> {
		if (id === this.deviceId) return;
		delete this.settings.devices[id];
		for (const k of Object.keys(this.settings.deviceAppearance)) if (k.startsWith(`${id}:`)) delete this.settings.deviceAppearance[k];
		for (const book of Object.values(this.settings.bookAppearance)) for (const k of Object.keys(book)) if (k.startsWith(`${id}:`)) delete book[k];
		await this.saveSettings();
	}

	private lastOrientation: Orientation | null = null;

	/** Rotating the phone or reshaping the window switches between horizontal and vertical appearance. */
	private watchOrientation(): void {
		this.lastOrientation = this.orientation;
		this.registerDomEvent(window, 'resize', () => {
			const now = this.orientation;
			if (now === this.lastOrientation) return;
			this.lastOrientation = now;
			this.applyReaderSettings();
			for (const v of this.views()) v.onAppearanceChanged();
		});
	}

	private applyReaderSettings(): void {
		for (const v of this.views()) v.reader?.updateSettings(this.readerSettings(v.file?.path));
	}

	/** Re-apply palette/opacity to views and callout CSS. */
	refreshPalette(): void {
		this.updateCalloutStyles();
		for (const v of this.views()) v.applyPalette();
	}

	savePosition(path: string, locator: string): void {
		this.settings.positions[path] = locator;
		window.clearTimeout(this.savePositionsTimer);
		this.savePositionsTimer = window.setTimeout(() => this.saveSettings(), 2000);
	}

	paletteRecord(): Record<string, string> {
		return Object.fromEntries(this.settings.palette.map((p) => [p.name, p.color]));
	}

	/** The open (loaded) views of this plugin. */
	views(): DocumentView<Doc, R>[] {
		return this.app.workspace
			.getLeavesOfType(this.viewType)
			.map((l) => l.view)
			.filter((v): v is DocumentView<Doc, R> => v instanceof DocumentView);
	}

	/** The active view of this plugin, if any. */
	activeView(): DocumentView<Doc, R> | null {
		const v = this.app.workspace.getActiveViewOfType(DocumentView);
		return v && v.plugin === (this as unknown) ? (v as DocumentView<Doc, R>) : null;
	}

	/**
	 * Switch a leaf between the rendered view of its file and the plain text (`SourceView`, read or
	 * edited: `mode`), in the same tab.
	 */
	async toggleSource(leaf: WorkspaceLeaf, mode: SourceMode = 'read'): Promise<void> {
		const state = leaf.getViewState();
		const file = (state.state as { file?: string } | undefined)?.file;
		if (!file || !this.format.plainText) return;
		if (state.type === this.sourceViewType) await leaf.setViewState({ type: this.viewType, state: { file }, active: true });
		else await leaf.setViewState({ type: this.sourceViewType, state: { file, mode }, active: true });
	}

	private updateCalloutStyles(): void {
		this.calloutStyle ??= document.head.createEl('style', { attr: { id: `${this.manifest.id}-callouts` } });
		this.calloutStyle.textContent = this.settings.palette
			.map((p) => {
				const rgb = toRgb(p.color);
				return rgb ? `.callout[data-callout-metadata="${CSS.escape(p.name)}"] { --callout-color: rgb(${rgb}); }` : '';
			})
			.join('\n');
	}

	// --------------------------------------------------------------------------------------------
	// Highlight index
	// --------------------------------------------------------------------------------------------

	private registerIndexEvents(): void {
		const { metadataCache, vault, workspace } = this.app;
		workspace.onLayoutReady(() => {
			const ready = () => this.index.rebuild();
			// resolvedLinks is only complete after the initial resolve pass.
			if ((metadataCache as any).initialized === false) this.registerEvent(metadataCache.on('resolved', ready));
			ready();
		});
		this.registerEvent(metadataCache.on('changed', (file) => file.extension === 'md' && this.index.indexFile(file)));
		this.registerEvent(metadataCache.on('deleted', (file) => this.index.removeSource(file.path, true)));
		// A document changed (edited as plain text, synced): re-render its open views.
		const reloadTimers = new Map<string, number>();
		this.registerEvent(
			vault.on('modify', (file) => {
				if (!(file instanceof TFile) || !this.format.extensions.includes(file.extension.toLowerCase())) return;
				window.clearTimeout(reloadTimers.get(file.path));
				reloadTimers.set(
					file.path,
					window.setTimeout(() => {
						reloadTimers.delete(file.path);
						for (const v of this.views()) if (v.file === file) void v.reload();
					}, 500),
				);
			}),
		);
		let rebuildTimer = 0;
		this.registerEvent(
			vault.on('rename', (file, oldPath) => {
				if (!(file instanceof TFile)) return;
				if (file.extension === 'md') {
					this.index.removeSource(oldPath, true);
					this.index.indexFile(file);
				} else if (this.format.extensions.includes(file.extension.toLowerCase())) {
					const look = this.settings.bookAppearance[oldPath];
					if (look) {
						delete this.settings.bookAppearance[oldPath];
						this.settings.bookAppearance[file.path] = look;
					}
					const pos = this.settings.positions[oldPath];
					if (pos) {
						delete this.settings.positions[oldPath];
						this.savePosition(file.path, pos);
					} else if (look) this.saveSettings();
					window.clearTimeout(rebuildTimer);
					rebuildTimer = window.setTimeout(() => this.index.rebuild(), 1000);
				}
			}),
		);
	}

	// --------------------------------------------------------------------------------------------
	// Link opening
	// --------------------------------------------------------------------------------------------

	/**
	 * Intercept link opening so links into the format's files (wiki or markdown, with a locator) reuse
	 * an existing tab and scroll it instead of reopening the file, and open in a split by default.
	 */
	private patchLinkOpening(): void {
		const plugin = this;
		this.register(
			around(this.app.workspace, {
				openLinkText(old) {
					return async function (this: Workspace, linktext: string, sourcePath: string, newLeaf?: PaneType | boolean, state?: OpenViewState) {
						try {
							const { path, subpath } = parseLinktext(linktext);
							const file = path ? plugin.resolveLink(path, sourcePath) : null;
							if (file) return await plugin.openDocument(file, subpath, newLeaf, state);
						} catch (e) {
							console.error('[fpp] link interception failed', e);
						}
						return old.call(this, linktext, sourcePath, newLeaf, state);
					};
				},
			}),
		);
	}

	/** Every way of opening a file in a tab ends in `setViewState`: there, files `documentFor` takes over open the document. */
	private patchViewOpening(): void {
		const plugin = this;
		this.register(
			around(WorkspaceLeaf.prototype, {
				setViewState(old) {
					return function (this: WorkspaceLeaf, viewState: ViewState, eState?: unknown) {
						let state = viewState;
						try {
							state = plugin.takeOver(viewState) ?? viewState;
						} catch (e) {
							console.error('[fpp] take over failed', e);
						}
						return old.call(this, state, eState);
					};
				},
			}),
		);
	}

	/**
	 * The view state showing the document `documentFor` gives for the file of `viewState`, when that is
	 * opened in Obsidian's default view for its type (not another plugin's, nor with `takeOver: false`).
	 */
	private takeOver(viewState: ViewState): ViewState | null {
		const state = viewState.state as { file?: unknown; takeOver?: unknown } | undefined;
		if (typeof state?.file !== 'string' || state.takeOver === false) return null;
		if (viewState.type === this.viewType || viewState.type === this.sourceViewType) return null;
		const file = this.app.vault.getFileByPath(state.file);
		const ext = file?.extension.toLowerCase();
		if (!file || this.format.extensions.includes(ext!)) return null;
		const own = this.defaultViewType(ext!);
		if (own && own !== viewState.type) return null;
		const doc = this.documentFor(file);
		if (!doc) return null;
		return { ...viewState, type: this.viewType, state: { file: doc.path, source: file.path } };
	}

	/** The view type Obsidian opens files with this extension in (private API; undefined if unknown). */
	private defaultViewType(ext: string): string | undefined {
		const registry = (this.app as unknown as { viewRegistry?: { getTypeByExtension?(ext: string): string | undefined } }).viewRegistry;
		return registry?.getTypeByExtension?.(ext);
	}

	/** Open a file in Obsidian's own view for it, even when `documentFor` would take it over. */
	async openUntakenOver(leaf: WorkspaceLeaf, file: TFile): Promise<void> {
		const type = this.defaultViewType(file.extension.toLowerCase());
		if (!type) return leaf.openFile(file, { active: true });
		await leaf.setViewState({ type, state: { file: file.path, takeOver: false }, active: true });
	}

	async openDocument(file: TFile, subpath: string, newLeaf?: PaneType | boolean, state?: OpenViewState): Promise<void> {
		const { workspace } = this.app;
		if (!newLeaf) {
			const existing = this.findLeaf(file);
			if (existing) {
				// Switch to that tab in its own pane (loading it if it was a background tab).
				await workspace.revealLeaf(existing);
				await (existing as WorkspaceLeaf & { loadIfDeferred?: () => Promise<void> }).loadIfDeferred?.();
				if (existing.view instanceof DocumentView) {
					if (subpath) existing.view.navigate(subpath);
				} else await existing.openFile(file, { eState: { subpath: subpath || undefined } });
				return;
			}
		}
		let leaf: WorkspaceLeaf;
		if (newLeaf) leaf = workspace.getLeaf(newLeaf);
		else leaf = this.leafFor(this.settings.openIn, () => workspace.getActiveViewOfType(MarkdownView) !== null);
		await leaf.openFile(file, { ...state, active: true, eState: { ...(state?.eState ?? {}), subpath: subpath || undefined } });
	}

	/**
	 * A tab showing this document. With "reuse panes" this includes background tabs Obsidian hasn't
	 * loaded yet (deferred views); otherwise only loaded views count.
	 */
	private findLeaf(file: TFile): WorkspaceLeaf | null {
		const loaded = this.views().find((v) => v.file?.path === file.path);
		if (loaded) return loaded.leaf;
		if (!this.settings.reusePanes) return null;
		return this.app.workspace.getLeavesOfType(this.viewType).find((l) => (l.getViewState().state as { file?: string } | undefined)?.file === file.path) ?? null;
	}

	/** Pick a leaf according to a setting. */
	private leafFor(target: OpenTarget, preferSplit: () => boolean): WorkspaceLeaf {
		const { workspace } = this.app;
		if (target === 'current' || Platform.isPhone) return workspace.getLeaf(false);
		if (target === 'tab') return workspace.getLeaf('tab');
		if (!preferSplit()) return workspace.getLeaf(false);
		if (this.settings.reusePanes) {
			// Another pane already exists: open a new tab there instead of splitting again.
			const pane = this.otherPane();
			if (pane) return workspace.createLeafInParent(pane as any, (pane as any).children?.length ?? 0);
		}
		return workspace.getLeaf('split', 'vertical');
	}

	/** A tab group in the main area other than the active one, preferring one that holds our views. */
	private otherPane(): unknown | null {
		const { workspace } = this.app;
		// The pane of the note the link was clicked in.
		const active = (workspace.getActiveViewOfType(MarkdownView)?.leaf ?? workspace.getMostRecentLeaf())?.parent;
		const panes: { pane: unknown; ours: boolean }[] = [];
		workspace.iterateRootLeaves((l) => {
			if (!l.parent || l.parent === active) return;
			const found = panes.find((p) => p.pane === l.parent);
			const ours = l.view.getViewType() === this.viewType;
			if (found) found.ours ||= ours;
			else panes.push({ pane: l.parent, ours });
		});
		return (panes.find((p) => p.ours) ?? panes[0])?.pane ?? null;
	}

	// --------------------------------------------------------------------------------------------
	// Highlight actions
	// --------------------------------------------------------------------------------------------

	/** Open the note containing a highlight's link, at the link's line. */
	async openSource(entry: HighlightEntry, fromView?: DocumentView<Doc, R>): Promise<void> {
		const file = this.app.vault.getFileByPath(entry.sourcePath);
		if (!file) return;
		const { workspace } = this.app;
		const eState = { line: entry.position.start.line };
		let leaf = workspace.getLeavesOfType('markdown').find((l) => (l.view as MarkdownView).file?.path === file.path) ?? null;
		if (leaf) {
			await workspace.revealLeaf(leaf);
			workspace.setActiveLeaf(leaf, { focus: true });
			leaf.setEphemeralState(eState);
		} else {
			const target = this.settings.openNoteIn;
			if (target === 'current' || Platform.isPhone || !fromView) leaf = workspace.getLeaf(Platform.isPhone ? false : 'tab');
			else if (target === 'tab') leaf = workspace.getLeaf('tab');
			else {
				// Prefer an existing markdown leaf in another split over creating a new one.
				const other = workspace.getLeavesOfType('markdown').find((l) => l.getRoot() === fromView.leaf.getRoot() && l.parent !== fromView.leaf.parent);
				leaf = other ?? workspace.createLeafBySplit(fromView.leaf, 'vertical');
			}
			await leaf.openFile(file, { active: true, eState });
		}
		const view = leaf.view;
		if (view instanceof MarkdownView) {
			const from = view.editor.offsetToPos(entry.position.start.offset);
			const to = view.editor.offsetToPos(entry.position.end.offset);
			if (view.getMode() === 'source') {
				view.editor.setSelection(from, to);
				view.editor.scrollIntoView({ from, to }, true);
			}
		}
	}

	/** Add, change or (with '') remove the comment of a highlight in its note. */
	async setHighlightComment(entry: HighlightEntry, comment: string): Promise<void> {
		const file = this.app.vault.getFileByPath(entry.sourcePath);
		if (!file) return;
		let failed = false;
		await this.app.vault.process(file, (data) => {
			let start = entry.position.start.offset;
			if (data.slice(start, entry.position.end.offset) !== entry.original) {
				start = data.indexOf(entry.original);
				if (start === -1) {
					failed = true;
					return data;
				}
			}
			const line = data.slice(0, start).split('\n').length - 1;
			return setComment(data.split('\n'), line, comment, entry.color ?? null).join('\n');
		});
		if (failed) this.notice('could not find the link in the note (it may have changed).');
	}

	/**
	 * Delete a highlight: its link (with the callout around it, and its comment) from the note.
	 * Asks first when it has a comment, unless `force`.
	 */
	async deleteHighlight(entry: HighlightEntry, force = false): Promise<void> {
		const file = this.app.vault.getFileByPath(entry.sourcePath);
		if (!file) return;
		const data = await this.app.vault.read(file);
		const at = findLink(data, entry);
		if (at === -1) return void this.notice('could not find the link in the note (it may have changed).');
		const comment = getComment(data.split('\n'), data.slice(0, at).split('\n').length - 1);
		if (comment && !force && !(await confirmDeleteHighlight(this.app, comment))) return;
		let failed = false;
		await this.app.vault.process(file, (d) => {
			const start = findLink(d, entry);
			if (start === -1) {
				failed = true;
				return d;
			}
			return removeHighlight(d, start, start + entry.original.length);
		});
		if (failed) this.notice('could not find the link in the note (it may have changed).');
	}

	/** Rewrite the `&color=` parameter (and enclosing callout color) of a highlight's link in its note. */
	async setHighlightColor(entry: HighlightEntry, color: string | null): Promise<void> {
		const file = this.app.vault.getFileByPath(entry.sourcePath);
		if (!file) return;
		let failed = false;
		await this.app.vault.process(file, (data) => {
			let start = entry.position.start.offset;
			let end = entry.position.end.offset;
			if (data.slice(start, end) !== entry.original) {
				start = data.indexOf(entry.original);
				if (start === -1) {
					failed = true;
					return data;
				}
				end = start + entry.original.length;
			}
			const updated = setLinkColor(entry.original, color);
			const next = data.slice(0, start) + updated + data.slice(end);
			const lineNo = next.slice(0, start).split('\n').length - 1;
			return setCalloutColor(next.split('\n'), lineNo, color).join('\n');
		});
		if (failed) this.notice('could not find the link in the note (it may have changed).');
	}

	// --------------------------------------------------------------------------------------------
	// Copying
	// --------------------------------------------------------------------------------------------

	linkStyle(): 'wiki' | 'markdown' {
		const s = this.settings.linkStyle;
		if (s !== 'auto') return s;
		return (this.app.vault as any).getConfig?.('useMarkdownLinks') ? 'markdown' : 'wiki';
	}

	/** Build a link to a selection. `alternate` swaps the configured link type (the format's ↔ text fragment). */
	buildLink(view: DocumentView<Doc, R>, info: SelectionInfo, color: string | null, alternate = false, extra: Record<string, string> = {}): string {
		const useText = (this.settings.linkType === 'text') !== alternate;
		const locator = (useText && info.textFragment()) || info.locator;
		const alias = renderTemplate(this.settings.aliasTemplate, { ...this.templateVars(view, info, color, ''), ...extra });
		return this.documentLink(view.file!, locator, alias, this.settings.colorInLinks ? color : null);
	}

	/** A link (wiki or markdown, per settings) to a locator in a document. */
	documentLink(file: TFile, locator: string, alias: string, color: string | null = null, sourcePath?: string): string {
		const subpath = formatLocator(locator, { color: color ?? undefined });
		const from = sourcePath ?? this.app.workspace.getActiveViewOfType(MarkdownView)?.file?.path ?? this.lastMarkdownPath() ?? '';
		const linktext = this.app.metadataCache.fileToLinktext(file, from, false);
		return formatLink(linktext, subpath, alias, this.linkStyle());
	}

	private lastMarkdownPath(): string | null {
		const leaf = this.app.workspace.getMostRecentLeaf();
		return leaf?.view instanceof MarkdownView ? (leaf.view.file?.path ?? null) : null;
	}

	/** The selection's text as copied: Markdown converted from the document's HTML, or plain text. */
	selectionText(info: SelectionInfo): string {
		if (!this.settings.copyMarkdown) return info.text;
		try {
			return info.markdown() || info.text;
		} catch (e) {
			console.warn('[fpp] markdown conversion failed', e);
			return info.text;
		}
	}

	templateVars(view: DocumentView<Doc, R>, info: SelectionInfo, color: string | null, link: string): Record<string, string> {
		const doc = view.document;
		const meta = doc && view.file ? this.format.info(doc, view.file) : null;
		const title = meta?.title || view.file?.basename || '';
		return {
			text: this.selectionText(info),
			link,
			color: color ?? '',
			title,
			book: title,
			author: meta?.author ?? '',
			chapter: info.tocItem?.label ?? '',
			locator: info.locator,
			file: view.file?.basename ?? '',
			path: view.file?.path ?? '',
			...this.format.templateVars?.(info, doc),
		};
	}

	/** Resolve a copy action (`text`, `link`, `alt-link`, `format:<id>`) to what it copies. */
	resolveCopyAction(action: CopyAction): CopyTarget | null {
		if (action === 'text' || action === 'link' || action === 'alt-link') return action;
		const id = action.slice('format:'.length);
		return this.settings.copyFormats.find((f) => f.id === id) ?? null;
	}

	/**
	 * The clipboard text for a selection (synchronous, so it can run inside a `copy` event).
	 * `extra`: more template variables, e.g. `{{label}}` when saving another plugin's annotation.
	 */
	renderCopy(view: DocumentView<Doc, R>, info: SelectionInfo, what: CopyTarget, color: string | null, comment = '', extra: Record<string, string> = {}): string {
		if (what === 'text') return this.selectionText(info);
		const link = this.buildLink(view, info, color, what === 'alt-link', extra);
		return typeof what === 'string' ? link : renderTemplate(what.template, { ...this.templateVars(view, info, color, link), ...extra, comment });
	}

	/** True when copying with this target first asks for a comment ({{comment}} in the template). */
	asksForComment(what: CopyTarget): boolean {
		return typeof what === 'object' && needsComment(what.template);
	}

	copyLabel(what: CopyTarget): string {
		if (what === 'text') return 'text';
		if (what === 'link') return 'link';
		if (what === 'alt-link') return this.settings.linkType === 'primary' ? 'text-fragment link' : `${this.format.linkTypeName} link`;
		return what.name.toLowerCase();
	}

	/**
	 * Copy (and/or insert into the annotation file, per its mode; `copyOnly` never inserts).
	 * `newFileMode`: for a document without an annotation file, Insert / Both create one first.
	 */
	async copy(view: DocumentView<Doc, R>, info: SelectionInfo, what: CopyTarget, color: string | null, copyOnly = false, newFileMode?: AnnotationMode): Promise<void> {
		let comment = '';
		if (this.asksForComment(what)) {
			const c = await askForComment(this.app, info.text);
			if (c === null) return;
			comment = c;
		}
		const text = this.renderCopy(view, info, what, color, comment);
		const inserts = what !== 'text' && !copyOnly && !!view.file;
		let ann = inserts ? this.annotations.find(view.file!) : null;
		let mode: AnnotationMode = ann ? this.annotations.mode(ann) : 'copy';
		if (inserts && !ann && newFileMode && newFileMode !== 'copy') {
			try {
				ann = await this.annotations.create(view);
				await this.annotations.setMode(ann, newFileMode);
				new Notice(`Created ${ann.path}`);
				mode = newFileMode;
			} catch (e) {
				this.notice((e as Error).message);
				return;
			}
		}
		if (mode !== 'insert') await navigator.clipboard.writeText(text);
		if (ann && mode !== 'copy') await this.addToAnnotationFile(view, ann, info, text, mode === 'both');
		else new Notice(`Copied ${this.copyLabel(what)} to clipboard`);
	}

	async addToAnnotationFile(view: DocumentView<Doc, R>, ann: TFile, info: SelectionInfo, text: string, copied: boolean): Promise<void> {
		try {
			const p = await this.annotations.insert(view, ann, info, text);
			const where = `${ann.basename}${p.heading ? ` › ${p.heading}` : ''}`;
			new Notice(`${copied ? 'Copied and added' : 'Added'} to ${where}${p.appended ? ' (at the end of the section)' : ''}`);
		} catch (e) {
			console.error('[fpp] could not add to annotation file', e);
			this.notice(`could not add to ${ann.basename}: ${(e as Error).message}`);
		}
	}

	/** Open (or reveal) a note, preferring another split than the document's. */
	async openNote(file: TFile, fromView?: DocumentView<Doc, R>): Promise<void> {
		const { workspace } = this.app;
		const open = workspace.getLeavesOfType('markdown').find((l) => (l.view as MarkdownView).file?.path === file.path);
		if (open) {
			await workspace.revealLeaf(open);
			workspace.setActiveLeaf(open, { focus: true });
			return;
		}
		const other = fromView && workspace.getLeavesOfType('markdown').find((l) => l.getRoot() === fromView.leaf.getRoot() && l.parent !== fromView.leaf.parent);
		const leaf = Platform.isPhone || !fromView ? workspace.getLeaf('tab') : (other ?? workspace.createLeafBySplit(fromView.leaf, 'vertical'));
		await leaf.openFile(file, { active: true });
	}

	/** Create (if needed) and open the annotation file of the document in `view`. */
	async openAnnotationFile(view: DocumentView<Doc, R>): Promise<void> {
		if (!view.file) return;
		const existed = this.annotations.find(view.file);
		try {
			const file = existed ?? (await this.annotations.create(view));
			if (!existed) {
				new Notice(`Created ${file.path}`);
				view.refreshHighlights();
			}
			await this.openNote(file, view);
		} catch (e) {
			this.notice((e as Error).message);
		}
	}

	// --------------------------------------------------------------------------------------------
	// Commands
	// --------------------------------------------------------------------------------------------

	/** A command callback that runs only while one of this plugin's views (with a reader) is active. */
	protected withView(fn: (v: DocumentView<Doc, R>) => void): (checking: boolean) => boolean {
		return (checking) => {
			const v = this.activeView();
			if (!v?.reader) return false;
			if (!checking) fn(v);
			return true;
		};
	}

	private registerCommands(): void {
		const withView = (fn: (v: DocumentView<Doc, R>) => void) => this.withView(fn);
		const name = this.format.name;
		this.addCommand({ id: 'toggle-sidebar', name: 'Toggle table of contents / search sidebar', checkCallback: withView((v) => v.toggleSidebar()) });
		this.addCommand({ id: 'search', name: `Search in ${name}`, checkCallback: withView((v) => v.openSearch()) });
		this.addCommand({ id: 'annotation-file', name: 'Open or create annotation file', checkCallback: withView((v) => this.openAnnotationFile(v)) });
		if (this.format.plainText)
			this.addCommand({
				id: 'toggle-source',
				name: `Toggle plain text / ${this.format.noun} view`,
				checkCallback: (checking) => {
					const { workspace } = this.app;
					const v = workspace.getActiveViewOfType(SourceView) ?? workspace.getActiveViewOfType(DocumentView);
					if (!v?.file || v.plugin !== (this as unknown)) return false;
					if (!checking) void this.toggleSource(v.leaf);
					return true;
				},
			});
		if (this.format.plainText)
			this.addCommand({
				id: 'edit-source',
				name: 'Toggle reading / editing as plain text',
				checkCallback: (checking) => {
					const { workspace } = this.app;
					const v = workspace.getActiveViewOfType(SourceView) ?? workspace.getActiveViewOfType(DocumentView);
					if (!v?.file || v.plugin !== (this as unknown)) return false;
					if (!checking) void (v instanceof SourceView ? v.toggleMode() : this.toggleSource(v.leaf, 'edit'));
					return true;
				},
			});
		this.addCommand({ id: 'appearance', name: 'Reading appearance', checkCallback: withView((v) => v.toggleAppearance()) });
		this.addCommand({ id: 'font-increase', name: 'Increase font size', checkCallback: withView((v) => this.updateReaderSettingsFor(v.file?.path, { fontSize: Math.min(48, this.readerSettings(v.file?.path).fontSize + 1) })) });
		this.addCommand({ id: 'font-decrease', name: 'Decrease font size', checkCallback: withView((v) => this.updateReaderSettingsFor(v.file?.path, { fontSize: Math.max(8, this.readerSettings(v.file?.path).fontSize - 1) })) });
		this.addCommand({
			id: 'cycle-theme',
			name: 'Cycle theme',
			checkCallback: withView((v) => {
				const order = (['auto', 'light', 'sepia', 'dark', 'publisher'] as const).filter((t) => t !== 'publisher' || this.format.appearance?.publisherName !== null);
				const i = order.indexOf(this.readerSettings(v.file?.path).theme);
				this.updateReaderSettingsFor(v.file?.path, { theme: order[(i + 1) % order.length] });
			}),
		});
		const copyCommand = (id: string, title: string, target: () => CopyTarget | null) =>
			this.addCommand({
				id,
				name: title,
				checkCallback: (checking) => {
					const v = this.activeView();
					const sel = v?.reader?.getSelection();
					const what = target();
					if (!v || !sel || !what) return false;
					if (!checking) this.copy(v, sel, what, v.activeColor);
					return true;
				},
			});
		copyCommand('copy-text', 'Copy selection as text', () => 'text');
		copyCommand('copy-link', 'Copy link to selection', () => 'link');
		copyCommand('copy-alt-link', `Copy alternate link to selection (${this.format.linkTypeName} ↔ text fragment)`, () => 'alt-link');
		this.syncFormatCommands = () => {
			const commands = (this.app as any).commands;
			for (const id of this.formatCommandIds) commands?.removeCommand?.(`${this.manifest.id}:${id}`);
			this.formatCommandIds = [];
			for (const fmt of this.settings.copyFormats) {
				const id = `copy-format-${fmt.id}`;
				copyCommand(id, `Copy selection as ${fmt.name.toLowerCase()}`, () => this.settings.copyFormats.find((f) => f.id === fmt.id) ?? null);
				this.formatCommandIds.push(id);
			}
		};
		this.syncFormatCommands();
	}

	/** Re-register the per-format copy commands (after formats are added, renamed or removed). Hotkeys are kept by id. */
	syncFormatCommands: () => void = () => {};
	private formatCommandIds: string[] = [];

	// --------------------------------------------------------------------------------------------
	// Backlinks pane integration
	// --------------------------------------------------------------------------------------------

	/**
	 * Hovering a match in Obsidian's Backlinks pane emphasizes the corresponding highlight in the
	 * document (like PDF++). Best-effort: matches by source file name and link text.
	 */
	private registerBacklinkHover(): void {
		let lastIds = '';
		this.registerDomEvent(document, 'mouseover', (e) => {
			const target = e.target as HTMLElement | null;
			const match = target?.closest?.('.workspace-leaf-content[data-type="backlink"] .search-result-file-match, .embedded-backlinks .search-result-file-match');
			const view = this.activeView() ?? this.views()[0];
			if (!view?.reader || !view.file) return;
			if (!match) {
				if (lastIds) view.reader.setHoveredHighlights([]);
				lastIds = '';
				return;
			}
			const result = match.closest('.search-result');
			const fileEl = result?.querySelector('.search-result-file-title .tree-item-inner') ?? result?.querySelector('.search-result-file-title');
			const basename = (fileEl?.textContent ?? '').trim();
			const text = match.textContent ?? '';
			const entries = this.index.get(view.file.path).filter((en) => en.sourcePath.split('/').pop()?.replace(/\.md$/, '') === basename);
			// Match rows show the raw markdown line, so the link source identifies the highlight.
			let hits = entries.filter((en) => text.includes(en.original.slice(0, 48)));
			if (!hits.length) hits = entries.filter((en) => en.displayText && text.includes(en.displayText));
			const ids = hits.map((h) => h.id);
			if (ids.join('|') !== lastIds) {
				lastIds = ids.join('|');
				view.reader.setHoveredHighlights(ids);
				const r = ids.length ? view.reader.highlightRange(ids[0]) : null;
				if (r) view.reader.scrollToRange(r, { position: 'center' });
			}
		});
	}
}

function toRgb(color: string): string | null {
	const ctx = document.createElement('canvas').getContext('2d');
	if (!ctx) return null;
	ctx.fillStyle = '#000';
	ctx.fillStyle = color;
	const v = ctx.fillStyle as string;
	const m = /^#([0-9a-f]{6})$/i.exec(v);
	if (m) {
		const n = parseInt(m[1], 16);
		return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
	}
	const r = /rgba?\(([^)]+)\)/.exec(v);
	return r ? r[1].split(',').slice(0, 3).join(',') : null;
}

/** Offset of a highlight's link in its note's current text (at its indexed position, else anywhere), or -1. */
function findLink(data: string, entry: HighlightEntry): number {
	const { start, end } = entry.position;
	return data.slice(start.offset, end.offset) === entry.original ? start.offset : data.indexOf(entry.original);
}

/** A name for this device in the settings ("iPhone", the computer's host name, …). */
function defaultDeviceName(): string {
	if (Platform.isIosApp) return Platform.isTablet ? 'iPad' : 'iPhone';
	if (Platform.isAndroidApp) return Platform.isTablet ? 'Android tablet' : 'Android phone';
	try {
		return ((window as { require?: (m: string) => unknown }).require?.('os') as { hostname(): string }).hostname() || 'Desktop';
	} catch {
		return Platform.isMacOS ? 'Mac' : Platform.isWin ? 'Windows PC' : 'Desktop';
	}
}

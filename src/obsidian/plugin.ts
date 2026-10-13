import { formatLocator, type DocumentReader, type ReaderSettings } from '../core';
import { MarkdownView, Notice, Platform, Plugin, TFile, WorkspaceLeaf, parseLinktext, type PaneType, type ViewState, type Workspace, type OpenViewState } from 'obsidian';
import { around } from './patch';
import { shareHotkeys } from './hotkeys';
import { hoverLink } from './hover';
import { resolveFile, type HighlightEntry } from '../annotator/highlight-index';
import { formatLink, linkAt } from './link-utils';
import { COMMENT_TEMPLATE, DEFAULT_SETTINGS, needsComment, newFormatId, syncMenus, type AppearancePlatform, type Orientation, type CopyFormat, type FppSettings, type LinkPlace, type OpenTarget } from './settings';
import { Annotator } from '../annotator/annotator';
import { DocumentEmbed, registerEmbeds, type EmbedContext } from './embed';
import { FppSettingTab } from './setting-tab';
import { DocumentView } from './view';
import { SourceView, type SourceMode } from './source-view';
import type { FileFormat } from './format';
import { FPP_API_READY, FPP_API_UNLOAD, type AnnotationProvider, type FileApi } from './api';


/** The sidebar as last left (see `sidebarState`) */
export interface SidebarState {
	open: boolean;
	tab: string;
}

/** Shared by every file-plus-plus plugin (the build's prefix rewriting leaves it alone) */
const SIDEBAR_KEY = 'file-plus-plus:sidebar';

export type CopyTarget = CopyFormat | 'link' | 'alt-link' | 'text';

/**
 * The plugin side of the library: a view for the format's files, links into them that open and
 * scroll the view, highlights from those links, copy formats, annotation files, previews and embeds,
 * and an API for other plugins. A plugin subclasses it and provides its `format`.
 */
export abstract class FilePlusPlusPlugin<Doc = unknown, R extends DocumentReader = DocumentReader> extends Plugin {
	abstract readonly format: FileFormat<Doc, R>;
	declare settings: FppSettings;
	/** The note-taking layer: highlights from links in notes, comments, annotation files, copying. */
	readonly annotator = new Annotator<Doc, R>(this);
	/** Annotation providers registered by other plugins, by id. */
	readonly providers = new Map<string, AnnotationProvider<unknown>>();
	/** For other plugins: see `api.ts`. */
	api!: FileApi;
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

	/** Page preview source for annotation providers' previews (plain hover). */
	get annotationHoverSource(): string {
		return `${this.manifest.id}-annotations`;
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

		this.registerView(this.viewType, (leaf) => this.createView(leaf));
		this.registerExtensions(this.format.extensions, this.viewType);
		if (this.format.plainText) this.registerView(this.sourceViewType, (leaf) => new SourceView(leaf, this));
		this.registerHoverLinkSource(this.hoverSource, { display: `${this.manifest.name} highlights`, defaultMod: true });
		// Obsidian's own editor previews need Ctrl/Cmd; this source (toggleable under Page preview)
		// previews links in the editor on plain hover, like Reading view does.
		this.registerHoverLinkSource(this.annotationHoverSource, { display: `${this.manifest.name}: previews of other plugins' annotations`, defaultMod: false });
		this.registerHoverLinkSource(this.editorHoverSource, { display: `${this.manifest.name}: ${this.format.name} links in the editor`, defaultMod: false });
		this.registerEditorHover();
		this.addSettingTab(new FppSettingTab(this.app, this as unknown as FilePlusPlusPlugin));
		this.patchLinkOpening();
		this.patchViewOpening();
		this.register(shareHotkeys(this.app));
		this.registerIndexEvents();
		this.registerCommands();
		this.annotator.load();
		this.watchOrientation();
		this.updatePreviews();
		this.api = this.createApi();
		await this.onLoaded();
		this.app.workspace.onLayoutReady(() => {
			this.app.workspace.trigger(`${this.manifest.id}:api-ready`, this.api);
			this.app.workspace.trigger(FPP_API_READY, this.api);
		});
	}

	// --------------------------------------------------------------------------------------------
	// API for other plugins (annotation providers)
	// --------------------------------------------------------------------------------------------

	protected baseApi(): FileApi {
		return {
			version: 1,
			pluginId: this.manifest.id,
			formatName: this.format.name,
			extensions: this.format.extensions,
			extractText: async (file) => {
				if (!this.format.extractText || !this.format.extensions.includes(file.extension.toLowerCase())) return null;
				return this.format.extractText(this.app, file);
			},
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



	/**
	 * A document's annotation file, when the format keeps its own (a Bible book's notes, shared by
	 * its translations): the file, null when it has none yet, or undefined to look for a note whose
	 * frontmatter links to the document (the default)
	 */
	findAnnotationFile(_target: TFile): TFile | null | undefined {
		return undefined;
	}

	/**
	 * Places notes mention in a document without linking to it (Logoxide: `John 3:16` written in a
	 * note), listed with its highlights (`HighlightEntry.mention`); none by default
	 */
	mentionsOf(_target: TFile): HighlightEntry[] {
		return [];
	}

	/** Makes the annotation file of the document open in a view, when the format keeps its own (null: the default file) */
	async createAnnotationFile(_view: DocumentView<Doc, R>): Promise<TFile | null> {
		return null;
	}

	/** The format's file a link path points to, if any. */
	resolveLink(path: string, sourcePath: string): TFile | null {
		return resolveFile(this.app, path, sourcePath, this.format.extensions);
	}

	private registerEditorHover(): void {
		this.registerDomEvent(document, 'mouseover', (e) => {
			if (!this.settings.previews || e.ctrlKey || e.metaKey) return; // with a modifier Obsidian handles it
			const el = (e.target as HTMLElement | null)?.closest?.<HTMLElement>('.cm-hmd-internal-link, .cm-link, .cm-url, .cm-underline');
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
			hoverLink(this.app, {
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
		this.app.workspace.trigger(FPP_API_UNLOAD, this.api);
		this.providers.clear();
		this.annotator.unload();
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
		const opening = (place: LinkPlace) => ({ ...defaults.linkOpening[place], ...data?.linkOpening?.[place] });
		this.settings.linkOpening = { mobile: opening('mobile'), desktop: opening('desktop'), half: opening('half') };
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
		for (const v of this.views()) {
			v.onAppearanceChanged();
			v.refreshHighlights();
		}
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	/**
	 * Whether the sidebar is open and on which tab (`toc`, `search`, `highlights`, `provider:<id>`), as
	 * the user last left it in any file-plus-plus plugin's view: new views open the same way. Kept in
	 * Obsidian's local storage, unprefixed so every plugin shares it, and per device (a drawer over
	 * the text on a phone, a column on a computer).
	 */
	sidebarState(): SidebarState {
		const saved = (this.app.loadLocalStorage(SIDEBAR_KEY) ?? {}) as Partial<SidebarState>;
		return { open: saved.open ?? (!Platform.isMobile && this.settings.sidebarOpen), tab: saved.tab ?? 'toc' };
	}

	rememberSidebar(change: Partial<SidebarState>): void {
		this.app.saveLocalStorage(SIDEBAR_KEY, { ...this.sidebarState(), ...change });
	}

	/**
	 * Whether a highlight being looked at (hovered, or its comment's) dims the others, kept per device
	 * in Obsidian's local storage, since repainting every highlight can be slow on some.
	 */
	get dimHighlights(): boolean {
		return this.app.loadLocalStorage(`${this.manifest.id}-dim-highlights`) !== 'off';
	}

	setDimHighlights(on: boolean): void {
		// Obsidian removes the key for a falsy value, so off is a string.
		this.app.saveLocalStorage(`${this.manifest.id}-dim-highlights`, on ? null : 'off');
		for (const view of this.views()) view.marginComments.refreshReveal();
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
		this.annotator.updateCalloutStyles();
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


	// --------------------------------------------------------------------------------------------
	// Highlight index
	// --------------------------------------------------------------------------------------------

	private registerIndexEvents(): void {
		const { vault } = this.app;
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
		this.registerEvent(
			vault.on('rename', (file, oldPath) => {
				if (!(file instanceof TFile)) return;
				if (this.format.extensions.includes(file.extension.toLowerCase())) {
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
							if (file) return await plugin.openDocument(file, subpath, newLeaf, subpath ? { ...state, eState: { ...(state?.eState as object | undefined), link: true } } : state);
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

	/** Opens a document at a subpath; `eState.link` in `state` says a link to a passage opened it (`linkOpening`). */
	async openDocument(file: TFile, subpath: string, newLeaf?: PaneType | boolean, state?: OpenViewState): Promise<void> {
		const { workspace } = this.app;
		if (!newLeaf) {
			const existing = this.findLeaf(file);
			if (existing) {
				// Switch to that tab in its own pane (loading it if it was a background tab).
				await workspace.revealLeaf(existing);
				await (existing as WorkspaceLeaf & { loadIfDeferred?: () => Promise<void> }).loadIfDeferred?.();
				if (existing.view instanceof DocumentView) {
					if (subpath) {
						// Make the place before the jump a history entry, so Back returns to it (private API).
						const l = existing as WorkspaceLeaf & { recordHistory?: (state: unknown) => void; getHistoryState?: () => unknown };
						if (existing.view.reader?.isRendered) l.recordHistory?.(l.getHistoryState?.());
						existing.view.navigate(subpath);
						if ((state?.eState as { link?: boolean } | undefined)?.link) existing.view.openedByLink();
					}
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






	// --------------------------------------------------------------------------------------------
	// Copying
	// --------------------------------------------------------------------------------------------

	linkStyle(): 'wiki' | 'markdown' {
		const s = this.settings.linkStyle;
		if (s !== 'auto') return s;
		return (this.app.vault as any).getConfig?.('useMarkdownLinks') ? 'markdown' : 'wiki';
	}


	/** A link (wiki or markdown, per settings) to a locator in a document; `params` follow the color. */
	documentLink(file: TFile, locator: string, alias: string, color: string | null = null, sourcePath?: string, params: Record<string, string | undefined> = {}): string {
		const subpath = formatLocator(locator, { color: color ?? undefined, ...params });
		const from = sourcePath ?? this.app.workspace.getActiveViewOfType(MarkdownView)?.file?.path ?? this.lastMarkdownPath() ?? '';
		const linktext = this.app.metadataCache.fileToLinktext(file, from, false);
		return formatLink(linktext, subpath, alias, this.linkStyle());
	}

	private lastMarkdownPath(): string | null {
		const leaf = this.app.workspace.getMostRecentLeaf();
		return leaf?.view instanceof MarkdownView ? (leaf.view.file?.path ?? null) : null;
	}











	// --------------------------------------------------------------------------------------------
	// Commands
	// --------------------------------------------------------------------------------------------

	/** A command callback that runs only while one of this plugin's views (with a reader) is active. */
	withViewCommand(fn: (v: DocumentView<Doc, R>) => void): (checking: boolean) => boolean {
		return this.withView(fn);
	}

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
	}

	// --------------------------------------------------------------------------------------------
	// Backlinks pane integration
	// --------------------------------------------------------------------------------------------

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

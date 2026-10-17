import { parseLocator, type DocumentReader, type ParsedLocator, type ReaderSettings, type SelectionInfo } from '../core';
import { Component, setIcon, type App, type Menu, type TFile } from 'obsidian';
import type { FilePlusPlusPlugin } from './plugin';

/** What Obsidian passes to an embed creator (private API, mirrors the built-in PDF/image embeds). */
export interface EmbedContext {
	app: App;
	containerEl: HTMLElement;
	linktext?: string;
	sourcePath?: string;
}

/**
 * Register the format's extensions with Obsidian's (private) embed registry. This powers both
 * `![[file#…]]` embeds and page previews when hovering `[[file#…]]` links. Returns an unregister function.
 */
export function registerEmbeds(plugin: FilePlusPlusPlugin): (() => void) | null {
	const registry = (plugin.app as any).embedRegistry;
	if (!registry?.registerExtension) return null;
	const exts = plugin.format.extensions;
	for (const ext of exts) {
		if (registry.isExtensionRegistered?.(ext)) registry.unregisterExtension(ext);
		registry.registerExtension(ext, (ctx: EmbedContext, file: TFile, subpath?: string) => plugin.createEmbed(ctx, file, subpath ?? ''));
	}
	return () => exts.forEach((ext) => registry.unregisterExtension?.(ext));
}

/**
 * A small reader showing the linked passage (highlighted), scrolled into view. Plugins may subclass it
 * (see `FilePlusPlusPlugin.createEmbed`) to add UI, e.g. a media player.
 */
export class DocumentEmbed<Doc = unknown, R extends DocumentReader = DocumentReader> extends Component {
	protected readonly containerEl: HTMLElement;
	protected reader: R | null = null;
	protected document: Doc | null = null;
	private unloaded = false;
	protected title!: HTMLElement;
	protected host!: HTMLElement;
	/**
	 * Highlights from notes in this embed, with its tab's menus to make and change them
	 * (`plugin.annotateReader`), instead of the linked passage highlighted; off by default
	 */
	protected annotated = false;
	/** Providers whose annotations an annotated embed leaves out (by id) */
	protected hiddenProviders: string[] = [];
	private annotator: ReturnType<FilePlusPlusPlugin<Doc, R>['annotateReader']> | null = null;

	constructor(
		protected plugin: FilePlusPlusPlugin<Doc, R>,
		ctx: EmbedContext,
		protected file: TFile,
		protected subpath: string,
	) {
		super();
		this.containerEl = ctx.containerEl;
	}

	/** The reader's appearance: the document's, filling the embed (a subclass may change it: a plugin's pane's own) */
	protected readerSettings(): ReaderSettings {
		return { ...this.plugin.readerSettings(this.file.path), width: 0, margin: 16 };
	}

	/** Where an annotated embed's comment cards and tooltips go (positioned): the embed by default */
	protected annotationContainer(): HTMLElement {
		return this.containerEl;
	}

	/** An annotated embed's own items in its selection menu (after the copy items) */
	protected extendSelectionMenu(_menu: Menu, _info: SelectionInfo): void {}

	/** Called once the header and the reader's host exist. */
	protected buildExtraUi(): void {}

	/** Called after the reader rendered the linked passage (`range`: null when not found). */
	protected onReaderReady(_reader: R, _loc: ParsedLocator, _range: Range | null): void {}

	async loadFile(): Promise<void> {
		const { plugin, file } = this;
		const s = plugin.settings;
		const el = this.containerEl;
		el.empty();
		el.addClass('fpp-embed');

		const header = el.createDiv('fpp-embed-header');
		const icon = header.createDiv('fpp-embed-icon');
		setIcon(icon, plugin.format.icon);
		this.title = header.createDiv({ cls: 'fpp-embed-title', text: file.basename });
		const open = header.createDiv({ cls: 'clickable-icon fpp-embed-open', attr: { 'aria-label': `Open in ${plugin.manifest.name}` } });
		setIcon(open, 'arrow-up-right');
		header.addEventListener('click', (e) => {
			e.preventDefault();
			e.stopPropagation();
			plugin.openDocument(file, this.subpath, e.ctrlKey || e.metaKey ? 'tab' : false);
		});
		this.host = el.createDiv('fpp-embed-host');
		this.host.style.height = `${s.previewHeight}px`;
		this.buildExtraUi();
		await this.renderAt(this.subpath, true);
	}

	/** (Re)render the preview around a locator. `highlight`: draw the linked passage. */
	private async renderAt(subpath: string, highlight: boolean): Promise<void> {
		const { plugin, file } = this;
		const s = plugin.settings;
		try {
			const doc = await plugin.getDocument(file);
			if (this.unloaded) return;
			this.document = doc;
			const loc = parseLocator(subpath, plugin.format.schemes);
			this.reader?.destroy();
			const reader = plugin.format.createReader(
				this.host,
				doc,
				{
					settings: this.readerSettings(),
					palette: plugin.paletteRecord(),
					defaultColor: s.defaultColor,
					highlightOpacity: s.highlightOpacity,
					onInternalLink: (href, e) => this.onLink(href, e),
				},
				loc,
			);
			this.reader = reader;
			await reader.render();
			if (this.unloaded) return;
			if (this.annotated) this.annotate();
			let chapter = '';
			let range: Range | null = null;
			if (loc.locator) {
				range = reader.resolve(loc.locator);
				if (range && highlight && !this.annotated && reader.isRangeLocator(loc.locator)) {
					const color = loc.params.color ?? (s.noColor === 'none' ? null : s.defaultColor);
					reader.setHighlights(color ? [{ id: 'target', locator: loc.locator, color }] : []);
				}
				if (range) {
					reader.scrollToRange(range, { position: range.collapsed || !highlight ? 'top' : 'center' });
					chapter = reader.tocItemAt(range)?.label ?? '';
				} else chapter = 'location not found';
			}
			const title = plugin.format.info(doc, file).title || file.basename;
			this.title.setText([title, chapter].filter(Boolean).join(' · '));
			this.onReaderReady(reader, loc, range);
		} catch (e) {
			console.error('[fpp] preview failed', e);
			this.host.empty();
			this.host.createDiv({ cls: 'fpp-error', text: `Could not preview this ${plugin.format.name}: ${(e as Error).message}` });
		}
	}

	/** Draws the notes' highlights in the reader (again, for a new reader), with the menus */
	private annotate(): void {
		if (this.annotator) this.removeChild(this.annotator);
		const embed = this;
		const target = {
			get file() {
				return embed.file;
			},
			get document() {
				return embed.document;
			},
			get reader() {
				return embed.reader;
			},
			refreshHighlights: () => this.annotator?.refreshHighlights(),
		};
		const container = this.annotationContainer();
		container.addClass('fpp-annotated');
		this.annotator = this.addChild(this.plugin.annotateReader(target, { container, hiddenProviders: this.hiddenProviders, extendSelectionMenu: (menu, info) => this.extendSelectionMenu(menu, info) }));
	}

	/** Links inside the document: jump within the preview, or open its tab (setting / Ctrl-click). */
	private onLink(href: string, e: MouseEvent): boolean {
		e.preventDefault();
		e.stopPropagation();
		const mod = e.ctrlKey || e.metaKey;
		if (mod || this.plugin.settings.previewLinks === 'tab') {
			void this.plugin.openDocument(this.file, href, mod ? 'tab' : false);
			return true;
		}
		// Rendered already? Let the reader scroll there.
		if (this.reader?.resolve(href)) return false;
		void this.renderAt(href, false);
		return true;
	}

	override onunload(): void {
		this.unloaded = true;
		this.reader?.destroy();
		this.reader = null;
	}
}

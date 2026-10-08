import type { App, Menu, TFile } from 'obsidian';

/**
 * The API other plugins use: `app.plugins.plugins['<plugin id>']?.api`, available once the workspace
 * event `<plugin id>:api-ready` (argument: the API) has fired. `<plugin id>:api-unload` fires when the
 * plugin unloads; providers registered before then are gone and must be registered again on the next
 * `api-ready`.
 *
 * The pattern: find things in a document, turn them into locators, and register an annotation provider
 * that hands them back. The plugin draws them, lists them in a sidebar tab, and lets the user save one
 * as a real highlight (a link in the document's annotation file). Formats add their own functions.
 *
 * Every plugin built on file-plus-plus also fires `file-plus-plus:api-ready` (and
 * `file-plus-plus:api-unload`) with its API, so a provider can serve all of them (EPUBs, transcripts,
 * Bibles…) without knowing each one: see `FPP_API_READY` and `fileApis`.
 */
export interface FileApi {
	/** Bumped on breaking changes. */
	readonly version: 1;
	/** The plugin's id (`epub-plus-plus`). */
	readonly pluginId: string;
	/** The format's name (`EPUB`) and file extensions. */
	readonly formatName: string;
	readonly extensions: readonly string[];
	/**
	 * A document's text without opening it, in sections, with a way back to locators (to search it and
	 * hand back annotations). Null when the format can't (or the file isn't one of its documents).
	 */
	extractText(file: TFile): Promise<ExtractedText | null>;
	/** Returns a function that unregisters the provider. */
	registerAnnotationProvider<T>(provider: AnnotationProvider<T>): () => void;
	/** Ask the plugin to fetch a provider's annotations again (for some paths, or all open documents). */
	refreshAnnotations(providerId: string, paths?: string[]): void;
	/** Open a document (reusing its tab) and jump to a locator. */
	open(file: TFile, locator?: string): Promise<void>;
	/** A wiki or markdown link to a locator, in the user's link style. */
	link(file: TFile, locator: string, alias: string, sourcePath?: string): string;
}

/** A document's text, for finding things in it (see `FileApi.extractText`). */
export interface ExtractedText {
	sections: ExtractedSection[];
	/** The format's range locator for `start`..`end` (UTF-16 offsets) in a section's text, or null. */
	locator(section: number, start: number, end: number): string | null;
}

export interface ExtractedSection {
	/** Passed back to `locator`. */
	index: number;
	/** Its table-of-contents label, if any. */
	title: string | null;
	text: string;
}

/** Fired on the workspace by every file-plus-plus plugin, with its `FileApi`, once it's ready. */
export const FPP_API_READY = 'file-plus-plus:api-ready';
/** Fired with the `FileApi` when its plugin unloads (its providers are gone). */
export const FPP_API_UNLOAD = 'file-plus-plus:api-unload';

/** The APIs of the file-plus-plus plugins loaded now (later ones fire `FPP_API_READY`). */
export function fileApis(app: App): FileApi[] {
	const plugins = (app as unknown as { plugins?: { plugins?: Record<string, { api?: Partial<FileApi> }> } }).plugins?.plugins ?? {};
	return Object.values(plugins)
		.map((p) => p?.api)
		.filter((api): api is FileApi => !!api && api.version === 1 && typeof api.pluginId === 'string');
}

export interface Annotation<T = unknown> {
	/** Unique within the provider and document. */
	id: string;
	/** A range locator of the format (e.g. `epubcfi(...)`) or `:~:text=...`. */
	locator: string;
	/** Shown in the sidebar, menus and tooltips, e.g. "John 3:16". */
	label: string;
	/** A palette name or CSS color; default: the provider's `color`. */
	color?: string;
	/**
	 * A note about the passage (Markdown), shown beside it in the margin like a highlight's comment
	 * (when the user shows comments in the margin and the provider's annotations).
	 */
	note?: string;
	data?: T;
}

/** What the plugin knows about an annotation when calling back into its provider. */
export interface AnnotationContext {
	file: TFile;
	/** The annotated text in the document. */
	text: string;
	/** The table-of-contents entry it's in. */
	chapter: string | null;
}

export interface AnnotationProvider<T = unknown> {
	/** Stable id; it also keys the user's show/hide choice. */
	id: string;
	/** Sidebar tab and menu label, e.g. "Bible references". */
	name: string;
	/** Lucide icon name for the sidebar tab. */
	icon?: string;
	/** Default color for annotations without one (palette name or CSS color). */
	color?: string;
	/**
	 * How annotations are drawn: CSS declarations for `::highlight()` given the resolved color, e.g.
	 * `` c => `text-decoration: underline dashed 2px ${c};` ``. Default: a background like highlights.
	 */
	style?: (color: string) => string;
	/** The annotations of a document. Called when a view opens it and on `refreshAnnotations`. */
	annotations(file: TFile): Annotation<T>[] | Promise<Annotation<T>[]>;
	/**
	 * A click (desktop) or tap (mobile) on annotations that isn't on a highlight. Return true when
	 * handled; otherwise desktop does nothing and mobile opens the menu.
	 */
	onClick?(annotations: Annotation<T>[], event: MouseEvent, ctx: AnnotationContext): boolean | void;
	/** Add items to the menu shown for these annotations (right-click, or a hold on mobile). */
	menu?(menu: Menu, annotations: Annotation<T>[], ctx: AnnotationContext): void;
	/** Hover text on desktop (default: the label). Return null for none. */
	tooltip?(annotation: Annotation<T>, ctx: AnnotationContext): string | null;
	/**
	 * A link to preview on hover (desktop), instead of the tooltip: `Bibles/BSB/JHN.usx#v=3:16`.
	 * Obsidian's page preview shows it (source "<plugin>: annotations"; previews of a format's own
	 * documents are its embeds). Null: the tooltip.
	 */
	preview?(annotation: Annotation<T>, ctx: AnnotationContext): string | null;
}

/** The reader layer (and sidebar tab) of another plugin's annotation provider. */
export const layerId = (providerId: string) => `provider:${providerId}`;

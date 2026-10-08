import type { Menu, TFile } from 'obsidian';

/**
 * The API other plugins use: `app.plugins.plugins['<plugin id>']?.api`, available once the workspace
 * event `<plugin id>:api-ready` (argument: the API) has fired. `<plugin id>:api-unload` fires when the
 * plugin unloads; providers registered before then are gone and must be registered again on the next
 * `api-ready`.
 *
 * The pattern: find things in a document, turn them into locators, and register an annotation provider
 * that hands them back. The plugin draws them, lists them in a sidebar tab, and lets the user save one
 * as a real highlight (a link in the document's annotation file). Formats add their own functions
 * (EPUB++: `extractText`).
 */
export interface FileApi {
	/** Bumped on breaking changes. */
	readonly version: 1;
	/** Returns a function that unregisters the provider. */
	registerAnnotationProvider<T>(provider: AnnotationProvider<T>): () => void;
	/** Ask the plugin to fetch a provider's annotations again (for some paths, or all open documents). */
	refreshAnnotations(providerId: string, paths?: string[]): void;
	/** Open a document (reusing its tab) and jump to a locator. */
	open(file: TFile, locator?: string): Promise<void>;
	/** A wiki or markdown link to a locator, in the user's link style. */
	link(file: TFile, locator: string, alias: string, sourcePath?: string): string;
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
}

/** The reader layer (and sidebar tab) of another plugin's annotation provider. */
export const layerId = (providerId: string) => `provider:${providerId}`;

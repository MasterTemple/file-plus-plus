import type { DocumentReader, LocatorScheme, ParsedLocator, ReaderOptions, ReaderSettings, SelectionInfo, TocItem } from '../core';
import type { App, TFile } from 'obsidian';
import type { ExtractedText } from './api';

/** Title and author of a document, for templates, file names and the view's title. */
export interface DocumentInfo {
	title: string;
	author: string;
}

/**
 * Orders positions in an annotation file: new annotations go between the ones before and after them
 * in the document. A format maps its locators to sortable keys (a CFI path, a time in seconds).
 */
export interface PositionScheme<K = unknown> {
	/** The key of a locator of the format's own scheme (the one `locatorFromRange` produces), or null. */
	key(locator: string): K | null;
	compare(a: K, b: K): number;
}

/**
 * What a plugin built on the library tells it about its file format. Everything format-specific the
 * library needs goes through here; the rest (views, links, highlights, menus, annotation files…) is shared.
 */
export interface FileFormat<Doc = unknown, R extends DocumentReader = DocumentReader> {
	/** Short name used in the UI: `EPUB`, `transcript`. */
	name: string;
	/** What one document is called in sentences: `book`, `transcript`. */
	noun: string;
	extensions: string[];
	/** The files are text: offer opening them as plain text (`SourceView`) besides the rendered view. */
	plainText?: boolean;
	/** Lucide icon of the view, embeds and the plugin's tabs. */
	icon: string;
	/**
	 * Frontmatter property linking an annotation file to its document (`epub: "[[Book.epub]]"`).
	 * The file's mode is kept in `<key>-annotation-mode`.
	 */
	frontmatterKey: string;
	/** Locator schemes, tried in order: the format's own scheme first, then `textFragmentScheme`… */
	schemes: LocatorScheme[];
	/** Name of the format's own link type, next to "Text fragment" (e.g. `EPUB CFI`, `Timestamp`). */
	linkTypeName: string;
	/** Settings description of the link type choice. */
	linkTypeDescription: string;
	position: PositionScheme<any>;

	load(app: App, file: TFile): Promise<Doc>;
	/**
	 * A document's text without rendering it, for annotation providers (`FileApi.extractText`). A
	 * locator may be the format's unit locator plus the exact words (`t=…:~:text=…`), which resolve
	 * within those units.
	 */
	extractText?(app: App, file: TFile): Promise<ExtractedText>;
	/** Release what `load` allocated (blob URLs…). */
	unload(doc: Doc): void;
	info(doc: Doc, file: TFile): DocumentInfo;
	/** The document's cover image (a URL `unload` releases), shown atop the sidebar's contents, or null. */
	cover?(doc: Doc): Promise<string | null>;
	/**
	 * A reader for the document. `preview`: the locator a hover preview or embed shows, so the
	 * format can render only what's needed around it.
	 */
	createReader(host: HTMLElement, doc: Doc, opts: ReaderOptions, preview?: ParsedLocator): R;
	/** Template variables in addition to the shared ones (e.g. `{{cfi}}`). */
	templateVars?(info: SelectionInfo, doc: Doc | null): Record<string, string>;
	/** Those variables as listed in the settings, e.g. `{{cfi}}`. */
	extraTemplateVars?: string;
	/** Appearance: options that don't apply to this format, and the name of "the document's own styles". */
	appearance?: {
		hidden?: (keyof ReaderSettings)[];
		/**
		 * Who made the document's own styles, for the `publisher` choices (theme, font, alignment);
		 * default `Publisher`. null: the format has none (the choices read "Default", no such theme).
		 */
		publisherName?: string | null;
		/** Defaults that differ from the library's. */
		defaults?: Partial<ReaderSettings>;
	};
	/** TOC entries that annotation files get headings for (default: all). */
	annotationHeadings?(toc: TocItem[]): TocItem[];
	/**
	 * Where a block of an annotation file is, from its text when no link in it says (`## John 3`, a
	 * heading naming a passage rather than linking to it): a locator in `target` (the document the
	 * file is for), or null
	 */
	locatorOfText?(markdown: string, target: TFile | null): string | null;
	/**
	 * What a highlight is called on its comment card in the margin (default: the note it's in): its
	 * passage (`John 3:16`), when its note is shared and says less
	 */
	highlightLabel?(locator: string, target: TFile | null): string | null;
}

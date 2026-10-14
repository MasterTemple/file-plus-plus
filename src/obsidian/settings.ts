import { DEFAULT_SETTINGS as READER_DEFAULTS, type ReaderSettings } from '../core';

export interface PaletteColor {
	name: string;
	color: string;
}

export interface CopyFormat {
	/** Stable id (command ids / copy action refer to it). */
	id: string;
	name: string;
	template: string;
}

/** One kind of imported highlight (with or without a comment): imported or not, and in which format. */
export interface ImportKind {
	enabled: boolean;
	format: CopyAction;
}

/** What a copy produces: plain text, a link, the alternate link type, or a copy format (`format:<id>`). */
export type CopyAction = 'text' | 'link' | 'alt-link' | `format:${string}`;

/** One entry of a configurable context menu. */
export interface MenuEntry {
	id: string;
	show: boolean;
}

/** What a reader key (`readerKeys`) does, its default key and its name in the settings. */
export const READER_KEY_ACTIONS = [
	{ id: 'scroll-down', key: 'j', name: 'Scroll down', desc: 'In the outline and the search results: the next entry.' },
	{ id: 'scroll-up', key: 'k', name: 'Scroll up', desc: 'In the outline and the search results: the previous entry.' },
	{ id: 'page-down', key: 'd', name: 'Scroll down half a screen' },
	{ id: 'page-up', key: 'u', name: 'Scroll up half a screen' },
	{ id: 'top', key: 'g g', name: 'Go to the beginning', desc: 'In the outline and the search results: the first entry.' },
	{ id: 'bottom', key: 'G', name: 'Go to the end', desc: 'In the outline and the search results: the last entry.' },
	{ id: 'set-mark', key: 'm', name: 'Set a mark', desc: 'Then a letter: a–z in this document, A–Z across documents.' },
	{ id: 'go-to-mark', key: "'", name: 'Go to a mark', desc: "Then its letter, or ' for where you were before the last jump." },
	{ id: 'jump-back', key: 'Ctrl+o', name: 'Back in the jump list', desc: 'Places jumped from (g g, G, marks, search, the outline), in this view, across documents.' },
	{ id: 'jump-forward', key: 'Ctrl+i', name: 'Forward in the jump list' },
	{ id: 'search', key: '/', name: 'Search', desc: 'In the search box, Ctrl+N / Ctrl+P go to the next / previous result, and Enter moves into the results: the scroll keys move, Enter goes there, / back to the box.' },
	{ id: 'next-result', key: 'n', name: 'Next search result' },
	{ id: 'prev-result', key: 'N', name: 'Previous search result' },
	{ id: 'outline', key: 'Tab', name: 'Outline', desc: 'Moves into the contents: the scroll keys (or arrows) move, h / l collapse and expand, Enter goes there. Again (or Escape) goes back to the text.' },
	{ id: 'sidebar', key: '\\', name: 'Toggle the sidebar', desc: 'Contents, search and highlights.' },
	{ id: 'comments', key: 'c', name: 'Toggle comments in the margin' },
] as const;
export type ReaderKeyAction = (typeof READER_KEY_ACTIONS)[number]['id'];

/** The format's own locator (`primary`: an EPUB CFI, a timestamp…) or a text fragment. */
export type LinkType = 'primary' | 'text';
/** What a touch gesture on a highlight does (mobile). */
export type HighlightGestureAction = 'open' | 'comment' | 'menu' | 'color' | 'copy-link' | 'select' | 'none';
export const HIGHLIGHT_GESTURE_LABELS: Record<HighlightGestureAction, string> = {
	open: 'Open the note (link)',
	comment: 'Add / edit comment',
	menu: 'Open the highlight menu',
	color: 'Change color',
	'copy-link': 'Copy link',
	select: 'Select the paragraph',
	none: 'Nothing',
};
/** What copying a selection does when the book has an annotation file. */
export type AnnotationMode = 'copy' | 'insert' | 'both';
export const ANNOTATION_MODES: AnnotationMode[] = ['copy', 'insert', 'both'];
export type LinkStyle = 'auto' | 'wiki' | 'markdown';
export type OpenTarget = 'split' | 'tab' | 'current';

/** Where a document is open, for how links open it: a phone or tablet, a desktop pane, or half (or less) of the desktop's panes. */
export type LinkPlace = 'mobile' | 'desktop' | 'half';

/** What a link to a passage does to the tab it opens (or goes to). */
export interface LinkOpening {
	closeSidebar: boolean;
	hideComments: boolean;
}

/** Desktop or mobile (phones and tablets): where a new device's appearance starts from. */
export type AppearancePlatform = 'desktop' | 'mobile';
/** The window's shape: horizontal (landscape) or vertical (portrait). */
export type Orientation = 'landscape' | 'portrait';
export const ORIENTATION_LABELS: Record<Orientation, string> = { landscape: 'Horizontal', portrait: 'Vertical' };

export interface DeviceInfo {
	name: string;
	platform: AppearancePlatform;
}

export interface FppSettings {
	/** Starting point of a device's appearance, per platform (and the appearance before devices existed). */
	appearance: Record<AppearancePlatform, ReaderSettings>;
	/** Devices that have used the plugin (id → name); each device keeps its id in local storage. */
	devices: Record<string, DeviceInfo>;
	/** Appearance for all books per device and orientation: `${deviceId}:${orientation}` → settings. */
	deviceAppearance: Record<string, ReaderSettings>;
	/** Per-document overrides: path → `${deviceId}:${orientation}` (or a legacy platform name) → changed settings. */
	bookAppearance: Record<string, Record<string, Partial<ReaderSettings>>>;
	palette: PaletteColor[];
	defaultColor: string;
	/** Bare 1–9 pick a palette color (0: none) while a document is focused (not while typing). */
	numberKeyColors: boolean;
	/** Vim-like keys in a focused document (`readerKeys`); off by default. */
	readerKeysEnabled: boolean;
	/** Each reader key action's binding (see key-sequence.ts: `j`, `Ctrl+d`, `g g`); '' = off. */
	readerKeys: Record<ReaderKeyAction, string>;
	/** Color picked last in a menu or the palette (null = no color); undefined until first pick. */
	lastColor?: string | null;
	/** Include `&color=` in copied links. */
	colorInLinks: boolean;
	/** Stamp highlight links with `&updated=` when they are created and when their color or comment changes. */
	timestampInLinks: boolean;
	/** Show highlights' comments (and annotations' notes) beside the text, when the pane is wide enough. */
	marginComments: boolean;
	highlightOpacity: number;
	linkType: LinkType;
	linkStyle: LinkStyle;
	/** Display text of generated links. Variables: {{book}} {{author}} {{chapter}} {{text}} */
	aliasTemplate: string;
	copyFormats: CopyFormat[];
	/** What Ctrl/Cmd+C (and the system Copy menu) puts on the clipboard for a selection in a document. */
	copyAction: CopyAction;
	/** Links without `&color=`: draw with the default color, or don't highlight them. */
	noColor: 'default' | 'none';
	/** Briefly highlight the passage after jumping to it from a link. */
	jumpHighlight: boolean;
	/** ms, including the fade-out. */
	jumpHighlightDuration: number;
	jumpHighlightColor: string;
	/** Copy selections as Markdown converted from the document's HTML (emphasis, lists…) instead of plain text. */
	copyMarkdown: boolean;
	/** Links clicked inside a preview: jump within the preview, or open the document's tab. */
	previewLinks: 'preview' | 'tab';
	/** Hover previews of links and `![[file#…]]` embeds. */
	previews: boolean;
	/** Height of previews / embeds in px. */
	previewHeight: number;
	/** Where links open when no view of that document is open yet. */
	openIn: OpenTarget;
	/** Where the source note opens when clicking a highlight. */
	openNoteIn: OpenTarget;
	/** What a link to a passage does to the tab it opens, by where it is. */
	linkOpening: Record<LinkPlace, LinkOpening>;
	/** Whether new views opened with the sidebar, before that was kept on each device (`sidebarState`). */
	sidebarOpen: boolean;
	/** Mobile: open the plugin's menu when a selection settles. */
	selectionBar: boolean;
	/** Order and visibility of selection menu items: `link`, `alt-link`, `text`, `format:<id>`. */
	selectionMenu: MenuEntry[];
	/** Order and visibility of highlight menu items: `open`, `color`, `copy-link`. */
	highlightMenu: MenuEntry[];
	/** Folder for new annotation files; empty = next to the document. */
	annotationFolder: string;
	/** File name (without .md). Variables: {{book}} {{author}} {{file}} */
	annotationFileName: string;
	/** Default for books with an annotation file (a file can override it in its frontmatter). */
	annotationMode: AnnotationMode;
	/** Resolve text-fragment links in annotation files to CFIs to place new annotations exactly. */
	annotationResolveTextFragments: boolean;
	/** Highlights tab: which highlights to list and how to group them. */
	highlightsFilter: 'all' | 'annotation' | 'other';
	highlightsGroup: 'book' | 'note' | 'chapter';
	/** "Split pane": reuse an open tab of the document, or another pane, before splitting. */
	reusePanes: boolean;
	/** Mobile: what tapping, double-tapping and holding a highlight do. */
	highlightTap: HighlightGestureAction;
	highlightDoubleTap: HighlightGestureAction;
	highlightHold: HighlightGestureAction;
	/** What "Save as highlight" on another plugin's annotation inserts into the annotation file. */
	saveAnnotationAs: CopyAction;
	/** Don't draw highlights (links from notes) in documents; the sidebar still lists them. */
	hideHighlights: boolean;
	/** Importing highlights from JSON: which kinds to import, and as what (a copy action). */
	importPlain: ImportKind;
	importComment: ImportKind;
	/** Annotation providers (other plugins) whose annotations aren't drawn in documents. */
	hiddenProviders: string[];
	/** Bumped when settings need a one-time migration. */
	settingsVersion: number;
	/** Last reading position (a locator) per document path. */
	positions: Record<string, string>;
	/** Reader-key marks a–z (Vim's `m a`): document path → mark → locator. */
	marks: Record<string, Record<string, string>>;
	/** Marks A–Z, across documents (Vim's file marks). */
	globalMarks: Record<string, { path: string; locator: string }>;
}

/** Asks for a comment: the quote is nested inside the callout, the comment follows it. */
export const COMMENT_TEMPLATE = '> [!quote|{{color}}] {{link}}\n> > {{text}}\n>\n> {{comment}}';

/** The selection highlighted in its sentence (or, for whole sentences, with the ones around them). */
export const CONTEXT_FORMAT: CopyFormat = { id: 'context', name: 'Highlight in context', template: '> [!quote|{{color}}] {{link}}\n> {{context}}' };

export const SELECTION_MENU_LABELS: Record<string, string> = {
	link: 'Link Only',
	'alt-link': 'Alternate Link',
	text: 'Text Only',
};

const SMALL_WORDS = new Set(['a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'in', 'of', 'on', 'or', 'the', 'to', 'with']);

/** "Callout with comment" → "Callout with Comment". */
export function titleCase(text: string): string {
	return text.replace(/[^\s-]+/g, (w, i: number) => (i > 0 && SMALL_WORDS.has(w.toLowerCase()) ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1)));
}

/** Selection-menu label of a copy format ("As Callout with Comment"). */
export function formatMenuLabel(name: string): string {
	return `As ${titleCase(name)}`;
}

/** Selection-menu label of the alternate link type (`primaryName`: the format's, e.g. `CFI`). */
export function altLinkLabel(linkType: LinkType, primaryName: string): string {
	return linkType === 'primary' ? 'Text-Fragment Link' : `${titleCase(primaryName)} Link`;
}

export const HIGHLIGHT_MENU_LABELS: Record<string, string> = {
	open: 'Open the note',
	color: 'Change color',
	comment: 'Add / edit comment',
	'copy-link': 'Copy link',
	delete: 'Delete highlight',
};

export const DEFAULT_SETTINGS: FppSettings = {
	appearance: { desktop: { ...READER_DEFAULTS }, mobile: { ...READER_DEFAULTS } },
	devices: {},
	deviceAppearance: {},
	bookAppearance: {},
	palette: [
		{ name: 'yellow', color: '#ffd000' },
		{ name: 'red', color: '#ff5f5f' },
		{ name: 'green', color: '#4cc764' },
		{ name: 'blue', color: '#4c9bff' },
		{ name: 'purple', color: '#b07cff' },
	],
	defaultColor: 'yellow',
	numberKeyColors: false,
	readerKeysEnabled: false,
	readerKeys: Object.fromEntries(READER_KEY_ACTIONS.map((a) => [a.id, a.key])) as Record<ReaderKeyAction, string>,
	colorInLinks: true,
	timestampInLinks: true,
	marginComments: true,
	highlightOpacity: 0.4,
	linkType: 'primary',
	linkStyle: 'auto',
	aliasTemplate: '{{book}}, {{chapter}}',
	copyFormats: [
		{ id: 'callout', name: 'Callout', template: '> [!quote|{{color}}] {{link}}\n> {{text}}' },
		{ id: 'quote', name: 'Quote', template: '> {{text}}\n\n{{link}}' },
		{ id: 'callout-comment', name: 'Callout with comment', template: COMMENT_TEMPLATE },
		{ id: 'text-with-link', name: 'Text with link', template: '{{text}} ({{link}})' },
		CONTEXT_FORMAT,
	],
	annotationFolder: '',
	annotationFileName: '{{book}} - Annotations',
	annotationMode: 'both',
	annotationResolveTextFragments: true,
	highlightsFilter: 'all',
	highlightsGroup: 'book',
	reusePanes: true,
	highlightTap: 'open',
	highlightDoubleTap: 'comment',
	highlightHold: 'menu',
	selectionMenu: [],
	highlightMenu: [],
	settingsVersion: 5,
	copyAction: 'text',
	saveAnnotationAs: 'format:callout',
	hiddenProviders: [],
	hideHighlights: false,
	importPlain: { enabled: true, format: 'format:callout' },
	importComment: { enabled: true, format: 'format:callout-comment' },
	noColor: 'default',
	jumpHighlight: true,
	jumpHighlightDuration: 2000,
	jumpHighlightColor: '#ffb000',
	previews: true,
	copyMarkdown: true,
	previewLinks: 'preview',
	previewHeight: 320,
	openIn: 'split',
	openNoteIn: 'split',
	linkOpening: {
		mobile: { closeSidebar: false, hideComments: false },
		desktop: { closeSidebar: false, hideComments: false },
		half: { closeSidebar: false, hideComments: false },
	},
	sidebarOpen: true,
	selectionBar: true,
	positions: {},
	marks: {},
	globalMarks: {},
};

export function newFormatId(): string {
	return Math.random().toString(36).slice(2, 10);
}

/** Templates with {{comment}} ask for a comment before copying. */
export function needsComment(template: string): boolean {
	return template.includes('{{comment}}');
}

/** Keep a configured menu in sync with the available items: drop unknown ids, append new ones (shown). */
export function syncMenu(entries: MenuEntry[], ids: string[]): MenuEntry[] {
	const known = new Set(ids);
	const out = entries.filter((e) => known.has(e.id));
	const present = new Set(out.map((e) => e.id));
	for (const id of ids) if (!present.has(id)) out.push({ id, show: true });
	return out;
}

export function selectionMenuIds(s: FppSettings): string[] {
	return ['link', ...s.copyFormats.map((f) => `format:${f.id}`), 'alt-link', 'text'];
}

export function syncMenus(s: FppSettings): void {
	s.selectionMenu = syncMenu(s.selectionMenu ?? [], selectionMenuIds(s));
	s.highlightMenu = syncMenu(s.highlightMenu ?? [], Object.keys(HIGHLIGHT_MENU_LABELS));
}

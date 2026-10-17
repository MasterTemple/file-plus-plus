import { Menu, Notice, type MenuItem, type TFile } from 'obsidian';
import type { DocumentReader, SelectionInfo } from '../core';
import type { CopyTarget, FilePlusPlusPlugin } from '../obsidian/plugin';
import { ANNOTATION_MODES, SELECTION_MENU_LABELS, altLinkLabel, formatMenuLabel, type AnnotationMode } from '../obsidian/settings';
import { askForComment } from './comment-modal';
import type { HighlightEntry } from './highlight-index';
import type { AnnotationTarget } from './target';

/**
 * Where the selection and highlight menus are shown: a document's tab (`DocumentView`) or an embed
 * (`ReaderAnnotator`). The menus are the same in both, built here.
 */
export interface MenuHost<Doc = unknown, R extends DocumentReader = DocumentReader> {
	readonly plugin: FilePlusPlusPlugin<Doc, R>;
	readonly target: AnnotationTarget<Doc, R>;
	/** The color new highlights get */
	readonly activeColor: string | null;
	setActiveColor(color: string | null): void;
	editComment(entry: HighlightEntry): Promise<void>;
	openSource(entry: HighlightEntry): void;
	/** The plugin's own items for a selection (after the copy items) */
	extendSelectionMenu?(menu: Menu, info: SelectionInfo): void;
	/** The plugin's own items for a highlight (in its `section`) */
	extendHighlightMenu?(menu: Menu, entry: HighlightEntry, section: string): void;
}

/** A palette color's CSS (a name not in the palette is a CSS color) */
export function colorCss(plugin: FilePlusPlusPlugin<any, any>, name: string | null): string {
	if (!name) return 'transparent';
	return plugin.settings.palette.find((p) => p.name === name)?.color ?? name;
}

/** A color's name after its swatch, for menu items */
export function colorTitle(plugin: FilePlusPlusPlugin<any, any>, name: string | null): DocumentFragment {
	const frag = document.createDocumentFragment();
	const sw = frag.createSpan({ cls: 'fpp-menu-swatch' });
	sw.style.setProperty('--swatch', colorCss(plugin, name));
	if (!name) sw.addClass('fpp-swatch-none');
	frag.appendText(name ?? 'No color');
	return frag;
}

/**
 * A row of palette swatches (and "No color") as a menu item: one line that scrolls sideways
 * instead of wrapping. `onPick` runs without closing the menu.
 */
export function addColorRow(plugin: FilePlusPlusPlugin<any, any>, menu: Menu, section: string, current: () => string | null, onPick: (color: string | null) => void): void {
	menu.addItem((item) => {
		item.setSection(section);
		const dom = (item as MenuItem & { dom?: HTMLElement }).dom;
		if (!dom) return;
		dom.empty();
		dom.addClass('fpp-color-row');
		dom.setAttr('aria-label', 'Color');
		// A mouse wheel scrolls the row sideways when it overflows.
		dom.addEventListener(
			'wheel',
			(e) => {
				if (dom.scrollWidth <= dom.clientWidth || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
				dom.scrollLeft += e.deltaY;
				e.preventDefault();
			},
			{ passive: false },
		);
		const swatches: [string | null, HTMLElement][] = [];
		const refresh = () => swatches.forEach(([name, sw]) => sw.toggleClass('is-active', name === current()));
		for (const name of [...plugin.settings.palette.map((p) => p.name), null]) {
			const sw = dom.createDiv({ cls: 'fpp-swatch', attr: { 'aria-label': name ?? 'No color' } });
			sw.style.setProperty('--swatch', colorCss(plugin, name));
			if (!name) sw.addClass('fpp-swatch-none');
			swatches.push([name, sw]);
			// Keep these events away from the menu item (and the menu) so it stays open.
			for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'touchstart', 'touchend']) sw.addEventListener(type, (e) => e.stopPropagation());
			sw.addEventListener('click', (e) => {
				e.preventDefault();
				e.stopPropagation();
				onPick(name);
				refresh();
			});
		}
		refresh();
	});
}

/** Menus that already have a row for the active color (selection and annotation items share one). */
const activeColorRows = new WeakSet<Menu>();

/** The color the selection / annotation items below use (the toolbar's active color), once per menu. */
export function addActiveColorRow(host: MenuHost<any, any>, menu: Menu, section: string): void {
	if (activeColorRows.has(menu)) return;
	activeColorRows.add(menu);
	addColorRow(host.plugin, menu, section, () => host.activeColor, (c) => host.setActiveColor(c));
}

/**
 * `[Copy | Insert | Both]`: what the selection items do with the document's annotation file. Without
 * one (`ann` null) the choice is kept in `pending` for this menu only.
 */
export function addAnnotationModeRow(plugin: FilePlusPlusPlugin<any, any>, menu: Menu, ann: TFile | null, section: string, pending: { mode: AnnotationMode }): void {
	menu.addItem((item) => {
		item.setSection(section);
		const dom = (item as MenuItem & { dom?: HTMLElement }).dom;
		if (!dom) return;
		dom.empty();
		dom.addClass('fpp-mode-row');
		dom.setAttr('aria-label', ann ? `When copying, for ${ann.basename}` : 'When copying (Insert and Both create an annotation file)');
		const labels: Record<AnnotationMode, string> = { copy: 'Copy', insert: 'Insert', both: 'Both' };
		const buttons: HTMLElement[] = [];
		const current = ann ? plugin.annotator.annotations.mode(ann) : pending.mode;
		for (const mode of ANNOTATION_MODES) {
			const b = dom.createDiv({ cls: 'fpp-mode-button', text: labels[mode] });
			b.toggleClass('is-active', mode === current);
			buttons.push(b);
			for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'touchstart', 'touchend']) b.addEventListener(type, (e) => e.stopPropagation());
			b.addEventListener('click', async (e) => {
				e.preventDefault();
				e.stopPropagation();
				buttons.forEach((x) => x.toggleClass('is-active', x === b));
				if (ann) await plugin.annotator.annotations.setMode(ann, mode);
				else pending.mode = mode;
			});
		}
	});
}

/**
 * Selection menu, in the order and with the items configured in settings. `copyOnly` (the paragraph
 * under a right-clicked highlight): just a "Copy" heading and items that only copy, no color row.
 */
export function addSelectionItems(host: MenuHost<any, any>, menu: Menu, info: SelectionInfo, isParagraph = false, copyOnly = false): void {
	const { plugin, target } = host;
	const s = plugin.settings;
	const section = 'fpp-selection';
	const label = (title: string) => menu.addItem((i) => (i.setTitle(title) as any).setIsLabel?.(true).setSection?.(section));
	// With an annotation file, the Copy | Insert | Both row says what the items below do; otherwise they copy.
	const ann = (!copyOnly && target.file && plugin.annotator.annotations.find(target.file)) || null;
	// Without an annotation file the row starts on Copy; Insert / Both create the file when an item is picked.
	const pending: { mode: AnnotationMode } = { mode: 'copy' };
	if (!copyOnly) addActiveColorRow(host, menu, section);
	if (copyOnly) label('Copy');
	else {
		if (isParagraph) label('Paragraph');
		addAnnotationModeRow(plugin, menu, ann, section, pending);
	}
	const copy = (what: CopyTarget, color: string | null) => plugin.annotator.copy(target, info, what, color, copyOnly, ann ? undefined : pending.mode);
	for (const entry of s.selectionMenu) {
		if (!entry.show) continue;
		if (entry.id === 'link') {
			menu.addItem((i) => i.setTitle(SELECTION_MENU_LABELS.link).setIcon('link').setSection(section).onClick(() => copy('link', host.activeColor)));
		} else if (entry.id === 'alt-link') {
			menu.addItem((i) =>
				i
					.setTitle(altLinkLabel(s.linkType, plugin.format.linkTypeName))
					.setIcon('link-2')
					.setSection(section)
					.onClick(() => copy('alt-link', host.activeColor)),
			);
		} else if (entry.id === 'text') {
			menu.addItem((i) => i.setTitle(SELECTION_MENU_LABELS.text).setIcon('copy').setSection(section).onClick(() => copy('text', null)));
		} else if (entry.id.startsWith('format:')) {
			const fmt = s.copyFormats.find((f) => `format:${f.id}` === entry.id);
			if (!fmt) continue;
			const icon = plugin.annotator.asksForComment(fmt) ? 'message-square-quote' : fmt.name.toLowerCase().includes('callout') ? 'quote' : 'clipboard-copy';
			menu.addItem((i) =>
				i
					.setTitle(`${formatMenuLabel(fmt.name)}${plugin.annotator.asksForComment(fmt) ? '…' : ''}`)
					.setIcon(icon)
					.setSection(section)
					.onClick(() => copy(fmt, host.activeColor)),
			);
		}
	}
	if (!copyOnly) host.extendSelectionMenu?.(menu, info);
}

/** Highlight menu, in the order and with the items configured in settings. */
export function addHighlightItems(host: MenuHost<any, any>, menu: Menu, entries: HighlightEntry[]): void {
	const { plugin } = host;
	const order = plugin.settings.highlightMenu.filter((e) => e.show).map((e) => e.id);
	for (const entry of entries) {
		const section = `fpp-hl-${entry.id}`;
		const note = entry.sourcePath.split('/').pop()?.replace(/\.md$/, '') ?? entry.sourcePath;
		if (entries.length > 1) menu.addItem((i) => (i.setTitle(`Highlight in "${note}"`) as any).setIsLabel?.(true).setSection?.(section));
		// Picking a color recolors the highlight right away.
		if (order.includes('color'))
			addColorRow(plugin, menu, section, () => entry.color ?? null, (c) => {
				host.setActiveColor(c);
				void plugin.annotator.setHighlightColor(entry, c);
				menu.hide();
			});
		for (const id of order) {
			if (id === 'open') menu.addItem((i) => i.setTitle(`Open in "${note}"`).setIcon('file-text').setSection(section).onClick(() => host.openSource(entry)));
			else if (id === 'comment')
				menu.addItem((i) =>
					i
						.setTitle(entry.comment ? 'Edit comment' : 'Add comment')
						.setIcon(entry.comment ? 'message-square-text' : 'message-square-plus')
						.setSection(section)
						.onClick(() => host.editComment(entry)),
				);
			else if (id === 'copy-link')
				menu.addItem((i) =>
					i
						.setTitle('Copy link')
						.setIcon('link')
						.setSection(section)
						.onClick(async () => {
							await navigator.clipboard.writeText(entry.original);
							new Notice('Copied link to clipboard');
						}),
				);
			else if (id === 'delete')
				menu.addItem((i) =>
					i
						.setTitle('Delete highlight')
						.setIcon('trash-2')
						.setWarning(true)
						.setSection(section)
						// Shift-click deletes without asking, even when the highlight has a comment.
						.onClick((evt) => plugin.annotator.deleteHighlight(entry, evt.shiftKey)),
				);
		}
		host.extendHighlightMenu?.(menu, entry, section);
	}
}

/** Prompt for a highlight's comment (`quote`: its words) and write it into the note. */
export async function editHighlightComment(plugin: FilePlusPlusPlugin<any, any>, entry: HighlightEntry, quote: string): Promise<void> {
	const comment = await askForComment(plugin.app, quote, {
		title: entry.comment ? 'Edit comment' : 'Add comment',
		initial: entry.comment ?? '',
		submit: 'Save',
		vim: plugin.settings.commentVim,
		vimEscape: plugin.settings.commentVimEscape,
	});
	if (comment === null) return;
	await plugin.annotator.setHighlightComment(entry, comment);
}

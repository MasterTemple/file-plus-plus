import { Menu, Notice, type MenuItem, type TFile } from 'obsidian';
import type { DocumentReader, HighlightSpec } from '../core';
import { ANNOTATION_MODES, type AnnotationMode, type HighlightGestureAction } from '../obsidian/settings';
import type { DocumentView } from '../obsidian/view';
import { askForComment } from './comment-modal';
import type { HighlightEntry } from './highlight-index';
import { stepHighlight } from './highlight-steps';

/**
 * The annotator's part of a document's view: drawing the highlights (links from notes) and their
 * comments in the margin, the highlight menu, comments, mobile gestures on highlights, and the
 * copy/insert row of the selection menu. The view owns one (`view.annotations`).
 */
export class ViewAnnotator<Doc = unknown, R extends DocumentReader = DocumentReader> {
	constructor(readonly view: DocumentView<Doc, R>) {}

	refreshHighlights(): void {
		if (!this.view.reader || !this.view.file) return;
		const all = this.view.plugin.annotator.index.get(this.view.file.path);
		const entries = this.view.plugin.settings.noColor === 'none' ? all.filter((e) => e.color) : all;
		const specs: HighlightSpec<HighlightEntry>[] = entries.map((e) => ({ id: e.id, locator: e.locator, color: e.color, data: e }));
		this.view.reader.setHighlights(specs);
		this.view.reader.setHighlightsHidden(this.view.plugin.settings.hideHighlights);
		this.view.sidebar.setHighlights(all);
		this.refreshMargin();
		this.reselect(all);
	}

	/** The highlight keys act on (`select-highlight`, or one just made with the keys), by id, and its passage (ids change as notes do) */
	private selected: string | null = null;
	private selectedRange: Range | null = null;
	/** `d` on a highlight with a comment: `y` deletes it (the notice that says so) */
	private confirmingDelete: Notice | null = null;
	/** A passage just highlighted with the keys: selected once its highlight is drawn (until `until`) */
	private toSelect: { range: Range; until: number } | null = null;
	private stopSelecting: (() => void) | null = null;

	/** Select a highlight for the keys (null: none) */
	select(id: string | null): void {
		const reader = this.view.reader;
		this.selected = id;
		this.confirmingDelete?.hide();
		this.confirmingDelete = null;
		this.stopSelecting?.();
		this.stopSelecting = null;
		const range = id ? (reader?.highlightRange(id) ?? null) : null;
		this.selectedRange = range?.cloneRange() ?? null;
		reader?.setSelectedHighlight(range);
		if (!range || !reader) return;
		// A click anywhere lets go
		const off = () => this.select(null);
		reader.doc.addEventListener('mousedown', off, { capture: true, once: true });
		this.stopSelecting = () => reader.doc.removeEventListener('mousedown', off, { capture: true });
	}

	/** Select the highlight of `range` once it's drawn (after the note is written and indexed) */
	selectWhenDrawn(range: Range): void {
		this.toSelect = { range: range.cloneRange(), until: Date.now() + 5000 };
		this.reselect(this.view.plugin.annotator.index.get(this.view.file?.path ?? ''));
	}

	/** After the highlights are drawn again: the selected one again, or the one waited for */
	private reselect(entries: HighlightEntry[]): void {
		const reader = this.view.reader;
		if (!reader) return;
		/** The highlight of a passage */
		const at = (range: Range) =>
			entries.find((e) => {
				const r = reader.highlightRange(e.id);
				return !!r && r.compareBoundaryPoints(Range.START_TO_START, range) === 0 && r.compareBoundaryPoints(Range.END_TO_END, range) === 0;
			});
		const wanted = this.toSelect;
		if (wanted && Date.now() < wanted.until) {
			const hit = at(wanted.range);
			if (hit) {
				this.toSelect = null;
				return this.select(hit.id);
			}
		} else this.toSelect = null;
		if (this.selected) this.select((this.selectedRange && at(this.selectedRange)?.id) ?? null);
	}

	/**
	 * A reader key while a highlight is selected: the number keys recolor it, `c` edits its comment,
	 * `d` deletes it (`d y` with a comment), Escape lets go. True: the key was used. A highlight
	 * scrolled out of view isn't selected anymore.
	 */
	handleKey(chord: string): boolean {
		const { reader, plugin } = this.view;
		if (!this.selected || !reader) return false;
		const entry = plugin.annotator.index.get(this.view.file?.path ?? '').find((e) => e.id === this.selected);
		const range = reader.highlightRange(this.selected);
		if (!entry || !range || !reader.lineOnScreen(range)) {
			this.select(null);
			return false;
		}
		if (this.confirmingDelete) {
			this.confirmingDelete.hide();
			this.confirmingDelete = null;
			if (chord === 'y') {
				this.select(null);
				void plugin.annotator.deleteHighlight(entry, true);
			} else plugin.notice('kept the highlight.', 1500);
			return true;
		}
		const s = plugin.settings;
		if (chord === 'Escape') this.select(null);
		else if (s.numberKeyColors && /^\d$/.test(chord)) {
			const n = Number(chord);
			const color = n === 0 ? null : s.palette[n - 1]?.name;
			if (color === undefined) return false;
			this.view.setActiveColor(color);
			void plugin.annotator.setHighlightColor(entry, color);
		} else if (chord === 'c') void this.editComment(entry);
		else if (chord === 'd') {
			if (entry.comment) {
				this.confirmingDelete = plugin.notice('this highlight has a comment: y deletes both, any other key keeps them.', 0);
			} else {
				this.select(null);
				void plugin.annotator.deleteHighlight(entry, true);
			}
		} else return false;
		return true;
	}

	/** Show (or hide) comments in the margin, per settings; when there is no room they show on hover. */
	refreshMargin(): void {
		if (!this.view.reader?.isRendered || !this.view.file) return;
		const shown = new Set(this.view.reader.getHighlights().map((h) => h.id));
		const entries = this.view.plugin.annotator.index.get(this.view.file.path).filter((e) => shown.has(e.id));
		this.view.marginComments.update(entries, [...this.view.providerNotes.values()]);
	}

	/** The highlight `] h` / `] c` went to last, and where it starts on screen once there (null: not there yet). */
	private stepped: { id: string; top: number | null } | null = null;

	/**
	 * Go to the next (`by` 1) or previous (-1) highlight, or highlight with a comment: after the one
	 * gone to last, or, once the view has moved, after where it is.
	 */
	step(by: 1 | -1, comments: boolean): void {
		const { reader, plugin } = this.view;
		if (!reader?.isRendered) return;
		const items = reader
			.getHighlights()
			.filter((h) => !comments || (h.data as HighlightEntry | undefined)?.comment)
			.map((h) => ({ id: h.id, range: reader.highlightRange(h.id) }))
			.filter((h): h is { id: string; range: Range } => !!h.range)
			.sort((a, b) => a.range.compareBoundaryPoints(Range.START_TO_START, b.range) || a.range.compareBoundaryPoints(Range.END_TO_END, b.range));
		const what = comments ? 'comment' : 'highlight';
		if (!items.length) return void plugin.notice(`this ${plugin.format.noun} has no ${what}s yet.`, 2000);
		const topOf = (range: Range) => (range.getClientRects()[0] ?? range.getBoundingClientRect()).top;
		const at = this.stepped ? items.findIndex((h) => h.id === this.stepped!.id) : -1;
		const stayed = at >= 0 && (this.stepped!.top === null || Math.abs(topOf(items[at].range) - this.stepped!.top) < 2);
		const box = reader.scroller.getBoundingClientRect();
		const i = stepHighlight(items.length, by, stayed ? at : null, (k) => topOf(items[k].range), box.top + box.height * reader.centerLine);
		if (i === null) return void plugin.notice(by > 0 ? `no ${what}s after this.` : `no ${what}s before this.`, 1500);
		const { id, range } = items[i];
		const stepped = (this.stepped = { id, top: null as number | null });
		this.view.recordJump();
		reader.scrollToRange(range, { flash: { color: reader.highlightColor(id) ?? undefined }, position: 'center' });
		// Where it ended up, once scrollToRange's corrections (two frames) are done
		const win = reader.scroller.win;
		win.requestAnimationFrame(() => win.requestAnimationFrame(() => win.requestAnimationFrame(() => {
			if (this.stepped === stepped) stepped.top = topOf(range);
		})));
	}

	/** Mobile gestures on highlights (see settings). Several overlapping highlights open the menu. */
	runHighlightGesture(action: HighlightGestureAction, entries: HighlightEntry[], at: { x: number; y: number }): void {
		const entry = entries[0];
		if (!entry || action === 'none') return;
		if (entries.length > 1 && action !== 'select') action = 'menu';
		switch (action) {
			case 'open':
				void this.view.plugin.annotator.openSource(entry, this.view);
				break;
			case 'comment':
				void this.editComment(entry);
				break;
			case 'color':
				this.view.openColorMenu(at, entry.color ?? null, (c) => {
					this.view.setActiveColor(c);
					void this.view.plugin.annotator.setHighlightColor(entry, c);
				});
				break;
			case 'copy-link':
				void navigator.clipboard.writeText(entry.original).then(() => new Notice('Copied link to clipboard'));
				break;
			case 'select': {
				const range = this.view.reader?.highlightRange(entry.id);
				const block = range && (range.startContainer.nodeType === 1 ? (range.startContainer as Element) : range.startContainer.parentElement)?.closest('p, li, blockquote, h1, h2, h3, h4, h5, h6, dd, dt, figcaption, td, th, pre, div:not(.fpp-body):not(.fpp-section)');
				if (!block) break;
				const r = block.ownerDocument.createRange();
				r.selectNodeContents(block);
				const info = this.view.reader?.describeRange(r);
				if (info) {
					this.view.lastMenuLocator = info.locator;
					this.view.showSelectionMenu(info);
				}
				break;
			}
			case 'menu': {
				void this.view.commentCard.show(entries, 'top');
				const menu = new Menu();
				this.addHighlightItems(menu, entries);
				menu.onHide(() => {
					this.view.commentCard.hide();
					this.view.afterMenuHidden();
				});
				menu.showAtPosition(at);
				break;
			}
		}
	}

	/** Prompt for a highlight's comment and write it into the note. */
	async editComment(entry: HighlightEntry): Promise<void> {
		const quote = this.view.reader?.highlightRange(entry.id)?.toString().replace(/\s+/g, ' ').trim() ?? '';
		const comment = await askForComment(this.view.app, quote, {
			title: entry.comment ? 'Edit comment' : 'Add comment',
			initial: entry.comment ?? '',
			submit: 'Save',
			vim: this.view.plugin.settings.commentVim,
		});
		if (comment === null) return;
		await this.view.plugin.annotator.setHighlightComment(entry, comment);
	}

	/**
	 * `[Copy | Insert | Both]`: what the selection items do with the document's annotation file. Without
	 * one (`ann` null) the choice is kept in `pending` for this menu only.
	 */
	addAnnotationModeRow(menu: Menu, ann: TFile | null, section: string, pending: { mode: AnnotationMode }): void {
		menu.addItem((item) => {
			item.setSection(section);
			const dom = (item as MenuItem & { dom?: HTMLElement }).dom;
			if (!dom) return;
			dom.empty();
			dom.addClass('fpp-mode-row');
			dom.setAttr('aria-label', ann ? `When copying, for ${ann.basename}` : 'When copying (Insert and Both create an annotation file)');
			const labels: Record<AnnotationMode, string> = { copy: 'Copy', insert: 'Insert', both: 'Both' };
			const buttons: HTMLElement[] = [];
			const current = ann ? this.view.plugin.annotator.annotations.mode(ann) : pending.mode;
			for (const mode of ANNOTATION_MODES) {
				const b = dom.createDiv({ cls: 'fpp-mode-button', text: labels[mode] });
				b.toggleClass('is-active', mode === current);
				buttons.push(b);
				for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'touchstart', 'touchend'])
					b.addEventListener(type, (e) => e.stopPropagation());
				b.addEventListener('click', async (e) => {
					e.preventDefault();
					e.stopPropagation();
					buttons.forEach((x) => x.toggleClass('is-active', x === b));
					if (ann) await this.view.plugin.annotator.annotations.setMode(ann, mode);
					else pending.mode = mode;
				});
			}
		});
	}

	/** Highlight menu, in the order and with the items configured in settings. */
	addHighlightItems(menu: Menu, entries: HighlightEntry[]): void {
		const order = this.view.plugin.settings.highlightMenu.filter((e) => e.show).map((e) => e.id);
		for (const entry of entries) {
			const section = `fpp-hl-${entry.id}`;
			const note = entry.sourcePath.split('/').pop()?.replace(/\.md$/, '') ?? entry.sourcePath;
			if (entries.length > 1) menu.addItem((i) => (i.setTitle(`Highlight in "${note}"`) as any).setIsLabel?.(true).setSection?.(section));
			// Picking a color recolors the highlight right away.
			if (order.includes('color'))
				this.view.addColorRow(menu, section, () => entry.color ?? null, (c) => {
					this.view.setActiveColor(c);
					void this.view.plugin.annotator.setHighlightColor(entry, c);
					menu.hide();
				});
			for (const id of order) {
				if (id === 'open') menu.addItem((i) => i.setTitle(`Open in "${note}"`).setIcon('file-text').setSection(section).onClick(() => this.view.plugin.annotator.openSource(entry, this.view)));
				else if (id === 'comment')
					menu.addItem((i) =>
						i
							.setTitle(entry.comment ? 'Edit comment' : 'Add comment')
							.setIcon(entry.comment ? 'message-square-text' : 'message-square-plus')
							.setSection(section)
							.onClick(() => this.editComment(entry)),
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
							.onClick((evt) => this.view.plugin.annotator.deleteHighlight(entry, evt.shiftKey)),
					);
			}
			this.view.extendHighlightMenuFor(menu, entry, section);
		}
	}
}

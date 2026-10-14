import { MarkdownView, Notice, Platform, TFile } from 'obsidian';
import { highlightInContext, type DocumentReader, type SelectionInfo } from '../core';
import type { Annotation } from '../obsidian/api';
import { linkTimestamp, renderTemplate, setCalloutColor, setLinkColor, touchLink, UPDATED_PARAM } from '../obsidian/link-utils';
import type { CopyTarget, FilePlusPlusPlugin } from '../obsidian/plugin';
import { COMMENT_TEMPLATE, needsComment, type AnnotationMode, type CopyAction } from '../obsidian/settings';
import type { DocumentView } from '../obsidian/view';
import { AnnotationFolderModal } from './annotation-folder';
import { Annotations } from './annotations';
import { askForComment, confirmDeleteHighlight } from './comment-modal';
import { getComment, removeHighlight, setComment } from './comment-utils';
import { HighlightIndex, type HighlightEntry } from './highlight-index';
import { ImportModal } from './import';

/**
 * The note-taking layer over the viewer: links from notes into a document are its highlights (the
 * index), with comments in callouts, colors and timestamps in the links; selections are copied as
 * links or templates and inserted into annotation files; other plugins' annotations can be saved as
 * highlights; the Backlinks pane points at highlights. The plugin owns one (`plugin.annotator`).
 */
export class Annotator<Doc = unknown, R extends DocumentReader = DocumentReader> {
	/** Links from notes into the format's documents. */
	index!: HighlightIndex;
	readonly annotations: Annotations;
	private calloutStyle: HTMLStyleElement | null = null;

	constructor(readonly plugin: FilePlusPlusPlugin<Doc, R>) {
		this.annotations = new Annotations(plugin as unknown as FilePlusPlusPlugin);
	}

	/** Called from the plugin's `onload`. */
	load(): void {
		const { plugin } = this;
		this.index = new HighlightIndex(plugin.app, plugin.format.extensions, plugin.format.schemes);
		this.registerIndexEvents();
		this.registerCommands();
		this.updateCalloutStyles();
		this.registerBacklinkHover();
	}

	unload(): void {
		this.calloutStyle?.remove();
	}

	private registerIndexEvents(): void {
		const { plugin } = this;
		const { metadataCache, vault, workspace } = plugin.app;
		workspace.onLayoutReady(() => {
			const ready = () => this.index.rebuild();
			// resolvedLinks is only complete after the initial resolve pass.
			if ((metadataCache as any).initialized === false) plugin.registerEvent(metadataCache.on('resolved', ready));
			ready();
		});
		plugin.registerEvent(metadataCache.on('changed', (file) => file.extension === 'md' && this.index.indexFile(file)));
		plugin.registerEvent(metadataCache.on('deleted', (file) => this.index.removeSource(file.path, true)));
		let rebuildTimer = 0;
		plugin.registerEvent(
			vault.on('rename', (file, oldPath) => {
				if (!(file instanceof TFile)) return;
				if (file.extension === 'md') {
					this.index.removeSource(oldPath, true);
					this.index.indexFile(file);
				} else if (plugin.format.extensions.includes(file.extension.toLowerCase())) {
					window.clearTimeout(rebuildTimer);
					rebuildTimer = window.setTimeout(() => this.index.rebuild(), 1000);
				}
			}),
		);
	}

	private registerCommands(): void {
		this.plugin.addCommand({ id: 'annotation-file', name: 'Open or create annotation file', checkCallback: this.plugin.withViewCommand((v) => this.openAnnotationFile(v)) });
		this.plugin.addCommand({ id: 'annotation-folder', name: 'Change annotation folder…', callback: () => new AnnotationFolderModal(this.plugin.app, this.plugin as unknown as FilePlusPlusPlugin).open() });
		this.plugin.addCommand({ id: 'import-json', name: 'Import highlights from JSON…', callback: () => new ImportModal(this.plugin.app, this.plugin as unknown as FilePlusPlusPlugin).open() });
		// A .json file's menu offers to import it.
		this.plugin.registerEvent(
			this.plugin.app.workspace.on('file-menu', (menu, file) => {
				if (!(file instanceof TFile) || file.extension.toLowerCase() !== 'json') return;
				menu.addItem((i) =>
					i
						.setTitle(`Import highlights into ${this.plugin.manifest.name}…`)
						.setIcon('import')
						.onClick(async () => new ImportModal(this.plugin.app, this.plugin as unknown as FilePlusPlusPlugin, await this.plugin.app.vault.read(file)).open()),
				);
			}),
		);
		this.plugin.addCommand({
			id: 'toggle-highlights',
			name: 'Show / hide highlights',
			callback: () => void this.setHighlightsHidden(!this.plugin.settings.hideHighlights),
		});
		this.plugin.addCommand({
			id: 'toggle-margin-comments',
			name: 'Toggle comments in the margin',
			callback: () => {
				const v = this.plugin.activeView();
				if (v) void v.setCommentsShown(!v.showsComments());
				else void this.setMarginComments(!this.plugin.settings.marginComments);
				const shown = v ? v.showsComments() : this.plugin.settings.marginComments;
				if (shown && v?.reader && !v.marginComments.visible) this.plugin.notice(v.plugin.annotator.index.get(v.file?.path ?? '').some((e) => e.comment) ? 'the pane is too narrow for comments in the margin.' : `this ${this.plugin.format.noun} has no comments yet.`);
			},
		});
		for (const [id, name, by, comments] of [
			['next-highlight', 'Go to the next highlight', 1, false],
			['previous-highlight', 'Go to the previous highlight', -1, false],
			['next-comment', 'Go to the next comment', 1, true],
			['previous-comment', 'Go to the previous comment', -1, true],
		] as const)
			this.plugin.addCommand({
				id,
				name,
				checkCallback: (checking) => {
					const v = this.plugin.activeView();
					if (!v?.reader) return false;
					if (!checking) v.annotations.step(by, comments);
					return true;
				},
			});
		const copyCommand = (id: string, title: string, target: () => CopyTarget | null) =>
			this.plugin.addCommand({
				id,
				name: title,
				checkCallback: (checking) => {
					const v = this.plugin.activeView();
					const sel = v?.reader?.getSelection();
					const what = target();
					if (!v || !sel || !what) return false;
					if (!checking) this.copy(v, sel, what, v.activeColor);
					return true;
				},
			});
		copyCommand('copy-text', 'Copy selection as text', () => 'text');
		copyCommand('copy-link', 'Copy link to selection', () => 'link');
		copyCommand('copy-alt-link', `Copy alternate link to selection (${this.plugin.format.linkTypeName} ↔ text fragment)`, () => 'alt-link');
		this.syncFormatCommands = () => {
			const commands = (this.plugin.app as any).commands;
			for (const id of this.formatCommandIds) commands?.removeCommand?.(`${this.plugin.manifest.id}:${id}`);
			this.formatCommandIds = [];
			for (const fmt of this.plugin.settings.copyFormats) {
				const id = `copy-format-${fmt.id}`;
				copyCommand(id, `Copy selection as ${fmt.name.toLowerCase()}`, () => this.plugin.settings.copyFormats.find((f) => f.id === fmt.id) ?? null);
				this.formatCommandIds.push(id);
			}
		};
		this.syncFormatCommands();
	}

	/** Re-register the per-format copy commands (after formats are added, renamed or removed). Hotkeys are kept by id. */
	syncFormatCommands: () => void = () => {};
	private formatCommandIds: string[] = [];

	/** Show or hide highlights in every open document (comments in the margin are separate); the sidebar still lists them. */
	async setHighlightsHidden(hidden: boolean): Promise<void> {
		this.plugin.settings.hideHighlights = hidden;
		await this.plugin.saveSettings();
		for (const v of this.plugin.views()) v.refreshHighlights();
	}

	/** Show or hide comments in the margin of every open document. */
	async setMarginComments(on: boolean): Promise<void> {
		this.plugin.settings.marginComments = on;
		await this.plugin.saveSettings();
		// Shown everywhere: also where a link hid them
		if (on) for (const v of this.plugin.views()) v.commentsHidden = false;
		// Also re-renders the sidebar's toggle buttons.
		for (const v of this.plugin.views()) v.refreshHighlights();
	}

	/** What "Save as highlight" inserts: the chosen format, else the first one without a comment. */
	saveFormat(): CopyTarget {
		return this.resolveCopyAction(this.plugin.settings.saveAnnotationAs) ?? this.plugin.settings.copyFormats.find((f) => !needsComment(f.template)) ?? 'link';
	}

	/**
	 * Turn another plugin's annotation into a real highlight: insert it into the document's annotation
	 * file (created if needed), as the "save as" format or, with a comment, the comment format.
	 */
	async saveAnnotation(view: DocumentView<Doc, R>, layerId: string, annotation: Annotation, color: string | null, withComment: boolean): Promise<void> {
		const range = view.reader?.layerRange(layerId, annotation.id);
		const info = range && view.reader?.describeRange(range);
		if (!info || !view.file) {
			this.plugin.notice(`could not find this passage in the ${this.plugin.format.noun}.`);
			return;
		}
		let what: CopyTarget | null;
		let comment = '';
		if (withComment) {
			const c = await askForComment(this.plugin.app, info.text);
			if (c === null) return;
			comment = c;
			what = this.plugin.settings.copyFormats.find((f) => needsComment(f.template)) ?? { id: '', name: 'Callout with comment', template: COMMENT_TEMPLATE };
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
			this.plugin.notice((e as Error).message);
		}
	}

	/** Callout colors in notes follow the palette (`[!quote|yellow]`). */
	updateCalloutStyles(): void {
		this.calloutStyle ??= document.head.createEl('style', { attr: { id: `${this.plugin.manifest.id}-callouts` } });
		this.calloutStyle.textContent = this.plugin.settings.palette
			.map((p) => {
				const rgb = toRgb(p.color);
				return rgb ? `.callout[data-callout-metadata="${CSS.escape(p.name)}"] { --callout-color: rgb(${rgb}); }` : '';
			})
			.join('\n');
	}

	/** Open the note containing a highlight's link, at the link's line. */
	async openSource(entry: HighlightEntry, fromView?: DocumentView<Doc, R>): Promise<void> {
		const file = this.plugin.app.vault.getFileByPath(entry.sourcePath);
		if (!file) return;
		const { workspace } = this.plugin.app;
		const eState = { line: entry.position.start.line };
		let leaf = workspace.getLeavesOfType('markdown').find((l) => (l.view as MarkdownView).file?.path === file.path) ?? null;
		if (leaf) {
			await workspace.revealLeaf(leaf);
			workspace.setActiveLeaf(leaf, { focus: true });
			leaf.setEphemeralState(eState);
		} else {
			const target = this.plugin.settings.openNoteIn;
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
		const file = this.plugin.app.vault.getFileByPath(entry.sourcePath);
		if (!file || comment.trim() === (entry.comment ?? '')) return;
		let failed = false;
		await this.plugin.app.vault.process(file, (data) => {
			let start = entry.position.start.offset;
			if (data.slice(start, entry.position.end.offset) !== entry.original) {
				start = data.indexOf(entry.original);
				if (start === -1) {
					failed = true;
					return data;
				}
			}
			const end = start + entry.original.length;
			const stamped = this.stamp(entry.original);
			const next = data.slice(0, start) + stamped + data.slice(end);
			const line = next.slice(0, start).split('\n').length - 1;
			return setComment(next.split('\n'), line, comment, entry.color ?? null).join('\n');
		});
		if (failed) this.plugin.notice('could not find the link in the note (it may have changed).');
	}

	/**
	 * Delete a highlight: its link (with the callout around it, and its comment) from the note.
	 * Asks first when it has a comment, unless `force`.
	 */
	async deleteHighlight(entry: HighlightEntry, force = false): Promise<void> {
		const file = this.plugin.app.vault.getFileByPath(entry.sourcePath);
		if (!file) return;
		const data = await this.plugin.app.vault.read(file);
		const at = findLink(data, entry);
		if (at === -1) return void this.plugin.notice('could not find the link in the note (it may have changed).');
		const comment = getComment(data.split('\n'), data.slice(0, at).split('\n').length - 1);
		if (comment && !force && !(await confirmDeleteHighlight(this.plugin.app, comment))) return;
		let failed = false;
		await this.plugin.app.vault.process(file, (d) => {
			const start = findLink(d, entry);
			if (start === -1) {
				failed = true;
				return d;
			}
			return removeHighlight(d, start, start + entry.original.length);
		});
		if (failed) this.plugin.notice('could not find the link in the note (it may have changed).');
	}

	/** Rewrite the `&color=` parameter (and enclosing callout color) of a highlight's link in its note. */
	async setHighlightColor(entry: HighlightEntry, color: string | null): Promise<void> {
		const file = this.plugin.app.vault.getFileByPath(entry.sourcePath);
		if (!file) return;
		let failed = false;
		await this.plugin.app.vault.process(file, (data) => {
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
			const updated = this.stamp(setLinkColor(entry.original, color));
			const next = data.slice(0, start) + updated + data.slice(end);
			const lineNo = next.slice(0, start).split('\n').length - 1;
			return setCalloutColor(next.split('\n'), lineNo, color).join('\n');
		});
		if (failed) this.plugin.notice('could not find the link in the note (it may have changed).');
	}

	/** A highlight's link with `&updated=` set to now (when links carry timestamps). */
	private stamp(link: string): string {
		return this.plugin.settings.timestampInLinks ? touchLink(link) : link;
	}

	/** Build a link to a selection. `alternate` swaps the configured link type (the format's ↔ text fragment). */
	buildLink(view: DocumentView<Doc, R>, info: SelectionInfo, color: string | null, alternate = false, extra: Record<string, string> = {}, updated?: Date | null): string {
		const useText = (this.plugin.settings.linkType === 'text') !== alternate;
		const locator = (useText && info.textFragment()) || info.locator;
		const alias = renderTemplate(this.plugin.settings.aliasTemplate, { ...this.templateVars(view, info, color, ''), ...extra });
		const params = { [UPDATED_PARAM]: this.plugin.settings.timestampInLinks ? linkTimestamp(updated ?? undefined) : undefined };
		return this.plugin.documentLink(view.file!, locator, alias, this.plugin.settings.colorInLinks ? color : null, undefined, params);
	}

	/** The selection's text as copied: Markdown converted from the document's HTML, or plain text. */
	selectionText(info: SelectionInfo): string {
		if (!this.plugin.settings.copyMarkdown) return info.text;
		try {
			return info.markdown() || info.text;
		} catch (e) {
			console.warn('[fpp] markdown conversion failed', e);
			return info.text;
		}
	}

	/** The selection marked `==…==` in its sentences (`{{context}}`) */
	contextText(info: SelectionInfo): string {
		try {
			return highlightInContext(info.context());
		} catch (e) {
			console.warn('[fpp] context failed', e);
			return `==${info.text.trim()}==`;
		}
	}

	templateVars(view: DocumentView<Doc, R>, info: SelectionInfo, color: string | null, link: string): Record<string, string> {
		const doc = view.document;
		const meta = doc && view.file ? this.plugin.format.info(doc, view.file) : null;
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
			...this.plugin.format.templateVars?.(info, doc),
		};
	}

	/** Resolve a copy action (`text`, `link`, `alt-link`, `format:<id>`) to what it copies. */
	resolveCopyAction(action: CopyAction): CopyTarget | null {
		if (action === 'text' || action === 'link' || action === 'alt-link') return action;
		const id = action.slice('format:'.length);
		return this.plugin.settings.copyFormats.find((f) => f.id === id) ?? null;
	}

	/**
	 * The clipboard text for a selection (synchronous, so it can run inside a `copy` event).
	 * `extra`: more template variables, e.g. `{{label}}` when saving another plugin's annotation.
	 */
	renderCopy(view: DocumentView<Doc, R>, info: SelectionInfo, what: CopyTarget, color: string | null, comment = '', extra: Record<string, string> = {}, updated?: Date | null): string {
		if (what === 'text') return this.selectionText(info);
		const link = this.buildLink(view, info, color, what === 'alt-link', extra, updated);
		if (typeof what === 'string') return link;
		const context = what.template.includes('{{context}}') ? this.contextText(info) : '';
		return renderTemplate(what.template, { ...this.templateVars(view, info, color, link), context, ...extra, comment });
	}

	/** True when copying with this target first asks for a comment ({{comment}} in the template). */
	asksForComment(what: CopyTarget): boolean {
		return typeof what === 'object' && needsComment(what.template);
	}

	copyLabel(what: CopyTarget): string {
		if (what === 'text') return 'text';
		if (what === 'link') return 'link';
		if (what === 'alt-link') return this.plugin.settings.linkType === 'primary' ? 'text-fragment link' : `${this.plugin.format.linkTypeName} link`;
		return what.name.toLowerCase();
	}

	/**
	 * Copy (and/or insert into the annotation file, per its mode; `copyOnly` never inserts).
	 * `newFileMode`: for a document without an annotation file, Insert / Both create one first.
	 */
	async copy(view: DocumentView<Doc, R>, info: SelectionInfo, what: CopyTarget, color: string | null, copyOnly = false, newFileMode?: AnnotationMode): Promise<void> {
		let comment = '';
		if (this.asksForComment(what)) {
			const c = await askForComment(this.plugin.app, info.text);
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
				this.plugin.notice((e as Error).message);
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
			this.plugin.notice(`could not add to ${ann.basename}: ${(e as Error).message}`);
		}
	}

	/** Open (or reveal) a note, preferring another split than the document's. */
	async openNote(file: TFile, fromView?: DocumentView<Doc, R>): Promise<void> {
		const { workspace } = this.plugin.app;
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
			this.plugin.notice((e as Error).message);
		}
	}

	/**
	 * Hovering a match in Obsidian's Backlinks pane emphasizes the corresponding highlight in the
	 * document (like PDF++). Best-effort: matches by source file name and link text.
	 */
	private registerBacklinkHover(): void {
		let lastIds = '';
		this.plugin.registerDomEvent(document, 'mouseover', (e) => {
			const target = e.target as HTMLElement | null;
			const match = target?.closest?.('.workspace-leaf-content[data-type="backlink"] .search-result-file-match, .embedded-backlinks .search-result-file-match');
			const view = this.plugin.activeView() ?? this.plugin.views()[0];
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

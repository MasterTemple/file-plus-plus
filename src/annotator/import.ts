import { Modal, Notice, Setting, TFile, type App } from 'obsidian';
import { bookKey, commentKey, parseImport, sameText, textFragmentFor, type ImportEntry, type ParsedImport } from './import-utils';
import { needsComment, titleCase, type CopyAction, type ImportKind } from '../obsidian/settings';
import type { FilePlusPlusPlugin } from '../obsidian/plugin';
import type { DocumentView } from '../obsidian/view';

export interface BookImportResult {
	file: TFile;
	annotationFile: TFile | null;
	/** The annotation file was created by this import. */
	created: boolean;
	/** Highlights the import had for this document. */
	total: number;
	added: number;
	duplicates: number;
	/** Of a kind (with / without comment) that was turned off. */
	skipped: number;
	/** Found by their text because their locator didn't match it (e.g. another edition). */
	foundByText: number;
	/** Entries whose passage wasn't found in the document (`#3 "Call me…"`). */
	notFound: string[];
	error?: string;
}

export interface ImportSummary {
	books: BookImportResult[];
	/** Books named in the JSON that aren't in the vault, with how many highlights they had. */
	missing: { name: string; count: number }[];
}

/** Books left out before the import (e.g. not matched to a file by an importer), listed in its summary. */
export interface NotImported {
	name: string;
	count: number;
	/** Why, e.g. "Skipped" or "Not matched to a file". */
	reason: string;
	/** Left out on purpose (shown as skipped, not as missed). */
	skipped?: boolean;
}

export interface ImportModalOptions {
	notImported?: NotImported[];
}

/** The format's files the JSON's book names refer to (by path, file name, or name without extension). */
export function resolveBooks(plugin: FilePlusPlusPlugin, entries: ImportEntry[], fallback: TFile | null): { byFile: Map<TFile, ImportEntry[]>; missing: Map<string, number> } {
	const files = plugin.app.vault.getFiles().filter((f) => plugin.format.extensions.includes(f.extension.toLowerCase()));
	const cache = new Map<string, TFile | null>();
	const find = (name: string): TFile | null => {
		if (!cache.has(name)) {
			const exact = plugin.resolveLink(name, '') ?? files.find((f) => f.path === name) ?? null;
			cache.set(name, exact ?? files.filter((f) => bookKey(f.path) === bookKey(name)).sort((a, b) => a.path.length - b.path.length)[0] ?? null);
		}
		return cache.get(name)!;
	};
	const byFile = new Map<TFile, ImportEntry[]>();
	const missing = new Map<string, number>();
	for (const e of entries) {
		const file = e.book ? find(e.book) : fallback;
		if (!file) {
			const name = e.book ?? '(no book given)';
			missing.set(name, (missing.get(name) ?? 0) + 1);
			continue;
		}
		const list = byFile.get(file) ?? [];
		list.push(e);
		byFile.set(file, list);
	}
	return { byFile, missing };
}

/** The open view of a document, opening it if needed, once its reader has rendered. */
async function viewFor(plugin: FilePlusPlusPlugin, file: TFile): Promise<DocumentView> {
	const find = () => plugin.views().find((v) => v.file?.path === file.path);
	if (!find()?.reader) await plugin.openDocument(file, '');
	for (let i = 0; i < 600; i++) {
		const v = find();
		if (v?.reader?.isRendered) return v;
		await sleep(100);
	}
	throw new Error(`Could not open ${file.path}`);
}

/**
 * Import highlights into each document's annotation file (created if needed), in document order.
 * Skips highlights already in the vault (same passage and same comment, anywhere) or repeated in the
 * import, and kinds that are turned off.
 */
export async function importHighlights(plugin: FilePlusPlusPlugin, parsed: ImportEntry[], fallback: TFile | null, onProgress?: (msg: string) => void): Promise<ImportSummary> {
	const s = plugin.settings;
	const { byFile, missing } = resolveBooks(plugin, parsed, fallback);
	const books: BookImportResult[] = [];
	let n = 0;
	for (const [file, entries] of byFile) {
		onProgress?.(`${file.basename} (${++n} of ${byFile.size})…`);
		const result: BookImportResult = { file, annotationFile: null, created: false, total: entries.length, added: 0, duplicates: 0, skipped: 0, foundByText: 0, notFound: [] };
		books.push(result);
		try {
			const view = await viewFor(plugin, file);
			const reader = view.reader!;
			const passage = (range: Range) => reader.locatorFromRange(range) ?? range.toString();
			const seen = new Set<string>();
			for (const h of plugin.annotator.index.get(file.path)) {
				const r = reader.resolve(h.locator);
				if (r) seen.add(`${passage(r)}\u0000${commentKey(h.comment)}`);
			}
			const items: { info: NonNullable<ReturnType<typeof reader.describeRange>>; block: string }[] = [];
			for (const e of entries) {
				let range = reader.resolve(e.locator);
				// A different edition (or a stale locator): the passage isn't there, or reads differently. Find the text instead.
				if (e.text && (!range || !sameText(range.toString(), e.text))) {
					const byText = reader.resolve(textFragmentFor(e.text));
					if (byText) {
						range = byText;
						result.foundByText++;
					}
				}
				const info = range && reader.describeRange(range);
				if (!info) {
					const snippet = (e.text ?? e.comment).slice(0, 40);
					result.notFound.push(`#${e.index + 1}${snippet ? ` "${snippet}${snippet.length === 40 ? '…' : ''}"` : ''}`);
					continue;
				}
				const key = `${passage(info.range)}\u0000${commentKey(e.comment)}`;
				if (seen.has(key)) {
					result.duplicates++;
					continue;
				}
				seen.add(key);
				const kind = e.comment ? s.importComment : s.importPlain;
				if (!kind.enabled) {
					result.skipped++;
					continue;
				}
				let what = plugin.annotator.resolveCopyAction(kind.format) ?? 'link';
				if (what === 'text' || what === 'alt-link') what = 'link';
				items.push({ info, block: plugin.annotator.renderCopy(view, info, what, e.color, e.comment, {}, e.updated) });
			}
			if (!items.length) continue;
			let ann = plugin.annotator.annotations.find(file);
			if (!ann) {
				ann = await plugin.annotator.annotations.create(view);
				result.created = true;
			}
			result.annotationFile = ann;
			result.added = await plugin.annotator.annotations.insertMany(view, ann, items);
		} catch (err) {
			console.error('[fpp] import failed for', file.path, err);
			result.error = (err as Error).message;
		}
	}
	return { books, missing: [...missing].map(([name, count]) => ({ name, count })) };
}

const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));

/**
 * The import dialog: JSON pasted or from a file, which kinds to import and as what, then a summary.
 * `initial`: JSON to start with (e.g. a .json file's contents).
 */
export class ImportModal extends Modal {
	private json = '';
	private parsed: ParsedImport = { entries: [], errors: [] };
	private infoEl!: HTMLElement;
	private importButton: HTMLButtonElement | null = null;
	/** Entries without a book go to the document open when the dialog opened. */
	private readonly fallback: TFile | null;

	constructor(
		app: App,
		private plugin: FilePlusPlusPlugin,
		initial = '',
		private options: ImportModalOptions = {},
	) {
		super(app);
		this.json = initial;
		this.fallback = plugin.activeView()?.file ?? null;
	}

	override onOpen(): void {
		const { contentEl, plugin } = this;
		const { format } = plugin;
		this.modalEl.addClass('fpp-import-modal');
		this.titleEl.setText('Import highlights from JSON');

		contentEl.createEl('p', {
			cls: 'setting-item-description',
			text: `A list of highlights, each with its ${format.noun} ("book": path or file name), passage ("cfi", "locator", "textFragment", or just "text"), and optionally "comment", "color" and "updated". They go into each ${format.noun}'s annotation file (created if needed), in ${format.noun} order. Highlights already in your notes with the same passage and comment are skipped.`,
		});
		const area = contentEl.createEl('textarea', { cls: 'fpp-import-json', attr: { rows: '8', placeholder: '[{ "book": "…", "cfi": "epubcfi(…)", "comment": "…", "color": "yellow" }]', spellcheck: 'false' } });
		area.value = this.json;
		area.addEventListener('input', () => this.setJson(area.value));
		const picker = contentEl.createEl('input', { attr: { type: 'file', accept: '.json,application/json' } });
		picker.style.display = 'none';
		picker.addEventListener('change', async () => {
			const f = picker.files?.[0];
			if (!f) return;
			area.value = await f.text();
			this.setJson(area.value);
		});
		new Setting(contentEl).setName('From a file').addButton((b) => b.setButtonText('Choose file…').onClick(() => picker.click()));
		this.infoEl = contentEl.createDiv('fpp-import-info');

		const kind = (name: string, desc: string, current: ImportKind, comment: boolean, save: (k: ImportKind) => void) => {
			const options: [CopyAction, string][] = [];
			for (const f of plugin.settings.copyFormats) if (needsComment(f.template) === comment) options.push([`format:${f.id}`, titleCase(f.name)]);
			if (!comment) options.push(['link', 'Link']); // last, so a missing format falls back to a real one
			const setting = new Setting(contentEl).setName(name).setDesc(desc);
			let dropdown: { setDisabled(d: boolean): unknown } | null = null;
			setting.addToggle((t) =>
				t.setValue(current.enabled).onChange((v) => {
					save({ ...current, enabled: (current.enabled = v) });
					dropdown?.setDisabled(!v);
				}),
			);
			setting.addDropdown((d) => {
				dropdown = d;
				for (const [value, label] of options) d.addOption(value, `Insert as ${label}`);
				if (!options.some(([v]) => v === current.format) && options[0]) current.format = options[0][0];
				d.setValue(current.format)
					.setDisabled(!current.enabled)
					.onChange((v) => save({ ...current, format: (current.format = v as CopyAction) }));
			});
		};
		const s = plugin.settings;
		kind('No comment', 'Highlights without a comment.', s.importPlain, false, (k) => {
			s.importPlain = k;
			void plugin.saveSettings();
		});
		kind('Comment', 'Highlights with a comment (formats with {{comment}}).', s.importComment, true, (k) => {
			s.importComment = k;
			void plugin.saveSettings();
		});

		new Setting(contentEl)
			.addButton((b) => b.setButtonText('Cancel').onClick(() => this.close()))
			.addButton((b) => {
				this.importButton = b.buttonEl;
				b.setButtonText('Import')
					.setCta()
					.onClick(() => void this.run());
			});
		this.setJson(this.json);
	}

	private setJson(json: string): void {
		this.json = json;
		this.parsed = json.trim() ? parseImport(json) : { entries: [], errors: [] };
		this.renderInfo();
	}

	private renderInfo(): void {
		const el = this.infoEl;
		el.empty();
		const { entries, errors } = this.parsed;
		const noun = this.plugin.format.noun;
		if (this.importButton) this.importButton.disabled = !entries.length;
		if (!this.json.trim()) return;
		if (entries.length) {
			const { byFile, missing } = resolveBooks(this.plugin, entries, this.fallback);
			const withComment = entries.filter((e) => e.comment).length;
			el.createDiv({ text: `${entries.length} highlight${entries.length === 1 ? '' : 's'} (${withComment} with a comment) for ${byFile.size} ${noun}${byFile.size === 1 ? '' : 's'}:` });
			const list = el.createEl('ul');
			for (const [file, list2] of byFile) list.createEl('li', { text: `${file.path}: ${list2.length}` });
			for (const [name, count] of missing) list.createEl('li', { cls: 'fpp-import-missing', text: `${name}: ${count} — not found in the vault, skipped` });
		}
		if (errors.length) {
			const e = el.createDiv({ cls: 'fpp-import-errors' });
			e.createDiv({ text: `${errors.length} problem${errors.length === 1 ? '' : 's'} (left out):` });
			const ul = e.createEl('ul');
			for (const msg of errors.slice(0, 10)) ul.createEl('li', { text: msg });
			if (errors.length > 10) ul.createEl('li', { text: `…and ${errors.length - 10} more` });
		}
	}

	private async run(): Promise<void> {
		const { entries } = this.parsed;
		if (!entries.length) return;
		const { contentEl } = this;
		contentEl.empty();
		const status = contentEl.createDiv({ cls: 'fpp-import-info', text: 'Importing…' });
		const summary = await importHighlights(this.plugin, entries, this.fallback, (msg) => status.setText(`Importing ${msg}`));
		contentEl.empty();
		this.renderSummary(summary);
	}

	private renderSummary({ books, missing }: ImportSummary): void {
		const { contentEl, plugin } = this;
		const noun = plugin.format.noun;
		const sum = (f: (b: BookImportResult) => number) => books.reduce((n, b) => n + f(b), 0);
		const added = sum((b) => b.added);
		const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
		this.titleEl.setText(`Imported ${plural(added, 'highlight')}`);
		const notImported = this.options.notImported ?? [];
		const outside: NotImported[] = [...missing.map((m) => ({ ...m, reason: 'Not in the vault' })), ...notImported];

		const totals = { total: sum((b) => b.total), added, duplicates: sum((b) => b.duplicates), skipped: sum((b) => b.skipped), notFound: sum((b) => b.notFound.length) };
		const left = outside.reduce((n, o) => n + o.count, 0);
		const parts = [added ? `${plural(added, 'highlight')} added to ${plural(books.filter((b) => b.added).length, noun)}` : 'Nothing new added'];
		if (totals.duplicates) parts.push(`${totals.duplicates} already there`);
		if (totals.skipped) parts.push(`${totals.skipped} of a kind turned off`);
		if (totals.notFound) parts.push(`${totals.notFound} not found`);
		if (left) parts.push(`${left} in ${plural(outside.length, noun)} not imported`);
		contentEl.createDiv({ cls: 'fpp-import-info', text: `${parts.join(' · ')}.` });

		const wrap = contentEl.createDiv('fpp-import-table-wrap');
		const table = wrap.createEl('table', { cls: 'fpp-import-table' });
		const head = table.createEl('thead').createEl('tr');
		const columns: [string, string][] = [
			[titleCase(noun), ''],
			['In import', 'Highlights the import had for it'],
			['Added', 'Inserted into its annotation file'],
			['Already there', 'The same passage and comment were already in your notes (or repeated in the import)'],
			['Turned off', 'Of a kind (with / without comment) that is turned off'],
			['Not found', `The passage isn't in the ${noun}`],
		];
		for (const [name, tip] of columns) head.createEl('th', { text: name, attr: tip ? { 'aria-label': tip } : {} });
		const body = table.createEl('tbody');
		const cell = (tr: HTMLElement, n: number, cls: string) => tr.createEl('td', { cls: n ? cls : 'is-zero', text: n ? String(n) : '–' });
		for (const b of books) {
			const tr = body.createEl('tr');
			if (b.error) tr.addClass('is-error');
			else if (b.notFound.length || b.skipped) tr.addClass('is-warning');
			const name = tr.createEl('td', { cls: 'fpp-import-book' });
			name.createDiv({ cls: 'fpp-import-book-name', text: b.file.basename });
			const sub = name.createDiv('fpp-import-book-note');
			if (b.annotationFile) {
				sub.appendText(b.created ? 'Created ' : 'In ');
				const a = sub.createEl('a', { text: b.annotationFile.basename, href: '#' });
				a.addEventListener('click', (e) => {
					e.preventDefault();
					this.close();
					void plugin.annotator.openNote(b.annotationFile!);
				});
			} else if (!b.error) sub.appendText(b.total === b.duplicates ? 'Nothing new' : 'Nothing added');
			if (b.foundByText) sub.appendText(`${sub.childNodes.length ? ' · ' : ''}${b.foundByText} located by their text`);
			if (b.error) name.createDiv({ cls: 'fpp-import-errors', text: `Failed: ${b.error}` });
			cell(tr, b.total, '');
			cell(tr, b.added, 'is-added');
			cell(tr, b.duplicates, 'is-duplicate');
			cell(tr, b.skipped, 'is-skipped');
			const nf = cell(tr, b.notFound.length, 'is-missed');
			if (b.notFound.length) {
				// The passages, in a row of their own under the book's.
				const detail = createEl('tr', { cls: 'fpp-import-detail' });
				detail.createEl('td', { attr: { colspan: String(columns.length) }, text: `Not found: ${b.notFound.slice(0, 30).join(', ')}${b.notFound.length > 30 ? ', …' : ''}` });
				detail.hidden = true;
				nf.addClass('is-expandable');
				nf.setAttr('aria-label', 'Show the passages');
				nf.addEventListener('click', () => {
					detail.hidden = !detail.hidden;
					nf.toggleClass('is-open', !detail.hidden);
				});
				tr.after(detail);
			}
		}
		for (const o of outside) {
			const skipped = !!o.skipped;
			const tr = body.createEl('tr', { cls: skipped ? 'is-outside is-skipped' : 'is-outside' });
			const name = tr.createEl('td', { cls: 'fpp-import-book' });
			name.createDiv({ cls: 'fpp-import-book-name', text: o.name });
			name.createDiv({ cls: 'fpp-import-book-note', text: o.reason });
			cell(tr, o.count, '');
			tr.createEl('td', { cls: 'fpp-import-left', text: skipped ? 'Skipped' : 'Not imported', attr: { colspan: String(columns.length - 2) } });
		}
		if (books.length + outside.length > 1) {
			const tr = table.createEl('tfoot').createEl('tr');
			tr.createEl('td', { text: 'Total' });
			cell(tr, totals.total + left, '');
			cell(tr, totals.added, 'is-added');
			cell(tr, totals.duplicates, 'is-duplicate');
			cell(tr, totals.skipped, 'is-skipped');
			cell(tr, totals.notFound, 'is-missed');
		}
		new Setting(contentEl).addButton((b) => b.setButtonText('Close').setCta().onClick(() => this.close()));
		new Notice(`${plugin.manifest.name}: imported ${plural(added, 'highlight')}`);
	}
}

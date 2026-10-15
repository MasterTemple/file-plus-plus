import { flattenToc, parseLocator, textFragmentScheme, type SelectionInfo } from '../core';
import { TFile, normalizePath, parseLinktext } from 'obsidian';
import { insertAnnotation, mergeAnnotationText, type Ordering, type Placement } from './annotation-utils';
import { linksIn, renderTemplate, retargetLinks } from '../obsidian/link-utils';
import type { FilePlusPlusPlugin } from '../obsidian/plugin';
import { ANNOTATION_MODES, type AnnotationMode } from '../obsidian/settings';
import type { DocumentView } from '../obsidian/view';
import type { NoteHistory } from './note-history';

/**
 * Annotation files: one markdown file per document with a heading per TOC entry. New annotations from
 * the document can be inserted there at the right place instead of (or as well as) being copied.
 */
export class Annotations {
	constructor(
		private plugin: FilePlusPlusPlugin,
		private history: NoteHistory,
	) {}

	private get app() {
		return this.plugin.app;
	}

	private get format() {
		return this.plugin.format;
	}

	/** Frontmatter property holding a file's mode (`epub-annotation-mode`). */
	get modeKey(): string {
		return `${this.format.frontmatterKey}-annotation-mode`;
	}

	/** The annotation file of a document: a note whose `<frontmatterKey>` property links to it. */
	find(target: TFile): TFile | null {
		const own = this.plugin.findAnnotationFile(target);
		if (own !== undefined) return own;
		const { metadataCache, vault } = this.app;
		for (const f of vault.getMarkdownFiles()) {
			const links = metadataCache.getFileCache(f)?.frontmatterLinks;
			if (!links) continue;
			for (const l of links) {
				if (l.key !== this.format.frontmatterKey) continue;
				const dest = metadataCache.getFirstLinkpathDest(parseLinktext(l.link).path, f.path);
				if (dest?.path === target.path) return f;
			}
		}
		return null;
	}

	/** The file's own mode (frontmatter) or the global default. */
	mode(file: TFile): AnnotationMode {
		const v = this.app.metadataCache.getFileCache(file)?.frontmatter?.[this.modeKey];
		return ANNOTATION_MODES.includes(v) ? v : this.plugin.settings.annotationMode;
	}

	async setMode(file: TFile, mode: AnnotationMode): Promise<void> {
		await this.app.fileManager.processFrontMatter(file, (fm) => {
			fm[this.modeKey] = mode;
		});
	}

	/** Create the annotation file for the document open in `view` (or return the existing one). */
	async create(view: DocumentView): Promise<TFile> {
		const target = view.file!;
		const existing = this.find(target);
		if (existing) return existing;
		const own = await this.plugin.createAnnotationFile(view as never);
		if (own) return own;
		const { reader, document: doc } = view;
		if (!reader || !doc) throw new Error(`The ${this.format.noun} is not loaded yet`);
		const s = this.plugin.settings;
		const { vault } = this.app;

		const folder = normalizePath(s.annotationFolder.trim() || target.parent?.path || '/');
		const info = this.format.info(doc, target);
		const vars = { book: info.title, title: info.title, author: info.author, file: target.basename };
		const name = sanitizeFileName(renderTemplate(s.annotationFileName, vars)) || `${target.basename} - Annotations`;
		let path = normalizePath(`${folder}/${name}.md`);
		for (let n = 2; vault.getAbstractFileByPath(path); n++) path = normalizePath(`${folder}/${name} ${n}.md`);
		if (folder !== '/' && !vault.getAbstractFileByPath(folder)) await vault.createFolder(folder);

		const linktext = this.app.metadataCache.fileToLinktext(target, path, false).replace(/"/g, '\\"');
		const lines = ['---', `${this.format.frontmatterKey}: "[[${linktext}]]"`, '---', ''];
		const items = this.format.annotationHeadings?.(reader.toc) ?? flattenToc(reader.toc);
		for (const item of items) {
			const label = item.label || 'Untitled';
			let heading = label;
			if (item.href) {
				const range = reader.resolve(item.href);
				range?.collapse(true);
				// A point locator: the heading links to the position without drawing a highlight.
				const locator = range && reader.locatorFromRange(range);
				if (locator) heading = this.plugin.documentLink(target, locator, label, null, path);
			}
			lines.push(`${'#'.repeat(Math.min(6, item.depth + 1))} ${heading}`, '');
		}
		return this.history.create(path, lines.join('\n'), 'the new annotation file');
	}

	/**
	 * How blocks of an annotation file are ordered: by the position of the first link into the format's
	 * files in them. Text-fragment links are located in the open document (when the setting allows).
	 */
	ordering(view: DocumentView): Ordering<unknown> {
		return this.orderingFor(view.file, this.plugin.settings.annotationResolveTextFragments ? view.reader : null);
	}

	/** `ordering` for a document, with or without a reader to locate text fragments in. */
	private orderingFor(target: TFile | null, resolveText: DocumentView['reader'] | null): Ordering<unknown> {
		const { schemes, position } = this.format;
		return {
			compare: (a, b) => position.compare(a, b),
			keyOf: (markdown) => {
				for (const link of linksIn(markdown)) {
					const { path, subpath } = parseLinktext(link);
					if (!subpath || !this.plugin.resolveLink(path, target?.path ?? '')) continue;
					const loc = parseLocator(subpath, schemes);
					if (!loc.locator) continue;
					if (loc.scheme === textFragmentScheme.id) {
						if (!resolveText) return null;
						const range = resolveText.resolve(loc.locator);
						const own = range && resolveText.locatorFromRange(range);
						return own ? position.key(own) : null;
					}
					return position.key(loc.locator);
				}
				const own = this.format.locatorOfText?.(markdown, target);
				return own ? position.key(own) : null;
			},
		};
	}

	/** Insert several rendered annotations at their places in the annotation file, in one write. */
	async insertMany(view: DocumentView, file: TFile, items: { info: SelectionInfo; block: string }[]): Promise<number> {
		const order = this.ordering(view);
		const keyed = items.map((it) => ({ ...it, key: this.format.position.key(it.info.locator) })).filter((it) => it.key !== null);
		await this.history.process(file, (data) => {
			for (const it of keyed) data = insertAnnotation(data, it.key, it.block, order).data;
			return data;
		}, 'the new highlights');
		return keyed.length;
	}

	/** Insert a rendered annotation at its place in the annotation file. */
	async insert(view: DocumentView, file: TFile, info: SelectionInfo, block: string): Promise<Placement> {
		const sel = this.format.position.key(info.locator);
		if (sel === null) throw new Error('The selection has no position');
		const order = this.ordering(view);
		let placement: Placement | null = null;
		await this.history.process(file, (data) => {
			const res = insertAnnotation(data, sel, block, order);
			placement = res.placement;
			return res.data;
		}, 'the new highlight');
		return placement!;
	}
	/** Every annotation file found by its `<frontmatterKey>` property, by document. */
	all(): Map<TFile, TFile[]> {
		const { metadataCache, vault } = this.app;
		const out = new Map<TFile, TFile[]>();
		for (const f of vault.getMarkdownFiles()) {
			for (const l of metadataCache.getFileCache(f)?.frontmatterLinks ?? []) {
				if (l.key !== this.format.frontmatterKey) continue;
				const dest = metadataCache.getFirstLinkpathDest(parseLinktext(l.link).path, f.path);
				if (!dest || !this.format.extensions.includes(dest.extension.toLowerCase())) continue;
				const list = out.get(dest) ?? [];
				list.push(f);
				out.set(dest, list);
				break;
			}
		}
		return out;
	}

	/** The folder annotation files of `target` go to for a folder setting (empty: next to the document). */
	folderFor(target: TFile, folder: string): string {
		return normalizePath(folder.trim() || target.parent?.path || '/');
	}

	/**
	 * What moving annotation files to `folder` does: per document, the file the others merge into (one
	 * already in the folder, or the first that moves there) and the files that move. With `everywhere`
	 * false, only files in the current folder (`annotationFolder`, or next to their document) move.
	 */
	planMove(folder: string, everywhere: boolean): FolderMove[] {
		const current = this.plugin.settings.annotationFolder;
		const plan: FolderMove[] = [];
		for (const [target, files] of this.all()) {
			const dest = this.folderFor(target, folder);
			const from = this.folderFor(target, current);
			const inDest = files.filter((f) => (f.parent?.path ?? '/') === dest);
			// Files from the current folder first: without one in `dest`, the first is the one kept.
			const moving = files
				.filter((f) => !inDest.includes(f) && (everywhere || (f.parent?.path ?? '/') === from))
				.sort((a, b) => Number((b.parent?.path ?? '/') === from) - Number((a.parent?.path ?? '/') === from));
			if (!moving.length && inDest.length < 2) continue;
			plan.push({ target, folder: dest, files: [...inDest, ...moving], moving });
		}
		return plan;
	}

	/** Move annotation files as `planMove` says, merging several of one document into one file. */
	async move(plan: FolderMove[]): Promise<{ moved: number; merged: number }> {
		const { vault, fileManager } = this.app;
		let moved = 0;
		let merged = 0;
		for (const { target, folder, files } of plan) {
			if (folder !== '/' && !vault.getAbstractFileByPath(folder)) await vault.createFolder(folder);
			const free = (name: string) => {
				let path = normalizePath(`${folder}/${name}.md`);
				for (let n = 2; vault.getAbstractFileByPath(path); n++) path = normalizePath(`${folder}/${name} ${n}.md`);
				return path;
			};
			const [base, ...rest] = files;
			if ((base.parent?.path ?? '/') !== folder) {
				await fileManager.renameFile(base, free(base.basename));
				moved++;
			}
			const order = this.orderingFor(target, null);
			for (const f of rest) {
				// Into the folder first, so Obsidian updates the links in it and to it.
				const sources = this.linkingTo(f);
				if ((f.parent?.path ?? '/') !== folder) await fileManager.renameFile(f, free(f.basename));
				const text = await vault.read(f);
				await vault.process(base, (data) => mergeAnnotationText(data, text, order));
				await this.relink(sources, f, base);
				await fileManager.trashFile(f);
				merged++;
			}
		}
		return { moved, merged };
	}

	/** Notes linking to `file` (other than itself). */
	private linkingTo(file: TFile): string[] {
		return Object.entries(this.app.metadataCache.resolvedLinks)
			.filter(([source, dests]) => dests[file.path] && source !== file.path)
			.map(([source]) => source);
	}

	/** Point links to `from` in `sources` at `to` instead. */
	private async relink(sources: string[], from: TFile, to: TFile): Promise<void> {
		const { metadataCache, vault } = this.app;
		for (const source of sources) {
			const file = vault.getFileByPath(source);
			if (!file) continue;
			const linktext = metadataCache.fileToLinktext(to, source, true);
			await vault.process(file, (data) => retargetLinks(data, (path) => metadataCache.getFirstLinkpathDest(path, source)?.path === from.path, linktext));
		}
	}
}

function sanitizeFileName(name: string): string {
	return name
		.replace(/[\\/:*?"<>|#^[\]]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

/** Annotation files of one document moving to `folder`: `files[0]` is the one the others merge into. */
export interface FolderMove {
	target: TFile;
	folder: string;
	files: TFile[];
	/** The files not yet in the folder. */
	moving: TFile[];
}

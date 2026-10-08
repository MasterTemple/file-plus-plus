import { flattenToc, parseLocator, textFragmentScheme, type SelectionInfo } from '../core';
import { TFile, normalizePath, parseLinktext } from 'obsidian';
import { insertAnnotation, type Ordering, type Placement } from './annotation-utils';
import { linksIn, renderTemplate } from './link-utils';
import type { FilePlusPlusPlugin } from './plugin';
import { ANNOTATION_MODES, type AnnotationMode } from './settings';
import type { DocumentView } from './view';

/**
 * Annotation files: one markdown file per document with a heading per TOC entry. New annotations from
 * the document can be inserted there at the right place instead of (or as well as) being copied.
 */
export class Annotations {
	constructor(private plugin: FilePlusPlusPlugin) {}

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
		return vault.create(path, lines.join('\n'));
	}

	/**
	 * How blocks of an annotation file are ordered: by the position of the first link into the format's
	 * files in them. Text-fragment links are located in the open document (when the setting allows).
	 */
	ordering(view: DocumentView): Ordering<unknown> {
		const { schemes, position } = this.format;
		const reader = view.reader;
		const resolveText = this.plugin.settings.annotationResolveTextFragments ? reader : null;
		return {
			compare: (a, b) => position.compare(a, b),
			keyOf: (markdown) => {
				for (const link of linksIn(markdown)) {
					const { path, subpath } = parseLinktext(link);
					if (!subpath || !this.plugin.resolveLink(path, view.file?.path ?? '')) continue;
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
				return null;
			},
		};
	}

	/** Insert a rendered annotation at its place in the annotation file. */
	async insert(view: DocumentView, file: TFile, info: SelectionInfo, block: string): Promise<Placement> {
		const sel = this.format.position.key(info.locator);
		if (sel === null) throw new Error('The selection has no position');
		const order = this.ordering(view);
		let placement: Placement | null = null;
		await this.app.vault.process(file, (data) => {
			const res = insertAnnotation(data, sel, block, order);
			placement = res.placement;
			return res.data;
		});
		return placement!;
	}
}

function sanitizeFileName(name: string): string {
	return name
		.replace(/[\\/:*?"<>|#^[\]]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

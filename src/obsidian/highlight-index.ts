import { isRangeLocator, parseLocator, type LocatorScheme } from '../core';
import { headingLabel, parseHeadings } from './annotation-utils';
import { getComment } from './comment-utils';
import { Events, TFile, parseLinktext, type App, type CachedMetadata, type Pos, type ReferenceCache } from 'obsidian';

export interface HighlightEntry {
	/** Stable within a session: `${sourcePath}:${offset}`. */
	id: string;
	/** The linked document. */
	targetPath: string;
	sourcePath: string;
	/** A range locator of one of the format's schemes (e.g. `epubcfi(...)`, `:~:text=...`). */
	locator: string;
	color?: string;
	subpath: string;
	displayText: string;
	original: string;
	position: Pos;
	/** Comment written next to the link in the note (see comment-utils), once loaded. */
	comment?: string | null;
	/** Label of the nearest heading above the link in its note (e.g. the annotation-file section). */
	heading?: string | null;
}

/**
 * Index of every link from a markdown note into a document of the format whose subpath is a range
 * locator. Each such link is rendered as a highlight in the document. Kept live through metadata
 * cache events.
 */
export class HighlightIndex extends Events {
	/** targetPath → sourcePath → entries */
	private byTarget = new Map<string, Map<string, HighlightEntry[]>>();
	/** sourcePath → set of target paths it links to */
	private bySource = new Map<string, Set<string>>();

	constructor(
		private app: App,
		private extensions: string[],
		private schemes: LocatorScheme[],
	) {
		super();
	}

	override on(name: 'changed', cb: (targetPaths: Set<string>) => void): ReturnType<Events['on']> {
		return super.on(name, cb as (...data: unknown[]) => unknown);
	}

	get(targetPath: string): HighlightEntry[] {
		const m = this.byTarget.get(targetPath);
		return m ? [...m.values()].flat() : [];
	}

	rebuild(): void {
		const affected = new Set<string>(this.byTarget.keys());
		this.byTarget.clear();
		this.bySource.clear();
		const resolved = this.app.metadataCache.resolvedLinks;
		for (const file of this.app.vault.getMarkdownFiles()) {
			const dests = resolved[file.path];
			if (dests && !Object.keys(dests).some((d) => this.extensions.includes(d.split('.').pop()!.toLowerCase()))) continue;
			for (const p of this.indexFile(file, false)) affected.add(p);
		}
		this.trigger('changed', affected);
	}

	/** Re-index one note. Returns the affected document paths. */
	indexFile(file: TFile, notify = true): Set<string> {
		const affected = this.removeSource(file.path);
		const cache = this.app.metadataCache.getFileCache(file);
		if (cache) {
			for (const e of this.extract(file.path, cache)) {
				let m = this.byTarget.get(e.targetPath);
				if (!m) this.byTarget.set(e.targetPath, (m = new Map()));
				let list = m.get(file.path);
				if (!list) m.set(file.path, (list = []));
				list.push(e);
				let s = this.bySource.get(file.path);
				if (!s) this.bySource.set(file.path, (s = new Set()));
				s.add(e.targetPath);
				affected.add(e.targetPath);
			}
		}
		if (notify && affected.size) this.trigger('changed', affected);
		if (cache && this.bySource.has(file.path)) void this.loadComments(file);
		return affected;
	}

	/** Comments need the note's text (not in the metadata cache): read it and attach them. */
	private async loadComments(file: TFile): Promise<void> {
		const text = await this.app.vault.cachedRead(file);
		const lines = text.split('\n');
		const headings = parseHeadings(lines);
		const affected = new Set<string>();
		for (const target of this.bySource.get(file.path) ?? []) {
			for (const e of this.byTarget.get(target)?.get(file.path) ?? []) {
				const comment = getComment(lines, e.position.start.line);
				let heading: string | null = null;
				for (const h of headings) if (h.line < e.position.start.line) heading = headingLabel(h.text);
				if (comment !== (e.comment ?? null) || heading !== (e.heading ?? null)) affected.add(target);
				e.comment = comment;
				e.heading = heading;
			}
		}
		if (affected.size) this.trigger('changed', affected);
	}

	removeSource(sourcePath: string, notify = false): Set<string> {
		const affected = new Set(this.bySource.get(sourcePath) ?? []);
		for (const target of affected) {
			const m = this.byTarget.get(target);
			m?.delete(sourcePath);
			if (m && !m.size) this.byTarget.delete(target);
		}
		this.bySource.delete(sourcePath);
		if (notify && affected.size) this.trigger('changed', affected);
		return affected;
	}

	private extract(sourcePath: string, cache: CachedMetadata): HighlightEntry[] {
		const out: HighlightEntry[] = [];
		const refs: ReferenceCache[] = [...(cache.links ?? []), ...(cache.embeds ?? [])];
		for (const ref of refs) {
			const entry = this.toEntry(sourcePath, ref);
			if (entry) out.push(entry);
		}
		return out;
	}

	private toEntry(sourcePath: string, ref: ReferenceCache): HighlightEntry | null {
		const { path, subpath } = parseLinktext(ref.link);
		if (!subpath) return null;
		const file = resolveFile(this.app, path, sourcePath, this.extensions);
		if (!file) return null;
		const loc = parseLocator(subpath, this.schemes);
		// Positions (e.g. annotation file headings, hrefs) are not highlights.
		if (!loc.locator || !isRangeLocator(loc, this.schemes)) return null;
		return {
			id: `${sourcePath}:${ref.position.start.offset}`,
			targetPath: file.path,
			locator: loc.locator,
			sourcePath,
			color: loc.params.color,
			subpath,
			displayText: ref.displayText ?? '',
			original: ref.original,
			position: ref.position,
		};
	}
}

/** Resolve a link path to a file with one of the extensions (tolerates percent-encoded markdown link paths). */
export function resolveFile(app: App, path: string, sourcePath: string, extensions: string[]): TFile | null {
	const tries = [path];
	try {
		const d = decodeURIComponent(path);
		if (d !== path) tries.push(d);
	} catch {
		/* ignore */
	}
	for (const p of tries) {
		const f = app.metadataCache.getFirstLinkpathDest(p, sourcePath);
		if (f && extensions.includes(f.extension.toLowerCase())) return f;
	}
	return null;
}

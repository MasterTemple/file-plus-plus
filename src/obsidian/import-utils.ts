/**
 * Importing highlights from JSON (pure logic, no Obsidian imports).
 *
 * The input is an array of highlights, or an object holding one (`highlights`, `annotations`, `items`).
 * Each highlight names its document and passage; the rest is optional:
 *
 *   {
 *     "book": "Moby Dick.epub",                 // or "file" / "path" / "title"; a path, file name, or name without extension
 *     "cfi": "epubcfi(/6/14!/4/2/4/6,/1:0,/1:76)", // or "locator" / "textFragment" (":~:text=…"), or only "text"
 *     "text": "It is a way I have of driving off the spleen",  // found in the document when there is no locator
 *     "comment": "The spleen line.",            // or "note"
 *     "color": "red",                           // a palette name or CSS color
 *     "updated": "2026-10-08T14:03:12Z"         // or "modified" / "created" / "date"; ISO 8601 or epoch ms
 *   }
 */

export interface ImportEntry {
	/** Index in the input (for messages). */
	index: number;
	/** The document as written in the JSON (resolved later), or null to use a default. */
	book: string | null;
	/** A locator of the format, or a text fragment built from `text`. */
	locator: string;
	/** The highlighted text, when given. */
	text: string | null;
	/** Trimmed; empty when there is none. */
	comment: string;
	color: string | null;
	updated: Date | null;
}

export interface ParsedImport {
	entries: ImportEntry[];
	/** Problems with single items (`#3: no locator or text`), which are left out. */
	errors: string[];
}

const pick = (o: Record<string, unknown>, keys: string[]): string | null => {
	for (const k of keys) {
		const v = o[k];
		if (typeof v === 'string' && v.trim()) return v.trim();
	}
	return null;
};

/** A locator from the JSON: `#` dropped, a bare CFI path (`/6/4!/…`) wrapped as `epubcfi(…)`. */
export function normalizeLocator(s: string): string {
	let l = s.trim().replace(/^#/, '');
	if (/^\/\d/.test(l)) l = `epubcfi(${l})`;
	if (/^text=/.test(l)) l = `:~:${l}`;
	return l;
}

/** A text fragment matching exactly `text` (commas and dashes can't be mistaken for its syntax). */
export function textFragmentFor(text: string): string {
	const enc = (t: string) => encodeURIComponent(t).replace(/-/g, '%2D');
	return `:~:text=${enc(text.replace(/\s+/g, ' ').trim())}`;
}

function parseDate(v: unknown): Date | null {
	if (typeof v === 'number' && isFinite(v)) return new Date(v < 1e11 ? v * 1000 : v); // seconds or ms
	if (typeof v !== 'string' || !v.trim()) return null;
	const d = new Date(v.trim());
	return isNaN(d.getTime()) ? null : d;
}

export function parseImport(json: string): ParsedImport {
	let data: unknown;
	try {
		data = JSON.parse(json);
	} catch (e) {
		return { entries: [], errors: [`Not valid JSON: ${(e as Error).message}`] };
	}
	const obj = data as Record<string, unknown>;
	const list = Array.isArray(data) ? data : [obj?.highlights, obj?.annotations, obj?.items].find(Array.isArray);
	if (!Array.isArray(list)) return { entries: [], errors: ['Expected a list of highlights (or an object with "highlights")'] };
	const entries: ImportEntry[] = [];
	const errors: string[] = [];
	list.forEach((item, index) => {
		if (!item || typeof item !== 'object') return void errors.push(`#${index + 1}: not an object`);
		const o = item as Record<string, unknown>;
		const text = pick(o, ['text', 'quote', 'highlight']);
		const loc = pick(o, ['cfi', 'locator', 'textFragment', 'fragment']);
		if (!loc && !text) return void errors.push(`#${index + 1}: no "cfi", "locator", "textFragment" or "text"`);
		const updated = parseDate(o.updated ?? o.modified ?? o.created ?? o.date);
		entries.push({
			index,
			book: pick(o, ['book', 'file', 'path', 'title']),
			locator: loc ? normalizeLocator(loc) : textFragmentFor(text!),
			text,
			comment: pick(o, ['comment', 'note']) ?? '',
			color: pick(o, ['color', 'colour']),
			updated,
		});
	});
	return { entries, errors };
}

/** Comments compare equal regardless of spacing and line breaks. */
export function commentKey(comment: string | null | undefined): string {
	return (comment ?? '').replace(/\s+/g, ' ').trim();
}

/** The name a book is referred to by, for matching: no folders, no extension, case-insensitive. */
export function bookKey(name: string): string {
	return name
		.split('/')
		.pop()!
		.replace(/\.[a-z0-9]{2,5}$/i, '')
		.trim()
		.toLowerCase();
}

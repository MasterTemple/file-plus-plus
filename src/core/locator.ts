/**
 * Locators are link subpaths into a document, PDF++ style: a locator followed by `&key=value`
 * parameters, e.g.
 *
 *   `#epubcfi(/6/4!/4/2,/1:0,/1:12)&color=yellow`
 *   `#:~:text=call%20me-,Ishmael&color=red`
 *   `#t=01:23.5,01:30&color=blue`
 *
 * Each format declares the locator schemes it understands, tried in order. The input may have been
 * percent-decoded once already (Obsidian decodes markdown link targets), or not at all.
 */

export interface LocatorScheme {
	/** e.g. `cfi`, `text`, `href`, `time`. */
	id: string;
	/**
	 * The locator at the start of `s` (without the leading `#`, possibly still percent-encoded) and
	 * what follows it, or null when `s` doesn't start with one of this scheme.
	 */
	match(s: string): { locator: string; rest: string } | null;
	/** True when the locator marks a passage (a highlight), false for a position. Default: false. */
	isRange?(locator: string): boolean;
}

export interface ParsedLocator {
	/** The scheme that matched, or null. */
	scheme: string | null;
	/** The locator, normalized by its scheme (e.g. `epubcfi(...)`, `:~:text=...`), or null. */
	locator: string | null;
	params: Record<string, string>;
}

export function safeDecode(s: string): string {
	try {
		return decodeURIComponent(s);
	} catch {
		return s;
	}
}

/** Text fragments (`:~:text=...`), understood in every format. */
export const textFragmentScheme: LocatorScheme = {
	id: 'text',
	match(s) {
		// Markdown links reach us after Obsidian's decodeURI, which leaves %3A / %2C encoded.
		const m = /^(?::~:|%3A~%3A)?(text=[^&]*)/i.exec(s);
		return m ? { locator: `:~:${m[1]}`, rest: s.slice(m[0].length) } : null;
	},
	isRange: () => true,
};

/** `&key=value` parameters. */
export function parseParams(s: string): Record<string, string> {
	const params: Record<string, string> = {};
	for (const part of s.split('&')) {
		if (!part) continue;
		const eq = part.indexOf('=');
		if (eq === -1) continue;
		params[safeDecode(part.slice(0, eq))] = safeDecode(part.slice(eq + 1));
	}
	return params;
}

export function parseLocator(input: string, schemes: LocatorScheme[]): ParsedLocator {
	const s = input.trim().replace(/^#/, '');
	for (const scheme of schemes) {
		const m = scheme.match(s);
		if (m) return { scheme: scheme.id, locator: m.locator, params: parseParams(m.rest) };
	}
	return { scheme: null, locator: null, params: parseParams(s) };
}

/** Build a subpath (without `#`) from a locator and params. */
export function formatLocator(locator: string, params: Record<string, string | undefined> = {}): string {
	let s = locator.replace(/^#/, '');
	for (const [k, v] of Object.entries(params)) if (v) s += `&${k}=${encodeURIComponent(v)}`;
	return s;
}

/** True when a parsed locator marks a passage (a highlight) rather than a position. */
export function isRangeLocator(loc: ParsedLocator, schemes: LocatorScheme[]): boolean {
	if (!loc.locator) return false;
	return !!schemes.find((s) => s.id === loc.scheme)?.isRange?.(loc.locator);
}

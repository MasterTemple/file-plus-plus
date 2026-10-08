/** Pure helpers for building and editing links in markdown (no Obsidian imports, unit-testable). */

/**
 * Percent-encode for a markdown link destination. Obsidian runs `decodeURI` on the destination, and
 * ignores markdown links whose destination contains a raw `:` (it treats them as URLs), so colons are
 * encoded as `%3A` (which `decodeURI` leaves alone; locator schemes accept it).
 */
export function mdEncode(s: string): string {
	return encodeURI(s).replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/:/g, '%3A');
}

export function sanitizeAlias(s: string, style: 'wiki' | 'markdown'): string {
	const oneLine = s.replace(/\s+/g, ' ').trim();
	return style === 'wiki' ? oneLine.replace(/[|\[\]#^]/g, ' ').replace(/\s+/g, ' ').trim() : oneLine.replace(/([\[\]])/g, '\\$1');
}

export function formatLink(linktext: string, subpath: string, alias: string, style: 'wiki' | 'markdown'): string {
	const a = sanitizeAlias(alias, style);
	if (style === 'wiki') return `[[${linktext}${subpath ? `#${subpath}` : ''}${a ? `|${a}` : ''}]]`;
	return `[${a || linktext}](${mdEncode(linktext)}${subpath ? `#${mdEncode(subpath)}` : ''})`;
}

/**
 * Fill a `{{var}}` template. Multi-line values continue the line's quote/callout prefix (`> `),
 * so `> {{text}}` stays inside the callout for multi-paragraph selections.
 */
export function renderTemplate(template: string, vars: Record<string, string>): string {
	return template
		.split('\n')
		.map((line) => {
			const prefix = /^(\s*>\s?)*/.exec(line)?.[0] ?? '';
			return line.replace(/\{\{(\w+)\}\}/g, (_, k: string) => {
				const v = vars[k] ?? '';
				return prefix ? v.split('\n').join(`\n${prefix.trimEnd() + ' '}`).replace(/> \n/g, '>\n') : v;
			});
		})
		.join('\n');
}

/**
 * Where the subpath of a link's source text starts (just after `#`) and ends (before `|alias]]`, `]]`
 * or the markdown destination's closing parenthesis), or null when it has none.
 */
function subpathBounds(src: string): { start: number; end: number } | null {
	const wiki = /^!?\[\[/.exec(src);
	if (wiki) {
		const close = src.indexOf(']]', wiki[0].length);
		const end = close === -1 ? src.length : close;
		const pipe = src.indexOf('|', wiki[0].length);
		const stop = pipe !== -1 && pipe < end ? pipe : end;
		const hash = src.indexOf('#', wiki[0].length);
		return hash === -1 || hash > stop ? null : { start: hash + 1, end: stop };
	}
	const open = src.indexOf('](');
	if (open === -1) return null;
	let depth = 0;
	let end = src.length;
	for (let i = open + 1; i < src.length; i++) {
		if (src[i] === '(') depth++;
		else if (src[i] === ')' && --depth === 0) {
			end = i;
			break;
		}
	}
	const hash = src.indexOf('#', open);
	return hash === -1 || hash > end ? null : { start: hash + 1, end };
}

/**
 * Set (or remove, when `color` is null) the `&color=` parameter of a link's source text. Parameters
 * follow the locator as `&key=value`; locators never contain a raw `&key=`, so the first one starts them.
 */
export function setLinkColor(src: string, color: string | null): string {
	const b = subpathBounds(src);
	if (!b) return src;
	const sub = src.slice(b.start, b.end);
	const p = sub.search(/&[\w-]+=/);
	const locator = p === -1 ? sub : sub.slice(0, p);
	let params = p === -1 ? '' : sub.slice(p);
	params = params.replace(/&color=[^&]*/g, '');
	if (color) params = `&color=${encodeURIComponent(color)}${params}`;
	return src.slice(0, b.start) + locator + params + src.slice(b.end);
}

/**
 * Update the color of a callout header (`> [!quote|yellow]`) that contains the line `lineNo`, if any.
 * Returns the edited lines (or the input when there is no callout).
 */
export function setCalloutColor(lines: string[], lineNo: number, color: string | null): string[] {
	if (!/^\s*>/.test(lines[lineNo] ?? '')) return lines;
	for (let i = lineNo; i >= 0 && /^\s*>/.test(lines[i]); i--) {
		const m = /^(\s*>\s*\[!)([^\]|]+)(\|[^\]]*)?(\][+-]?)/.exec(lines[i]);
		if (m) {
			const out = lines.slice();
			out[i] = lines[i].replace(m[0], `${m[1]}${m[2]}${color ? `|${color}` : ''}${m[4]}`);
			return out;
		}
	}
	return lines;
}

/**
 * The link (wiki or markdown) covering column `ch` of a line, as linktext (`path#subpath`), or null.
 * Markdown destinations are decoded the way Obsidian does (decodeURI); balanced parentheses allowed.
 */
export function linkAt(line: string, ch: number): string | null {
	for (const m of line.matchAll(/!?\[\[([^\]]+)\]\]/g)) {
		if (ch >= m.index! && ch <= m.index! + m[0].length) return m[1].split('|')[0];
	}
	for (let i = line.indexOf(']('); i !== -1; i = line.indexOf('](', i + 2)) {
		const open = line.lastIndexOf('[', i);
		let depth = 0;
		let end = -1;
		for (let j = i + 1; j < line.length; j++) {
			if (line[j] === '(') depth++;
			else if (line[j] === ')' && --depth === 0) {
				end = j;
				break;
			}
		}
		if (open === -1 || end === -1) continue;
		if (ch >= open && ch <= end) {
			let dest = line.slice(i + 2, end).trim().replace(/^<|>$/g, '');
			try {
				dest = decodeURI(dest);
			} catch {
				/* keep */
			}
			return dest;
		}
	}
	return null;
}

/** Link targets (`path#subpath`) of the wiki and markdown links in some text, in order. */
export function linksIn(text: string): string[] {
	const out: { at: number; link: string }[] = [];
	for (const m of text.matchAll(/!?\[\[([^\]]+)\]\]/g)) out.push({ at: m.index!, link: m[1].split('|')[0] });
	for (let i = text.indexOf(']('); i !== -1; i = text.indexOf('](', i + 2)) {
		const link = linkAt(text.slice(text.lastIndexOf('\n', i) + 1), i - (text.lastIndexOf('\n', i) + 1));
		if (link && !/^[a-z][a-z0-9+.-]*:/i.test(link)) out.push({ at: i, link });
	}
	return out.sort((a, b) => a.at - b.at).map((l) => l.link);
}

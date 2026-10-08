/** Obsidian's `parseLinktext`, for tests that run without Obsidian. */
export function parseLinktext(link: string): { path: string; subpath: string } {
	const i = link.indexOf('#');
	return i === -1 ? { path: link, subpath: '' } : { path: link.slice(0, i), subpath: link.slice(i + 1) };
}

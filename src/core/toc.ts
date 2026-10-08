export interface TocItem {
	id: string;
	label: string;
	/** A locator the reader resolves (an EPUB href, a timestamp…). Empty for unlinked headings. */
	href: string;
	children: TocItem[];
	depth: number;
}

export function flattenToc(items: TocItem[], out: TocItem[] = []): TocItem[] {
	for (const it of items) {
		out.push(it);
		flattenToc(it.children, out);
	}
	return out;
}

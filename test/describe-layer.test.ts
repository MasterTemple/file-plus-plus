import { expect, test } from 'bun:test';
import { DocumentReader, textFragmentScheme, type ParsedLocator, type TocItem } from '../src/core';

// The test DOM has no StaticRange (layers keep their ranges as them)
(globalThis as { StaticRange?: unknown }).StaticRange ??= class {
	constructor(init: object) {
		Object.assign(this, init);
	}
};

/** Paragraphs of text, with text-fragment locators */
class TextReader extends DocumentReader {
	readonly schemes = [textFragmentScheme];
	constructor(
		host: HTMLElement,
		private readonly html: string,
	) {
		super(host);
	}
	get toc(): TocItem[] {
		return [];
	}
	protected async renderContent(): Promise<void> {
		const wrapper = this.doc.createElement('div');
		const body = this.doc.createElement('div');
		body.innerHTML = this.html;
		wrapper.append(body);
		this.addSection({ index: 0, wrapper, body });
		this.content.append(wrapper);
	}
	locatorFromRange(): string | null {
		return null;
	}
	protected resolveLocator(_loc: ParsedLocator): Range | null {
		return null;
	}
}

test('describeLayer: each annotation with the text of its paragraph around it', async () => {
	document.body.innerHTML = '<div id="host"></div>';
	const long = 'word '.repeat(30);
	const r = new TextReader(document.getElementById('host')!, `<p>Today we read <b>John 3:16</b> together.</p><p>${long}then Romans 8:28 and ${long}</p>`);
	await r.render();
	const spec = (id: string, text: string) => ({ id, locator: `:~:text=${encodeURIComponent(text)}` });
	r.setLayer('refs', [spec('a', 'John 3:16'), spec('b', 'Romans 8:28'), spec('c', 'Psalm 23')], { hidden: true });

	const [a, b, c] = r.describeLayer('refs', { context: 20 });
	expect([a.text, a.before, a.after]).toEqual(['John 3:16', 'Today we read ', ' together.']);
	// Long paragraphs are cut at a word, with an ellipsis where they go on
	expect(b.before).toBe('…word word then ');
	expect(b.after).toBe(' and word word word…');
	// One that isn't in the document comes last, with no text
	expect([c.spec.id, c.text, c.before]).toEqual(['c', null, undefined]);
	// Without `context`, only the text
	expect(r.describeLayer('refs')[0].before).toBeUndefined();
});

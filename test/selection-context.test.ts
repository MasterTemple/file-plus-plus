import { describe, expect, test } from 'bun:test';
import { DocumentReader, highlightInContext, sentenceContext, textFragmentScheme, type ParsedLocator, type TocItem } from '../src/core';

describe('sentenceContext', () => {
	const text = 'He came home. She said, “Stay a while.” Then they ate! It was late.';
	const ctx = (sel: string) => {
		const at = text.indexOf(sel);
		const c = sentenceContext(text, at, at + sel.length);
		return text.slice(c.start, c.end);
	};
	test('a phrase: its sentence', () => {
		expect(ctx('Stay a')).toBe('She said, “Stay a while.”');
		expect(ctx('came')).toBe('He came home.');
	});
	test('a phrase across sentences: both', () => {
		expect(ctx('home. She')).toBe('He came home. She said, “Stay a while.”');
	});
	test('a whole sentence: with the ones before and after', () => {
		expect(ctx('Then they ate!')).toBe('She said, “Stay a while.” Then they ate! It was late.');
	});
	test('a whole sentence without its final punctuation or quotes', () => {
		expect(ctx('Then they ate')).toBe('She said, “Stay a while.” Then they ate! It was late.');
		expect(ctx('She said, “Stay a while')).toBe('He came home. She said, “Stay a while.” Then they ate!');
	});
	test('the first or last sentence', () => {
		const first = sentenceContext(text, 0, 'He came home'.length);
		expect([text.slice(first.start, first.end), first.needPrev, first.needNext]).toEqual(['He came home. She said, “Stay a while.”', true, false]);
		const last = sentenceContext(text, text.indexOf('It was'), text.length);
		expect(last.needNext).toBe(true);
	});
});

test('highlightInContext marks each paragraph, spaces outside', () => {
	expect(highlightInContext({ before: 'He said ', text: 'hello there ', after: 'to them.' })).toBe('He said ==hello there== to them.');
	expect(highlightInContext({ before: 'One. ', text: 'Two.\n\nThree', after: '. Four.' })).toBe('One. ==Two.==\n\n==Three==. Four.');
});

/** Paragraphs of HTML */
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

test('selectionContext: within and across paragraphs, never a heading', async () => {
	document.body.innerHTML = '<div id="host"></div>';
	const r = new TextReader(document.getElementById('host')!, '<h2>Chapter One</h2><p>First <em>thing</em> here. Second one.</p><p>Third\n  goes here. Fourth.</p>');
	await r.render();
	const ps = r.content.querySelectorAll('p');
	const at = (p: Element, sel: string): [Text, number] => {
		const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
		for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
			const i = n.data.indexOf(sel);
			if (i >= 0) return [n, i];
		}
		throw new Error(sel);
	};
	const select = (start: [Text, number], end: [Text, number]) => {
		const range = document.createRange();
		range.setStart(...start);
		range.setEnd(...end);
		return highlightInContext(r.selectionContext(range));
	};
	// A phrase across an inline element
	const [t, i] = at(ps[0], 'First');
	expect(select([t, i + 'Fir'.length], [ps[0].querySelector('em')!.firstChild as Text, 5])).toBe('Fir==st thing== here.');
	// The last sentence of a paragraph: the next paragraph's first follows
	const [s] = at(ps[0], ' Second');
	expect(select([s, s.data.indexOf('Second')], [s, s.data.length - 1])).toBe('First thing here. ==Second one==.\n\nThird goes here.');
	// The first sentence of the first paragraph: no heading before it
	expect(select([t, 0], [t, t.data.length])).toBe('==First== thing here.');
	const [u] = at(ps[1], 'Third');
	expect(select([u, 0], [u, u.data.indexOf('.')])).toBe('Second one.\n\n==Third goes here==. Fourth.');
});

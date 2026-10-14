import { describe, expect, test } from 'bun:test';
import { hintLabels, sentenceRanges, wordRanges } from '../src/core';

describe('hintLabels', () => {
	test('one key each while they fit, in the alphabet order', () => {
		expect(hintLabels(3, 'asdf')).toEqual(['a', 's', 'd']);
		expect(hintLabels(4, 'asdf')).toEqual(['a', 's', 'd', 'f']);
	});
	test('else two keys each: none starts another', () => {
		const labels = hintLabels(6, 'asdf');
		expect(labels).toEqual(['aa', 'as', 'ad', 'af', 'sa', 'ss']);
		const all = hintLabels(16, 'asdf');
		expect(new Set(all).size).toBe(16);
		expect(hintLabels(17, 'asdf')[16]).toBe('saa');
	});
	test('repeated keys and spaces count once; nothing to label with', () => {
		expect(hintLabels(3, 'aa s')).toEqual(['aa', 'as', 'sa']);
		expect(hintLabels(2, '')).toEqual([]);
		expect(hintLabels(2, 'a')).toEqual([]);
		expect(hintLabels(1, 'a')).toEqual(['a']);
	});
});

describe('sentenceRanges', () => {
	test("a block's sentences, across inline elements", () => {
		const p = document.createElement('p');
		p.innerHTML = 'First one. Second <em>has emphasis</em> and a <a href="#">link</a>. Third.';
		expect(sentenceRanges(p).map((r) => r.toString())).toEqual(['First one.', 'Second has emphasis and a link.', 'Third.']);
	});
});

describe('wordRanges', () => {
	test('the words of a range, across inline elements, without punctuation', () => {
		const p = document.createElement('p');
		p.innerHTML = 'First one. Sec<em>ond has</em> a <a href="#">link</a>, don’t you? Third.';
		const [, second] = sentenceRanges(p);
		expect(wordRanges(second).map((r) => r.toString())).toEqual(['Second', 'has', 'a', 'link', 'don’t', 'you']);
	});
	test('within one text node', () => {
		const p = document.createElement('p');
		p.textContent = 'Call me Ishmael.';
		const r = document.createRange();
		r.setStart(p.firstChild!, 5);
		r.setEnd(p.firstChild!, 15);
		expect(wordRanges(r).map((w) => w.toString())).toEqual(['me', 'Ishmael']);
	});
});

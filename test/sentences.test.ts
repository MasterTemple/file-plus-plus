import { describe, expect, test } from 'bun:test';
import { sentenceBounds, sentenceRange } from '../src/core';

describe('sentenceBounds', () => {
	test('splits sentences without the spaces between them', () => {
		const text = 'In the beginning was the Word. And the Word was\nwith God!  Was it? Yes.';
		expect(sentenceBounds(text).map(([a, b]) => text.slice(a, b))).toEqual([
			'In the beginning was the Word.',
			'And the Word was\nwith God!',
			'Was it?',
			'Yes.',
		]);
	});
});

describe('sentenceRange', () => {
	const block = () => {
		const p = document.createElement('p');
		p.innerHTML = 'First one. Second <em>has emphasis</em> and a <a href="#">link</a>. Third.';
		return p;
	};
	test('a sentence across inline elements', () => {
		const p = block();
		const em = p.querySelector('em')!.firstChild!;
		expect(sentenceRange(p, em, 3)!.toString()).toBe('Second has emphasis and a link.');
	});
	test('the first and last sentence', () => {
		const p = block();
		expect(sentenceRange(p, p.firstChild!, 0)!.toString()).toBe('First one.');
		const last = p.lastChild!;
		expect(sentenceRange(p, last, (last as Text).data.length)!.toString()).toBe('Third.');
	});
	test('the space between sentences belongs to the one before', () => {
		const q = block();
		expect(sentenceRange(q, q.firstChild!, 11)!.toString()).toBe('Second has emphasis and a link.');
		const p = block();
		expect(sentenceRange(p, p.firstChild!, 10)!.toString()).toBe('First one.');
	});
	test('an element position', () => {
		const p = block();
		expect(sentenceRange(p, p, 1)!.toString()).toBe('Second has emphasis and a link.');
	});
});

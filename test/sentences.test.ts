import { describe, expect, test } from 'bun:test';
import { sentenceBounds, sentenceContext, sentenceRange } from '../src/core';

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

describe('note references', () => {
	const para = (html: string) => {
		const p = document.createElement('p');
		p.innerHTML = html;
		return p;
	};
	test('end the sentence before them, which keeps them', () => {
		const p = para('Simony is <em>an earnest desire</em>.<a epub:type="noteref" role="doc-noteref" href="#n4">4</a> This precise formulation is Aquinas’s,<a role="doc-noteref" href="#n5">5</a> though. Later ones.');
		expect(sentenceRange(p, p.firstChild!, 2)!.toString()).toBe('Simony is an earnest desire.4');
		const after = p.childNodes[4];
		expect(sentenceRange(p, after, 3)!.toString()).toBe('This precise formulation is Aquinas’s,5 though.');
	});
	test('superscript links count without markup for them', () => {
		const p = para('One thing.<sup><a href="#n1">12</a></sup> Two things.<a href="#n2"><sup>13</sup></a> Three.');
		expect(sentenceRange(p, p.firstChild!, 0)!.toString()).toBe('One thing.12');
		expect(sentenceRange(p, p.childNodes[2], 2)!.toString()).toBe('Two things.13');
	});
	test('a selection of the sentence without its reference is still the whole sentence', () => {
		const text = 'First. Second.4 Third.';
		expect(sentenceContext(text, 7, 14, undefined, [[14, 15]])).toEqual({ start: 0, end: 22, needPrev: false, needNext: false });
	});
});

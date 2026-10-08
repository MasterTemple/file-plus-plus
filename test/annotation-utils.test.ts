import { describe, expect, test } from 'bun:test';
import { parseLinktext } from './linktext';
import { findPlacement, headingLabel, insertAnnotation, insertAt, type Ordering } from '../src/obsidian/annotation-utils';
import { linksIn } from '../src/obsidian/link-utils';

// A toy format: `#n=<number>` locators, ordered by number. Text fragments resolve through `tf`.
const order = (tf: Record<string, number> = {}): Ordering<number> => ({
	compare: (a, b) => a - b,
	keyOf: (md) => {
		for (const link of linksIn(md)) {
			const sub = parseLinktext(link).subpath;
			const n = /^n=(\d+)/.exec(sub);
			if (n) return Number(n[1]);
			const t = /^:~:text=([^&]*)/.exec(sub);
			if (t) return tf[t[1]] ?? null;
		}
		return null;
	},
});

const file = `---
doc: "[[a.doc]]"
---

# [[a.doc#n=100|Part 1]]

> [!quote] [[a.doc#n=110|a]]
> one

> [!quote] [[a.doc#n=130|a]]
> three

# [[a.doc#n=200|Part 2]]

# [[a.doc#n=300|Part 3]]

Some loose note without a link.
`;

describe('annotation placement', () => {
	test('between existing annotations in the right section', () => {
		const { data, placement } = insertAnnotation(file, 120, '> NEW', order());
		expect(placement.heading).toBe('Part 1');
		const lines = data.split('\n');
		const i = lines.indexOf('> NEW');
		expect(lines[i - 2]).toBe('> one');
		expect(lines[i + 2]).toBe('> [!quote] [[a.doc#n=130|a]]');
	});

	test('empty section', () => {
		const { data, placement } = insertAnnotation(file, 250, '> P2', order());
		expect(placement.heading).toBe('Part 2');
		expect(data).toContain('# [[a.doc#n=200|Part 2]]\n\n> P2\n\n# [[a.doc#n=300|Part 3]]');
	});

	test('unclear blocks append to the end of the section', () => {
		const { data, placement } = insertAnnotation(file, 310, '> P3', order());
		expect(placement.appended).toBe(true);
		expect(data.trimEnd().endsWith('Some loose note without a link.\n\n> P3')).toBe(true);
	});

	test('text fragments are ordered through keyOf', () => {
		const withTf = file.replace('[[a.doc#n=130|a]]', '[[a.doc#:~:text=three|a]]');
		const placed = insertAnnotation(withTf, 120, '> NEW', order({ three: 130 }));
		expect(placed.placement.appended).toBe(false);
		const lines = placed.data.split('\n');
		expect(lines[lines.indexOf('> NEW') + 2]).toBe('> [!quote] [[a.doc#:~:text=three|a]]');
		expect(insertAnnotation(withTf, 120, '> NEW', order()).placement.appended).toBe(true);
	});

	test('before the first section and in files without headings', () => {
		const p = findPlacement(file.split('\n'), 5, order());
		expect(p.heading).toBeNull();
		expect(p.line).toBe(3);
		expect(insertAnnotation('just text\n', 5, '> X', order()).data).toBe('just text\n\n> X\n');
	});

	test('markdown links and labels', () => {
		expect(headingLabel('[Part 1](a.doc#n=100)')).toBe('Part 1');
		const md = '# [P1](a.doc#n=100)\n\n[a](a.doc#n=150)\n';
		expect(insertAnnotation(md, 120, 'NEW', order()).data).toBe('# [P1](a.doc#n=100)\n\nNEW\n\n[a](a.doc#n=150)\n');
	});

	test('insertAt spacing', () => {
		expect(insertAt(['a', '', '', 'b'], 3, 'X')).toEqual(['a', '', 'X', '', 'b']);
		expect(insertAt(['a'], 1, 'X')).toEqual(['a', '', 'X', '']);
	});
});

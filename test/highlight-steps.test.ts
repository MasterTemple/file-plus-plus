import { expect, test } from 'bun:test';
import { stepHighlight } from '../src/annotator/highlight-steps';

const tops = [-500, -20, 100, 100, 300, 2000];
const top = (i: number) => tops[i];

test('stepHighlight: from the one gone to last, while the view stays', () => {
	expect(stepHighlight(tops.length, 1, 2, top, 100)).toBe(3);
	expect(stepHighlight(tops.length, -1, 3, top, 100)).toBe(2);
	expect(stepHighlight(tops.length, 1, 5, top, 100)).toBeNull();
	expect(stepHighlight(tops.length, -1, 0, top, 100)).toBeNull();
});

test('stepHighlight: after scrolling, from where the view is', () => {
	// On the line: neither ahead nor behind
	expect(stepHighlight(tops.length, 1, null, top, 100)).toBe(4);
	expect(stepHighlight(tops.length, -1, null, top, 100)).toBe(1);
	expect(stepHighlight(tops.length, 1, null, top, 100.5)).toBe(4);
	expect(stepHighlight(tops.length, 1, null, top, 50)).toBe(2);
	expect(stepHighlight(tops.length, -1, null, top, 50)).toBe(1);
	expect(stepHighlight(tops.length, 1, null, top, 3000)).toBeNull();
	expect(stepHighlight(tops.length, -1, null, top, -1000)).toBeNull();
	expect(stepHighlight(0, 1, null, top, 0)).toBeNull();
});

import { describe, expect, test } from 'bun:test';
import { formatLineLocator, formatLocator, isRangeLocator, lineScheme, linesFromRange, parseLineLocator, parseLocator, resolveLines, textFragmentScheme } from '../src/core';

const schemes = [lineScheme, textFragmentScheme];

describe('locators', () => {
	test('schemes are tried in order; params follow', () => {
		expect(parseLocator('#L3C2-L4&color=red', schemes)).toEqual({ scheme: 'line', locator: 'L3C2-L4', params: { color: 'red' } });
		expect(parseLocator('%3A~%3Atext=a,b&color=x%20y', schemes)).toEqual({ scheme: 'text', locator: ':~:text=a,b', params: { color: 'x y' } });
		expect(parseLocator('text=a', schemes).locator).toBe(':~:text=a');
		expect(parseLocator('heading&color=red', schemes)).toEqual({ scheme: null, locator: null, params: { color: 'red' } });
		expect(formatLocator(':~:text=a', { color: 'light blue', other: undefined })).toBe(':~:text=a&color=light%20blue');
		expect(isRangeLocator(parseLocator(':~:text=a', schemes), schemes)).toBe(true);
	});

	test('line locators parse and format', () => {
		expect(parseLineLocator('L12')).toEqual({ start: { line: 12, column: null }, end: { line: 12, column: null } });
		expect(parseLineLocator('L12C5-L14C3')).toEqual({ start: { line: 12, column: 5 }, end: { line: 14, column: 3 } });
		expect(parseLineLocator('L3-5')).toEqual({ start: { line: 3, column: null }, end: { line: 5, column: null } });
		expect(parseLineLocator('L5-L3')).toBeNull();
		for (const s of ['L12', 'L12-L14', 'L12C5-L14C3', 'L2-L2C4']) expect(formatLineLocator(parseLineLocator(s)!)).toBe(s);
	});

	test('line locators resolve against rendered lines and back', () => {
		document.body.innerHTML = '<div id="r"><p data-fpp-line="1">first line</p><p data-fpp-line="2">second <b>bold</b> line</p></div>';
		const root = document.getElementById('r')!;
		const r = resolveLines(root, parseLineLocator('L1C7-L2C11')!, document)!;
		expect(r.toString()).toBe('linesecond bold');
		expect(formatLineLocator(linesFromRange(r)!)).toBe('L1C7-L2C11');
		const whole = resolveLines(root, parseLineLocator('L2')!, document)!;
		expect(whole.toString()).toBe('second bold line');
		expect(formatLineLocator(linesFromRange(whole)!)).toBe('L2');
	});
});

describe('scoped text fragments', () => {
	test('the first match at or after an offset; shorter fragments inside a scope', async () => {
		const { TextIndex, createTextFragment, findTextFragment, serializeTextFragment } = await import('../src/core');
		document.body.innerHTML = '<div id="r"><p>the whale and the whale</p><p>another whale here</p></div>';
		const index = new TextIndex(document.getElementById('r')!);
		const second = index.text.indexOf('whale', 5);
		expect(findTextFragment(index, { start: 'whale' })).toEqual([4, 9]);
		expect(findTextFragment(index, { start: 'whale' }, 10)).toEqual([second, second + 5]);
		const global = serializeTextFragment(createTextFragment(index, second, second + 5)!);
		const scoped = serializeTextFragment(createTextFragment(index, second, second + 5, 10)!);
		expect(global).not.toBe(':~:text=whale');
		expect(scoped).toBe(':~:text=whale');
	});
});

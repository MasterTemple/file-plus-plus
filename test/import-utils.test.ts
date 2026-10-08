import { expect, test } from 'bun:test';
import { parseLocator, textFragmentScheme } from '../src/core';
import { bookKey, commentKey, normalizeLocator, parseImport, sameText, textFragmentFor } from '../src/obsidian/import-utils';

test('parseImport: fields, aliases and wrappers', () => {
	const json = JSON.stringify({
		highlights: [
			{ book: 'Moby Dick.epub', cfi: 'epubcfi(/6/14!/4/2,/1:0,/1:5)', comment: '  Nice \n', color: 'red', updated: '2026-10-08T14:03:12Z' },
			{ file: 'Books/Alice.epub', locator: '#/6/4!/4/2,/1:0,/1:3', note: 'n' },
			{ title: 'Moby Dick', text: 'Call me Ishmael', created: 1760000000 },
			{ textFragment: 'text=foo' },
			{ comment: 'nothing to find' },
			42,
		],
	});
	const { entries, errors } = parseImport(json);
	expect(entries.map((e) => [e.index, e.book, e.locator, e.comment, e.color])).toEqual([
		[0, 'Moby Dick.epub', 'epubcfi(/6/14!/4/2,/1:0,/1:5)', 'Nice', 'red'],
		[1, 'Books/Alice.epub', 'epubcfi(/6/4!/4/2,/1:0,/1:3)', 'n', null],
		[2, 'Moby Dick', ':~:text=Call%20me%20Ishmael', '', null],
		[3, null, ':~:text=foo', '', null],
	]);
	expect(entries[0].updated?.toISOString()).toBe('2026-10-08T14:03:12.000Z');
	expect(entries[2].updated?.getTime()).toBe(1760000000 * 1000);
	expect(errors).toEqual(['#5: no "cfi", "locator", "textFragment" or "text"', '#6: not an object']);
});

test('parseImport: bad input', () => {
	expect(parseImport('{').errors[0]).toStartWith('Not valid JSON');
	expect(parseImport('{"x": 1}').errors).toEqual(['Expected a list of highlights (or an object with "highlights")']);
	expect(parseImport('[]')).toEqual({ entries: [], errors: [] });
});

test('text fragments from text survive commas and dashes', () => {
	const f = textFragmentFor('well-known, they  said');
	expect(f).toBe(':~:text=well%2Dknown%2C%20they%20said');
	expect(parseLocator(f, [textFragmentScheme]).locator).toBe(f);
	expect(normalizeLocator('text=a,b')).toBe(':~:text=a,b');
});

test('keys', () => {
	expect(commentKey(' a\n  b ')).toBe('a b');
	expect(commentKey(null)).toBe('');
	expect(bookKey('Books/Moby Dick.EPUB')).toBe('moby dick');
	expect(bookKey('Moby Dick')).toBe('moby dick');
});

test('sameText ignores quotes, spacing, case and soft hyphens', () => {
	expect(sameText('“It’s a white whale,” I say', '"It\'s a white\nwhale," i say')).toBe(true);
	expect(sameText('regu\u00adlating the circulation.', 'regulating the circulation')).toBe(true);
	expect(sameText('Call me Ishmael. Some years ago', 'Call me Ishmael')).toBe(true);
	expect(sameText('Call me Ishmael', 'Some years ago')).toBe(false);
	expect(sameText('', 'x')).toBe(false);
});

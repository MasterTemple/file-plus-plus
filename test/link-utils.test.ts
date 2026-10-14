import { expect, test } from 'bun:test';
import { parseLocator, textFragmentScheme } from '../src/core';
import { formatLink, linkAt, retargetLinks, linksIn, linkTimestamp, parseLinkTimestamp, renderTemplate, setCalloutColor, setLinkColor, setLinkParam, touchLink } from '../src/obsidian/link-utils';

const cfi = 'epubcfi(/6/14!/4/2,/1:0,/1:16)';

test('wiki and markdown links', () => {
	expect(formatLink('Books/Moby Dick.epub', `${cfi}&color=red`, 'Moby | Ch. 1', 'wiki')).toBe(
		'[[Books/Moby Dick.epub#epubcfi(/6/14!/4/2,/1:0,/1:16)&color=red|Moby Ch. 1]]',
	);
	expect(formatLink('Books/Moby Dick.epub', `${cfi}&color=red`, 'Moby [1]', 'markdown')).toBe(
		'[Moby \\[1\\]](Books/Moby%20Dick.epub#epubcfi%28/6/14!/4/2,/1%3A0,/1%3A16%29&color=red)',
	);
});

test('markdown link subpath survives one decode', () => {
	const sub = ':~:text=call%20me-,Ishmael,-%2C%20some&color=red';
	const link = formatLink('a.epub', sub, 'x', 'markdown');
	const dest = /\((.*)\)$/.exec(link)![1];
	// Obsidian applies decodeURI, which keeps reserved chars like %3A encoded.
	const decoded = decodeURI(dest.split('#')[1]);
	expect(decoded).toBe(sub.replace(/:/g, '%3A'));
	expect(parseLocator(decoded, [textFragmentScheme])).toEqual({ scheme: 'text', locator: ':~:text=call%20me-,Ishmael,-%2C%20some', params: { color: 'red' } });
});

test('setLinkColor', () => {
	expect(setLinkColor(`[[a.epub#${cfi}|x]]`, 'red')).toBe(`[[a.epub#${cfi}&color=red|x]]`);
	expect(setLinkColor(`[[a.epub#${cfi}&color=yellow|x]]`, 'red')).toBe(`[[a.epub#${cfi}&color=red|x]]`);
	expect(setLinkColor(`[[a.epub#${cfi}&color=yellow]]`, null)).toBe(`[[a.epub#${cfi}]]`);
	expect(setLinkColor('[x](a.epub#epubcfi%28/6/4!/4/2/1:0%29&color=blue)', 'green')).toBe('[x](a.epub#epubcfi%28/6/4!/4/2/1:0%29&color=green)');
	expect(setLinkColor('[x](a.epub#:~:text=foo,bar)', 'green')).toBe('[x](a.epub#:~:text=foo,bar&color=green)');
	expect(setLinkColor('[x](a.epub#%3A~%3Atext=foo,bar&color=red)', 'green')).toBe('[x](a.epub#%3A~%3Atext=foo,bar&color=green)');
	expect(setLinkColor('[[talk.srt#t=109s-300.7s&color=red&x=1|talk]]', 'blue')).toBe('[[talk.srt#t=109s-300.7s&color=blue&x=1|talk]]');
	expect(setLinkColor('![[talk.srt#t=109s]]', 'blue')).toBe('![[talk.srt#t=109s&color=blue]]');
	expect(setLinkColor('[[talk.srt|no subpath]]', 'blue')).toBe('[[talk.srt|no subpath]]');
	expect(setLinkColor('[x](a.epub#epubcfi(/6/4!/4/2,/1:0,/1:5)&color=red)', null)).toBe('[x](a.epub#epubcfi(/6/4!/4/2,/1:0,/1:5))');
});

test('setLinkParam keeps other params and their order', () => {
	expect(setLinkParam(`[[a.epub#${cfi}&color=red|x]]`, 'updated', '20261008T140312Z')).toBe(`[[a.epub#${cfi}&color=red&updated=20261008T140312Z|x]]`);
	expect(setLinkParam(`[[a.epub#${cfi}&updated=1&color=red|x]]`, 'updated', '2')).toBe(`[[a.epub#${cfi}&updated=2&color=red|x]]`);
	expect(setLinkParam(`[[a.epub#${cfi}&updated=1&color=red]]`, 'updated', null)).toBe(`[[a.epub#${cfi}&color=red]]`);
	expect(setLinkColor(`[[a.epub#${cfi}&updated=1|x]]`, 'red')).toBe(`[[a.epub#${cfi}&color=red&updated=1|x]]`);
	expect(setLinkParam('[x](a.epub#epubcfi%28/6/4!/4/2/1%3A0%29&color=blue)', 'updated', '20261008T140312Z')).toBe('[x](a.epub#epubcfi%28/6/4!/4/2/1%3A0%29&color=blue&updated=20261008T140312Z)');
});

test('link timestamps', () => {
	const d = new Date(Date.UTC(2026, 9, 8, 14, 3, 12, 345));
	expect(linkTimestamp(d)).toBe('20261008T140312Z');
	expect(parseLinkTimestamp('20261008T140312Z')?.getTime()).toBe(Date.UTC(2026, 9, 8, 14, 3, 12));
	expect(parseLinkTimestamp('2026-10-08T14:03:12Z')?.getTime()).toBe(Date.UTC(2026, 9, 8, 14, 3, 12));
	expect(parseLinkTimestamp('2026-10-08')?.getFullYear()).toBe(2026);
	expect(parseLinkTimestamp('soon')).toBeNull();
	expect(parseLinkTimestamp(undefined)).toBeNull();
	expect(touchLink(`[[a.epub#${cfi}&updated=20200101T000000Z|x]]`, d)).toBe(`[[a.epub#${cfi}&updated=20261008T140312Z|x]]`);
	const { params } = parseLocator(`${cfi}&color=red&updated=20261008T140312Z`.replace('epubcfi', ':~:text=a'), [textFragmentScheme]);
	expect(params.updated).toBe('20261008T140312Z');
});

test('templates continue callout prefix', () => {
	const t = '> [!quote|{{color}}] {{link}}\n> {{text}}';
	expect(renderTemplate(t, { color: 'red', link: 'L', text: 'para one\n\npara two' })).toBe('> [!quote|red] L\n> para one\n>\n> para two');
	expect(renderTemplate('{{text}} ({{link}})', { text: 'a\nb', link: 'L' })).toBe('a\nb (L)');
});

test('setCalloutColor', () => {
	const lines = ['text', '> [!quote|yellow] [[a.epub#x]]', '> body'];
	expect(setCalloutColor(lines, 2, 'red')[1]).toBe('> [!quote|red] [[a.epub#x]]');
	expect(setCalloutColor(lines, 0, 'red')).toBe(lines);
	expect(setCalloutColor(['> [!note]- x'], 0, 'blue')[0]).toBe('> [!note|blue]- x');
});

test('linkAt', () => {
	const line = 'See [[B.epub#epubcfi(/6/4!/4/2,/1:0,/1:5)|here]] and [md](Moby%20Dick.epub#epubcfi%28/6/14!/4/2/1%3A0%29&color=red) end';
	expect(linkAt(line, 10)).toBe('B.epub#epubcfi(/6/4!/4/2,/1:0,/1:5)');
	expect(linkAt(line, line.indexOf('[md]') + 2)).toBe('Moby Dick.epub#epubcfi(/6/14!/4/2/1%3A0)&color=red');
	expect(linkAt(line, line.length - 1)).toBeNull();
});

test('linksIn', () => {
	expect(linksIn('a [[x.doc#n=1|y]] b [c](x%20y.doc#n=2) d [e](https://example.com) ![[z.doc]]')).toEqual(['x.doc#n=1', 'x y.doc#n=2', 'z.doc']);
});

test('retargetLinks', () => {
	const is = (p: string) => p === 'Old notes' || p === 'dir/Old notes';
	expect(retargetLinks('See [[Old notes]], ![[dir/Old notes#Part 1|x]] and [[Other]].', is, 'New')).toBe('See [[New]], ![[New#Part 1|x]] and [[Other]].');
	expect(retargetLinks('[a](Old%20notes.md#Part%201) [b](<Old notes>) [c](https://x.org/Old%20notes)', is, 'New name')).toBe('[a](New%20name.md#Part%201) [b](<New name>) [c](https://x.org/Old%20notes)');
});

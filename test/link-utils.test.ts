import { expect, test } from 'bun:test';
import { parseLocator, textFragmentScheme } from '../src/core';
import { formatLink, linkAt, linksIn, renderTemplate, setCalloutColor, setLinkColor } from '../src/obsidian/link-utils';

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

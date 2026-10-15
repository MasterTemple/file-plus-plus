import { expect, test } from 'bun:test';
import { isNoteLink, noteOf } from '../src/core/note-preview';

const html = (s: string) => {
	const div = document.createElement('div');
	div.innerHTML = s;
	return div;
};

test('isNoteLink: said so, to a note, or a short mark not to a heading', () => {
	const d = html(`
		<p>Text<a id="r1" data-epub-type="noteref" data-fpp-href="#n1">see</a>
		<sup><a id="r2" data-fpp-href="#x">here</a></sup><a id="r3" data-fpp-href="#y">[12]</a>
		<a id="r4" data-fpp-href="#h">1</a><a id="r5" data-fpp-href="#z">Chapter one</a></p>
		<aside data-epub-type="footnote" id="n1"><p>A note.</p></aside>
		<p id="x">x</p><p id="y">y</p><h2 id="h">Heading</h2><p id="z">z</p>`);
	const $ = (id: string) => d.querySelector(`#${id}`)!;
	expect(isNoteLink($('r1'), $('n1'))).toBe(true);
	expect(isNoteLink($('r5'), $('n1'))).toBe(true);
	expect(isNoteLink($('r2'), $('x'))).toBe(true);
	expect(isNoteLink($('r3'), $('y'))).toBe(true);
	expect(isNoteLink($('r4'), $('h'))).toBe(false);
	expect(isNoteLink($('r5'), $('z'))).toBe(false);
});

test('noteOf: the note container, else the block of an anchor', () => {
	const d = html(`
		<aside data-epub-type="footnote" id="n1"><p>A note.</p><p>Its second paragraph.</p></aside>
		<p><a id="n2"></a>2. Another note.</p>
		<ol class="footnotes"><li id="n3">Third.</li><li>Fourth.</li></ol>`);
	expect(noteOf(d.querySelector('#n1')!).localName).toBe('aside');
	expect(noteOf(d.querySelector('#n2')!).textContent).toBe('2. Another note.');
	expect(noteOf(d.querySelector('#n3')!).textContent).toBe('Third.');
});

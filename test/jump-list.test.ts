import { expect, test } from 'bun:test';
import { JumpList } from '../src/obsidian/jump-list';

const p = (locator: string, path = 'a.epub') => ({ path, locator });

test('JumpList: back and forward as Vim, the current place kept for coming back', () => {
	const j = new JumpList();
	expect(j.back(p('x'))).toBeNull();
	j.jumpedFrom(p('A'));
	j.jumpedFrom(p('B'));
	// Now at C
	expect(j.back(p('C'))).toEqual(p('B'));
	expect(j.back(p('B'))).toEqual(p('A'));
	expect(j.back(p('A'))).toBeNull();
	expect(j.forward()).toEqual(p('B'));
	expect(j.forward()).toEqual(p('C'));
	expect(j.forward()).toBeNull();
	// A new jump from C: back from D goes to C, then B, A
	j.jumpedFrom(p('C'));
	expect(j.back(p('D'))).toEqual(p('C'));
	expect(j.back(null)).toEqual(p('B'));
});

test('JumpList: a place is listed once, at its latest; other documents count', () => {
	const j = new JumpList();
	j.jumpedFrom(p('A'));
	j.jumpedFrom(p('B'));
	j.jumpedFrom(p('A'));
	expect(j.back(p('A', 'b.epub'))).toEqual(p('A'));
	expect(j.back(null)).toEqual(p('B'));
	expect(j.back(null)).toBeNull();
	// Back where we were (the current place was already the last one): nowhere to go back to
	const k = new JumpList();
	k.jumpedFrom(p('A'));
	expect(k.back(p('A'))).toBeNull();
});

test('JumpList: at most max places', () => {
	const j = new JumpList(3);
	for (const l of ['A', 'B', 'C', 'D']) j.jumpedFrom(p(l));
	expect(j.back(null)).toEqual(p('C'));
	expect(j.back(null)).toEqual(p('B'));
	expect(j.back(null)).toBeNull();
});

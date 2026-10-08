import { expect, test } from 'bun:test';
import { around } from '../src/obsidian/patch';

test('patches chain and unload in any order', () => {
	const obj = { f: (x: number) => x };
	const a = around(obj, { f: (next) => (x: number) => next(x) + 1 });
	const b = around(obj, { f: (next) => (x: number) => next(x) * 10 });
	expect(obj.f(1)).toBe(20);
	a(); // removed underneath b: passes through
	expect(obj.f(1)).toBe(10);
	b();
	expect(obj.f(1)).toBe(1);
});

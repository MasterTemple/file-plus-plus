import { expect, test } from 'bun:test';
import { linesContain } from '../src/core/reader';

const rect = (left: number, top: number, right: number, bottom: number) => ({ left, top, right, bottom, width: right - left, height: bottom - top });
const range = (...rects: ReturnType<typeof rect>[]) => ({ getClientRects: () => rects }) as unknown as Range;

test('the line spacing between lines of a range counts as on it', () => {
	// Two lines 20px tall, 8px apart; the second made of two inline pieces.
	const r = range(rect(100, 0, 400, 20), rect(10, 28, 150, 48), rect(150, 30, 200, 46));
	expect(linesContain(r, 120, 10)).toBe(true);
	expect(linesContain(r, 120, 24)).toBe(true); // in the gap
	expect(linesContain(r, 30, 24)).toBe(true); // in the gap, under the second line only
	expect(linesContain(r, 450, 24)).toBe(false); // beside both lines
	expect(linesContain(r, 300, 40)).toBe(false); // past the end of the second line
});

test('a gap taller than a line (paragraph break) is not bridged', () => {
	const r = range(rect(10, 0, 400, 20), rect(10, 60, 400, 80));
	expect(linesContain(r, 100, 40)).toBe(false);
	expect(linesContain(r, 100, 70)).toBe(true);
});

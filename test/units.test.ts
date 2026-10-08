import { describe, expect, test } from 'bun:test';
import { DocumentReader, splitTextDirective, withTextDirective, type ParsedLocator, type TocItem } from '../src/core';

/** Units marked by empty elements before their text (verse numbers), or spans around it (cues) */
class UnitReader extends DocumentReader {
	readonly schemes = [];
	constructor(
		host: HTMLElement,
		private readonly html: string[],
		private readonly selector: string,
		private readonly spans = false,
	) {
		super(host);
	}
	get toc(): TocItem[] {
		return [];
	}
	private units: Element[] = [];
	protected override unitElements(): readonly Element[] {
		return this.units;
	}
	protected override unitEnd(i: number): [Node, number] {
		const el = this.units[i];
		return this.spans ? [el, el.childNodes.length] : super.unitEnd(i);
	}
	protected async renderContent(): Promise<void> {
		this.html.forEach((html, index) => {
			const wrapper = this.doc.createElement('div');
			const body = this.doc.createElement('div');
			body.innerHTML = html;
			wrapper.append(body);
			this.addSection({ index, wrapper, body });
			this.content.append(wrapper);
		});
		this.units = [...this.content.querySelectorAll(this.selector)];
	}
	locatorFromRange(): string | null {
		return null;
	}
	protected resolveLocator(_loc: ParsedLocator): Range | null {
		return null;
	}
}

async function reader(html: string[], selector: string, spans = false) {
	document.body.innerHTML = '<div id="host"></div>';
	const r = new UnitReader(document.getElementById('host')!, html, selector, spans);
	await r.render();
	return r;
}

const at = (r: DocumentReader, s: string, e: string) => {
	const text = r.textIndex.text;
	return r.textIndex.toRange(text.indexOf(s), text.indexOf(e) + e.length);
};

describe('units', () => {
	test('markers: a verse runs to the next marker or the end of its section', async () => {
		const r = await reader(
			['<p><b class="v"></b>In the beginning. <b class="v"></b>He was with God.</p><h4>A heading</h4><p><b class="v"></b>All things.</p>', '<p><b class="v"></b>Next chapter.</p>'],
			'.v',
		);
		expect(r.unitRange(0, 0)!.toString()).toBe('In the beginning. ');
		expect(r.unitRange(1, 1)!.toString()).toContain('He was with God.');
		// The last unit of a section ends with it, not at the next section's first marker
		expect(r.unitRange(2, 2)!.toString()).toBe('All things.');
		// Whole units: no words
		expect(r.unitsOfRange(r.unitRange(0, 1)!)).toEqual({ first: 0, last: 1 });
		// Part of them: the exact words, which resolve within the units
		const part = r.unitsOfRange(at(r, 'beginning', 'He was'))!;
		expect([part.first, part.last]).toEqual([0, 1]);
		expect(r.resolveUnits(part.first, part.last, part.text)!.toString()).toBe('beginning. He was');
		// Words that aren't in those units: the whole units
		expect(r.resolveUnits(2, 2, ':~:text=beginning')!.toString()).toBe('All things.');
		// A selection ending right where a verse starts ends in the verse before
		const range = r.unitRange(0, 0)!;
		expect(r.unitsOfRange(range)).toEqual({ first: 0, last: 0 });
	});

	test('spans: a point between units starts the next one and ends the one before', async () => {
		const r = await reader(['<p><span class="c">Call me Ishmael.</span> <span class="c">Some years ago.</span></p>'], '.c', true);
		const p = r.content.querySelector('p')!;
		const between = p.childNodes[1];
		expect(r.unitAt(between, 0)).toBe(1);
		expect(r.unitAt(between, 0, true)).toBe(0);
		expect(r.unitsOfRange(at(r, 'Ishmael', 'years'))!.first).toBe(0);
		expect(r.unitsOfRange(r.unitRange(0, 1)!)).toEqual({ first: 0, last: 1 });
	});

	test('text directives after a locator', () => {
		expect(splitTextDirective('t=1s-2s:~:text=whale')).toEqual({ base: 't=1s-2s', text: ':~:text=whale' });
		expect(splitTextDirective('v=3%3A16%3A~%3Atext=so%20loved')).toEqual({ base: 'v=3%3A16', text: ':~:text=so%20loved' });
		expect(splitTextDirective('v=3:16')).toEqual({ base: 'v=3:16', text: null });
		expect(withTextDirective('v=3:16', ':~:text=a')).toBe('v=3:16:~:text=a');
		expect(withTextDirective('v=3:16', null)).toBe('v=3:16');
	});
});

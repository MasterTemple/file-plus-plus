/** Labels over things in view (sentences) that keys pick, as Vimium's link hints or flash.nvim. */

/**
 * `n` labels from the keys of `alphabet`, in its order: one key each while they fit, else two (three…)
 * each, so no label starts another. Repeated keys count once.
 */
export function hintLabels(n: number, alphabet: string): string[] {
	const keys = [...new Set([...alphabet])].filter((k) => k.trim());
	if (n <= 0 || !keys.length) return [];
	let length = 1;
	while (keys.length ** length < n && keys.length > 1) length++;
	if (keys.length ** length < n) return []; // one key can't tell several things apart
	return Array.from({ length: n }, (_, i) => {
		let label = '';
		for (let k = 0, rest = i; k < length; k++, rest = Math.floor(rest / keys.length)) label = keys[rest % keys.length] + label;
		return label;
	});
}

/** Something to pick: its range, where its label goes (viewport coordinates) and the label. */
export interface Hint {
	range: Range;
	x: number;
	y: number;
	label: string;
}

/** The labels, drawn over a reader's text (`scroller`: they scroll with it, so the caller ends them on scroll). */
export class HintOverlay {
	private readonly layer: HTMLElement;
	private readonly els: HTMLElement[];

	constructor(
		scroller: HTMLElement,
		readonly hints: Hint[],
		color: string,
	) {
		const doc = scroller.ownerDocument;
		const box = scroller.getBoundingClientRect();
		this.layer = doc.createElement('div');
		this.layer.className = 'fpp-hints';
		this.layer.style.setProperty('--fpp-hint-color', color);
		this.els = hints.map((h) => {
			const el = doc.createElement('span');
			el.className = 'fpp-hint';
			el.textContent = h.label;
			el.style.left = `${h.x - box.left + scroller.scrollLeft}px`;
			el.style.top = `${h.y - box.top + scroller.scrollTop}px`;
			this.layer.appendChild(el);
			return el;
		});
		scroller.appendChild(this.layer);
	}

	/** Shows the labels starting with `typed` (that part dimmed) and returns their hints */
	narrow(typed: string): Hint[] {
		const out: Hint[] = [];
		this.hints.forEach((h, i) => {
			const el = this.els[i];
			const match = h.label.startsWith(typed);
			el.hidden = !match;
			if (!match) return;
			out.push(h);
			el.replaceChildren();
			if (typed) el.appendChild(el.ownerDocument.createElement('span')).textContent = typed;
			el.append(h.label.slice(typed.length));
		});
		return out;
	}

	destroy(): void {
		this.layer.remove();
	}
}

export const HINT_CSS = /* css */ `
.fpp-hints { position: absolute; top: 0; left: 0; width: 0; height: 0; z-index: 5; pointer-events: none; }
.fpp-hint {
	position: absolute;
	transform: translate(-3px, -62%);
	padding: 0 3px;
	border-radius: 3px;
	background: var(--fpp-hint-color);
	color: #000;
	box-shadow: 0 1px 3px rgba(0, 0, 0, 0.35);
	font: 700 12px/16px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
	text-transform: none;
	letter-spacing: 0;
	white-space: pre;
	user-select: none;
	-webkit-user-select: none;
}
.fpp-hint[hidden] { display: none; }
.fpp-hint > span { opacity: 0.4; }
`;

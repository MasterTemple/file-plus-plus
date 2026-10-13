import type { App, HoverParent, HoverPopover } from 'obsidian';

/** What `hover-link` takes, and where to put the popover */
export interface HoverLink {
	event: MouseEvent;
	source: string;
	hoverParent: HoverParent;
	targetEl: HTMLElement;
	linktext: string;
	sourcePath: string;
	state?: unknown;
	/** Puts the popover somewhere (also each time Obsidian places it again, as its content loads) */
	place?: (popover: HoverPopover) => void;
	/**
	 * Whether a point is on the link, for a target shared by many links (a document whose annotations
	 * aren't elements of their own): its preview replaces another link's, and hides as the pointer
	 * leaves the link rather than the target
	 */
	over?: (x: number, y: number) => boolean;
}

/** Obsidian's popover, with what isn't in the API's types */
type Popover = HoverPopover & { targetEl?: HTMLElement | null; staticPos: { x: number; y: number } | null; position(): void; hide(): void };

/** `PopoverState.Hidden` (the enum has no members in the API's types) */
const HIDDEN = 3;

/** The link each target's preview was asked for, until it shows */
const pending = new WeakMap<HTMLElement, string>();

/** The link each popover shows */
const shows = new WeakMap<HoverPopover, string>();

/** How long to wait for Obsidian's popover (it shows after 300 ms, then loads its content) */
const WAIT = 1500;

/** How far the pointer may drift away from the popover, past the closest it came, before it hides */
const DRIFT = 16;

/**
 * Shows a link's hover preview (Obsidian's page preview) for an element, once: Obsidian makes its
 * popover a hover parent's only after 300 ms, so every `mouseover` until then (one per child the
 * pointer crosses) would make another. The popover hides as soon as the pointer heads away from it
 * (rather than when Obsidian next looks, up to 800 ms later), or leaves it after being on it, or
 * reaches another link; a target the pointer already left (a preview asked for after an `await`)
 * gets none.
 */
export function hoverLink(app: App, link: HoverLink): void {
	const { targetEl, hoverParent, place, linktext, over } = link;
	if (pending.get(targetEl) === linktext || !targetEl.isConnected || !hovered(targetEl)) return;
	let shown = hoverParent.hoverPopover as Popover | null;
	if (shown && shown.state !== HIDDEN && shown.targetEl === targetEl) {
		// Obsidian keeps a target's popover, whatever link it was for
		if (!over || shows.get(shown) === linktext) return;
		shown.hide();
		shown = null;
	}
	pending.set(targetEl, linktext);
	const asked = () => pending.get(targetEl) === linktext;
	const leave = () => {
		if (asked()) pending.delete(targetEl);
	};
	targetEl.addEventListener('mouseleave', leave, { once: true });
	app.workspace.trigger('hover-link', {
		event: link.event,
		source: link.source,
		hoverParent,
		targetEl,
		linktext,
		sourcePath: link.sourcePath,
		state: link.state,
	});
	const win = targetEl.win;
	const start = Date.now();
	// Where the pointer is when the popover shows: Obsidian places a popover for a tall target (a
	// shared one) at the pointer as it last saw it, which it forgets once no popover is shown, and
	// then places it against the whole target, at the top of the screen
	const pointer = { x: link.event.clientX, y: link.event.clientY };
	const track = (e: PointerEvent) => {
		pointer.x = e.clientX;
		pointer.y = e.clientY;
	};
	if (over) targetEl.doc.addEventListener('pointermove', track, true);
	const look = () => {
		const popover = hoverParent.hoverPopover as Popover | null;
		if (!popover || popover === shown || popover.targetEl !== targetEl || popover.state === HIDDEN) {
			if (Date.now() - start < WAIT && asked()) win.requestAnimationFrame(look);
			else {
				leave();
				targetEl.doc.removeEventListener('pointermove', track, true);
			}
			return;
		}
		leave();
		targetEl.doc.removeEventListener('pointermove', track, true);
		if (over) {
			popover.staticPos = { ...pointer };
			if (!place) popover.position();
		}
		targetEl.removeEventListener('mouseleave', leave);
		shows.set(popover, linktext);
		if (place) {
			const position = popover.position.bind(popover);
			popover.position = () => {
				position();
				place(popover);
			};
			place(popover);
		}
		dismissAway(popover, targetEl, over);
	};
	win.requestAnimationFrame(look);
}

/** Whether the pointer is over an element (true where `:hover` can't be asked) */
function hovered(el: HTMLElement): boolean {
	try {
		return el.matches(':hover');
	} catch {
		return true;
	}
}

/** Hides a popover once the pointer heads away from it, leaves it after being on it, or reaches another link */
function dismissAway(popover: Popover, targetEl: HTMLElement, over?: (x: number, y: number) => boolean): void {
	const doc = targetEl.doc;
	let entered = false;
	let closest = Infinity;
	const move = (e: PointerEvent) => {
		if (popover.state === HIDDEN) return stop();
		const el = e.target as Element | null;
		if (!el) return;
		if (popover.hoverEl.contains(el)) {
			entered = true;
			return;
		}
		// Back on the link, or in a popover opened from this one
		if ((over ? over(e.clientX, e.clientY) : targetEl.contains(el)) || el.closest('.hover-popover')) {
			closest = Infinity;
			return;
		}
		if (entered || el.closest('a, .internal-link, .external-link, [data-href], .cm-hmd-internal-link, .cm-link, .cm-url')) return hide();
		const d = distance(popover.hoverEl.getBoundingClientRect(), e.clientX, e.clientY);
		closest = Math.min(closest, d);
		if (d > closest + DRIFT) hide();
	};
	const hide = () => {
		stop();
		popover.hide();
	};
	const stop = () => doc.removeEventListener('pointermove', move, true);
	doc.addEventListener('pointermove', move, true);
	popover.register(stop);
}

/** How far a point is from a rectangle (0 inside it) */
function distance(r: DOMRect, x: number, y: number): number {
	const dx = Math.max(r.left - x, 0, x - r.right);
	const dy = Math.max(r.top - y, 0, y - r.bottom);
	return Math.hypot(dx, dy);
}

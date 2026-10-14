/**
 * Smooth scrolling for reader keys. A press eases by its step (presses in a row add up); a held
 * key (its repeats) scrolls at a steady speed until `release`. Scrolling by other means (the
 * wheel, a touch, a jump) meanwhile stops it.
 */
export class KeyScroller {
	private el: HTMLElement | null = null;
	private raf = 0;
	/** Where the last frame left the scroll position (to notice scrolling by other means). */
	private expected = 0;
	/** The exact position (scrollTop rounds to device pixels). */
	private pos = 0;
	private anim: { from: number; to: number; start: number } | null = null;
	private hold: { velocity: number; last: number } | null = null;

	constructor(private duration = 180) {}

	/** Scroll `el` by `distance` px; `repeat`: the key is held, so go on at `speed` px/s instead. */
	press(el: HTMLElement, distance: number, repeat: boolean, speed: number): void {
		if (this.el !== el) this.stop();
		const running = !!this.raf;
		this.el = el;
		const now = el.win.performance.now();
		if (!running) this.expected = this.pos = el.scrollTop;
		if (repeat) {
			const velocity = Math.sign(distance) * speed;
			if (this.hold?.velocity !== velocity) this.hold = { velocity, last: now };
			this.anim = null;
		} else {
			this.hold = null;
			const max = el.scrollHeight - el.clientHeight;
			const base = this.anim ? this.anim.to : this.pos;
			this.anim = { from: this.pos, to: Math.max(0, Math.min(max, base + distance)), start: now };
		}
		if (!running) this.raf = el.win.requestAnimationFrame((t) => this.frame(t));
	}

	/** The held key went up. */
	release(): void {
		if (this.hold) this.stop();
	}

	stop(): void {
		if (this.raf && this.el) this.el.win.cancelAnimationFrame(this.raf);
		this.raf = 0;
		this.anim = this.hold = null;
	}

	private frame(t: number): void {
		this.raf = 0;
		const el = this.el;
		if (!el?.isConnected || Math.abs(el.scrollTop - this.expected) > 3) return this.stop();
		const max = el.scrollHeight - el.clientHeight;
		if (this.hold) {
			const dt = Math.min(50, t - this.hold.last);
			this.hold.last = t;
			this.pos = Math.max(0, Math.min(max, this.pos + (this.hold.velocity * dt) / 1000));
			if (this.pos === 0 || this.pos === max) this.hold = null;
		} else if (this.anim) {
			const p = Math.min(1, Math.max(0, (t - this.anim.start) / this.duration));
			const eased = 1 - (1 - p) ** 3;
			this.pos = this.anim.from + (this.anim.to - this.anim.from) * eased;
			if (p >= 1) this.anim = null;
		}
		el.scrollTop = this.pos;
		this.expected = el.scrollTop;
		if (this.hold || this.anim) this.raf = el.win.requestAnimationFrame((t2) => this.frame(t2));
	}
}

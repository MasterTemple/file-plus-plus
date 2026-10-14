/**
 * Reader key bindings as text: chords separated by spaces (`g g`), each chord modifiers and a key
 * joined by `+` (`Ctrl+d`, `Shift+Tab`). A character key is written as typed, Shift included (`G`,
 * `?`); a named key (`Tab`, `Enter`, `Space`, `ArrowDown`, `F5`) takes `Shift+` when shifted.
 * `Mod` is Cmd on macOS, Ctrl elsewhere. No dependency on Obsidian (unit tested).
 */

const MODIFIERS = ['Ctrl', 'Alt', 'Meta', 'Shift'] as const;
type ModifierName = (typeof MODIFIERS)[number];

const MODIFIER_ALIASES: Record<string, ModifierName | 'Mod'> = {
	ctrl: 'Ctrl',
	control: 'Ctrl',
	alt: 'Alt',
	option: 'Alt',
	opt: 'Alt',
	meta: 'Meta',
	cmd: 'Meta',
	command: 'Meta',
	win: 'Meta',
	super: 'Meta',
	shift: 'Shift',
	mod: 'Mod',
};

const NAMED_KEYS = ['Tab', 'Enter', 'Escape', 'Backspace', 'Delete', 'Insert', 'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`)];
const KEY_ALIASES: Record<string, string> = {
	...Object.fromEntries(NAMED_KEYS.map((k) => [k.toLowerCase(), k])),
	esc: 'Escape',
	return: 'Enter',
	del: 'Delete',
	up: 'ArrowUp',
	down: 'ArrowDown',
	left: 'ArrowLeft',
	right: 'ArrowRight',
	pgup: 'PageUp',
	pgdn: 'PageDown',
};

/** KeyboardEvent keys that are only modifiers (or not a key yet): never a chord of their own. */
const NOT_KEYS = ['Shift', 'Control', 'Alt', 'AltGraph', 'Meta', 'OS', 'CapsLock', 'Dead', 'Unidentified', 'Process'];

type KeyEventLike = Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'altKey' | 'metaKey' | 'shiftKey' | 'isComposing'>;

/** The chord a key press is, as bindings write it (`j`, `G`, `Ctrl+d`, `Shift+Tab`); null for a lone modifier. */
export function chordOf(e: KeyEventLike): string | null {
	if (e.isComposing || NOT_KEYS.includes(e.key)) return null;
	let key = e.key === ' ' ? 'Space' : e.key;
	// Alt (Option on a Mac) and Ctrl change the character (Option+J is ∆): use the key's letter or digit instead.
	if ((e.altKey || e.ctrlKey) && /^(Key[A-Z]|Digit\d)$/.test(e.code)) key = e.code.slice(-1)[e.shiftKey ? 'toUpperCase' : 'toLowerCase']();
	const mods: string[] = [];
	if (e.ctrlKey) mods.push('Ctrl');
	if (e.altKey) mods.push('Alt');
	if (e.metaKey) mods.push('Meta');
	// Shift is in a character (`G`), but named keys say it
	if (e.shiftKey && key.length > 1) mods.push('Shift');
	return [...mods, key].join('+');
}

/** One chord of a binding, normalized (`ctrl+D` → `Ctrl+D`, `Mod+k` → `Ctrl+k`); null if it isn't one. */
export function parseChord(text: string, isMac = false): string | null {
	// The key may itself be `+` (`Ctrl++`)
	const m = /^(.*?)\+?(\+|[^+]+)$/.exec(text);
	if (!m) return null;
	const [, modText, keyText] = m;
	const mods = new Set<ModifierName>();
	for (const part of modText ? modText.split('+') : []) {
		const name = MODIFIER_ALIASES[part.toLowerCase()];
		if (!name) return null;
		mods.add(name === 'Mod' ? (isMac ? 'Meta' : 'Ctrl') : name);
	}
	let key: string;
	if ([...keyText].length === 1) {
		key = keyText;
		// Shift+g is G (a character carries its Shift)
		if (mods.has('Shift') && key.toLowerCase() !== key.toUpperCase()) {
			mods.delete('Shift');
			key = key.toUpperCase();
		} else if (mods.has('Shift')) return null; // Shift+/ is ? on some keyboards and not others: write the character
	} else {
		const named = KEY_ALIASES[keyText.toLowerCase()];
		if (!named) return null;
		key = named;
	}
	return [...MODIFIERS.filter((n) => mods.has(n)), key].join('+');
}

/** A binding's chords (`'g g'` → `['g', 'g']`), [] for '' (off), null if it doesn't parse. */
export function parseBinding(text: string, isMac = false): string[] | null {
	const parts = text.trim().split(/\s+/).filter(Boolean);
	const chords = parts.map((p) => parseChord(p, isMac));
	return chords.every((c): c is string => c !== null) ? chords : null;
}

export type SequenceResult =
	/** A binding's sequence is complete. */
	| { kind: 'run'; action: string }
	/** The keys so far start a longer binding; `fallback` is the shorter one they complete, if any (run it when no key follows). */
	| { kind: 'pending'; fallback: string | null }
	/** Not part of any binding. */
	| { kind: 'none' };

/** Matches key presses against bindings that may be several chords long (`g g`). */
export class SequenceMatcher {
	private pending: string[] = [];

	/** Forget keys typed so far (a timeout, a click, a key that went elsewhere). */
	reset(): void {
		this.pending = [];
	}

	get isPending(): boolean {
		return this.pending.length > 0;
	}

	feed(chord: string, bindings: ReadonlyMap<string, readonly string[]>): SequenceResult {
		const seq = [...this.pending, chord];
		let exact: string | null = null;
		let longer = false;
		for (const [action, chords] of bindings) {
			if (!chords.length || chords.length < seq.length || !seq.every((c, i) => chords[i] === c)) continue;
			if (chords.length === seq.length) exact ??= action;
			else longer = true;
		}
		if (longer) {
			this.pending = seq;
			return { kind: 'pending', fallback: exact };
		}
		this.pending = [];
		if (exact) return { kind: 'run', action: exact };
		// `g x`: the `g` led nowhere, but `x` may be a binding of its own
		return seq.length > 1 ? this.feed(chord, bindings) : { kind: 'none' };
	}
}

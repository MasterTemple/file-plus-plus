import { expect, test } from 'bun:test';
import { chordOf, parseBinding, parseChord, SequenceMatcher } from '../src/obsidian/key-sequence';

const ev = (key: string, mods: Partial<KeyboardEvent> = {}) => ({ key, code: /^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : '', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, isComposing: false, ...mods }) as KeyboardEvent;

test('chordOf: characters as typed, named keys with Shift+, modifiers in front', () => {
	expect(chordOf(ev('j'))).toBe('j');
	expect(chordOf(ev('G', { shiftKey: true }))).toBe('G');
	expect(chordOf(ev('/'))).toBe('/');
	expect(chordOf(ev('Tab'))).toBe('Tab');
	expect(chordOf(ev('Tab', { shiftKey: true }))).toBe('Shift+Tab');
	expect(chordOf(ev(' '))).toBe('Space');
	expect(chordOf(ev('d', { ctrlKey: true }))).toBe('Ctrl+d');
	expect(chordOf(ev('D', { ctrlKey: true, shiftKey: true }))).toBe('Ctrl+D');
	// Option+J on a Mac types ∆
	expect(chordOf({ ...ev('∆', { altKey: true }), code: 'KeyJ' })).toBe('Alt+j');
	expect(chordOf(ev('Shift', { shiftKey: true }))).toBeNull();
	expect(chordOf(ev('Control', { ctrlKey: true }))).toBeNull();
});

test('parseChord / parseBinding: normalized, aliases, Shift folded into characters', () => {
	expect(parseBinding('g g')).toEqual(['g', 'g']);
	expect(parseBinding('  G ')).toEqual(['G']);
	expect(parseBinding('')).toEqual([]);
	expect(parseChord('ctrl+d')).toBe('Ctrl+d');
	expect(parseChord('Shift+Ctrl+tab')).toBe('Ctrl+Shift+Tab');
	expect(parseChord('shift+g')).toBe('G');
	expect(parseChord('Mod+k')).toBe('Ctrl+k');
	expect(parseChord('Mod+k', true)).toBe('Meta+k');
	expect(parseChord('cmd+k')).toBe('Meta+k');
	expect(parseChord('esc')).toBe('Escape');
	expect(parseChord('Ctrl++')).toBe('Ctrl++');
	expect(parseChord('\\')).toBe('\\');
	expect(parseChord('Hyper+k')).toBeNull();
	expect(parseChord('Ctrl+Nope')).toBeNull();
	expect(parseChord('Shift+/')).toBeNull();
	expect(parseBinding('g Nope')).toBeNull();
	// Every chord a key press makes parses back to itself
	for (const c of ['j', 'G', 'Ctrl+d', 'Shift+Tab', 'Space', 'Alt+j', '/', '\\']) expect(parseChord(c)).toBe(c);
});

test('SequenceMatcher: multi-key bindings, prefixes, fallbacks and restarts', () => {
	const b = new Map([
		['top', ['g', 'g']],
		['bottom', ['G']],
		['go', ['g']],
		['down', ['j']],
		['off', []],
	]);
	const m = new SequenceMatcher();
	expect(m.feed('G', b)).toEqual({ kind: 'run', action: 'bottom' });
	expect(m.feed('g', b)).toEqual({ kind: 'pending', fallback: 'go' });
	expect(m.isPending).toBe(true);
	expect(m.feed('g', b)).toEqual({ kind: 'run', action: 'top' });
	expect(m.isPending).toBe(false);
	expect(m.feed('x', b)).toEqual({ kind: 'none' });
	expect(m.isPending).toBe(false);
	// `g` is a binding too: run before what follows it
	m.feed('g', b);
	expect(m.feed('j', b)).toEqual({ kind: 'run', action: 'down', before: 'go' });
	m.feed('g', b);
	expect(m.feed('x', b)).toEqual({ kind: 'none', before: 'go' });
	const only = new Map([['top', ['g', 'g']]]);
	expect(m.feed('g', only)).toEqual({ kind: 'pending', fallback: null });
	// `g j`: the g leads nowhere, j runs on its own
	expect(m.feed('j', only)).toEqual({ kind: 'none' });
});

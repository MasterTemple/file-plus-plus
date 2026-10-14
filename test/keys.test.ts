import { expect, test } from 'bun:test';
import { keyName } from '../src/obsidian/keys';

const ev = (key: string, mods: Partial<KeyboardEvent> = {}) => ({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, isComposing: false, ...mods }) as KeyboardEvent;

test('keyName: characters as typed, named keys with Shift+, nothing with modifiers', () => {
	expect(keyName(ev('j'))).toBe('j');
	expect(keyName(ev('J', { shiftKey: true }))).toBe('J');
	expect(keyName(ev('/'))).toBe('/');
	expect(keyName(ev('Tab'))).toBe('Tab');
	expect(keyName(ev('Tab', { shiftKey: true }))).toBe('Shift+Tab');
	expect(keyName(ev(' '))).toBe('Space');
	expect(keyName(ev('j', { ctrlKey: true }))).toBeNull();
	expect(keyName(ev('Shift', { shiftKey: true }))).toBeNull();
});

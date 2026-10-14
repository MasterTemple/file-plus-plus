import { Platform } from 'obsidian';
import type { FilePlusPlusPlugin } from './plugin';
import type { DocumentView } from './view';
import type { ReaderKeyAction } from './settings';
import { chordOf, parseBinding, SequenceMatcher } from './key-sequence';

/** Whether the focus is where a key types (an input, a comment, the editor), so reader keys leave it alone. */
export function typing(): boolean {
	const el = activeDocument.activeElement as HTMLElement | null;
	return !!el && (el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT');
}

/** How long a binding of several keys (`g g`) waits for its next key, as Vim's `timeoutlen`. */
const SEQUENCE_TIMEOUT = 1000;

interface ScopeKey {
	func: (evt: KeyboardEvent) => false | void;
}

/**
 * Reader keys in a focused document: the number keys pick a color, and `readerKeys` (vim-like, may
 * have modifiers or be several keys long, `g g`). Never while typing, or while a menu or modal is
 * open. They are looked at first in Obsidian's root key scope, ahead of its hotkeys (so `Ctrl+d`
 * can be one), and keys they don't use go on to the hotkeys.
 */
export function registerReaderKeys(plugin: FilePlusPlusPlugin): void {
	const actions: Record<ReaderKeyAction, (v: DocumentView) => void> = {
		'scroll-down': (v) => scroll(v, 0.15),
		'scroll-up': (v) => scroll(v, -0.15),
		'page-down': (v) => scroll(v, 0.5),
		'page-up': (v) => scroll(v, -0.5),
		top: (v) => v.reader!.scroller.scrollTo({ top: 0, behavior: 'smooth' }),
		bottom: (v) => v.reader!.scroller.scrollTo({ top: v.reader!.scroller.scrollHeight, behavior: 'smooth' }),
		search: (v) => {
			v.sidebar.setKeyMode(null);
			v.openSearch();
		},
		'next-result': (v) => v.sidebar.stepResults(1),
		'prev-result': (v) => v.sidebar.stepResults(-1),
		outline: (v) => (v.sidebar.keysMode() === 'toc' ? leaveOutline(v) : v.openOutlineKeys()),
		sidebar: (v) => {
			v.sidebar.setKeyMode(null);
			v.toggleSidebar();
		},
		comments: () => (plugin.app as any).commands.executeCommandById(`${plugin.manifest.id}:toggle-margin-comments`),
	};
	/** Back to the text from the outline (a drawer-style sidebar closes). */
	const leaveOutline = (v: DocumentView) => {
		v.sidebar.setKeyMode(null);
		if (v.sidebarIsOverlay()) v.toggleSidebar(false, false);
	};
	const scroll = (v: DocumentView, screens: number) => {
		const el = v.reader!.scroller;
		el.scrollBy({ top: Math.round(el.clientHeight * screens), behavior: 'smooth' });
	};

	// The bindings, parsed again when the settings change (one that doesn't parse is off)
	let parsedFrom = '';
	let bindings = new Map<ReaderKeyAction, string[]>();
	const currentBindings = () => {
		const text = JSON.stringify(plugin.settings.readerKeys);
		if (text !== parsedFrom) {
			parsedFrom = text;
			bindings = new Map((Object.entries(plugin.settings.readerKeys) as [ReaderKeyAction, string][]).map(([id, k]) => [id, parseBinding(k, Platform.isMacOS) ?? []]));
		}
		return bindings;
	};

	const matcher = new SequenceMatcher();
	let timer: number | undefined;
	const clearPending = () => {
		window.clearTimeout(timer);
		matcher.reset();
	};

	/** What an action does where the keys are: in the outline and the results, moving means moving through them. */
	const perform = (v: DocumentView, action: ReaderKeyAction) => {
		const sidebar = v.sidebar;
		const mode = sidebar.keysMode();
		const step: Partial<Record<ReaderKeyAction, number>> = { 'scroll-down': 1, 'scroll-up': -1, top: -Infinity, bottom: Infinity };
		const by = step[action];
		if (mode === 'toc' && by !== undefined) return sidebar.moveTocCursor(by);
		if (mode === 'results' && by !== undefined) return sidebar.moveResults(by);
		actions[action](v);
	};

	/** Keys of the outline and the results that aren't bindings: arrows, h / l, Enter, Escape. */
	const modeKey = (v: DocumentView, chord: string): (() => void) | null => {
		const sidebar = v.sidebar;
		const mode = sidebar.keysMode();
		if (mode && !v.sidebarTabShown(mode === 'toc' ? 'toc' : 'search')) sidebar.setKeyMode(null);
		else if (mode === 'toc') {
			if (chord === 'ArrowDown' || chord === 'ArrowUp') return () => sidebar.moveTocCursor(chord === 'ArrowDown' ? 1 : -1);
			if (chord === 'h' || chord === 'ArrowLeft') return () => sidebar.foldTocCursor(false);
			if (chord === 'l' || chord === 'ArrowRight') return () => sidebar.foldTocCursor(true);
			if (chord === 'Enter') return () => sidebar.openTocCursor();
			if (chord === 'Escape') return () => leaveOutline(v);
		} else if (mode === 'results') {
			if (chord === 'ArrowDown' || chord === 'ArrowUp') return () => sidebar.moveResults(chord === 'ArrowDown' ? 1 : -1);
			if (chord === 'Enter') return () => sidebar.leaveResults();
			if (chord === 'Escape') return () => sidebar.setKeyMode(null);
		}
		return null;
	};

	/** false: the key was used (Obsidian then stops it); undefined: it goes on to the hotkeys. */
	const handle = (e: KeyboardEvent): false | void => {
		const s = plugin.settings;
		if (!s.numberKeyColors && !s.readerKeysEnabled) return;
		const chord = chordOf(e);
		if (!chord) return; // a modifier on its own: a sequence goes on
		const v = plugin.activeView();
		if (!v?.reader || typing() || activeDocument.querySelector('body > .modal-container, body > .menu, body > .suggestion-container')) return clearPending();
		if (!matcher.isPending) {
			if (s.numberKeyColors && /^\d$/.test(chord)) {
				const n = Number(chord);
				const color = n === 0 ? null : s.palette[n - 1];
				if (color === undefined) return;
				v.setActiveColor(color?.name ?? null);
				return false;
			}
			if (!s.readerKeysEnabled) return;
			const fixed = modeKey(v, chord);
			if (fixed) {
				fixed();
				return false;
			}
		}
		if (!s.readerKeysEnabled) return;
		window.clearTimeout(timer);
		const r = matcher.feed(chord, currentBindings());
		if (r.kind === 'none') return;
		if (r.kind === 'run') perform(v, r.action as ReaderKeyAction);
		else
			timer = window.setTimeout(() => {
				matcher.reset();
				const view = plugin.activeView();
				if (r.fallback && view?.reader) perform(view, r.fallback as ReaderKeyAction);
			}, SEQUENCE_TIMEOUT);
		return false;
	};

	// First in the root scope, as a wildcard (any key, any modifiers) that passes keys on by returning nothing
	const root = plugin.app.scope as unknown as { keys: ScopeKey[]; register(m: null, k: null, f: ScopeKey['func']): ScopeKey; unregister(k: ScopeKey): void };
	const entry = root.register(null, null, handle);
	root.keys.splice(root.keys.indexOf(entry), 1);
	root.keys.unshift(entry);
	plugin.register(() => {
		clearPending();
		root.unregister(entry);
	});
	// Clicking anywhere leaves the outline's or the results' key mode, and forgets a half-typed sequence.
	plugin.registerDomEvent(document, 'mousedown', () => {
		clearPending();
		for (const v of plugin.views()) v.sidebar?.setKeyMode(null);
	});
}

import { Platform } from 'obsidian';
import type { FilePlusPlusPlugin } from './plugin';
import type { DocumentView } from './view';
import type { ReaderKeyAction } from './settings';
import { chordOf, parseBinding, SequenceMatcher } from './key-sequence';
import type { Place } from './jump-list';
import { KeyScroller } from './key-scroll';
import { endSentenceHints, sentenceHintKey, sentenceHintsShown } from './sentence-hints';

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
		'scroll-down': (v) => scroll(v, 0.15, 1.2),
		'scroll-up': (v) => scroll(v, -0.15, 1.2),
		'page-down': (v) => scroll(v, 0.5, 2.5),
		'page-up': (v) => scroll(v, -0.5, 2.5),
		'screen-down': (v) => scroll(v, 0.9, 4),
		'screen-up': (v) => scroll(v, -0.9, 4),
		'set-mark': (v) => (awaiting = { action: 'set-mark', view: v }),
		'go-to-mark': (v) => (awaiting = { action: 'go-to-mark', view: v }),
		top: (v) => {
			scroller.stop();
			v.reader!.scrollToEdge('start');
		},
		bottom: (v) => {
			scroller.stop();
			v.reader!.scrollToEdge('end');
		},
		'jump-back': (v) => travel(v, -1),
		'jump-forward': (v) => travel(v, 1),
		search: (v) => {
			v.sidebar.setKeyMode(null);
			v.openSearch();
		},
		'next-result': (v) => v.sidebar.stepResults(1),
		'prev-result': (v) => v.sidebar.stepResults(-1),
		outline: (v) => (v.sidebar.keysMode() === 'toc' ? v.backToText() : v.openOutlineKeys()),
		sidebar: (v) => {
			v.sidebar.setKeyMode(null);
			v.toggleSidebar();
		},
		'open-file': () => command('open-file'),
		'hint-highlight': () => command('highlight-sentence'),
		'hint-comment': () => command('comment-on-sentence'),
		'hint-words-highlight': () => command('highlight-words'),
		'hint-words-comment': () => command('comment-on-words'),
		comments: () => command('toggle-margin-comments'),
		highlights: () => command('toggle-highlights'),
		'next-highlight': () => command('next-highlight'),
		'prev-highlight': () => command('previous-highlight'),
		'next-comment': () => command('next-comment'),
		'prev-comment': () => command('previous-comment'),
	};
	const command = (id: string) => (plugin.app as any).commands.executeCommandById(`${plugin.manifest.id}:${id}`);
	const scroller = new KeyScroller();
	/** By `screens` of the view (a held key: on at `speed` screens a second). */
	const scroll = (v: DocumentView, screens: number, speed: number) => {
		const el = v.reader!.scroller;
		scroller.press(el, Math.round(el.clientHeight * screens), repeat, el.clientHeight * speed);
	};
	/** Whether the key being handled is a held key's repeat */
	let repeat = false;

	// Marks: a–z per document, A–Z across documents, ' (or `) where the view was before its last jump
	const rememberJump = (v: DocumentView) => v.recordJump();
	const jumpTo = (v: DocumentView, target: Place) => {
		v.recordJump();
		void v.showPlace(target);
	};
	/** Ctrl+O (`by` -1) / Ctrl+I (1): back and forth through the view's jump list. */
	const travel = (v: DocumentView, by: number) => {
		const target = by < 0 ? v.jumps.back(v.here()) : v.jumps.forward();
		if (target) void v.showPlace(target);
	};
	const setMark = (v: DocumentView, name: string) => {
		const locator = v.reader?.getLocation()?.locator;
		if (!v.file || !locator || !/^[a-zA-Z]$/.test(name)) return;
		const s = plugin.settings;
		if (name === name.toLowerCase()) (s.marks[v.file.path] ??= {})[name] = locator;
		else s.globalMarks[name] = { path: v.file.path, locator };
		void plugin.saveSettings();
		plugin.notice(`mark ${name} set.`, 1500);
	};
	const goToMark = (v: DocumentView, name: string) => {
		if (!v.file) return;
		const s = plugin.settings;
		const target =
			name === "'" || name === '`'
				? v.lastJump
				: name === name.toLowerCase()
					? ((locator) => locator && { path: v.file!.path, locator })(s.marks[v.file.path]?.[name])
					: s.globalMarks[name];
		if (!target) return plugin.notice(name === "'" || name === '`' ? 'no jump to go back to yet.' : `mark ${name} isn't set.`, 2000);
		jumpTo(v, target);
	};
	/** An action that takes the next key as its argument (the mark's letter) */
	let awaiting: { action: 'set-mark' | 'go-to-mark'; view: DocumentView } | null = null;

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
		endSentenceHints();
		window.clearTimeout(timer);
		matcher.reset();
		awaiting = null;
	};

	/** What an action does where the keys are: in the outline and the results, moving means moving through them. */
	const perform = (v: DocumentView, action: ReaderKeyAction) => {
		const sidebar = v.sidebar;
		const mode = sidebar.keysMode();
		const step: Partial<Record<ReaderKeyAction, number>> = { 'scroll-down': 1, 'scroll-up': -1, top: -Infinity, bottom: Infinity };
		const by = step[action];
		if (!mode && (action === 'top' || action === 'bottom' || action === 'next-result' || action === 'prev-result' || action === 'search')) rememberJump(v);
		if (mode === 'toc' && by !== undefined) return sidebar.moveTocCursor(by);
		if (mode === 'results' && by !== undefined) return sidebar.moveResults(by);
		actions[action](v);
	};

	/** Keys of the outline and the results that aren't bindings: arrows, h / l, Enter, Escape; Escape in the text. */
	const modeKey = (v: DocumentView, chord: string): (() => void) | null => {
		const sidebar = v.sidebar;
		const mode = sidebar.keysMode();
		if (mode && !v.sidebarTabShown(mode === 'toc' ? 'toc' : 'search')) sidebar.setKeyMode(null);
		else if (!mode) {
			// In the text: the search results stop being drawn (n / N show them again)
			if (chord === 'Escape' && sidebar.resultsDrawn()) return () => sidebar.hideResults();
		} else if (mode === 'toc') {
			if (chord === 'ArrowDown' || chord === 'ArrowUp') return () => sidebar.moveTocCursor(chord === 'ArrowDown' ? 1 : -1);
			if (chord === 'h' || chord === 'ArrowLeft') return () => sidebar.foldTocCursor(false);
			if (chord === 'l' || chord === 'ArrowRight') return () => sidebar.foldTocCursor(true);
			if (chord === 'Enter')
				return () => {
					sidebar.openTocCursor();
					v.backToText();
				};
			if (chord === 'Escape') return () => v.backToText();
		} else if (mode === 'results') {
			if (chord === 'ArrowDown' || chord === 'ArrowUp') return () => sidebar.moveResults(chord === 'ArrowDown' ? 1 : -1);
			if (chord === 'Enter' || chord === 'Escape') return () => v.backToText();
		}
		return null;
	};

	/** false: the key was used (Obsidian then stops it); undefined: it goes on to the hotkeys. */
	const handle = (e: KeyboardEvent): false | void => {
		const s = plugin.settings;
		const chord = chordOf(e);
		if (!chord) return; // a modifier on its own: a sequence goes on
		// Sentence labels shown (also when picked from a command): keys type a label
		if (sentenceHintsShown() && !typing()) {
			sentenceHintKey(chord);
			return false;
		}
		if (!s.numberKeyColors && !s.readerKeysEnabled) return;
		repeat = e.repeat;
		const v = plugin.activeView();
		if (!v?.reader || typing() || activeDocument.querySelector('body > .modal-container, body > .menu, body > .suggestion-container')) return clearPending();
		if (awaiting) {
			const { action, view } = awaiting;
			awaiting = null;
			if (view === v && chord !== 'Escape') (action === 'set-mark' ? setMark : goToMark)(v, chord);
			return false;
		}
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
	// A held scroll key goes up: stop
	plugin.registerDomEvent(document, 'keyup', () => scroller.release(), { capture: true });
	plugin.registerDomEvent(window, 'blur', () => scroller.release());
	plugin.register(() => scroller.stop());
	// Clicking anywhere leaves the outline's or the results' key mode, and forgets a half-typed sequence.
	plugin.registerDomEvent(document, 'mousedown', () => {
		clearPending();
		for (const v of plugin.views()) v.sidebar?.setKeyMode(null);
	});
}

import type { FilePlusPlusPlugin } from './plugin';
import type { DocumentView } from './view';
import type { ReaderKeyAction } from './settings';

/** Whether the focus is where a key types (an input, a comment, the editor), so reader keys leave it alone. */
export function typing(): boolean {
	const el = activeDocument.activeElement as HTMLElement | null;
	return !!el && (el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT');
}

/**
 * A key as `readerKeys` names it: a character as typed (`j`, `J`, `/`), or a named key (`Tab`,
 * `Shift+Tab`, `ArrowDown`). Null with Ctrl/Cmd/Alt: those are Obsidian's hotkeys.
 */
export function keyName(e: KeyboardEvent): string | null {
	if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return null;
	if (['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Dead', 'Unidentified', 'Process'].includes(e.key)) return null;
	if (e.key === ' ') return 'Space';
	return e.key.length === 1 || !e.shiftKey ? e.key : `Shift+${e.key}`;
}

/** How a key name shows in the settings. */
export function keyLabel(key: string): string {
	return key === '' ? 'Off' : key === ' ' ? 'Space' : key;
}

/**
 * Keys without modifiers in a focused document (Obsidian's hotkeys can't be bare keys): the number
 * keys pick a color, and the vim-like `readerKeys`. Never while typing, or while a menu or modal is open.
 */
export function registerReaderKeys(plugin: FilePlusPlusPlugin): void {
	const actions: Record<ReaderKeyAction, (v: DocumentView) => void> = {
		'scroll-down': (v) => scroll(v, 0.15),
		'scroll-up': (v) => scroll(v, -0.15),
		'page-down': (v) => scroll(v, 0.5),
		'page-up': (v) => scroll(v, -0.5),
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
	const handle = (e: KeyboardEvent) => {
		const s = plugin.settings;
		if (!s.numberKeyColors && !s.readerKeysEnabled) return;
		const key = keyName(e);
		const v = plugin.activeView();
		if (!v?.reader || activeDocument.querySelector('body > .modal-container, body > .menu, body > .suggestion-container')) return;
		const run = (fn: () => void) => {
			e.preventDefault();
			e.stopPropagation();
			fn();
		};
		const sidebar = v.sidebar;
		if (!key || typing()) return;
		if (s.numberKeyColors && /^\d$/.test(key)) {
			const n = Number(key);
			const color = n === 0 ? null : s.palette[n - 1];
			if (color !== undefined) run(() => v.setActiveColor(color?.name ?? null));
			return;
		}
		if (!s.readerKeysEnabled) return;
		const bound = (id: ReaderKeyAction) => s.readerKeys[id] === key;
		const move = bound('scroll-down') || key === 'ArrowDown' ? 1 : bound('scroll-up') || key === 'ArrowUp' ? -1 : 0;
		// The outline: the scroll keys and arrows move, h / l fold, Enter goes there.
		const mode = sidebar.keysMode();
		if (mode && !v.sidebarTabShown(mode === 'toc' ? 'toc' : 'search')) sidebar.setKeyMode(null);
		else if (mode === 'toc') {
			if (move) return run(() => sidebar.moveTocCursor(move));
			if (key === 'h' || key === 'ArrowLeft') return run(() => sidebar.foldTocCursor(false));
			if (key === 'l' || key === 'ArrowRight') return run(() => sidebar.foldTocCursor(true));
			if (key === 'Enter') return run(() => sidebar.openTocCursor());
			if (key === 'Escape') return run(() => leaveOutline(v));
		} else if (mode === 'results') {
			// The search results: the scroll keys and arrows move (the document follows), Enter goes there.
			if (move) return run(() => sidebar.stepResults(move));
			if (key === 'Enter') return run(() => sidebar.leaveResults());
			if (key === 'Escape') return run(() => sidebar.setKeyMode(null));
		}
		const action = (Object.keys(actions) as ReaderKeyAction[]).find(bound);
		if (action) run(() => actions[action](v));
	};
	// Capture: ahead of the sidebar's own handling (Tab moving the focus)
	plugin.registerDomEvent(document, 'keydown', handle, { capture: true });
	// Clicking anywhere leaves the outline's or the results' key mode.
	plugin.registerDomEvent(document, 'mousedown', () => {
		for (const v of plugin.views()) v.sidebar?.setKeyMode(null);
	});
}

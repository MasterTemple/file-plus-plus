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
		search: (v) => v.openSearch(),
		outline: (v) => {
			if (!v.sidebarTabShown('toc') || !v.sidebar.tocKeysActive()) return v.openOutlineKeys();
			v.sidebar.setTocKeys(false);
			v.toggleSidebar(false);
		},
		'left-sidebar': () => {
			const split = plugin.app.workspace.leftSplit as unknown as { collapsed: boolean; expand(): void; collapse(): void };
			if (split.collapsed) split.expand();
			else split.collapse();
		},
		comments: () => (plugin.app as any).commands.executeCommandById(`${plugin.manifest.id}:toggle-margin-comments`),
	};
	const scroll = (v: DocumentView, screens: number) => {
		const el = v.reader!.scroller;
		el.scrollBy({ top: Math.round(el.clientHeight * screens), behavior: 'smooth' });
	};
	const handle = (e: KeyboardEvent) => {
		const s = plugin.settings;
		if (!s.numberKeyColors && !s.readerKeysEnabled) return;
		const key = keyName(e);
		const v = key ? plugin.activeView() : null;
		if (!key || !v?.reader || typing() || activeDocument.querySelector('body > .modal-container, body > .menu, body > .suggestion-container')) return;
		const run = (fn: () => void) => {
			e.preventDefault();
			e.stopPropagation();
			fn();
		};
		if (s.numberKeyColors && /^\d$/.test(key)) {
			const n = Number(key);
			const color = n === 0 ? null : s.palette[n - 1];
			if (color !== undefined) run(() => v.setActiveColor(color?.name ?? null));
			return;
		}
		if (!s.readerKeysEnabled) return;
		const bound = (id: ReaderKeyAction) => s.readerKeys[id] === key;
		// Moving through the outline: the scroll keys and arrows move, h / l fold, Enter goes there.
		const toc = v.sidebar;
		if (toc.tocKeysActive()) {
			if (!v.sidebarTabShown('toc')) toc.setTocKeys(false);
			else {
				const move = bound('scroll-down') || key === 'ArrowDown' ? 1 : bound('scroll-up') || key === 'ArrowUp' ? -1 : 0;
				if (move) return run(() => toc.moveTocCursor(move));
				if (key === 'h' || key === 'ArrowLeft') return run(() => toc.foldTocCursor(false));
				if (key === 'l' || key === 'ArrowRight') return run(() => toc.foldTocCursor(true));
				if (key === 'Enter') return run(() => toc.openTocCursor());
				if (key === 'Escape') return run(() => toc.setTocKeys(false));
			}
		}
		const action = (Object.keys(actions) as ReaderKeyAction[]).find(bound);
		if (action) run(() => actions[action](v));
	};
	// Capture: ahead of the sidebar's own handling (Tab moving the focus)
	plugin.registerDomEvent(document, 'keydown', handle, { capture: true });
	// Clicking anywhere leaves the outline's key mode.
	plugin.registerDomEvent(document, 'mousedown', () => {
		for (const v of plugin.views()) v.sidebar?.setTocKeys(false);
	});
}

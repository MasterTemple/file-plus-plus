import type { MarginNote } from '../core';
import { Component, MarkdownRenderer, Menu, setIcon } from 'obsidian';
import type { HighlightEntry } from './highlight-index';
import type { Annotation, AnnotationProvider } from '../obsidian/api';
import type { DocumentView } from '../obsidian/view';

/** A provider's annotations that have a `note`, as last fetched by the view. */
export interface ProviderNotes {
	provider: AnnotationProvider<unknown>;
	layer: string;
	annotations: Annotation[];
}

interface Card {
	/** What the card shows; it is rebuilt when this changes. */
	key: string;
	el: HTMLElement;
	child: Component;
}

/**
 * Comments of highlights (and notes of other plugins' annotations) as cards in the reader's margin,
 * beside their passages (see `Margin` in core). Hovering a card emphasizes its passage; clicking it
 * brings it next to the passage; a double click edits the comment; right-click opens the highlight menu.
 */
export class MarginComments extends Component {
	private cards = new Map<string, Card>();
	private hovered = new Set<string>();

	constructor(private view: DocumentView<any, any>) {
		super();
	}

	/** True while the margin shows (enabled, any comments, and the pane is wide enough). */
	get visible(): boolean {
		return !!this.view.reader?.isRendered && this.view.reader.margin.visible;
	}

	/** Rebuild the notes from the view's highlights and providers. */
	update(highlights: HighlightEntry[], providers: ProviderNotes[]): void {
		const reader = this.view.reader;
		if (!reader?.isRendered) return;
		const margin = reader.margin;
		margin.setEnabled(this.view.showsComments());
		const notes: MarginNote[] = [];
		const seen = new Set<string>();
		const file = this.view.file;
		const annPath = (file && this.view.plugin.annotator.annotations.find(file)?.path) ?? null;
		for (const e of highlights) {
			if (!e.comment) continue;
			const id = `hl:${e.id}`;
			seen.add(id);
			const inAnn = e.sourcePath === annPath;
			const key = [e.comment, e.color, e.updated?.getTime(), e.sourcePath, e.heading, inAnn].join('\u0000');
			const el = this.card(id, key, (el, child) => this.buildHighlightCard(el, child, e, inAnn));
			notes.push({ id, range: reader.highlightRange(e.id), el });
		}
		for (const p of providers) {
			for (const a of p.annotations) {
				if (!a.note) continue;
				const id = `${p.layer}:${a.id}`;
				seen.add(id);
				const el = this.card(id, [a.note, a.label, a.color ?? p.provider.color].join('\u0000'), (el, child) => this.buildAnnotationCard(el, child, p, a));
				notes.push({ id, range: reader.layerRange(p.layer, a.id), el });
			}
		}
		for (const [id, c] of this.cards) {
			if (seen.has(id)) continue;
			this.removeChild(c.child);
			c.el.remove();
			this.cards.delete(id);
		}
		margin.set(notes);
		this.applyHover();
		this.syncReveal();
	}

	/** The reader is going away: forget the cards (its margin removes their elements). */
	reset(): void {
		for (const c of this.cards.values()) this.removeChild(c.child);
		this.cards.clear();
		this.hovered.clear();
		this.cardHover = null;
		this.textHover = [];
	}

	/** Highlights under the pointer in the text: mark their cards. */
	hoverHighlights(entries: HighlightEntry[]): void {
		this.hovered = new Set(entries.map((e) => `hl:${e.id}`));
		this.textHover = entries.map((e) => e.id);
		this.applyHover();
		this.syncReveal();
	}

	/** Highlights under the pointer in the text (focused too, while highlights are shown). */
	private textHover: string[] = [];

	/** Bring the card of a highlight next to its passage (a highlight was clicked). */
	activateHighlight(entry: HighlightEntry): void {
		if (entry.comment && this.visible) this.view.reader?.margin.setActive(`hl:${entry.id}`);
		this.syncReveal();
	}

	/** The highlight whose card the pointer is on, if any. */
	private cardHover: string | null = null;

	/**
	 * The highlight of the comment being looked at (hovered or selected) stands out: the others are
	 * dimmed, or, with highlights hidden, it alone is drawn.
	 */
	private syncReveal(): void {
		const reader = this.view.reader;
		if (!reader) return;
		const active = reader.margin.activeId;
		const ids = [this.cardHover, active?.startsWith('hl:') ? active.slice(3) : null].filter((x): x is string => !!x);
		if (!this.view.plugin.settings.hideHighlights) ids.push(...this.textHover);
		reader.setFocusedHighlights(ids);
	}

	private applyHover(): void {
		for (const [id, c] of this.cards) c.el.toggleClass('is-hovered', this.hovered.has(id));
	}

	private card(id: string, key: string, build: (el: HTMLElement, child: Component) => void): HTMLElement {
		const old = this.cards.get(id);
		if (old?.key === key) return old.el;
		if (old) this.removeChild(old.child);
		const el = old?.el ?? createDiv();
		el.empty();
		el.className = 'fpp-mc';
		const child = this.addChild(new Component());
		build(el, child);
		this.cards.set(id, { key, el, child });
		return el;
	}

	private colorCss(color: string | undefined): string {
		const s = this.view.plugin.settings;
		const name = color || s.defaultColor;
		return s.palette.find((p) => p.name === name)?.color ?? name ?? 'var(--text-highlight-bg)';
	}

	/** `inAnnotationFile`: the comment is in the document's annotation file, so the card doesn't name its note. */
	private buildHighlightCard(el: HTMLElement, child: Component, e: HighlightEntry, inAnnotationFile: boolean): void {
		const { view } = this;
		el.style.setProperty('--swatch', this.colorCss(e.color));
		const body = el.createDiv('fpp-mc-body markdown-rendered');
		void MarkdownRenderer.render(view.app, e.comment!, body, e.sourcePath, child);
		this.handleLinks(body, e.sourcePath);
		const noteName = e.sourcePath.split('/').pop()!.replace(/\.md$/, '');
		const meta = !inAnnotationFile || e.updated ? el.createDiv('fpp-mc-meta') : null;
		if (meta && !inAnnotationFile) {
			const label = view.plugin.format.highlightLabel?.(e.locator, view.file) ?? noteName;
			const note = meta.createEl('a', { cls: 'fpp-mc-source', text: label });
			note.setAttr('aria-label', e.heading ? `${e.sourcePath} › ${e.heading}` : e.sourcePath);
			note.addEventListener('click', (ev) => {
				ev.stopPropagation();
				void view.plugin.annotator.openSource(e, view);
			});
		}
		if (meta && e.updated) {
			meta.createSpan({ cls: 'fpp-mc-time', text: timeAgo(e.updated), attr: { 'aria-label': `Updated ${e.updated.toLocaleString()}` } });
		}
		const actions = el.createDiv('fpp-mc-actions');
		const action = (icon: string, label: string, fn: () => void) => {
			const b = actions.createDiv({ cls: 'clickable-icon', attr: { 'aria-label': label } });
			setIcon(b, icon);
			b.addEventListener('click', (ev) => {
				ev.stopPropagation();
				fn();
			});
		};
		action('pencil', 'Edit comment', () => void view.editComment(e));
		action('file-text', `Open in "${noteName}"`, () => void view.plugin.annotator.openSource(e, view));
		this.bindCard(el, `hl:${e.id}`, [e.id], (menu) => view.addHighlightItems(menu, [e]));
		el.addEventListener('dblclick', (ev) => {
			if ((ev.target as HTMLElement).closest('a, .fpp-mc-actions')) return;
			ev.preventDefault();
			void view.editComment(e);
		});
	}

	private buildAnnotationCard(el: HTMLElement, child: Component, p: ProviderNotes, a: Annotation): void {
		const { view } = this;
		el.addClass('fpp-mc-annotation');
		el.style.setProperty('--swatch', this.colorCss(a.color ?? p.provider.color));
		const body = el.createDiv('fpp-mc-body markdown-rendered');
		const sourcePath = view.file?.path ?? '';
		void MarkdownRenderer.render(view.app, a.note!, body, sourcePath, child);
		this.handleLinks(body, sourcePath);
		el.createDiv({ cls: 'fpp-mc-meta', text: `${p.provider.name}: ${a.label}` });
		this.bindCard(el, `${p.layer}:${a.id}`, [], (menu) => view.addAnnotationItems(menu, [{ layer: p.layer, spec: { id: a.id, locator: a.locator, color: a.color, data: a } }]));
	}

	/** Hover, click and right-click on a card. `highlightIds`: highlights to emphasize while hovering. */
	private bindCard(el: HTMLElement, id: string, highlightIds: string[], menu: (menu: Menu) => void): void {
		const reader = () => this.view.reader;
		el.addEventListener('mouseenter', () => {
			if (!highlightIds.length) return;
			this.cardHover = highlightIds[0];
			this.syncReveal();
		});
		el.addEventListener('mouseleave', () => {
			if (!highlightIds.length) return;
			this.cardHover = null;
			this.syncReveal();
		});
		el.addEventListener('click', (ev) => {
			if ((ev.target as HTMLElement).closest('a')) return;
			const margin = reader()?.margin;
			if (margin) margin.setActive(margin.activeId === id ? null : id);
			this.syncReveal();
		});
		el.addEventListener('contextmenu', (ev) => {
			ev.preventDefault();
			ev.stopPropagation();
			const m = new Menu();
			menu(m);
			m.showAtMouseEvent(ev);
		});
	}

	/** Internal links in rendered comments open like links in notes. */
	private handleLinks(body: HTMLElement, sourcePath: string): void {
		body.addEventListener('click', (ev) => {
			const a = (ev.target as HTMLElement).closest('a.internal-link');
			if (!a) return;
			ev.preventDefault();
			ev.stopPropagation();
			const href = a.getAttribute('data-href') ?? a.getAttribute('href') ?? '';
			void this.view.app.workspace.openLinkText(href, sourcePath, ev.ctrlKey || ev.metaKey);
		});
	}

	override onunload(): void {
		this.reset();
	}
}

/** "5 minutes ago", "yesterday", "3 months ago". */
export function timeAgo(date: Date, now = Date.now()): string {
	const s = (date.getTime() - now) / 1000;
	const units: [Intl.RelativeTimeFormatUnit, number][] = [
		['year', 365 * 86400],
		['month', 30 * 86400],
		['week', 7 * 86400],
		['day', 86400],
		['hour', 3600],
		['minute', 60],
	];
	const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
	for (const [unit, secs] of units) if (Math.abs(s) >= secs) return rtf.format(Math.round(s / secs), unit);
	return rtf.format(0, 'minute');
}

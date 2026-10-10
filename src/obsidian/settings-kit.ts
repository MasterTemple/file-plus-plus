import { Setting, setIcon } from 'obsidian';

/** Text with `code` in backticks (variables, syntax, link parameters) and *names* of buttons and commands in asterisks, for a setting's description. */
export function md(text: string): DocumentFragment {
	const fragment = document.createDocumentFragment();
	for (const part of text.split(/(`[^`]+`|\*[^*\s][^*]*\*)/)) {
		const tag = part.length > 2 && part.startsWith('`') && part.endsWith('`') ? 'code' : part.length > 2 && part.startsWith('*') && part.endsWith('*') ? 'em' : null;
		if (tag) {
			const el = document.createElement(tag);
			el.textContent = part.slice(1, -1);
			fragment.append(el);
		} else if (part) fragment.append(part);
	}
	return fragment;
}

/** A tab of the settings. */
export interface TabSpec<Id extends string> {
	id: Id;
	name: string;
	icon: string;
	/** A short paragraph at the top of the tab, saying what's in it (`md` text). */
	lead?: string;
}

/** A row of tabs over a panel each: every panel is drawn, and only the selected one shows. */
export class Tabs<Id extends string> {
	readonly panels = new Map<Id, HTMLElement>();
	private readonly buttons = new Map<Id, HTMLElement>();

	constructor(
		container: HTMLElement,
		specs: TabSpec<Id>[],
		private selected: Id,
		private readonly onSelect: (id: Id) => void,
	) {
		const bar = container.createDiv({ cls: 'fpp-tabs', attr: { role: 'tablist' } });
		// The bar sticks at the very top, over the settings pane's padding (which differs between versions
		// and devices), or on phones just under the header floating over the pane
		if (container.isConnected) {
			const header = container.closest('.modal')?.querySelector<HTMLElement>('.modal-header');
			const floating = header && /absolute|fixed/.test(getComputedStyle(header).position) ? header.getBoundingClientRect().bottom - container.getBoundingClientRect().top : 0;
			const padding = parseFloat(getComputedStyle(container).paddingTop) || 0;
			bar.style.setProperty('--fpp-tabs-top', `${Math.max(0, floating) - padding}px`);
		}
		const body = container.createDiv('fpp-tab-panels');
		for (const spec of specs) {
			const button = bar.createEl('button', { cls: 'fpp-tab', attr: { role: 'tab', type: 'button', 'aria-label': spec.name } });
			setIcon(button.createSpan('fpp-tab-icon'), spec.icon);
			button.createSpan({ cls: 'fpp-tab-name', text: spec.name });
			button.addEventListener('click', () => this.select(spec.id));
			this.buttons.set(spec.id, button);
			const panel = body.createDiv({ cls: 'fpp-tab-panel', attr: { role: 'tabpanel' } });
			if (spec.lead) panel.createEl('p', { cls: 'fpp-tab-lead' }).append(md(spec.lead));
			this.panels.set(spec.id, panel);
		}
		if (!this.panels.has(selected)) this.selected = specs[0].id;
		this.show();
	}

	get current(): Id {
		return this.selected;
	}

	select(id: Id): void {
		if (!this.panels.has(id)) return;
		this.selected = id;
		this.show();
		this.onSelect(id);
		this.buttons.get(id)?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
	}

	private show(): void {
		for (const [id, panel] of this.panels) {
			const on = id === this.selected;
			panel.toggleClass('is-active', on);
			this.buttons.get(id)?.toggleClass('is-active', on);
			this.buttons.get(id)?.setAttr('aria-selected', String(on));
		}
	}
}

/**
 * A group of settings under a heading, the way Obsidian's own tabs draw them (1.11 and later):
 * the heading (with its description), and the settings in one card.
 */
export interface Section {
	group: HTMLElement;
	heading: Setting;
	/** The card: add settings here. */
	items: HTMLElement;
}

export function section(container: HTMLElement, name: string, desc?: string): Section {
	const group = container.createDiv('setting-group');
	const heading = new Setting(group).setName(name).setHeading();
	if (desc) heading.setDesc(md(desc));
	const items = group.createDiv('setting-items');
	return { group, heading, items };
}

/** Another card in the same group, under the first. */
export function card(section: Section): HTMLElement {
	return section.group.createDiv('setting-items');
}

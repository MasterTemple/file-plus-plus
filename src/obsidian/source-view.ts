import { Platform, TextFileView, type Menu, type WorkspaceLeaf } from 'obsidian';
import type { FilePlusPlusPlugin } from './plugin';

/** The plugin of the view being constructed (`FileView`'s constructor calls `getViewType()`). */
let constructing: FilePlusPlusPlugin<any, any> | null = null;

/**
 * A text format's file as it is on disk: read-only, monospace, with line numbers. Offered for formats
 * with `plainText` set; switching keeps the tab (`FilePlusPlusPlugin.toggleSource`). Reloads when the
 * file changes.
 */
export class SourceView extends TextFileView {
	readonly plugin: FilePlusPlusPlugin<any, any>;
	private textEl!: HTMLElement;

	constructor(leaf: WorkspaceLeaf, plugin: FilePlusPlusPlugin<any, any>) {
		constructing = plugin;
		try {
			super(leaf);
		} finally {
			constructing = null;
		}
		this.plugin = plugin;
		this.contentEl.addClass('fpp-source-view');
		this.contentEl.toggleClass('fpp-mobile', Platform.isMobile);
		this.textEl = this.contentEl.createDiv('fpp-source-text');
		this.addAction(plugin.format.icon, `Open as ${plugin.format.noun}`, () => void plugin.toggleSource(this.leaf));
	}

	getViewType(): string {
		return (this.plugin ?? constructing!).sourceViewType;
	}

	override getIcon(): string {
		return 'file-code';
	}

	override canAcceptExtension(extension: string): boolean {
		return this.plugin.format.extensions.includes(extension.toLowerCase());
	}

	/** Read-only: never writes the file. */
	override async save(_clear?: boolean): Promise<void> {}

	getViewData(): string {
		return this.data;
	}

	/** One element per line, so long lines wrap next to their number (a CSS counter, kept out of copies). */
	setViewData(data: string, _clear: boolean): void {
		const lines = data.split(/\r\n|\r|\n/);
		if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
		const { scrollTop } = this.textEl;
		this.textEl.empty();
		this.textEl.style.setProperty('--fpp-source-digits', String(String(lines.length).length));
		const frag = this.textEl.doc.createDocumentFragment();
		for (const line of lines) frag.createDiv({ cls: 'fpp-source-line', text: line });
		this.textEl.append(frag);
		this.textEl.scrollTop = scrollTop;
	}

	clear(): void {
		this.textEl.empty();
	}

	override onPaneMenu(menu: Menu, source: string): void {
		super.onPaneMenu(menu, source);
		const { format } = this.plugin;
		menu.addItem((i) =>
			i
				.setTitle(`Open as ${format.noun}`)
				.setIcon(format.icon)
				.setSection('open')
				.onClick(() => this.plugin.toggleSource(this.leaf)),
		);
	}
}

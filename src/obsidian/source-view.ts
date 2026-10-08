import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
import { EditorState, Transaction } from '@codemirror/state';
import { EditorView, drawSelection, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers } from '@codemirror/view';
import { Platform, Scope, TextFileView, setIcon, type Menu, type ViewStateResult, type WorkspaceLeaf } from 'obsidian';
import type { FilePlusPlusPlugin } from './plugin';

/** Reading the file (line numbers, wrapped lines) or editing it (CodeMirror, same look). */
export type SourceMode = 'read' | 'edit';

/** The plugin of the view being constructed (`FileView`'s constructor calls `getViewType()`). */
let constructing: FilePlusPlusPlugin<any, any> | null = null;

/**
 * A text format's file as it is on disk, monospace with line numbers, to read or edit (`mode`, kept
 * in the view state; Ctrl/Cmd+E switches). Offered for formats with `plainText` set; switching to and
 * from the rendered view keeps the tab (`FilePlusPlusPlugin.toggleSource`). Follows changes to the file.
 */
export class SourceView extends TextFileView {
	readonly plugin: FilePlusPlusPlugin<any, any>;
	mode: SourceMode = 'read';
	private textEl!: HTMLElement;
	private editorEl!: HTMLElement;
	private editor: EditorView | null = null;
	private modeButton!: HTMLElement;
	/** Edited since the last save (only then does `save` write). */
	private dirty = false;
	/** What this view last wrote: the change event it causes is not a change on disk. */
	private lastSaved: string | null = null;

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
		this.editorEl = this.contentEl.createDiv('fpp-source-editor');
		this.modeButton = this.addAction('pencil', 'Edit as plain text', () => void this.toggleMode());
		this.addAction(plugin.format.icon, `Open as ${plugin.format.noun}`, () => void plugin.toggleSource(this.leaf));
		this.scope = new Scope(this.app.scope);
		this.scope.register(['Mod'], 'e', () => {
			void this.toggleMode();
			return false;
		});
		this.showMode();
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

	override getState(): Record<string, unknown> {
		return { ...super.getState(), mode: this.mode };
	}

	override async setState(state: unknown, result: ViewStateResult): Promise<void> {
		const mode = (state as { mode?: unknown } | null)?.mode;
		await super.setState(state, result);
		if (mode === 'read' || mode === 'edit') await this.setMode(mode);
	}

	toggleMode(): Promise<void> {
		return this.setMode(this.mode === 'read' ? 'edit' : 'read');
	}

	/** Read or edit; leaving edit mode saves first. */
	async setMode(mode: SourceMode): Promise<void> {
		if (mode === this.mode) return;
		if (this.mode === 'edit') {
			await this.save();
			this.editor?.destroy();
			this.editor = null;
		}
		this.mode = mode;
		this.showMode();
		this.render(this.data, true);
		if (mode === 'edit') this.editor?.focus();
		this.app.workspace.requestSaveLayout();
	}

	private showMode(): void {
		const editing = this.mode === 'edit';
		this.contentEl.toggleClass('is-editing', editing);
		setIcon(this.modeButton, editing ? 'book-open' : 'pencil');
		this.modeButton.setAttribute('aria-label', editing ? 'Read as plain text' : 'Edit as plain text');
	}

	/** Only an edited file is written (reading never touches it). */
	override async save(clear?: boolean): Promise<void> {
		if (!this.dirty) return;
		this.dirty = false;
		this.lastSaved = this.getViewData();
		await super.save(clear);
	}

	getViewData(): string {
		return this.editor ? this.editor.state.doc.toString() : this.data;
	}

	setViewData(data: string, clear: boolean): void {
		this.render(data, clear);
	}

	clear(): void {
		this.textEl.empty();
		this.editor?.destroy();
		this.editor = null;
		this.dirty = false;
		this.lastSaved = null;
	}

	private render(data: string, clear: boolean): void {
		if (this.mode === 'edit') {
			this.textEl.empty();
			if (!this.editor || clear) {
				this.editor?.destroy();
				this.editor = new EditorView({ parent: this.editorEl, state: this.editorState(data) });
			} else if (data === this.lastSaved) {
				this.data = this.editor.state.doc.toString(); // our own write; typing may have gone on since
			} else if (this.editor.state.doc.toString() !== data) {
				// Changed on disk (sync, another editor): take it, keeping the cursor where it can be.
				const { anchor } = this.editor.state.selection.main;
				this.editor.dispatch({ changes: { from: 0, to: this.editor.state.doc.length, insert: data }, selection: { anchor: Math.min(anchor, data.length) }, annotations: Transaction.remote.of(true) });
			}
			return;
		}
		// One element per line, so long lines wrap next to their number (a CSS counter, kept out of copies).
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

	private editorState(data: string): EditorState {
		return EditorState.create({
			doc: data,
			extensions: [
				lineNumbers(),
				highlightActiveLineGutter(),
				highlightActiveLine(),
				history(),
				drawSelection(),
				search({ top: true }),
				highlightSelectionMatches(),
				EditorView.lineWrapping,
				keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
				EditorView.updateListener.of((u) => {
					if (!u.docChanged) return;
					this.data = u.state.doc.toString();
					if (u.transactions.every((t) => t.annotation(Transaction.remote))) return; // from disk
					this.dirty = true;
					this.requestSave();
				}),
			],
		});
	}

	override async onClose(): Promise<void> {
		await this.save();
		this.editor?.destroy();
		this.editor = null;
		await super.onClose();
	}

	override onPaneMenu(menu: Menu, source: string): void {
		super.onPaneMenu(menu, source);
		const { format } = this.plugin;
		const editing = this.mode === 'edit';
		menu.addItem((i) =>
			i
				.setTitle(editing ? 'Read as plain text' : 'Edit as plain text')
				.setIcon(editing ? 'book-open' : 'pencil')
				.setSection('open')
				.onClick(() => this.toggleMode()),
		);
		menu.addItem((i) =>
			i
				.setTitle(`Open as ${format.noun}`)
				.setIcon(format.icon)
				.setSection('open')
				.onClick(() => this.plugin.toggleSource(this.leaf)),
		);
	}
}

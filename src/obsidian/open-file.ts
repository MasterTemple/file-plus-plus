import { FuzzySuggestModal, Keymap, Platform, type App, type TFile } from 'obsidian';
import type { FilePlusPlusPlugin } from './plugin';

/** Like the quick switcher, for the format's files only (`Open EPUB file…`): recently opened ones first. */
export class OpenFileModal extends FuzzySuggestModal<TFile> {
	constructor(
		app: App,
		private plugin: FilePlusPlusPlugin,
	) {
		super(app);
		const { format } = plugin;
		this.setPlaceholder(`Open a ${format.noun}…`);
		const mod = Platform.isMacOS ? '⌘' : 'Ctrl';
		this.setInstructions([
			{ command: '↑↓', purpose: 'to navigate' },
			{ command: '↵', purpose: 'to open' },
			{ command: `${mod} ↵`, purpose: 'to open in a new tab' },
			{ command: 'esc', purpose: 'to dismiss' },
		]);
		// Ctrl/Cmd+Enter: a new tab (as the quick switcher)
		this.scope.register(['Mod'], 'Enter', (e) => {
			(this as unknown as { selectActiveSuggestion(e: KeyboardEvent): void }).selectActiveSuggestion(e);
			return false;
		});
	}

	getItems(): TFile[] {
		const extensions = this.plugin.format.extensions;
		const files = this.app.vault.getFiles().filter((f) => extensions.includes(f.extension.toLowerCase()));
		const recent = new Map(this.app.workspace.getLastOpenFiles().map((p, i) => [p, i]));
		return files.sort((a, b) => (recent.get(a.path) ?? Infinity) - (recent.get(b.path) ?? Infinity) || a.path.localeCompare(b.path));
	}

	getItemText(file: TFile): string {
		return file.path;
	}

	onChooseItem(file: TFile, evt: MouseEvent | KeyboardEvent): void {
		void this.app.workspace.getLeaf(Keymap.isModEvent(evt) ? 'tab' : false).openFile(file);
	}
}

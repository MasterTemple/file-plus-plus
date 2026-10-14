import { AbstractInputSuggest, Modal, Setting, normalizePath, type App, type TFolder } from 'obsidian';
import type { FilePlusPlusPlugin } from '../obsidian/plugin';
import type { FolderMove } from './annotations';

/** Folder suggestions under a text input. */
class FolderSuggest extends AbstractInputSuggest<TFolder> {
	constructor(
		app: App,
		private input: HTMLInputElement,
		private onPick: (path: string) => void,
	) {
		super(app, input);
	}

	protected getSuggestions(query: string): TFolder[] {
		const q = query.toLowerCase();
		return this.app.vault
			.getAllFolders(false)
			.filter((f) => f.path.toLowerCase().includes(q))
			.sort((a, b) => a.path.localeCompare(b.path))
			.slice(0, 50);
	}

	renderSuggestion(folder: TFolder, el: HTMLElement): void {
		el.setText(folder.path);
	}

	override selectSuggestion(folder: TFolder): void {
		this.input.value = folder.path;
		this.onPick(folder.path);
		this.close();
	}
}

/**
 * Change the folder for annotation files and move the existing ones there. Several annotation files
 * of one document end up merged into one (`Annotations.move`). `onDone` runs after moving (the
 * settings tab redraws).
 */
export class AnnotationFolderModal extends Modal {
	private folder: string;
	private everywhere = false;
	private plan: FolderMove[] = [];
	private infoEl!: HTMLElement;
	private moveButton: HTMLButtonElement | null = null;

	constructor(
		app: App,
		private plugin: FilePlusPlusPlugin,
		private onDone?: () => void,
	) {
		super(app);
		this.folder = plugin.settings.annotationFolder;
	}

	override onOpen(): void {
		const { contentEl, plugin } = this;
		const noun = plugin.format.noun;
		this.titleEl.setText('Change annotation folder');
		contentEl.createEl('p', {
			cls: 'setting-item-description',
			text: `New annotation files are created in this folder, and existing ones move there. When a ${noun} ends up with more than one annotation file, they are merged into one: annotations go to their places in ${noun} order, ones already there are skipped, and links to the merged files point to the one kept.`,
		});
		new Setting(contentEl)
			.setName('Folder')
			.setDesc(`Leave empty to keep annotation files next to their ${noun}.`)
			.addText((t) => {
				t.setPlaceholder('e.g. Reading/Annotations')
					.setValue(this.folder)
					.onChange((v) => this.setFolder(v));
				new FolderSuggest(this.app, t.inputEl, (v) => this.setFolder(v));
				window.setTimeout(() => t.inputEl.focus());
			});
		new Setting(contentEl)
			.setName('Also move annotation files elsewhere')
			.setDesc(`Otherwise only the ones in the current folder (${plugin.settings.annotationFolder.trim() ? `"${normalizePath(plugin.settings.annotationFolder)}"` : `next to their ${noun}`}) move.`)
			.addToggle((t) =>
				t.setValue(this.everywhere).onChange((v) => {
					this.everywhere = v;
					this.update();
				}),
			);
		this.infoEl = contentEl.createDiv('setting-item-description');
		new Setting(contentEl)
			.addButton((b) => b.setButtonText('Cancel').onClick(() => this.close()))
			.addButton((b) => {
				this.moveButton = b.buttonEl;
				b.setButtonText('Change folder')
					.setCta()
					.onClick(() => void this.run());
			});
		this.update();
	}

	private setFolder(v: string): void {
		this.folder = v;
		this.update();
	}

	private update(): void {
		this.plan = this.plugin.annotator.annotations.planMove(this.folder, this.everywhere);
		const moving = this.plan.reduce((n, p) => n + p.moving.length, 0);
		const merging = this.plan.reduce((n, p) => n + p.files.length - 1, 0);
		const files = (n: number) => `${n} annotation file${n === 1 ? '' : 's'}`;
		const parts = [moving ? `${files(moving)} will move` : 'No annotation files will move'];
		if (merging) parts.push(`${files(merging)} will be merged into another of the same ${this.plugin.format.noun}`);
		this.infoEl.setText(parts.join('; ') + '.');
		const changed = this.folder.trim() !== this.plugin.settings.annotationFolder.trim();
		if (this.moveButton) {
			this.moveButton.disabled = !changed && !this.plan.length;
			this.moveButton.setText(this.plan.length ? (changed ? 'Change folder and move' : 'Move') : 'Change folder');
		}
	}

	private async run(): Promise<void> {
		const { plugin } = this;
		if (this.moveButton) this.moveButton.disabled = true;
		plugin.settings.annotationFolder = this.folder.trim();
		await plugin.saveSettings();
		try {
			const { moved, merged } = await plugin.annotator.annotations.move(this.plan);
			const parts = [];
			if (moved) parts.push(`moved ${moved} annotation file${moved === 1 ? '' : 's'}`);
			if (merged) parts.push(`merged ${merged}`);
			const where = plugin.settings.annotationFolder ? `"${normalizePath(plugin.settings.annotationFolder)}"` : `next to each ${plugin.format.noun}`;
			plugin.notice(parts.length ? `${parts.join(', ')} (${where}).` : `annotation files now go ${plugin.settings.annotationFolder ? 'into ' : ''}${where}.`);
		} catch (e) {
			console.error(e);
			plugin.notice(`moving annotation files failed: ${(e as Error).message}`);
		}
		this.close();
		this.onDone?.();
	}
}

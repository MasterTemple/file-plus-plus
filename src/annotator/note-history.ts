import type { App, TFile } from 'obsidian';

/** One write to a note: its text before (null: the note didn't exist) and after */
interface Edit {
	path: string;
	before: string | null;
	after: string;
	/** What it did, for notices (`the new highlight`) */
	what: string;
}

/** How many edits are kept */
const LIMIT = 100;

/**
 * Undo and redo for what the annotator writes into notes (highlights added, recolored, commented on,
 * deleted; annotation files created). An edit is undone only while the note is as it left it.
 */
export class NoteHistory {
	private undos: Edit[] = [];
	private redos: Edit[] = [];

	constructor(
		private readonly app: App,
		private readonly notice: (message: string, timeout?: number) => void,
	) {}

	/** `vault.process`, remembered (`what`: as notices name it) */
	async process(file: TFile, fn: (data: string) => string, what: string): Promise<string> {
		let before = '';
		const after = await this.app.vault.process(file, (data) => {
			before = data;
			return fn(data);
		});
		if (after !== before) this.push({ path: file.path, before, after, what });
		return after;
	}

	/** `vault.create`, remembered */
	async create(path: string, data: string, what: string): Promise<TFile> {
		const file = await this.app.vault.create(path, data);
		this.push({ path: file.path, before: null, after: data, what });
		return file;
	}

	private push(edit: Edit): void {
		this.undos.push(edit);
		if (this.undos.length > LIMIT) this.undos.shift();
		this.redos = [];
	}

	async undo(): Promise<void> {
		await this.apply(this.undos, this.redos, 'before', 'undo');
	}

	async redo(): Promise<void> {
		await this.apply(this.redos, this.undos, 'after', 'redo');
	}

	/** Puts the last edit of `from` back to its text `to` (once the note is as the edit has it), onto `onto` */
	private async apply(from: Edit[], onto: Edit[], to: 'before' | 'after', verb: 'undo' | 'redo'): Promise<void> {
		const edit = from.pop();
		if (!edit) return this.notice(`nothing to ${verb}.`, 1500);
		const { vault, fileManager } = this.app;
		const file = vault.getFileByPath(edit.path);
		const now = file ? await vault.read(file) : null;
		const expected = to === 'before' ? edit.after : edit.before;
		const name = edit.path.split('/').pop()!.replace(/\.md$/, '');
		if (now !== expected) {
			// Changed since (by hand, or another edit): it's dropped
			return this.notice(`can't ${verb} ${edit.what}: ${name} has changed since.`, 3000);
		}
		const text = edit[to];
		if (text === null) await fileManager.trashFile(file!);
		else if (file) await vault.modify(file, text);
		else await vault.create(edit.path, text);
		onto.push(edit);
		this.notice(`${verb === 'undo' ? 'undid' : 'redid'} ${edit.what} (${name}).`, 2000);
	}
}

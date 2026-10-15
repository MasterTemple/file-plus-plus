import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { EditorState } from '@codemirror/state';
import { drawSelection, EditorView, keymap } from '@codemirror/view';
import { getCM, Vim, vim } from '@replit/codemirror-vim';
import { Modal, Platform, Setting, type App } from 'obsidian';

export interface CommentPromptOptions {
	title?: string;
	initial?: string;
	submit?: string;
	/** Edit with Vim keys (desktop only: `commentVim`) */
	vim?: boolean;
}

/** The comment modals with a Vim editor, for `:w` / `:q` */
const vimModals = new WeakMap<EditorView, CommentModal>();
let exDefined = false;

/** `:w`, `:wq`, `:x` save the comment, `:q` cancels */
function defineEx(): void {
	if (exDefined) return;
	exDefined = true;
	const modal = (cm: { cm6?: EditorView }) => (cm.cm6 ? vimModals.get(cm.cm6) : undefined);
	for (const [name, short] of [['write', 'w'], ['wq', 'wq'], ['xit', 'x']]) Vim.defineEx(name, short, (cm: { cm6?: EditorView }) => modal(cm)?.submit());
	Vim.defineEx('quit', 'q', (cm: { cm6?: EditorView }) => modal(cm)?.close());
}

/** Ask for a comment to put under a quote. Resolves to null when cancelled. */
export function askForComment(app: App, quote: string, opts: CommentPromptOptions = {}): Promise<string | null> {
	return new Promise((resolve) => new CommentModal(app, quote, resolve, opts).open());
}

class CommentModal extends Modal {
	private done = false;
	private value = '';

	constructor(
		app: App,
		private quote: string,
		private resolve: (v: string | null) => void,
		private opts: CommentPromptOptions,
	) {
		super(app);
		this.value = opts.initial ?? '';
	}

	override onOpen(): void {
		this.modalEl.addClass('fpp-comment-modal');
		if (Platform.isMobile) this.fitAboveKeyboard();
		this.titleEl.setText(this.opts.title ?? 'Add a comment');
		const { contentEl } = this;
		contentEl.createEl('blockquote', {
			cls: 'fpp-comment-quote',
			text: this.quote.length > 400 ? `${this.quote.slice(0, 400)}…` : this.quote,
		});
		const vimKeys = !!this.opts.vim && !Platform.isMobile;
		let focus: () => void;
		if (vimKeys) focus = this.vimEditor(contentEl);
		else {
			const area = contentEl.createEl('textarea', { cls: 'fpp-comment-input', attr: { rows: Platform.isMobile ? '3' : '5', placeholder: 'Your comment…' } });
			area.value = this.value;
			area.addEventListener('input', () => (this.value = area.value));
			area.addEventListener('keydown', (e) => {
				if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
					e.preventDefault();
					this.submit();
				}
			});
			focus = () => area.focus();
		}
		new Setting(contentEl)
			.setDesc(Platform.isMobile ? '' : vimKeys ? 'Ctrl/Cmd+Enter or :w to confirm, :q to cancel' : 'Ctrl/Cmd+Enter to confirm')
			.addButton((b) => b.setButtonText('Cancel').onClick(() => this.close()))
			.addButton((b) => b.setButtonText(this.opts.submit ?? 'Copy').setCta().onClick(() => this.submit()));
		window.setTimeout(focus, 50);
	}

	/**
	 * A CodeMirror editor with Vim keys (new comments start in insert mode). Escape stays in it (Vim's)
	 * rather than closing the dialog. Returns what focuses it.
	 */
	private vimEditor(parent: HTMLElement): () => void {
		defineEx();
		const view = new EditorView({
			parent: parent.createDiv('fpp-comment-input fpp-comment-vim'),
			state: EditorState.create({
				doc: this.value,
				extensions: [
					vim(),
					drawSelection(),
					history(),
					EditorView.lineWrapping,
					keymap.of([{ key: 'Mod-Enter', run: () => (this.submit(), true) }, ...defaultKeymap, ...historyKeymap]),
					EditorView.updateListener.of((u) => {
						if (u.docChanged) this.value = u.state.doc.toString();
					}),
				],
			}),
		});
		vimModals.set(view, this);
		this.editor = view;
		// The dialog's Escape (closing it) goes to Vim instead
		const scope = this.scope as unknown as { keys: { key: string | null }[] };
		scope.keys = scope.keys.filter((k) => k.key !== 'Escape');
		this.scope.register([], 'Escape', () => true);
		return () => {
			view.focus();
			const end = view.state.doc.length;
			view.dispatch({ selection: { anchor: end } });
			const cm = getCM(view);
			if (cm && !this.value) Vim.handleKey(cm, 'i', 'user');
		};
	}

	private editor: EditorView | null = null;

	/**
	 * Mobile: pin the dialog to the top of the visible area, where the on-screen keyboard can't cover
	 * it (not every Obsidian app reports the keyboard through the visual viewport), and keep it short
	 * enough to stay above a keyboard either way.
	 */
	private fitAboveKeyboard(): void {
		this.containerEl.addClass('fpp-comment-container');
		const vv = window.visualViewport;
		const gap = 8;
		const fit = () => {
			const top = vv ? vv.offsetTop : 0;
			const height = vv ? vv.height : window.innerHeight;
			const safe = parseFloat(getComputedStyle(document.body).getPropertyValue('--safe-area-inset-top')) || 0;
			this.containerEl.style.paddingTop = `${top + safe + gap}px`;
			this.modalEl.style.maxHeight = `${Math.max(160, Math.min(height - safe - 2 * gap, window.innerHeight * 0.55))}px`;
		};
		fit();
		vv?.addEventListener('resize', fit);
		vv?.addEventListener('scroll', fit);
		window.addEventListener('resize', fit);
		this.stopFit = () => {
			vv?.removeEventListener('resize', fit);
			vv?.removeEventListener('scroll', fit);
			window.removeEventListener('resize', fit);
		};
	}

	private stopFit: (() => void) | null = null;

	submit(): void {
		this.done = true;
		this.resolve(this.value.trim());
		this.close();
	}

	override onClose(): void {
		this.stopFit?.();
		this.editor?.destroy();
		this.editor = null;
		if (!this.done) this.resolve(null);
		this.contentEl.empty();
	}
}

/** Ask before deleting a highlight that has a comment. Resolves to true to delete. */
export function confirmDeleteHighlight(app: App, comment: string): Promise<boolean> {
	return new Promise((resolve) => new ConfirmDeleteModal(app, comment, resolve).open());
}

class ConfirmDeleteModal extends Modal {
	private result = false;

	constructor(
		app: App,
		private comment: string,
		private resolve: (v: boolean) => void,
	) {
		super(app);
	}

	override onOpen(): void {
		this.titleEl.setText('Delete highlight?');
		const { contentEl } = this;
		contentEl.createEl('p', { text: 'Its comment will be deleted too:' });
		contentEl.createEl('blockquote', {
			cls: 'fpp-comment-quote',
			text: this.comment.length > 400 ? `${this.comment.slice(0, 400)}…` : this.comment,
		});
		if (!Platform.isMobile) contentEl.createEl('p', { cls: 'setting-item-description', text: 'Tip: Shift-click "Delete highlight" to skip this question.' });
		new Setting(contentEl)
			.addButton((b) => b.setButtonText('Cancel').onClick(() => this.close()))
			.addButton((b) =>
				b
					.setButtonText('Delete')
					.setWarning()
					.onClick(() => {
						this.result = true;
						this.close();
					}),
			);
	}

	override onClose(): void {
		this.contentEl.empty();
		this.resolve(this.result);
	}
}

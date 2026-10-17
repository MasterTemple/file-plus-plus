import type { TFile, WorkspaceLeaf } from 'obsidian';
import type { DocumentReader } from '../core';

/**
 * What annotating needs of a document on screen: its file, the loaded document, and its reader.
 * A document's tab (`DocumentView`) is one; so is an embed or a hover preview (`DocumentEmbed`), whose
 * `ReaderAnnotator` makes and draws highlights in it too.
 */
export interface AnnotationTarget<Doc = unknown, R extends DocumentReader = DocumentReader> {
	readonly file: TFile | null;
	readonly document: Doc | null;
	readonly reader: R | null;
	/** Its tab, when it has one of its own: notes open beside it */
	readonly leaf?: WorkspaceLeaf;
	/** Draw its highlights again (an annotation file was just made) */
	refreshHighlights?(): void;
}

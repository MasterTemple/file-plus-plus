/**
 * The annotator: a note-taking layer over the viewer (`../obsidian`). Links from notes into a
 * document are its highlights (`HighlightIndex`), with comments in callouts, annotation files with
 * a heading per chapter, copy formats, margin cards, and highlight import. The plugin class composes
 * it with the viewer.
 */
export { HighlightIndex, resolveFile, type HighlightEntry } from './highlight-index';
export { Annotations, type FolderMove } from './annotations';
export { AnnotationFolderModal } from './annotation-folder';
export * from './annotation-utils';
export * from './comment-utils';
export { askForComment, confirmDeleteHighlight } from './comment-modal';
export { ImportModal, importHighlights, resolveBooks, type BookImportResult, type ImportModalOptions, type ImportSummary, type NotImported } from './import';
export * from './import-utils';
export type { AnnotationTarget } from './target';
export { ReaderAnnotator, type ReaderAnnotatorOptions } from './reader-annotator';
export { addColorRow, addHighlightItems, addSelectionItems, colorCss, colorTitle, editHighlightComment, type MenuHost } from './menus';

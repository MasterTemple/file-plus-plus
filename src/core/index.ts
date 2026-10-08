export { PREFIX } from './prefix';
export { Emitter } from './emitter';
export { flattenToc, type TocItem } from './toc';
export * from './locator';
export * from './lines';
export * from './text-fragment';
export { TextIndex, foldString, foldChar, BLOCK, SKIP, type Section } from './text-index';
export { searchIndex, type SearchMatch, type SearchOptions } from './search';
export {
	DocumentReader,
	rangeText,
	type FlashOptions,
	type AnnotationLayerOptions,
	type HighlightSpec,
	type LayerHit,
	type Location,
	type ReaderOptions,
	type RenderedSection,
	type SearchResult,
	type SelectionInfo,
} from './reader';
export * from './settings';
export { rangeToMarkdown } from './markdown';

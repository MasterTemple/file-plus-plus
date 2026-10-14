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
	yieldToBrowser,
	rangeText,
	type FlashOptions,
	type AnnotationLayerOptions,
	type HighlightSpec,
	type LayerHit,
	type LayerItem,
	type Location,
	type ReaderOptions,
	type RenderedSection,
	type SearchResult,
	type SelectionInfo,
	type SelectionContext,
} from './reader';
export * from './settings';
export { highlightInContext, rangeToMarkdown } from './markdown';
export { sentenceBounds, sentenceContext, sentenceEndAt, sentenceRange, sentenceRanges, sentenceStartAt } from './sentences';
export { hintLabels, HintOverlay, type Hint } from './hints';
export { Margin, type MarginNote, type MarginOptions } from './margin';

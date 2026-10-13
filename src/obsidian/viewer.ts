/**
 * The viewer: a document in its own tab (`DocumentView`), links that open and scroll it, previews and
 * embeds, appearance, and other plugins' annotations (`api.ts`). Knows nothing of notes.
 */
export * from './format';
export * from './api';
export { FilePlusPlusPlugin, type CopyTarget } from './plugin';
export { DocumentView } from './view';
export { SourceView } from './source-view';
export { DocumentEmbed, type EmbedContext } from './embed';
export { MediaPlayer, PlaybackFollower, type PlayerOptions, type PlayerSource } from './player';
export * from './link-utils';
export * from './settings';
export { around } from './patch';
export { hoverLink, type HoverLink } from './hover';
export { buildAppearanceControls, type AppearanceTarget } from './appearance';

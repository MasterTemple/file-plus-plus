/**
 * Prefix of the CSS classes, data attributes, CSS variables and highlight names the library creates.
 *
 * Plugins bundle their own copy of the library, so each build replaces `fpp` with its own prefix
 * (`epp` for EPUB++, see `build/plugin.ts`): two plugins on different library versions never share
 * class names or styles. Code outside the library refers to library-owned names through this constant,
 * so it matches in unit tests (unprefixed) and in builds alike.
 */
export const PREFIX = 'fpp';

# file-plus-plus

The shared engine of PDF++-style Obsidian plugins for other file types: **EPUB++** (`.epub`) and **Transcript++** (`.srt`, `.vtt`), with more to come (e.g. Bibles in USX). A document renders as one continuous page in an Obsidian tab, and **links from your notes into it are its highlights**.

A plugin built on it provides only its file format; everything else is shared:

- **Reader** (`file-plus-plus/core`, no Obsidian imports): renders a document into a shadow root; highlights and color palette; annotation layers (thousands of other plugins' annotations, cheap); jump flashes; selection (shadow-DOM-safe); full-text search; Text Fragments (`:~:text=…`) and line/column locators (`L12C5-L14C3`) for any format; selection → Markdown.
- **Obsidian side** (`file-plus-plus/obsidian`): the view (toolbar, palette, sidebar with contents / search / highlights / other plugins' annotations, appearance per device and orientation); link interception (links reuse and scroll an open tab); highlights from links in notes, with colors (`&color=`); comments next to highlights; copy formats and templates; **annotation files** (one note per document, a heading per chapter, new annotations inserted in document order); hover previews and `![[embeds]]`; the raw file as plain text, to read or edit, for text formats (`plainText: true`; open views re-render when a document changes); context menus and mobile gestures; the backlinks pane; settings; an API for other plugins' annotation providers.
- **Build and test tooling**: `buildPlugin` (esbuild, per-plugin class prefix, styles), an isolated headless Obsidian, CDP drivers for real mouse/touch/key input.

## Writing a plugin

```ts
// src/main.ts
import { FilePlusPlusPlugin } from 'file-plus-plus/obsidian';
import { myFormat } from './format';

export default class MyPlusPlus extends FilePlusPlusPlugin<MyDoc, MyReader> {
	readonly format = myFormat;
}
```

```ts
// src/format.ts — what the library needs to know about the format
export const myFormat: FileFormat<MyDoc, MyReader> = {
	name: 'Transcript', noun: 'transcript', extensions: ['srt'], icon: 'captions',
	plainText: true,                                    // offer "Read / Edit as plain text" (the raw file, monospace)
	frontmatterKey: 'transcript',                       // annotation files: `transcript: "[[talk.srt]]"`
	schemes: [timeScheme, textFragmentScheme],          // link subpaths, tried in order
	linkTypeName: 'Timestamp', linkTypeDescription: '…',
	position: { key: (locator) => startSeconds(locator), compare: (a, b) => a - b },
	load: async (app, file) => parse(await app.vault.read(file)),
	unload: () => {},
	info: (doc, file) => ({ title: file.basename, author: '' }),
	createReader: (host, doc, opts) => new MyReader(host, doc, opts),
};
```

```ts
// The reader: fill `content` with sections and map ranges ↔ locators.
class MyReader extends DocumentReader {
	readonly schemes = [timeScheme, textFragmentScheme];
	get toc() { … }
	protected async renderContent() { /* build DOM; this.addSection({ index, wrapper, body }) */ }
	locatorFromRange(range: Range) { … }                 // e.g. `t=109s-300.7s`
	protected resolveLocator(loc: ParsedLocator) { … }   // locator → Range
}
```

```ts
// esbuild.config.ts
import { buildPlugin } from 'file-plus-plus/build';
await buildPlugin({ root: import.meta.dir, prefix: 'tpp', production: process.argv[2] === 'production' });
```

Subclass `DocumentView` / `DocumentEmbed` (via `createView` / `createEmbed`) to add UI such as a media player, and override `createApi` to add format-specific API functions.

To take over other file types (optional), override `documentFor(file)`: when a file is opened in Obsidian's own view for its type, return a document of your format to show instead (Transcript++ opens `talk.mp4` as `talk.srt`). The view's `source` is the file that was opened (kept in the view state, changed with `setSource`, reported to `onSourceChange`); its tab menu offers to open that file by itself.

## Using it

Until it is published, plugins live next to it and link it:

```sh
cd file-plus-plus && bun install && bun link
cd ../epub-plus-plus && bun install          # "file-plus-plus": "link:file-plus-plus"
```

## Development

```sh
bun test            # locators, line/column, annotation placement, links, comments, patching, prefix rewrite
bun run typecheck
```

Plugin repos run the headless Obsidian from their own folder: `…/file-plus-plus/scripts/obsidian-headless.sh mobile|desktop|stop` (vault: `./test-vault`), `bun …/scripts/cdp.ts`, `bun …/scripts/cdp-input.ts`, `…/scripts/install.sh <vault> [plugin-dir]`.

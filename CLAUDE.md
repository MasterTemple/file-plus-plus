# file-plus-plus — notes for Claude

Shared library of the PDF++-style Obsidian plugins (EPUB++, Transcript++, …): a document renders as one scrolling page, and links from notes into it *are* its highlights. User-facing overview: `README.md`.

## Workflow the user expects

- **Tooling:** use `bun`, not npm or pnpm, and `fd` / `rg`, not find / grep.
- **Separate repos**, side by side in `~/Dropbox/Development/typescript/obsidian-plus-plus/`: this library, `epub-plus-plus`, `transcript-plus-plus`. Plugins depend on it with `"file-plus-plus": "link:file-plus-plus"` (run `bun link` here once); later a GitHub tag (`github:MasterTemple/file-plus-plus#vX`).
- **After each change here:** `bun test` and `bun run typecheck` here, then in every plugin that uses the change: its tests, typecheck, build, a headless check, commit, and `…/scripts/install.sh ~/Obsidian` (see the plugin's CLAUDE.md). Commit here too.
- **Mobile matters as much as desktop.** **Don't touch the user's running Obsidian**: test only in the isolated headless instance.

## Layout

```
src/core/       no Obsidian imports
  reader.ts     DocumentReader: shadow-root page, sections, highlights, annotation layers, flash, selection, search, events
  locator.ts    LocatorScheme registry, parseLocator, params; textFragmentScheme
  margin.ts     Margin (`reader.margin`): notes beside the text, Google Docs style — light-DOM elements slotted into a column in the scroller, stacked without overlap; moves the text left, hides itself when too narrow
  lines.ts      line/column locators (L12C5-L14C3) for line-based formats
  text-index.ts, search.ts, text-fragment.ts, markdown.ts (range → Markdown), settings.ts (themes, base CSS)
src/obsidian/    the viewer (`file-plus-plus/viewer`): knows nothing of notes
  format.ts     FileFormat: everything a plugin tells the library about its format
  plugin.ts     FilePlusPlusPlugin: views, link interception, takeover, previews/embeds, appearance, positions, providers API, commands; owns `annotator`
  view.ts       DocumentView (subclassable: buildExtraUi, onReaderReady, onNavigate, onTeardown, extendSelectionMenu, extendHighlightMenu); owns `annotations` (a ViewAnnotator)
  source-view.ts SourceView: the raw file, monospace with line numbers, `mode` read (divs) or edit (CodeMirror 6 from Obsidian: `@codemirror/*` are externals, devDependencies pinned to Obsidian's versions) (formats with `plainText`); `toggleSource(leaf, mode)` swaps views in the same tab
  embed.ts      DocumentEmbed (subclassable) for ![[file#…]] and hover previews
  player.ts     MediaPlayer (a URL, our own controls; container query: one row wide, two rows narrow; clips stop just inside their end) and PlaybackFollower (keeps what plays in view, not just after scrolling by hand): Transcript++ and the Topos Bible plugin; styles under `.fpp-player-ui`
  api.ts        FileApi, annotation providers (`preview`, `extractText`), `file-plus-plus:api-ready`
  sidebar.ts, setting-tab.ts, appearance.ts, annotation-tip.ts, link-utils.ts (link syntax, shared)
  patch.ts      around(): method patching that tolerates other plugins patching the same method
  viewer.ts / index.ts  exports: the viewer / everything (`file-plus-plus/obsidian`)
src/annotator/  the note-taking layer (`file-plus-plus/annotator`): links in notes are highlights
  annotator.ts  Annotator (`plugin.annotator`): the highlight index and its events, highlight actions (open source, comment, color, delete), copying and templates, annotation files, saving provider annotations, Backlinks hover, its commands
  view-annotator.ts  ViewAnnotator (`view.annotations`): drawing highlights, margin comments, the highlight menu, comment editing, mobile gestures on highlights, the copy/insert row
  highlight-index.ts, annotations.ts (annotation files), comment-*.ts, margin-comments.ts
  import.ts     ImportModal + importHighlights: JSON → annotation files (opens each document's view to resolve passages, dedupes by resolved passage + comment); parsing in import-utils.ts (pure)
  notes.ts      pure note-text logic (annotation placement, comments, links) — importable without Obsidian (`file-plus-plus/notes`)
build/plugin.ts buildPlugin(): esbuild + prefix rewrite + styles.css (library's, then the plugin's)
scripts/        obsidian-headless.sh, cdp.ts, cdp-input.ts, install.sh (run from a plugin's folder)
```

**Viewer and annotator.** The viewer (`src/obsidian/`) must not depend on the annotator except where they are composed (`plugin.ts`, `view.ts`, `sidebar.ts`, `setting-tab.ts`); annotator code reaches the viewer through `plugin` / `view`. View members marked `@internal (the annotator)` are for `ViewAnnotator`. A separate annotator++ package becomes worthwhile when a plugin wants the viewer without notes.

## The prefix

All CSS classes, data attributes, CSS variables and highlight names the library creates start with `fpp`. `buildPlugin` rewrites `fpp` (followed by `-`, a quote or `]`) to the plugin's prefix (`epp`, `tpp`) in library sources and `styles.css`, so plugins on different library versions never share styles. Plugin code refers to library-owned names through `PREFIX` (from `file-plus-plus/core`): it's `fpp` in unit tests and the plugin's prefix in builds.

## Writing a format

- A `DocumentReader` subclass: `schemes`, `renderContent()` (append to `content`, `addSection()` each part), `locatorFromRange()`, `resolveLocator()`, `toc`; optional `extraCss()`.
- A `FileFormat`: load/unload/info, `createReader`, `position` (sortable keys for annotation files), names (`name`, `noun`, `linkTypeName`), `frontmatterKey`, appearance tweaks.
- A plugin: `class X extends FilePlusPlusPlugin { format = … }`; override `createView` / `createEmbed` for extra UI, `createApi` for format-specific API, `migrateSettings` for renamed settings.
- **Annotations from other plugins, in any format:** `FileApi` (api.ts) has `pluginId`, `formatName`, `extensions`, and `extractText(file)` (the format's optional `extractText`: sections of text plus `locator(section, start, end)`, which may be a unit locator with the exact words). Every plugin also fires `file-plus-plus:api-ready` / `-unload` (`FPP_API_READY`, `FPP_API_UNLOAD`; `fileApis(app)` lists the loaded ones), so one provider (Topos Bible's references) serves EPUBs, transcripts, and Bibles. A provider's `preview(annotation)` returns a link that Obsidian's page preview shows on hover (source `<id>-annotations`, plain hover), instead of the tooltip. Its sidebar tab lists each annotation in its sentence (`describeLayer(id, { context })` gives the block's text before and after), with the same menu (right-click) and preview (hover) as in the document; `noun` names them in sentences ("Filter Bible references…").
- Taking over other files: override `documentFor(file)`. `WorkspaceLeaf.prototype.setViewState` is patched, so every way of opening (explorer, links, restored layouts) goes through it; only Obsidian's default view type for the extension is taken over, and `state.takeOver: false` opts out (`openUntakenOver`). The opened file is the view's `source` (view state; `setSource`, `onSourceChange`).
- **Links to a passage:** `openDocument` with `eState.link` (file-plus-plus's own link interception sets it when there's a subpath; a plugin's own link handling passes it) applies `linkOpening` for where the tab is (`view.linkPlace()`: `mobile`, `desktop`, or `half`): closing the sidebar, hiding comments in that tab (`view.commentsHidden`; `showsComments()`/`setCommentsShown()` are what the menus and the command use).
- Range locators are highlights, point locators are positions (annotation-file headings). `scheme.isRange` decides.
- **Media:** `MediaPlayer` plays any URL (`vault.getResourcePath(file)`, or `adapter.getResourcePath(path)` for files outside the vault's index, like a hidden folder); `reader.setPlayingRange(range)` marks what's being played (a highlight under the document's), for formats whose units aren't elements.
- **Units** (exact words in the format's own locators, `t=…:~:text=…`, `v=3:16:~:text=…`): a format whose locators name whole units (cues, verses) overrides `unitElements()` (where each unit starts, in order: the unit's element or a marker before it) and, if a unit isn't "up to the next one", `unitEnd(i)`. Then `unitsOfRange(range)` gives the units a selection covers plus, for part of them, a text fragment searched from the first unit; `resolveUnits(first, last, text)` narrows to the words (the whole units when they aren't found); `unitAt` / `unitRange` find units. `splitTextDirective` / `withTextDirective` (locator.ts) split or append the `:~:text=` part, so a scheme's `match` keeps it. Transcript++ (cues) and the Topos Bible plugin (verse markers) use them.

## Gotchas learned the hard way

- **Markdown links:** Obsidian ignores markdown link destinations containing a raw `:`, and runs `decodeURI` on them, which keeps `%3A` and `%2C` encoded. `mdEncode` encodes `( ) :`; schemes must accept the encoded and decoded forms.
- **Obsidian view lifecycle:** `FileView`'s constructor calls `getViewType()` before subclass fields exist (see `constructing` in view.ts). `onLoadFile` can run before `onOpen`, so the UI is built in the constructor. Don't name fields `titleEl`. Background tabs are deferred views: find them via `getViewState().state.file` and call `loadIfDeferred()`.
- **Shadow DOM:** Obsidian sets `user-select: none` on `<body>`, so the scroller forces `user-select: text`. `@font-face` doesn't work inside shadow roots (formats lift it to the document).
- **Live Ranges are expensive:** Chromium updates every live Range on every DOM mutation. Use `StaticRange` for bulk painting (search results, annotation layers); live ranges only for user highlights.
- **Per-window globals:** `CSS.highlights` and `Highlight` belong to each window; the reader uses its host's `doc` / `win`, and the view rebuilds the reader on `onWindowMigrated`. Highlight names are per plugin (prefix) and per reader (`id`).
- **Scroll position:** moving or hiding the host resets `scrollTop`; the reader restores an anchor Range via a ResizeObserver. Deferred scrolls (drift correction, `keepPosition`, `updateSettings`) go through `scrollSeq` / `afterFrameUnlessJumped` so they never undo a newer jump (the margin's restore once sent reopened books back to the top). The view puts its locator in `getEphemeralState` (`position`) for Obsidian's back/forward, and link jumps into an open document call the private `leaf.recordHistory` first.
- **Mobile touch:** Obsidian's pull-down gesture can't see the shadow scroller, so vertical swipes are stopped unless the document is at the top. Tapping a selection fires `contextmenu`; `preventDefault` there blocks the OS selection toolbar ("System menu" relies on not doing so). The release after a long press emits a synthetic mousedown/click: `preventDefault` that `touchend`. Every tap emits a mouse move, so hover UI is desktop-only.
- **Ranges into the shadow root:** a Range made by the document and moved in with `setStart` must also get `setEnd` (happy-dom keeps the end outside, so it isn't collapsed).
- **Selection in shadow DOM:** try `shadowRoot.getSelection()`, then both `getComposedRanges` signatures, then a plain range.
- **Menus:** the color row and the Copy/Insert/Both row are custom DOM inside `item.dom` that stop pointer/touch/click events. `afterMenuHidden` / `keepPendingSelection` hand the pending selection between menus.
- **Private APIs:** `app.embedRegistry`, `app.commands.removeCommand`, `app.setting.openTabById`, `app.emulateMobile`, `editor.cm.posAtDOM`, the `openLinkText` patch.
- **Documents change on disk** (plain-text editing, sync): the plugin calls `view.reload()` (debounced); `reloading` is true during its `onTeardown` / `onReaderReady`, so subclasses can keep UI (Transcript++ keeps a playing player). The source view only writes after an edit (`dirty`), ignores the echo of its own save (`lastSaved`), and marks changes from disk `Transaction.remote` so they aren't saved back.
- **Margin notes are light DOM:** they live in the reader host and are slotted (`<slot name="fpp-margin">`) into the shadow scroller, so they scroll with the text and get Obsidian's styles; clicks on them still reach the scroller's listeners (they aren't over any highlight). `Margin.set` reuses elements, and `className` resets on rebuilt cards are re-patched there.
- **Link params:** `setLinkParam` edits `&key=` in a link's source; `&updated=` (ISO 8601 basic, UTC) is stamped on creation and by `setHighlightColor` / `setHighlightComment` when `timestampInLinks` is on.
- **The sidebar's open state and tab** are shared by every file-plus-plus plugin and kept per device, in Obsidian's local storage (`file-plus-plus:sidebar`, `plugin.sidebarState()` / `rememberSidebar`), not in settings: new views open as the user last left any view. Only the user's own opening, closing, and tab choices count (`toggleSidebar(open, persist = false)` for closing the drawer after going somewhere).
- **Settings:** `loadSettings` deep-clones defaults and migrates via `settingsVersion` (v4: `linkType` is `primary` | `text`). When adding copy formats or menu items, keep `syncMenus()` and `syncFormatCommands()` in mind.

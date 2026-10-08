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
  lines.ts      line/column locators (L12C5-L14C3) for line-based formats
  text-index.ts, search.ts, text-fragment.ts, markdown.ts (range → Markdown), settings.ts (themes, base CSS)
src/obsidian/
  format.ts     FileFormat: everything a plugin tells the library about its format
  plugin.ts     FilePlusPlusPlugin: link interception, copy/templates, highlight actions, annotation files, appearance, commands, API
  view.ts       DocumentView (subclassable: buildExtraUi, onReaderReady, onNavigate, onTeardown, extendSelectionMenu, extendHighlightMenu)
  embed.ts      DocumentEmbed (subclassable) for ![[file#…]] and hover previews
  sidebar.ts, setting-tab.ts, appearance.ts, highlight-index.ts, annotations.ts, comment-*.ts, annotation-tip.ts
  notes.ts      pure note-text logic (annotation placement, comments, links) — importable without Obsidian (`file-plus-plus/notes`)
  patch.ts      around(): method patching that tolerates other plugins patching the same method
build/plugin.ts buildPlugin(): esbuild + prefix rewrite + styles.css (library's, then the plugin's)
scripts/        obsidian-headless.sh, cdp.ts, cdp-input.ts, install.sh (run from a plugin's folder)
```

## The prefix

All CSS classes, data attributes, CSS variables and highlight names the library creates start with `fpp`. `buildPlugin` rewrites `fpp` (followed by `-`, a quote or `]`) to the plugin's prefix (`epp`, `tpp`) in library sources and `styles.css`, so plugins on different library versions never share styles. Plugin code refers to library-owned names through `PREFIX` (from `file-plus-plus/core`): it's `fpp` in unit tests and the plugin's prefix in builds.

## Writing a format

- A `DocumentReader` subclass: `schemes`, `renderContent()` (append to `content`, `addSection()` each part), `locatorFromRange()`, `resolveLocator()`, `toc`; optional `extraCss()`.
- A `FileFormat`: load/unload/info, `createReader`, `position` (sortable keys for annotation files), names (`name`, `noun`, `linkTypeName`), `frontmatterKey`, appearance tweaks.
- A plugin: `class X extends FilePlusPlusPlugin { format = … }`; override `createView` / `createEmbed` for extra UI, `createApi` for format-specific API, `migrateSettings` for renamed settings.
- Range locators are highlights, point locators are positions (annotation-file headings). `scheme.isRange` decides.
- A locator can combine the format's own position with a text fragment for the exact words (Transcript++: `t=…:~:text=…`): `textFragmentFromRange(range, within)` and `resolveTextFragment(fragment, within)` scope the fragment to a range.

## Gotchas learned the hard way

- **Markdown links:** Obsidian ignores markdown link destinations containing a raw `:`, and runs `decodeURI` on them, which keeps `%3A` and `%2C` encoded. `mdEncode` encodes `( ) :`; schemes must accept the encoded and decoded forms.
- **Obsidian view lifecycle:** `FileView`'s constructor calls `getViewType()` before subclass fields exist (see `constructing` in view.ts). `onLoadFile` can run before `onOpen`, so the UI is built in the constructor. Don't name fields `titleEl`. Background tabs are deferred views: find them via `getViewState().state.file` and call `loadIfDeferred()`.
- **Shadow DOM:** Obsidian sets `user-select: none` on `<body>`, so the scroller forces `user-select: text`. `@font-face` doesn't work inside shadow roots (formats lift it to the document).
- **Live Ranges are expensive:** Chromium updates every live Range on every DOM mutation. Use `StaticRange` for bulk painting (search results, annotation layers); live ranges only for user highlights.
- **Per-window globals:** `CSS.highlights` and `Highlight` belong to each window; the reader uses its host's `doc` / `win`, and the view rebuilds the reader on `onWindowMigrated`. Highlight names are per plugin (prefix) and per reader (`id`).
- **Scroll position:** moving or hiding the host resets `scrollTop`; the reader restores an anchor Range via a ResizeObserver.
- **Mobile touch:** Obsidian's pull-down gesture can't see the shadow scroller, so vertical swipes are stopped unless the document is at the top. Tapping a selection fires `contextmenu`; `preventDefault` there blocks the OS selection toolbar ("System menu" relies on not doing so). The release after a long press emits a synthetic mousedown/click: `preventDefault` that `touchend`. Every tap emits a mouse move, so hover UI is desktop-only.
- **Selection in shadow DOM:** try `shadowRoot.getSelection()`, then both `getComposedRanges` signatures, then a plain range.
- **Menus:** the color row and the Copy/Insert/Both row are custom DOM inside `item.dom` that stop pointer/touch/click events. `afterMenuHidden` / `keepPendingSelection` hand the pending selection between menus.
- **Private APIs:** `app.embedRegistry`, `app.commands.removeCommand`, `app.setting.openTabById`, `app.emulateMobile`, `editor.cm.posAtDOM`, the `openLinkText` patch.
- **Settings:** `loadSettings` deep-clones defaults and migrates via `settingsVersion` (v4: `linkType` is `primary` | `text`). When adding copy formats or menu items, keep `syncMenus()` and `syncFormatCommands()` in mind.

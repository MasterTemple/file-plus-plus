import { Platform, PluginSettingTab, Scope, Setting, debounce, type App, type TextComponent } from 'obsidian';
import { AnnotationFolderModal } from '../annotator/annotation-folder';
import { buildAppearanceControls, globalAppearance } from './appearance';
import { chordOf, parseBinding } from './key-sequence';
import type { FilePlusPlusPlugin } from './plugin';
import { card, md, section, Tabs, type Section, type TabSpec } from './settings-kit';
import { DEFAULT_SETTINGS, titleCase, READER_KEY_ACTIONS, HIGHLIGHT_GESTURE_LABELS, HIGHLIGHT_MENU_LABELS, SELECTION_MENU_LABELS, altLinkLabel, formatMenuLabel, ORIENTATION_LABELS, type HighlightGestureAction, type Orientation, needsComment, newFormatId, syncMenus, type AnnotationMode, type CopyAction, type LinkStyle, type LinkPlace, type LinkType, type OpenTarget, type WordHintFlow } from './settings';

type TabId = 'own' | 'reading' | 'links' | 'highlights' | 'annotations' | 'menus';

/** The tab showing, kept while the settings are redrawn and between visits. */
let activeTab: TabId = 'reading';

/** Template variables (`{{text}}`) in a format's text, as code. */
const codeVars = (text: string) => text.replace(/\{\{\w+\}\}/g, '`$&`');

export class FppSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private plugin: FilePlusPlusPlugin,
	) {
		super(app, plugin);
	}

	/** Which device and orientation the Reading section edits (this device, now, by default). */
	private appearanceDevice: string | null = null;
	private appearanceOrientation: Orientation | null = null;

	private appearanceSection(sec: Section): void {
		const plugin = this.plugin;
		const devices = plugin.settings.devices;
		if (!this.appearanceDevice || !devices[this.appearanceDevice]) this.appearanceDevice = plugin.deviceId;
		const device = this.appearanceDevice;
		const orientation = (this.appearanceOrientation ??= plugin.orientation);
		const key = plugin.appearanceKey(device, orientation);
		const deviceName = (id: string) => `${devices[id].name}${id === plugin.deviceId ? ' (this device)' : ''}`;

		new Setting(sec.items)
			.setName('Appearance for')
			.setDesc('Each device keeps its own appearance, separately for a horizontal and a vertical window (or screen).')
			.addDropdown((d) => {
				for (const id of [plugin.deviceId, ...Object.keys(devices).filter((id) => id !== plugin.deviceId)]) d.addOption(id, deviceName(id));
				d.setValue(device).onChange((v) => {
					this.appearanceDevice = v;
					this.display();
				});
			})
			.addDropdown((d) =>
				d
					.addOptions(ORIENTATION_LABELS)
					.setValue(orientation)
					.onChange((v) => {
						this.appearanceOrientation = v as Orientation;
						this.display();
					}),
			);
		const nameRow = new Setting(sec.items)
			.setClass('fpp-subsetting')
			.setName('Device name')
			.addText((t) =>
				t.setValue(devices[device].name).onChange((v) => {
					devices[device].name = v.trim() || devices[device].name;
					void plugin.saveSettings();
				}),
			);
		if (device !== plugin.deviceId)
			nameRow.addExtraButton((b) =>
				b
					.setIcon('trash-2')
					.setTooltip('Forget this device and its appearance')
					.onClick(async () => {
						await plugin.forgetDevice(device);
						this.appearanceDevice = null;
						this.display();
					}),
			);
		buildAppearanceControls(card(sec), plugin, globalAppearance(plugin, key));

		const noun = plugin.format.noun;
		const books = Object.keys(plugin.settings.bookAppearance).filter((path) => Object.keys(plugin.bookAppearance(path, key)).length);
		if (!books.length) return;
		const own = card(sec);
		new Setting(own)
			.setName(`${titleCase(noun)}s with their own appearance`)
			.setDesc(md(`Set from a ${noun}'s Appearance panel (*This ${noun}*). Their own settings win over the ones above.`));
		for (const path of books) {
			new Setting(own)
				.setClass('fpp-subsetting')
				.setName(path.split('/').pop()!.replace(/\.[^.]+$/, ''))
				.setDesc(Object.keys(plugin.bookAppearance(path, key)).join(', '))
				.addExtraButton((x) =>
					x
						.setIcon('rotate-ccw')
						.setTooltip(`Use the settings for all ${noun}s`)
						.onClick(async () => {
							await plugin.resetBookAppearance(path, key);
							this.display();
						}),
				);
		}
	}

	/** Reorderable, toggleable list of menu items. */
	private menuEditor(sec: Section, key: 'selectionMenu' | 'highlightMenu', label: (id: string) => string): void {
		const list = this.plugin.settings[key];
		const box = sec.items === this.containerEl ? sec.items.createDiv() : sec.items;
		box.addClass('fpp-menu-editor');
		list.forEach((entry, i) => {
			const row = new Setting(box).setName(label(entry.id));
			row.settingEl.addClass('fpp-menu-editor-row');
			row.settingEl.toggleClass('is-hidden-item', !entry.show);
			row.addExtraButton((b) =>
				b
					.setIcon('arrow-up')
					.setTooltip('Move up')
					.setDisabled(i === 0)
					.onClick(async () => {
						[list[i - 1], list[i]] = [list[i], list[i - 1]];
						await this.plugin.saveSettings();
						this.display();
					}),
			);
			row.addExtraButton((b) =>
				b
					.setIcon('arrow-down')
					.setTooltip('Move down')
					.setDisabled(i === list.length - 1)
					.onClick(async () => {
						[list[i + 1], list[i]] = [list[i], list[i + 1]];
						await this.plugin.saveSettings();
						this.display();
					}),
			);
			row.addToggle((t) =>
				t
					.setTooltip('Show in menu')
					.setValue(entry.show)
					.onChange(async (v) => {
						entry.show = v;
						row.settingEl.toggleClass('is-hidden-item', !v);
						await this.plugin.saveSettings();
					}),
			);
		});
	}

	override display(): void {
		const { containerEl } = this;
		const s = this.plugin.settings;
		const save = () => this.plugin.saveSettings();
		const syncCommands = debounce(() => this.plugin.annotator.syncFormatCommands(), 800, true);
		const { format, manifest } = this.plugin;
		const noun = format.noun;
		const scrollTop = containerEl.scrollTop;
		containerEl.empty();

		const own = createDiv();
		this.plugin.displaySettings(own, () => this.display());

		/**
		 * The settings in tabs, each heading's settings in a card. A plugin that draws tabs of its own
		 * (Logoxide) gets them flat after its own, a heading each, and moves them into its tabs.
		 */
		let group: (tab: TabId, name: string, desc?: string) => Section;
		if (own.querySelector('[role="tablist"]')) {
			containerEl.removeClass('fpp-settings');
			new Setting(containerEl).setName(format.name).setHeading();
			containerEl.appendChild(own);
			group = (_tab, name, desc) => {
				const heading = new Setting(containerEl).setName(name).setHeading();
				if (desc) containerEl.createEl('p', { cls: 'setting-item-description' }).append(md(desc));
				return { group: containerEl, heading, items: containerEl };
			};
		} else {
			containerEl.addClass('fpp-settings');
			const specs: TabSpec<TabId>[] = [
				{ id: 'reading', name: 'Reading', icon: 'book-open-text', lead: `How ${noun}s look (on each device, for each window orientation), jumping to a passage, and hover previews and embeds.` },
				{ id: 'links', name: 'Links', icon: 'link', lead: `The links you copy from a ${noun}: their kind and text, where they open, and the copy formats in the menus.` },
				{ id: 'highlights', name: 'Highlights', icon: 'highlighter', lead: `Links from your notes into a ${noun} are its highlights: how they're drawn, their colors, and other plugins' annotations.` },
				{ id: 'annotations', name: 'Annotation files', icon: 'file-text', lead: `A note per ${noun} that collects its highlights, under a heading per chapter.` },
				{ id: 'menus', name: 'Menus', icon: 'menu', lead: 'What the menus on a selection and on a highlight hold, and what touches on a highlight do on mobile.' },
			];
			if (own.childElementCount) specs.unshift({ id: 'own', name: format.name, icon: 'sliders-horizontal' });
			const tabs = new Tabs(containerEl, specs, activeTab, (id) => {
				activeTab = id;
				containerEl.scrollTop = 0;
			});
			if (own.childElementCount) {
				own.addClass('setting-items');
				tabs.panels.get('own')!.createDiv('setting-group').append(own);
			}
			group = (tab, name, desc) => section(tabs.panels.get(tab)!, name, desc);
		}

		// ─── Reading ───────────────────────────────────────────────────────────

		this.appearanceSection(group('reading', 'Reading'));

		const jump = group('reading', 'Jumping to a passage');
		const applyFlash = () => {
			for (const view of this.plugin.views()) view.applyFlashSettings();
		};
		let flashRows: Setting[] = [];
		new Setting(jump.items)
			.setName('Highlight the passage after opening a link')
			.setDesc('Shown on top of existing highlights, then fades out.')
			.addToggle((t) =>
				t.setValue(s.jumpHighlight).onChange(async (v) => {
					s.jumpHighlight = v;
					for (const r of flashRows) r.settingEl.toggle(v);
					await save();
				}),
			);
		flashRows = [
			new Setting(jump.items).setName('Duration').setDesc('Seconds, including the fade-out.').addSlider((sl) =>
				sl
					.setLimits(0.5, 10, 0.5)
					.setValue(s.jumpHighlightDuration / 1000)
					.setDynamicTooltip()
					.onChange(async (v) => {
						s.jumpHighlightDuration = Math.round(v * 1000);
						await save();
						applyFlash();
					}),
			),
			new Setting(jump.items).setName('Color').addColorPicker((c) =>
				c.setValue(s.jumpHighlightColor).onChange(async (v) => {
					s.jumpHighlightColor = v;
					await save();
					applyFlash();
				}),
			),
		];
		for (const r of flashRows) {
			r.settingEl.addClass('fpp-subsetting');
			r.settingEl.toggle(s.jumpHighlight);
		}

		const previews = group('reading', 'Previews', `In the editor, ${format.name} links preview on plain hover. Change that under *Settings → Page preview → ${manifest.name}: ${format.name} links in the editor*.`);
		new Setting(previews.items)
			.setName('Hover previews and embeds')
			.setDesc(md(`Preview the linked passage when hovering a link to a ${noun} (with Page preview), and render \`![[file.${format.extensions[0]}#…]]\` embeds.`))
			.addToggle((t) =>
				t.setValue(s.previews).onChange(async (v) => {
					s.previews = v;
					await save();
					this.plugin.updatePreviews();
				}),
			);
		new Setting(previews.items)
			.setName('Links inside previews')
			.setDesc(`Clicking a link to another place in the ${noun} inside a hover preview or embed. Ctrl/Cmd-click always opens a new tab.`)
			.addDropdown((d) =>
				d
					.addOptions({ preview: 'Jump there in the preview', tab: `Open in the ${noun}'s tab` })
					.setValue(s.previewLinks)
					.onChange(async (v) => {
						s.previewLinks = v as 'preview' | 'tab';
						await save();
					}),
			);
		new Setting(previews.items)
			.setName('Preview height')
			.setDesc('In pixels.')
			.addSlider((sl) =>
				sl
					.setLimits(160, 800, 20)
					.setValue(s.previewHeight)
					.setDynamicTooltip()
					.onChange(async (v) => {
						s.previewHeight = v;
						await save();
					}),
			);

		const keys = group('reading', 'Keyboard', `Keys while a ${noun} is focused (not while typing), ahead of Obsidian's hotkeys there. The number keys and the commands *${manifest.name}: Use highlight color 1…9* (for Obsidian hotkeys) pick the highlight color.`);
		new Setting(keys.items)
			.setName('Number keys pick the color')
			.setDesc('1–9 pick a color in palette order (under Highlights), 0 no color.')
			.addToggle((t) =>
				t.setValue(s.numberKeyColors).onChange(async (v) => {
					s.numberKeyColors = v;
					await save();
				}),
			);
		let keyRows: Setting[] = [];
		new Setting(keys.items)
			.setName('Vim-like keys')
			.setDesc(
				md(
					'Scrolling, search, the outline, the sidebar and comments. A key is written as typed (`j`, `G`, `/`) or named (`Tab`, `Enter`, `Space`, `ArrowDown`), with modifiers in front (`Ctrl+d`, `Alt+j`, `Shift+Tab`, `Mod+k`: Cmd on a Mac, Ctrl elsewhere); several keys in a row are separated by spaces (`g g`). Empty turns it off. Or record it with the keyboard button: press the keys, then wait a second.',
				),
			)
			.addToggle((t) =>
				t.setValue(s.readerKeysEnabled).onChange(async (v) => {
					s.readerKeysEnabled = v;
					for (const r of keyRows) r.settingEl.toggle(v);
					await save();
				}),
			);
		keyRows = READER_KEY_ACTIONS.map((a) => {
			const row = new Setting(keys.items).setName(a.name).setClass('fpp-subsetting');
			if ('desc' in a) row.setDesc(a.desc);
			let text!: TextComponent;
			const setBinding = async (value: string) => {
				const chords = parseBinding(value, Platform.isMacOS);
				text.inputEl.toggleClass('fpp-key-invalid', !chords);
				text.inputEl.setAttr('aria-label', chords ? '' : 'Not a key: see the description above');
				if (!chords) return;
				s.readerKeys[a.id] = chords.join(' ');
				await save();
			};
			row.addText((t) => {
				text = t;
				t.inputEl.addClass('fpp-key-input');
				t.setPlaceholder('Off').setValue(s.readerKeys[a.id]).onChange(setBinding);
				// Shown normalized (`ctrl+D` → `Ctrl+D`) once done
				t.inputEl.addEventListener('blur', () => {
					if (!t.inputEl.hasClass('fpp-key-invalid')) t.setValue(s.readerKeys[a.id]);
				});
			});
			row.addExtraButton((b) =>
				b
					.setIcon('keyboard')
					.setTooltip('Record keys')
					.onClick(() => {
						// A scope of its own while recording: ahead of the settings' Escape and every hotkey
						const scope = new Scope();
						const chords: string[] = [];
						let timer = 0;
						const done = async (keep: boolean) => {
							window.clearTimeout(timer);
							this.app.keymap.popScope(scope);
							b.extraSettingsEl.removeClass('is-active');
							text.setPlaceholder('Off');
							if (keep && chords.length) await setBinding(chords.join(' '));
							text.setValue(s.readerKeys[a.id]);
						};
						scope.register(null, null, (e) => {
							const chord = chordOf(e);
							if (!chord) return false;
							if (chord === 'Escape' && !chords.length) {
								void done(false);
								return false;
							}
							chords.push(chord);
							text.setValue(chords.join(' '));
							window.clearTimeout(timer);
							timer = window.setTimeout(() => void done(true), 1000);
							return false;
						});
						this.app.keymap.pushScope(scope);
						b.extraSettingsEl.addClass('is-active');
						text.setValue('');
						text.setPlaceholder('Press keys…');
						timer = window.setTimeout(() => void done(false), 5000);
					}),
			);
			row.addExtraButton((b) =>
				b
					.setIcon('rotate-ccw')
					.setTooltip(`Default: ${a.key}`)
					.onClick(async () => {
						s.readerKeys[a.id] = a.key;
						await save();
						this.display();
					}),
			);
			row.settingEl.toggle(s.readerKeysEnabled);
			return row;
		});
		new Setting(keys.items)
			.setName('Sentence labels')
			.setDesc(
				md(
					`The keys that label the sentences and words in view (\`h\` / \`c\` and \`H\` / \`C\` above, or the commands *${manifest.name}: Highlight a sentence in view* and *Comment on a sentence in view*), the best first. One key each while they fit, else two.`,
				),
			)
			.addText((t) =>
				t
					.setPlaceholder(DEFAULT_SETTINGS.hintKeys)
					.setValue(s.hintKeys)
					.onChange(async (v) => {
						s.hintKeys = v.replace(/\s/g, '') || DEFAULT_SETTINGS.hintKeys;
						await save();
					}),
			);
		const hintFormat = (name: string, desc: string, key: 'hintFormat' | 'hintCommentFormat') =>
			new Setting(keys.items)
				.setName(name)
				.setDesc(desc)
				.addDropdown((d) => {
					d.addOption('link', 'Link');
					d.addOption('alt-link', s.linkType === 'primary' ? 'Text-fragment link' : `${format.linkTypeName} link`);
					for (const f of s.copyFormats) d.addOption(`format:${f.id}`, f.name);
					d.setValue(this.plugin.annotator.resolveCopyAction(s[key]) ? s[key] : DEFAULT_SETTINGS[key]).onChange(async (v) => {
						s[key] = v as CopyAction;
						await save();
					});
				});
		new Setting(keys.items)
			.setName('Picking from word to word')
			.setDesc(md('How `H` / `C` pick where a passage starts and ends. Every word in view takes longer labels, and a lot of them.'))
			.addDropdown((d) =>
				d
					.addOptions({ sentence: 'Sentence, word, sentence, word', word: 'Word, word (every word labeled)' })
					.setValue(s.wordHintFlow)
					.onChange(async (v) => {
						s.wordHintFlow = v as WordHintFlow;
						await save();
					}),
			);
		for (const [key, name, desc] of [
			['hintStartPunctuation', 'Starting at a sentence\'s first word includes the punctuation before it', 'An opening quote or bracket.'],
			['hintEndPunctuation', 'Ending at a sentence\'s last word includes the punctuation after it', 'The period, a closing quote or bracket.'],
		] as const)
			new Setting(keys.items)
				.setName(name)
				.setDesc(desc)
				.setClass('fpp-subsetting')
				.addToggle((t) =>
					t.setValue(s[key]).onChange(async (v) => {
						s[key] = v;
						await save();
					}),
				);
		hintFormat('Highlighting a sentence copies', `As the copy format's command, in the current color: into the ${noun}'s annotation file, per its mode.`, 'hintFormat');
		hintFormat('Commenting on a sentence copies', 'Likewise; a format with {{comment}} asks for the comment.', 'hintCommentFormat');

		// ─── Links ─────────────────────────────────────────────────────────────

		const links = group('links', 'Links');
		new Setting(links.items)
			.setName('Link type')
			.setDesc(format.linkTypeDescription)
			.addDropdown((d) =>
				d
					.addOptions({ primary: format.linkTypeName, text: 'Text fragment' })
					.setValue(s.linkType)
					.onChange(async (v) => {
						s.linkType = v as LinkType;
						await save();
					}),
			);
		new Setting(links.items)
			.setName('Link format')
			.setDesc(md('*Vault default* follows *Settings → Files & links → Use [[Wikilinks]]*.'))
			.addDropdown((d) =>
				d
					.addOptions({ auto: 'Vault default', wiki: '[[Wikilink]]', markdown: '[Markdown](link)' })
					.setValue(s.linkStyle)
					.onChange(async (v) => {
						s.linkStyle = v as LinkStyle;
						await save();
					}),
			);
		new Setting(links.items)
			.setName('Link display text')
			.setDesc(md('Variables: `{{title}}`, `{{author}}`, `{{chapter}}`, `{{text}}`, `{{file}}`.'))
			.addText((t) => {
				t.inputEl.addClass('fpp-code-input');
				t.setValue(s.aliasTemplate).onChange(async (v) => {
					s.aliasTemplate = v;
					await save();
				});
			});
		new Setting(links.items)
			.setName('Include color in links')
			.setDesc(md('Adds `&color=<name>` so the highlight is drawn in that color.'))
			.addToggle((t) =>
				t.setValue(s.colorInLinks).onChange(async (v) => {
					s.colorInLinks = v;
					await save();
				}),
			);
		new Setting(links.items)
			.setName('Include last-updated time in links')
			.setDesc(md('Adds `&updated=<time>` (UTC, e.g. `20261008T140312Z`) when a highlight is created, and updates it when its color or comment changes.'))
			.addToggle((t) =>
				t.setValue(s.timestampInLinks).onChange(async (v) => {
					s.timestampInLinks = v;
					await save();
				}),
			);

		const opening = group('links', 'Opening links');
		const targets = { split: 'Split pane', tab: 'New tab', current: 'Current tab' };
		new Setting(opening.items)
			.setName(`Open ${format.name} links in`)
			.setDesc(`Used when the ${noun} is not open yet; an open ${noun} is reused and scrolled.`)
			.addDropdown((d) =>
				d
					.addOptions(targets)
					.setValue(s.openIn)
					.onChange(async (v) => {
						s.openIn = v as OpenTarget;
						await save();
					}),
			);
		new Setting(opening.items)
			.setName('Reuse tabs and panes')
			.setDesc(md(`With *Split pane*: if the ${noun} is already open in a tab of another pane, switch to it there; otherwise open it as a new tab in an existing other pane before creating a new split.`))
			.addToggle((t) =>
				t.setValue(s.reusePanes).onChange(async (v) => {
					s.reusePanes = v;
					await save();
				}),
			);
		const places: [LinkPlace, string, string][] = [
			['mobile', 'on a phone or tablet', ''],
			['desktop', 'on desktop', ''],
			['half', 'on desktop, in half the window', ' when it takes about half the width of the panes, or less'],
		];
		for (const [place, name, where] of places) {
			const o = s.linkOpening[place];
			const choices = { keep: 'Leave the sidebar and comments', sidebar: 'Close the sidebar', comments: 'Hide comments in the margin', both: 'Close the sidebar, hide comments' };
			new Setting(opening.items)
				.setName(`Following a link ${name}`)
				.setDesc(md(`What a link that opens a ${noun} at a passage, or goes to one already open, does to its tab${where}. Comments hidden this way come back with the tab's menu or the *Toggle comments in the margin* command.`))
				.addDropdown((d) =>
					d
						.addOptions(choices)
						.setValue(o.closeSidebar ? (o.hideComments ? 'both' : 'sidebar') : o.hideComments ? 'comments' : 'keep')
						.onChange(async (v) => {
							s.linkOpening[place] = { closeSidebar: v === 'sidebar' || v === 'both', hideComments: v === 'comments' || v === 'both' };
							await save();
						}),
				);
		}
		new Setting(opening.items)
			.setName('Open notes from highlights in')
			.addDropdown((d) =>
				d
					.addOptions(targets)
					.setValue(s.openNoteIn)
					.onChange(async (v) => {
						s.openNoteIn = v as OpenTarget;
						await save();
					}),
			);

		const copying = group('links', 'Copying');
		new Setting(copying.items)
			.setName('Copy text as Markdown')
			.setDesc(md(`Convert the ${noun}'s formatting (italics, bold, lists, headings, line breaks) to Markdown when copying or inserting a selection (\`{{text}}\`). Off: plain text.`))
			.addToggle((t) =>
				t.setValue(s.copyMarkdown).onChange(async (v) => {
					s.copyMarkdown = v;
					await save();
				}),
			);
		new Setting(copying.items)
			.setName('Ctrl/Cmd+C copies')
			.setDesc(`What copying a selection in a ${noun} puts on the clipboard (also used by the system Copy menu).`)
			.addDropdown((d) => {
				d.addOption('text', 'Plain text');
				d.addOption('link', 'Link');
				d.addOption('alt-link', s.linkType === 'primary' ? 'Text-fragment link' : `${format.linkTypeName} link`);
				for (const f of s.copyFormats) d.addOption(`format:${f.id}`, f.name);
				d.setValue(this.plugin.annotator.resolveCopyAction(s.copyAction) ? s.copyAction : 'text').onChange(async (v) => {
					s.copyAction = v as CopyAction;
					await save();
				});
			});
		new Setting(copying.items)
			.setName('Other copy shortcuts')
			.setDesc(md(`Each copy style is a command (*${manifest.name}: Copy selection as …*); assign keys to them under Hotkeys.`))
			.addButton((b) =>
				b.setButtonText('Open hotkeys').onClick(() => {
					const setting = (this.app as any).setting;
					const tab = setting?.openTabById?.('hotkeys');
					tab?.searchComponent?.setValue?.(`${manifest.name}: Copy`);
					tab?.updateHotkeyVisibility?.();
				}),
			);

		const formats = group(
			'links',
			'Copy formats',
			`Shown in the right-click menu. Variables: \`{{text}}\`, \`{{context}}\` (the selection \`==highlighted==\` in its sentence; a whole sentence with the ones before and after), \`{{link}}\`, \`{{color}}\`, \`{{title}}\`, \`{{author}}\`, \`{{chapter}}\`, \`{{locator}}\`, \`{{file}}\`, \`{{path}}\`${format.extraTemplateVars ? `, ${codeVars(format.extraTemplateVars)}` : ''}, and \`{{comment}}\` (asks for a comment when copying). Multi-line values keep the \`> \` prefix of their line.`,
		);
		formats.heading.addButton((b) =>
			b.setButtonText('Add format').onClick(async () => {
				s.copyFormats.push({ id: newFormatId(), name: 'New format', template: '{{text}} {{link}}' });
				syncMenus(s);
				await save();
				this.plugin.annotator.syncFormatCommands();
				this.display();
			}),
		);
		if (!s.copyFormats.length) formats.items.createDiv({ cls: 'setting-item mod-empty-state fpp-empty-state', text: 'No copy formats yet.' });
		s.copyFormats.forEach((fmt, i) => {
			new Setting(formats.items)
				.setClass('fpp-format-row')
				.addText((t) =>
					t
						.setPlaceholder('Name')
						.setValue(fmt.name)
						.onChange(async (v) => {
							fmt.name = v;
							await save();
							syncCommands();
						}),
				)
				.addTextArea((t) => {
					t.inputEl.rows = 3;
					t.inputEl.addClass('fpp-template');
					t.setValue(fmt.template).onChange(async (v) => {
						fmt.template = v;
						await save();
					});
				})
				.addExtraButton((b) =>
					b
						.setIcon('trash-2')
						.setTooltip('Remove')
						.onClick(async () => {
							s.copyFormats.splice(i, 1);
							if (s.copyAction === `format:${fmt.id}`) s.copyAction = 'text';
							syncMenus(s);
							await save();
							this.plugin.annotator.syncFormatCommands();
							this.display();
						}),
				);
		});

		// ─── Highlights ────────────────────────────────────────────────────────

		const highlights = group('highlights', 'Highlights');
		new Setting(highlights.items)
			.setName('Show highlights')
			.setDesc(md(`Draw links from your notes as highlights in ${noun}s. Off: the text is left plain, but the sidebar still lists them and comments in the margin still show; hovering or selecting a comment shows its highlight. Also the eye button in the Highlights tab and the *Show / hide highlights* command.`))
			.addToggle((t) => t.setValue(!s.hideHighlights).onChange((v) => this.plugin.annotator.setHighlightsHidden(!v)));
		new Setting(highlights.items)
			.setName('Dim other highlights')
			.setDesc(md('While the pointer is on a highlight or its comment, or a comment is selected, the other highlights fade. Turn it off if that is slow on this device. Kept for this device only (not synced).'))
			.addToggle((t) => t.setValue(this.plugin.dimHighlights).onChange((v) => this.plugin.setDimHighlights(v)));
		new Setting(highlights.items)
			.setName('Comments in the margin')
			.setDesc(md(`Show comments beside the highlighted text, like Google Docs, when the pane is wide enough (otherwise they show on hover). Independent of *Show highlights*. Also: the comment button in the Highlights tab, the *Toggle comments in the margin* command and the ${noun}'s tab menu.`))
			.addToggle((t) =>
				t.setValue(s.marginComments).onChange(async (v) => {
					await this.plugin.annotator.setMarginComments(v);
				}),
			);
		new Setting(highlights.items)
			.setName('Vim keys in the comment editor')
			.setDesc(md('Edit comments with Vim keys (desktop): a new comment starts in insert mode, Escape goes to normal mode instead of closing, `:w` (or Ctrl/Cmd+Enter) saves, `:q` cancels.'))
			.addToggle((t) =>
				t.setValue(s.commentVim).onChange(async (v) => {
					s.commentVim = v;
					await save();
				}),
			);
		new Setting(highlights.items)
			.setName('Leave insert mode with')
			.setDesc(md('Keys typed quickly in insert mode that work as Escape there (`jk`, as `inoremap jk <Esc>`). Empty: none.'))
			.addText((t) =>
				t
					.setPlaceholder('jk')
					.setValue(s.commentVimEscape)
					.onChange(async (v) => {
						s.commentVimEscape = v.trim();
						await save();
					}),
			);
		new Setting(highlights.items)
			.setName('Links without a color')
			.setDesc(md('For links that have no `&color=…`.'))
			.addDropdown((d) =>
				d
					.addOptions({ default: 'Highlight with the default color', none: "Don't highlight" })
					.setValue(s.noColor)
					.onChange(async (v) => {
						s.noColor = v as 'default' | 'none';
						await save();
						this.plugin.refreshAllHighlights();
					}),
			);
		new Setting(highlights.items)
			.setName('Highlight opacity')
			.setDesc(`Applies to newly opened ${noun}s.`)
			.addSlider((sl) =>
				sl
					.setLimits(0.1, 1, 0.05)
					.setValue(s.highlightOpacity)
					.setDynamicTooltip()
					.onChange(async (v) => {
						s.highlightOpacity = v;
						await save();
					}),
			);

		const colors = group('highlights', 'Colors', 'The colors in the highlight menus. Links name them (`&color=yellow`).');
		colors.heading.addButton((b) =>
			b.setButtonText('Add color').onClick(async () => {
				s.palette.push({ name: `color${s.palette.length + 1}`, color: '#888888' });
				await save();
				this.plugin.refreshPalette();
				this.display();
			}),
		);
		new Setting(colors.items)
			.setName('Default color')
			.setDesc('For new highlights, and links without a color.')
			.addDropdown((d) => {
				for (const p of s.palette) d.addOption(p.name, p.name);
				d.setValue(s.defaultColor).onChange(async (v) => {
					s.defaultColor = v;
					await save();
					this.plugin.refreshPalette();
				});
			});
		const palette = colors.items === containerEl ? containerEl : card(colors);
		s.palette.forEach((p, i) => {
			const row = new Setting(palette).setClass('fpp-color-row');
			row
				.addText((t) =>
					t
						.setPlaceholder('name')
						.setValue(p.name)
						.onChange(async (v) => {
							const was = p.name;
							p.name = v.trim().replace(/\s+/g, '-');
							if (s.defaultColor === was) s.defaultColor = p.name;
							await save();
							this.plugin.refreshPalette();
						}),
				)
				.addColorPicker((c) =>
					c.setValue(p.color).onChange(async (v) => {
						p.color = v;
						await save();
						this.plugin.refreshPalette();
					}),
				)
				.addExtraButton((b) =>
					b
						.setIcon('trash-2')
						.setTooltip('Remove')
						.onClick(async () => {
							s.palette.splice(i, 1);
							await save();
							this.plugin.refreshPalette();
							this.display();
						}),
				);
		});

		const others = group(
			'highlights',
			'Annotations from other plugins',
			`Other plugins can mark passages in ${noun}s (for example Bible references). Each gets its own sidebar tab, where its eye button shows or hides it in the ${noun}. Right-click one (or hold it on mobile) to save it as a highlight in the annotation file.`,
		);
		new Setting(others.items)
			.setName('Save as highlight inserts')
			.setDesc(md("What *Save as highlight* adds to the annotation file (created if needed). Templates can use `{{label}}`, the annotation's name. *Save with comment* uses the first format with `{{comment}}`."))
			.addDropdown((d) => {
				d.addOption('link', 'Link');
				for (const f of s.copyFormats) if (!needsComment(f.template)) d.addOption(`format:${f.id}`, f.name);
				const current = this.plugin.annotator.saveFormat();
				d.setValue(typeof current === 'string' ? current : `format:${current.id}`).onChange(async (v) => {
					s.saveAnnotationAs = v as CopyAction;
					await save();
				});
			});
		for (const p of this.plugin.providers.values())
			new Setting(others.items).setName(`Show ${p.name}`).addToggle((t) =>
				t.setValue(!s.hiddenProviders.includes(p.id)).onChange((v) => this.plugin.setProviderHidden(p.id, !v)),
			);

		// ─── Annotation files ──────────────────────────────────────────────────

		const files = group(
			'annotations',
			'Annotation files',
			`An annotation file is a note with a heading per chapter (from the table of contents), linked to the ${noun} by its \`${format.frontmatterKey}\` property. Create one from the Highlights tab, the ${noun}'s tab menu, or the command palette. While a ${noun} has one, copying from the selection menu can insert the annotation in the right chapter, in ${noun} order.`,
		);
		new Setting(files.items)
			.setName('When copying a selection')
			.setDesc(md(`Default for ${noun}s with an annotation file. Each file can override it (the Copy / Insert / Both row in the selection menu, saved in its \`${this.plugin.annotator.annotations.modeKey}\` property).`))
			.addDropdown((d) =>
				d
					.addOptions({ copy: 'Copy to clipboard', insert: 'Insert into the annotation file', both: 'Copy and insert' })
					.setValue(s.annotationMode)
					.onChange(async (v) => {
						s.annotationMode = v as AnnotationMode;
						await save();
					}),
			);
		new Setting(files.items)
			.setName('Folder for new annotation files')
			.setDesc(`Leave empty to create them next to the ${noun}. To move existing annotation files too, use Move…`)
			.addText((t) =>
				t
					.setPlaceholder('e.g. Reading/Annotations')
					.setValue(s.annotationFolder)
					.onChange(async (v) => {
						s.annotationFolder = v;
						await save();
					}),
			)
			.addButton((b) => b.setButtonText('Move…').onClick(() => new AnnotationFolderModal(this.app, this.plugin as never, () => this.display()).open()));
		new Setting(files.items)
			.setName('File name')
			.setDesc(md('Variables: `{{title}}`, `{{author}}`, `{{file}}`.'))
			.addText((t) => {
				t.inputEl.addClass('fpp-code-input');
				t.setValue(s.annotationFileName).onChange(async (v) => {
					s.annotationFileName = v;
					await save();
				});
			});
		new Setting(files.items)
			.setName('Place text-fragment links exactly')
			.setDesc(`Locate text-fragment annotations in the ${noun} to order new ones among them. Turn off if inserting is slow; they are then added at the end of the chapter section.`)
			.addToggle((t) =>
				t.setValue(s.annotationResolveTextFragments).onChange(async (v) => {
					s.annotationResolveTextFragments = v;
					await save();
				}),
			);

		// ─── Menus ─────────────────────────────────────────────────────────────

		this.menuEditor(group('menus', 'Selection menu', 'What the right-click (or tap) menu on selected text holds, in order. On mobile, *System menu* is always added last.'), 'selectionMenu', (id) => {
			if (id.startsWith('format:')) {
				const f = s.copyFormats.find((x) => `format:${x.id}` === id);
				return f ? formatMenuLabel(f.name) : id;
			}
			if (id === 'alt-link') return altLinkLabel(s.linkType, format.linkTypeName);
			return SELECTION_MENU_LABELS[id] ?? id;
		});
		this.menuEditor(group('menus', 'Highlight menu', 'What the right-click (or tap) menu on a highlight holds, in order.'), 'highlightMenu', (id) => HIGHLIGHT_MENU_LABELS[id] ?? id);

		const mobile = group('menus', 'Mobile');
		const gesture = (name: string, key: 'highlightTap' | 'highlightDoubleTap' | 'highlightHold') =>
			new Setting(mobile.items).setName(name).addDropdown((d) =>
				d
					.addOptions(HIGHLIGHT_GESTURE_LABELS)
					.setValue(s[key])
					.onChange(async (v) => {
						s[key] = v as HighlightGestureAction;
						await save();
					}),
			);
		gesture('Tap a highlight', 'highlightTap');
		gesture('Double-tap a highlight', 'highlightDoubleTap');
		gesture('Hold a highlight', 'highlightHold');
		new Setting(mobile.items)
			.setName('Selection menu')
			.setDesc(md(`Open ${manifest.name}'s copy menu when you select text (there is no right-click on mobile). Its *System menu* item brings back the phone's own menu.`))
			.addToggle((t) =>
				t.setValue(s.selectionBar).onChange(async (v) => {
					s.selectionBar = v;
					await save();
				}),
			);

		containerEl.scrollTop = scrollTop;
	}
}

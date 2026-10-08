/** `publisher` (theme, text alignment, fonts): keep the document's own styles (an EPUB publisher's, or a format's defaults). */
export type ThemeName = 'auto' | 'light' | 'dark' | 'sepia' | 'publisher';
export type WidthUnit = 'px' | 'ch' | 'em' | '%';
export type TextAlign = 'publisher' | 'left' | 'justify';

export interface ReaderSettings {
	/** `auto` follows the host page (Obsidian theme variables, or system colors). */
	theme: ThemeName;
	/** Base font size in px. Publisher sizes scale relative to this. */
	fontSize: number;
	/** CSS font-family; empty string keeps the publisher's fonts. */
	fontFamily: string;
	/** Unitless line height; null keeps the publisher's. */
	lineHeight: number | null;
	textAlign: TextAlign;
	/** Maximum reading width; 0 = no limit. */
	width: number;
	widthUnit: WidthUnit;
	/** Horizontal padding in px. */
	margin: number;
	/** Slightly dim images in dark themes. */
	dimImages: boolean;
}

export const DEFAULT_SETTINGS: ReaderSettings = {
	theme: 'auto',
	fontSize: 18,
	fontFamily: '',
	lineHeight: null,
	textAlign: 'publisher',
	width: 42,
	widthUnit: 'em',
	margin: 24,
	dimImages: true,
};

interface ThemeColors {
	bg: string;
	fg: string;
	link: string;
	dark: boolean;
}

const THEMES: Record<Exclude<ThemeName, 'publisher'>, ThemeColors> = {
	auto: {
		bg: 'var(--background-primary, Canvas)',
		fg: 'var(--text-normal, CanvasText)',
		link: 'var(--text-accent, LinkText)',
		dark: false,
	},
	light: { bg: '#ffffff', fg: '#1d1d1f', link: '#2e5fa8', dark: false },
	dark: { bg: '#1c1c1e', fg: '#d6d6d6', link: '#8ab4f8', dark: true },
	sepia: { bg: '#f4ecd8', fg: '#5b4636', link: '#8a4b16', dark: false },
};

/** CSS custom properties to set on the host element for the given settings. */
export function settingsToVars(s: ReaderSettings, hostIsDark: boolean): Record<string, string | null> {
	const themed = s.theme !== 'publisher';
	const t = themed ? THEMES[s.theme as keyof typeof THEMES] : null;
	const dark = s.theme === 'auto' ? hostIsDark : !!t?.dark;
	return {
		'--fpp-font-size': `${s.fontSize}px`,
		'--fpp-font-family': s.fontFamily || null,
		'--fpp-line-height': s.lineHeight ? String(s.lineHeight) : null,
		'--fpp-text-align': s.textAlign === 'publisher' ? null : s.textAlign,
		'--fpp-max-width': s.width > 0 ? `${s.width}${s.widthUnit}` : 'none',
		'--fpp-margin': `${s.margin}px`,
		'--fpp-bg': t ? t.bg : '#ffffff',
		'--fpp-fg': t ? t.fg : '#000000',
		'--fpp-text-color': t ? t.fg : null,
		'--fpp-link-color': t ? t.link : null,
		'--fpp-bg-override': t ? 'transparent' : null,
		'--fpp-img-filter': dark && s.dimImages ? 'brightness(0.85)' : 'none',
		'--fpp-color-scheme': dark ? 'dark' : 'light',
	};
}

/** Styles of the reader's shadow root (formats add their own, see `DocumentReader.extraCss`). */
export const BASE_CSS = /* css */ `
/* The document's own styles go into the \`document\` layer, between the reader's base and user styles. */
@layer fpp-base, document, fpp-user;

:host {
	display: block;
	position: relative;
	overflow: hidden;
	contain: strict;
}
.fpp-scroller {
	all: initial;
	display: block;
	position: absolute;
	inset: 0;
	overflow-y: auto;
	overflow-x: hidden;
	background: var(--fpp-bg);
	color: var(--fpp-fg);
	color-scheme: var(--fpp-color-scheme);
	font-family: serif;
	-webkit-text-size-adjust: none;
	text-size-adjust: none;
	overscroll-behavior: contain;
	/* Host apps (e.g. Obsidian) often set user-select: none on <body>; 'auto' would inherit it. */
	-webkit-user-select: text;
	user-select: text;
	-webkit-touch-callout: default;
}
.fpp-scroller:focus { outline: none; }
.fpp-content {
	box-sizing: content-box;
	max-width: var(--fpp-max-width, none);
	margin: 0 auto;
	padding: 2em var(--fpp-margin, 24px) 50vh;
	font-size: var(--fpp-font-size);
}

@layer fpp-base {
	.fpp-section {
		display: block;
		font-size: var(--fpp-font-size);
		line-height: var(--fpp-line-height, normal);
		font-family: var(--fpp-font-family, serif);
		text-align: var(--fpp-text-align, start);
		color: var(--fpp-text-color, inherit);
		content-visibility: auto;
		contain-intrinsic-size: auto 800px;
		overflow-wrap: break-word;
	}
	.fpp-body { display: block; margin: 0; }
	.fpp-section + .fpp-section { margin-top: 3em; }
}

@layer fpp-user {
	.fpp-section img, .fpp-section video { max-width: 100%; height: auto; filter: var(--fpp-img-filter); }
	.fpp-section svg { max-width: 100%; max-height: 95vh; }
	.fpp-section img { max-height: 95vh; object-fit: contain; }
	.fpp-themed .fpp-section a[href] { color: var(--fpp-link-color); }
	.fpp-section table { max-width: 100%; }
	.fpp-section pre { white-space: pre-wrap; }
}
`;

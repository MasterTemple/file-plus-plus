/**
 * Build an Obsidian plugin that uses the library: bundle `main.js`, write `styles.css` (the library's
 * styles followed by the plugin's) and copy `manifest.json` into `outdir`.
 *
 * The library's CSS classes, data attributes, CSS variables and highlight names all start with `fpp`;
 * the build renames them to the plugin's `prefix` (e.g. `epp`) in both the bundled library code and its
 * styles, so plugins on different library versions never share (and override) each other's styles.
 *
 *   await buildPlugin({ root: import.meta.dir, prefix: 'epp', production: process.argv[2] === 'production' });
 */
import esbuild from 'esbuild';
import { mkdirSync, readFileSync, realpathSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface BuildOptions {
	/** The plugin's folder (with `manifest.json`, and `styles.css` if it has its own styles). */
	root: string;
	/** Entry point, relative to `root`. Default `src/main.ts`. */
	entry?: string;
	/** Output folder, relative to `root`. Default `dist`. */
	outdir?: string;
	/** Replaces the library's `fpp` prefix (lowercase letters only). */
	prefix: string;
	/** Minify, no source map, build once. Otherwise: inline source maps, watch. */
	production: boolean;
	/** More esbuild options. */
	esbuild?: esbuild.BuildOptions;
}

const LIBRARY = realpathSync(join(dirname(fileURLToPath(import.meta.url)), '..'));

/** `fpp-x`, `--fpp-x`, `data-fpp-x`, `'fpp'`, `[fpp]` → the plugin's prefix. */
export function rewritePrefix(code: string, prefix: string): string {
	if (!/^[a-z]+$/.test(prefix)) throw new Error(`invalid prefix "${prefix}"`);
	return code.replace(/\bfpp(?=[-'"`\]])/g, prefix);
}

export async function buildPlugin(opts: BuildOptions): Promise<void> {
	const { root, prefix, production } = opts;
	const outdir = join(root, opts.outdir ?? 'dist');
	mkdirSync(outdir, { recursive: true });
	const librarySrc = join(LIBRARY, 'src');

	const writeStatic = () => {
		const lib = rewritePrefix(readFileSync(join(LIBRARY, 'styles.css'), 'utf8'), prefix);
		const own = existsSync(join(root, 'styles.css')) ? readFileSync(join(root, 'styles.css'), 'utf8') : '';
		writeFileSync(join(outdir, 'styles.css'), `/* file-plus-plus */\n${lib}\n${own ? `/* plugin */\n${own}` : ''}`);
		copyFileSync(join(root, 'manifest.json'), join(outdir, 'manifest.json'));
	};

	const plugin: esbuild.Plugin = {
		name: 'file-plus-plus',
		setup(build) {
			build.onLoad({ filter: /\.ts$/ }, (args) => {
				const real = realpathSync(args.path);
				if (!real.startsWith(librarySrc)) return undefined;
				return { contents: rewritePrefix(readFileSync(real, 'utf8'), prefix), loader: 'ts' };
			});
			build.onEnd(writeStatic);
		},
	};

	const ctx = await esbuild.context({
		entryPoints: [join(root, opts.entry ?? 'src/main.ts')],
		bundle: true,
		external: ['obsidian', 'electron', '@codemirror/*', '@lezer/*'],
		format: 'cjs',
		target: 'es2022',
		platform: 'browser',
		mainFields: ['browser', 'module', 'main'],
		sourcemap: production ? false : 'inline',
		minify: production,
		treeShaking: true,
		logLevel: 'info',
		outfile: join(outdir, 'main.js'),
		...opts.esbuild,
		plugins: [plugin, ...(opts.esbuild?.plugins ?? [])],
	});
	if (production) {
		await ctx.rebuild();
		await ctx.dispose();
	} else await ctx.watch();
}

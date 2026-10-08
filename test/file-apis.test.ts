import { expect, test } from 'bun:test';
import { fileApis } from '../src/obsidian/api';

test('fileApis finds the loaded file-plus-plus plugins', () => {
	const api = { version: 1, pluginId: 'transcript-plus-plus' };
	const app = { plugins: { plugins: { a: { api }, b: { api: { version: 1 } }, c: {}, d: { api: { version: 2, pluginId: 'x' } } } } };
	expect(fileApis(app as never)).toEqual([api as never]);
	expect(fileApis({} as never)).toEqual([]);
});

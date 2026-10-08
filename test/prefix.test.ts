import { expect, test } from 'bun:test';
import { rewritePrefix } from '../build/plugin';

test('rewritePrefix renames library-owned names only', () => {
	const src = "el.addClass('fpp-toolbar'); x.closest('[data-fpp-section]'); `fpp-${id}-search`; var(--fpp-font-size); const PREFIX = 'fpp'; console.log('[fpp] x'); class FppSettingTab {} const fppish = 1;";
	expect(rewritePrefix(src, 'epp')).toBe(
		"el.addClass('epp-toolbar'); x.closest('[data-epp-section]'); `epp-${id}-search`; var(--epp-font-size); const PREFIX = 'epp'; console.log('[epp] x'); class FppSettingTab {} const fppish = 1;",
	);
});

/**
 * Wrap methods of an object (like `monkey-around`): `around(obj, { method: (next) => function (...args) { … } })`.
 * Returns a function that removes the wrappers. Removing one that others have wrapped since leaves
 * it in their chain as a pass-through, so plugins can patch the same method and unload in any order.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Fn = (...args: any[]) => any;

export function around<O extends object>(obj: O, factories: { [K in keyof O]?: O[K] extends Fn ? (next: O[K]) => O[K] : never }): () => void {
	const removers = Object.entries(factories).map(([key, factory]) => patch(obj as Record<string, Fn>, key, factory as (next: Fn) => Fn));
	return () => removers.forEach((r) => r());
}

function patch(obj: Record<string, Fn>, key: string, factory: (next: Fn) => Fn): () => void {
	const own = Object.prototype.hasOwnProperty.call(obj, key);
	const original = obj[key];
	let current: Fn | null = factory(original);
	const wrapper = function (this: unknown, ...args: unknown[]) {
		return (current ?? original).apply(this, args);
	};
	obj[key] = wrapper;
	return () => {
		current = null;
		if (obj[key] !== wrapper) return;
		if (own) obj[key] = original;
		else delete obj[key];
	};
}

import type { App } from 'obsidian';
import { around } from './patch';

interface Command {
	id: string;
	checkCallback?: (checking: boolean) => boolean | void;
}

/**
 * Let commands that apply in different places share a hotkey ("Copy selection as callout with
 * comment" in EPUB++ and in a Bible, both Ctrl+Alt+M). Obsidian runs the first command bound to a
 * key and stops there, since `executeCommand` says it ran even when the command's check said it
 * doesn't apply now. Here a command whose check fails isn't run and says so, so Obsidian tries the
 * next command with that key (and, if none applies, leaves the key alone). Patched once per app,
 * whichever plugin loads first; the others' patches pass through.
 */
export function shareHotkeys(app: App): () => void {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const commands = (app as any).commands as { executeCommand?: (command: Command, event?: unknown) => boolean } | undefined;
	if (!commands?.executeCommand) return () => {};
	return around(commands as { executeCommand: (command: Command, event?: unknown) => boolean }, {
		executeCommand(old) {
			return function (this: unknown, command: Command, event?: unknown) {
				try {
					if (command?.checkCallback && command.checkCallback(true) === false) return false;
				} catch {
					// a check that throws is Obsidian's to report: run it as before
				}
				return old.call(this, command, event);
			};
		},
	});
}

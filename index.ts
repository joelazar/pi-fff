import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { CustomEditor } from "@mariozechner/pi-coding-agent";
import type { AutocompleteItem, AutocompleteProvider, AutocompleteSuggestions, KeybindingsManager, TUI } from "@mariozechner/pi-tui";
import type { EditorTheme } from "@mariozechner/pi-tui";

const PATH_DELIMITERS = new Set([" ", "\t", '"', "'", "="]);
const MAX_RESULTS = 20;

type FffSearchItem = { relativePath: string; fileName?: string };

type FffSearchResult = {
	ok: true;
	value: { items: FffSearchItem[] };
} | {
	ok: false;
	error: string;
};

type FinderLike = {
	fileSearch(query: string, options?: { pageSize?: number }): FffSearchResult;
	destroy(): void;
	waitForScan?(timeoutMs: number): unknown;
};

type FinderFactoryResult = { ok: true; value: FinderLike } | { ok: false; error: string };

type FileFinderClass = {
	create(options: { basePath: string; aiMode?: boolean }): FinderFactoryResult;
};

class FinderRuntime {
	private finder: FinderLike | null = null;
	private initPromise: Promise<void> | null = null;
	private loadError: string | null = null;

	constructor(private readonly cwd: string) {}

	async ensure(): Promise<FinderLike | null> {
		if (this.finder) return this.finder;
		if (this.loadError) return null;
		if (!this.initPromise) {
			this.initPromise = this.initialize();
		}
		await this.initPromise;
		return this.finder;
	}

	dispose(): void {
		try {
			this.finder?.destroy();
		} catch {
			// ignore cleanup errors
		}
		this.finder = null;
		this.initPromise = null;
	}

	private async initialize(): Promise<void> {
		try {
			const FileFinder = await loadFileFinderClass();
			if (!FileFinder) {
				this.loadError = "Could not load FileFinder";
				return;
			}
			const created = FileFinder.create({ basePath: this.cwd, aiMode: true });
			if (!created.ok) {
				this.loadError = created.error;
				return;
			}
			this.finder = created.value;
			try {
				this.finder.waitForScan?.(500);
			} catch {
				// best effort warmup
			}
		} catch (error) {
			this.loadError = error instanceof Error ? error.message : String(error);
		}
	}
}

let cachedFileFinderClass: Promise<FileFinderClass | null> | null = null;

async function loadFileFinderClass(): Promise<FileFinderClass | null> {
	if (!cachedFileFinderClass) {
		cachedFileFinderClass = (async () => {
			try {
				const mod = await import("@ff-labs/fff-node");
				if (mod?.FileFinder) return mod.FileFinder as FileFinderClass;
			} catch {
				return null;
			}

			return null;
		})();
	}
	return cachedFileFinderClass;
}

function findLastDelimiter(text: string): number {
	for (let i = text.length - 1; i >= 0; i -= 1) {
		if (PATH_DELIMITERS.has(text[i] ?? "")) return i;
	}
	return -1;
}

function isTokenStart(text: string, index: number): boolean {
	return index === 0 || PATH_DELIMITERS.has(text[index - 1] ?? "");
}

function findUnclosedQuoteStart(text: string): number | null {
	let inQuotes = false;
	let quoteStart = -1;
	for (let i = 0; i < text.length; i += 1) {
		if (text[i] === '"') {
			inQuotes = !inQuotes;
			if (inQuotes) quoteStart = i;
		}
	}
	return inQuotes ? quoteStart : null;
}

function extractAtPrefix(text: string): string | null {
	const quoteStart = findUnclosedQuoteStart(text);
	if (quoteStart !== null && quoteStart > 0 && text[quoteStart - 1] === "@" && isTokenStart(text, quoteStart - 1)) {
		return text.slice(quoteStart - 1);
	}

	const lastDelimiterIndex = findLastDelimiter(text);
	const tokenStart = lastDelimiterIndex === -1 ? 0 : lastDelimiterIndex + 1;
	if (text[tokenStart] === "@") {
		return text.slice(tokenStart);
	}
	return null;
}

function parseAtPrefix(prefix: string): { rawQuery: string; isQuotedPrefix: boolean } {
	if (prefix.startsWith('@"')) return { rawQuery: prefix.slice(2), isQuotedPrefix: true };
	return { rawQuery: prefix.slice(1), isQuotedPrefix: false };
}

function toSuggestion(item: FffSearchItem, isQuotedPrefix: boolean): AutocompleteItem {
	const relativePath = item.relativePath.replace(/\\/g, "/");
	const needsQuotes = isQuotedPrefix || relativePath.includes(" ");
	const value = needsQuotes ? `@"${relativePath}"` : `@${relativePath}`;
	return {
		value,
		label: item.fileName ?? relativePath.split("/").pop() ?? relativePath,
		description: relativePath,
	};
}

class FffAtAutocompleteProvider implements AutocompleteProvider {
	constructor(
		private readonly baseProvider: AutocompleteProvider,
		private readonly runtime: FinderRuntime,
	) {}

	async getSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		options: { signal: AbortSignal; force?: boolean },
	): Promise<AutocompleteSuggestions | null> {
		const currentLine = lines[cursorLine] ?? "";
		const textBeforeCursor = currentLine.slice(0, cursorCol);
		const atPrefix = extractAtPrefix(textBeforeCursor);
		if (!atPrefix) return this.baseProvider.getSuggestions(lines, cursorLine, cursorCol, options);
		if (options.signal.aborted) return null;

		const finder = await this.runtime.ensure();
		if (!finder || options.signal.aborted) {
			return this.baseProvider.getSuggestions(lines, cursorLine, cursorCol, options);
		}

		const { rawQuery, isQuotedPrefix } = parseAtPrefix(atPrefix);
		const search = finder.fileSearch(rawQuery, { pageSize: MAX_RESULTS });
		if (!search.ok) {
			return this.baseProvider.getSuggestions(lines, cursorLine, cursorCol, options);
		}

		const items = search.value.items.slice(0, MAX_RESULTS).map((item) => toSuggestion(item, isQuotedPrefix));
		if (items.length === 0) return null;
		return { items, prefix: atPrefix };
	}

	applyCompletion(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		item: AutocompleteItem,
		prefix: string,
	): { lines: string[]; cursorLine: number; cursorCol: number } {
		return this.baseProvider.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
	}

	shouldTriggerFileCompletion?(lines: string[], cursorLine: number, cursorCol: number): boolean {
		const candidate = this.baseProvider as AutocompleteProvider & {
			shouldTriggerFileCompletion?: (l: string[], line: number, col: number) => boolean;
		};
		return candidate.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
	}
}

class FffEditor extends CustomEditor {
	constructor(
		tui: TUI,
		theme: EditorTheme,
		keybindings: KeybindingsManager,
		private readonly runtime: FinderRuntime,
	) {
		super(tui, theme, keybindings);
	}

	override setAutocompleteProvider(provider: AutocompleteProvider): void {
		super.setAutocompleteProvider(new FffAtAutocompleteProvider(provider, this.runtime));
	}
}

export default function (pi: ExtensionAPI) {
	let runtime: FinderRuntime | null = null;

	pi.on("session_start", async (_event, ctx) => {
		runtime?.dispose();
		runtime = new FinderRuntime(ctx.cwd);
		void runtime.ensure();

		ctx.ui.setEditorComponent((tui, theme, keybindings) => new FffEditor(tui, theme, keybindings, runtime!));
		ctx.ui.notify("fff @-autocomplete enabled", "info");
	});

	pi.on("session_shutdown", async () => {
		runtime?.dispose();
		runtime = null;
	});
}

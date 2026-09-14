/**
 * compact-ui: merge thinking + tool calls into a single tree-shaped block.
 *
 * Tool calls are intercepted at the container-prototype level (like
 * pi-cc-extensions) and collected into a ToolGroupComponent rendered in place
 * in the transcript. Thinking text is captured from message_update events and
 * merged into the same block.
 *
 * Collapsed (max 3 lines by default, configurable):
 *   ⠋ tool calling...
 *   │  ✓ bash: ls /tmp && cat fi... (3s)
 *   └  · thinking: Planning... · ≈1.2K tok
 *
 * Ctrl+O toggles collapse/expand (via setExpanded, same as built-in tools).
 * Expand line counts are configurable via /compact-config (interactive
 * settings menu, arrows to select, Enter to adjust, Esc to close) and are
 * persisted to ~/.pi/agent/compact-ui.json:
 *   { "collapsedMaxLines": 3, "expandedToolLines": 5, "expandedThinkingLines": 10 }
 */

import type { ExtensionAPI, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import {
	AssistantMessageComponent,
	CompactionSummaryMessageComponent,
	ToolExecutionComponent,
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
	getMarkdownTheme,
	getSettingsListTheme,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	Key,
	Markdown,
	SettingsList,
	Spacer,
	Text,
	getCapabilities,
	hyperlink,
	matchesKey,
	stripTerminalSequences,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { Component, DefaultTextStyle, MarkdownTheme, SettingItem } from "@earendil-works/pi-tui";
import { readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { isAbsolute, join, resolve } from "path";
import { pathToFileURL } from "node:url";

// =============================================================================
// Config
// =============================================================================
const CONFIG_PATH = join(homedir(), ".pi", "agent", "compact-ui.json");
interface CompactUiConfig {
	collapsedMaxLines: number;
	expandedToolLines: number;
	expandedThinkingLines: number;
	standaloneTools?: string[];
}

const DEFAULT_CONFIG: CompactUiConfig = {
	collapsedMaxLines: 3,
	expandedToolLines: 5,
	expandedThinkingLines: 10,
	standaloneTools: ["compress", "acp_delegate", "acp_delegate_wait", "subagent"],
};
let config: CompactUiConfig = { ...DEFAULT_CONFIG };
try {
	const loaded = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
	config = {
		...DEFAULT_CONFIG,
		...loaded,
		standaloneTools: Array.isArray(loaded.standaloneTools)
			? loaded.standaloneTools
			: DEFAULT_CONFIG.standaloneTools,
	};
} catch {
	// first run — use defaults
}

function saveConfig(): void {
	try {
		writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
	} catch {
		// ignore
	}
}

// Interactive editor metadata for each numeric option.
const CONFIG_KEYS = [
	{
		id: "collapsedMaxLines",
		label: "Collapsed max lines",
		description: "Max lines shown when a tool group is collapsed",
		min: 2,
		max: 20,
		step: 1,
	},
	{
		id: "expandedToolLines",
		label: "Expanded tool lines",
		description: "Result lines shown per tool when expanded",
		min: 1,
		max: 50,
		step: 1,
	},
	{
		id: "expandedThinkingLines",
		label: "Expanded thinking lines",
		description: "Thinking lines shown when expanded",
		min: 1,
		max: 100,
		step: 1,
	},
] as const;

// Numeric stepper submenu: ◀/▶ (or −/+) adjust the value, Enter saves, Esc
// cancels. `done(undefined)` means "no change".
function makeStepper(
	title: string,
	initial: number,
	meta: { min: number; max: number; step: number },
	theme: any,
	done: (value?: string) => void,
): Component {
	let value = initial;
	let cachedWidth: number | undefined;
	let cachedLines: string[] | undefined;
	const fg = (color: string, t: string) => theme?.fg?.(color, t) ?? t;

	return {
		render(width: number): string[] {
			if (cachedLines && cachedWidth === width) return cachedLines;
			const barLen = Math.max(1, Math.min(width - 10, 40));
			const ratio = (value - meta.min) / Math.max(1, meta.max - meta.min);
			const filled = Math.round(ratio * barLen);
			const bar = "█".repeat(filled) + "░".repeat(Math.max(0, barLen - filled));
			const titleText = theme?.bold ? theme.bold(title) : title;
			cachedLines = [
				fg("accent", titleText),
				"",
				`  ${fg("accent", String(value))}`,
				`  ${fg("muted", bar)}`,
				"",
				fg("dim", "  ◀ ▶ / − +  adjust    Enter  save    Esc  cancel"),
			].map((line) => truncateToWidth(line, Math.max(1, width)));
			cachedWidth = width;
			return cachedLines;
		},
		handleInput(data: string): void {
			if (matchesKey(data, Key.left) || matchesKey(data, Key.down) || data === "-" || data === "_") {
				value = Math.max(meta.min, value - meta.step);
			} else if (matchesKey(data, Key.right) || matchesKey(data, Key.up) || data === "+" || data === "=") {
				value = Math.min(meta.max, value + meta.step);
			} else if (matchesKey(data, Key.enter) || matchesKey(data, Key.space)) {
				done(String(value));
				return;
			} else if (matchesKey(data, Key.escape)) {
				done(undefined);
				return;
			}
			cachedWidth = undefined;
		},
		invalidate(): void {
			cachedWidth = undefined;
		},
	};
}

// =============================================================================
// Shared state
// =============================================================================
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
// 100ms/frame (10fps) matches pi's default spinner cadence; 300ms felt laggy.
const SPINNER_MS = 100;
const GROUP_PADDING_X = 1;
const spinnerStart = Date.now();
const PARENT_KEY = Symbol.for("compact-ui.group-parent");
const PATCH_KEY = Symbol.for("compact-ui.group-patch");
const MARKDOWN_RENDER_PATCH_KEY = Symbol.for("compact-ui.markdown-render-patch");
const COMPACTION_STYLE_PATCH_KEY = Symbol.for("compact-ui.compaction-style-patch");
const ASSISTANT_THINKING_PATCH_KEY = Symbol.for("compact-ui.assistant-thinking-patch");

let currentTheme: any = null;
let thinkingActive = false;
let thinkingStartedAt: number | undefined;
let thinkingElapsedMs = 0;
let thinkingTimingKnown = false;
let thinkingText = "";
// Most providers report reasoning usage only when the response finishes. While
// streaming, fall back to pi's own chars/4 token heuristic and mark it with ≈.
let thinkingTokenCount = 0;
let thinkingTokenCountExact = false;
// message_update contains a cumulative AssistantMessage snapshot. Track stream
// content indexes so growing text deltas seal a block only once.
const handledTextIndexes = new Set<number>();
const thinkingBlocks = new Map<number, string>();
let assistantThinkingStarted = false;
let pendingTextSeal = false;
let pendingTextOrdinal: number | null = null;
let lastActiveGroup: ToolGroupComponent | null = null;
// Track the current assistant message's component + the container it lives in,
// so a thinking-only group can be inserted right after it (before any tool).
let lastStreamingComp: any = null;
let lastChatContainer: any = null;
const toolStarts = new Map<string, number>();
const toolEnds = new Map<string, number>();
// Wall-clock start of the current turn (user message), used to render the
// "worked for Xm Ys" divider before the final visible text.
let turnStartMs = 0;

// =============================================================================
// Tool summary helpers
// =============================================================================
function shortenPath(path: string): string {
	const home = homedir();
	return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

function oneLine(value: unknown, max = 60): string {
	const text = String(value ?? "").replace(/\s+/g, " ").trim();
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function resetThinking(): void {
	thinkingActive = false;
	thinkingText = "";
	thinkingElapsedMs = 0;
	thinkingTimingKnown = false;
	thinkingStartedAt = undefined;
	thinkingTokenCount = 0;
	thinkingTokenCountExact = false;
	thinkingBlocks.clear();
	assistantThinkingStarted = false;
}

function stopThinking(): void {
	if (thinkingStartedAt !== undefined) thinkingElapsedMs += Date.now() - thinkingStartedAt;
	thinkingStartedAt = undefined;
	thinkingActive = false;
}

function thinkingDuration(): number | undefined {
	if (!thinkingTimingKnown) return undefined;
	return thinkingElapsedMs + (thinkingStartedAt === undefined ? 0 : Date.now() - thinkingStartedAt);
}

function estimateTextTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

function formatTokenK(tokens: number): string {
	if (tokens <= 0) return "0.0K";
	if (tokens < 100) return "<0.1K";
	const value = tokens / 1000;
	return value < 100 ? `${value.toFixed(1)}K` : `${Math.round(value)}K`;
}

function updateThinkingTokenCount(message: any): void {
	const reported = Number(message?.usage?.reasoning);
	if (Number.isFinite(reported) && reported > 0) {
		thinkingTokenCount = reported;
		thinkingTokenCountExact = true;
		return;
	}
	thinkingTokenCount = estimateTextTokens(thinkingText);
	thinkingTokenCountExact = false;
}

function toolSummary(name: string, args: any): { name: string; content: string } {
	switch (name) {
		case "bash":
			return { name: "bash", content: oneLine(args?.command || "…") };
		case "read":
			return { name: "read", content: shortenPath(args?.path || "…") };
		case "write":
		case "edit":
			return { name, content: shortenPath(args?.path || "…") };
		case "find":
			return { name: "find", content: `${oneLine(args?.pattern || "")} in ${shortenPath(args?.path || ".")}` };
		case "grep":
			return { name: "grep", content: `${oneLine(args?.pattern || "")} in ${shortenPath(args?.path || ".")}` };
		case "ls":
			return { name: "ls", content: shortenPath(args?.path || ".") };
		case "web_search":
			return { name: "web_search", content: oneLine(args?.query || (Array.isArray(args?.queries) ? args.queries.join("; ") : "") || "…") };
		case "acp_delegate": {
			const agent = args?.agent ? `[${args.agent}]` : "";
			const task = args?.task ? `"${oneLine(args.task, 60)}"` : (args?.resumeFrom ? `resume ${args.resumeFrom}` : "…");
			return { name: `⚡ delegate${agent}`, content: task };
		}
		case "acp_delegate_wait":
			return { name: "⚡ delegate_wait", content: oneLine(args?.runId || "…") };
		case "acp_delegate_cancel":
			return { name: "⚡ delegate_cancel", content: oneLine(args?.runId || "…") };
		case "subagent": {
			const agent = args?.agent ? `[${args.agent}]` : "";
			const task = args?.task ? `"${oneLine(args.task, 60)}"` : (args?.agent || "…");
			return { name: `⚡ subagent${agent}`, content: task };
		}
		default: {
			const preferred = args?.path ?? args?.query ?? args?.name ?? args?.description ?? args?.url;
			return { name, content: oneLine(preferred ?? "…") };
		}
	}
}

type ToolStatus = "pending" | "success" | "error";
function toolStatus(tool: any): ToolStatus {
	if (tool?.isPartial === true || (tool?.executionStarted && !tool?.result)) return "pending";
	if (tool?.result?.isError) return "error";
	return tool?.result ? "success" : "pending";
}

type ToolResultSummary = {
	isError?: boolean;
	details?: unknown;
	content?: { type: string; text?: string }[];
};

export function getToolExecutionPhase(details: unknown): string | undefined {
	if (!details || typeof details !== "object") return undefined;
	const data = details as Record<string, unknown>;
	if (typeof data.phase !== "string" || !data.phase.trim()) return undefined;
	const phase = oneLine(stripTerminalSequences(data.phase));
	const query = typeof data.currentQuery === "string" ? oneLine(stripTerminalSequences(data.currentQuery)) : "";
	const progress = typeof data.progress === "string" ? oneLine(stripTerminalSequences(data.progress)) : "";
	switch (phase) {
		case "searching": return query ? `searching: "${query}"` : "searching";
		case "generating": return "generating summary";
		case "waiting_approval": return "waiting approval";
		case "downloading": return progress ? `downloading: ${progress}` : "downloading";
		default: return phase.replace(/[-_]+/g, " ").toLowerCase();
	}
}

export function extractFailureReason(result: ToolResultSummary | undefined): string | undefined {
	if (!result?.isError) return undefined;
	const details = result.details && typeof result.details === "object" ? result.details as Record<string, unknown> : {};
	const error = details.error;
	const message = typeof error === "string" ? error : error && typeof error === "object" && "message" in error ? error.message : undefined;
	if (typeof message === "string" && message.trim()) return oneLine(stripTerminalSequences(message), 500);
	const lines = (result.content ?? [])
		.filter((item) => item.type === "text" && typeof item.text === "string")
		.flatMap((item) => stripTerminalSequences(item.text!).split(/\r?\n/))
		.map((line) => line.trim())
		.filter(Boolean);
	// Select a cause only after the result has explicitly reported failure.
	const cause = lines.find((line) => !/^(?:>|failed with \d+ errors?$)/i.test(line) && (/(?:\berror(?:\s+TS\d+)?\s*:|\b[A-Za-z]*Error\s*:|permission denied|no such file|not found|timed? out|\bfailed at\b)/i.test(line) || /\bE[A-Z]{2,}\b/.test(line)));
	if (cause) return cause;
	return lines.find((line) => !/^(?:>|at\s|command failed:?$|failed with \d+ errors?$)/i.test(line)) ?? lines[0];
}

function localPath(value: unknown, cwd?: string): string | undefined {
	if (typeof value !== "string" || !value.trim() || /[\x00-\x1f\x7f-\x9f]/.test(value) || /^[a-z][a-z\d+.-]*:/i.test(value)) return undefined;
	if (isAbsolute(value)) return value;
	if (!cwd || !isAbsolute(cwd) || /[\x00-\x1f\x7f-\x9f]/.test(cwd)) return undefined;
	return resolve(cwd, value);
}

export function linkErrorLocation(row: string, cwd?: string): string {
	if (!getCapabilities().hyperlinks) return row;
	const text = stripTerminalSequences(row);
	// Restrict links to leading diagnostic locations, rather than guessing paths in prose.
	const match = text.match(/^\s*([^<>:"|?*\x00-\x1f]+?)(\([1-9]\d*(?:,[1-9]\d*)?\)|:[1-9]\d*(?::[1-9]\d*)?)(?=[:\s)]|$)/);
	if (!match) return row;
	if (!match[2].startsWith("(") && !/^:\d+:\d+$/.test(match[2]) && text[match[0].length] !== ":") return row;
	const path = match[1].trim();
	if (!isAbsolute(path) && !path.startsWith("./") && !path.startsWith("../") && /\s/.test(path.split("/")[0])) return row;
	if (!isAbsolute(path) && !path.includes("/") && !/\.[a-z\d]+$/i.test(path)) return row;
	const target = localPath(path, cwd);
	const label = `${path}${match[2]}`;
	if (!target || !row.includes(label)) return row;
	return row.replace(label, hyperlink(label, pathToFileURL(target).href));
}

export function fullOutputEntry(name: string, details: unknown, cwd?: string): string | undefined {
	if (name !== "bash" || !details || typeof details !== "object" || !("fullOutputPath" in details)) return undefined;
	const path = localPath(details.fullOutputPath, cwd);
	if (!path) return undefined;
	const label = shortenPath(path);
	return `Full output: ${getCapabilities().hyperlinks ? hyperlink(label, pathToFileURL(path).href) : label}`;
}

export function delegateOutputEntry(name: string, details: unknown, text?: string, cwd?: string): string | undefined {
	if (!name.startsWith("acp_delegate") && name !== "subagent") return undefined;
	let pathVal: string | undefined;
	if (details && typeof details === "object") {
		const data = details as Record<string, unknown>;
		if (typeof data.outputFile === "string") pathVal = data.outputFile;
		else if (typeof data.outputPath === "string") pathVal = data.outputPath;
		else if (typeof data.resultFile === "string") pathVal = data.resultFile;
	}
	if (!pathVal && text) {
		const match = text.match(/(?:output(?:\s+is)?(?:\s+at)?|(?:result|output)\s+written\s+to|Output:)\s*[`'"]?(\/[^`'"\s\n]+)[`'"]?/i);
		if (match) pathVal = match[1];
	}
	if (!pathVal) return undefined;
	const path = localPath(pathVal, cwd);
	if (!path) return undefined;
	const label = shortenPath(path);
	return `Delegate output: ${getCapabilities().hyperlinks ? hyperlink(label, pathToFileURL(path).href) : label}`;
}

export function renderEditDiff(
	diff: unknown,
	width: number,
	maxLines: number,
	theme: Pick<Theme, "fg"> | null,
): { lines: string[]; truncated: boolean } | undefined {
	if (typeof diff !== "string" || !diff.trim()) return undefined;
	const rows = diff.split(/\r?\n/);
	if (!rows.some((line) => /^[+-](?![+-]{2})/.test(line))) return undefined;
	const limit = Math.max(1, maxLines);
	const lines = rows.slice(0, limit).map((row) => {
		const color: ThemeColor = row.startsWith("+") && !row.startsWith("+++") ? "toolDiffAdded"
			: row.startsWith("-") && !row.startsWith("---") ? "toolDiffRemoved" : "toolDiffContext";
		const text = stripTerminalSequences(row).replace(/\t/g, "   ");
		return truncateToWidth(theme?.fg?.(color, text) ?? text, Math.max(1, width), "…");
	});
	return { lines, truncated: rows.length > limit };
}

export type AggregatedItem<T> =
	| { type: "tool"; tool: T }
	| { type: "aggregate"; name: string; tools: T[]; count: number; distinctCount?: number; distinctUnit?: string };

export function aggregateConsecutiveTools<T>(
	tools: readonly T[],
	getToolName: (tool: T) => string,
	getStatus: (tool: T) => ToolStatus,
	getArgs: (tool: T) => unknown,
): AggregatedItem<T>[] {
	const items: AggregatedItem<T>[] = [];
	for (let start = 0; start < tools.length;) {
		const tool = tools[start]!;
		const name = getToolName(tool);
		let end = start + 1;
		if (getStatus(tool) === "success" && !config.standaloneTools?.includes(name)) {
			while (end < tools.length && getToolName(tools[end]!) === name && getStatus(tools[end]!) === "success") end++;
		}
		if (end === start + 1) {
			items.push({ type: "tool", tool });
		} else {
			const run = tools.slice(start, end);
			const paths = run.map((item) => {
				const args = getArgs(item);
				return args && typeof args === "object" && "path" in args && typeof args.path === "string" && args.path ? args.path : undefined;
			});
			const files = ["read", "write", "edit"].includes(name) && paths.every((path) => path !== undefined);
			const searches = ["grep", "find", "zvec_grep_search", "web_search"].includes(name);
			items.push({
				type: "aggregate", name, tools: run, count: run.length,
				distinctCount: files ? new Set(paths).size : searches ? run.length : undefined,
				distinctUnit: files ? "files" : searches ? "searches" : undefined,
			});
		}
		start = end;
	}
	return items;
}

export function selectCollapsedItems<T>(items: AggregatedItem<T>[], getStatus: (tool: T) => ToolStatus, maxLines: number, hasThinking: boolean): { items: AggregatedItem<T>[]; showThinking: boolean } {
	const capacity = Math.max(1, maxLines - 1);
	const selected: AggregatedItem<T>[] = [];
	const failed = items.find((item) => item.type === "tool" && getStatus(item.tool) === "error");
	const pending = items.findLast((item) => item.type === "tool" && getStatus(item.tool) === "pending");
	if (failed) selected.push(failed);
	if (pending && selected.length < capacity) selected.push(pending);
	const showThinking = hasThinking && capacity > selected.length && (selected.length > 0 || capacity > 1 || items.length === 0);
	for (const item of items.slice().reverse()) {
		if (selected.length >= capacity - Number(showThinking)) break;
		if (!selected.includes(item)) selected.push(item);
	}
	return { items: selected, showThinking };
}

function aggregateLabel<T>(item: Extract<AggregatedItem<T>, { type: "aggregate" }>): string {
	const count = item.distinctCount ?? item.count;
	const unit = item.distinctUnit ?? "calls";
	return `${count} ${count === 1 ? unit === "searches" ? "search" : unit.slice(0, -1) : unit}`;
}

function resultSummary(name: string, result?: ToolResultSummary, partial = false): string {
	if (!result || partial) return "";
	const data = result.details && typeof result.details === "object" ? result.details as Record<string, unknown> : {};
	const texts = result.content?.filter((item) => item.type === "text" && typeof item.text === "string");
	const text = texts?.map((item) => item.text).join("\n");
	const truncation = data.truncation as { outputLines?: unknown; truncated?: boolean } | undefined;
	const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
	if (name === "bash") {
		if (typeof data.exitCode === "number" && Number.isSafeInteger(data.exitCode)) return `exit ${data.exitCode}`;
		const status = result.isError ? text?.match(/(?:^|\n\n)Command exited with code (-?\d+)(?![\s\S])/) : undefined;
		const code = status ? Number(status[1]) : undefined;
		return code !== undefined && Number.isSafeInteger(code) && code !== 0 ? `exit ${code}` : "";
	}
	if (result.isError) return "";
	if (name === "read") {
		if (result.content?.some((item) => item.type === "image") || /^Read image file \[image\/[^\]\n]+\](?:\n|$)/.test(text ?? "")) return "";
		if (count(truncation?.outputLines)) return `${truncation.outputLines} lines shown`;
		if (count(data.lineCount)) return `${data.lineCount} lines`;
		if (!texts?.length || text === undefined) return "";
		if (/^\[Line \d+ is [^\n]+, exceeds [^\n]+ limit\. Use bash: [^\n]+\](?![\s\S])/.test(text)) return "";
		const displayed = text.replace(/\n\n\[\d+ more lines in file\. Use offset=\d+ to continue\.\](?![\s\S])/, "");
		return `${displayed.split("\n").length} lines shown`;
	}
	if (name === "edit" && typeof data.diff === "string") {
		const rows = data.diff.split("\n");
		const added = rows.filter((row) => /^\+\s*\d+ /.test(row)).length;
		const removed = rows.filter((row) => /^-\s*\d+ /.test(row)).length;
		if (added || removed) return `+${added}/-${removed}`;
	}
	if (name === "grep") {
		if (count(data.matchLimitReached)) return `≥${data.matchLimitReached} matches`;
		if (count(data.matchCount)) return `${data.matchCount} matches`;
		if (text === "No matches found") return "0 matches";
		const matches = new Set<string>();
		for (const row of text?.split("\n") ?? []) {
			const match = row.match(/^(.+?)(?::([1-9]\d*): |-[1-9]\d*- )/);
			if (match?.[2]) matches.add(`${match[1]}:${match[2]}`);
		}
		if (matches.size) return `${matches.size} matches${truncation?.truncated ? " shown" : ""}`;
	}
	if (name === "web_search") {
		if (count(data.totalResults)) return `${data.totalResults} results`;
		if (count(data.resultCount)) return `${data.resultCount} results`;
		if (Array.isArray(data.results)) return `${data.results.length} results`;
	}
	if (name === "acp_delegate" || name === "subagent") {
		if (typeof data.exitCode === "number") return `exit ${data.exitCode}`;
		const exitMatch = text?.match(/\bexit\s+(-?\d+)\b/i);
		if (exitMatch) return `exit ${exitMatch[1]}`;
		if (data.status === "running" || text?.includes("Dispatched delegate") || text?.includes("running in the background")) {
			return data.runId ? `dispatched (${data.runId})` : "dispatched";
		}
		if (text?.includes("Completed delegate") || data.status === "completed") return "completed";
		return "";
	}
	if (name === "acp_delegate_wait") {
		if (typeof data.exitCode === "number") return `exit ${data.exitCode}`;
		const exitMatch = text?.match(/\bexit\s+(-?\d+)\b/i);
		if (exitMatch) return `exit ${exitMatch[1]}`;
		if (text?.includes("result not ready") || text?.includes("not ready")) return "not ready";
		if (text?.includes("Completed delegate") || data.status === "completed") return "completed";
		return "";
	}
	if (name === "acp_delegate_cancel") {
		return "cancelled";
	}
	return "";
}

type GroupTool = { status: ToolStatus; startedAt?: number; endedAt?: number };

function groupHeader(tools: GroupTool[], thinking: boolean, frame: string, fg: (color: string, text: string) => string): string {
	const pending = tools.some((tool) => tool.status === "pending");
	const failed = tools.filter((tool) => tool.status === "error").length;
	const working = pending || thinking;
	const color = failed ? "error" : pending ? "accent" : thinking ? "thinkingText" : "success";
	const label = pending ? "tool calling..." : thinking ? "thinking..." : "tools done";
	let detail = tools.length ? ` · ${tools.length} ${tools.length === 1 ? "tool" : "tools"}` : "";
	if (failed) detail += ` · ${failed} failed`;
	if (tools.length && !working) {
		const known = tools.every((tool) => tool.startedAt !== undefined && tool.endedAt !== undefined && tool.endedAt >= tool.startedAt);
		const elapsed = known ? ((Math.max(...tools.map((tool) => tool.endedAt!)) - Math.min(...tools.map((tool) => tool.startedAt!))) / 1000).toFixed(1) : "—";
		detail += ` · ${elapsed}s`;
	}
	return fg(color, `${working ? frame : failed ? "✗" : "✓"} ${label}${detail}`);
}

function toolElapsed(tool: any): string {
	const start = toolStarts.get(tool?.toolCallId);
	if (start === undefined) return "—";
	const pending = tool?.isPartial === true || !tool?.result;
	const end = toolEnds.get(tool?.toolCallId) ?? (pending ? Date.now() : undefined);
	if (end === undefined) return "—";
	return ((end - start) / 1000).toFixed(1);
}

function toolResultText(tool: any): string {
	return (tool?.result?.content ?? [])
		.filter((c: any) => c.type === "text")
		.map((c: any) => String(c.text))
		.join("\n")
		.trim();
}

type MarkdownPreview = {
	source: string;
	width: number;
	maxLines: number;
	lines: string[];
	truncated: boolean;
};

// Compact code fence markers are exactly "┌─" or "┌─ <language>", and the
// close row is exactly "└─". Markdown tables reuse the same box-drawing
// prefix ("┌─────┬──────┐") and must not enter code-block mode.
function isCompactCodeBlockOpen(visible: string): boolean {
	return visible === "┌─" || visible.startsWith("┌─ ");
}

function isCompactCodeBlockClose(visible: string): boolean {
	return visible === "└─";
}

// Pi's Markdown component normally renders fenced code blocks with literal
// ``` delimiters. Emit lightweight internal markers here; the normalization
// pass replaces them with a padded, theme-aware background block while
// retaining syntax highlighting.
export function getCompactMarkdownTheme(): MarkdownTheme {
	const base = getMarkdownTheme();
	let insideCodeBlock = false;
	const theme: MarkdownTheme = {
		...base,
		codeBlockIndent: "",
		codeBlockBorder(text: string): string {
			const opening = !insideCodeBlock;
			insideCodeBlock = !insideCodeBlock;
			const language = opening ? text.replace(/^```/, "").trim() : "";
			if (opening) {
				theme.codeBlockIndent = "";
			}
			const border = opening ? `┌─${language ? ` ${language}` : ""}` : "└─";
			return base.codeBlockBorder(border);
		},
	};
	return theme;
}

const CODE_BLOCK_PADDING_X = 1;

function renderCodeBlockBackgroundRow(content: string, width: number): string {
	const safeWidth = Math.max(1, width);
	const horizontalPadding = Math.min(CODE_BLOCK_PADDING_X, Math.floor((safeWidth - 1) / 2));
	const innerWidth = Math.max(1, safeWidth - horizontalPadding * 2);
	const clipped = truncateToWidth(content, innerWidth, "…");
	const rightFill = " ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)));
	const row = `${" ".repeat(horizontalPadding)}${clipped}${rightFill}${" ".repeat(horizontalPadding)}`;
	return currentTheme?.bg?.("toolPendingBg", row) ?? row;
}

export function normalizeCompactCodeBlockLines(lines: string[], width: number, paddingX = 0): string[] {
	const safeWidth = Math.max(1, width);
	const horizontalPadding = Math.max(0, Math.floor(paddingX));
	const leftPadding = " ".repeat(horizontalPadding);
	const contentWidth = Math.max(1, safeWidth - horizontalPadding * 2);
	const continuationWidth = contentWidth;
	const normalized: string[] = [];
	let codeBlockMode: "none" | "background" = "none";

	for (const originalLine of lines) {
		const withoutLeftPadding =
			leftPadding.length > 0 && originalLine.startsWith(leftPadding)
				? originalLine.slice(leftPadding.length)
				: originalLine;
		const content = withoutLeftPadding.trimEnd();
		const visible = stripTerminalSequences(content).trimStart();
		if (isCompactCodeBlockOpen(visible)) {
			codeBlockMode = "background";
			const language = visible.replace(/^┌─/, "").trim();
			if (language) {
				const label = currentTheme?.fg?.("muted", language) ?? language;
				normalized.push(`${leftPadding}${renderCodeBlockBackgroundRow(label, contentWidth)}`);
			}
			continue;
		}
		if (isCompactCodeBlockClose(visible)) {
			codeBlockMode = "none";
			continue;
		}
		if (codeBlockMode === "background") {
			const codeWidth = Math.max(1, continuationWidth - CODE_BLOCK_PADDING_X * 2);
			const wrappedRows = wrapTextWithAnsi(content, codeWidth);
			for (const wrapped of wrappedRows.length > 0 ? wrappedRows : [""]) {
				normalized.push(`${leftPadding}${renderCodeBlockBackgroundRow(wrapped, contentWidth)}`);
			}
			continue;
		}
		normalized.push(truncateToWidth(originalLine, safeWidth, "…"));
	}

	return normalized;
}

export type CompactExternalTool = {
	id: string;
	cwd?: string;
	name: string;
	args: any;
	status: ToolStatus;
	resultText: string;
	resultDetails?: unknown;
	startedAt: number;
	endedAt?: number;
};

export type CompactExternalGroup = {
	tools: CompactExternalTool[];
	thinking: string;
	thinkingActive: boolean;
	sealed: boolean;
	thinkingTokens?: number;
	thinkingTokensExact?: boolean;
	thinkingStartedAt?: number;
	thinkingEndedAt?: number;
};

/**
 * Isolated compact-ui renderer for secondary transcripts (for example a
 * subagent overlay). It deliberately owns no main-session globals while using
 * the same colors, rails, Markdown/code rendering, limits, and expansion
 * behavior as ToolGroupComponent.
 */
export class CompactExternalGroupComponent implements Component {
	private expanded = false;

	constructor(
		readonly state: CompactExternalGroup,
		private readonly theme: any,
	) {}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
	}

	invalidate(): void {}

	private icon(tool: CompactExternalTool, frame: string): string {
		return tool.status === "pending" ? frame : tool.status === "error" ? "✗" : "✓";
	}

	private color(tool: CompactExternalTool): string {
		return tool.status === "pending" ? "accent" : tool.status === "error" ? "error" : "success";
	}

	private elapsed(tool: CompactExternalTool): string {
		const end = tool.endedAt ?? (tool.status === "pending" ? Date.now() : undefined);
		if (end === undefined) return "—s";
		return `${Math.max(0, (end - tool.startedAt) / 1000).toFixed(1)}s`;
	}

	private toolRow(rail: string, tool: CompactExternalTool, frame: string, previewFailure = false): string {
		const fg = (color: string, text: string) => this.theme?.fg?.(color, text) ?? text;
		const bold = this.theme?.bold ? (text: string) => this.theme.bold(text) : (text: string) => text;
		const summary = toolSummary(tool.name, tool.args);
		const phase = tool.status === "pending" ? getToolExecutionPhase(tool.resultDetails) : undefined;
		if (phase) {
			summary.content = `${phase} · ${summary.content}`;
		} else {
			const stats = resultSummary(tool.name, {
				details: tool.resultDetails,
				isError: tool.status === "error",
				content: [{ type: "text", text: tool.resultText }],
			}, tool.status === "pending");
			if (stats) summary.content = summary.content ? `${summary.content} · ${stats}` : stats;
		}
		if (previewFailure && tool.status === "error") {
			const result = { isError: true, details: tool.resultDetails, content: [{ type: "text", text: tool.resultText }] };
			const reason = extractFailureReason(result);
			const stats = resultSummary(tool.name, result);
			if (reason) summary.content = `${reason}${stats ? ` · ${stats}` : ""}`;
		}
		const content = oneLine(summary.content, 500);
		const display = previewFailure && tool.status === "error" ? linkErrorLocation(content, tool.cwd) : content;
		return `${fg("dim", rail)}${fg(this.color(tool), this.icon(tool, frame))} ${fg("toolTitle", bold(summary.name))} ${fg(tool.status === "error" ? "error" : "dim", display)} ${fg("muted", `(${this.elapsed(tool)})`)}`;
	}

	private tokenLabel(): string {
		const tokens = this.state.thinkingTokens ?? estimateTextTokens(this.state.thinking);
		const end = this.state.thinkingEndedAt ?? (this.state.thinkingActive && !this.state.sealed ? Date.now() : undefined);
		const duration = this.state.thinkingStartedAt !== undefined && end !== undefined ? `${Math.max(0, (end - this.state.thinkingStartedAt) / 1000).toFixed(1)}s` : "—s";
		return `${this.state.thinkingTokensExact ? "" : "≈"}${formatTokenK(tokens)} tok · ${duration}`;
	}

	private markdownLines(source: string, width: number, maxLines: number, color: string, italic = false): string[] {
		if (!source.trim()) return [];
		const lineLimit = Math.max(1, maxLines);
		const sourceRows = source.split("\n");
		const bounded = sourceRows
			.slice(0, Math.max(lineLimit * 4, lineLimit + 20))
			.join("\n")
			.slice(0, Math.max(4096, lineLimit * Math.max(40, width) * 4));
		const markdown = new Markdown(bounded, 0, 0, getCompactMarkdownTheme(), {
			color: (text) => this.theme?.fg?.(color, text) ?? text,
			italic,
		});
		const rendered = normalizeCompactCodeBlockLines(markdown.render(Math.max(1, width)), Math.max(1, width));
		const lines = rendered.slice(0, lineLimit);
		if (rendered.length > lineLimit || bounded.length < source.length) {
			lines.push(this.theme?.fg?.("muted", "…") ?? "…");
		}
		return lines;
	}

	private renderCollapsed(width: number, frame: string): string[] {
		const fg = (color: string, text: string) => this.theme?.fg?.(color, text) ?? text;
		const bold = (text: string) => this.theme?.bold?.(text) ?? text;
		const lines = [groupHeader(this.state.tools, !this.state.sealed && (this.state.thinkingActive || this.state.tools.length === 0), frame, fg)];
		const thinking = this.state.thinking.trim().replace(/[*_#`>]+/g, "");
		const aggregated = aggregateConsecutiveTools(this.state.tools, (tool) => tool.name, (tool) => tool.status, (tool) => tool.args);
		const selection = selectCollapsedItems(aggregated, (tool) => tool.status, config.collapsedMaxLines, thinking.length > 0);
		for (const [index, item] of selection.items.entries()) {
			const rail = index === selection.items.length - 1 && !selection.showThinking ? "└  " : "│  ";
			lines.push(item.type === "aggregate"
				? `${fg("dim", rail)}${fg("success", "✓")} ${fg("toolTitle", bold(item.name))} ${fg("dim", `· ${aggregateLabel(item)}`)}`
				: this.toolRow(rail, item.tool, frame, true));
		}
		if (selection.showThinking) {
			const previewWidth = Math.max(1, Math.min(50, width - GROUP_PADDING_X - 18 - this.tokenLabel().length));
			lines.push(`${fg("dim", "└  ")}${fg("muted", "·")} ${fg("thinkingText", `thinking: ${oneLine(thinking, previewWidth)}`)} ${fg("muted", `· ${this.tokenLabel()}`)}`);
		}
		return lines;
	}

	private renderExpanded(width: number, frame: string): string[] {
		const fg = (color: string, text: string) => this.theme?.fg?.(color, text) ?? text;
		const lines = [groupHeader(this.state.tools, !this.state.sealed && (this.state.thinkingActive || this.state.tools.length === 0), frame, fg)];
		for (let index = 0; index < this.state.tools.length; index++) {
			const tool = this.state.tools[index]!;
			const last = index === this.state.tools.length - 1;
			const sub = last ? "    " : "│   ";
			lines.push(this.toolRow(last ? "└─ " : "├─ ", tool, frame));

			const subWidth = Math.max(1, width - GROUP_PADDING_X - sub.length);
			let diffRendered = false;
			if (tool.name === "edit" && tool.resultDetails && tool.status !== "error") {
				const editDiff = renderEditDiff((tool.resultDetails as Record<string, unknown>).diff, subWidth, config.expandedToolLines, this.theme);
				if (editDiff) {
					for (const row of editDiff.lines) {
						lines.push(`${fg("dim", sub)}${row}`);
					}
					if (editDiff.truncated) {
						lines.push(`${fg("dim", sub)}${fg("muted", "…")}`);
					}
					diffRendered = true;
				}
			}

			if (!diffRendered) {
				for (const row of this.markdownLines(
					tool.resultText,
					subWidth,
					config.expandedToolLines,
					"toolOutput",
				)) {
					lines.push(`${fg("dim", sub)}${tool.status === "error" ? linkErrorLocation(row, tool.cwd) : row}`);
				}
			}
			const fullOutput = fullOutputEntry(tool.name, tool.resultDetails, tool.cwd);
			if (fullOutput) lines.push(`${fg("dim", sub)}${fg("accent", fullOutput)}`);
			const delegateOutput = delegateOutputEntry(tool.name, tool.resultDetails, tool.resultText, tool.cwd);
			if (delegateOutput) lines.push(`${fg("dim", sub)}${fg("accent", delegateOutput)}`);
		}
		if (this.state.thinking.trim()) {
			lines.push(
				`${fg("dim", "└  ")}${fg("muted", "·")} ${fg("thinkingText", "thinking")} ${fg("muted", `· ${this.tokenLabel()}`)}`,
			);
			for (const row of this.markdownLines(
				this.state.thinking,
				Math.max(1, width - GROUP_PADDING_X - 4),
				config.expandedThinkingLines,
				"thinkingText",
				true,
			)) {
				lines.push(`${fg("dim", "    ")}${row}`);
			}
		}
		return lines;
	}

	render(width: number): string[] {
		const frame = SPINNER[Math.floor((Date.now() - spinnerStart) / SPINNER_MS) % SPINNER.length]!;
		const source = this.expanded ? this.renderExpanded(width, frame) : this.renderCollapsed(width, frame);
		const padding = " ".repeat(Math.min(GROUP_PADDING_X, Math.max(0, width - 1)));
		const contentWidth = Math.max(1, width - padding.length);
		return source.map((line) => padding + truncateToWidth(line, contentWidth, "…"));
	}
}

// AssistantMessageComponent already uses Markdown for visible final text, but
// pi's stock Markdown theme intentionally displays literal ``` fence rows.
// Replace only visible assistant Markdown instances with compact code borders;
// user/custom messages and hidden thinking Markdown retain their native theme.
function installVisibleAssistantMarkdownRendering(component: Markdown): void {
	const markdown = component as any;
	if (markdown[MARKDOWN_RENDER_PATCH_KEY]) return;
	markdown.theme = getCompactMarkdownTheme();
	const originalRender = markdown.render.bind(markdown);
	markdown.render = (width: number): string[] =>
		normalizeCompactCodeBlockLines(originalRender(width), width, Number(markdown.paddingX) || 0);
	markdown[MARKDOWN_RENDER_PATCH_KEY] = { originalRender };
	markdown.invalidate();
}

class CompactionHeaderComponent implements Component {
	constructor(private readonly tokensBefore: number) {}

	render(width: number): string[] {
		const theme = currentTheme;
		const fg = (color: string, text: string) => theme?.fg?.(color, text) ?? text;
		const exactTokens = Math.max(0, this.tokensBefore).toLocaleString();
		const icon = fg("success", "›‹");
		const title = fg("success", "Context compacted");
		const detail = fg("muted", ` • ${exactTokens} tokens → summary`);
		const full = `${icon} ${title}${detail}`;
		if (visibleWidth(full) <= width) return [full];

		const compactTitle = fg("success", "Compacted");
		const compactDetail = fg("muted", ` • ${formatTokenK(this.tokensBefore)} tok`);
		return [truncateToWidth(`${icon} ${compactTitle}${compactDetail}`, Math.max(1, width), "…")];
	}

	invalidate(): void {}
}

function installCompactionSummaryRendering(): void {
	const prototype = CompactionSummaryMessageComponent.prototype as any;
	const previous = prototype[COMPACTION_STYLE_PATCH_KEY] as
		| {
				original?: (this: any) => void;
				installed?: (this: any) => void;
				originalUpdateDisplay?: (this: any) => void;
				originalSetExpanded?: (this: any, expanded: boolean) => void;
				installedUpdateDisplay?: (this: any) => void;
				installedSetExpanded?: (this: any, expanded: boolean) => void;
		  }
		| undefined;
	// Replace the previous compact-ui closure on hot reload while retaining
	// pi's original renderer for a future replacement.
	const previousInstalledUpdate = previous?.installedUpdateDisplay ?? previous?.installed;
	const originalUpdateDisplay =
		previous && previousInstalledUpdate && prototype.updateDisplay === previousInstalledUpdate
			? (previous.originalUpdateDisplay ?? previous.original)!
			: (prototype.updateDisplay as (this: any) => void);
	const originalSetExpanded =
		previous?.installedSetExpanded && prototype.setExpanded === previous.installedSetExpanded
			? previous.originalSetExpanded!
			: (prototype.setExpanded as (this: any, expanded: boolean) => void);
	const installedUpdateDisplay = function (this: any): void {
		this.paddingX = GROUP_PADDING_X;
		this.paddingY = 0;
		this.setBgFn(undefined);
		this.clear();

		const tokensBefore = Number(this.message?.tokensBefore);
		const safeTokens = Number.isFinite(tokensBefore) && tokensBefore > 0 ? tokensBefore : 0;
		this.addChild(new CompactionHeaderComponent(safeTokens));
	};
	const installedSetExpanded = function (this: any, _expanded: boolean): void {
		// Context compaction is a static transcript event. Global Ctrl+O remains
		// available for compact thinking/tool groups but does not alter this row.
	};
	prototype.updateDisplay = installedUpdateDisplay;
	prototype.setExpanded = installedSetExpanded;
	prototype[COMPACTION_STYLE_PATCH_KEY] = {
		originalUpdateDisplay,
		originalSetExpanded,
		installedUpdateDisplay,
		installedSetExpanded,
	};
}

const TOOL_EXECUTION_PATCH_KEY = Symbol.for("pi-compact-ui.tool-execution-patch");
const TOOL_EXECUTION_INSTALLED_KEY = Symbol.for("pi-compact-ui.tool-execution-installed");

function parseCompressStats(firstLine: string): {
	beforeStr: string;
	afterStr: string;
	reclaimedStr: string;
	pct: number;
} | null {
	const match = firstLine.match(/([\d.]+\s*[KkMm]?)\s*→\s*([\d.]+\s*[KkMm]?)\s*tokens?\s*(?:\(~?([\d.]+\s*[KkMm]?)?\s*reclaimed)?/i);
	if (!match) return null;
	const beforeStr = match[1]?.trim() ?? "";
	const afterStr = match[2]?.trim() ?? "";
	let reclaimedStr = match[3]?.trim() ?? "";

	const parseTokens = (s: string) => {
		const m = s.match(/([\d.]+)\s*([KkMm]?)/i);
		if (!m) return 0;
		const n = parseFloat(m[1] ?? "0");
		const unit = (m[2] ?? "").toUpperCase();
		if (unit === "K") return n * 1000;
		if (unit === "M") return n * 1000000;
		return n;
	};

	const beforeNum = parseTokens(beforeStr);
	const afterNum = parseTokens(afterStr);
	let pct = 0;
	if (beforeNum > 0 && beforeNum >= afterNum) {
		pct = Math.round(((beforeNum - afterNum) / beforeNum) * 100);
		if (!reclaimedStr && beforeNum > afterNum) {
			const diff = beforeNum - afterNum;
			reclaimedStr = diff >= 1000 ? `${(diff / 1000).toFixed(1).replace(/\.0$/, "")}K` : `${diff}`;
		}
	}
	return { beforeStr, afterStr, reclaimedStr, pct };
}

function renderCompressRows(tool: any, width: number): string[] {
	const theme = currentTheme;
	const fg = (color: string, text: string) => theme?.fg?.(color, text) ?? text;
	const bold = theme?.bold ? theme.bold : (t: string) => t;
	const padding = " ".repeat(Math.min(GROUP_PADDING_X, Math.max(0, width - 1)));
	const contentWidth = Math.max(1, width - padding.length);

	const isPending = tool.isPartial === true || (tool.executionStarted && !tool.result);
	const frame = SPINNER[Math.floor((Date.now() - spinnerStart) / SPINNER_MS) % SPINNER.length]!;

	if (isPending) {
		scheduleAnimation();
		const line = `${fg("accent", frame)} ${fg("accent", bold("compress"))} ${fg("dim", "compressing context...")} ${fg("dim", "·")} ${fg("muted", `${toolElapsed(tool)}s`)}`;
		return ["", padding + truncateToWidth(line, contentWidth, "…")];
	}

	if (tool.result?.isError) {
		const line = `${fg("error", "✗")} ${fg("error", bold("compress"))} ${fg("error", "compression failed")} ${fg("dim", "·")} ${fg("muted", `${toolElapsed(tool)}s`)}`;
		return ["", padding + truncateToWidth(line, contentWidth, "…")];
	}

	const output = (tool.result?.content ?? [])
		.filter((c: any) => c.type === "text")
		.map((c: any) => String(c.text))
		.join("\n")
		.trim();

	const firstLine = output.split("\n")[0]?.trim() ?? "";
	const stats = parseCompressStats(firstLine);

	let statsFormatted = "";
	if (stats) {
		const transition = `${fg("dim", stats.beforeStr)} ${fg("dim", "→")} ${fg("syntaxKeyword", bold(stats.afterStr))}`;
		let savings = "";
		if (stats.reclaimedStr && stats.reclaimedStr !== "0") {
			const pctText = stats.pct > 0 ? ` / ${stats.pct}% saved` : "";
			savings = `  ${fg("success", bold(`(-${stats.reclaimedStr}${pctText})`))}`;
		} else if (stats.pct > 0) {
			savings = `  ${fg("success", bold(`(${stats.pct}% saved)`))}`;
		}
		statsFormatted = `${transition}${savings}`;
	} else {
		let statsSummary = "";
		const tokenMatch = firstLine.match(/(\d+(?:\.\d+)?[KkMmbB]?\s*→\s*\d+(?:\.\d+)?[KkMmbB]?\s*tokens?\s*(?:\(~[^)]+\))?)/i);
		if (tokenMatch) {
			statsSummary = tokenMatch[1].trim();
		} else {
			const pipeIdx = firstLine.indexOf("|");
			if (pipeIdx >= 0) {
				statsSummary = firstLine.slice(pipeIdx + 1).split(",")[0].trim();
			} else {
				statsSummary = firstLine.replace(/^▣\s*ACP\s*\|?\s*/i, "").trim() || "context compressed";
			}
		}
		statsFormatted = fg("toolTitle", statsSummary);
	}

	const singleLine = `${fg("success", "✓")} ${fg("accent", bold("compress"))}  ${statsFormatted}  ${fg("dim", "·")} ${fg("muted", `${toolElapsed(tool)}s`)}`;

	const lines: string[] = [];
	lines.push(padding + truncateToWidth(singleLine, contentWidth, "…"));

	// Additional output lines (e.g. excluded messages warning)
	const otherOutputLines = output.split("\n").slice(1).map((l) => l.trim()).filter(Boolean);
	for (const line of otherOutputLines) {
		lines.push(padding + "  " + fg("warning", truncateToWidth(line, contentWidth - 2, "…")));
	}

	// Detailed summary from args
	const contentArg = tool.args?.content;
	let ranges: any[] = [];
	if (Array.isArray(contentArg)) {
		ranges = contentArg;
	} else if (typeof contentArg === "string") {
		try {
			const parsed = JSON.parse(contentArg);
			if (Array.isArray(parsed)) ranges = parsed;
		} catch {}
	}

	if (ranges.length > 0) {
		for (const r of ranges) {
			const topic = r.topic ? `[${r.topic}] ` : "";
			const rangeRef = r.startId && r.endId ? `(${r.startId}..${r.endId})` : "";
			lines.push(padding + "  " + fg("accent", `▼ ${topic}${rangeRef}`));
			if (r.summary) {
				const summaryLines = String(r.summary).split("\n");
				const maxLines = Math.max(8, config.expandedToolLines * 3);
				for (const sLine of summaryLines.slice(0, maxLines)) {
					lines.push(padding + "    " + fg("dim", truncateToWidth(sLine, contentWidth - 4, "…")));
				}
				if (summaryLines.length > maxLines) {
					lines.push(padding + "    " + fg("muted", `… +${summaryLines.length - maxLines} more lines`));
				}
			}
		}
	}

	return ["", ...lines];
}

const DELEGATE_STANDALONE_TOOLS = new Set(["acp_delegate", "acp_delegate_wait", "acp_delegate_cancel", "subagent"]);

export function renderDelegateStandaloneRows(tool: any, width: number): string[] {
	const theme = currentTheme;
	const fg = (color: string, text: string) => theme?.fg?.(color, text) ?? text;
	const bold = theme?.bold ? theme.bold : (t: string) => t;
	const padding = "  ";
	const contentWidth = Math.max(1, width - padding.length);

	const isPending = tool.isPartial === true || (tool.executionStarted && !tool.result);
	const frame = SPINNER[Math.floor((Date.now() - spinnerStart) / SPINNER_MS) % SPINNER.length]!;
	if (isPending) {
		scheduleAnimation();
	}

	const toolName = tool.toolName || tool.name || "acp_delegate";
	let agentName = "";
	let taskSummary = "…";
	let fullTask = "";

	if (toolName === "acp_delegate" || toolName === "subagent") {
		if (tool.args?.agent) agentName = `[${tool.args.agent}]`;
		if (tool.args?.task) {
			fullTask = String(tool.args.task).trim();
			taskSummary = `"${oneLine(fullTask, Math.max(20, contentWidth - 40))}"`;
		} else if (tool.args?.resumeFrom) {
			taskSummary = `resume ${tool.args.resumeFrom}`;
		}
	} else if (toolName === "acp_delegate_wait") {
		taskSummary = tool.args?.runId ? `wait ${tool.args.runId}` : "wait";
	} else if (toolName === "acp_delegate_cancel") {
		taskSummary = tool.args?.runId ? `cancel ${tool.args.runId}` : "cancel";
	}

	const title = toolName === "subagent" ? `⚡ subagent${agentName}` : toolName.startsWith("acp_delegate_") ? `⚡ ${toolName.slice(4)}` : `⚡ delegate${agentName}`;
	const elapsed = `${toolElapsed(tool)}s`;
	const stats = resultSummary(toolName, tool.result, tool.isPartial);

	let singleLine = "";
	if (isPending) {
		singleLine = `${fg("accent", frame)} ${fg("accent", bold(title))}  ${fg("foreground", taskSummary)}  ${fg("muted", `(running · ${elapsed})`)}`;
	} else if (tool.result?.isError) {
		const statusText = stats || "failed";
		singleLine = `${fg("error", "✗")} ${fg("error", bold(title))}  ${fg("foreground", taskSummary)}  ${fg("dim", "·")} ${fg("error", statusText)}  ${fg("muted", `(${elapsed})`)}`;
	} else {
		const statsDisplay = stats ? `${fg("dim", "·")} ${fg("toolTitle", stats)}  ` : "";
		singleLine = `${fg("success", "✓")} ${fg("accent", bold(title))}  ${fg("foreground", taskSummary)}  ${statsDisplay}${fg("muted", `(${elapsed})`)}`;
	}

	const lines: string[] = [padding + truncateToWidth(singleLine, contentWidth, "…")];

	if (tool.expanded) {
		if (tool.result?.isError) {
			const reason = extractFailureReason(tool.result);
			if (reason) lines.push(padding + "  " + fg("error", truncateToWidth(reason, contentWidth - 2, "…")));
		}

		if (fullTask && fullTask.includes("\n")) {
			const taskLines = fullTask.split("\n");
			for (const tLine of taskLines.slice(0, 4)) {
				lines.push(padding + "  " + fg("dim", truncateToWidth(`> ${tLine}`, contentWidth - 4, "…")));
			}
			if (taskLines.length > 4) {
				lines.push(padding + "  " + fg("muted", `… +${taskLines.length - 4} more lines`));
			}
		}

		const outputEntry = delegateOutputEntry(toolName, tool.result?.details, toolResultText(tool), tool.cwd);
		if (outputEntry) {
			lines.push(padding + "  " + fg("accent", outputEntry));
		}

		const resultText = toolResultText(tool);
		if (resultText && !tool.result?.isError) {
			const previewLines = resultText.split("\n").filter((l: string) => !l.startsWith("Full result:") && !l.startsWith("Delegate **"));
			for (const line of previewLines.slice(0, config.expandedToolLines)) {
				lines.push(padding + "  " + fg("dim", truncateToWidth(line, contentWidth - 2, "…")));
			}
		}

		lines.push(padding + "  " + fg("muted", "(Ctrl+O to collapse)"));
	}

	return ["", ...lines];
}

function installToolExecutionCustomRendering(): void {
	const prototype = ToolExecutionComponent.prototype as any;
	prototype[TOOL_EXECUTION_PATCH_KEY] = renderCompressRows;
	if (prototype[TOOL_EXECUTION_INSTALLED_KEY]) return;
	const originalRender = prototype.render;
	prototype.render = function (this: any, width: number): string[] {
		if (this.toolName === "compress") {
			const handler = prototype[TOOL_EXECUTION_PATCH_KEY] || renderCompressRows;
			return handler(this, width);
		}
		if (DELEGATE_STANDALONE_TOOLS.has(this.toolName)) {
			return renderDelegateStandaloneRows(this, width);
		}
		return originalRender.call(this, width);
	};
	prototype[TOOL_EXECUTION_INSTALLED_KEY] = true;
}

/**
 * Pi's hidden-thinking mode still renders one Text component per thinking run.
 * Setting its label to "" hides the glyphs, but the Text itself still occupies
 * a terminal row and Pi may add adjacent Spacer components around it.
 *
 * compact-ui already renders thinking inside ToolGroupComponent, so remove
 * thinking blocks from the presentation-only message passed to Pi's native
 * AssistantMessageComponent. The original session/model message is untouched,
 * and visible text/tool-call ordering is preserved.
 */
function installNativeThinkingSuppression(): void {
	const prototype = AssistantMessageComponent.prototype as any;
	const previous = prototype[ASSISTANT_THINKING_PATCH_KEY] as
		| {
				originalUpdateContent: (this: any, message: any, isStreaming?: boolean) => void;
				installedUpdateContent: (this: any, message: any, isStreaming?: boolean) => void;
		  }
		| undefined;
	const originalUpdateContent =
		previous && prototype.updateContent === previous.installedUpdateContent
			? previous.originalUpdateContent
			: (prototype.updateContent as (this: any, message: any, isStreaming?: boolean) => void);
	const installedUpdateContent = function (this: any, message: any, isStreaming?: boolean): void {
		const content = Array.isArray(message?.content) ? message.content : undefined;
		if (!content?.some((item: any) => item?.type === "thinking")) {
			originalUpdateContent.call(this, message, isStreaming);
			return;
		}
		originalUpdateContent.call(
			this,
			{
				...message,
				content: content.filter((item: any) => item?.type !== "thinking"),
			},
			isStreaming,
		);
	};
	prototype.updateContent = installedUpdateContent;
	prototype[ASSISTANT_THINKING_PATCH_KEY] = {
		originalUpdateContent,
		installedUpdateContent,
	};
}

// =============================================================================
// ToolGroupComponent
// =============================================================================
class ToolGroupComponent extends Container {
	readonly toolCallId = `compact-group-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
	toolName = "group";
	/** Nested at a visible-text boundary rather than rendered at chat level. */
	anchored = false;
	private _expanded = false;
	get expanded(): boolean {
		return this._expanded;
	}
	/** Sealed: this block was closed by real text output — render from snapshot only. */
	sealed = false;
	/** Thinking snapshot captured when this block was sealed by text output. */
	thinkingFrozen = "";
	/** Token snapshot paired with thinkingFrozen. */
	thinkingTokensFrozen = 0;
	thinkingTokensFrozenExact = false;
	thinkingDurationFrozen: number | undefined;
	private markdownPreviewCache = new Map<string, MarkdownPreview>();

	constructor() {
		super();
	}

	seal(): void {
		stopThinking();
		this.sealed = true;
		this.thinkingFrozen = thinkingText;
		this.thinkingTokensFrozen = thinkingTokenCount;
		this.thinkingTokensFrozenExact = thinkingTokenCountExact;
		this.thinkingDurationFrozen = thinkingDuration();
		this.invalidate();
	}

	setExpanded(expanded: boolean): void {
		this._expanded = expanded;
		for (const tool of this.children) tool.setExpanded?.(expanded);
		this.invalidate();
	}

	addTool(tool: any): void {
		this.children.push(tool);
		if ((tool as any)._groupedAt === undefined) (tool as any)._groupedAt = Date.now();
		(tool as any)[PARENT_KEY] = this;
	}

	removeTool(tool: any): void {
		const index = this.children.indexOf(tool);
		if (index >= 0) this.children.splice(index, 1);
		if ((tool as any)?.[PARENT_KEY] === this) delete (tool as any)[PARENT_KEY];
	}

	hasPending(): boolean {
		// Running tools only — global thinking alone must not keep the bar repainting.
		return this.children.some((tool) => toolStatus(tool) === "pending");
	}

	/** True while this group should keep its spinner animating. */
	needsAnimation(): boolean {
		return (
			this.hasPending() ||
			(this === lastActiveGroup && !this.sealed && (thinkingActive || this.liveThinking().trim().length > 0))
		);
	}

	invalidate(): void {
		// Theme changes and tool/thinking updates must rebuild ANSI markdown.
		this.markdownPreviewCache.clear();
		super.invalidate();
	}

	private renderMarkdownPreview(
		cacheKey: string,
		source: string,
		width: number,
		maxLines: number,
		defaultTextStyle?: DefaultTextStyle,
	): MarkdownPreview {
		const renderWidth = Math.max(1, width);
		const lineLimit = Math.max(1, maxLines);
		const cached = this.markdownPreviewCache.get(cacheKey);
		if (cached && cached.source === source && cached.width === renderWidth && cached.maxLines === lineLimit) {
			return cached;
		}

		// Only a bounded prefix can become visible. This prevents a very large
		// command result from being reparsed in full merely to display a handful
		// of expanded lines. Incomplete closing fences are supported by pi-tui.
		const sourceRows = source.split("\n");
		const sourceLineLimit = Math.max(lineLimit * 4, lineLimit + 20);
		const sourceCharLimit = Math.max(4096, lineLimit * Math.max(40, renderWidth) * 4);
		let markdownSource = sourceRows.slice(0, sourceLineLimit).join("\n");
		let sourceTruncated = sourceRows.length > sourceLineLimit;
		if (markdownSource.length > sourceCharLimit) {
			markdownSource = markdownSource.slice(0, sourceCharLimit);
			sourceTruncated = true;
		}

		const markdown = new Markdown(markdownSource, 0, 0, getCompactMarkdownTheme(), defaultTextStyle);
		const rendered = normalizeCompactCodeBlockLines(markdown.render(renderWidth), renderWidth);
		const preview: MarkdownPreview = {
			source,
			width: renderWidth,
			maxLines: lineLimit,
			lines: rendered.slice(0, lineLimit),
			truncated: sourceTruncated || rendered.length > lineLimit,
		};
		this.markdownPreviewCache.set(cacheKey, preview);
		return preview;
	}

	private iconFor(tool: any, frame: string): string {
		const st = toolStatus(tool);
		return st === "pending" ? frame : st === "error" ? "✗" : "✓";
	}
	private colorFor(status: string): string {
		return status === "pending" ? "accent" : status === "error" ? "error" : "success";
	}
	// Tool name in bold accent, tool payload in dim.
	private toolRow(rail: string, tool: any, frame: string, previewFailure = false): string {
		const theme = currentTheme;
		const fg = (color: string, text: string) => theme?.fg?.(color, text) ?? text;
		const bold = theme?.bold ? theme.bold : (t: string) => t;
		const st = toolStatus(tool);
		const s = toolSummary(tool.toolName, tool.args);
		const phase = st === "pending" ? getToolExecutionPhase(tool?.result?.details) : undefined;
		if (phase) {
			s.content = `${phase} · ${s.content}`;
		} else {
			const stats = resultSummary(tool.toolName, tool.result, tool.isPartial);
			if (stats) s.content = s.content ? `${s.content} · ${stats}` : stats;
		}
		if (previewFailure && st === "error") {
			const reason = extractFailureReason(tool.result);
			const stats = resultSummary(tool.toolName, tool.result);
			if (reason) s.content = `${reason}${stats ? ` · ${stats}` : ""}`;
		}
		const content = oneLine(s.content, 500);
		const display = previewFailure && st === "error" ? linkErrorLocation(content, tool.cwd) : content;
		return `${fg("dim", rail)}${fg(this.colorFor(st), this.iconFor(tool, frame))} ${fg("toolTitle", bold(s.name))} ${fg(st === "error" ? "error" : "dim", display)} ${fg("muted", `(${toolElapsed(tool)}s)`)}`;
	}
	// Live state only applies to the not-yet-sealed (active) block.
	private liveThinking(): string {
		return this.sealed ? this.thinkingFrozen : this === lastActiveGroup ? thinkingText : this.thinkingFrozen;
	}
	private liveThinkingTokenLabel(): string {
		const tokens = this.sealed || this !== lastActiveGroup ? this.thinkingTokensFrozen : thinkingTokenCount;
		const exact = this.sealed || this !== lastActiveGroup ? this.thinkingTokensFrozenExact : thinkingTokenCountExact;
		const duration = this.sealed || this !== lastActiveGroup ? this.thinkingDurationFrozen : thinkingDuration();
		return `${exact ? "" : "≈"}${formatTokenK(tokens)} tok · ${duration === undefined ? "—" : (duration / 1000).toFixed(1)}s`;
	}
	private liveThinkingActive(): boolean {
		return this === lastActiveGroup && !this.sealed && thinkingActive;
	}
	private livePending(): boolean {
		return !this.sealed && this.children.some((t) => toolStatus(t) === "pending");
	}

	private header(frame: string, fg: (color: string, text: string) => string): string {
		const tools = this.children.map((child) => {
			const tool = child as Component & { toolCallId?: string };
			return { status: toolStatus(tool), startedAt: toolStarts.get(tool.toolCallId ?? ""), endedAt: toolEnds.get(tool.toolCallId ?? "") };
		});
		return groupHeader(tools, this.liveThinkingActive() || (!this.sealed && tools.length === 0), frame, fg);
	}

	// Folded: header + up to collapsedMaxLines total, ellipsis when exceeding.
	private renderCollapsed(width: number): string[] {
		const fg = (color: string, text: string) => currentTheme?.fg?.(color, text) ?? text;
		const bold = (text: string) => currentTheme?.bold?.(text) ?? text;
		const frame = SPINNER[Math.floor((Date.now() - spinnerStart) / SPINNER_MS) % SPINNER.length]!;
		const lines = [this.header(frame, fg)];
		const thinking = this.liveThinking().trim().replace(/[*_#`>]+/g, "");
		const aggregated = aggregateConsecutiveTools(this.children,
			(tool) => (tool as Component & { toolName: string }).toolName,
			toolStatus,
			(tool) => (tool as Component & { args?: unknown }).args);
		const selection = selectCollapsedItems(aggregated, toolStatus, config.collapsedMaxLines, thinking.length > 0);
		for (const [index, item] of selection.items.entries()) {
			const rail = index === selection.items.length - 1 && !selection.showThinking ? "└  " : "│  ";
			lines.push(item.type === "aggregate"
				? `${fg("dim", rail)}${fg("success", "✓")} ${fg("toolTitle", bold(item.name))} ${fg("dim", `· ${aggregateLabel(item)}`)}`
				: this.toolRow(rail, item.tool, frame, true));
		}
		if (selection.showThinking) {
			const tokenLabel = this.liveThinkingTokenLabel();
			const previewWidth = Math.max(1, Math.min(50, width - GROUP_PADDING_X - 18 - tokenLabel.length));
			lines.push(`${fg("dim", "└  ")}${fg("muted", "·")} ${fg("thinkingText", `thinking: ${oneLine(thinking, previewWidth)}`)} ${fg("muted", `· ${tokenLabel}`)}`);
		}
		if (this.hasPending() || this.liveThinkingActive()) scheduleAnimation();
		return lines;
	}

	// Expanded: per-tool detail + thinking, line counts configurable.
	private renderExpanded(width: number): string[] {
		const theme = currentTheme;
		const fg = (color: string, text: string) => theme?.fg?.(color, text) ?? text;
		const frame = SPINNER[Math.floor((Date.now() - spinnerStart) / SPINNER_MS) % SPINNER.length]!;
		const lines: string[] = [];

		lines.push(this.header(frame, fg));

		const total = this.children.length;
		for (let index = 0; index < total; index++) {
			const tool = this.children[index];
			const isLast = index === total - 1;
			const rail = isLast ? "└─ " : "├─ ";
			const sub = isLast ? "    " : "│   ";
			lines.push(this.toolRow(rail, tool, frame));

			// Highlight diff for edit tool if valid details.diff exists
			const markdownWidth = Math.max(1, width - GROUP_PADDING_X - sub.length);
			let diffRendered = false;
			if (tool?.toolName === "edit" && tool?.result?.details && !tool?.result?.isError) {
				const editDiff = renderEditDiff(tool.result.details.diff, markdownWidth, config.expandedToolLines, currentTheme);
				if (editDiff) {
					for (const row of editDiff.lines) {
						lines.push(`${fg("dim", sub)}${row}`);
					}
					if (editDiff.truncated) {
						lines.push(`${fg("dim", sub)}${fg("muted", "…")}`);
					}
					diffRendered = true;
				}
			}

			if (!diffRendered) {
				const result = toolResultText(tool);
				if (result) {
					const preview = this.renderMarkdownPreview(
						`tool:${tool.toolCallId ?? index}`,
						result,
						markdownWidth,
						config.expandedToolLines,
						{ color: (text) => currentTheme?.fg?.("toolOutput", text) ?? text },
					);
					for (const row of preview.lines) {
						lines.push(`${fg("dim", sub)}${toolStatus(tool) === "error" ? linkErrorLocation(row, tool.cwd) : row}`);
					}
					if (preview.truncated) {
						lines.push(`${fg("dim", sub)}${fg("muted", "…")}`);
					}
				}
			}
			const fullOutput = fullOutputEntry(tool.toolName, tool.result?.details, tool.cwd);
			if (fullOutput) lines.push(`${fg("dim", sub)}${fg("accent", fullOutput)}`);
			const delegateOutput = delegateOutputEntry(tool.toolName, tool.result?.details, toolResultText(tool), tool.cwd);
			if (delegateOutput) lines.push(`${fg("dim", sub)}${fg("accent", delegateOutput)}`);
		}

		const tText = this.liveThinking().trim();
		if (tText) {
			lines.push(
				`${fg("dim", "└  ")}${fg("muted", "·")} ${fg("thinkingText", "thinking")} ${fg("muted", `· ${this.liveThinkingTokenLabel()}`)}`,
			);
			const sub = "    ";
			const markdownWidth = Math.max(1, width - GROUP_PADDING_X - sub.length);
			const preview = this.renderMarkdownPreview(
				"thinking",
				tText,
				markdownWidth,
				config.expandedThinkingLines,
				{ color: (text) => currentTheme?.fg?.("thinkingText", text) ?? text, italic: true },
			);
			for (const row of preview.lines) {
				lines.push(`${fg("dim", sub)}${row}`);
			}
			if (preview.truncated) {
				lines.push(`${fg("dim", sub)}${fg("muted", "…")}`);
			}
		}

		if (this.hasPending() || this.liveThinkingActive()) scheduleAnimation();
		return lines;
	}

	render(width: number): string[] {
		const lines = this._expanded ? this.renderExpanded(width) : this.renderCollapsed(width);
		// Indent compact blocks from the transcript edge while keeping every line
		// within the terminal width (including mobile / narrow terminals).
		const padding = " ".repeat(Math.min(GROUP_PADDING_X, Math.max(0, width - 1)));
		const contentWidth = Math.max(1, width - padding.length);
		const rendered = lines.map((line) => padding + truncateToWidth(line, contentWidth, "…"));
		// Native ToolExecutionComponent starts with Spacer(1). Our custom render
		// bypasses that child tree, so restore the same single leading gap while
		// the group is top-level. Anchored groups receive deterministic spacing
		// from placeAnchoredGroupBeforeText() instead.
		return this.anchored ? rendered : ["", ...rendered];
	}
}

// =============================================================================
// Animation scheduling. The TUI instance is captured via setWidget's factory
// (extensions can't requestRender directly). We tick at 300ms and call the
// throttled requestRender(), so the diff renderer updates only the changed
// spinner/elapsed cells — no full-screen repaint, no scroll fight.
// =============================================================================
let animTimer: ReturnType<typeof setTimeout> | null = null;
let capturedTui: any = null;

function scheduleAnimation(): void {
	if (animTimer) return;
	animTimer = setTimeout(() => {
		animTimer = null;
		let any = false;
		for (const g of groups) {
			const running = g.children.some((t) => toolStatus(t) === "pending");
			const liveThinking = g === lastActiveGroup && !g.sealed && thinkingActive;
			if (running || liveThinking) {
				any = true;
			}
		}
		if (any && capturedTui) {
			capturedTui.requestRender();
		}
	}, SPINNER_MS);
}

// =============================================================================
// Prototype patch
// =============================================================================
const groups = new Set<ToolGroupComponent>();

function isGroupable(value: any): boolean {
	if (!(value instanceof ToolExecutionComponent)) return false;
	const toolName = (value as any).toolName;
	const standaloneList = config.standaloneTools;
	if (toolName && Array.isArray(standaloneList) && standaloneList.includes(toolName)) {
		return false;
	}
	return true;
}

function previousGroupable(children: any[], start: number): { child: any; index: number } | undefined {
	for (let i = start; i >= 0; i--) {
		const child = children[i];
		if (child instanceof Spacer) continue;
		if (child instanceof AssistantMessageComponent) continue;
		return { child, index: i };
	}
	return undefined;
}

// Show a collapsed block as soon as thinking content appears (before any tool
// call). The block is inserted right after the current assistant message
// component so the message's (and later messages') tool calls join it via
// maybeGroup — as long as no real (non-thinking) text sealed it in between.
function ensureThinkingGroup(): void {
	if (!thinkingText.trim()) return; // nothing to show
	if (lastActiveGroup && !lastActiveGroup.sealed) return; // already an open block
	if (!lastChatContainer || !lastStreamingComp) return;
	const parent = lastChatContainer;
	const children = parent.children;
	if (!Array.isArray(children)) return;
	const idx = children.indexOf(lastStreamingComp);
	const group = new ToolGroupComponent();
	children.splice(idx >= 0 ? idx + 1 : children.length, 0, group);
	groups.add(group);
	lastActiveGroup = group;
	parent.invalidate?.();
	capturedTui?.requestRender?.();
}

// A text stream is a boundary between compact blocks. The message_update event
// arrives before or after the matching AssistantMessageComponent depending on
// the renderer's event ordering, so defer the seal until that component exists.
function flushPendingTextSeal(): void {
	if (!pendingTextSeal) return;

	if ((!lastActiveGroup || lastActiveGroup.sealed) && thinkingText.trim()) {
		ensureThinkingGroup();
	}

	if (lastActiveGroup && !lastActiveGroup.sealed) {
		// The active group contains every thinking/tool event since the previous
		// visible text. Anchor it immediately before this text block so the visual
		// component order matches the stream order:
		//   group -> visible text -> next group -> next visible text
		if (pendingTextOrdinal !== null) {
			anchorGroupBeforeCurrentText(lastActiveGroup, pendingTextOrdinal);
		}
		lastActiveGroup.seal();
		pendingTextSeal = false;
		pendingTextOrdinal = null;
		resetThinking();
		return;
	}

	// No thinking or tools preceded this text, so there is no compact block to
	// seal. Do not let the boundary leak forward and close a later tool group.
	if (!thinkingText.trim()) {
		pendingTextSeal = false;
		pendingTextOrdinal = null;
	}
}

function maybeGroup(parent: any, component: any): void {
	if (!isGroupable(component) || parent instanceof ToolGroupComponent) {
		if (parent && !(parent instanceof ToolGroupComponent) && component instanceof ToolExecutionComponent) {
			const toolName = (component as any).toolName;
			const standaloneList = config.standaloneTools;
			if (toolName && Array.isArray(standaloneList) && standaloneList.includes(toolName)) {
				if (lastActiveGroup && !lastActiveGroup.sealed) {
					lastActiveGroup.seal();
					resetThinking();
					lastActiveGroup = null;
				}
			}
		}
		return;
	}
	const children = parent?.children;
	if (!Array.isArray(children)) return;
	const index = children.indexOf(component);
	if (index < 0) return;
	const prior = previousGroupable(children, index - 1);

	// Previous sibling is an open (not-yet-sealed) group → join it.
	if (prior?.child instanceof ToolGroupComponent && !prior.child.sealed) {
		children.splice(index, 1);
		prior.child.addTool(component);
		lastActiveGroup = prior.child;
		return;
	}
	// Previous sibling is a bare tool → merge both into a new group.
	if (prior && isGroupable(prior.child)) {
		const group = new ToolGroupComponent();
		group.addTool(prior.child);
		group.addTool(component);
		(parent as any).children[prior.index] = group;
		children.splice(index, 1);
		groups.add(group);
		lastActiveGroup = group;
		return;
	}
	// Otherwise (sealed group before, or nothing groupable) → wrap the tool in a
	// fresh open group so it stays visible.
	const group = new ToolGroupComponent();
	group.addTool(component);
	(parent as any).children[index] = group;
	groups.add(group);
	lastActiveGroup = group;
}

type PatchState = {
	active: boolean;
	original: { addChild: Function; removeChild: Function; clear: Function };
	installed: { addChild: Function; removeChild: Function; clear: Function };
	prototype: any;
};

// AssistantMessageComponent content containers that may carry a "phantom" blank
// line. With hiddenThinkingLabel set to "", pi still adds
// Text(italic(fg("thinkingText",""))) to the message; because the empty string
// is wrapped in ANSI escapes, Text does not treat it as empty and renders a full
// blank line. That phantom line (plus the thinking-only Spacer pi adds after
// it) makes the gap between a folded tool group and the following text look too
// large. We strip the empty Text so only pi's normal single Spacer remains.
const assistantContentContainers = new WeakSet<Container>();
type AssistantContentState = {
	/** Sealed groups keyed by the visible Markdown block they precede. */
	anchors: Map<number, ToolGroupComponent>;
	/** Visible Markdown ordinal while AssistantMessageComponent rebuilds. */
	nextTextOrdinal: number;
	/** Turn-duration divider bound to the final visible Markdown ordinal. */
	finalDivider?: { ordinal: number; component: any };
};
const assistantContentStates = new WeakMap<Container, AssistantContentState>();
const groupAnchors = new WeakMap<ToolGroupComponent, { container: Container; ordinal: number }>();

function getAssistantContentState(container: Container): AssistantContentState {
	let state = assistantContentStates.get(container);
	if (!state) {
		state = { anchors: new Map(), nextTextOrdinal: 0 };
		assistantContentStates.set(container, state);
	}
	return state;
}

function removeGroupFromContainer(container: any, group: ToolGroupComponent): void {
	const children = container?.children;
	if (!Array.isArray(children)) return;
	const index = children.indexOf(group);
	if (index >= 0) children.splice(index, 1);
}

function removeComponentFromContainer(container: any, component: any): void {
	const children = container?.children;
	if (!Array.isArray(children)) return;
	const index = children.indexOf(component);
	if (index >= 0) children.splice(index, 1);
}

function formatWorkedTime(elapsedMs: number): string {
	const totalSec = Math.max(1, Math.round(elapsedMs / 1000));
	const hours = Math.floor(totalSec / 3600);
	const minutes = Math.floor((totalSec % 3600) / 60);
	const seconds = totalSec % 60;
	if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
	if (minutes > 0) return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
	return `${seconds}s`;
}

// Static horizontal rule with the turn's elapsed time in the middle:
//   ──── worked for 0m 42s ────
class TurnDividerComponent {
	private readonly timeLabel: string;

	constructor(timeLabel: string) {
		this.timeLabel = timeLabel;
	}

	render(width: number): string[] {
		const theme = currentTheme;
		const fg = (color: string, text: string) => theme?.fg?.(color, text) ?? text;
		const middle = `worked for ${this.timeLabel}`;
		const avail = Math.max(6, width - middle.length - 2);
		const left = Math.floor(avail / 2);
		const right = avail - left;
		const dash = (n: number) => "─".repeat(Math.max(0, n));
		const line = `${fg("dim", dash(left))} ${fg("muted", middle)} ${fg("dim", dash(right))}`;
		return [truncateToWidth(line, Math.max(1, width))];
	}

	invalidate(): void {}
}

// Insert the turn divider directly before the final visible Markdown, keeping
// the anchored group's trailing Spacer as the gap: ... group, Spacer, divider,
// final text. Re-inserting is idempotent (the old instance is removed first).
function placeTurnDividerBeforeText(container: Container, target: Markdown, divider: any): void {
	const targetIndex = container.children.indexOf(target);
	if (targetIndex < 0) return;
	removeComponentFromContainer(container, divider);
	container.children.splice(targetIndex, 0, divider);
}

// Called at agent_end: bind a divider to the final visible text of the last
// assistant message so it survives cumulative rebuilds (like anchored groups).
function insertTurnDivider(elapsedMs: number): void {
	if (elapsedMs < 1000) return;
	let comp: any = lastStreamingComp;
	if (!comp || !(comp instanceof AssistantMessageComponent)) {
		if (!lastChatContainer) return;
		const children = (lastChatContainer as any)?.children;
		if (!Array.isArray(children)) return;
		for (let i = children.length - 1; i >= 0; i--) {
			if (children[i] instanceof AssistantMessageComponent) {
				comp = children[i];
				break;
			}
		}
	}
	if (!comp) return;
	const contentContainer = (comp as any).contentContainer;
	if (!(contentContainer instanceof Container)) return;

	const markdowns = contentContainer.children.filter(isVisibleTextMarkdown);
	if (markdowns.length === 0) return;
	const final = markdowns[markdowns.length - 1];
	const finalIndex = contentContainer.children.indexOf(final);
	// Only separate the final text from preceding work (an anchored tool/thinking
	// group). A plain text-only answer gets no divider.
	const hasPriorContent = contentContainer.children
		.slice(0, finalIndex)
		.some((child) => child instanceof ToolGroupComponent);
	if (!hasPriorContent) return;

	const state = getAssistantContentState(contentContainer);
	if (state.finalDivider && contentContainer.children.includes(state.finalDivider.component)) return;
	const ordinal = markdowns.length - 1;
	const divider = new TurnDividerComponent(formatWorkedTime(elapsedMs));
	state.finalDivider = { ordinal, component: divider };
	placeTurnDividerBeforeText(contentContainer, final, divider);
	contentContainer.invalidate?.();
	capturedTui?.requestRender?.();
}

function isVisibleTextMarkdown(component: any): component is Markdown {
	// Thinking Markdown receives a defaultTextStyle ({ color, italic }) from
	// AssistantMessageComponent; normal assistant text does not. Count only
	// normal text blocks so anchors remain correct if thinking visibility is
	// toggled on.
	return component instanceof Markdown && !(component as any).defaultTextStyle;
}

function placeAnchoredGroupBeforeText(container: Container, target: Markdown, group: ToolGroupComponent): void {
	const targetIndex = container.children.indexOf(target);
	if (targetIndex < 0) return;

	// Pi may accumulate one Spacer for the message itself plus one Spacer for
	// every hidden thinking run before this text. Tool loops can therefore leave
	// an arbitrarily large run here. Replace the entire run with a deterministic
	// boundary:
	//
	//   previous text/content -> one blank -> compact group -> one blank -> text
	//
	// This also makes repeated cumulative AssistantMessageComponent rebuilds
	// idempotent instead of accumulating more spacing around restored anchors.
	let spacerStart = targetIndex;
	while (spacerStart > 0 && container.children[spacerStart - 1] instanceof Spacer) spacerStart--;
	if (targetIndex > spacerStart) {
		container.children.splice(spacerStart, targetIndex - spacerStart);
	}
	group.anchored = true;
	container.children.splice(spacerStart, 0, new Spacer(1), group, new Spacer(1));
}

function insertAnchoredGroup(container: Container, ordinal: number, group: ToolGroupComponent): void {
	const markdowns = container.children.filter(isVisibleTextMarkdown);
	const target = markdowns[ordinal];
	if (!target) return;
	removeGroupFromContainer(container, group);
	placeAnchoredGroupBeforeText(container, target, group);
}

function installAssistantExpansion(component: AssistantMessageComponent, contentContainer: Container): void {
	// Ctrl+O only visits top-level chat children. Once compact groups are
	// anchored inside an AssistantMessageComponent, make that top-level
	// component expandable and delegate the state to its nested groups.
	(component as any).setExpanded = (expanded: boolean) => {
		const state = assistantContentStates.get(contentContainer);
		if (!state) return;
		for (const group of state.anchors.values()) group.setExpanded(expanded);
		contentContainer.invalidate();
	};
}

function anchorGroupBeforeCurrentText(group: ToolGroupComponent, ordinal: number): void {
	if (!lastStreamingComp || !lastChatContainer) return;
	const contentContainer = (lastStreamingComp as any).contentContainer;
	if (!(contentContainer instanceof Container)) return;

	// An open group normally lives directly in the chat container. Remove it
	// there before nesting it at the exact text boundary.
	removeGroupFromContainer(lastChatContainer, group);

	const previousAnchor = groupAnchors.get(group);
	if (previousAnchor) {
		const previousState = assistantContentStates.get(previousAnchor.container);
		if (previousState?.anchors.get(previousAnchor.ordinal) === group) {
			previousState.anchors.delete(previousAnchor.ordinal);
		}
		removeGroupFromContainer(previousAnchor.container, group);
	}

	const state = getAssistantContentState(contentContainer);
	const replaced = state.anchors.get(ordinal);
	if (replaced && replaced !== group) {
		removeGroupFromContainer(contentContainer, replaced);
		replaced.anchored = false;
		groupAnchors.delete(replaced);
	}
	state.anchors.set(ordinal, group);
	groupAnchors.set(group, { container: contentContainer, ordinal });
	insertAnchoredGroup(contentContainer, ordinal, group);
	lastChatContainer.invalidate?.();
	capturedTui?.requestRender?.();
}

function restoreAssistantAnchor(parent: any, component: any): void {
	if (!assistantContentContainers.has(parent) || !isVisibleTextMarkdown(component)) return;
	installVisibleAssistantMarkdownRendering(component);
	const state = getAssistantContentState(parent);
	const ordinal = state.nextTextOrdinal++;
	const group = state.anchors.get(ordinal);
	if (group) {
		removeGroupFromContainer(parent, group);
		placeAnchoredGroupBeforeText(parent, component, group);
	}
	const divider = state.finalDivider;
	if (divider && divider.ordinal === ordinal) {
		placeTurnDividerBeforeText(parent, component, divider.component);
	}
}

function releaseAssistantAnchors(component: any): void {
	if (!(component instanceof AssistantMessageComponent)) return;
	const contentContainer = (component as any).contentContainer;
	if (!(contentContainer instanceof Container)) return;
	const state = assistantContentStates.get(contentContainer);
	if (!state) return;
	for (const group of state.anchors.values()) {
		for (const tool of [...group.children]) delete (tool as any)[PARENT_KEY];
		groupAnchors.delete(group);
		groups.delete(group);
	}
	state.anchors.clear();
	state.finalDivider = undefined;
}

function stripAssistantPhantomPadding(parent: any, component: any): void {
	// Mark the plain Container that an AssistantMessageComponent owns as its
	// content container so we can trim its children later.
	if (parent instanceof AssistantMessageComponent && component instanceof Container && !(component instanceof AssistantMessageComponent)) {
		assistantContentContainers.add(component);
		getAssistantContentState(component);
		installAssistantExpansion(parent, component);
		return;
	}
	if (!assistantContentContainers.has(parent)) return;
	// Drop any Text child whose visible content is empty (only ANSI styling).
	// This is the hidden-thinking label pi renders even when the label is "".
	// Also remove the trailing Spacer run that preceded the label. Otherwise
	// every thinking-only assistant message in a multi-tool loop remains as a
	// one-line blank component; moving the final group into a later text message
	// then exposes all of those accumulated blank lines as a huge gap.
	if (component instanceof Text) {
		const visible = String((component as any).text ?? "").replace(/\x1b\[[0-9;]*m/g, "").trim();
		if (visible === "") {
			const index = parent.children.indexOf(component);
			if (index >= 0) parent.children.splice(index, 1);
			while (parent.children.at(-1) instanceof Spacer) parent.children.pop();
		}
	}
}

function installGrouping(): void {
	const host = globalThis as any;
	const prototype = Container.prototype as any;
	const previous = host[PATCH_KEY] as PatchState | undefined;
	// Always (re-)install. On hot-reload (/reload) the old instance's prototype
	// patch stays on Container.prototype but its closures reference the OLD
	// module state (groups/lastActiveGroup). Skipping here would leave the new
	// instance's event handlers reading a different lastActiveGroup than the one
	// the patch writes, so message-boundary sealing would never fire. Re-install
	// with the preserved original so future addChild calls use THIS instance's
	// closures.

	const original = {
		addChild: previous && prototype.addChild === previous.installed.addChild ? previous.original.addChild : prototype.addChild,
		removeChild: previous && prototype.removeChild === previous.installed.removeChild ? previous.original.removeChild : prototype.removeChild,
		clear: previous && prototype.clear === previous.installed.clear ? previous.original.clear : prototype.clear,
	};
	const state: PatchState = {
		active: true,
		prototype,
		original,
		installed: undefined as any,
	};
	state.installed = {
		addChild: function (this: any, component: any) {
			const result = state.original.addChild.call(this, component);
			if (component && typeof component === "object") {
				// Remember where the current assistant message component lives so a
				// thinking-only group can be inserted right after it later.
				if (component instanceof AssistantMessageComponent) {
					lastChatContainer = this;
					lastStreamingComp = component;
					flushPendingTextSeal();
				}
				maybeGroup(this, component);
				stripAssistantPhantomPadding(this, component);
				restoreAssistantAnchor(this, component);
			}
			return result;
		},
		removeChild: function (this: any, component: any) {
			const group = component?.[PARENT_KEY];
			if (group instanceof ToolGroupComponent && (group as any)[PARENT_KEY] === this) {
				group.removeTool(component);
				if (group.children.length === 0) groups.delete(group);
				return;
			}
			releaseAssistantAnchors(component);
			return state.original.removeChild.call(this, component);
		},
		clear: function (this: any) {
			if (assistantContentContainers.has(this)) {
				// AssistantMessageComponent rebuilds this container for every
				// cumulative stream update. Keep sealed compact groups in the
				// anchor map; restoreAssistantAnchor() reinserts each one before
				// its matching Markdown child as the rebuild proceeds.
				getAssistantContentState(this).nextTextOrdinal = 0;
				return state.original.clear.call(this);
			}
			for (const child of [...(this.children ?? [])]) {
				if (child instanceof ToolGroupComponent) {
					for (const tool of [...child.children]) delete tool[PARENT_KEY];
					groups.delete(child);
				}
				releaseAssistantAnchors(child);
			}
			return state.original.clear.call(this);
		},
	};
	prototype.addChild = state.installed.addChild;
	prototype.removeChild = state.installed.removeChild;
	prototype.clear = state.installed.clear;
	host[PATCH_KEY] = state;
}

// =============================================================================
// Built-in tool delegation (render nothing natively)
// =============================================================================
type AnyTool = {
	parameters: unknown;
	execute: (toolCallId: string, params: unknown, signal: AbortSignal, onUpdate?: unknown, ctx?: unknown) => Promise<unknown>;
};

const toolCache = new Map<string, Record<string, AnyTool>>();
function getTools(cwd: string): Record<string, AnyTool> {
	let tools = toolCache.get(cwd);
	if (!tools) {
		tools = {
			read: createReadTool(cwd),
			bash: createBashTool(cwd),
			edit: createEditTool(cwd),
			write: createWriteTool(cwd),
			find: createFindTool(cwd),
			grep: createGrepTool(cwd),
			ls: createLsTool(cwd),
		};
		toolCache.set(cwd, tools);
	}
	return tools;
}

export default function (pi: ExtensionAPI) {
	installGrouping();
	installNativeThinkingSuppression();
	installCompactionSummaryRendering();
	installToolExecutionCustomRendering();

	const delegate = (name: keyof ReturnType<typeof getTools>) =>
		async (toolCallId: string, params: unknown, signal: AbortSignal, onUpdate?: unknown, ctx?: unknown) => {
			return getTools((ctx as { cwd: string }).cwd)[name].execute(toolCallId, params, signal, onUpdate);
		};

	for (const name of ["read", "bash", "edit", "write", "find", "grep", "ls"] as const) {
		pi.registerTool({
			name,
			label: name,
			description: `Built-in ${name} (rendering handled by compact-ui group).`,
			parameters: getTools(process.cwd())[name].parameters,
			execute: delegate(name),
			renderCall: () => new Text("", 0, 0),
			renderResult: () => new Text("", 0, 0),
		});
	}

	pi.on("session_start", async (_event, ctx) => {
		currentTheme = ctx.ui.theme;
		ctx.ui.setHiddenThinkingLabel("");
		// Capture the TUI instance via setWidget's factory so the animation can
		// call its throttled requestRender() to repaint just the changed cells.
		ctx.ui.setWidget("compact-anim", (tui: any) => {
			capturedTui = tui;
			return { render: () => [] as string[], invalidate() {} };
		});
		installGrouping();
		installNativeThinkingSuppression();
		installCompactionSummaryRendering();
		installToolExecutionCustomRendering();
	});

	pi.on("tool_execution_start", async (event) => {
		toolStarts.set(event.toolCallId, Date.now());
		lastActiveGroup?.invalidate();
	});

	pi.on("tool_execution_end", async (event) => {
		toolEnds.set(event.toolCallId, Date.now());
		lastActiveGroup?.invalidate();
	});

	pi.on("message_start", async (event) => {
		const role = (event.message as any)?.role;
		// A new user message is a hard turn boundary: seal whatever block is still
		// open. Assistant/toolResult message boundaries do NOT seal — thinking and
		// tool calls stay in one block until real (non-thinking) text appears.
		if (role === "user" && lastActiveGroup && !lastActiveGroup.sealed) {
			lastActiveGroup.seal();
		}
		if (role === "user") {
			turnStartMs = Date.now();
			resetThinking();
			handledTextIndexes.clear();
			pendingTextSeal = false;
			pendingTextOrdinal = null;
			lastStreamingComp = null;
		} else if (role === "assistant") {
			// contentIndex values are local to one streamed assistant message.
			// Keep the previous thinking snapshot until this message either starts
			// new thinking or emits text that seals the open tool group.
			handledTextIndexes.clear();
			assistantThinkingStarted = false;
			stopThinking();
			pendingTextSeal = false;
			pendingTextOrdinal = null;
			// Do not insert early thinking beside the previous assistant message.
			// The addChild patch fills this with the current streaming component.
			lastStreamingComp = null;
		}
	});

	pi.on("message_update", async (event) => {
		const msg = event.message as any;
		if (!msg || msg.role !== "assistant") return;
		const content = Array.isArray(msg.content) ? msg.content : [];
		const streamEvent = event.assistantMessageEvent as any;
		const streamType = String(streamEvent?.type ?? "");

		if (streamType.startsWith("thinking_")) {
			// Only read the block targeted by this stream event. The surrounding
			// message is cumulative and may still contain thinking from before a
			// text boundary; scanning all content would resurrect that old block.
			if (!assistantThinkingStarted) {
				thinkingBlocks.clear();
				stopThinking();
				thinkingElapsedMs = 0;
				thinkingTimingKnown = false;
				assistantThinkingStarted = true;
			}
			const contentIndex = Number(streamEvent.contentIndex);
			const block = Number.isInteger(contentIndex) ? content[contentIndex] : undefined;
			const blockText =
				block?.type === "thinking"
					? String(block.thinking ?? "")
					: streamType === "thinking_end"
						? String(streamEvent.content ?? "")
						: "";
			if (Number.isInteger(contentIndex)) thinkingBlocks.set(contentIndex, blockText);
			thinkingText = [...thinkingBlocks.values()].filter((text) => text.trim()).join("\n\n");
			updateThinkingTokenCount(msg);
			if (streamType === "thinking_end") stopThinking();
			else {
				thinkingStartedAt ??= Date.now();
				thinkingTimingKnown = true;
				thinkingActive = true;
			}
			// Show a collapsed block as soon as thinking appears (no tool needed).
			ensureThinkingGroup();
		} else if (streamType.startsWith("text_")) {
			const contentIndex = Number(streamEvent.contentIndex);
			const block = Number.isInteger(contentIndex) ? content[contentIndex] : undefined;
			const text = block?.type === "text" ? String(block.text ?? "").trim() : "";
			// The first non-whitespace text is a boundary. Deduplicate by content
			// index so every later cumulative delta extends the same text block.
			if (text.length > 0 && !handledTextIndexes.has(contentIndex)) {
				stopThinking();
				if (thinkingText.trim()) updateThinkingTokenCount(msg);
				handledTextIndexes.add(contentIndex);
				pendingTextSeal = true;
				pendingTextOrdinal =
					content
						.slice(0, Number.isInteger(contentIndex) ? contentIndex + 1 : content.length)
						.filter((item: any) => item?.type === "text" && String(item.text ?? "").trim()).length - 1;
				flushPendingTextSeal();
			}
		} else if (streamType === "done" || streamType === "error") {
			if (thinkingText.trim()) updateThinkingTokenCount(msg);
			stopThinking();
		}

		// Refresh the active block when thinking starts/stops (event-driven only;
		// no timer, so the transcript scroll position is never yanked around).
		lastActiveGroup?.invalidate();
	});

	pi.on("agent_end", async () => {
		// Turn finished: freeze the final block so it stops spinning and shows a
		// stable summary until the user starts the next turn.
		if (lastActiveGroup && !lastActiveGroup.sealed) {
			lastActiveGroup.seal();
		}
		// Separate the final visible text from the preceding work with a divider
		// that reports how long this turn ran.
		const elapsedMs = Date.now() - turnStartMs;
		insertTurnDivider(elapsedMs);
		resetThinking();
		handledTextIndexes.clear();
		pendingTextSeal = false;
		pendingTextOrdinal = null;
	});

	pi.registerCommand("compact-ui-config", {
		description: "Interactive compact-ui settings (arrows to select, Enter to adjust, Esc to close)",
		handler: async (_args, ctx) => {
			// Non-TUI modes (print/json) can't show the interactive menu.
			if (!ctx.hasUI) {
				ctx.ui.notify(
					`compact: collapsedMaxLines=${config.collapsedMaxLines}, expandedToolLines=${config.expandedToolLines}, expandedThinkingLines=${config.expandedThinkingLines}`,
					"info",
				);
				return;
			}

			const changed = await ctx.ui.custom<boolean>((tui, theme, _keybindings, done) => {
				let anyChanged = false;
				const items: SettingItem[] = CONFIG_KEYS.map((meta) => ({
					id: meta.id,
					label: meta.label,
					currentValue: String((config as any)[meta.id]),
					description: meta.description,
					submenu: (currentValue: string, subDone: (value?: string) => void) =>
						makeStepper(meta.label, Number(currentValue), meta, theme, subDone),
				}));
			const settingsList = new SettingsList(
				items,
				Math.min(items.length, 15),
				getSettingsListTheme(),
				(id, newValue) => {
					// Persist and refresh the live groups when SettingsList commits a change.
					(config as any)[id] = Number(newValue);
					saveConfig();
					anyChanged = true;
					for (const g of groups) g.invalidate();
				},
				() => done(anyChanged),
			);
			return {
				render(width: number) {
					return settingsList.render(width);
				},
				invalidate() {
					settingsList.invalidate();
				},
				handleInput(data: string) {
					settingsList.handleInput?.(data);
					tui.requestRender();
				},
			};
		});

		if (changed) {
			ctx.ui.notify("compact-ui settings saved", "info");
		}
	},
});
}

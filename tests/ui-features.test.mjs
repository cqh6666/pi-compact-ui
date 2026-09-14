import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { Container, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { loadExtension } from "./load-extension.mjs";

const themeUrl = new URL("./modes/interactive/theme/theme.js", import.meta.resolve("@earendil-works/pi-coding-agent"));
const requireFromPi = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const { initTheme } = requireFromPi(fileURLToPath(themeUrl));
initTheme("dark");

const {
	default: install,
	getToolExecutionPhase,
	extractFailureReason,
	renderEditDiff,
	aggregateConsecutiveTools,
	selectCollapsedItems,
	CompactExternalGroupComponent,
} = await loadExtension();

const handlers = new Map();
install({
	on: (name, handler) => handlers.set(name, handler),
	registerTool() {},
	registerCommand() {},
	setWidget() {},
});

function fixture(t, toolName = "bash") {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_700_000_000_000 });
	const chat = new Container();
	const tool = new ToolExecutionComponent(toolName, t.name, {}, {}, undefined, { requestRender() {} }, process.cwd());
	chat.addChild(tool);
	const group = chat.children.at(-1);
	t.after(() => chat.clear());
	return {
		chat,
		tool,
		group,
		start: () => handlers.get("tool_execution_start")({ toolCallId: t.name }),
		end: () => handlers.get("tool_execution_end")({ toolCallId: t.name }),
		render(expanded = true) {
			group.setExpanded(expanded);
			return chat.render(120).map(stripTerminalSequences).join("\n");
		},
	};
}

test("getToolExecutionPhase maps known phases and cleans formatting", () => {
	assert.equal(getToolExecutionPhase(undefined), undefined);
	assert.equal(getToolExecutionPhase({}), undefined);
	assert.equal(getToolExecutionPhase({ phase: "searching", currentQuery: "node test runner" }), 'searching: "node test runner"');
	assert.equal(getToolExecutionPhase({ phase: "searching" }), "searching");
	assert.equal(getToolExecutionPhase({ phase: "curating" }), "curating");
	assert.equal(getToolExecutionPhase({ phase: "generating" }), "generating summary");
	assert.equal(getToolExecutionPhase({ phase: "waiting_approval" }), "waiting approval");
	assert.equal(getToolExecutionPhase({ phase: "waiting-approval" }), "waiting approval");
	assert.equal(getToolExecutionPhase({ phase: "downloading", progress: "45%" }), "downloading: 45%");
	assert.equal(getToolExecutionPhase({ phase: "downloading" }), "downloading");
	assert.equal(getToolExecutionPhase({ phase: "extracting" }), "extracting");
	assert.equal(getToolExecutionPhase({ phase: "custom_step_name" }), "custom step name");
});

test("extractFailureReason extracts structured details.error or useful error text", () => {
	assert.equal(extractFailureReason({ isError: false }), undefined);
	assert.equal(extractFailureReason({ isError: true, content: [] }), undefined);

	// Structured string error
	assert.equal(
		extractFailureReason({ isError: true, details: { error: "Resource not found on remote server" } }),
		"Resource not found on remote server"
	);

	// Structured Error object
	assert.equal(
		extractFailureReason({ isError: true, details: { error: new Error("Connection timed out") } }),
		"Connection timed out"
	);

	// Content text fallback, filtering out generic headers
	assert.equal(
		extractFailureReason({
			isError: true,
			content: [
				{ type: "text", text: "Command failed:\nfailed with 1 error\nENOENT: no such file or directory, open 'foo.txt'" }
			]
		}),
		"ENOENT: no such file or directory, open 'foo.txt'"
	);
});

test("renderEditDiff formats diff with theme colors and truncation bounds", () => {
	const dummyTheme = {
		fg: (color, text) => `[${color}]${text}[/${color}]`,
	};

	assert.equal(renderEditDiff(undefined, 80, 10, dummyTheme), undefined);
	assert.equal(renderEditDiff("just regular text without diff markers", 80, 10, dummyTheme), undefined);

	const sampleDiff = [
		"@@ -1,3 +1,4 @@",
		"  const a = 1;",
		"- const b = 2;",
		"+ const b = 3;",
		"+ const c = 4;",
	].join("\n");

	const rendered = renderEditDiff(sampleDiff, 80, 10, dummyTheme);
	assert.ok(rendered);
	assert.equal(rendered.truncated, false);
	assert.equal(rendered.lines.length, 5);
	assert.match(rendered.lines[0], /\[toolDiffContext\]/);
	assert.match(rendered.lines[1], /\[toolDiffContext\]/);
	assert.match(rendered.lines[2], /\[toolDiffRemoved\]/);
	assert.match(rendered.lines[3], /\[toolDiffAdded\]/);
	assert.match(rendered.lines[4], /\[toolDiffAdded\]/);

	// Truncation limit
	const truncated = renderEditDiff(sampleDiff, 80, 3, dummyTheme);
	assert.ok(truncated);
	assert.equal(truncated.truncated, true);
	assert.equal(truncated.lines.length, 3);
});

test("aggregateConsecutiveTools collapses contiguous successful tools and stops at barriers", () => {
	const tools = [
		{ name: "read", status: "success", args: { path: "a.ts" } },
		{ name: "read", status: "success", args: { path: "b.ts" } },
		{ name: "read", status: "success", args: { path: "a.ts" } },
		{ name: "bash", status: "error", args: { command: "npm test" } },
		{ name: "grep", status: "success", args: { pattern: "foo" } },
		{ name: "grep", status: "success", args: { pattern: "bar" } },
		{ name: "grep", status: "pending", args: { pattern: "baz" } },
		{ name: "bash", status: "success", args: { command: "ls" } },
		{ name: "bash", status: "success", args: { command: "pwd" } },
	];

	const aggregated = aggregateConsecutiveTools(
		tools,
		(t) => t.name,
		(t) => t.status,
		(t) => t.args,
	);

	assert.equal(aggregated.length, 5);

	// Run 1: 3 reads -> 2 distinct files
	assert.equal(aggregated[0].type, "aggregate");
	assert.equal(aggregated[0].name, "read");
	assert.equal(aggregated[0].count, 3);
	assert.equal(aggregated[0].distinctCount, 2);
	assert.equal(aggregated[0].distinctUnit, "files");

	// Item 2: bash error (barrier)
	assert.equal(aggregated[1].type, "tool");
	assert.equal(aggregated[1].tool.name, "bash");
	assert.equal(aggregated[1].tool.status, "error");

	// Run 3: 2 greps -> 2 distinct searches
	assert.equal(aggregated[2].type, "aggregate");
	assert.equal(aggregated[2].name, "grep");
	assert.equal(aggregated[2].count, 2);
	assert.equal(aggregated[2].distinctCount, 2);
	assert.equal(aggregated[2].distinctUnit, "searches");

	// Item 4: grep pending (barrier)
	assert.equal(aggregated[3].type, "tool");
	assert.equal(aggregated[3].tool.status, "pending");

	// Run 5: 2 bash calls -> 2 calls
	assert.equal(aggregated[4].type, "aggregate");
	assert.equal(aggregated[4].name, "bash");
	assert.equal(aggregated[4].count, 2);
	assert.equal(aggregated[4].distinctCount, undefined);
});

test("ToolGroupComponent renders failure reason preview when collapsed and full diff when expanded", async (t) => {
	const f = fixture(t, "edit");
	await f.start();
	f.tool.markExecutionStarted();

	// In progress phase
	f.tool.updateResult({ content: [], details: { phase: "searching", currentQuery: "test symbol" } }, true);
	assert.match(f.render(false), /searching: "test symbol"/);

	// Error completion
	await f.end();
	f.tool.updateResult({
		content: [{ type: "text", text: "Patch failed:\nHunk #1 failed at line 10" }],
		isError: true,
	});

	const collapsed = f.render(false);
	assert.match(collapsed, /Hunk #1 failed at line 10/);

	// Now successful edit with diff
	const successTool = new ToolExecutionComponent("edit", `${t.name}-success`, { path: "src/app.ts" }, {}, undefined, { requestRender() {} }, process.cwd());
	f.chat.addChild(successTool);
	await handlers.get("tool_execution_start")({ toolCallId: `${t.name}-success` });
	successTool.markExecutionStarted();
	await handlers.get("tool_execution_end")({ toolCallId: `${t.name}-success` });
	successTool.updateResult({
		content: [{ type: "text", text: "Applied edit" }],
		details: {
			diff: "@@ -1,2 +1,2 @@\n-oldLine\n+newLine",
		},
		isError: false,
	});

	const expanded = f.render(true);
	assert.match(expanded, /-oldLine/);
	assert.match(expanded, /\+newLine/);
});

test("CompactExternalGroupComponent renders failure reason preview and consecutive aggregation", () => {
	const theme = {
		fg: (c, t) => `[${c}]${t}[/${c}]`,
		bold: (t) => `*${t}*`,
	};

	const state = {
		tools: [
			{ id: "1", name: "read", status: "success", args: { path: "f1.ts" }, resultText: "", startedAt: 1000, endedAt: 2000 },
			{ id: "2", name: "read", status: "success", args: { path: "f2.ts" }, resultText: "", startedAt: 2000, endedAt: 3000 },
			{ id: "3", name: "bash", status: "error", args: { command: "make" }, resultText: "Compilation error: missing symbol", startedAt: 3000, endedAt: 4000 },
		],
		thinking: "",
		thinkingActive: false,
		sealed: true,
	};

	const comp = new CompactExternalGroupComponent(state, theme);
	const renderedCollapsed = comp.render(120).join("\n");

	// Collapsed view should aggregate the 2 reads: "read · 2 files"
	assert.match(renderedCollapsed, /read.*· 2 files/);
	// Collapsed view should show failure reason preview: "bash · Compilation error: missing symbol"
	assert.match(renderedCollapsed, /\[error\]✗.*Compilation error: missing symbol/);

	// Expanded view should expand tools in order and display output
	comp.setExpanded(true);
	const renderedExpanded = comp.render(120).join("\n");
	assert.match(renderedExpanded, /f1\.ts/);
	assert.match(renderedExpanded, /f2\.ts/);
	assert.match(renderedExpanded, /make/);
	assert.match(renderedExpanded, /Compilation error: missing symbol/);
});

test("failure preview selects a cause beyond npm banners and requires explicit failure", () => {
	const output = {
		isError: true,
		content: [{ type: "text", text: "> package check\n> tsgo --noEmit\n\nfile.ts(8,2): error TS2322: Provider type mismatch\n\nCommand exited with code 2" }],
	};
	assert.equal(extractFailureReason(output), "file.ts(8,2): error TS2322: Provider type mismatch");
	assert.equal(extractFailureReason({ ...output, isError: false }), undefined);
	assert.equal(extractFailureReason({ ...output, details: { error: "\u001b[31mPermission denied\u001b[0m" } }), "Permission denied");
});

test("collapsed row budgets prioritize errors and pending phases over thinking", () => {
	const tools = [
		{ name: "bash", status: "error", args: {} },
		{ name: "web_search", status: "pending", args: {} },
		...Array.from({ length: 6 }, (_, index) => ({ name: "read", status: "success", args: { path: `${index}.ts` } })),
	];
	const items = aggregateConsecutiveTools(tools, (t) => t.name, (t) => t.status, (t) => t.args);
	const tiny = selectCollapsedItems(items, (t) => t.status, 2, true);
	assert.deepEqual(tiny.items.map((item) => item.tool), [tools[0]]);
	assert.equal(tiny.showThinking, false);
	const compact = selectCollapsedItems(items, (t) => t.status, 3, true);
	assert.deepEqual(compact.items.map((item) => item.tool), [tools[0], tools[1]]);
	assert.equal(compact.showThinking, false);
	for (const size of [2, 3, 4, 5]) {
		const selected = selectCollapsedItems(items, (t) => t.status, size, true);
		assert.ok(1 + selected.items.length + Number(selected.showThinking) <= size);
		assert.equal(new Set(selected.items).size, selected.items.length);
	}
});

test("long-query phase stays visible in a narrow row and clears on final result", async (t) => {
	const f = fixture(t, "web_search");
	f.tool.args = { query: "very long search query ".repeat(12) };
	await f.start();
	f.tool.markExecutionStarted();
	f.tool.updateResult({ content: [], details: { phase: "waiting_approval" } }, true);
	assert.match(f.chat.render(60).map(stripTerminalSequences).join("\n"), /waiting approval/);
	await f.end();
	f.tool.updateResult({ content: [], details: { phase: "waiting_approval", totalResults: 3 } });
	assert.doesNotMatch(f.render(false), /waiting approval/);
	assert.match(f.render(true), /3 results/);
});

test("native diff colors preserve context markers, expand tabs and respect ANSI width", () => {
	const colors = [];
	const theme = { fg: (color, text) => { colors.push(color); return `\u001b[32m${text}\u001b[0m`; } };
	const diff = "-2 old\n+2 新的值\twith a long suffix\n +context starts with plus\n -context starts with minus";
	for (const width of [1, 12, 40]) {
		colors.length = 0;
		const rendered = renderEditDiff(diff, width, 4, theme);
		assert.deepEqual(colors, ["toolDiffRemoved", "toolDiffAdded", "toolDiffContext", "toolDiffContext"]);
		assert.ok(rendered.lines.every((line) => visibleWidth(line) <= width));
		assert.ok(rendered.lines.every((line) => !line.includes("\t")));
		assert.equal(rendered.truncated, false);
	}
});

test("aggregation counts repeated searches, falls back on missing paths and respects standalone tools", () => {
	const tools = [
		{ name: "grep", status: "success", args: { pattern: "foo", path: "src" } },
		{ name: "grep", status: "success", args: { pattern: "foo", path: "tests" } },
		{ name: "read", status: "success", args: { path: "a.ts" } },
		{ name: "read", status: "success", args: {} },
		{ name: "compress", status: "success", args: {} },
		{ name: "compress", status: "success", args: {} },
	];
	const items = aggregateConsecutiveTools(tools, (t) => t.name, (t) => t.status, (t) => t.args);
	assert.equal(items[0].distinctCount, 2);
	assert.equal(items[1].distinctCount, undefined);
	assert.equal(items[1].count, 2);
	assert.equal(items[2].type, "tool");
	assert.equal(items[3].type, "tool");
});

test("collapsed failure is rendered once while expanded tools retain order and fallback output", (t) => {
	const f = fixture(t, "bash");
	f.tool.updateResult({ isError: true, content: [{ type: "text", text: "ENOENT: missing file" }] });
	for (const path of ["first.ts", "second.ts"]) {
		const tool = new ToolExecutionComponent("edit", path, { path }, {}, undefined, { requestRender() {} }, process.cwd());
		f.chat.addChild(tool);
		tool.updateResult({ content: [{ type: "text", text: `Updated ${path}` }], details: { diff: "not a diff" } });
	}
	const collapsed = f.render(false);
	assert.equal((collapsed.match(/✗ bash/g) ?? []).length, 1);
	assert.match(collapsed, /2 files/);
	const expanded = f.render(true);
	assert.ok(expanded.indexOf("ENOENT") < expanded.indexOf("Updated first.ts"));
	assert.ok(expanded.indexOf("Updated first.ts") < expanded.indexOf("Updated second.ts"));
});


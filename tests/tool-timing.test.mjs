import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { Container, stripTerminalSequences } from "@earendil-works/pi-tui";
import { loadExtension } from "./load-extension.mjs";

const themeUrl = new URL("./modes/interactive/theme/theme.js", import.meta.resolve("@earendil-works/pi-coding-agent"));
const requireFromPi = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const { initTheme } = requireFromPi(fileURLToPath(themeUrl));
initTheme("dark");
const { default: install, CompactExternalGroupComponent } = await loadExtension();
const handlers = new Map();
install({
	on: (name, handler) => handlers.set(name, handler),
	registerTool() {},
	registerCommand() {},
});

const result = { content: [{ type: "text", text: "output" }], isError: false };
const clockStart = Date.now();

function fixture(t, name = "bash") {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: clockStart });
	const chat = new Container();
	const tool = new ToolExecutionComponent(name, t.name, { command: "echo output" }, {}, undefined, { requestRender() {} }, process.cwd());
	chat.addChild(tool);
	const group = chat.children[0];
	t.after(() => chat.clear());
	return {
		chat,
		tool,
		start: () => handlers.get("tool_execution_start")({ toolCallId: t.name }),
		end: () => handlers.get("tool_execution_end")({ toolCallId: t.name }),
		render(expanded = true) {
			group.setExpanded(expanded);
			return chat.render(120).map(stripTerminalSequences).join("\n");
		},
	};
}

function expectTime(view, seconds) {
	assert.match(view, new RegExp(`\\(${seconds.replace(".", "\\.")}s\\)`));
}

test("live pending tools keep counting across expansion", async (t) => {
	const f = fixture(t);
	await f.start();
	f.tool.markExecutionStarted();
	t.mock.timers.tick(1200);
	expectTime(f.render(false), "1.2");
	t.mock.timers.tick(2300);
	const expanded = f.render();
	assert.match(expanded, /tool calling/);
	expectTime(expanded, "3.5");
});

test("completed tools retain execution duration across delayed render and Ctrl+O", async (t) => {
	const f = fixture(t);
	await f.start();
	f.tool.markExecutionStarted();
	t.mock.timers.tick(2500);
	await f.end();
	f.tool.updateResult(result);
	t.mock.timers.tick(10_000);
	assert.match(f.render(), /tools done/);
	expectTime(f.render(), "2.5");
	t.mock.timers.tick(60_000);
	expectTime(f.render(false), "2.5");
	expectTime(f.render(), "2.5");
});

test("partial results keep counting until execution ends", async (t) => {
	const f = fixture(t);
	await f.start();
	f.tool.markExecutionStarted();
	t.mock.timers.tick(1000);
	f.tool.updateResult(result, true);
	expectTime(f.render(), "1.0");
	t.mock.timers.tick(2000);
	assert.match(f.render(), /tool calling/);
	expectTime(f.render(), "3.0");
	await f.end();
	f.tool.updateResult(result);
	t.mock.timers.tick(10_000);
	expectTime(f.render(), "3.0");
});

test("historical tools without timing remain unknown across repaints and Ctrl+O", (t) => {
	const f = fixture(t);
	f.tool.updateResult(result);
	const first = f.render();
	t.mock.timers.tick(60_000);
	assert.equal(f.render(), first);
	assert.match(first, /tools done/);
	assert.match(first, /\(—s\)/);
	assert.match(f.render(false), /\(—s\)/);
	assert.equal(f.render(), first);
});

test("an end event without a start does not invent historical timing", async (t) => {
	const f = fixture(t);
	await f.end();
	f.tool.updateResult(result);
	t.mock.timers.tick(5000);
	assert.match(f.render(), /\(—s\)/);
});

test("completed tools without an end timestamp show unknown until the end event", async (t) => {
	const f = fixture(t);
	await f.start();
	t.mock.timers.tick(2000);
	f.tool.updateResult(result);
	assert.match(f.render(), /\(—s\)/);
	await f.end();
	t.mock.timers.tick(5000);
	expectTime(f.render(), "2.0");
});

test("an end event stops timing before the final result reaches the renderer", async (t) => {
	const f = fixture(t);
	await f.start();
	f.tool.updateResult(result, true);
	t.mock.timers.tick(2000);
	await f.end();
	t.mock.timers.tick(5000);
	expectTime(f.render(), "2.0");
	f.tool.updateResult({ ...result, isError: true });
	expectTime(f.render(), "2.0");
	assert.match(f.render(), /✗ bash/);
});

test("pending tools without a start timestamp show unknown", (t) => {
	const f = fixture(t);
	f.tool.markExecutionStarted();
	assert.match(f.render(), /\(—s\)/);
	t.mock.timers.tick(5000);
	assert.match(f.render(), /\(—s\)/);
});

test("parallel group header uses wall-clock span and exposes failures while pending", async (t) => {
	const f = fixture(t);
	await f.start();
	f.tool.markExecutionStarted();
	const chat = new Container();
	const second = new ToolExecutionComponent("bash", `${t.name}-2`, { command: "false" }, {}, undefined, { requestRender() {} }, process.cwd());
	chat.addChild(second);
	const group = chat.children[0];
	group.addTool(f.tool);
	t.after(() => chat.clear());
	t.mock.timers.tick(1000);
	await handlers.get("tool_execution_start")({ toolCallId: `${t.name}-2` });
	second.markExecutionStarted();
	t.mock.timers.tick(2000);
	await handlers.get("tool_execution_end")({ toolCallId: `${t.name}-2` });
	second.updateResult({ ...result, isError: true });
	const render = () => chat.render(160).map(stripTerminalSequences).join("\n");
	assert.match(render(), /tool calling\.\.\. · 2 tools · 1 failed/);
	t.mock.timers.tick(2000);
	await f.end();
	f.tool.updateResult(result);
	assert.match(render(), /✗ tools done · 2 tools · 1 failed · 5\.0s/);
	t.mock.timers.tick(60_000);
	group.setExpanded(true);
	assert.match(render(), /✗ tools done · 2 tools · 1 failed · 5\.0s/);
});

test("partial error output remains pending and does not count as a final failure", async (t) => {
	const f = fixture(t);
	await f.start();
	f.tool.updateResult({ ...result, isError: true }, true);
	assert.match(f.render(), /tool calling/);
	assert.doesNotMatch(f.render(), /failed/);
});

test("summaries prefer final metadata, including zero counts", (t) => {
	const f = fixture(t);
	const cases = [
		["read", { lineCount: 0 }, "0 lines"],
		["read", { truncation: { outputLines: 20 } }, "20 lines shown"],
		["edit", { diff: "-1 old\n+1 new\n+2 next\n 3 context" }, "+2/-1"],
		["grep", { matchCount: 0 }, "0 matches"],
		["grep", { matchLimitReached: 100 }, "≥100 matches"],
		["web_search", { totalResults: 9, queryCount: 1, successfulQueries: 1 }, "9 results"],
		["web_search", { totalResults: 0, queryCount: 1, successfulQueries: 1 }, "0 results"],
		["web_search", { results: [{ url: "a" }, { url: "b" }] }, "2 results"],
		["bash", { exitCode: 0 }, "exit 0"],
	];
	for (const [name, details, expected] of cases) {
		f.tool.toolName = name;
		f.tool.args = { path: "file.ts", queries: ["alpha", "beta"] };
		f.tool.updateResult({ ...result, details });
		assert.ok(f.render().includes(expected), `${name}: ${f.render()}`);
		if (name === "web_search") assert.match(f.render(), /alpha; beta/);
		f.tool.updateResult({ ...result, details }, true);
		assert.ok(!f.render().includes(expected), `partial ${name}`);
		f.tool.updateResult(result);
		assert.ok(!f.render().includes(expected), `missing ${name}`);
	}
	f.tool.toolName = "bash";
	f.tool.updateResult({ ...result, isError: true, details: { exitCode: 7 } });
	assert.match(f.render(), /exit 7/);
	f.tool.updateResult({ ...result, details: { exitCode: "0" } });
	assert.doesNotMatch(f.render(), /exit 0/);
});

async function thinkingEvent(type, thinking = "Planning carefully", contentIndex = 0) {
	await handlers.get("message_update")({
		message: { role: "assistant", content: [{ type: "thinking", thinking }], usage: { reasoning: 120 } },
		assistantMessageEvent: { type, contentIndex, content: thinking },
	});
}

test("thinking duration freezes at thinking_end and survives sealing", async (t) => {
	const f = fixture(t);
	await handlers.get("message_start")({ message: { role: "assistant" } });
	await thinkingEvent("thinking_start");
	t.mock.timers.tick(1200);
	assert.match(f.render(), /0\.1K tok · 1\.2s/);
	await thinkingEvent("thinking_end");
	t.mock.timers.tick(10_000);
	assert.match(f.render(false), /0\.1K tok · 1\.2s/);
	await handlers.get("agent_end")({});
	t.mock.timers.tick(10_000);
	assert.match(f.render(), /0\.1K tok · 1\.2s/);
});

test("thinking error freezes observed time and multiple segments exclude gaps", async (t) => {
	const f = fixture(t);
	await handlers.get("message_start")({ message: { role: "assistant" } });
	await thinkingEvent("thinking_start");
	t.mock.timers.tick(1000);
	await thinkingEvent("thinking_end");
	t.mock.timers.tick(5000);
	await thinkingEvent("thinking_start");
	t.mock.timers.tick(2000);
	await thinkingEvent("error");
	t.mock.timers.tick(5000);
	assert.match(f.render(), /tok · 3\.0s/);
	await handlers.get("message_start")({ message: { role: "assistant" } });
	await thinkingEvent("thinking_start");
	t.mock.timers.tick(500);
	await thinkingEvent("thinking_end");
	assert.match(f.render(), /tok · 0\.5s/);
});

test("thinking with only an end event has unknown duration", async (t) => {
	const f = fixture(t);
	await handlers.get("message_start")({ message: { role: "assistant" } });
	await thinkingEvent("thinking_end");
	assert.match(f.render(), /tok · —s/);
});

test("standalone compress keeps frozen execution timing", async (t) => {
	const f = fixture(t, "compress");
	await f.start();
	f.tool.markExecutionStarted();
	t.mock.timers.tick(2500);
	await f.end();
	f.tool.updateResult({ content: [{ type: "text", text: "1000 → 500 tokens" }] });
	t.mock.timers.tick(10_000);
	assert.match(f.render(), /2\.5s/);
	t.mock.timers.tick(60_000);
	assert.match(f.render(false), /2\.5s/);
});

test("shared header uses error color for mixed and all-failed groups, including collapsed hidden failures", (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: clockStart });
	const state = {
		tools: [
			{ id: "failed", name: "bash", args: {}, status: "error", resultText: "", startedAt: 1000, endedAt: 2000 },
			{ id: "ok", name: "bash", args: {}, status: "success", resultText: "", startedAt: 1000, endedAt: 3000 },
			{ id: "running", name: "bash", args: {}, status: "pending", resultText: "", startedAt: 2000 },
		],
		thinking: "", thinkingActive: false, sealed: true,
	};
	const component = new CompactExternalGroupComponent(state, { fg: (color, text) => `[${color}]${text}[/${color}]` });
	assert.match(component.render(200)[0], /\[error\].*tool calling\.\.\. · 3 tools · 1 failed/);
	state.tools[2].status = "success";
	state.tools[2].endedAt = 5000;
	assert.match(component.render(200)[0], /\[error\]✗ tools done · 3 tools · 1 failed · 4\.0s/);
	component.setExpanded(true);
	assert.match(component.render(200)[0], /\[error\]✗ tools done · 3 tools · 1 failed · 4\.0s/);
	for (const tool of state.tools) tool.status = "error";
	assert.match(component.render(200)[0], /3 tools · 3 failed · 4\.0s/);
	delete state.tools[0].endedAt;
	assert.match(component.render(200)[0], /3 failed · —s/);
});

test("external completed tool and thinking timing stay unknown without end metadata", (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: clockStart });
	const state = {
		tools: [{ id: "old", name: "read", args: { path: "file" }, status: "success", resultText: "", startedAt: 1000 }],
		thinking: "Planning", thinkingActive: false, sealed: true, thinkingStartedAt: 1000,
	};
	const component = new CompactExternalGroupComponent(state, {});
	const first = component.render(160);
	assert.match(first.join("\n"), /tok · —s/);
	t.mock.timers.tick(60_000);
	assert.deepEqual(component.render(160), first);
	state.thinkingEndedAt = 2500;
	assert.match(component.render(160).join("\n"), /tok · 1\.5s/);
});

test("text boundary freezes thinking even when no thinking_end arrives", async (t) => {
	const f = fixture(t);
	await handlers.get("message_start")({ message: { role: "assistant" } });
	await thinkingEvent("thinking_start");
	t.mock.timers.tick(1500);
	await handlers.get("message_update")({
		message: { role: "assistant", content: [{ type: "text", text: "Answer" }] },
		assistantMessageEvent: { type: "text_delta", contentIndex: 0 },
	});
	t.mock.timers.tick(60_000);
	assert.match(f.render(), /tok · 1\.5s/);
	await handlers.get("message_start")({ message: { role: "user" } });
	assert.match(f.render(false), /tok · 1\.5s/);
});

function textResult(text, extra = {}) {
	return { content: [{ type: "text", text }], isError: false, ...extra };
}

test("native read counts displayed lines and strips only the exact appended footer", (t) => {
	const f = fixture(t, "read");
	const cases = [
		["alpha\nbeta", 2],
		["alpha\n", 2],
		["", 1],
		["alpha\nbeta\n\n[18 more lines in file. Use offset=3 to continue.]", 2],
		["alpha\n\n[18 more lines in file. Use offset=3 to continue.]\nfile content", 4],
		["alpha\n\n[18 more lines in file. Use offset=3 to continue!]", 3],
		["alpha\n\n[18 more lines in file. Use offset=3 to continue.]\n", 4],
		["# Heading\n\n- actual file contents", 3],
	];
	for (const [text, lines] of cases) {
		f.tool.updateResult(textResult(text));
		assert.ok(f.render(false).includes(`· ${lines} lines shown`), JSON.stringify(text));
	}
	f.tool.updateResult({ content: [{ type: "text", text: "alpha" }, { type: "text", text: "beta" }] });
	assert.match(f.render(false), /· 2 lines shown/);
	f.tool.updateResult(textResult("alpha\nbeta", { details: { lineCount: 99, truncation: { outputLines: 1 } } }));
	assert.match(f.render(false), /· 1 lines shown/);
});

test("read skips image notes, failures and oversized-line diagnostics, while respecting zero metadata", (t) => {
	const f = fixture(t, "read");
	const diagnostic = "[Line 1 is 80KB, exceeds 50KB limit. Use bash: sed -n '1p' file.txt | head -c 51200]";
	const cases = [
		textResult("Read image file [image/png]\nImage resized"),
		{ content: [{ type: "text", text: "Image attached" }, { type: "image", data: "", mimeType: "image/png" }] },
		{ content: [{ type: "image", data: "", mimeType: "image/png" }] },
		textResult(diagnostic),
		textResult("Error: permission denied", { isError: true }),
		{ content: [] },
	];
	for (const value of cases) {
		f.tool.updateResult(value);
		assert.doesNotMatch(f.render(false), /· \d+ lines/);
	}
	f.tool.updateResult(textResult(diagnostic, { details: { truncation: { outputLines: 0 } } }));
	assert.match(f.render(false), /· 0 lines shown/);
	f.tool.updateResult(textResult("alpha\nbeta"), true);
	assert.doesNotMatch(f.render(false), /· \d+ lines/);
});

test("native grep counts unique matching file lines, excluding overlapping context", (t) => {
	const f = fixture(t, "grep");
	const text = "src/a.ts-1- before:99: nested format\nsrc/a.ts:2: hit:99: payload\nsrc/a.ts-3- hit too\nsrc/a.ts-2- hit\nsrc/a.ts:3: hit too\nsrc/a.ts:2: duplicate\nsrc/b.ts:2: hit\nsrc/b.ts-3- after";
	f.tool.updateResult(textResult(text));
	assert.match(f.render(false), /· 3 matches/);
	f.tool.updateResult(textResult(text, { details: { truncation: { truncated: true } } }));
	assert.match(f.render(false), /· 3 matches shown/);
	f.tool.updateResult(textResult(text, { details: { matchLimitReached: 100, matchCount: 3, truncation: { truncated: true } } }));
	assert.match(f.render(false), /· ≥100 matches/);
	f.tool.updateResult(textResult("No matches found"));
	assert.match(f.render(false), /· 0 matches/);
	for (const unknown of ["# Results\n- alpha\n- beta", "No matches found\n", "src/a.ts-2- context only", ""]) {
		f.tool.updateResult(textResult(unknown));
		assert.doesNotMatch(f.render(false), /· \d+ matches/);
	}
	f.tool.updateResult(textResult(text, { isError: true }));
	assert.doesNotMatch(f.render(false), /· \d+ matches/);
	f.tool.updateResult(textResult(text), true);
	assert.doesNotMatch(f.render(false), /· \d+ matches/);
});

test("native bash exit parsing requires an exact final error status", (t) => {
	const f = fixture(t);
	for (const text of ["Command exited with code 7", "failure output\n\nCommand exited with code 7"]) {
		f.tool.updateResult(textResult(text, { isError: true }));
		assert.match(f.render(false), /· exit 7/);
	}
	for (const text of ["Command timed out after 10 seconds", "Command aborted", "Command exited with code 7\n", "Command exited with code 7\n\nmore output", "prefix Command exited with code 7", "Command exited with code 0"]) {
		f.tool.updateResult(textResult(text, { isError: true }));
		assert.doesNotMatch(f.render(false), /· exit /);
	}
	f.tool.updateResult(textResult("Command exited with code 7"));
	assert.doesNotMatch(f.render(false), /· exit /);
	f.tool.updateResult(textResult("(no output)"));
	assert.doesNotMatch(f.render(false), /· exit 0/);
	f.tool.updateResult(textResult("Command exited with code 7", { isError: true, details: { exitCode: 2 } }));
	assert.match(f.render(false), /· exit 2/);
	f.tool.updateResult(textResult("Command exited with code 7", { isError: true }), true);
	assert.doesNotMatch(f.render(false), /· exit /);
});

test("external groups summarize native text but do not count web search prose", () => {
	const state = {
		tools: [{ id: "text", name: "read", args: {}, status: "success", resultText: "alpha\nbeta", startedAt: 0, endedAt: 1000 }],
		thinking: "", thinkingActive: false, sealed: true,
	};
	const component = new CompactExternalGroupComponent(state, {});
	assert.match(component.render(160).join("\n"), /· 2 lines shown/);
	state.tools[0].name = "grep";
	state.tools[0].resultText = "a.ts:1: hit\na.ts-2- context";
	assert.match(component.render(160).join("\n"), /· 1 matches/);
	state.tools[0].name = "bash";
	state.tools[0].status = "error";
	state.tools[0].resultText = "Command exited with code 7";
	assert.match(component.render(160).join("\n"), /· exit 7/);
	state.tools[0].name = "web_search";
	state.tools[0].status = "success";
	state.tools[0].resultText = "Found 12 results\n- https://example.com";
	assert.doesNotMatch(component.render(160).join("\n"), /· \d+ results/);
});

test("standalone compress keeps the sealed thinking snapshot out of later groups", async (t) => {
	const f = fixture(t);
	await handlers.get("message_start")({ message: { role: "assistant" } });
	await thinkingEvent("thinking_start", "Before compression");
	t.mock.timers.tick(1500);
	const compress = new ToolExecutionComponent("compress", `${t.name}-compress`, {}, {}, undefined, { requestRender() {} }, process.cwd());
	f.chat.addChild(compress);
	const nextTool = new ToolExecutionComponent("bash", `${t.name}-next`, {}, {}, undefined, { requestRender() {} }, process.cwd());
	f.chat.addChild(nextTool);
	const nextGroup = f.chat.children.at(-1);
	nextGroup.setExpanded(true);
	assert.doesNotMatch(nextGroup.render(160).join("\n"), /thinking|Before compression/);
	assert.match(f.render(), /tok · 1\.5s/);
	await thinkingEvent("thinking_start", "After compression");
	t.mock.timers.tick(500);
	await thinkingEvent("thinking_end", "After compression");
	const newView = nextGroup.render(160).map(stripTerminalSequences).join("\n");
	assert.match(newView, /After compression/);
	assert.match(newView, /tok · 0\.5s/);
	assert.doesNotMatch(newView, /Before compression/);
	assert.equal((f.render().match(/Before compression/g) ?? []).length, 1);
});

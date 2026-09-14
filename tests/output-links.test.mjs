import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { Container, getCapabilities, setCapabilities, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { loadExtension } from "./load-extension.mjs";

const requireFromPi = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const { initTheme } = requireFromPi(fileURLToPath(new URL("./modes/interactive/theme/theme.js", import.meta.resolve("@earendil-works/pi-coding-agent"))));
initTheme("dark");
const { default: install, linkErrorLocation, fullOutputEntry, CompactExternalGroupComponent } = await loadExtension();
install({ on() {}, registerTool() {}, registerCommand() {} });

function links(t, enabled = true) {
	const previous = { ...getCapabilities() };
	setCapabilities({ ...previous, hyperlinks: enabled });
	t.after(() => setCapabilities(previous));
}

function group(t, result, name = "bash", partial = false) {
	const chat = new Container();
	const tool = new ToolExecutionComponent(name, t.name, {}, {}, undefined, { requestRender() {} }, "/tmp/project");
	chat.addChild(tool);
	tool.updateResult(result, partial);
	t.after(() => chat.clear());
	return (expanded, width = 120) => {
		chat.children[0].setExpanded(expanded);
		return chat.render(width);
	};
}

function assertClosed(rows) {
	for (const row of rows) {
		const opens = (row.match(/\x1b\]8;;file:/g) ?? []).length;
		const closes = (row.match(/\x1b\]8;;\x1b\\/g) ?? []).length;
		assert.equal(opens, closes, "Each row must close every file hyperlink");
	}
}

test("leading compiler locations link to files and preserve visible line/column", (t) => {
	links(t);
	for (const [text, url] of [
		["src/app.ts(42,7): error TS2322: mismatch", "file:///tmp/project/src/app.ts"],
		["src/app.ts:42:7: error: mismatch", "file:///tmp/project/src/app.ts"],
		["/tmp/my project/中文.ts:42:7: error", "file:///tmp/my%20project/%E4%B8%AD%E6%96%87.ts"],
		["./my project/app.ts(4,2): error", "file:///tmp/project/my%20project/app.ts"],
	]) {
		const row = linkErrorLocation(text, "/tmp/project");
		assert.ok(row.includes(`\x1b]8;;${url}\x1b\\`));
		assert.equal(stripTerminalSequences(row), text);
		assertClosed([row]);
	}
});

test("ambiguous text, URLs, missing cwd and unsupported terminals stay plain", (t) => {
	links(t);
	for (const text of ["https://example.com/app.ts:42:7", "node:internal/process:42:7", "error at src/app.ts:42:7", "127.0.0.1:8080", "file.ts:0:1"]) {
		assert.equal(linkErrorLocation(text, "/tmp/project"), text);
	}
	assert.equal(linkErrorLocation("src/app.ts:42:7"), "src/app.ts:42:7");
	setCapabilities({ ...getCapabilities(), hyperlinks: false });
	assert.equal(linkErrorLocation("src/app.ts:42:7", "/tmp/project"), "src/app.ts:42:7");
	assert.equal(fullOutputEntry("bash", { fullOutputPath: "/tmp/full log.txt" }), "Full output: /tmp/full log.txt");
});

test("log entries use only valid Bash metadata and known cwd", (t) => {
	links(t);
	for (const details of [undefined, {}, { fullOutputPath: 123 }, { fullOutputPath: "" }, { fullOutputPath: "/tmp/a\nwrong" }, { fullOutputPath: "https://example.com/log" }]) {
		assert.equal(fullOutputEntry("bash", details, "/tmp/project"), undefined);
	}
	assert.equal(fullOutputEntry("read", { fullOutputPath: "/tmp/log" }), undefined);
	assert.equal(fullOutputEntry("bash", { fullOutputPath: "log.txt" }), undefined);
	assert.match(fullOutputEntry("bash", { fullOutputPath: "log.txt" }, "/tmp/project"), /file:\/\/\/tmp\/project\/log.txt/);
});

test("failed main tool locations remain clickable in collapsed and expanded rows", (t) => {
	links(t);
	const render = group(t, { isError: true, content: [{ type: "text", text: "src/app.ts(42,7): error TS2322: mismatch" }] });
	for (const expanded of [false, true]) {
		const rows = render(expanded);
		assert.match(rows.join("\n"), /\x1b\]8;;file:\/\/\/tmp\/project\/src\/app.ts/);
		assertClosed(rows);
	}
});

test("successful and partial output is not promoted to error location links", (t) => {
	links(t);
	const render = group(t, { content: [{ type: "text", text: "src/app.ts(42,7): error example in a successful command" }] });
	assert.doesNotMatch(render(true).join("\n"), /\x1b\]8;;file:/);
	const pending = group(t, { isError: true, content: [{ type: "text", text: "src/app.ts(42,7): error in partial output" }] }, "bash", true);
	assert.doesNotMatch(pending(true).join("\n"), /\x1b\]8;;file:/);
});

test("full log entry survives preview truncation and narrow redraws", (t) => {
	links(t);
	const render = group(t, {
		content: [{ type: "text", text: Array.from({ length: 100 }, (_, n) => `output ${n}`).join("\n") }],
		details: { fullOutputPath: "/tmp/full log.txt", truncation: { truncated: true } },
	});
	const rows = render(true);
	assert.match(rows.map(stripTerminalSequences).join("\n"), /…\n.*Full output: \/tmp\/full log.txt/);
	assert.match(rows.join("\n"), /file:\/\/\/tmp\/full%20log.txt/);
	for (const width of [1, 12, 28, 80]) {
		const narrow = render(true, width);
		assert.ok(narrow.every((line) => visibleWidth(line) <= width));
		assertClosed(narrow);
	}
});

test("external transcripts resolve links only with their own cwd", (t) => {
	links(t);
	const tool = { id: "one", name: "bash", args: {}, status: "error", startedAt: 0, endedAt: 1, resultText: "src/app.ts:4:2: error", resultDetails: { fullOutputPath: "/tmp/external.log" } };
	const state = { tools: [tool], thinking: "", thinkingActive: false, sealed: true };
	const component = new CompactExternalGroupComponent(state, { fg: (_color, text) => text, bold: (text) => text });
	component.setExpanded(true);
	assert.doesNotMatch(component.render(120).join("\n"), /file:.*src\/app.ts/);
	assert.match(component.render(120).join("\n"), /file:\/\/\/tmp\/external.log/);
	tool.cwd = "/tmp/agent";
	assert.match(component.render(120).join("\n"), /file:\/\/\/tmp\/agent\/src\/app.ts/);
	assertClosed(component.render(120));
});

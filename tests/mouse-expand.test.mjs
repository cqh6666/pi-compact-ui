import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, stripTerminalSequences } from "@earendil-works/pi-tui";
import { loadExtension } from "./load-extension.mjs";

const requireFromPi = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const { initTheme } = requireFromPi(fileURLToPath(new URL("./modes/interactive/theme/theme.js", import.meta.resolve("@earendil-works/pi-coding-agent"))));
initTheme("dark");
const { default: install, CompactExternalGroupComponent } = await loadExtension();
const api = { on() {}, registerTool() {}, registerCommand() {} };
install(api);

function mouse(x, y, overrides = {}) {
	return { type: "click", button: "left", clickCount: 1, x, y, screenX: x, screenY: y,
		width: 80, height: 24, shift: false, alt: false, ctrl: false, ...overrides };
}

function tool(name, id, args = {}) {
	const component = new ToolExecutionComponent(name, id, args, {}, undefined, { requestRender() {} }, "/tmp");
	component.updateResult({ content: [{ type: "text", text: "Result detail line one\nResult detail line two" }], details: { runId: id } });
	return component;
}

function plain(component, width = 80) {
	return component.render(width).map(stripTerminalSequences).join("\n");
}

test("top-level groups toggle only on title text and leave sibling groups independent", (t) => {
	const chat = new Container();
	t.after(() => chat.clear());
	chat.addChild(tool("read", "mouse-read", { path: "/tmp/read.txt" }));
	const first = chat.children[0];
	first.seal();
	chat.addChild(tool("bash", "mouse-bash", { command: "pwd" }));
	const second = chat.children[1];
	assert.notEqual(first, second);
	assert.doesNotMatch(plain(chat), /Result detail/);
	for (const event of [mouse(2, 0), mouse(0, 1), mouse(79, 1), mouse(2, 2),
		mouse(2, 1, { type: "press" }), mouse(2, 1, { type: "drag" }),
		mouse(2, 1, { type: "release" }), mouse(2, 1, { type: "wheel", wheelDelta: 1 }),
		mouse(2, 1, { button: "right" }), mouse(2, 1, { clickCount: 2 }), mouse(2, 1, { shift: true })]) {
		assert.equal(chat.handleMouse(event), undefined);
		assert.equal(first.expanded, false);
	}
	const result = chat.handleMouse(mouse(2, 1));
	assert.equal(result.handled, true);
	assert.equal(result.render, true);
	assert.equal(result.focus, undefined);
	assert.equal(first.expanded, true);
	assert.equal(second.expanded, false);
	assert.match(plain(chat), /Result detail/);
	chat.handleMouse(mouse(2, 1));
	assert.equal(first.expanded, false);
	for (const group of chat.children) group.setExpanded(true);
	assert.equal(first.expanded, true);
	assert.equal(second.expanded, true);
	for (const group of chat.children) group.setExpanded(false);
	assert.doesNotMatch(plain(chat), /Result detail/);
});

test("nested anchored groups use the visible title row after preceding content changes and resize", (t) => {
	const chat = new Container();
	t.after(() => chat.clear());
	chat.addChild(tool("read", "mouse-anchor", { path: "/tmp/anchor.txt" }));
	const group = chat.children[0];
	group.anchored = true;
	const parent = new Container();
	const prefix = new Spacer(3);
	parent.addChild(prefix);
	parent.addChild(chat);
	parent.render(80);
	assert.equal(parent.handleMouse(mouse(2, 2)), undefined);
	assert.equal(parent.handleMouse(mouse(2, 3)).handled, true);
	assert.equal(group.expanded, true);
	parent.removeChild(prefix);
	parent.render(12);
	assert.equal(parent.handleMouse(mouse(2, 0, { width: 12 })).handled, true);
	assert.equal(group.expanded, false);
	parent.render(1);
	assert.equal(parent.handleMouse(mouse(0, 0, { width: 1 })).handled, true);
	assert.equal(group.expanded, true);
});

test("external transcript groups expand through Container dispatch without consuming body clicks", () => {
	const group = new CompactExternalGroupComponent({
		tools: [{ id: "ext-click", name: "read", args: { path: "/tmp/a" }, status: "success",
			startedAt: 1, endedAt: 2, resultText: "External result detail" }],
		thinking: "", thinkingActive: false, sealed: true,
	}, { fg: (_color, text) => text, bold: (text) => text });
	const parent = new Container();
	parent.addChild(new Spacer(2));
	parent.addChild(group);
	assert.doesNotMatch(plain(parent), /External result detail/);
	assert.equal(parent.handleMouse(mouse(2, 2)).handled, true);
	assert.match(plain(parent), /External result detail/);
	assert.equal(parent.handleMouse(mouse(2, 4)), undefined);
	group.setExpanded(false);
	assert.doesNotMatch(plain(parent), /External result detail/);
});

test("standalone delegate title toggles both halves of a paired card", () => {
	const delegate = tool("acp_delegate", "mouse-pair", { agent: "worker", task: "Inspect files" });
	const wait = tool("acp_delegate_wait", "mouse-wait", { runId: "mouse-pair" });
	delegate.render(80);
	assert.deepEqual(wait.render(80), []);
	wait.setExpanded(true);
	assert.match(plain(delegate), /Result detail/);
	assert.equal(delegate.handleMouse(mouse(2, 0)), undefined);
	assert.equal(delegate.handleMouse(mouse(0, 1)), undefined);
	assert.equal(delegate.handleMouse(mouse(2, 2)), undefined);
	assert.equal(delegate.handleMouse(mouse(2, 1)).handled, true);
	assert.equal(delegate.expanded, false);
	assert.equal(wait.expanded, false);
	assert.doesNotMatch(plain(delegate), /Result detail/);
	assert.equal(delegate.handleMouse(mouse(2, 1)).handled, true);
	assert.equal(delegate.expanded, true);
	assert.equal(wait.expanded, true);
	assert.match(plain(delegate), /Result detail/);
	assert.equal(wait.handleMouse(mouse(2, 1)), undefined, "hidden paired card has no hit area");
	delegate.setExpanded(false);
	wait.setExpanded(false);
	assert.doesNotMatch(plain(delegate), /Result detail/);
});

test("static compress cards ignore clicks instead of routing to hidden native children", () => {
	const compress = tool("compress", "mouse-compress", { content: [] });
	compress.render(80);
	for (const y of [0, 1, 2]) assert.equal(compress.handleMouse(mouse(2, y)), undefined);
	assert.equal(compress.expanded, false);
});

test("reinstall upgrades an already-loaded render wrapper to record clickable titles", (t) => {
	const prototype = ToolExecutionComponent.prototype;
	const key = Symbol.for("pi-compact-ui.tool-render-patch");
	const savedRender = prototype.render;
	const savedPatch = prototype[key];
	t.after(() => { prototype.render = savedRender; prototype[key] = savedPatch; });
	const legacyRender = function () { return ["", " legacy card"]; };
	legacyRender[Symbol.for("pi-compact-ui.tool-execution-wrapped-render")] = true;
	prototype.render = legacyRender;
	delete prototype[key];
	install(api);
	const delegate = tool("subagent", "mouse-upgrade", { agent: "worker", task: "Upgrade" });
	assert.match(plain(delegate), /Upgrade/);
	assert.equal(delegate.handleMouse(mouse(2, 1)).handled, true);
	assert.equal(delegate.expanded, true);
});

test("reinstall keeps one mouse wrapper and forwards untouched tools to their native handler", () => {
	const delegate = tool("subagent", "mouse-reload", { agent: "reviewer", task: "Review" });
	plain(delegate);
	const prototype = ToolExecutionComponent.prototype;
	const patchKey = Symbol.for("pi-compact-ui.tool-mouse-patch");
	const original = prototype[patchKey].original;
	install(api);
	install(api);
	assert.equal(prototype[patchKey].original, original);
	assert.equal(delegate.handleMouse(mouse(2, 1)).handled, true);
	assert.equal(delegate.expanded, true);
	plain(delegate);
	assert.equal(delegate.handleMouse(mouse(2, 1)).handled, true);
	assert.equal(delegate.expanded, false);

	const native = tool("custom_native", "mouse-native");
	const lines = native.render(80).map(stripTerminalSequences);
	const row = lines.findIndex((line) => line.includes("Result detail"));
	assert.ok(row >= 0);
	assert.equal(native.expanded, false);
	assert.equal(native.handleMouse(mouse(2, row)).handled, true);
	assert.equal(native.expanded, true);
});

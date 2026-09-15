import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { AssistantMessageComponent, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { loadExtension } from "./load-extension.mjs";

const requireFromPi = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const theme = requireFromPi(fileURLToPath(new URL("./modes/interactive/theme/theme.js", import.meta.resolve("@earendil-works/pi-coding-agent"))));
theme.initTheme("dark");
// Match Pi's extension loader: the host and extension must share TUI classes.
const { Container, Spacer, stripTerminalSequences } = requireFromPi("@earendil-works/pi-tui");
const { default: install } = await loadExtension({ alias: {
	"@earendil-works/pi-tui": requireFromPi.resolve("@earendil-works/pi-tui"),
} });
const handlers = new Map();
install({ on: (name, handler) => handlers.set(name, handler), registerTool() {}, registerCommand() {} });
const parentKey = Symbol.for("compact-ui.group-parent");

async function fixture(t, expanded = false) {
	const chat = new Container();
	const ui = { theme: theme.theme, getToolsExpanded: () => expanded, setHiddenThinkingLabel() {}, setWidget() {} };
	await handlers.get("session_start")({}, { ui });
	await handlers.get("message_start")({ message: { role: "user" } });
	t.after(async () => { await handlers.get("agent_end")(); chat.clear(); });
	return { chat, setGlobal(value) {
		expanded = value;
		for (const child of chat.children) child.setExpanded?.(value);
	} };
}

function addTool(chat, id, expanded = false) {
	const tool = new ToolExecutionComponent("read", id, { path: `/tmp/${id}` }, {}, undefined, { requestRender() {} }, "/tmp");
	tool.updateResult({ content: [{ type: "text", text: `${id} preview\nMore output` }] });
	tool.setExpanded(expanded);
	chat.addChild(tool);
	return tool;
}

function click(component, text, offsetX = 0, offsetY = 0) {
	const rows = component.render(80).map(stripTerminalSequences);
	const y = rows.findIndex((row) => row.includes(text));
	assert.ok(y >= 0, text);
	return component.handleMouse({ type: "click", button: "left", clickCount: 1, x: 5, y,
		screenX: 5 + offsetX, screenY: y + offsetY, width: 80, height: rows.length,
		shift: false, alt: false, ctrl: false });
}

async function anchorGroup(chat, group) {
	await handlers.get("message_start")({ message: { role: "assistant" } });
	const assistant = new AssistantMessageComponent();
	chat.addChild(assistant);
	const message = { role: "assistant", content: [{ type: "text", text: "Following explanation" }] };
	assistant.updateContent(message);
	await handlers.get("message_update")({ message, assistantMessageEvent: { type: "text_delta", contentIndex: 0 } });
	assert.ok(assistant.contentContainer.children.includes(group));
	return { assistant, message };
}

test("mouse dispatch retains screen origins through nested containers", async (t) => {
	const { chat } = await fixture(t);
	addTool(chat, "origin");
	const group = chat.children[0];
	const outer = new Container();
	outer.addChild(new Spacer(3));
	outer.addChild(chat);
	const result = click(outer, "tools done", 7, 11);
	assert.equal(result.target.component, group);
	assert.equal(result.target.originX, 7);
	assert.equal(result.target.originY, 14);
});

test("visibility keeps previews cached while content, width and invalidation refresh them", async (t) => {
	const { chat } = await fixture(t, true);
	const first = addTool(chat, "cache-first", true);
	addTool(chat, "cache-second", true);
	const group = chat.children[0];
	chat.render(80);
	const cached = group.markdownPreviewCache.get("tool:cache-second");
	assert.ok(cached);
	click(chat, "/tmp/cache-first");
	chat.render(80);
	assert.equal(group.markdownPreviewCache.get("tool:cache-second"), cached);
	click(chat, "tools done");
	click(chat, "tools done");
	chat.render(80);
	assert.equal(group.markdownPreviewCache.get("tool:cache-second"), cached);
	group.setExpanded(true);
	chat.render(80);
	assert.equal(group.markdownPreviewCache.get("tool:cache-second"), cached);
	first.updateResult({ content: [{ type: "text", text: "Changed preview" }] });
	assert.match(chat.render(80).map(stripTerminalSequences).join("\n"), /Changed preview/);
	assert.equal(group.markdownPreviewCache.get("tool:cache-second"), cached);
	chat.render(40);
	assert.notEqual(group.markdownPreviewCache.get("tool:cache-second"), cached);
	group.invalidate();
	assert.equal(group.markdownPreviewCache.size, 0);
});

test("new groups inherit current global expansion instead of a previous group's local choice", async (t) => {
	const { chat, setGlobal } = await fixture(t);
	addTool(chat, "global-first");
	const first = chat.children[0];
	setGlobal(true);
	click(chat, "tools done");
	assert.equal(first.expanded, false);
	first.seal();
	addTool(chat, "global-second", true);
	const second = chat.children[1];
	assert.equal(second.expanded, true);
	setGlobal(false);
	second.seal();
	addTool(chat, "global-third");
	assert.equal(chat.children[2].expanded, false);
});

test("thinking-only groups inherit global expansion and forward global changes after anchoring", async (t) => {
	const { chat, setGlobal } = await fixture(t, true);
	await handlers.get("message_start")({ message: { role: "assistant" } });
	const assistant = new AssistantMessageComponent();
	chat.addChild(assistant);
	const message = { role: "assistant", content: [{ type: "thinking", thinking: "Thinking preview" }] };
	await handlers.get("message_update")({ message, assistantMessageEvent: { type: "thinking_delta", contentIndex: 0 } });
	const group = chat.children[1];
	assert.equal(group.expanded, true);
	const onlyTool = addTool(chat, "thinking-tool", true);
	chat.removeChild(onlyTool);
	assert.ok(chat.children.includes(group), "thinking remains after the last tool is removed");
	message.content.push({ type: "text", text: "Following explanation" });
	assistant.updateContent(message);
	await handlers.get("message_update")({ message, assistantMessageEvent: { type: "text_delta", contentIndex: 1 } });
	assert.ok(assistant.contentContainer.children.includes(group));
	setGlobal(false);
	assert.equal(group.expanded, false);
	click(chat, "tools done");
	assert.equal(group.expanded, true);
	setGlobal(true);
	assert.equal(group.expanded, true);
});

test("removing grouped tools clears their state and removes the last empty group", async (t) => {
	const { chat } = await fixture(t, true);
	const first = addTool(chat, "remove-first", true);
	const second = addTool(chat, "remove-second", true);
	const group = chat.children[0];
	click(chat, "/tmp/remove-first");
	const unrelated = new Container();
	unrelated.removeChild(first);
	assert.equal(group.children.length, 2);
	chat.removeChild(first);
	assert.deepEqual(group.children, [second]);
	assert.equal(first[parentKey], undefined);
	assert.equal(group.markdownPreviewCache.has("tool:remove-first"), false);
	group.addTool(first);
	assert.match(chat.render(80).map(stripTerminalSequences).join("\n"), /remove-first preview/);
	chat.removeChild(first);
	chat.removeChild(second);
	assert.equal(chat.children.length, 0);
	assert.equal(second[parentKey], undefined);
});

test("removing an anchored tool cannot resurrect its group on assistant rebuild", async (t) => {
	const { chat } = await fixture(t);
	const tool = addTool(chat, "remove-anchor");
	const group = chat.children[0];
	const { assistant, message } = await anchorGroup(chat, group);
	chat.removeChild(tool);
	assert.equal(tool[parentKey], undefined);
	assert.ok(!assistant.contentContainer.children.includes(group));
	assistant.updateContent(message);
	assert.ok(!assistant.contentContainer.children.includes(group));
});

test("clearing chat releases anchored and top-level tools", async (t) => {
	const { chat } = await fixture(t);
	const anchoredTool = addTool(chat, "clear-anchor");
	await anchorGroup(chat, chat.children[0]);
	const liveTool = addTool(chat, "clear-live");
	chat.clear();
	assert.equal(anchoredTool[parentKey], undefined);
	assert.equal(liveTool[parentKey], undefined);
	addTool(chat, "after-clear");
	assert.equal(chat.children.length, 1);
	assert.equal(chat.children[0].children.length, 1);
});

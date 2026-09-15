import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { Container, stripTerminalSequences } from "@earendil-works/pi-tui";
import { loadExtension } from "./load-extension.mjs";

const requireFromPi = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const { initTheme } = requireFromPi(fileURLToPath(new URL("./modes/interactive/theme/theme.js", import.meta.resolve("@earendil-works/pi-coding-agent"))));
initTheme("dark");
const { default: install, CompactExternalGroupComponent } = await loadExtension();
install({ on() {}, registerTool() {}, registerCommand() {} });

function rows(component, width = 80) {
	return component.render(width).map(stripTerminalSequences);
}

function click(component, title, width = 80, overrides = {}) {
	const lines = rows(component, width);
	const y = lines.findIndex((line) => line.includes(title));
	assert.ok(y >= 0, `Missing title: ${title}`);
	return component.handleMouse({ type: "click", button: "left", clickCount: 1, x: 5, y,
		screenX: 5, screenY: y, width, height: lines.length,
		shift: false, alt: false, ctrl: false, ...overrides });
}

function addRead(chat, name) {
	const tool = new ToolExecutionComponent("read", name, { path: `/tmp/${name}` }, {}, undefined, { requestRender() {} }, "/tmp");
	tool.updateResult({ content: [{ type: "text", text: `${name} output\n${name} second line` }] });
	chat.addChild(tool);
	return tool;
}

for (const anchored of [false, true]) {
	test(`individual tools retain selection across group toggles (${anchored ? "anchored" : "top-level"})`, (t) => {
		const chat = new Container();
		t.after(() => chat.clear());
		addRead(chat, "first");
		addRead(chat, "second");
		const group = chat.children[0];
		group.anchored = anchored;
		assert.equal(chat.children.length, 1);
		click(chat, "tools done");
		assert.match(rows(chat).join("\n"), /first output/);
		assert.match(rows(chat).join("\n"), /second output/);
		assert.equal(click(chat, "/tmp/first").handled, true);
		assert.doesNotMatch(rows(chat).join("\n"), /first output/);
		assert.match(rows(chat).join("\n"), /second output/);
		assert.equal(click(chat, "second output"), undefined);
		assert.equal(click(chat, "/tmp/second", 80, { type: "drag" }), undefined);
		assert.match(rows(chat).join("\n"), /second output/);
		click(chat, "tools done");
		click(chat, "tools done");
		assert.doesNotMatch(rows(chat).join("\n"), /first output/);
		assert.match(rows(chat).join("\n"), /second output/);
		assert.equal(click(chat, "/tmp/sec", 22).handled, true);
		assert.doesNotMatch(rows(chat).join("\n"), /second output/);
		click(chat, "/tmp/first");
		assert.match(rows(chat).join("\n"), /first output/);
		assert.doesNotMatch(rows(chat).join("\n"), /second output/);
		addRead(chat, "third");
		assert.match(rows(chat).join("\n"), /third output/);
		assert.doesNotMatch(rows(chat).join("\n"), /second output/);
		group.setExpanded(true);
		assert.match(rows(chat).join("\n"), /second output/);
		click(chat, "/tmp/second");
		group.setExpanded(false);
		click(chat, "tools done");
		assert.match(rows(chat).join("\n"), /second output/);
	});
}

test("external groups preserve per-tool choices by id and reset them with global expansion", () => {
	const state = {
		tools: ["first", "second"].map((id) => ({ id, name: "read", args: { path: `/tmp/${id}` },
			status: "success", startedAt: 1, endedAt: 2, resultText: `${id} output` })),
		thinking: "Reasoning remains visible", thinkingActive: false, sealed: true,
	};
	const group = new CompactExternalGroupComponent(state, { fg: (_color, text) => text, bold: (text) => text });
	const parent = new Container();
	parent.addChild(group);
	click(parent, "tools done");
	click(parent, "/tmp/first");
	assert.doesNotMatch(rows(parent).join("\n"), /first output/);
	assert.match(rows(parent).join("\n"), /second output/);
	assert.match(rows(parent).join("\n"), /Reasoning remains visible/);
	state.tools = state.tools.map((tool) => ({ ...tool, resultText: `${tool.id} output updated` }));
	click(parent, "tools done");
	click(parent, "tools done");
	assert.doesNotMatch(rows(parent).join("\n"), /first output/);
	assert.match(rows(parent).join("\n"), /second output updated/);
	click(parent, "/tmp/sec", 22);
	assert.doesNotMatch(rows(parent).join("\n"), /second output/);
	group.setExpanded(true);
	assert.match(rows(parent).join("\n"), /first output updated/);
	assert.match(rows(parent).join("\n"), /second output updated/);
	click(parent, "/tmp/first");
	group.setExpanded(false);
	click(parent, "tools done");
	assert.match(rows(parent).join("\n"), /first output updated/);
});

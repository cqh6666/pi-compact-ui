import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { Container, getCapabilities, setCapabilities, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { loadExtension } from "./load-extension.mjs";

const requireFromPi = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const { initTheme, getThemeByName } = requireFromPi(fileURLToPath(new URL("./modes/interactive/theme/theme.js", import.meta.resolve("@earendil-works/pi-coding-agent"))));
initTheme("dark");

const { default: install, delegateOutputEntry, renderDelegateStandaloneRows, CompactExternalGroupComponent } = await loadExtension();
install({ on() {}, registerTool() {}, registerCommand() {} });

function links(t, enabled = true) {
	const previous = { ...getCapabilities() };
	setCapabilities({ ...previous, hyperlinks: enabled });
	t.after(() => setCapabilities(previous));
}

test("delegateOutputEntry extracts output file from details or text and hyperlinks when supported", (t) => {
	links(t, true);
	const fromDetails = delegateOutputEntry("acp_delegate", { outputFile: "/tmp/subagent.out" }, undefined, "/tmp/project");
	assert.match(fromDetails ?? "", /Delegate output: /);
	assert.match(fromDetails ?? "", /\x1b\]8;;file:\/\/\/tmp\/subagent\.out/);

	const fromText = delegateOutputEntry("acp_delegate", {}, "Completed delegate del_1. Output written to /tmp/subagent-text.out", "/tmp/project");
	assert.match(fromText ?? "", /Delegate output: /);
	assert.match(fromText ?? "", /\x1b\]8;;file:\/\/\/tmp\/subagent-text\.out/);

	links(t, false);
	const plain = delegateOutputEntry("acp_delegate", { outputFile: "/tmp/plain.out" }, undefined, "/tmp/project");
	assert.equal(stripTerminalSequences(plain ?? ""), "Delegate output: /tmp/plain.out");
	assert.doesNotMatch(plain ?? "", /\x1b\]8;;/);
});

test("delegateOutputEntry returns undefined for non-delegate tools or missing paths", () => {
	assert.equal(delegateOutputEntry("bash", { outputFile: "/tmp/a.out" }), undefined);
	assert.equal(delegateOutputEntry("read", { outputFile: "/tmp/a.out" }), undefined);
	assert.equal(delegateOutputEntry("acp_delegate", {}), undefined);
});

test("acp_delegate tool renders with lightning badge, agent brackets, and quoted task", (t) => {
	const chat = new Container();
	const tool = new ToolExecutionComponent(
		"acp_delegate",
		"call_del_1",
		{ agent: "reviewer", task: "Review index.ts for race conditions", async: true },
		{},
		undefined,
		{ requestRender() {} },
		"/tmp/project",
	);
	chat.addChild(tool);
	tool.updateResult({
		content: [{ type: "text", text: "Dispatched delegate `del_1` (reviewer). Result will arrive as a notification" }],
		details: { runId: "del_1", agent: "reviewer", status: "running" },
	});
	t.after(() => chat.clear());

	const group = chat.children[0];
	assert.ok(group, "Group must be created");
	const collapsed = group.render(120).map(stripTerminalSequences).join("\n");
	assert.match(collapsed, /⚡ delegate\[reviewer\]/);
	assert.match(collapsed, /"Review index\.ts for race conditions"/);
	assert.match(collapsed, /dispatched \(del_1\)/);
});

test("acp_delegate_wait renders runId and exit status", (t) => {
	const chat = new Container();
	const tool = new ToolExecutionComponent(
		"acp_delegate_wait",
		"call_wait_1",
		{ runId: "del_123", timeout: 10 },
		{},
		undefined,
		{ requestRender() {} },
		"/tmp/project",
	);
	chat.addChild(tool);
	tool.updateResult({
		content: [{ type: "text", text: "Completed delegate `del_123` (worker, exit 0). Output: /tmp/del_123.out" }],
		details: { runId: "del_123", exitCode: 0, outputFile: "/tmp/del_123.out" },
	});
	t.after(() => chat.clear());

	const group = chat.children[0];
	const collapsed = group.render(120).map(stripTerminalSequences).join("\n");
	assert.match(collapsed, /⚡ delegate_wait/);
	assert.match(collapsed, /del_123 · exit 0/);
});

test("subagent delegate expanded view displays hyperlinked delegate output entry", (t) => {
	links(t, true);
	const chat = new Container();
	const tool = new ToolExecutionComponent(
		"acp_delegate",
		"call_del_2",
		{ agent: "worker", task: "Fix timing drift in compact-ui" },
		{},
		undefined,
		{ requestRender() {} },
		"/tmp/project",
	);
	chat.addChild(tool);
	tool.updateResult({
		content: [{ type: "text", text: "Completed worker. Result written to /tmp/worker.out" }],
		details: { runId: "del_worker", exitCode: 0, outputFile: "/tmp/worker.out" },
	});
	t.after(() => chat.clear());

	const group = chat.children[0];
	group.setExpanded(true);
	const expanded = group.render(120);
	const plain = expanded.map(stripTerminalSequences).join("\n");
	assert.match(plain, /⚡ delegate\[worker\]/);
	assert.match(plain, /Delegate output: \/tmp\/worker\.out/);
	assert.match(expanded.join("\n"), /\x1b\]8;;file:\/\/\/tmp\/worker\.out/);
});

test("CompactExternalGroupComponent formats delegate tools and output links", (t) => {
	links(t, true);
	const tool = {
		id: "del_ext",
		name: "acp_delegate",
		args: { agent: "researcher", task: "Analyze architecture" },
		status: "success",
		startedAt: 1000,
		endedAt: 2500,
		resultText: "Done. Output: /tmp/research.out",
		resultDetails: { outputFile: "/tmp/research.out", exitCode: 0 },
		cwd: "/tmp/project",
	};
	const state = { tools: [tool], thinking: "", thinkingActive: false, sealed: true };
	const component = new CompactExternalGroupComponent(state, {
		fg: (_c, text) => text,
		bold: (text) => text,
	});

	const collapsed = component.render(120).map(stripTerminalSequences).join("\n");
	assert.match(collapsed, /⚡ delegate\[researcher\]/);
	assert.match(collapsed, /"Analyze architecture"/);
	assert.match(collapsed, /exit 0/);

	component.setExpanded(true);
	const expanded = component.render(120);
	assert.match(expanded.map(stripTerminalSequences).join("\n"), /Delegate output: \/tmp\/research\.out/);
	assert.match(expanded.join("\n"), /\x1b\]8;;file:\/\/\/tmp\/research\.out/);
});

test("renderDelegateStandaloneRows renders standalone task card in pending, completed, and expanded states", (t) => {
	links(t, true);
	const tool = new ToolExecutionComponent(
		"acp_delegate",
		"call_standalone_1",
		{ agent: "planner", task: "Step 1: Plan\nStep 2: Execute\nStep 3: Verify" },
		{},
		undefined,
		{ requestRender() {} },
		"/tmp/project",
	);

	// 1. Pending
	tool.executionStarted = true;
	const pendingRows = renderDelegateStandaloneRows(tool, 120);
	const pendingText = pendingRows.map(stripTerminalSequences).join("\n");
	assert.match(pendingText, /⚡ subagent \[planner\]/);
	assert.match(pendingText, /running/);
	assert.match(pendingText, /task: "Step 1: Plan/);

	// 2. Completed collapsed
	tool.updateResult({
		content: [{ type: "text", text: "Planning complete. Output: /tmp/plan.md" }],
		details: { outputFile: "/tmp/plan.md", exitCode: 0 },
	});
	const completedRows = renderDelegateStandaloneRows(tool, 120);
	const completedText = completedRows.map(stripTerminalSequences).join("\n");
	assert.match(completedText, /⚡ subagent \[planner\]/);
	assert.match(completedText, /"Step 1: Plan/);
	assert.match(completedText, /exit 0/);
	assert.match(completedText, /output: \/tmp\/plan\.md/);
	assert.doesNotMatch(completedText, /Ctrl\+O to collapse/);

	// 3. Expanded
	tool.setExpanded(true);
	const expandedRows = renderDelegateStandaloneRows(tool, 120);
	const expandedText = expandedRows.map(stripTerminalSequences).join("\n");
	assert.match(expandedText, /output: \/tmp\/plan\.md/);
	assert.match(expandedText, /> Step 1: Plan/);
	assert.match(expandedText, /Ctrl\+O to collapse/);
	assert.match(expandedRows.join("\n"), /\x1b\]8;;file:\/\/\/tmp\/plan\.md/);
});

test("renderDelegateStandaloneRows pairs acp_delegate and acp_delegate_wait into a unified subagent tree", (t) => {
	links(t, true);
	const delegateTool = new ToolExecutionComponent(
		"acp_delegate",
		"call_del_pair",
		{ agent: "researcher", task: "Analyze performance" },
		{},
		undefined,
		{ requestRender() {} },
		"/tmp/project",
	);
	delegateTool.executionStarted = true;
	delegateTool.updateResult({
		content: [{ type: "text", text: "Dispatched delegate del_pair_123" }],
		details: { runId: "del_pair_123" },
	});

	const waitTool = new ToolExecutionComponent(
		"acp_delegate_wait",
		"call_wait_pair",
		{ runId: "del_pair_123" },
		{},
		undefined,
		{ requestRender() {} },
		"/tmp/project",
	);
	waitTool.executionStarted = true;

	// Wait tool should return [] as it pairs with delegateTool
	const waitRows = renderDelegateStandaloneRows(waitTool, 120);
	assert.deepEqual(waitRows, []);

	// Now wait finishes
	waitTool.updateResult({
		content: [{ type: "text", text: "Completed del_pair_123. Full result: /tmp/del_pair_123.out" }],
		details: { runId: "del_pair_123", exitCode: 0, outputFile: "/tmp/del_pair_123.out" },
	});

	const mergedRows = renderDelegateStandaloneRows(delegateTool, 120);
	const mergedText = mergedRows.map(stripTerminalSequences).join("\n");
	assert.match(mergedText, /⚡ subagent \[researcher\]/);
	assert.match(mergedText, /exit 0/);
	assert.match(mergedText, /task: "Analyze performance"/);
	assert.match(mergedText, /output: \/tmp\/del_pair_123\.out/);
});

test("renderDelegateStandaloneRows supports the active pi theme", () => {
	const theme = getThemeByName("dark");
	assert.ok(theme, "dark theme must be available");

	const rows = renderDelegateStandaloneRows(
		{
			toolName: "acp_delegate",
			args: { agent: "worker", task: "Render with the active theme" },
			executionStarted: true,
			ui: { theme },
		},
		120,
	);

	assert.match(rows.join("\n"), /Render with the active theme/);
});

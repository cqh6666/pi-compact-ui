import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { SkillInvocationMessageComponent } from "@earendil-works/pi-coding-agent";
import { loadExtension } from "./load-extension.mjs";

const requireFromPi = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const theme = requireFromPi(
	fileURLToPath(new URL("./modes/interactive/theme/theme.js", import.meta.resolve("@earendil-works/pi-coding-agent")))
);
theme.initTheme("dark");

const { default: install, extractSkillName, aggregateConsecutiveTools } = await loadExtension();
const api = { on() {}, registerTool() {}, registerCommand() {} };
install(api);

test("extractSkillName identifies skill file paths accurately", () => {
	assert.equal(
		extractSkillName("/Users/user/.pi/agent/skills/simplify/SKILL.md"),
		"simplify"
	);
	assert.equal(
		extractSkillName("C:\\Users\\user\\.pi\\agent\\skills\\archscribe\\SKILL.md"),
		"archscribe"
	);
	assert.equal(
		extractSkillName("./skills/drawio-skill/SKILL.md"),
		"drawio-skill"
	);
	assert.equal(
		extractSkillName(".pi/skills/add-llm-provider.md"),
		"add-llm-provider"
	);
	assert.equal(
		extractSkillName("/Users/user/project/skills/my-agent-skill.md"),
		"my-agent-skill"
	);
	// Non-skill files
	assert.equal(extractSkillName("/Users/user/project/SKILL.md"), undefined);
	assert.equal(extractSkillName("src/skills/index.ts"), undefined);
	assert.equal(extractSkillName(undefined), undefined);
	assert.equal(extractSkillName({}), undefined);
});

test("aggregateConsecutiveTools isolates skill read from ordinary file reads", () => {
	const tools = [
		{ name: "read", args: { path: "src/index.ts" }, status: "success" },
		{ name: "read", args: { path: "src/utils.ts" }, status: "success" },
		{ name: "read", args: { path: "/Users/user/.pi/agent/skills/simplify/SKILL.md" }, status: "success" },
		{ name: "read", args: { path: "package.json" }, status: "success" },
	];

	const items = aggregateConsecutiveTools(
		tools,
		(t) => t.name,
		(t) => t.status,
		(t) => t.args
	);

	assert.equal(items.length, 3);
	assert.equal(items[0].type, "aggregate");
	assert.equal(items[0].tools.length, 2);
	assert.equal(items[1].type, "tool");
	assert.equal(items[1].tool, tools[2]);
	assert.equal(items[2].type, "tool");
	assert.equal(items[2].tool, tools[3]);
});

test("SkillInvocationMessageComponent toggles expanded on click", () => {
	const skillBlock = {
		name: "simplify",
		content: "# Simplify code\nCheck all comments.",
	};
	const component = new SkillInvocationMessageComponent(skillBlock);
	assert.equal(component.expanded, false);

	// Click header row 0 in collapsed mode -> expands
	const res1 = component.handleMouse?.({
		type: "click",
		button: "left",
		x: 5,
		y: 0,
	});
	assert.deepEqual(res1, { handled: true, render: true });
	assert.equal(component.expanded, true);

	// Click header row 0 in expanded mode -> collapses
	const res2 = component.handleMouse?.({
		type: "click",
		button: "left",
		x: 5,
		y: 0,
	});
	assert.deepEqual(res2, { handled: true, render: true });
	assert.equal(component.expanded, false);

	// Right click -> ignored
	const res3 = component.handleMouse?.({
		type: "click",
		button: "right",
		x: 5,
		y: 0,
	});
	assert.equal(res3, undefined);
	assert.equal(component.expanded, false);
});

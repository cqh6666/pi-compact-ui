import assert from "node:assert/strict";
import test from "node:test";
import { loadExtension } from "./load-extension.mjs";

const { formatActionsSummary, isImagePath } = await loadExtension();

test("isImagePath accurately detects common raster and vector image formats", () => {
	assert.equal(isImagePath("test.png"), true);
	assert.equal(isImagePath("/path/to/cat.jpg"), true);
	assert.equal(isImagePath("IMAGE.JPEG"), true);
	assert.equal(isImagePath("icon.svg"), true);
	assert.equal(isImagePath("pic.webp"), true);
	assert.equal(isImagePath("photo.gif"), true);
	assert.equal(isImagePath("index.ts"), false);
	assert.equal(isImagePath(undefined), false);
	assert.equal(isImagePath(123), false);
});

test("formatActionsSummary handles single and multiple viewed images", () => {
	assert.equal(
		formatActionsSummary([{ name: "read", args: { path: "preview.png" } }]),
		"Viewed an image"
	);
	assert.equal(
		formatActionsSummary([
			{ name: "read", args: { path: "first.png" } },
			{ name: "read", args: { path: "second.jpg" } }
		]),
		"Viewed 2 images"
	);
});

test("formatActionsSummary combines images with skills and commands like Codex", () => {
	assert.equal(
		formatActionsSummary([
			{ name: "read", args: { path: "preview.png" } },
			{ name: "bash", args: { command: "ls" } }
		]),
		"Viewed an image, ran a command"
	);

	assert.equal(
		formatActionsSummary([
			{ name: "read", args: { path: "/Users/test/.pi/agent/skills/simplify/SKILL.md" } },
			{ name: "read", args: { path: "chart.png" } },
			{ name: "bash", args: { command: "npm test" } }
		]),
		"Read simplify skill, viewed an image, ran a command"
	);
});

test("formatActionsSummary handles standard tool combinations (loaded tool, read files, ran commands)", () => {
	assert.equal(
		formatActionsSummary([
			{ name: "tool_search" },
			{ name: "read", args: { path: "a.ts" } },
			{ name: "read", args: { path: "b.ts" } },
			{ name: "bash", args: { command: "cmd1" } },
			{ name: "bash", args: { command: "cmd2" } }
		]),
		"Loaded a tool, read files, ran commands"
	);
});

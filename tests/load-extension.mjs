import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { mock } from "node:test";

const requireFromPi = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const { createJiti } = requireFromPi("jiti");

export async function loadExtension(options = {}) {
	const configPath = join(homedir(), ".pi", "agent", "compact-ui.json");
	const readFileSync = fs.readFileSync;
	let configReads = 0;
	const reader = mock.method(fs, "readFileSync", (path, ...options) => {
		if (path === configPath) {
			configReads++;
			return JSON.stringify({
				collapsedMaxLines: 8,
				expandedToolLines: 10,
				expandedThinkingLines: 10,
				standaloneTools: ["compress"],
			});
		}
		return readFileSync(path, ...options);
	});
	syncBuiltinESMExports();
	try {
		const extension = await createJiti(import.meta.url, options).import("../index.ts");
		assert.equal(configReads, 1, "Extension must read the isolated test configuration");
		return extension;
	} finally {
		reader.mock.restore();
		syncBuiltinESMExports();
	}
}

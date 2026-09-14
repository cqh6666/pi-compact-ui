# pi-compact-ui

Compact reasoning and tool-call groups for the [Pi Coding Agent](https://github.com/earendil-works/pi-mono).

This is an independently maintained fork based on the npm release of
[pi-compact-ui 0.1.3](https://www.npmjs.com/package/pi-compact-ui/v/0.1.3),
maintained upstream by [geoffreychen777](https://www.npmjs.com/~geoffreychen777).
The original package provides the compact tree layout and reasoning/tool grouping.
This repository builds on that foundation with execution summaries, stable timing,
failure previews, diff highlighting, and standalone tool support.

## Install this fork

```bash
pi install git:github.com/cqh6666/pi-compact-ui@main
```

Then reload Pi:

```text
/reload
```

If you already load `npm:pi-compact-ui`, remove that entry from your Pi package
configuration so that only one copy is loaded. The npm package is the upstream
release; the Git URL above installs this fork.

For a temporary session with a local checkout:

```bash
pi -e /absolute/path/to/pi-compact-ui/index.ts
```

`/reload` reloads installed files. It does not fetch newer Git commits.

## What this fork adds

| Area | Behavior |
|---|---|
| Group summaries | Tool count, failure count, and elapsed execution span |
| Stable timing | Completed durations freeze; missing historical timing displays `—s` |
| Thinking | Token usage and locally observed duration, excluding gaps between thinking segments |
| Failure previews | The first failed tool and its cause take priority in the collapsed view |
| File links | Common leading error locations link to local files in supported terminals |
| Full logs | Expanded Bash results expose a supplied `fullOutputPath` outside the preview limit |
| Result summaries | Read line counts, edit additions/deletions, grep matches, search result counts, and confirmed Bash exit codes |
| Execution phases | Displays reported phases before long arguments, then clears them on completion |
| Edit diffs | Theme-colored additions, deletions, and context within the preview limit |
| Repeated calls | Consecutive successful calls of the same type share one collapsed row |
| Standalone tools | Selected tools keep their own presentation outside the tool tree |
| Context compression | A distinct `compress` display with token savings, topic summaries, and fixed duration |

The renderer also removes empty native thinking placeholders and uses compact,
syntax-highlighted panels for fenced code blocks.

## Preview

Consecutive successful reads collapse into one row. The default collapsed view
uses at most three lines:

```text
✓ tools done · 4 tools · 0.6s
│  ✓ read · 4 files
└  · thinking: Checking the call sites… · ≈1.2K tok · 1.4s
```

A failure gets priority over ordinary successful output:

```text
✗ tools done · 3 tools · 1 failed · 2.8s
│  ✗ bash file.ts(8,2): error TS2322: Type mismatch · exit 2 (2.5s)
└  ✓ read · 2 files
```

Expand with `Ctrl+O` to see calls in chronological order, result previews, and
colored edit diffs:

```text
✓ tools done · 2 tools · 0.3s
├─ ✓ read src/auth.ts · 45 lines shown (0.1s)
│   export async function authenticate() { … }
└─ ✓ edit src/auth.ts · +2/-1 (0.2s)
    -12 const timeout = 1000;
    +12 const timeout = 5000;
    +13 const retries = 3;
```

Examples are illustrative; colors follow your Pi theme and durations depend on
observed execution events.

## Configuration

Use `/compact-ui-config` for numeric display settings. Configuration is stored at
`~/.pi/agent/compact-ui.json`:

| Setting | Default | Purpose |
|---|---:|---|
| `collapsedMaxLines` | `3` | Maximum lines in a collapsed group |
| `expandedToolLines` | `5` | Result-preview lines per expanded tool |
| `expandedThinkingLines` | `10` | Thinking-preview lines when expanded |
| `standaloneTools` | `["compress"]` | Tools excluded from ordinary grouping |

Default configuration:

```json
{
  "collapsedMaxLines": 3,
  "expandedToolLines": 5,
  "expandedThinkingLines": 10,
  "standaloneTools": ["compress"]
}
```

Edit `standaloneTools` in the JSON file and run `/reload` to apply the change.
Preserve other settings when updating this field.

### Preserve web_search's native UI

If you use `pi-web-access` and want its native progress bars, browser approval
links, shortcuts, and result rendering, add `web_search`:

```json
"standaloneTools": ["compress", "web_search"]
```

This is an optional personal setting, not the default. Search calls then render
independently and no longer merge into compact tool groups. Ordinary tools before
and after a standalone call form separate groups.

Grouped tools use compact-ui's summaries and result previews rather than their
original result UI. Reported phase labels do not reproduce every provider's
interactive progress display. Use standalone mode when those details matter.

### Context compression

With `compress` in `standaloneTools`, compression seals the preceding tool group
and displays its highlighted token-savings line and topic summaries independently.
These remain visible when other groups are collapsed. The extension styles an
existing `compress` tool; it does not provide context compression itself.

## Display rules

- Group duration spans the first observed tool start through the last end,
  including gaps between sequential calls. Parallel durations are not summed.
- Thinking duration measures observed thinking segments. Missing timestamps show
  `—s`; locally observed timing is not server-side model latency.
- Token counts are estimated during streaming and prefer provider-reported usage
  when available. Estimates are marked with `≈`.
- Result counts use final metadata or recognized native tool output. Unknown
  formats retain their argument summary. Successful Bash output alone does not
  establish an exit code; search prose is not treated as a result count.
- Read summaries count displayed lines, not the entire file. Grep excludes context
  rows and marks truncated counts or known lower bounds.
- Repeated file operations count distinct supplied paths; repeated searches count
  calls. Missing paths fall back to call counts. Errors, pending calls, and
  standalone tools stop aggregation. Expanded calls preserve their original order.
- Collapsed rows prioritize the first failure and most recent pending call.
  Thinking yields space when the line limit requires it.
- Expanded results and diffs remain bounded previews. An ellipsis indicates omitted
  lines; expanding a group does not guarantee the entire raw result is shown.

## File locations and full logs

Explicitly failed tool output can link leading diagnostic locations such as
`src/app.ts(42,7)` and `src/app.ts:42:7`. Relative paths resolve against the tool's
working directory. This supports common local POSIX paths; ambiguous text and
locations split across wrapped rows may remain plain text. If a shell command
changes directory internally, its relative diagnostics may need to be emitted as
absolute paths for correct links.

Links use `file://` URLs and Pi's OSC 8 terminal capability detection. They open
files using the terminal's configured handler; visible line and column numbers
are preserved, but exact editor line navigation is not guaranteed. Unsupported
terminals retain readable text. No editor command is executed by this extension.

Expanded Bash results show `Full output: <path>` when the tool supplies a valid
`details.fullOutputPath`. This entry remains outside the result-preview line
limit, although its displayed path is clipped to terminal width. The full URL
remains in the link. It does not reconstruct truncated output or create logs for
other tools. A log may have been deleted since execution; file existence is not
checked during rendering.

Secondary transcripts can supply each tool's `cwd` for relative links. Without
it, only absolute paths are linked.

## Controls

| Action | Key |
|---|---|
| Expand or collapse tool groups and thinking | `Ctrl+O` (Pi default) |
| Move through settings | `Up` / `Down` |
| Adjust a numeric setting | `Left` / `Right`, `-` / `+` |
| Save a setting | `Enter` |
| Close settings | `Esc` |

## Compatibility

The extension patches Pi presentation components and re-registers built-in tools
while delegating execution to Pi's native implementations. It does not modify
model-facing messages or tool results.

Avoid loading multiple compact-ui copies or competing built-in tool renderers
such as `pi-tool-display` and `pi-quiet-tools` together. Pi internal component
changes can also require compatibility updates; the wildcard peer dependencies
do not imply validation against every Pi release.

## Development

Use a checkout with the Pi peer dependencies available. Run the renderer tests:

```bash
node --test tests/*.test.mjs
```

Tests use fixed configuration during extension loading rather than reading your
personal display preferences. They exercise real tool components, timing events,
streaming results, narrow layouts, failures, diffs, and aggregation. The test loader
uses the `jiti` dependency resolved through the installed Pi package.

## Upstream credit

Credit for the original compact grouping implementation belongs to the upstream
`pi-compact-ui` project and its contributors. This repository was initialized
separately from the npm source and is not linked as a fork in GitHub's repository
metadata. The shared package name does not mean this fork publishes or maintains
the upstream npm release.

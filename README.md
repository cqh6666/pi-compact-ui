<div align="center">

# compact-ui

### A quiet, structured home for Pi's reasoning and tool calls

![Pi Extension](https://img.shields.io/badge/Pi-Extension-7C3AED?style=flat-square)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white)
![TUI](https://img.shields.io/badge/UI-Compact_Tree-0F172A?style=flat-square)

</div>

## Preview

The collapsed view shows at most three lines by default:

```text
⠋ tool calling...
│  ✓ bash: npm test (3.2s)
└  · thinking: Checking the failing assertion… · ≈1.2K tok
```

Expand the group to inspect tool arguments, result previews, and more of the
reasoning content:

```text
✓ tool calling
│
├─ ✓ read: src/auth.ts (0.1s)
│  └─ export async function authenticate() { … }
│
├─ ✓ edit: src/auth.ts (0.2s)
│  └─ Updated src/auth.ts
│
└─ · thinking · 1.2K tok
   └─ The validation path now handles expired sessions…
```

## Features

- Combines consecutive **reasoning and tool calls** into a single visual group.
- Removes Pi's native hidden-thinking placeholder components so an empty
  thinking label cannot leave phantom blank rows in the transcript.
- Supports streaming reasoning, streaming tool output, and parallel tool calls.
- Displays tool state, argument summaries, elapsed time, and result previews.
- Shows reasoning-token usage. During streaming it uses an estimate, then
  prefers provider-reported usage when available.
- Follows Pi's standard `Ctrl+O` expand and collapse behavior.
- Renders fenced code blocks as subtle theme-aware background panels with
  syntax highlighting and one character of horizontal padding instead of
  decorative top and bottom border rows.
- Preserves Pi's native execution semantics for `read`, `bash`, `edit`, `write`,
  `find`, `grep`, and `ls`.
- Gives compaction summaries a distinct, compact presentation.

## Installation

```bash
pi install npm:pi-compact-ui
```

Reload Pi:

```text
/reload
```

You can also load a local checkout temporarily:

```bash
pi -e ./compact-ui/index.ts
```

## Configuration

Open the interactive settings menu:

```text
/compact-ui-config
```

Available settings:

| Setting | Default | Purpose |
|---|---:|---|
| `collapsedMaxLines` | `3` | Maximum lines shown while a group is collapsed |
| `expandedToolLines` | `5` | Result-preview lines shown for each expanded tool |
| `expandedThinkingLines` | `10` | Reasoning-preview lines shown while expanded |
| `standaloneTools` | `["compress"]` | List of tool names to render standalone (unfolded) instead of collapsing into tree |

The configuration is stored at:

```text
~/.pi/agent/compact-ui.json
```

Example:

```json
{
  "collapsedMaxLines": 3,
  "expandedToolLines": 5,
  "expandedThinkingLines": 10,
  "standaloneTools": [
    "compress"
  ]
}
```

## Controls

| Action | Key |
|---|---|
| Expand or collapse reasoning and tool groups | `Ctrl+O` |
| Move through the settings menu | `Up` / `Down` |
| Adjust a numeric value | `Left` / `Right`, `-` / `+` |
| Save a setting | `Enter` |
| Close the settings menu | `Esc` |

## How It Works

compact-ui combines Pi's Assistant Message, Thinking, and Tool Execution
components at the presentation layer. It does not change the original messages
sent to the model or alter tool results.

Its main responsibilities are:

1. Capture reasoning blocks from the active assistant message.
2. Track consecutive and parallel tool calls.
3. Combine them into a tree component with shared state.
4. Seal the active group when visible assistant text begins, preserving clear
   message boundaries.

> [!NOTE]
> compact-ui overrides the registration of several built-in tools so it can
> control their presentation. Actual execution is still delegated to Pi's
> native tool implementations.

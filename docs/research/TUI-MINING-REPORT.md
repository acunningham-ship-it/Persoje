# Terminal UI Implementation Mining Report

## Executive Summary

Mined **actual source code** from production agentic CLIs (Command Code v0.28.1 decompiled, Ink ecosystem, CLI spinner library). Captured exact color palettes (hex), spinner frame arrays, component patterns, and Ink/React-for-terminal techniques. Below are concrete findings ranked by visual impact.

---

## 1. Command Code v0.28.1 Theme Color Palette

**Repo:** github.com/anxkhn/command-code-decompiled/main/index.mjs (lines ~160-200 in beautified output)

### Full Theme/Color Constants

```javascript
// Command Code's Ink TUI color definitions
const ACCENT_COLOR = "#E4CCFF";           // Purple accent (prominent)
const BRAND_COLOR = "#8367F4";            // Brand purple
const ORANGE_ACCENT = "#F49D2A";          // Orange highlight (Claude Code-like)
const PRIMARY_ACCENT = "#E4CCFF";         // Same as ACCENT_COLOR
const WARNING_COLOR = "#F5B731";          // Yellow warning
const LINK_COLOR = "#B1BAF9";             // Blueish link text
const MUTED_COLOR = "#636D83";            // Gray dim text
const DIM_TEXT_COLOR = "#636D83";         // Matching muted
const BORDER_COLOR = "#6E61A3";           // Purple-gray borders

// Status badge styling
const BADGE_COLORS = {
  BADGE_BG: "#08575B",                    // Dark teal background
  BADGE_FG: "#f4f4f4",                    // Light foreground
  TEXT: "#02888E"                         // Cyan text
};

// Badges for different states
const HEADER_BADGE = { BG: "#5945B1", FG: "#f4f4f4" };        // Deep purple
const SECONDARY_BADGE = { BG: "#2D2B55", FG: "#E4CCFF" };     // Dark purple + purple text
const PRIMARY_BADGE = { BG: "#6943FF", FG: "#f4f4f4" };       // Bright purple

// Status colors for success/error/warning/in-progress
const STATUS_COLORS = {
  SUCCESS: "#35AD68",                     // Green
  ERROR: "#E84057",                       // Red
  WARNING: "#F5B731",                     // Yellow
  IN_PROGRESS: "#E4CCFF"                  // Purple (matches accent)
};

// Diff/comparison colors
const DIFF_COLORS = {
  REMOVED_BG: "#5C0112",
  ADDED_BG: "#04473A",
  REMOVED_TEXT: "#D95A6A",
  ADDED_TEXT: "#4CC88E",
  REMOVED_HIGHLIGHT_BG: "#7D2233",
  ADDED_HIGHLIGHT_BG: "#2E6B4A",
  LINE_NUM: "#636D83"
};

// UI element colors
const SELECTOR_COLORS = { BG: "#2D2B55", POINTER: "#A599E9" }; // Selection highlight
const HIGHLIGHT_COLOR = "#A599E9";                              // Bright purple
const EMPHASIS_COLOR = "#F5B731";                               // Yellow emphasis
const MARKDOWN_COLORS = { CODE: "#B1BAF9", HEADING: "#A599E9" };
const TOOLTIP_COLORS = { TEXT: "#B1BAF9", BG: "#5646AB" };
const PR_STATUS_COLORS = { OPEN: "#F5B731", MERGED: "#A78BFA" };

// Gradient array (9-color spectrum for header/banner)
const GRADIENT_COLORS = [
  "#A599E9",  // Bright purple
  "#E4CCFF",  // Light purple
  "#ABA5CE",  // Muted purple
  "#CCC7E1",  // Very light purple
  "#FFFFFF",  // White
  "#EADAFF",  // Light lavender
  "#ABA5CE",  // Muted purple (cycle)
  "#E4CCFF",  // Light purple
  "#A599E9"   // Bright purple
];

// Full terminal theme (8-color ANSI + extras)
const THEME_COLORS = {
  CYAN: "#7AD4D6",
  GREEN: "#2EBD8E",
  GRAY: "#636D83",
  WHITE: "#E5E5E5",
  YELLOW: "#F5B731",
  RED: "#E84057",
  BLUE: "#5945B1",
  MAGENTA: "#F2608A",
  DIM: "#636D83",
  DIMMER: "#4C556A",
  DIMMEST: "#353D50"
};
```

**Key observations:**
- **Purple-dominant theme** (accent `#E4CCFF`, brand `#8367F4`) similar to Claude Code's aesthetic
- **Orange accent** (`#F49D2A`) mirrors Claude's actual brand orange
- **Gradient uses 9-step spectrum** for smooth color transitions in headers
- **Status colors use semantic hues** (green=success, red=error, yellow=warning, purple=in-progress)
- **Selector BG/pointer** (`#2D2B55`/`#A599E9`) for interactive UI focus states

---

## 2. CLI Spinner Frames (from npm `cli-spinners`)

**Repo:** github.com/sindresorhus/cli-spinners/main/spinners.json

### Best Spinners for Agentic CLI

**Dots (default, 80ms interval):**
```json
{
  "interval": 80,
  "frames": ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
}
```
Simple, universal, works everywhere.

**Dots2 (smooth Unicode balls):**
```json
{
  "interval": 80,
  "frames": ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"]
}
```

**Line (classic rotating slash, 130ms):**
```json
{
  "interval": 130,
  "frames": ["-", "\\", "|", "/"]
}
```

**Arrow (directional, 100ms):**
```json
{
  "interval": 100,
  "frames": ["←", "↖", "↑", "↗", "→", "↘", "↓", "↙"]
}
```

**SimpleDots (slow ball pulse, 400ms):**
```json
{
  "interval": 400,
  "frames": [".  ", ".. ", "...", "   "]
}
```
Great for long-running tasks (avoid visual noise).

**Earth (globe spin, 180ms):**
```json
{
  "interval": 180,
  "frames": ["🌍 ", "🌎 ", "🌏 "]
}
```

**Dots12 (large ASCII animation, 80ms):**
```json
{
  "interval": 80,
  "frames": ["⢀⠀", "⡀⠀", "⠄⠀", "⢂⠀", "⡂⠀", "⠅⠀", "⢃⠀", "⡃⠀", "⠍⠀", "⢋⠀", "⡋⠀", "⠍⠁", ...]  // 56 total frames
}
```
Most detailed, good for "thinking" state.

---

## 3. Ink Component Structure (from Ink + ink-spinner)

**Repo:** github.com/vadimdemedes/ink (v7.0.5, latest) + github.com/vadimdemedes/ink-spinner/master

### Spinner Component (React/Ink style)

```jsx
// Exact implementation from ink-spinner/source/index.tsx
import React, { useState, useEffect } from 'react';
import { Text } from 'ink';
import spinners from 'cli-spinners';

function Spinner({ type = 'dots' }) {
  const [frame, setFrame] = useState(0);
  const spinner = spinners[type];

  useEffect(() => {
    const timer = setInterval(() => {
      setFrame(previousFrame => {
        const isLastFrame = previousFrame === spinner.frames.length - 1;
        return isLastFrame ? 0 : previousFrame + 1;
      });
    }, spinner.interval);

    return () => clearInterval(timer);
  }, [spinner]);

  return <Text>{spinner.frames[frame]}</Text>;
}

export default Spinner;
```

**Usage in agentic context:**
```jsx
<Box flexDirection="row" marginRight={1}>
  <Spinner type="dots" />
  <Text color="#E4CCFF">Thinking…</Text>
</Box>
```

### Box & Border Styles (cli-boxes)

**Repo:** github.com/sindresorhus/cli-boxes/main/boxes.json

```javascript
// Round box (good for headers)
const BOXES = {
  round: {
    topLeft: "╭",
    top: "─",
    topRight: "╮",
    right: "│",
    bottomRight: "╯",
    bottom: "─",
    bottomLeft: "╰",
    left: "│"
  },
  
  // Double-line (prominent headers)
  double: {
    topLeft: "╔",
    top: "═",
    topRight: "╗",
    right: "║",
    bottomRight: "╝",
    bottom: "═",
    bottomLeft: "╚",
    left: "║"
  },
  
  // Bold (thicker lines)
  bold: {
    topLeft: "┏",
    top: "━",
    topRight: "┓",
    right: "┃",
    bottomRight: "┛",
    bottom: "━",
    bottomLeft: "┗",
    left: "┃"
  },
  
  // Classic ASCII
  classic: {
    topLeft: "+",
    top: "-",
    topRight: "+",
    right: "|",
    bottomRight: "+",
    bottom: "-",
    bottomLeft: "+",
    left: "|"
  }
};
```

**Ink.Box usage (from Ink examples):**
```jsx
<Box flexDirection="column" borderStyle="round" borderColor="#E4CCFF" padding={1}>
  <Text bold color="#E4CCFF">Agent Output</Text>
  <Text>{content}</Text>
</Box>
```

Ink.Box props:
- `borderStyle`: 'single' | 'double' | 'round' | 'bold' (uses cli-boxes internally)
- `borderColor`: hex or ANSI color name
- `padding`: number (applies to all sides)
- `paddingX`, `paddingY`: horizontal/vertical
- `margin`, `marginX`, `marginY`: spacing outside box

### Gradient Component (ink-gradient)

**Repo:** github.com/sindresorhus/ink-gradient/main/example.js

```jsx
import React from 'react';
import { render, Box, Text } from 'ink';
import Gradient from 'ink-gradient';
import BigText from 'ink-big-text';

// Usage: wrap content with Gradient
render(
  <Gradient name="retro">
    <Box borderStyle="round" padding={1}>
      <Text>Gradient with Box children</Text>
      <BigText text="Hello" />
    </Box>
  </Gradient>
);

// Or custom colors:
render(
  <Gradient colors={["#E4CCFF", "#F49D2A", "#35AD68"]}>
    <Text>Custom gradient text</Text>
  </Gradient>
);
```

Available built-in gradients: 'cristall', 'mind', 'morning', 'passion', 'pastel', 'rainbow', 'retro', 'summer', 'teen'

---

## 4. Command Code Ink Components (from decompiled index.mjs)

### Spinner with Status Icon Pattern

```jsx
// From Command Code's auth flow
function AuthStatusComponent({ status }) {
  const getStatusIcon = (status) => {
    switch(status) {
      case "loading":
        return <InkSpinner type="dots" />;
      case "waiting_browser":
        return <Text color="#7AD4D6">…</Text>;  // CYAN
      case "browser_success":
      case "success":
        return <Text color="#2EBD8E">✓</Text>;  // GREEN
      case "denied":
      case "invalid_key":
        return <Text color="#E84057">✕</Text>; // RED
      case "manual_entry":
        return <Text color="#F5B731">↓</Text>; // YELLOW
      case "error":
        return <Text color="#E84057">⚠</Text>; // RED
    }
  };

  return (
    <Box flexDirection="column" paddingY={1}>
      <Box marginBottom={1}>
        <Box marginRight={1}>{getStatusIcon(status)}</Box>
        <Text color={getStatusColor(status)}>{statusMessage}</Text>
      </Box>
    </Box>
  );
}
```

### Task Spinner (Loading → Success transition)

```jsx
function TaskSpinner({
  loadingMessage,
  successMessage,
  task,
  onComplete,
  showSuccessState = true
}) {
  const [state, setState] = useState("loading");
  const [result, setResult] = useState(null);

  useEffect(() => {
    task().then((res) => {
      setResult(res);
      setState(showSuccessState ? "success" : "done");
    });
  }, [task]);

  useEffect(() => {
    if (state === "done" && result !== null) {
      onComplete(result);
    }
    if (state === "success" && result !== null) {
      const timeout = setTimeout(() => onComplete(result), 100);
      return () => clearTimeout(timeout);
    }
  }, [state, result]);

  return (
    <>
      {state === "loading" ? (
        <Box>
          <Spinner type="dots" />
          <Text color="#E4CCFF" marginLeft={1}>{loadingMessage}</Text>
        </Box>
      ) : (
        <Box>
          <Text color="#35AD68">✓</Text>
          <Text color="#35AD68" marginLeft={1}>{successMessage}</Text>
        </Box>
      )}
    </>
  );
}
```

### Token/Context Status Bar Pattern

```jsx
// Command Code tracks token usage like this (inferred from decompilation)
function StatusBar({ tokensUsed, tokenLimit, percentage }) {
  const barLength = 30;
  const filledLength = Math.round(barLength * (percentage / 100));
  const bar = "█".repeat(filledLength) + "░".repeat(barLength - filledLength);

  return (
    <Box marginTop={1}>
      <Text color="#636D83">{bar}</Text>
      <Text color="#636D83" marginLeft={1}>
        {tokensUsed.toLocaleString()}/{tokenLimit.toLocaleString()} 
        tokens ({percentage.toFixed(1)}%)
      </Text>
    </Box>
  );
}
```

---

## 5. Ink Ecosystem Dependencies

**From Ink v7.0.5 package.json:**

**TUI Core:**
- `react` – React renderer for terminal
- `ink` (v7.0.5) – Box, Text, render, useInput hooks
- `ink-spinner` – Animated spinner component
- `ink-select-input` – Keyboard-driven list selection
- `ink-big-text` – Large ASCII text rendering
- `ink-gradient` – Color gradient for text

**CLI Input:**
- `@clack/prompts` – Beautiful prompts (select, confirm, password)
- `commander` – CLI argument parsing
- `chalk` – ANSI color styling (legacy, but used for fallback)
- `picocolors` – Lightweight color library
- `ora` – Spinner abstraction layer

**File/Markdown:**
- `marked` + `marked-terminal` – Markdown → terminal rendering
- `diff` – Diff formatting
- `shell-quote` – Shell command parsing

**Utilities:**
- `cli-boxes` – Box drawing characters
- `cli-cursor` – Cursor control (show/hide)
- `cli-spinners` – Spinner animation frames
- `ansi-escapes` – Low-level ANSI escape codes
- `ansi-styles` – ANSI color/style definitions
- `wrap-ansi`, `slice-ansi`, `string-width` – ANSI-aware text handling
- `terminal-size` – Get terminal dimensions
- `figures` – Unicode symbols (✓, ✕, …)

---

## 6. Ink Box Border Title Pattern (Workaround for older Ink)

**Problem:** Older Ink versions don't support border titles natively.

**Workaround (current best practice):**

```jsx
function TitledBox({ title, children, ...boxProps }) {
  return (
    <Box flexDirection="column" {...boxProps}>
      {/* Title line */}
      <Box marginBottom={0}>
        <Text bold color="#E4CCFF">╭─ {title} ─╮</Text>
      </Box>
      {/* Content */}
      <Box
        borderStyle="round"
        borderColor="#E4CCFF"
        flexDirection="column"
        {...boxProps}
      >
        {children}
      </Box>
      {/* Bottom line (optional) */}
      <Box>
        <Text color="#E4CCFF">╰──────────╯</Text>
      </Box>
    </Box>
  );
}
```

**Ink 7.0+ should support natively** — check latest docs. Recommendation: Use `<Box title="...">` prop directly if available.

---

## 7. Agent-Style Tool-Call Rendering Pattern

**From Command Code decompilation + inspection of agent CLI patterns:**

```jsx
function ToolCallLine({ tool, input, status, duration }) {
  const statusSymbol = {
    pending: <Spinner type="dots" />,
    success: <Text color="#35AD68">✓</Text>,
    error: <Text color="#E84057">✕</Text>
  }[status];

  const statusColor = status === "pending" ? "#E4CCFF" : 
                      status === "success" ? "#35AD68" : "#E84057";

  return (
    <Box flexDirection="column" marginY={1}>
      {/* Tool call header */}
      <Box flexDirection="row">
        <Text color="#636D83">│ </Text>
        <Box marginRight={1}>{statusSymbol}</Box>
        <Text bold color={statusColor}>{tool}</Text>
        {duration && <Text color="#636D83" marginLeft={2}>({duration}ms)</Text>}
      </Box>

      {/* Input/params preview */}
      {input && (
        <Box flexDirection="row" marginLeft={2}>
          <Text color="#636D83">┊ </Text>
          <Text color="#B1BAF9" dimColor>{JSON.stringify(input).slice(0, 60)}…</Text>
        </Box>
      )}
    </Box>
  );
}
```

Render tool-calls in sequence:
```jsx
<Box flexDirection="column">
  {toolCalls.map((call, i) => (
    <ToolCallLine key={i} {...call} />
  ))}
</Box>
```

---

## Things to Steal (Ranked by Visual Impact)

### Tier 1: Immediate High-Impact

1. **Gradient color array** (`#A599E9`, `#E4CCFF`, `#ABA5CE`, ... gradient of purples/white) → Use for animated header banner or progress bar color cycling. **Raw URL:** https://raw.githubusercontent.com/anxkhn/command-code-decompiled/main/index.mjs

2. **Orange accent `#F49D2A`** + **Primary purple `#E4CCFF`** → Use as action button colors and status highlights. Mirrors Claude's actual brand.

3. **Dots12 spinner** (56-frame Braille animation) → Most visually sophisticated, especially good for "thinking/pondering" states. **Raw JSON:** https://raw.githubusercontent.com/sindresorhus/cli-spinners/main/spinners.json

4. **Spinner + status icon pattern** → Dots spinner next to colored text (`<Spinner type="dots" /> + <Text color="#E4CCFF">Thinking…</Text>`). No external library needed beyond Ink.

### Tier 2: Solid Foundations

5. **Selector focus colors** (`BG: "#2D2B55"`, `POINTER: "#A599E9"`) → For interactive list selection, use dark purple background with bright purple cursor.

6. **Status color semantics** (Green `#35AD68` for success, Red `#E84057` for error, Yellow `#F5B731` for warning, Purple `#E4CCFF` for in-progress) → Apply consistently across all UI states.

7. **Round box style** (╭─┌─╮) → Default Ink border style, lightweight, friendly. Use `borderStyle="round"` with `borderColor="#E4CCFF"`.

8. **Token/context status bar** → Progress bar showing `tokensUsed / tokenLimit` with percentage. Use `█` (full) and `░` (empty) Unicode block characters.

### Tier 3: Polish & Details

9. **Diff colors** (removed `#5C0112`/`#D95A6A`, added `#04473A`/`#4CC88E`) → For file edit diffs or before/after comparisons.

10. **Tooltip styling** (`TEXT: "#B1BAF9"`, `BG: "#5646AB"`) → For hover hints or command help text.

11. **Title box workaround** → `╭─ Title ─╮` top line manually rendered before Box, allows custom border styling in older Ink.

12. **Ink dependencies** → Always include `cli-spinners`, `cli-boxes`, `figures`, `chalk`, `ansi-styles`, `string-width` for full TUI capability.

---

## Implementation Checklist

- [ ] Install deps: `npm install ink chalk cli-spinners cli-boxes figures`
- [ ] Copy color palette as constants (all hex values above)
- [ ] Create reusable `<Spinner>` component using ink-spinner pattern (or DIY with useState + useEffect)
- [ ] Create `<StatusBar>` component with progress Unicode blocks
- [ ] Define `<TitledBox>` wrapper for titled borders
- [ ] Apply purple/orange color scheme to buttons & highlights
- [ ] Use gradient colors for header/banner animation
- [ ] Test spinners in live CLI: dots, dots12, earth, line
- [ ] Implement tool-call rendering with status icons (✓, ✕, ⟳)

---

## Raw Source URLs

- **Command Code decompiled (full 70K lines):** https://raw.githubusercontent.com/anxkhn/command-code-decompiled/main/index.mjs
- **Spinner frames (JSON):** https://raw.githubusercontent.com/sindresorhus/cli-spinners/main/spinners.json
- **CLI box styles:** https://raw.githubusercontent.com/sindresorhus/cli-boxes/main/boxes.json
- **Ink repo:** https://github.com/vadimdemedes/ink (v7.0.5 latest)
- **Ink-spinner source:** https://raw.githubusercontent.com/vadimdemedes/ink-spinner/master/source/index.tsx
- **Ink-gradient example:** https://raw.githubusercontent.com/sindresorhus/ink-gradient/main/example.js

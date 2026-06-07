# Agentic CLI TUI Visual Design Language Specification

**Compiled Research Date**: June 7, 2026  
**Focus**: Claude Code (primary), OpenCode/SST, Gemini CLI, Codex CLI  
**Target Implementation**: Ink-based TUI in React/TypeScript

---

## Executive Summary

This spec documents the exact visual design patterns used by premium agentic CLI tools. The research covers:
- **Claude Code** (Anthropic's leaked source + community customization tools like tweakcc)
- **OpenCode** (SST) with documented design system & theme architecture
- **Ink/React TUI** framework (the underlying tech for both Claude Code & Gemini CLI)
- **Premium UX patterns** that distinguish polished TUIs from basic ones

Key finding: **Agentic CLI TUIs are not minimalist**—they use the full 24-bit truecolor palette, careful spacing rhythm, animated spinners, real-time metrics, and multi-layer borders. The "premium feel" comes from consistent vertical rhythm, dim status indicators, and a single accent color used sparingly.

---

## Part 1: Claude Code Visual Design

### 1.1 Overall Color Palette

**Primary Accent** (the signature orange):
- Hex: **#FA7921** or **#FF8C42** (peach-orange, varies by usage)
- Used for: welcome header star glyph, active focus indicators, selected menu items
- Opacity variants: 100% for active, 50-60% for disabled/dim states

**Neutral Scale** (warm near-black):
- Primary text: **#FFFFFF** (true white on dark backgrounds)
- Dim/secondary text: **#AAAAAA** or **#888888** (gray-400 range for muted messages)
- Background/surface: **#0A0A0A** or **#141414** (near-black, slightly warm)
- Subtle border: **rgba(255, 255, 255, 0.08)** to **rgba(255, 255, 255, 0.15)** (barely visible dividers)

**Status Colors**:
- Success/completion: **#00C853** (bright green)
- Warning/pending: **#FFC107** (amber)
- Error/blocked: **#F44336** (red)
- Context/info: **#00BCD4** (cyan, for context %)

**Observed in tweakcc docs**: users pick themes that customize the orange accent + spinner style, confirming the orange is load-bearing to the visual identity.

### 1.2 Welcome Header Layout

**ASCII Art Borders**:
```
┌───────────────────────────────────────────────┐
│  ✻ Claude Code v2.1.x                        │
│  You are now in an agentic coding session.    │
│                                               │
│  Commands: /help  /example  /settings         │
└───────────────────────────────────────────────┘
```

**Specifics**:
- Single-line rounded/box-drawing corners: `┌` `┐` `├` `─` `│`
- Border color: dim white, ~8% opacity (`rgba(255, 255, 255, 0.08)`)
- Padding inside box: 1 line top/bottom, 2 chars left/right
- Star glyph: **✻** (heavy black star U+273B, rendered in orange #FA7921)
- Font: monospace (system monospace or Berkeley Mono if available)
- Center or left-align the title; commands in secondary text color
- Blank line after header before message history starts

### 1.3 User Message Rendering

**Prefix Character**: **`>`** (greater-than, dim orange or white)
```
> build me a calculator in React with a pink theme
```

**Styling**:
- Prefix `>` color: **#888888** or dim orange (#FA7921 @ 60% opacity)
- Message text: **#FFFFFF** (bright white)
- Line wrapping: respect terminal width, indent continuation lines 2 spaces
- Blank line after each user message

**Multiple consecutive messages**: stack without extra blank lines between them, but keep a blank line before assistant response.

### 1.4 Assistant Message Rendering

**Prefix Character**: **⏺** (bullet/circle U+23FA, medium gray, NOT white)
```
⏺ I'll build a React calculator with a pink theme. Starting…
```

**Styling**:
- Prefix `⏺` color: **#666666** (medium gray, subtle, not bright)
- Text: **#FFFFFF** (bright white)
- Multi-line blocks preserve monospace alignment
- No extra indentation beyond natural terminal wrap

**Plain assistant messages**: single `⏺` prefix, standard white text. When tool use occurs, messages expand (see below).

### 1.5 Tool Call Lines (Bash, Edit, Read, etc.)

**Format** (example Bash call):
```
⏺ Bash
  command: npm install react
  ⎿ ▶ running…
```

**Breakdown**:
1. **Line 1**: `⏺ ` + Tool Name (e.g., "Bash", "Edit", "Read") in dim orange or white
2. **Line 2+**: Indented 2 spaces, metadata in dim gray:
   - `command:` / `file:` / `pattern:` + value
   - Lines wrapped and indented consistently
3. **Execution indicator**:
   - Pending: `⎿ ▶ running…` (dim cyan or bright blue)
   - Complete: `⎿ ✓ done` (green) or `⎿ ✗ failed` (red)

**Result rendering** (below tool call):
```
⏺ Bash
  command: npm install react
  ⎿ ▶ running…

  stdout:
  + react@18.2.0 added 42 packages
  ⎿ ✓ done (2.3s)
```

- Result indented 2 spaces
- Blank line before result output
- Elapsed time in dim gray: `(2.3s)` or `(0.8s · ⚒ 1.2k tokens)`
- Token counter appears during long operations: `⚒ 1200 tokens consumed`

### 1.6 Edit/Diff Preview

When Claude Code shows a file edit in-line:
```
⏺ Edit (src/App.tsx)
  ⎿ ▶ previewing diff…

  - const oldValue = 10;
  + const newValue = 20;
    const result = oldValue + newValue;

  ⎿ ✓ done
```

**Diff colors**:
- Removed lines: **#F44336** (red) prefix `-`
- Added lines: **#00C853** (green) prefix `+`
- Context lines: **#666666** (dim gray) prefix ` ` (space)

---

## Part 2: Input Box & Interactive Elements

### 2.1 Input Box Design

Located at **bottom of terminal**, fixed, non-scrolling:

```
Thinking…

─────────────────────────────────────────────────────────────

> your prompt goes here…

Hints: Tab to cycle · Ctrl+C to exit · ? for shortcuts
```

**Specifics**:
- Divider line above: `─────` spanning full width, **#333333** or **rgba(255, 255, 255, 0.12)**
- Prompt prefix: **`>`** in **#FA7921** (orange)
- Input text: **#FFFFFF**
- Placeholder text (if empty): **#666666** (gray, italicized if supported, else just dim)
- Cursor: **inverted** (white-on-orange or orange-on-white block)
- Hints line below: **#666666** (dim gray), right-aligned, single line

### 2.2 Status/Hints Line

Always visible below input, right-justified:

```
Hints: Tab to cycle · Ctrl+C to exit · ? for shortcuts
```

OR during active work:

```
✓ Processing · 4.2k tokens · context: 68% · ETA: 3s
```

**Colors**:
- Icon/prefix (`✓`): matching operation state (green for success, yellow for pending)
- Text: **#888888** (medium dim gray)
- Metrics (tokens, context %): **#AAAAAA** (slightly brighter gray)

### 2.3 Spinner / "Thinking" Indicator

**Top of screen, above message history** (if scrolled down) OR **between messages** (if scrolling history):

```
⏳ Thinking…
```

**Animated spinners** (cycle every 400-600ms):
- **Brainstorm**: `⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏` (Braille spinner)
- **Stars**: `✻ ✻ ✻` (static) or `⭐ ⭐ ⭐` (cycling)
- **Dots**: `⠁ ⠂ ⠄ ⡀ ⢀ ⠠ ⠐ ⠈` (minimal, elegant)
- **Verb rotation** (tweakcc feature): `Thinking… / Brewing… / Pondering… / Analyzing…` (1-2 verbs every 2s)

**Styling**:
- Icon: **#FA7921** (orange) or **#00BCD4** (cyan for "computing")
- Text: **#AAAAAA** (dim gray)
- Duration ticker (if visible): `(12s · ⚒ 2.3k tokens)` in **#666666**

### 2.4 Permission Dialog

When tool use requires approval (e.g., git commit, file write):

```
┌─────────────────────────────────┐
│ ⚠ Confirm Action                │
│                                 │
│ Edit file: /src/index.ts        │
│ Change: 42 lines added, 8 rem   │
│                                 │
│ [A] Approve  [S] Skip  [C] Cancel│
└─────────────────────────────────┘
```

**Styling**:
- Title line: **#FFC107** (yellow/amber for warning tone)
- Content: **#FFFFFF**
- Metadata (filename, changes): **#AAAAAA** (dim gray)
- Options: **#FA7921** (orange) for key, **#FFFFFF** for label
- Border: single-line, **#FFC107** (warning orange)

---

## Part 3: OpenCode Design System

### 3.1 Color Palette (from oh-my-design.kr analysis)

**Primary Text**: **#201d1d** (warm near-black, almost charcoal)  
**Accent**: Appears to be a warm orange/rust tone (exact hex varies by theme)  
**Borders**: **rgba(15, 0, 0, 0.12)** (subtle warm transparency, barely visible)  
**Typography**: **Berkeley Mono** (monospace-only, no sans-serif mixing)

**Truecolor Requirement**: OpenCode explicitly requires `truecolor` (24-bit) terminal support; queries `$COLORTERM` for `truecolor` or `24bit`.

### 3.2 Theme Architecture

OpenCode supports **custom themes** via JSON/YAML:

```json
{
  "name": "default",
  "colors": {
    "primary": "#FA7921",
    "secondary": "#4A90E2",
    "background": "#0A0A0A",
    "text": "#FFFFFF",
    "dimText": "#888888",
    "success": "#00C853",
    "error": "#F44336"
  },
  "spacing": {
    "padding": 2,
    "lineHeight": 1.5
  }
}
```

Themes cascade: system colors → theme file → component overrides.

### 3.3 UI Components (OpenCode-specific)

**Dialog layouts**: centered boxes with padding, consistent with Ink rendering  
**List rendering**: vertical stack with highlight on active item  
**Status bars**: fixed at bottom, right-aligned metrics  

---

## Part 4: Gemini CLI (Google) Design Notes

### 4.1 TUI Architecture

**Also uses Ink** (confirmed from HN discussion: "Gemini CLI is an open-source AI agent" powered by React + Ink).

**Layout pattern**:
- Header with project name
- Scrollable message history
- Fixed input at bottom
- Status line with metrics

**Color scheme**: Less documented publicly, but uses similar warm/cool neutrals as Claude Code. Likely similar to Google's Material Design colors (blue accents instead of orange).

### 4.2 Key Difference from Claude Code

Gemini CLI focuses on **stateless REPL interaction**—each prompt is independent. Claude Code maintains multi-turn state, tool history, and context tracking. This affects message grouping and state display.

---

## Part 5: Ink Framework Technical Specification

### 5.1 Core Architecture

**Rendering System**:
- **React Reconciler**: Ink mounts components into a virtual terminal buffer
- **Yoga Layout Engine**: Flexbox layout calculation (same as React Native)
- **Chalk Library**: Terminal color/style output (handles ANSI codes)
- **Alternate Screen Buffer**: `[?1049h` (enables full-screen TUI)

**Render Cycle**:
1. Component tree updates (state/props change)
2. React reconciler diffs against previous render
3. Yoga calculates layout (flexbox → terminal coordinates)
4. Output written to alternate screen buffer
5. Terminal refreshes (double-buffered, no flicker)

### 5.2 Layout with Flexbox (Yoga)

**Key CSS-like properties**:
```tsx
<Box
  flexDirection="column"
  width={80}
  height={20}
  paddingLeft={2}
  paddingRight={2}
  borderStyle="round"
  borderColor="white"
>
  {children}
</Box>
```

**Defaults in Ink** (differ from web CSS):
- `flexDirection`: `column` (not `row`)
- `alignContent`: `flex-start` (not `stretch`)
- `flexShrink`: `0` (not `1`)

**Spacing rhythm rule**: Use **4-unit increments** for padding/margin (2, 4, 8, 12, 16 spaces) to maintain vertical rhythm.

### 5.3 Fixed Footer + Scrollable Content Pattern

**The "expandable layout" pattern** (from combray.prose.sh research):

```tsx
<Box flexDirection="column" width={terminalWidth} height={terminalHeight}>
  {/* Scrollable history */}
  <Box
    flexDirection="column"
    flexGrow={1}
    overflow="hidden"
  >
    {messages.map(msg => <Message key={msg.id} {...msg} />)}
  </Box>

  {/* Fixed divider */}
  <Box borderTop borderStyle="─">
    <Text>─────────────────────────────────────</Text>
  </Box>

  {/* Fixed input footer */}
  <Box height={3}>
    <Text color="cyan">> </Text>
    <TextInput value={input} onChange={setInput} />
  </Box>
</Box>
```

**Key techniques**:
1. **`flexGrow={1}`** on scrollable area: expands to fill available space
2. **`overflow="hidden"`**: clips content to bounds (enables scrolling)
3. **Fixed divider**: `<Box borderTop>` stays pinned
4. **Fixed footer**: placed after scrollable, always rendered last

### 5.4 Border Styles in Ink

Available styles: `single`, `double`, `round`, `bold`, `dashed`, `dotted`, `double`, `classic`

```tsx
<Box
  borderStyle="round"
  borderColor="#FA7921"
  paddingX={1}
  paddingY={1}
>
  Content
</Box>
```

Renders:
```
╭──────────────┬─────────────╮
│ Content here │ More        │
╰──────────────┴─────────────╯
```

**In practice**, Claude Code uses:
- Outer wrapper: `round` or `single`, dim white
- Dividers (no corner cells): `─` repeated (manual rendering)
- Tool boxes: `single` with subtle color

### 5.5 Color Handling

Ink uses **Chalk-style color names**:
```tsx
<Text color="#FA7921">Orange text</Text>
<Text color="cyan">Cyan text</Text>
<Text color="gray" dimColor>Dimmed gray</Text>
<Text bold>Bold text</Text>
```

**Hex support**: Full 24-bit hex colors are supported if terminal advertises `truecolor`.

### 5.6 Gradient Text (Bonus)

The **ink-gradient** library (by Sindre Sorhus) provides gradient text:

```tsx
import Gradient from 'ink-gradient';
import chalk from 'chalk';

<Gradient name="stripe">
  ✻ Welcome to Claude Code
</Gradient>
```

Creates animated color gradients across text. Less common in agentic CLIs, but available for premium UI.

---

## Part 6: Premium UX Patterns (Small Details That Matter)

### 6.1 Elapsed Time + Token Counter

During long operations, display:
```
⏳ Thinking… (8s · ⚒ 3.2k tokens)
```

- Elapsed time: update every 100ms
- Token counter: update per token (streaming models)
- Colors: dim gray for time, slightly brighter for token count
- Format: `(Xs · ⚒ Xk tokens)` in parentheses, right-aligned if space

### 6.2 Context Percentage Warning

When context window fills (e.g., 85%+ full):
```
⚠ Context: 87% full · Recommend /clear or /archive
```

- Icon: **#FFC107** (warning yellow)
- Percentage: **#AAAAAA** (dim gray)
- Recommendation: brighter gray, right-aligned

### 6.3 Double-Press Interrupt Hint

```
⎿ Interrupted (Ctrl+C again to force exit)
```

- Prefix: dim gray
- Message: white
- Shown for 1-2 seconds after first Ctrl+C

### 6.4 Queued Message Display

When user sends input while agent is working:
```
⏳ Thinking…

> [QUEUED] generate a landing page
```

- Queued prefix: **#FFC107** (amber, to distinguish from sent)
- Or: show in a separate "Next message" section at bottom

### 6.5 Diff Coloring in Edit Previews

```
- const x = 10;        ← #F44336 (red)
+ const x = 20;        ← #00C853 (green)
  const y = x + 5;     ← #666666 (dim gray, context)
```

- Removed: bright red with prefix `-`
- Added: bright green with prefix `+`
- Context: dim gray with prefix ` ` (space)

### 6.6 Status Verbs (Animated Spinner Text)

Cycling verbs (tweakcc feature):
```
⏳ Thinking…    (t=0s)
⏳ Brewing…     (t=2s)
⏳ Analyzing…   (t=4s)
⏳ Pondering…   (t=6s)
```

- Verb list: customizable per theme
- Rotate every 2-3 seconds
- Keep emoji/spinner character constant

### 6.7 Permission Approval Keyboard Shortcuts

```
[A] Approve  [S] Skip  [D] Deny  [?] Details
```

- Key in **brackets**: orange (#FA7921) or cyan
- Action label: white
- Highlight active option on arrow key movement

### 6.8 Header Spacing & Breathing Room

After welcome header:
```
┌──────────────────────────────┐
│  ✻ Claude Code v2.1.x        │
│  Ready for input.            │
└──────────────────────────────┘

─────────────────────────────────


⏺ How can I help?
```

- **1 blank line** after header (full-width blank)
- **1 divider line** (subtle)
- **1 blank line** before first assistant message
- This creates visual hierarchy and breathing room

---

## Part 7: Recipe for Replicating Claude Code's Look in Ink

### 7.1 Project Setup

```bash
npm install ink react chalk cli-boxes
npm install --save-dev @types/react @types/cli-boxes
```

Optional (for polish):
```bash
npm install ink-gradient ink-box ink-ui
npm install chalk@4  # Ensure v4 for ESM
```

### 7.2 Core Components (TypeScript)

**Color constants**:
```tsx
// colors.ts
export const COLORS = {
  accent: '#FA7921',        // Orange
  accentDim: '#D4671E',     // Orange @ 60% opacity (approximated)
  white: '#FFFFFF',
  gray: '#AAAAAA',
  dimGray: '#666666',
  darkGray: '#333333',
  bg: '#0A0A0A',
  success: '#00C853',
  warning: '#FFC107',
  error: '#F44336',
  info: '#00BCD4',
};
```

**Main App shell**:
```tsx
// App.tsx
import React, { useState } from 'react';
import { Box, Text } from 'ink';
import Header from './components/Header';
import MessageHistory from './components/MessageHistory';
import InputBox from './components/InputBox';
import StatusLine from './components/StatusLine';

export default function App() {
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState([]);
  const [thinking, setThinking] = useState(false);

  return (
    <Box
      flexDirection="column"
      width={80}
      height={24}
      borderStyle="none"
    >
      {/* Header */}
      <Header />

      {/* Scrollable message area */}
      <Box
        flexDirection="column"
        flexGrow={1}
        overflow="hidden"
        marginTop={1}
        marginBottom={1}
      >
        <MessageHistory messages={messages} thinking={thinking} />
      </Box>

      {/* Divider */}
      <Box borderTop borderColor={COLORS.dimGray}>
        <Text color={COLORS.dimGray}>
          {Array(80).fill('─').join('')}
        </Text>
      </Box>

      {/* Input + status */}
      <InputBox
        input={input}
        setInput={setInput}
        onSubmit={(msg) => {
          setMessages([...messages, { role: 'user', text: msg }]);
          setInput('');
          setThinking(true);
        }}
      />

      {/* Status hints */}
      <StatusLine context={68} tokens={2300} />
    </Box>
  );
}
```

**Header component**:
```tsx
// components/Header.tsx
import React from 'react';
import { Box, Text } from 'ink';
import { COLORS } from '../colors';

export default function Header() {
  return (
    <Box
      borderStyle="round"
      borderColor={COLORS.dimGray}
      paddingX={2}
      paddingY={1}
      flexDirection="column"
    >
      <Box>
        <Text color={COLORS.accent}>✻ </Text>
        <Text color={COLORS.white} bold>Claude Code v2.1.x</Text>
      </Box>
      <Text color={COLORS.gray}>Ready for agentic coding.</Text>
      <Box marginTop={1}>
        <Text color={COLORS.gray}>/help  /example  /settings</Text>
      </Box>
    </Box>
  );
}
```

**User message component**:
```tsx
// components/UserMessage.tsx
import React from 'react';
import { Box, Text } from 'ink';
import { COLORS } from '../colors';

export default function UserMessage({ text }: { text: string }) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color={COLORS.dimGray}>{'> '}</Text>
        <Text color={COLORS.white}>{text}</Text>
      </Box>
    </Box>
  );
}
```

**Assistant message with tool call**:
```tsx
// components/AssistantMessage.tsx
import React from 'react';
import { Box, Text } from 'ink';
import { COLORS } from '../colors';

interface ToolCall {
  type: 'bash' | 'edit' | 'read';
  command?: string;
  file?: string;
  status: 'pending' | 'running' | 'done' | 'error';
  elapsed?: number;
  tokens?: number;
}

interface AssistantMessageProps {
  text: string;
  toolCall?: ToolCall;
}

export default function AssistantMessage({ text, toolCall }: AssistantMessageProps) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      {/* Main message */}
      <Box>
        <Text color={COLORS.dimGray}>⏺ </Text>
        <Text color={COLORS.white}>{text}</Text>
      </Box>

      {/* Tool call if present */}
      {toolCall && (
        <Box flexDirection="column" marginLeft={2} marginTop={0}>
          <Box>
            <Text color={COLORS.white} bold>
              {toolCall.type.toUpperCase()}
            </Text>
          </Box>

          <Box marginLeft={2} marginTop={0}>
            {toolCall.command && (
              <Text color={COLORS.gray}>command: {toolCall.command}</Text>
            )}
            {toolCall.file && (
              <Text color={COLORS.gray}>file: {toolCall.file}</Text>
            )}
          </Box>

          <Box marginLeft={2} marginTop={0}>
            <Text color={COLORS.info}>
              ⎿ {getStatusIcon(toolCall.status)} {getStatusText(toolCall.status)}
              {toolCall.elapsed && ` (${toolCall.elapsed}s`}
              {toolCall.tokens && ` · ⚒ ${toolCall.tokens}k tokens`}
              {(toolCall.elapsed || toolCall.tokens) && ')'}
            </Text>
          </Box>
        </Box>
      )}
    </Box>
  );
}

function getStatusIcon(status: string): string {
  switch (status) {
    case 'pending': return '◯';
    case 'running': return '▶';
    case 'done': return '✓';
    case 'error': return '✗';
    default: return '?';
  }
}

function getStatusText(status: string): string {
  switch (status) {
    case 'pending': return 'pending…';
    case 'running': return 'running…';
    case 'done': return 'done';
    case 'error': return 'failed';
    default: return 'unknown';
  }
}
```

**Input box**:
```tsx
// components/InputBox.tsx
import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { COLORS } from '../colors';

interface InputBoxProps {
  input: string;
  setInput: (val: string) => void;
  onSubmit: (msg: string) => void;
}

export default function InputBox({ input, setInput, onSubmit }: InputBoxProps) {
  useInput((str, key) => {
    if (key.return) {
      if (input.trim()) {
        onSubmit(input);
      }
    }
  });

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={COLORS.accent}>{'>  '}</Text>
        <TextInput
          value={input}
          onChange={setInput}
          placeholder="your prompt here…"
        />
      </Box>
      <Text color={COLORS.dimGray} fontSize="small">
        Hints: Tab to cycle · Ctrl+C to exit · ? for shortcuts
      </Text>
    </Box>
  );
}
```

**Status line**:
```tsx
// components/StatusLine.tsx
import React from 'react';
import { Box, Text } from 'ink';
import { COLORS } from '../colors';

interface StatusLineProps {
  context: number;  // 0-100
  tokens: number;
}

export default function StatusLine({ context, tokens }: StatusLineProps) {
  const contextColor = context > 85 ? COLORS.warning : COLORS.gray;

  return (
    <Box justifyContent="flex-end">
      <Text color={contextColor}>
        ◯ Context: {context}% · ⚒ {tokens}k tokens
      </Text>
    </Box>
  );
}
```

### 7.3 Spacing & Rhythm Rules

**Vertical spacing**:
- Between messages: `marginBottom={1}` (1 line)
- Between sections: `marginBottom={2}` (2 lines = blank line)
- Inside boxes: `paddingY={1}` or `{2}`

**Horizontal spacing**:
- Inside borders: `paddingX={2}` (2 chars on each side)
- Indentation for nested content: `marginLeft={2}`

**Line height**: Ink defaults to 1 line per Text element. Explicit line breaks use multiple Box elements with marginTop.

### 7.4 Animation & State

**Spinner animation**:
```tsx
// hooks/useSpinner.ts
import { useEffect, useState } from 'react';

const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export function useSpinner(active: boolean) {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    if (!active) return;
    const interval = setInterval(() => {
      setFrame((f) => (f + 1) % spinnerFrames.length);
    }, 80);
    return () => clearInterval(interval);
  }, [active]);

  return spinnerFrames[frame];
}
```

**Verb rotation**:
```tsx
const verbs = ['Thinking', 'Brewing', 'Analyzing', 'Pondering'];
const [verbIndex, setVerbIndex] = useState(0);

useEffect(() => {
  const interval = setInterval(() => {
    setVerbIndex((v) => (v + 1) % verbs.length);
  }, 2000);
  return () => clearInterval(interval);
}, []);

// In render:
<Text color={COLORS.info}>
  {spinnerFrame} {verbs[verbIndex]}…
</Text>
```

**Elapsed time counter**:
```tsx
const [elapsed, setElapsed] = useState(0);

useEffect(() => {
  const startTime = Date.now();
  const interval = setInterval(() => {
    setElapsed(Math.floor((Date.now() - startTime) / 1000));
  }, 100);
  return () => clearInterval(interval);
}, []);

// In render:
<Text color={COLORS.dimGray}>({elapsed}s)</Text>
```

### 7.5 Responsive Layout

Ink provides terminal dimensions via `useWindowSize()`:

```tsx
import { useWindowSize } from 'ink';

export function App() {
  const { width, height } = useWindowSize();

  return (
    <Box width={width} height={height} flexDirection="column">
      {/* layout adapts to width/height */}
    </Box>
  );
}
```

Wrap long text with:
```tsx
import wordwrap from 'word-wrap';

<Text>{wordwrap(longText, { width: width - 4 })}</Text>
```

---

## Part 8: Color Hex Reference Table

| Element | Purpose | Hex | RGB | Use Case |
|---------|---------|-----|-----|----------|
| Accent | Primary interactive | `#FA7921` | 250, 121, 33 | Focus, buttons, stars |
| Accent Dim | Disabled/secondary | `#D4671E` | 212, 103, 30 | Dim prefix, inactive |
| White | Primary text | `#FFFFFF` | 255, 255, 255 | All main content |
| Gray | Secondary text | `#AAAAAA` | 170, 170, 170 | Muted messages |
| Dim Gray | Borders/hints | `#666666` | 102, 102, 102 | Dividers, status |
| Dark Gray | Subtle dividers | `#333333` | 51, 51, 51 | Faint lines |
| Background | Terminal bg | `#0A0A0A` | 10, 10, 10 | Fill color |
| Success | Checkmarks | `#00C853` | 0, 200, 83 | ✓ done, green states |
| Warning | Alerts | `#FFC107` | 255, 193, 7 | ⚠ context warning |
| Error | Failures | `#F44336` | 244, 67, 54 | ✗ failed, red states |
| Info | Informational | `#00BCD4` | 0, 188, 212 | ⏳ pending, cyan |

---

## Part 9: Open Questions & Variations

### 9.1 Things That Vary by Theme

- **Accent color**: Claude Code uses orange, but users can customize via tweakcc. OpenCode may use rust/warm tones.
- **Spinner style**: Braille dots, Unicode stars, classic ASCII. Customizable.
- **Verb list**: "Thinking" vs "Brewing" vs "Pondering" is theme/personalization.
- **Border style**: Single-line, double-line, rounded, or custom ASCII art.

### 9.2 Terminal Capability Fallbacks

If terminal doesn't support truecolor:
- Fall back to 256-color palette closest hex match
- Use ANSI 16-color if available: orange → bright yellow, dim gray → normal black
- Gracefully degrade bold/italic if not supported

### 9.3 Accessibility Considerations

- **Color contrast**: White (#FFF) on black (#0A0A0A) = 21:1 WCAG AAA ✓
- **Not color-alone**: Use icons (✓, ✗, ⏺) in addition to color for status
- **Focus indicators**: Highlight on arrow key navigation
- **Screen reader**: Alt text on Unicode glyphs where needed (less critical in CLI, but good practice)

---

## Part 10: Implementation Checklist

- [ ] Set up Ink + React TypeScript project
- [ ] Define color constants (use the hex reference table above)
- [ ] Implement Header component with border and star glyph
- [ ] Build MessageHistory with UserMessage & AssistantMessage components
- [ ] Add ToolCall component with nested status indicators
- [ ] Create InputBox with TextInput and keyboard handlers
- [ ] Implement StatusLine with context % and token counter
- [ ] Add useSpinner hook with Braille animation
- [ ] Implement verb rotation (2s cycle)
- [ ] Add useWindowSize responsive layout
- [ ] Style Diff/Edit previews (red/green lines)
- [ ] Build Permission dialog with keyboard shortcuts
- [ ] Implement animated elapsed-time counter
- [ ] Add theme customization layer (JSON → color override)
- [ ] Test on multiple terminals (iTerm2, VSCode, Linux TTY, Windows Terminal)
- [ ] Verify truecolor support detection & fallback behavior
- [ ] Create "spacing rhythm" unit system (4px = 2 spaces, 8px = 4 spaces)

---

## Sources & References

**Primary Research**:
1. **Claude Code leaked source** (manikqi/claude-leaked on GitHub) — TypeScript UI components, themes, spinners
2. **tweakcc documentation** (Piebald-AI/tweakcc) — customization framework, theme system, available spinners/verbs
3. **OpenCode design system** (oh-my-design.kr analysis) — color palette (#201d1d primary, warm borders), theme JSON schema
4. **Ink framework docs** (vadimdemedes/ink on GitHub) — Yoga flexbox, rendering, alternate screen buffer
5. **Ink layout patterns** (combray.prose.sh articles on TUI development) — fixed footer + scrollable content, flexGrow techniques
6. **Builder.io Claude Code preview feature** — visual editing, screenshot-based iteration
7. **Gemini CLI** (github.com/google-gemini/gemini-cli) — open-source reference implementation, Ink-based

**Secondary References**:
- Reddit r/ClaudeCode, r/ClaudeAI — community screenshots, customization discussions
- HackerNews discussions on Claude Code, agentic CLIs, TUI design
- CSS Flexbox specification — baseline for Yoga layout engine
- chalk & cli-boxes npm docs — ANSI color codes, box-drawing characters

**URLs**:
- https://github.com/manikqi/claude-leaked
- https://github.com/Piebald-AI/tweakcc
- https://oh-my-design.kr/design-systems/opencode.ai
- https://github.com/vadimdemedes/ink
- https://github.com/google-gemini/gemini-cli
- https://combray.prose.sh/2025-12-01-tui-development
- https://www.builder.io/blog/claude-code-visual-editor
- https://claudefa.st/blog/tools/customization/customize-claude-code

---

**End of Specification**

This document is a living spec. Update sections as new tools ship or design patterns emerge.

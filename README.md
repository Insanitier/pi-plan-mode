# pi-plan-mode

Grill-first planning mode for Pi. A two-phase (`/plan` → grill → compose → implement) extension with a narumitw-style `/plan tools` TUI for tool toggling.

## Install

```bash
pi install git:github.com/Insanitier/pi-plan-mode
```

## Quick start

```text
/plan
```

That enters Plan mode:

1. **Grill phase** — one question at a time, relentless boundary clarification until you confirm
2. **Compose phase** — writes the plan in a fixed template with validation and retry
3. **Review** — implement, stay in plan mode, or exit

## Commands

| Command | What it does |
|---------|-------------|
| `/plan` | Enter plan mode (grill → compose flow) |
| `/plan tools` | Open paginated tool selector (narumitw-style) |
| `/plan exit` / `/plan off` | Exit plan mode |
| `--plan` | Auto-enter plan mode on session start |

## Features

- **Tool defaults**: ALL tools enabled except `edit`/`write`; extension tools stay available
- **Grill skill**: loads the local grilling skill prompt dynamically; one question at a time, unlimited count
- **Tool TUI**: paginated selector; `[x]` enabled, `[-]` blocked (edit/write), `[ ]` disabled
- **Compose template**: `## Summary` / `## Key Changes` / `## Test Plan` / `## Assumptions`
- **Validation**: missing or empty sections trigger retry with specific feedback
- **Safety**: `edit`/`write` blocked at both `tool_call` event and tool level; bash destructive commands intercepted
- **Persistence**: tool choices and phase survive session reload

## Development

```bash
npm install
npm run typecheck
```

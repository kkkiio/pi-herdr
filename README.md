# pi-herdr

Subagents and agent-to-agent messaging for pi, running inside [herdr](https://herdr.dev) panes.

Only activated when pi is run in the herdr environment (`HERDR_ENV=1`).

## Installation

```bash
pi install @kkkiio/pi-herdr
```

## Bundled subagents

pi-herdr ships two built-in subagents:

- **`explorer`** — read-only codebase search. Use it to find files, grep symbols, or answer "where is X defined". Defaults to the cheapest available model (`gpt-5.6-luna` first, then `deepseek-v4-flash`), falling back to the parent model with a warning.
- **`general-purpose`** — general-purpose agent with full tools, including `edit`/`write`. Defaults to the parent model.

## Usage

Ask the pi agent to explore a repo using the bundled `explorer` agent:

```
Use gpt-5.6-luna to explore the `ldtk` repo and describe all the art assets within it.
```

Spawn a `general-purpose` subagent for a multi-step task:

```
Spawn a general-purpose subagent to refactor all JSON parsing in `src/` to use the new parser module.
```

## Tools

- `Agent` — spawn a subagent in a herdr pane.
- `get_subagent_result` — fetch the result of a background subagent.
- `steer_subagent` — send a mid-run message to a running subagent.
- `ListAgents` / `SendMessage` — agent-to-agent messaging.

## Custom agents

Add `.pi/agents/<name>.md`, `.agents/agents/<name>.md`, or `~/.pi/agent/agents/<name>.md` to define custom agents. A custom `explorer.md` or `general-purpose.md` overrides the bundled version. Project-level files (`.pi/agents/`) take precedence over workspace-level (`.agents/agents/`), which take precedence over global ones.

See `docs/adr/003-agent-definitions.md` for the frontmatter format.

## Documentation

- `docs/subagents.md` — subagent API and lifecycle.
- `docs/messaging.md` — agent-to-agent messaging.
- `docs/adr/` — architecture decision records.

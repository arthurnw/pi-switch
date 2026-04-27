# pi-switch

A [pi](https://github.com/badlogic/pi-mono) extension for deliberate model switching via slash-command
shortcuts. Configure tiers (opus/sonnet/haiku or equivalent) across multiple providers, then
target a specific (provider, tier) per message. Inspired by
[kyleboas/pi-cycle](https://github.com/kyleboas/pi-cycle); diverged to support explicit selection
instead of round-robin cycling.

## Features

- **Explicit model targeting**: `/t1 explain this` uses the default provider's tier 1 for one turn.
- **Provider overrides**: `/t2:openai explain this` uses OpenAI's tier 2 for one turn.
- **Nickname shortcuts**: `/t1:sonnet explain this` resolves via global nicknames.
- **One-shot by default, sticky defaults**: Per-message targeting reverts to defaults after the
  turn. Change defaults explicitly with `/default`.
- **Live footer preview**: The pending model is shown in the status bar as you type, before you
  submit (requires [pi-status-bar](https://github.com/kboas/pi-status-bar) or equivalent footer
  that renders extension statuses).

## Commands

| Command                          | Behavior                                                   | Writes to disk | Reverts after turn |
| -------------------------------- | ---------------------------------------------------------- | :------------: | :----------------: |
| `/t1 <message>`                  | Send `<message>` with default provider's tier 1            |       ✗        |         ✓          |
| `/t2:anthropic <message>`        | Explicit provider, this turn only                          |       ✗        |         ✓          |
| `/t3:sonnet <message>`           | Nickname (overrides tier digit), this turn only            |       ✗        |         ✓          |
| `/t1` (no body)                  | Alias for `/default tier 1`                                |       ✓        |         ✗          |
| `/t1:openai` (no body)           | Alias for setting default provider + default tier together |       ✓        |         ✗          |
| `/t2:sonnet` (nickname, no body) | Set active model from nickname. Sticky for session.        |       ✗        |         ✗          |
| `/default show`                  | Print current defaults and active model                    |       —        |         —          |
| `/default provider <name>`       | Set default provider (validates current tier exists)       |       ✓        |         ✗          |
| `/default tier <1\|2\|3>`        | Set default tier (validates current provider has it)       |       ✓        |         ✗          |
| `/default reset`                 | Reload config file from disk and re-apply defaults         |       —        |         —          |
| `/switch <provider>/<model-id>`  | Direct `setModel`. Sticky for session, doesn't save.       |       ✗        |         ✗          |

**Three axes to think about:**

- **Writes to disk**: affects future sessions (persisted in `~/.pi/agent/pi-switch.json`).
- **Reverts after turn**: one-shot — only applies to the message that carried the prefix.
- **Sticky for session**: affects subsequent plain messages until overridden or pi restarts.

`/default ...` = sticky forever. `/switch` = sticky for session. `/tN <msg>` = just this turn.

## Install

```sh
pi install git:github.com/arthurnw/pi-switch
```

This clones the repo to `~/.pi/agent/git/github.com/arthurnw/pi-switch` and adds
it to the `packages` array in `settings.json`. `pi update` pulls latest. To
pin: append `@v0.1.0` (or any tag/commit). SSH form is also accepted:
`pi install git:git@github.com:arthurnw/pi-switch`.

### Dev install (editable)

For iterating on pi-switch itself, clone wherever you keep source and symlink
the extension file. pi auto-discovers single-file extensions in
`~/.pi/agent/extensions/`:

```sh
git clone https://github.com/arthurnw/pi-switch.git ~/code/oss/pi-switch
ln -s ~/code/oss/pi-switch/pi-switch.ts ~/.pi/agent/extensions/pi-switch.ts
```

Don't combine the two install paths on the same machine — you'd register the
extension twice.

Start pi. On first run, `~/.pi/agent/pi-switch.json` is created with a seed config
covering anthropic, openai, and google. Edit it to match your available providers/keys.

## Config

`~/.pi/agent/pi-switch.json`:

```json
{
  "defaultProvider": "anthropic",
  "defaultTier": 2,
  "providers": {
    "anthropic": {
      "1": "claude-opus-4-7",
      "2": "claude-sonnet-4-6",
      "3": "claude-haiku-4-5"
    },
    "openai": {
      "1": "gpt-5.4",
      "2": "gpt-5.4-mini",
      "3": "gpt-5.4-nano"
    },
    "google": {
      "1": "gemini-3.1-pro-preview",
      "2": "gemini-2.5-flash",
      "3": "gemini-2.5-flash-lite"
    }
  },
  "nicknames": {
    "opus": "anthropic/claude-opus-4-7",
    "sonnet": "anthropic/claude-sonnet-4-6",
    "haiku": "anthropic/claude-haiku-4-5",
    "pro": "google/gemini-3.1-pro-preview",
    "flash": "google/gemini-2.5-flash"
  },
  "thinking": {
    "anthropic/claude-opus-4-7": "xhigh",
    "anthropic/claude-sonnet-4-6": "high",
    "anthropic/claude-haiku-4-5": "high",
    "openai/gpt-5.4": "xhigh",
    "openai/gpt-5.4-mini": "xhigh",
    "openai/gpt-5.4-nano": "xhigh",
    "google/gemini-3.1-pro-preview": "high",
    "google/gemini-2.5-flash": "high",
    "google/gemini-2.5-flash-lite": "high"
  }
}
```

**Config rules:**

- `defaultProvider` must be a key in `providers`. If missing or invalid, falls back to the first
  provider defined.
- `defaultTier` must be 1, 2, or 3. Defaults to 1 if missing or invalid.
- Each provider entry maps `"1"`, `"2"`, `"3"` to model IDs (matching pi's model registry).
- `nicknames` map a short name to `"provider/model-id"`. Used as `/tN:<nickname>`. Nicknames
  override the tier digit — `/t3:sonnet` uses the nickname's model, not tier 3 of its provider.
- `thinking` maps `"provider/model-id"` to a reasoning level: `off`, `minimal`, `low`, `medium`,
  `high`, or `xhigh`. Applied automatically each time pi-switch sets a model. pi clamps
  unsupported levels (e.g. `xhigh` on a non-thinking model) so it's safe to overconfigure.
  Models not in the map keep whatever level pi already has. Manual `shift+tab` overrides between
  turns are preserved (they only get reset on the next pi-switch-driven model change).

Edit the config directly on disk, then run `/default reset` or restart pi.

## Semantics

Three kinds of state:

- **Defaults** (persistent, on disk): `defaultProvider` + `defaultTier`. Plain messages use these.
  Changed via `/default ...` commands or by bare `/tN` / `/tN:provider` (no body).
- **Active model** (session-only): what pi.setModel is currently set to. Usually matches defaults
  but diverges during one-shots and after `/switch` or bare `/tN:nickname`.
- **Active override flag** (in-memory, transient): set by `/tN <message>` one-shots. Triggers a
  revert to defaults at `agent_end`. `/switch` and bare nickname forms deliberately don't set
  this flag, so they persist for the session.

Example timeline (starting default: `anthropic/claude-sonnet-4-6`):

```
tell me about python          → sonnet (default)
/t1 hard question             → opus, revert to sonnet after
another question              → sonnet (default, restored)
/t2:openai quick check        → gpt-5.4-mini, revert to sonnet after
/switch openai/gpt-5.4        → active = gpt-5.4, no save, no revert
keep working on this          → gpt-5.4 (sticky for session)
/default provider openai      → defaults become openai/tier2, on disk
plain message                 → gpt-5.4-mini (new default)
<restart pi>
plain message                 → gpt-5.4-mini (persisted)
```

## Status bar integration

pi-switch writes one extension status key: `pi-switch`. It has two visual states:

- **Idle** — dim text `· default: <provider>/t<tier>`. Shows what plain messages will use.
- **Typing a prefix** — bright text `· → <provider>/<model-id>`. Shows what the pending prefix
  resolves to. Replaces the idle text while visible, restores on submit or when the draft no
  longer matches.

ANSI codes are embedded in the status text to dim the idle state. If your footer renderer strips
ANSI (unlikely), the separator and label still show but without dimming.

If you don't have a footer that renders extension statuses via `footerData.getExtensionStatuses()`,
the information is not lost — each prefix-triggered model change is also echoed via
`ctx.ui.notify`.

## Tradeoffs & non-features

- **No tab completion for `/t1` / `/t2` / `/t3`** — they're parsed via the `input` event, not
  registered as real commands. Completion works for `/default ...` and `/switch`.
- **No sticky-for-session one-shot** — every `/tN <message>` reverts. Use `/switch` or bare
  `/tN:nickname` to stick without writing to disk. Use `/default ...` to stick forever.
- **Nicknames are global** — they don't carry provider/tier context and always resolve to the
  same model.
- **Live preview requires `onTerminalInput`** — only available in interactive mode. In RPC or
  print mode, status updates still happen on submit but not as you type.

## Attribution

Inspired by [kyleboas/pi-cycle](https://github.com/kyleboas/pi-cycle). Thanks to
[@mariozechner](https://github.com/mariozechner) for the pi extension API.

## License

MIT

# omp-plugins

Plugins for [omp (oh-my-pi)](https://github.com/can1357/oh-my-pi), distributed as an omp marketplace.

## opencode-zen-free

Lets omp use OpenCode Zen's free models (`opencode-zen/*-free`, `opencode-zen/big-pickle`). Without it, every request to them fails with:

```
403 OpenCode's free tier can only be used from within OpenCode. (type=FreeTierError)
```

OpenCode Go models (`opencode-go/*`) are a paid subscription and work in omp without this plugin.

### Requirements

- omp 18.x
- An OpenCode Zen API key (free account at <https://opencode.ai/zen>). Add it in omp with `/login` → **OpenCode Zen**, or export `OPENCODE_API_KEY`.

### Install

```sh
omp plugin marketplace add Unravl/omp-plugins
omp plugin install opencode-zen-free@omp-plugins
```

Or from inside omp:

```
/marketplace add Unravl/omp-plugins
/marketplace install opencode-zen-free@omp-plugins
```

Restart omp (or run `/reload`), then pick a free model:

```sh
omp --model opencode-zen/deepseek-v4.1-flash-free
```

If you previously copied an `opencode-zen-free.ts` into `~/.omp/agent/extensions/`, delete it so the plugin isn't loaded twice.

### Update

OpenCode changes its free-tier check often. If the `FreeTierError` comes back, update:

```sh
omp plugin marketplace update omp-plugins
omp plugin upgrade opencode-zen-free@omp-plugins
```

### Uninstall

```sh
omp plugin uninstall opencode-zen-free@omp-plugins
omp plugin marketplace remove omp-plugins
```

### What's included

| Module | What it does |
|---|---|
| `index.ts` | Rewrites omp's requests for free Zen models so they pass OpenCode's free-tier check. |
| `zen-judge.ts` | `/zen-judge {"state": "...", "questions": {...}}` runs a judgment with `jev-1.13-free`. Needs omp 18.10 or newer; older builds print `Failed to load extension …zen-judge.ts` at startup, which is harmless: the free-model fix still loads. |

### How it works

The plugin wraps `fetch` and, for free Zen models only, makes each request look like it came from the opencode client. As of 2026-10-15 OpenCode's check requires:

| Requirement | What the plugin does |
|---|---|
| Free models are served from `opencode.ai/inference/v1`; `/zen/v1` rejects them | Rewrites `/zen/…` to `/inference/…` |
| Session id shaped like opencode's: `ses_` + 12-hex inverted timestamp + 14 base62 chars | Generates one per omp session |
| Both `x-opencode-session` and `x-opencode-session-id` headers | Sends both |
| An `opencode/<version>` User-Agent | Sends `opencode/1.18.35` |
| A `read` tool with at least one parameter | Adds a placeholder `read` tool to requests that lack one (title generation, advisors, some subagents) |

Paid Zen models and OpenCode Go requests pass through untouched.

OpenCode intends its free tier for its own client. This plugin bypasses that; use it at your own risk.

### Maintaining

When you change the plugin, bump `version` in both `plugins/opencode-zen-free/package.json` and `.omp-plugin/marketplace.json`. `omp plugin upgrade` only picks up a new catalog version.

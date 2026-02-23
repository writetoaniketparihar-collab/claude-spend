# claude-spent

See where your Claude Code tokens go. One command, zero setup.

## Just run this

```
npx claude-spent
```

No installation. No config. No account. Just run it and your dashboard opens in the browser — instantly.

## Problem

Been using Claude Code every day? Hit the usage limit but have zero visibility into which prompts are eating your tokens. claude-spent fixes that. One command, zero setup.

## How does it look

<img src="https://github.com/user-attachments/assets/898526e6-cf06-4a55-8e4f-07b6da0f40e7" />

<img src="https://github.com/user-attachments/assets/5a97c605-6fba-4d33-91f4-643abddd6318" />

<img src="https://github.com/user-attachments/assets/2ce109b2-8ef3-4f19-ab4b-c27e2d396153" />

<img src="https://github.com/user-attachments/assets/93ffe785-aace-4b6c-aba7-f623ee4a9a18" />

<img src="https://github.com/user-attachments/assets/b6069642-59c4-4e3a-a89e-1327e19ea1ce" />

<img src="https://github.com/user-attachments/assets/46676b31-13aa-4ce9-842e-6f020dae916b" />

## Install

```
npx claude-spent
```

That's it. Opens a dashboard in your browser.

## What it does

- Reads your local Claude Code session files (nothing leaves your machine)
- Shows token usage per conversation, per day, and per model
- Surfaces insights like which prompts cost the most and usage patterns

## Options

```
claude-spent --port 8080   # custom port (default: 3455)
claude-spent --no-open     # don't auto-open browser
```

## Privacy

All data stays local. claude-spent reads files from `~/.claude/` on your machine and serves a dashboard on localhost. No data is sent anywhere.

## License

MIT

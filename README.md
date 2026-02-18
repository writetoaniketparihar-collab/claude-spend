# claude-spend

See where your Claude Code tokens go. One command, zero setup.

## Install

```
npx claude-spend
```

That's it. Opens a dashboard in your browser.

## What it does

- Reads your local Claude Code session files (nothing leaves your machine)
- Shows token usage per conversation, per day, and per model
- Surfaces insights like which prompts cost the most and usage patterns

## Options

```
claude-spend --port 8080   # custom port (default: 3456)
claude-spend --no-open     # don't auto-open browser
```

## Privacy

All data stays local. claude-spend reads files from `~/.claude/` on your machine and serves a dashboard on localhost. No data is sent anywhere.

## License

MIT

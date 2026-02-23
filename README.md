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

<img width="1910" height="966" alt="Screenshot 2026-02-18 092727" src="https://github.com/user-attachments/assets/11cc7149-d4dd-4e44-a3a0-0b48e935b7bc" />

<img width="1906" height="966" alt="Screenshot 2026-02-18 093529" src="https://github.com/user-attachments/assets/537c3611-5794-41d2-864e-e368e6949812" />

<img width="1908" height="969" alt="Screenshot 2026-02-18 093647" src="https://github.com/user-attachments/assets/aaaa8ce5-2025-407d-8596-ea1965748691" />

<img width="1908" height="969" alt="Screenshot 2026-02-18 093647" src="https://github.com/user-attachments/assets/a9fde5e2-6e52-4bae-9b96-03655109aef6" />

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

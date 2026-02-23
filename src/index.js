#!/usr/bin/env node

const { createServer } = require('./server');

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
claude-spend - See where your Claude Code tokens go

Usage:
  claude-spend [options]

Options:
  --port <port>   Port to run dashboard on (default: 3455)
  --no-open       Don't auto-open browser
  --summary       Print a usage summary to stdout and exit (no server)
  --help, -h      Show this help message

Examples:
  npx claude-spend          Open dashboard in browser
  claude-spend --port 8080  Use custom port
  claude-spend --summary    Print usage summary
`);
  process.exit(0);
}

if (args.includes('--summary')) {
  const { parseAllSessions } = require('./parser');

  function fmtNum(n) {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
    if (n >= 10_000)    return (n / 1_000).toFixed(0) + 'K';
    if (n >= 1_000)     return (n / 1_000).toFixed(1) + 'K';
    return n.toLocaleString();
  }

  parseAllSessions().then(data => {
    const t = data.totals;
    const dr = t.dateRange ? `${t.dateRange.from} – ${t.dateRange.to}` : 'No data';
    const sorted = [...data.modelBreakdown].sort((a, b) => b.totalTokens - a.totalTokens);
    const topModel = sorted[0];
    const topModelStr = topModel
      ? `${topModel.model} (${Math.round((topModel.totalTokens / Math.max(t.totalTokens, 1)) * 100)}%)`
      : 'N/A';

    const today = new Date().toISOString().split('T')[0];
    const todaySessions = data.sessions.filter(s => s.date === today);
    const todayCost = todaySessions.reduce((s, x) => s + (x.estimatedCost || 0), 0);
    const todayTokens = todaySessions.reduce((s, x) => s + x.totalTokens, 0);
    const todayLine = todaySessions.length > 0
      ? `Today:         ${todaySessions.length} session${todaySessions.length !== 1 ? 's' : ''} · ~$${todayCost.toFixed(2)} · ${fmtNum(todayTokens)} tokens`
      : `Today:         No sessions yet`;

    console.log(`
Claude Code Usage Summary
─────────────────────────
Total cost:    ~$${(t.totalEstimatedCost || 0).toFixed(2)}
Total tokens:  ${fmtNum(t.totalTokens)} (${fmtNum(t.totalInputTokens)} read · ${fmtNum(t.totalOutputTokens)} written)
Sessions:      ${t.totalSessions}
Date range:    ${dr}
Top model:     ${topModelStr}
Cache savings: ~$${(t.cacheSavingsDollars || 0).toFixed(2)}

${todayLine}
`);
    process.exit(0);
  }).catch(err => {
    console.error('Error:', err.message);
    process.exit(1);
  });
} else {
  const portIndex = args.indexOf('--port');
  const port = portIndex !== -1 ? parseInt(args[portIndex + 1], 10) : 3455;
  const noOpen = args.includes('--no-open');

  if (isNaN(port)) {
    console.error('Error: --port must be a number');
    process.exit(1);
  }

  const app = createServer();

  const server = app.listen(port, async () => {
    const url = `http://localhost:${port}`;
    console.log(`\n  claude-spend dashboard running at ${url}\n`);

    if (!noOpen) {
      try {
        const open = (await import('open')).default;
        await open(url);
      } catch {
        console.log('  Could not auto-open browser. Open the URL manually.');
      }
    }
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${port} is already in use. Try --port <other-port>`);
      process.exit(1);
    }
    throw err;
  });

  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log('\n  Shutting down...');
    server.close();
    process.exit(0);
  });
}

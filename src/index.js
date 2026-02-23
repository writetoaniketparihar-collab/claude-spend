#!/usr/bin/env node

const { createServer } = require('./server');

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
claude-spend - See where your Claude Code tokens go

Usage:
  claude-spend [options]

Options:
  --port <port>   Port to run dashboard on (default: 3456)
  --no-open       Don't auto-open browser
  --help, -h      Show this help message

Examples:
  npx claude-spend          Open dashboard in browser
  claude-spend --port 8080  Use custom port
`);
  process.exit(0);
}

const portIndex = args.indexOf('--port');
const port = portIndex !== -1 ? parseInt(args[portIndex + 1], 10) : 3456;
const noOpen = args.includes('--no-open');

if (isNaN(port)) {
  console.error('Error: --port must be a number');
  process.exit(1);
}

const app = createServer();

const server = app.listen(port, '127.0.0.1', async () => {
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

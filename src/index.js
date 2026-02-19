#!/usr/bin/env node

const { createServer } = require('./server');
const { initOTLP, shutdownOTLP } = require('./otlp');

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
claude-spend - Token usage dashboard for Claude Code, Gemini CLI & Codex CLI

Usage:
  claude-spend [options]

Options:
  --port <port>              Port to run dashboard on (default: 3456)
  --no-open                  Don't auto-open browser
  --otlp-endpoint <url>      Send token usage metrics to an OTLP endpoint
                             (e.g. http://localhost:4318)
  --otlp-headers <headers>   Headers for OTLP endpoint as key=value pairs
                             separated by commas. Can be specified multiple times.
                             (e.g. --otlp-headers Authorization=Bearer tok --otlp-headers X-Org=my-org)
  --help, -h                 Show this help message

Environment variables:
  OTEL_EXPORTER_OTLP_ENDPOINT   OTLP endpoint (same as --otlp-endpoint)
  OTEL_EXPORTER_OTLP_HEADERS    OTLP headers as comma-separated key=value pairs

Examples:
  npx claude-spend                                              Open dashboard in browser
  claude-spend --port 8080                                      Use custom port
  claude-spend --otlp-endpoint http://localhost:4318             Export metrics via OTLP
  OTEL_EXPORTER_OTLP_ENDPOINT=http://otel:4318 claude-spend    Export via env var
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

// OTLP configuration: CLI flags take precedence over env vars
const otlpEndpointIndex = args.indexOf('--otlp-endpoint');
const otlpEndpoint = otlpEndpointIndex !== -1
  ? args[otlpEndpointIndex + 1]
  : process.env.OTEL_EXPORTER_OTLP_ENDPOINT || null;

// Collect all --otlp-headers flags (can be specified multiple times)
const otlpHeaderParts = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--otlp-headers' && args[i + 1]) {
    otlpHeaderParts.push(args[i + 1]);
    i++; // skip the value
  }
}
// Fall back to env var if no CLI flags
if (otlpHeaderParts.length === 0 && process.env.OTEL_EXPORTER_OTLP_HEADERS) {
  otlpHeaderParts.push(process.env.OTEL_EXPORTER_OTLP_HEADERS);
}

// Reuse the shared parser from server module
const { parseHeaderString } = require('./server');
let otlpHeaders = {};
for (const raw of otlpHeaderParts) {
  Object.assign(otlpHeaders, parseHeaderString(raw));
}

// Initialize OTLP if an endpoint is configured
let otel = null;
if (otlpEndpoint) {
  otel = initOTLP({ endpoint: otlpEndpoint, headers: otlpHeaders });
  console.log(`\n  OTLP metrics export enabled → ${otlpEndpoint}`);
}

const app = createServer({ otel, otlpEndpoint });

const server = app.listen(port, async () => {
  const url = `http://localhost:${port}`;
  console.log(`\n  Coding Agent Usage dashboard running at ${url}\n`);

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
process.on('SIGINT', async () => {
  console.log('\n  Shutting down...');
  await shutdownOTLP();
  server.close();
  process.exit(0);
});

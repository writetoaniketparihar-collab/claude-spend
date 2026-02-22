const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');

function createServer() {
  const app = express();

  // Cache parsed data (reparse on demand via refresh endpoint)
  let cachedData = null;

  // SSE clients list for live mode (F7)
  let sseClients = [];

  app.get('/api/data', async (req, res) => {
    try {
      if (!cachedData) {
        cachedData = await require('./parser').parseAllSessions();
      }
      res.json(cachedData);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/refresh', async (req, res) => {
    try {
      delete require.cache[require.resolve('./parser')];
      cachedData = await require('./parser').parseAllSessions();
      res.json({ ok: true, sessions: cachedData.sessions.length });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // F7: SSE endpoint for live mode
  app.get('/api/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    // Initial heartbeat so the client knows the connection is alive
    res.write('data: {"type":"connected"}\n\n');

    sseClients.push(res);
    req.on('close', () => {
      sseClients = sseClients.filter(c => c !== res);
    });
  });

  // F7: Watch ~/.claude/projects for new session files
  const projectsDir = path.join(os.homedir(), '.claude', 'projects');
  let debounceTimer = null;
  if (fs.existsSync(projectsDir)) {
    try {
      fs.watch(projectsDir, { recursive: true }, () => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          cachedData = null; // invalidate cache
          const msg = 'data: ' + JSON.stringify({ type: 'update' }) + '\n\n';
          sseClients.forEach(client => {
            try { client.write(msg); } catch { /* ignore dead connections */ }
          });
        }, 2000);
      });
    } catch {
      // fs.watch may not be available in all environments; fail silently
    }
  }

  // Serve static dashboard
  app.use(express.static(path.join(__dirname, 'public')));

  return app;
}

module.exports = { createServer };

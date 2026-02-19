const express = require('express');
const path = require('path');
const { parseAllSessions } = require('./parser');

function createServer() {
  const app = express();

  // Cache parsed data (reparse on demand via refresh endpoint)
  let cachedData = null;

  app.get('/api/data', async (req, res) => {
    try {
      if (!cachedData) {
        cachedData = await parseAllSessions();
      }
      res.json(cachedData);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/data-stream', async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    try {
      cachedData = await parseAllSessions((progress) => {
        res.write(`data: ${JSON.stringify(progress)}\n\n`);
      });
      res.write(`data: ${JSON.stringify({ stage: 'done' })}\n\n`);
      res.end();
    } catch (err) {
      res.write(`data: ${JSON.stringify({ stage: 'error', message: err.message })}\n\n`);
      res.end();
    }
  });

  app.get('/api/refresh', async (req, res) => {
    try {
      cachedData = await parseAllSessions();
      res.json({ ok: true, sessions: cachedData.sessions.length });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Serve static dashboard
  app.use(express.static(path.join(__dirname, 'public')));

  return app;
}

module.exports = { createServer };

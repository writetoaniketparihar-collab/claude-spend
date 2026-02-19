const express = require('express');
const path = require('path');
const { parseAllSessions } = require('./parser');
const { initOTLP, exportMetrics, shutdownOTLP, testEndpoint } = require('./otlp');

/**
 * Parse a header string into an object.
 * Supports both "Key: Value" and "Key=Value" formats, comma-separated.
 * Handles base64 values that contain "=" characters.
 */
function parseHeaderString(raw) {
  const headers = {};
  if (!raw || typeof raw !== 'string') return headers;

  for (const pair of raw.split(',')) {
    const trimmed = pair.trim();
    if (!trimmed) continue;

    // Try "Key: Value" first (colon-space), then "Key=Value"
    const colonIdx = trimmed.indexOf(': ');
    if (colonIdx > 0) {
      headers[trimmed.slice(0, colonIdx).trim()] = trimmed.slice(colonIdx + 2).trim();
      continue;
    }

    // Fallback: split on first "=" only — everything after is the value (safe for base64)
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx > 0) {
      const key = trimmed.slice(0, eqIdx).trim();
      // Only treat as key=value if the key looks like a valid header name (no spaces/colons)
      if (/^[A-Za-z0-9\-_]+$/.test(key)) {
        headers[key] = trimmed.slice(eqIdx + 1).trim();
        continue;
      }
    }

    // Try plain "Key:Value" (colon without space)
    const plainColonIdx = trimmed.indexOf(':');
    if (plainColonIdx > 0) {
      headers[trimmed.slice(0, plainColonIdx).trim()] = trimmed.slice(plainColonIdx + 1).trim();
    }
  }

  return headers;
}

function createServer({ otel, otlpEndpoint } = {}) {
  const app = express();
  app.use(express.json());

  // Cache parsed data (reparse on demand via refresh endpoint)
  let cachedData = null;

  // Mutable OTLP state — can be changed at runtime from the UI
  let currentOtel = otel || null;
  let otlpStatus = currentOtel
    ? { enabled: true, endpoint: otlpEndpoint, lastExport: null, lastError: null, exports: 0 }
    : { enabled: false };

  // Periodic export interval (re-parse sessions & push metrics every 60s)
  const EXPORT_INTERVAL_MS = 60_000;
  let exportTimer = null;

  function startPeriodicExport() {
    stopPeriodicExport();
    exportTimer = setInterval(async () => {
      try {
        cachedData = await parseAllSessions();
        if (currentOtel) {
          await exportMetrics(currentOtel, cachedData);
          otlpStatus.lastExport = new Date().toISOString();
          otlpStatus.lastError = null;
          otlpStatus.exports++;
        }
      } catch (err) {
        if (otlpStatus.enabled) {
          otlpStatus.lastError = err.message;
        }
        console.error('  OTLP periodic export failed:', err.message);
      }
    }, EXPORT_INTERVAL_MS);
  }

  function stopPeriodicExport() {
    if (exportTimer) {
      clearInterval(exportTimer);
      exportTimer = null;
    }
  }

  // Start periodic export if OTLP was configured via CLI
  if (currentOtel) startPeriodicExport();

  async function parseAndExport() {
    const data = await parseAllSessions();
    if (currentOtel) {
      try {
        await exportMetrics(currentOtel, data);
        otlpStatus.lastExport = new Date().toISOString();
        otlpStatus.lastError = null;
        otlpStatus.exports++;
      } catch (err) {
        otlpStatus.lastError = err.message;
        console.error('  OTLP export failed:', err.message);
      }
    }
    return data;
  }

  app.get('/api/data', async (req, res) => {
    try {
      if (!cachedData) {
        cachedData = await parseAndExport();
      }
      res.json({ ...cachedData, otlp: { ...otlpStatus, intervalSec: otlpStatus.enabled ? EXPORT_INTERVAL_MS / 1000 : null } });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/refresh', async (req, res) => {
    try {
      cachedData = await parseAndExport();
      res.json({ ok: true, sessions: cachedData.sessions.length, otlp: otlpStatus });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- OTLP configuration endpoints ---

  app.post('/api/otlp/connect', async (req, res) => {
    const { endpoint, headers } = req.body || {};
    if (!endpoint || typeof endpoint !== 'string') {
      return res.status(400).json({ error: 'Endpoint URL is required' });
    }

    // Parse headers — supports "Key: Value" and "Key=Value" formats
    const parsedHeaders = parseHeaderString(headers);

    try {
      // Step 1: Test connectivity before committing
      console.log(`  OTLP testing endpoint → ${endpoint.trim()}`);
      await testEndpoint(endpoint.trim(), parsedHeaders);
      console.log(`  OTLP endpoint reachable`);
    } catch (err) {
      console.error(`  OTLP endpoint test failed: ${err.message}`);
      return res.status(400).json({ error: err.message });
    }

    try {
      // Step 2: Shut down existing provider if any
      await shutdownOTLP();

      // Step 3: Initialize new OTLP pipeline
      currentOtel = initOTLP({ endpoint: endpoint.trim(), headers: parsedHeaders });
      otlpStatus = {
        enabled: true,
        endpoint: endpoint.trim(),
        lastExport: null,
        lastError: null,
        exports: 0,
      };

      console.log(`  OTLP connected → ${endpoint.trim()}`);

      // Step 4: Export current data immediately if available
      if (cachedData) {
        try {
          await exportMetrics(currentOtel, cachedData);
          otlpStatus.lastExport = new Date().toISOString();
          otlpStatus.exports++;
          console.log(`  OTLP initial export complete`);
        } catch (err) {
          otlpStatus.lastError = err.message;
        }
      }

      // Step 5: Start periodic re-parse + export every 60s
      startPeriodicExport();
      console.log(`  OTLP periodic export started (every ${EXPORT_INTERVAL_MS / 1000}s)`);

      res.json({ ok: true, otlp: otlpStatus });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/otlp/disconnect', async (req, res) => {
    try {
      stopPeriodicExport();
      await shutdownOTLP();
      currentOtel = null;
      otlpStatus = { enabled: false };
      console.log('  OTLP disconnected');
      res.json({ ok: true, otlp: otlpStatus });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Serve static dashboard
  app.use(express.static(path.join(__dirname, 'public')));

  return app;
}

module.exports = { createServer, parseHeaderString };

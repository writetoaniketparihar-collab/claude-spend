const express = require('express');
const path = require('path');
function createServer() {
  const app = express();

  // Cache parsed data per date range (reparse on demand via refresh endpoint)
  const cache = new Map();

  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

  // Validate/normalize ?from= and ?to=. Returns { from, to } or { invalid }.
  function parseRange(query) {
    const from = query.from ? String(query.from).trim() : null;
    const to = query.to ? String(query.to).trim() : null;

    for (const [name, val] of [['from', from], ['to', to]]) {
      if (val === null || val === '') continue;
      if (!DATE_RE.test(val)) {
        return { invalid: `Invalid "${name}" date "${val}". Expected format YYYY-MM-DD.` };
      }
      const d = new Date(val + 'T00:00:00');
      if (isNaN(d.getTime())) {
        return { invalid: `Invalid "${name}" date "${val}". Not a real calendar date.` };
      }
    }
    if (from && to && from > to) {
      return { invalid: `Start date (${from}) is after end date (${to}).` };
    }
    return { from: from || null, to: to || null };
  }

  const cacheKey = (from, to) => `${from || ''}..${to || ''}`;

  // Full date bounds of all available data, for initializing the date pickers.
  // Tagged with the local day it was computed on: today's activity extends the
  // upper bound, so a value cached yesterday is stale even if the files on disk
  // have not changed.
  let boundsCache = null;
  let boundsDay = null;

  const localDay = () => {
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };

  function friendlyError(err) {
    const msg = err.message || String(err);
    if (err.code === 'ENOENT') return { error: 'Claude Code data directory not found. Have you used Claude Code yet?', code: 'ENOENT' };
    if (err.code === 'EPERM' || err.code === 'EACCES') return { error: 'Permission denied reading Claude Code data. Try running with elevated permissions.', code: err.code };
    return { error: msg };
  }

  app.get('/api/data', async (req, res) => {
    const range = parseRange(req.query);
    if (range.invalid) {
      return res.status(400).json({ error: range.invalid, code: 'BAD_RANGE' });
    }
    try {
      const key = cacheKey(range.from, range.to);
      if (!cache.has(key)) {
        cache.set(key, await require('./parser').parseAllSessions(range));
      }
      res.json(cache.get(key));
    } catch (err) {
      res.status(500).json(friendlyError(err));
    }
  });

  app.get('/api/refresh', async (req, res) => {
    const range = parseRange(req.query);
    if (range.invalid) {
      return res.status(400).json({ error: range.invalid, code: 'BAD_RANGE' });
    }
    try {
      delete require.cache[require.resolve('./parser')];
      // Session files may have changed on disk, so every cached range is stale.
      cache.clear();
      boundsCache = null;
      boundsDay = null;
      const data = await require('./parser').parseAllSessions(range);
      cache.set(cacheKey(range.from, range.to), data);
      res.json({ ok: true, sessions: data.sessions.length });
    } catch (err) {
      res.status(500).json(friendlyError(err));
    }
  });

  // Always computed unfiltered, and cached separately from range queries.
  app.get('/api/bounds', async (req, res) => {
    try {
      const today = localDay();
      if (!boundsCache || boundsDay !== today) {
        // Reparse rather than reusing the unfiltered cache entry, which is only
        // invalidated by /api/refresh and could itself predate today.
        const all = await require('./parser').parseAllSessions({});
        boundsCache = all.totals?.dateRange || null;
        boundsDay = today;
      }
      res.json({ bounds: boundsCache });
    } catch (err) {
      res.status(500).json(friendlyError(err));
    }
  });

  // Serve static dashboard
  app.use(express.static(path.join(__dirname, 'public')));

  return app;
}

module.exports = { createServer };

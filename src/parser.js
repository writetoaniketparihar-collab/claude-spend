const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');

function getClaudeDir() {
  return path.join(os.homedir(), '.claude');
}

function pathToProjectDir(absPath) {
  // "D:\GitHub\iracing-stats" → "D--GitHub-iracing-stats"
  return absPath.replace(/^([A-Za-z]):\\/, '$1--').replace(/\\/g, '-');
}

async function parseJSONLFile(filePath) {
  const lines = [];
  const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      lines.push(JSON.parse(line));
    } catch {
      // Skip malformed lines
    }
  }
  return lines;
}

function extractSessionData(entries, projectDir) {
  const queries = [];
  let pendingUserMessage = null;
  const wdCounts = {};

  for (const entry of entries) {
    if (typeof entry.message?.content === 'string') {
      const m = entry.message.content.match(/<working_directory>([^<]+)<\/working_directory>/);
      if (m) wdCounts[m[1]] = (wdCounts[m[1]] || 0) + 1;
    }
    if (entry.type === 'user' && entry.message?.role === 'user') {
      const content = entry.message.content;
      if (entry.isMeta) continue;
      if (typeof content === 'string' && (
        content.startsWith('<local-command') ||
        content.startsWith('<command-name')
      )) continue;

      const textContent = typeof content === 'string'
        ? content
        : content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
      pendingUserMessage = {
        text: textContent || null,
        timestamp: entry.timestamp,
      };
    }

    if (entry.type === 'assistant' && entry.message?.usage) {
      const usage = entry.message.usage;
      const model = entry.message.model || 'unknown';
      if (model === '<synthetic>') continue;

      const baseInputTokens = usage.input_tokens || 0;
      const cacheWriteTokens = usage.cache_creation_input_tokens || 0;
      const cacheReadTokens = usage.cache_read_input_tokens || 0;
      const inputTokens = baseInputTokens + cacheWriteTokens + cacheReadTokens;
      const outputTokens = usage.output_tokens || 0;

      const tools = [];
      if (Array.isArray(entry.message.content)) {
        for (const block of entry.message.content) {
          if (block.type === 'tool_use' && block.name) tools.push(block.name);
        }
      }

      queries.push({
        userPrompt: pendingUserMessage?.text || null,
        userTimestamp: pendingUserMessage?.timestamp || null,
        assistantTimestamp: entry.timestamp,
        model,
        inputTokens,
        baseInputTokens,
        cacheWriteTokens,
        cacheReadTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        tools,
      });
    }
  }

  const detectedWd = Object.entries(wdCounts).sort((a, b) => b[1] - a[1])[0]?.[0];
  const effectiveProject = (detectedWd && pathToProjectDir(detectedWd).toLowerCase() !== projectDir.toLowerCase())
    ? pathToProjectDir(detectedWd)
    : projectDir;

  return { queries, effectiveProject };
}

// Pricing: $ per million tokens
// Keyed by "family-major.minor" — getPricing() extracts this from model IDs
const VERSION_PRICING = {
  'opus-4.6':   { baseInput: 5,  cacheWrite: 6.25,  cacheRead: 0.50, output: 25 },
  'opus-4.5':   { baseInput: 5,  cacheWrite: 6.25,  cacheRead: 0.50, output: 25 },
  'opus-4.1':   { baseInput: 15, cacheWrite: 18.75, cacheRead: 1.50, output: 75 },
  'opus-4':     { baseInput: 15, cacheWrite: 18.75, cacheRead: 1.50, output: 75 },
  'opus-3':     { baseInput: 15, cacheWrite: 18.75, cacheRead: 1.50, output: 75 },
  'sonnet-4.6': { baseInput: 3,  cacheWrite: 3.75,  cacheRead: 0.30, output: 15 },
  'sonnet-4.5': { baseInput: 3,  cacheWrite: 3.75,  cacheRead: 0.30, output: 15 },
  'sonnet-4':   { baseInput: 3,  cacheWrite: 3.75,  cacheRead: 0.30, output: 15 },
  'sonnet-3.7': { baseInput: 3,  cacheWrite: 3.75,  cacheRead: 0.30, output: 15 },
  'sonnet-3.5': { baseInput: 3,  cacheWrite: 3.75,  cacheRead: 0.30, output: 15 },
  'haiku-4.5':  { baseInput: 1,  cacheWrite: 1.25,  cacheRead: 0.10, output: 5 },
  'haiku-3.5':  { baseInput: 0.80, cacheWrite: 1.00, cacheRead: 0.08, output: 4 },
  'haiku-3':    { baseInput: 0.25, cacheWrite: 0.30, cacheRead: 0.03, output: 1.25 },
};

// Fallback pricing by family
const FAMILY_PRICING = {
  opus:   { baseInput: 15, cacheWrite: 18.75, cacheRead: 1.50, output: 75 },
  sonnet: { baseInput: 3,  cacheWrite: 3.75,  cacheRead: 0.30, output: 15 },
  haiku:  { baseInput: 1,  cacheWrite: 1.25,  cacheRead: 0.10, output: 5 },
};

// Dynamic pricing cache (fetched from Anthropic's pricing page)
const PRICING_CACHE_PATH = path.join(os.homedir(), '.claude', 'pricing-cache.json');
let dynamicPricing = null; // loaded lazily

function loadDynamicPricing() {
  if (dynamicPricing !== null) return;
  try {
    if (fs.existsSync(PRICING_CACHE_PATH)) {
      const raw = JSON.parse(fs.readFileSync(PRICING_CACHE_PATH, 'utf-8'));
      // Cache valid for 7 days
      if (raw.fetchedAt && (Date.now() - raw.fetchedAt) < 7 * 24 * 60 * 60 * 1000) {
        dynamicPricing = raw.models || {};
        return;
      }
    }
  } catch {}
  dynamicPricing = {};
}

function fetchPricingFromWeb() {
  return new Promise((resolve) => {
    const https = require('https');
    const url = 'https://platform.claude.com/docs/en/about-claude/pricing';
    https.get(url, { headers: { 'User-Agent': 'claude-spend/1.0' } }, (res) => {
      if (res.statusCode !== 200) { resolve(null); res.resume(); return; }
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try {
          const models = parsePricingHtml(body);
          if (Object.keys(models).length > 0) {
            const cache = { fetchedAt: Date.now(), models };
            fs.mkdirSync(path.dirname(PRICING_CACHE_PATH), { recursive: true });
            fs.writeFileSync(PRICING_CACHE_PATH, JSON.stringify(cache, null, 2));
            dynamicPricing = models;
          }
          resolve(models);
        } catch { resolve(null); }
      });
    }).on('error', () => resolve(null));
  });
}

function parsePricingHtml(html) {
  const models = {};
  // Match HTML table rows: <td>Claude Opus 4.6</td><td>$5 / MTok</td>...
  const rowRe = /<td[^>]*>\s*Claude\s+(Opus|Sonnet|Haiku)\s+([\d.]+)\s*(?:<[^>]*>)*(?:\(deprecated\))?\s*<\/td>\s*<td[^>]*>\s*\$([\d.]+)\s*\/\s*MTok\s*<\/td>\s*<td[^>]*>\s*\$([\d.]+)\s*\/\s*MTok\s*<\/td>\s*<td[^>]*>\s*\$([\d.]+)\s*\/\s*MTok\s*<\/td>\s*<td[^>]*>\s*\$([\d.]+)\s*\/\s*MTok\s*<\/td>\s*<td[^>]*>\s*\$([\d.]+)\s*\/\s*MTok\s*<\/td>/gi;
  let match;
  while ((match = rowRe.exec(html)) !== null) {
    const family = match[1].toLowerCase();
    const version = match[2];
    const key = family + '-' + version;
    models[key] = {
      baseInput: parseFloat(match[3]),
      cacheWrite: parseFloat(match[4]),
      // match[5] is 1h cache write — skip
      cacheRead: parseFloat(match[6]),
      output: parseFloat(match[7]),
    };
  }
  // Also try markdown pipe format as fallback
  if (Object.keys(models).length === 0) {
    const mdRe = /\|\s*Claude\s+(Opus|Sonnet|Haiku)\s+([\d.]+)[^|]*\|\s*\$([\d.]+)\s*\/\s*MTok\s*\|\s*\$([\d.]+)\s*\/\s*MTok\s*\|\s*\$([\d.]+)\s*\/\s*MTok\s*\|\s*\$([\d.]+)\s*\/\s*MTok\s*\|\s*\$([\d.]+)\s*\/\s*MTok\s*\|/gi;
    while ((match = mdRe.exec(html)) !== null) {
      const family = match[1].toLowerCase();
      const version = match[2];
      const key = family + '-' + version;
      models[key] = {
        baseInput: parseFloat(match[3]),
        cacheWrite: parseFloat(match[4]),
        cacheRead: parseFloat(match[6]),
        output: parseFloat(match[7]),
      };
    }
  }
  return models;
}

// Set of models we've already attempted to fetch pricing for
const _fetchAttempted = new Set();

function getPricing(model) {
  loadDynamicPricing();

  // Extract family + version key from model ID
  const key = modelToKey(model);
  if (key && VERSION_PRICING[key]) return VERSION_PRICING[key];
  if (key && dynamicPricing[key]) return dynamicPricing[key];

  // Family fallback
  for (const [family, pricing] of Object.entries(FAMILY_PRICING)) {
    if (model.toLowerCase().includes(family)) return pricing;
  }
  return FAMILY_PRICING.sonnet; // default fallback
}

function modelToKey(model) {
  // New format: claude-{family}-{major}-{minor}[-date]
  let m = model.match(/(?:claude-)?(opus|sonnet|haiku)-(\d+)-(\d+)/i);
  if (m) {
    const key = m[1].toLowerCase() + '-' + m[2] + '.' + m[3];
    // Check it's not a date suffix (6+ digit minor = date)
    if (m[3].length < 6) return key;
  }
  // Base version: claude-opus-4-20250514
  m = model.match(/(?:claude-)?(opus|sonnet|haiku)-(\d+)(?:-\d{6,}|$)/i);
  if (m) return m[1].toLowerCase() + '-' + m[2];
  // Old: claude-3-5-sonnet-20241022
  m = model.match(/claude-(\d+)-(\d+)-(opus|sonnet|haiku)/i);
  if (m) return m[3].toLowerCase() + '-' + m[1] + '.' + m[2];
  // Old: claude-3-opus
  m = model.match(/claude-(\d+)-(opus|sonnet|haiku)/i);
  if (m) return m[2].toLowerCase() + '-' + m[1];
  return null;
}

// Attempt to auto-fetch pricing for unknown models (called once per parseAllSessions)
async function ensurePricingForModels(modelIds) {
  loadDynamicPricing();
  const unknown = [];
  for (const id of modelIds) {
    const key = modelToKey(id);
    if (key && !VERSION_PRICING[key] && !dynamicPricing[key]) {
      // Check family fallback exists — still worth fetching for accuracy
      unknown.push(id);
    }
  }
  if (unknown.length > 0 && !_fetchAttempted.has('done')) {
    _fetchAttempted.add('done');
    await fetchPricingFromWeb();
  }
}

function computeCost(model, baseInputTokens, cacheWriteTokens, cacheReadTokens, outputTokens) {
  const p = getPricing(model);
  const withCache = (baseInputTokens * p.baseInput + cacheWriteTokens * p.cacheWrite + cacheReadTokens * p.cacheRead + outputTokens * p.output) / 1_000_000;
  const withoutCache = ((baseInputTokens + cacheWriteTokens + cacheReadTokens) * p.baseInput + outputTokens * p.output) / 1_000_000;
  return { withCache, withoutCache };
}

async function parseAllSessions() {
  const claudeDir = getClaudeDir();
  const projectsDir = path.join(claudeDir, 'projects');

  if (!fs.existsSync(projectsDir)) {
    return { sessions: [], dailyUsage: [], modelBreakdown: [], topPrompts: [], totals: {} };
  }

  // Read history.jsonl for prompt display text
  const historyPath = path.join(claudeDir, 'history.jsonl');
  const historyEntries = fs.existsSync(historyPath) ? await parseJSONLFile(historyPath) : [];

  // Build a map: sessionId -> first meaningful prompt
  const sessionFirstPrompt = {};
  for (const entry of historyEntries) {
    if (entry.sessionId && entry.display && !sessionFirstPrompt[entry.sessionId]) {
      const display = entry.display.trim();
      if (display.startsWith('/') && display.length < 30) continue;
      sessionFirstPrompt[entry.sessionId] = display;
    }
  }

  const projectDirs = fs.readdirSync(projectsDir).filter(d => {
    return fs.statSync(path.join(projectsDir, d)).isDirectory();
  });

  const sessions = [];
  const dailyMap = {};
  const modelMap = {};
  const allPrompts = []; // for "most expensive prompts" across all sessions

  for (const projectDir of projectDirs) {
    const dir = path.join(projectsDir, projectDir);
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'));

    for (const file of files) {
      const filePath = path.join(dir, file);
      const sessionId = path.basename(file, '.jsonl');

      let entries;
      try {
        entries = await parseJSONLFile(filePath);
      } catch {
        continue;
      }
      if (entries.length === 0) continue;

      const { queries, effectiveProject } = extractSessionData(entries, projectDir);
      if (queries.length === 0) continue;

      let inputTokens = 0, outputTokens = 0, baseInputTokens = 0, cacheWriteTokens = 0, cacheReadTokens = 0;
      for (const q of queries) {
        inputTokens += q.inputTokens;
        outputTokens += q.outputTokens;
        baseInputTokens += q.baseInputTokens;
        cacheWriteTokens += q.cacheWriteTokens;
        cacheReadTokens += q.cacheReadTokens;
      }
      const totalTokens = inputTokens + outputTokens;

      const firstTimestamp = entries.find(e => e.timestamp)?.timestamp;
      const date = firstTimestamp ? firstTimestamp.split('T')[0] : 'unknown';

      // Primary model
      const modelCounts = {};
      for (const q of queries) {
        modelCounts[q.model] = (modelCounts[q.model] || 0) + 1;
      }
      const primaryModel = Object.entries(modelCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'unknown';

      const firstPrompt = sessionFirstPrompt[sessionId]
        || queries.find(q => q.userPrompt)?.userPrompt
        || '(no prompt)';

      // Collect per-prompt data for "most expensive prompts"
      // Group consecutive queries under the same user prompt
      let currentPrompt = null;
      let promptInput = 0, promptOutput = 0;
      const flushPrompt = () => {
        if (currentPrompt && (promptInput + promptOutput) > 0) {
          allPrompts.push({
            prompt: currentPrompt.substring(0, 300),
            inputTokens: promptInput,
            outputTokens: promptOutput,
            totalTokens: promptInput + promptOutput,
            date,
            sessionId,
            model: primaryModel,
          });
        }
      };
      for (const q of queries) {
        if (q.userPrompt && q.userPrompt !== currentPrompt) {
          flushPrompt();
          currentPrompt = q.userPrompt;
          promptInput = 0;
          promptOutput = 0;
        }
        promptInput += q.inputTokens;
        promptOutput += q.outputTokens;
      }
      flushPrompt();

      sessions.push({
        sessionId,
        project: effectiveProject,
        date,
        timestamp: firstTimestamp,
        firstPrompt: firstPrompt.substring(0, 200),
        model: primaryModel,
        queryCount: queries.length,
        userPromptCount: queries.filter(q => q.userPrompt !== null).length,
        queries,
        inputTokens,
        baseInputTokens,
        cacheWriteTokens,
        cacheReadTokens,
        outputTokens,
        totalTokens,
      });

      // Daily
      if (date !== 'unknown') {
        if (!dailyMap[date]) {
          dailyMap[date] = { date, inputTokens: 0, outputTokens: 0, totalTokens: 0, sessions: 0, queries: 0 };
        }
        dailyMap[date].inputTokens += inputTokens;
        dailyMap[date].outputTokens += outputTokens;
        dailyMap[date].totalTokens += totalTokens;
        dailyMap[date].sessions += 1;
        dailyMap[date].queries += queries.length;
      }

      // Model
      for (const q of queries) {
        if (q.model === '<synthetic>' || q.model === 'unknown') continue;
        if (!modelMap[q.model]) {
          modelMap[q.model] = { model: q.model, inputTokens: 0, baseInputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0, totalTokens: 0, queryCount: 0 };
        }
        modelMap[q.model].inputTokens += q.inputTokens;
        modelMap[q.model].baseInputTokens += q.baseInputTokens;
        modelMap[q.model].cacheWriteTokens += q.cacheWriteTokens;
        modelMap[q.model].cacheReadTokens += q.cacheReadTokens;
        modelMap[q.model].outputTokens += q.outputTokens;
        modelMap[q.model].totalTokens += q.totalTokens;
        modelMap[q.model].queryCount += 1;
      }
    }
  }

  sessions.sort((a, b) => b.totalTokens - a.totalTokens);

  // Build per-project aggregation
  const projectMap = {};
  for (const session of sessions) {
    const proj = session.project;
    if (!projectMap[proj]) {
      projectMap[proj] = {
        project: proj,
        inputTokens: 0, baseInputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0, totalTokens: 0,
        sessionCount: 0, queryCount: 0, userPromptCount: 0,
        modelMap: {},
        allPrompts: [],
      };
    }
    const p = projectMap[proj];
    p.inputTokens += session.inputTokens;
    p.baseInputTokens += session.baseInputTokens;
    p.cacheWriteTokens += session.cacheWriteTokens;
    p.cacheReadTokens += session.cacheReadTokens;
    p.outputTokens += session.outputTokens;
    p.totalTokens += session.totalTokens;
    p.sessionCount += 1;
    p.queryCount += session.queryCount;
    p.userPromptCount += session.userPromptCount;

    for (const q of session.queries) {
      if (q.model === '<synthetic>' || q.model === 'unknown') continue;
      if (!p.modelMap[q.model]) {
        p.modelMap[q.model] = { model: q.model, inputTokens: 0, baseInputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0, totalTokens: 0, queryCount: 0, userPromptCount: 0 };
      }
      const m = p.modelMap[q.model];
      m.inputTokens += q.inputTokens;
      m.baseInputTokens += q.baseInputTokens;
      m.cacheWriteTokens += q.cacheWriteTokens;
      m.cacheReadTokens += q.cacheReadTokens;
      m.outputTokens += q.outputTokens;
      m.totalTokens += q.totalTokens;
      m.queryCount += 1;
      if (q.userPrompt !== null) m.userPromptCount += 1;
    }

    // Per-project prompt grouping with tool tracking
    let curPrompt = null, curInput = 0, curOutput = 0, curConts = 0;
    let curModels = {}, curTools = {};
    const flushProjectPrompt = () => {
      if (curPrompt && (curInput + curOutput) > 0) {
        const topModel = Object.entries(curModels).sort((a, b) => b[1] - a[1])[0]?.[0] || session.model;
        p.allPrompts.push({
          prompt: curPrompt.substring(0, 300),
          inputTokens: curInput,
          outputTokens: curOutput,
          totalTokens: curInput + curOutput,
          continuations: curConts,
          model: topModel,
          toolCounts: { ...curTools },
          date: session.date,
          sessionId: session.sessionId,
        });
      }
    };
    for (const q of session.queries) {
      if (q.userPrompt && q.userPrompt !== curPrompt) {
        flushProjectPrompt();
        curPrompt = q.userPrompt;
        curInput = 0; curOutput = 0; curConts = 0;
        curModels = {}; curTools = {};
      } else if (!q.userPrompt) {
        curConts++;
      }
      curInput += q.inputTokens;
      curOutput += q.outputTokens;
      if (q.model && q.model !== '<synthetic>') curModels[q.model] = (curModels[q.model] || 0) + 1;
      for (const t of q.tools || []) curTools[t] = (curTools[t] || 0) + 1;
    }
    flushProjectPrompt();
  }

  const projectBreakdown = Object.values(projectMap).map(p => {
    // Compute per-model cost within project
    const modelBd = Object.values(p.modelMap).map(m => {
      const cost = computeCost(m.model, m.baseInputTokens, m.cacheWriteTokens, m.cacheReadTokens, m.outputTokens);
      return { ...m, costWithCache: cost.withCache, costWithoutCache: cost.withoutCache };
    }).sort((a, b) => b.totalTokens - a.totalTokens);

    const projectCostWith = modelBd.reduce((s, m) => s + m.costWithCache, 0);
    const projectCostWithout = modelBd.reduce((s, m) => s + m.costWithoutCache, 0);

    return {
      project: p.project,
      inputTokens: p.inputTokens,
      baseInputTokens: p.baseInputTokens,
      cacheWriteTokens: p.cacheWriteTokens,
      cacheReadTokens: p.cacheReadTokens,
      outputTokens: p.outputTokens,
      totalTokens: p.totalTokens,
      sessionCount: p.sessionCount,
      queryCount: p.queryCount,
      userPromptCount: p.userPromptCount,
      costWithCache: projectCostWith,
      costWithoutCache: projectCostWithout,
      modelBreakdown: modelBd,
      topPrompts: (p.allPrompts || []).sort((a, b) => b.totalTokens - a.totalTokens).slice(0, 10),
    };
  }).sort((a, b) => b.totalTokens - a.totalTokens);

  const dailyUsage = Object.values(dailyMap).sort((a, b) => a.date.localeCompare(b.date));

  // Top 20 most expensive individual prompts
  allPrompts.sort((a, b) => b.totalTokens - a.totalTokens);
  const topPrompts = allPrompts.slice(0, 20);

  // Auto-fetch pricing for any unknown models
  await ensurePricingForModels(Object.keys(modelMap));

  // Add cost to model breakdown
  const modelBreakdownWithCost = Object.values(modelMap).map(m => {
    const cost = computeCost(m.model, m.baseInputTokens, m.cacheWriteTokens, m.cacheReadTokens, m.outputTokens);
    return { ...m, costWithCache: cost.withCache, costWithoutCache: cost.withoutCache };
  });

  const totalCostWith = modelBreakdownWithCost.reduce((s, m) => s + m.costWithCache, 0);
  const totalCostWithout = modelBreakdownWithCost.reduce((s, m) => s + m.costWithoutCache, 0);

  const grandTotals = {
    totalSessions: sessions.length,
    totalQueries: sessions.reduce((sum, s) => sum + s.queryCount, 0),
    userPromptCount: sessions.reduce((sum, s) => sum + s.userPromptCount, 0),
    totalTokens: sessions.reduce((sum, s) => sum + s.totalTokens, 0),
    totalInputTokens: sessions.reduce((sum, s) => sum + s.inputTokens, 0),
    totalOutputTokens: sessions.reduce((sum, s) => sum + s.outputTokens, 0),
    costWithCache: totalCostWith,
    costWithoutCache: totalCostWithout,
    avgTokensPerQuery: 0,
    avgTokensPerSession: 0,
    dateRange: dailyUsage.length > 0
      ? { from: dailyUsage[0].date, to: dailyUsage[dailyUsage.length - 1].date }
      : null,
  };
  if (grandTotals.totalQueries > 0) {
    grandTotals.avgTokensPerQuery = Math.round(grandTotals.totalTokens / grandTotals.totalQueries);
  }
  if (grandTotals.totalSessions > 0) {
    grandTotals.avgTokensPerSession = Math.round(grandTotals.totalTokens / grandTotals.totalSessions);
  }

  // Generate insights
  const insights = generateInsights(sessions, allPrompts, grandTotals);

  return {
    sessions,
    dailyUsage,
    modelBreakdown: modelBreakdownWithCost,
    projectBreakdown,
    topPrompts,
    totals: grandTotals,
    insights,
  };
}

function generateInsights(sessions, allPrompts, totals) {
  const insights = [];

  // 1. Short, vague messages that cost a lot
  const shortExpensive = allPrompts.filter(p => p.prompt.trim().length < 30 && p.totalTokens > 100_000);
  if (shortExpensive.length > 0) {
    const totalWasted = shortExpensive.reduce((s, p) => s + p.totalTokens, 0);
    const examples = [...new Set(shortExpensive.map(p => p.prompt.trim()))].slice(0, 4);
    insights.push({
      id: 'vague-prompts',
      type: 'warning',
      title: 'Short, vague messages are costing you the most',
      description: `${shortExpensive.length} times you sent a short message like ${examples.map(e => '"' + e + '"').join(', ')} -- and each time, Claude used over 100K tokens to respond. That adds up to ${fmt(totalWasted)} tokens total. When you say just "Yes" or "Do it", Claude doesn't know exactly what you want, so it tries harder -- reading more files, running more tools, making more attempts. Each of those steps re-sends the entire conversation, which multiplies the cost.`,
      action: 'Try being specific. Instead of "Yes", say "Yes, update the login page and run the tests." It gives Claude a clear target, so it finishes faster and uses fewer tokens.',
    });
  }

  // 2. Long conversations getting more expensive over time
  const longSessions = sessions.filter(s => s.queries.length > 50);
  if (longSessions.length > 0) {
    const growthData = longSessions.map(s => {
      const first5 = s.queries.slice(0, 5).reduce((sum, q) => sum + q.totalTokens, 0) / Math.min(5, s.queries.length);
      const last5 = s.queries.slice(-5).reduce((sum, q) => sum + q.totalTokens, 0) / Math.min(5, s.queries.length);
      return { session: s, first5, last5, ratio: last5 / Math.max(first5, 1) };
    }).filter(g => g.ratio > 2);

    if (growthData.length > 0) {
      const avgGrowth = (growthData.reduce((s, g) => s + g.ratio, 0) / growthData.length).toFixed(1);
      const worstSession = growthData.sort((a, b) => b.ratio - a.ratio)[0];
      insights.push({
        id: 'context-growth',
        type: 'warning',
        title: 'The longer you chat, the more each message costs',
        description: `In ${growthData.length} of your conversations, the messages near the end cost ${avgGrowth}x more than the ones at the start. Why? Every time you send a message, Claude re-reads the entire conversation from the beginning. So message #5 is cheap, but message #80 is expensive because Claude is re-reading 79 previous messages plus all the code it wrote. Your longest conversation ("${worstSession.session.firstPrompt.substring(0, 50)}...") grew ${worstSession.ratio.toFixed(1)}x more expensive by the end.`,
        action: 'Start a fresh conversation when you move to a new task. If you need context from before, paste a short summary in your first message. This gives Claude a clean slate instead of re-reading hundreds of old messages.',
      });
    }
  }

  // 3. Marathon conversations
  const turnCounts = sessions.map(s => s.queryCount);
  const medianTurns = turnCounts.sort((a, b) => a - b)[Math.floor(turnCounts.length / 2)] || 0;
  const longCount = sessions.filter(s => s.queryCount > 200).length;
  if (longCount >= 3) {
    const longTokens = sessions.filter(s => s.queryCount > 200).reduce((s, ses) => s + ses.totalTokens, 0);
    const longPct = ((longTokens / Math.max(totals.totalTokens, 1)) * 100).toFixed(0);
    insights.push({
      id: 'marathon-sessions',
      type: 'info',
      title: `Just ${longCount} long conversations used ${longPct}% of all your tokens`,
      description: `You have ${longCount} conversations with over 200 messages each. These alone consumed ${fmt(longTokens)} tokens -- that's ${longPct}% of everything. Meanwhile, your typical conversation is about ${medianTurns} messages. Long conversations aren't always bad, but they're disproportionately expensive because of how context builds up.`,
      action: 'Try keeping one conversation per task. When a conversation starts drifting into different topics, that is a good time to start a new one.',
    });
  }

  // 4. Most tokens are re-reading, not writing
  if (totals.totalTokens > 0) {
    const outputPct = (totals.totalOutputTokens / totals.totalTokens) * 100;
    if (outputPct < 2) {
      insights.push({
        id: 'input-heavy',
        type: 'info',
        title: `${outputPct.toFixed(1)}% of your tokens are Claude actually writing`,
        description: `Here's something surprising: out of ${fmt(totals.totalTokens)} total tokens, only ${fmt(totals.totalOutputTokens)} are from Claude writing responses. The other ${(100 - outputPct).toFixed(1)}% is Claude re-reading your conversation history, files, and context before each response. This means the biggest factor in token usage isn't how much Claude writes -- it's how long your conversations are.`,
        action: 'Keeping conversations shorter has more impact than asking for shorter answers. A 20-message conversation costs far less than a 200-message one, even if the total output is similar.',
      });
    }
  }

  // 5. Day-of-week pattern
  if (sessions.length >= 10) {
    const dayOfWeekMap = {};
    for (const s of sessions) {
      if (!s.timestamp) continue;
      const d = new Date(s.timestamp);
      const day = d.getDay();
      if (!dayOfWeekMap[day]) dayOfWeekMap[day] = { tokens: 0, sessions: 0 };
      dayOfWeekMap[day].tokens += s.totalTokens;
      dayOfWeekMap[day].sessions += 1;
    }
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const days = Object.entries(dayOfWeekMap).map(([d, v]) => ({ day: dayNames[d], ...v, avg: v.tokens / v.sessions }));
    if (days.length >= 3) {
      days.sort((a, b) => b.avg - a.avg);
      const busiest = days[0];
      const quietest = days[days.length - 1];
      insights.push({
        id: 'day-pattern',
        type: 'neutral',
        title: `You use Claude the most on ${busiest.day}s`,
        description: `Your ${busiest.day} conversations average ${fmt(Math.round(busiest.avg))} tokens each, compared to ${fmt(Math.round(quietest.avg))} on ${quietest.day}s. This could mean you tackle bigger tasks on ${busiest.day}s, or your conversations tend to run longer.`,
        action: null,
      });
    }
  }

  // 6. Model mismatch -- Opus used for simple conversations
  const opusSessions = sessions.filter(s => s.model.includes('opus'));
  if (opusSessions.length > 0) {
    const simpleOpus = opusSessions.filter(s => s.queryCount < 10 && s.totalTokens < 200_000);
    if (simpleOpus.length >= 3) {
      const wastedTokens = simpleOpus.reduce((s, ses) => s + ses.totalTokens, 0);
      const examples = simpleOpus.slice(0, 3).map(s => '"' + s.firstPrompt.substring(0, 40) + '"').join(', ');
      insights.push({
        id: 'model-mismatch',
        type: 'warning',
        title: `${simpleOpus.length} simple conversations used Opus unnecessarily`,
        description: `These conversations had fewer than 10 messages and used ${fmt(wastedTokens)} tokens on Opus: ${examples}. Opus is the most capable model but also the most expensive. For quick questions and small tasks, Sonnet or Haiku would give similar results at a fraction of the cost.`,
        action: 'Use /model to switch to Sonnet or Haiku for simple tasks. Save Opus for complex multi-file changes, architecture decisions, or tricky debugging.',
      });
    }
  }

  // 7. Tool-heavy conversations
  if (sessions.length >= 5) {
    const toolHeavy = sessions.filter(s => {
      const userMessages = s.queries.filter(q => q.userPrompt).length;
      const toolCalls = s.queryCount - userMessages;
      return userMessages > 0 && toolCalls > userMessages * 3;
    });
    if (toolHeavy.length >= 3) {
      const totalToolTokens = toolHeavy.reduce((s, ses) => s + ses.totalTokens, 0);
      const avgRatio = toolHeavy.reduce((s, ses) => {
        const userMsgs = ses.queries.filter(q => q.userPrompt).length;
        return s + (ses.queryCount - userMsgs) / Math.max(userMsgs, 1);
      }, 0) / toolHeavy.length;
      insights.push({
        id: 'tool-heavy',
        type: 'info',
        title: `${toolHeavy.length} conversations had ${Math.round(avgRatio)}x more tool calls than messages`,
        description: `In these conversations, Claude made ~${Math.round(avgRatio)} tool calls for every message you sent. Each tool call (reading files, running commands, searching code) is a full round trip that re-reads the entire conversation. These ${toolHeavy.length} conversations used ${fmt(totalToolTokens)} tokens total.`,
        action: 'Point Claude to specific files and line numbers when you can. "Fix the bug in src/auth.js line 42" triggers fewer tool calls than "fix the login bug" where Claude has to search for the right file first.',
      });
    }
  }

  // 8. One project dominates usage
  if (sessions.length >= 5) {
    const projectTokens = {};
    for (const s of sessions) {
      const proj = s.project || 'unknown';
      projectTokens[proj] = (projectTokens[proj] || 0) + s.totalTokens;
    }
    const sorted = Object.entries(projectTokens).sort((a, b) => b[1] - a[1]);
    if (sorted.length >= 2) {
      const [topProject, topTokens] = sorted[0];
      const pct = ((topTokens / Math.max(totals.totalTokens, 1)) * 100).toFixed(0);
      if (pct >= 60) {
        const projName = topProject.replace(/^C--Users-[^-]+-?/, '').replace(/^Projects-?/, '').replace(/-/g, '/') || '~';
        insights.push({
          id: 'project-dominance',
          type: 'info',
          title: `${pct}% of your tokens went to one project: ${projName}`,
          description: `Your "${projName}" project used ${fmt(topTokens)} tokens out of ${fmt(totals.totalTokens)} total. That is ${pct}% of all your usage. The next closest project used ${fmt(sorted[1][1])} tokens.`,
          action: 'Not necessarily a problem, but worth knowing. If this project has long-running conversations, breaking them into smaller sessions could reduce its footprint.',
        });
      }
    }
  }

  // 9. Conversation efficiency -- short vs long conversations cost per message
  if (sessions.length >= 10) {
    const shortSessions = sessions.filter(s => s.queryCount >= 3 && s.queryCount <= 15);
    const longSessions2 = sessions.filter(s => s.queryCount > 80);
    if (shortSessions.length >= 3 && longSessions2.length >= 2) {
      const shortAvg = Math.round(shortSessions.reduce((s, ses) => s + ses.totalTokens / ses.queryCount, 0) / shortSessions.length);
      const longAvg = Math.round(longSessions2.reduce((s, ses) => s + ses.totalTokens / ses.queryCount, 0) / longSessions2.length);
      const ratio = (longAvg / Math.max(shortAvg, 1)).toFixed(1);
      if (ratio >= 2) {
        insights.push({
          id: 'conversation-efficiency',
          type: 'warning',
          title: `Each message costs ${ratio}x more in long conversations`,
          description: `In your short conversations (under 15 messages), each message costs ~${fmt(shortAvg)} tokens. In your long ones (80+ messages), each message costs ~${fmt(longAvg)} tokens. That is ${ratio}x more per message, because Claude re-reads the entire history every turn.`,
          action: 'This is the single biggest lever for reducing token usage. Start fresh conversations more often. A 5-conversation workflow costs far less than one 500-message marathon.',
        });
      }
    }
  }

  // 10. Heavy context on first message (large CLAUDE.md or system prompts)
  if (sessions.length >= 5) {
    const heavyStarts = sessions.filter(s => {
      const firstQuery = s.queries[0];
      return firstQuery && firstQuery.inputTokens > 50_000;
    });
    if (heavyStarts.length >= 5) {
      const avgStartTokens = Math.round(heavyStarts.reduce((s, ses) => s + ses.queries[0].inputTokens, 0) / heavyStarts.length);
      const totalOverhead = heavyStarts.reduce((s, ses) => s + ses.queries[0].inputTokens, 0);
      insights.push({
        id: 'heavy-context',
        type: 'info',
        title: `${heavyStarts.length} conversations started with ${fmt(avgStartTokens)}+ tokens of context`,
        description: `Before you even type your first message, Claude reads your CLAUDE.md, project files, and system context. In ${heavyStarts.length} conversations, this starting context averaged ${fmt(avgStartTokens)} tokens. Across all of them, that is ${fmt(totalOverhead)} tokens just on setup -- and this context gets re-read with every message.`,
        action: 'Keep your CLAUDE.md files concise. Remove sections you rarely need. A smaller starting context compounds into savings across every message in the conversation.',
      });
    }
  }

  return insights;
}

function fmt(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 10_000) return (n / 1_000).toFixed(0) + 'K';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return n.toLocaleString();
}

module.exports = { parseAllSessions };

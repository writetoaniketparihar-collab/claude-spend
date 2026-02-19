const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');

// ====== Shared utilities ======

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

function safeDirs(dirPath) {
  if (!fs.existsSync(dirPath)) return [];
  return fs.readdirSync(dirPath).filter(d => {
    try { return fs.statSync(path.join(dirPath, d)).isDirectory(); } catch { return false; }
  });
}

function safeFiles(dirPath, ext) {
  if (!fs.existsSync(dirPath)) return [];
  return fs.readdirSync(dirPath).filter(f => f.endsWith(ext));
}

// ====== Claude Code parser ======

function extractClaudeSessionData(entries) {
  const queries = [];
  let pendingUserMessage = null;

  for (const entry of entries) {
    if (entry.type === 'user' && entry.message?.role === 'user') {
      const content = entry.message.content;
      if (entry.isMeta) continue;
      if (typeof content === 'string' && (
        content.startsWith('<local-command') ||
        content.startsWith('<command-name')
      )) continue;

      pendingUserMessage = {
        text: typeof content === 'string' ? content : JSON.stringify(content),
        timestamp: entry.timestamp,
      };
    }

    if (entry.type === 'assistant' && entry.message?.usage) {
      const usage = entry.message.usage;
      const model = entry.message.model || 'unknown';
      if (model === '<synthetic>') continue;

      const inputTokens = (usage.input_tokens || 0)
        + (usage.cache_creation_input_tokens || 0)
        + (usage.cache_read_input_tokens || 0);
      const outputTokens = usage.output_tokens || 0;

      queries.push({
        userPrompt: pendingUserMessage?.text || null,
        userTimestamp: pendingUserMessage?.timestamp || null,
        assistantTimestamp: entry.timestamp,
        model,
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
      });
    }
  }

  return queries;
}

async function parseClaudeSessions() {
  const claudeDir = path.join(os.homedir(), '.claude');
  const projectsDir = path.join(claudeDir, 'projects');

  if (!fs.existsSync(projectsDir)) return [];

  // Read history.jsonl for prompt display text
  const historyPath = path.join(claudeDir, 'history.jsonl');
  const historyEntries = fs.existsSync(historyPath) ? await parseJSONLFile(historyPath) : [];

  const sessionFirstPrompt = {};
  for (const entry of historyEntries) {
    if (entry.sessionId && entry.display && !sessionFirstPrompt[entry.sessionId]) {
      const display = entry.display.trim();
      if (display.startsWith('/') && display.length < 30) continue;
      sessionFirstPrompt[entry.sessionId] = display;
    }
  }

  const projectDirs = safeDirs(projectsDir);
  const sessions = [];

  for (const projectDir of projectDirs) {
    const dir = path.join(projectsDir, projectDir);
    const files = safeFiles(dir, '.jsonl');

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

      const queries = extractClaudeSessionData(entries);
      if (queries.length === 0) continue;

      let inputTokens = 0, outputTokens = 0;
      for (const q of queries) {
        inputTokens += q.inputTokens;
        outputTokens += q.outputTokens;
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

      sessions.push({
        sessionId,
        source: 'claude',
        project: projectDir,
        date,
        timestamp: firstTimestamp,
        firstPrompt: firstPrompt.substring(0, 200),
        model: primaryModel,
        queryCount: queries.length,
        queries,
        inputTokens,
        outputTokens,
        totalTokens,
      });
    }
  }

  return sessions;
}

// ====== Gemini CLI parser ======

async function parseGeminiSessions() {
  const geminiDir = path.join(os.homedir(), '.gemini');
  const tmpDir = path.join(geminiDir, 'tmp');

  if (!fs.existsSync(tmpDir)) return [];

  const sessions = [];
  const projectHashes = safeDirs(tmpDir);

  for (const projectHash of projectHashes) {
    const chatsDir = path.join(tmpDir, projectHash, 'chats');
    if (!fs.existsSync(chatsDir)) continue;

    const chatFiles = safeFiles(chatsDir, '.json');

    for (const file of chatFiles) {
      const filePath = path.join(chatsDir, file);

      let sessionData;
      try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        sessionData = JSON.parse(raw);
      } catch {
        continue;
      }

      const messages = sessionData.messages;
      if (!messages || messages.length === 0) continue;

      const queries = [];
      let pendingUserMessage = null;

      for (const msg of messages) {
        if (msg.type === 'user') {
          pendingUserMessage = {
            text: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
            timestamp: msg.timestamp,
          };
        }

        if (msg.type === 'gemini' && msg.tokens) {
          const t = msg.tokens;
          const inputTokens = (t.input || 0) + (t.cached || 0) + (t.thoughts || 0) + (t.tool || 0);
          const outputTokens = t.output || 0;

          queries.push({
            userPrompt: pendingUserMessage?.text || null,
            userTimestamp: pendingUserMessage?.timestamp || null,
            assistantTimestamp: msg.timestamp,
            model: msg.model || 'gemini-unknown',
            inputTokens,
            outputTokens,
            totalTokens: inputTokens + outputTokens,
          });
        }
      }

      if (queries.length === 0) continue;

      let inputTokens = 0, outputTokens = 0;
      for (const q of queries) {
        inputTokens += q.inputTokens;
        outputTokens += q.outputTokens;
      }
      const totalTokens = inputTokens + outputTokens;

      const firstTimestamp = sessionData.startTime || messages[0]?.timestamp;
      const date = firstTimestamp ? firstTimestamp.split('T')[0] : 'unknown';

      const modelCounts = {};
      for (const q of queries) {
        modelCounts[q.model] = (modelCounts[q.model] || 0) + 1;
      }
      const primaryModel = Object.entries(modelCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'gemini-unknown';

      const firstPrompt = queries.find(q => q.userPrompt)?.userPrompt || '(no prompt)';
      const sessionId = sessionData.sessionId || path.basename(file, '.json');

      sessions.push({
        sessionId: 'gemini-' + sessionId,
        source: 'gemini',
        project: projectHash.substring(0, 12), // shortened hash
        date,
        timestamp: firstTimestamp,
        firstPrompt: firstPrompt.substring(0, 200),
        model: primaryModel,
        queryCount: queries.length,
        queries,
        inputTokens,
        outputTokens,
        totalTokens,
      });
    }
  }

  return sessions;
}

// ====== Codex CLI parser ======

async function parseCodexSessions() {
  const codexDir = path.join(os.homedir(), '.codex');
  const sessionsDir = path.join(codexDir, 'sessions');

  if (!fs.existsSync(sessionsDir)) return [];

  // Read codex history for first prompts
  const historyPath = path.join(codexDir, 'history.jsonl');
  const historyEntries = fs.existsSync(historyPath) ? await parseJSONLFile(historyPath) : [];

  const sessionFirstPrompt = {};
  for (const entry of historyEntries) {
    if (entry.session_id && entry.text && !sessionFirstPrompt[entry.session_id]) {
      sessionFirstPrompt[entry.session_id] = entry.text.trim();
    }
  }

  // Recursively find all .jsonl files under sessionsDir
  const sessionFiles = [];
  function walkDir(dir) {
    try {
      for (const item of fs.readdirSync(dir)) {
        const full = path.join(dir, item);
        try {
          const stat = fs.statSync(full);
          if (stat.isDirectory()) walkDir(full);
          else if (item.endsWith('.jsonl')) sessionFiles.push(full);
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }
  walkDir(sessionsDir);

  const sessions = [];

  for (const filePath of sessionFiles) {
    let entries;
    try {
      entries = await parseJSONLFile(filePath);
    } catch {
      continue;
    }
    if (entries.length === 0) continue;

    const queries = [];
    let pendingUserMessage = null;
    let sessionMeta = null;
    let currentModel = 'gpt-unknown';
    let cwd = '';

    for (const entry of entries) {
      // Session metadata
      if (entry.type === 'session_meta') {
        sessionMeta = entry.payload;
        cwd = entry.payload?.cwd || '';
      }

      // Turn context (contains model info)
      if (entry.type === 'turn_context') {
        if (entry.payload?.model) currentModel = entry.payload.model;
        if (entry.payload?.cwd) cwd = entry.payload.cwd;
      }

      // User message
      if (entry.type === 'response_item' && entry.payload?.role === 'user') {
        const content = entry.payload.content;
        let text = '';
        if (Array.isArray(content)) {
          text = content.map(c => c.text || '').join(' ').trim();
        } else if (typeof content === 'string') {
          text = content;
        }
        if (text) {
          pendingUserMessage = { text, timestamp: entry.timestamp };
        }
      }

      // Token count event — this represents one complete turn
      if (entry.type === 'event_msg' && entry.payload?.type === 'token_count') {
        const usage = entry.payload.info?.last_token_usage;
        if (!usage) continue;

        const inputTokens = (usage.input_tokens || 0) + (usage.cached_input_tokens || 0);
        const outputTokens = (usage.output_tokens || 0) + (usage.reasoning_output_tokens || 0);

        queries.push({
          userPrompt: pendingUserMessage?.text || null,
          userTimestamp: pendingUserMessage?.timestamp || null,
          assistantTimestamp: entry.timestamp,
          model: currentModel,
          inputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens,
        });

        // Reset pending user message after pairing
        pendingUserMessage = null;
      }
    }

    if (queries.length === 0) continue;

    let inputTokens = 0, outputTokens = 0;
    for (const q of queries) {
      inputTokens += q.inputTokens;
      outputTokens += q.outputTokens;
    }
    const totalTokens = inputTokens + outputTokens;

    const firstTimestamp = sessionMeta?.timestamp || entries[0]?.timestamp;
    const date = firstTimestamp ? firstTimestamp.split('T')[0] : 'unknown';

    const modelCounts = {};
    for (const q of queries) {
      modelCounts[q.model] = (modelCounts[q.model] || 0) + 1;
    }
    const primaryModel = Object.entries(modelCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'gpt-unknown';

    // Session ID from metadata or filename
    const sessionId = sessionMeta?.id || path.basename(filePath, '.jsonl');

    // Project name from cwd
    const project = cwd ? path.basename(cwd) || '~' : '~';

    const firstPrompt = sessionFirstPrompt[sessionId]
      || queries.find(q => q.userPrompt)?.userPrompt
      || '(no prompt)';

    sessions.push({
      sessionId: 'codex-' + sessionId,
      source: 'codex',
      project,
      date,
      timestamp: firstTimestamp,
      firstPrompt: firstPrompt.substring(0, 200),
      model: primaryModel,
      queryCount: queries.length,
      queries,
      inputTokens,
      outputTokens,
      totalTokens,
    });
  }

  return sessions;
}

// ====== Aggregation ======

async function parseAllSessions() {
  // Parse all three sources in parallel
  const [claudeSessions, geminiSessions, codexSessions] = await Promise.all([
    parseClaudeSessions().catch(() => []),
    parseGeminiSessions().catch(() => []),
    parseCodexSessions().catch(() => []),
  ]);

  const sessions = [...claudeSessions, ...geminiSessions, ...codexSessions];

  if (sessions.length === 0) {
    return { sessions: [], dailyUsage: [], modelBreakdown: [], topPrompts: [], totals: {}, insights: [] };
  }

  const dailyMap = {};
  const modelMap = {};
  const allPrompts = [];

  for (const session of sessions) {
    const { date, queries } = session;

    // Primary model for this session
    const primaryModel = session.model;

    // Collect per-prompt data for "most expensive prompts"
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
          sessionId: session.sessionId,
          model: primaryModel,
          source: session.source,
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

    // Daily aggregation
    if (date !== 'unknown') {
      if (!dailyMap[date]) {
        dailyMap[date] = { date, inputTokens: 0, outputTokens: 0, totalTokens: 0, sessions: 0, queries: 0 };
      }
      dailyMap[date].inputTokens += session.inputTokens;
      dailyMap[date].outputTokens += session.outputTokens;
      dailyMap[date].totalTokens += session.totalTokens;
      dailyMap[date].sessions += 1;
      dailyMap[date].queries += session.queryCount;
    }

    // Model aggregation
    for (const q of queries) {
      if (q.model === '<synthetic>' || q.model === 'unknown') continue;
      if (!modelMap[q.model]) {
        modelMap[q.model] = { model: q.model, inputTokens: 0, outputTokens: 0, totalTokens: 0, queryCount: 0 };
      }
      modelMap[q.model].inputTokens += q.inputTokens;
      modelMap[q.model].outputTokens += q.outputTokens;
      modelMap[q.model].totalTokens += q.totalTokens;
      modelMap[q.model].queryCount += 1;
    }
  }

  sessions.sort((a, b) => b.totalTokens - a.totalTokens);

  const dailyUsage = Object.values(dailyMap).sort((a, b) => a.date.localeCompare(b.date));

  allPrompts.sort((a, b) => b.totalTokens - a.totalTokens);
  const topPrompts = allPrompts.slice(0, 20);

  const grandTotals = {
    totalSessions: sessions.length,
    totalQueries: sessions.reduce((sum, s) => sum + s.queryCount, 0),
    totalTokens: sessions.reduce((sum, s) => sum + s.totalTokens, 0),
    totalInputTokens: sessions.reduce((sum, s) => sum + s.inputTokens, 0),
    totalOutputTokens: sessions.reduce((sum, s) => sum + s.outputTokens, 0),
    avgTokensPerQuery: 0,
    avgTokensPerSession: 0,
    dateRange: dailyUsage.length > 0
      ? { from: dailyUsage[0].date, to: dailyUsage[dailyUsage.length - 1].date }
      : null,
    // Source counts
    claudeSessions: claudeSessions.length,
    geminiSessions: geminiSessions.length,
    codexSessions: codexSessions.length,
  };
  if (grandTotals.totalQueries > 0) {
    grandTotals.avgTokensPerQuery = Math.round(grandTotals.totalTokens / grandTotals.totalQueries);
  }
  if (grandTotals.totalSessions > 0) {
    grandTotals.avgTokensPerSession = Math.round(grandTotals.totalTokens / grandTotals.totalSessions);
  }

  const insights = generateInsights(sessions, allPrompts, grandTotals);

  return {
    sessions,
    dailyUsage,
    modelBreakdown: Object.values(modelMap),
    topPrompts,
    totals: grandTotals,
    insights,
  };
}

// ====== Insights ======

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
      description: `${shortExpensive.length} times you sent a short message like ${examples.map(e => '"' + e + '"').join(', ')} -- and each time, the model used over 100K tokens to respond. That adds up to ${fmt(totalWasted)} tokens total.`,
      action: 'Try being specific. Instead of "Yes", say "Yes, update the login page and run the tests." It gives the model a clear target, so it finishes faster and uses fewer tokens.',
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
        description: `In ${growthData.length} of your conversations, the messages near the end cost ${avgGrowth}x more than the ones at the start. Your longest conversation ("${worstSession.session.firstPrompt.substring(0, 50)}...") grew ${worstSession.ratio.toFixed(1)}x more expensive by the end.`,
        action: 'Start a fresh conversation when you move to a new task. If you need context from before, paste a short summary in your first message.',
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
      description: `You have ${longCount} conversations with over 200 messages each. These alone consumed ${fmt(longTokens)} tokens -- that's ${longPct}% of everything. Meanwhile, your typical conversation is about ${medianTurns} messages.`,
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
        title: `${outputPct.toFixed(1)}% of your tokens are the model actually writing`,
        description: `Out of ${fmt(totals.totalTokens)} total tokens, only ${fmt(totals.totalOutputTokens)} are from the model writing responses. The other ${(100 - outputPct).toFixed(1)}% is re-reading conversation history, files, and context.`,
        action: 'Keeping conversations shorter has more impact than asking for shorter answers.',
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
        title: `You use AI coding tools the most on ${busiest.day}s`,
        description: `Your ${busiest.day} conversations average ${fmt(Math.round(busiest.avg))} tokens each, compared to ${fmt(Math.round(quietest.avg))} on ${quietest.day}s.`,
        action: null,
      });
    }
  }

  // 6. Model mismatch
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
        description: `These conversations had fewer than 10 messages and used ${fmt(wastedTokens)} tokens on Opus: ${examples}. Opus is the most capable model but also the most expensive.`,
        action: 'Use /model to switch to Sonnet or Haiku for simple tasks. Save Opus for complex multi-file changes or tricky debugging.',
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
        description: `In these conversations, the model made ~${Math.round(avgRatio)} tool calls for every message you sent. These ${toolHeavy.length} conversations used ${fmt(totalToolTokens)} tokens total.`,
        action: 'Point the model to specific files and line numbers when you can. It triggers fewer tool calls than vague requests.',
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
          description: `Your "${projName}" project used ${fmt(topTokens)} tokens out of ${fmt(totals.totalTokens)} total.`,
          action: 'Not necessarily a problem, but worth knowing. Breaking long conversations into smaller sessions could reduce its footprint.',
        });
      }
    }
  }

  // 9. Conversation efficiency
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
          description: `In short conversations (under 15 messages), each message costs ~${fmt(shortAvg)} tokens. In long ones (80+ messages), each message costs ~${fmt(longAvg)} tokens. That is ${ratio}x more per message.`,
          action: 'This is the single biggest lever for reducing token usage. Start fresh conversations more often.',
        });
      }
    }
  }

  // 10. Heavy context on first message
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
        description: `Before you even type your first message, the model reads project files and system context. In ${heavyStarts.length} conversations, this starting context averaged ${fmt(avgStartTokens)} tokens. That is ${fmt(totalOverhead)} tokens just on setup.`,
        action: 'Keep your project config files concise. Remove sections you rarely need.',
      });
    }
  }

  // 11. Multi-tool insight (if using more than one CLI)
  const sources = new Set(sessions.map(s => s.source));
  if (sources.size > 1) {
    const sourceStats = {};
    for (const s of sessions) {
      if (!sourceStats[s.source]) sourceStats[s.source] = { tokens: 0, sessions: 0 };
      sourceStats[s.source].tokens += s.totalTokens;
      sourceStats[s.source].sessions += 1;
    }
    const names = { claude: 'Claude Code', gemini: 'Gemini CLI', codex: 'Codex CLI' };
    const parts = Object.entries(sourceStats)
      .sort((a, b) => b[1].tokens - a[1].tokens)
      .map(([src, v]) => `${names[src] || src}: ${v.sessions} sessions, ${fmt(v.tokens)} tokens`);
    insights.push({
      id: 'multi-tool',
      type: 'neutral',
      title: `Using ${sources.size} AI coding tools`,
      description: `Breakdown across tools: ${parts.join(' | ')}`,
      action: null,
    });
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

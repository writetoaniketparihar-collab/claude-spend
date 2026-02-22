const fs = require("fs");
const path = require("path");
const os = require("os");
const readline = require("readline");

// Pricing per million tokens (USD) — updated Feb 2026
// Source: https://www.anthropic.com/pricing
const PRICING = [
  // New claude-{family}-{major}-{minor} format (e.g. claude-opus-4-5)
  {
    pattern: /claude-opus/i,
    input: 15.0,
    cacheWrite: 18.75,
    cacheRead: 1.5,
    output: 75.0,
  },
  {
    pattern: /claude-sonnet/i,
    input: 3.0,
    cacheWrite: 3.75,
    cacheRead: 0.3,
    output: 15.0,
  },
  {
    pattern: /claude-haiku/i,
    input: 0.8,
    cacheWrite: 1.0,
    cacheRead: 0.08,
    output: 4.0,
  },
  // Legacy claude-3-X-{family} format (e.g. claude-3-5-sonnet-20241022)
  {
    pattern: /claude-3[^-]*-opus/i,
    input: 15.0,
    cacheWrite: 18.75,
    cacheRead: 1.5,
    output: 75.0,
  },
  {
    pattern: /claude-3[^-]*-sonnet/i,
    input: 3.0,
    cacheWrite: 3.75,
    cacheRead: 0.3,
    output: 15.0,
  },
  {
    pattern: /claude-3[^-]*-haiku/i,
    input: 0.8,
    cacheWrite: 1.0,
    cacheRead: 0.08,
    output: 4.0,
  },
];
const PRICING_FALLBACK = {
  input: 3.0,
  cacheWrite: 3.75,
  cacheRead: 0.3,
  output: 15.0,
};

function getPricing(model) {
  for (const tier of PRICING) {
    if (tier.pattern.test(model)) return tier;
  }
  return PRICING_FALLBACK;
}

// Returns estimated USD cost for a single API call
function estimateCost(model, freshInput, cacheWrite, cacheRead, output) {
  const p = getPricing(model);
  return (
    (freshInput * p.input) / 1_000_000 +
    (cacheWrite * p.cacheWrite) / 1_000_000 +
    (cacheRead * p.cacheRead) / 1_000_000 +
    (output * p.output) / 1_000_000
  );
}

function getClaudeDir() {
  return path.join(os.homedir(), ".claude");
}

async function parseJSONLFile(filePath) {
  const lines = [];
  const stream = fs.createReadStream(filePath, { encoding: "utf-8" });
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

function extractSessionData(entries) {
  const queries = [];
  let pendingUserMessage = null;

  for (const entry of entries) {
    if (entry.type === "user" && entry.message?.role === "user") {
      const content = entry.message.content;
      if (entry.isMeta) continue;
      if (
        typeof content === "string" &&
        (content.startsWith("<local-command") ||
          content.startsWith("<command-name"))
      )
        continue;

      const textContent =
        typeof content === "string"
          ? content
          : content
              .filter((b) => b.type === "text")
              .map((b) => b.text)
              .join("\n")
              .trim();
      pendingUserMessage = {
        text: textContent || null,
        timestamp: entry.timestamp,
      };
    }

    if (entry.type === 'assistant') {
      const usage = entry.message?.usage || {};
      const model = entry.message?.model || 'unknown';
      if (model === '<synthetic>') continue;

      const freshInputTokens  = usage.input_tokens || 0;
      const cacheWriteTokens  = usage.cache_creation_input_tokens || 0;
      const cacheReadTokens   = usage.cache_read_input_tokens || 0;
      const outputTokens      = usage.output_tokens || 0;
      // inputTokens = sum of all input sources (backward-compat)
      const inputTokens = freshInputTokens + cacheWriteTokens + cacheReadTokens;

      const cost = estimateCost(model, freshInputTokens, cacheWriteTokens, cacheReadTokens, outputTokens);

      const tools = [];
      if (Array.isArray(entry.message.content)) {
        for (const block of entry.message.content) {
          if (block.type === 'tool_use' && block.name) tools.push({ name: block.name, input: block.input || {} });
        }
      }

      queries.push({
        userPrompt: pendingUserMessage?.text || null,
        userTimestamp: pendingUserMessage?.timestamp || null,
        assistantTimestamp: entry.timestamp,
        model,
        freshInputTokens,
        cacheWriteTokens,
        cacheReadTokens,
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        estimatedCost: cost,
        tools,
      });
    }
  }

  return queries;
}

async function parseAllSessions() {
  const claudeDir = getClaudeDir();
  const projectsDir = path.join(claudeDir, "projects");

  if (!fs.existsSync(projectsDir)) {
    return {
      sessions: [],
      dailyUsage: [],
      modelBreakdown: [],
      topPrompts: [],
      totals: {},
    };
  }

  // Read history.jsonl for prompt display text
  const historyPath = path.join(claudeDir, "history.jsonl");
  const historyEntries = fs.existsSync(historyPath)
    ? await parseJSONLFile(historyPath)
    : [];

  // Build a map: sessionId -> first meaningful prompt
  const sessionFirstPrompt = {};
  for (const entry of historyEntries) {
    if (
      entry.sessionId &&
      entry.display &&
      !sessionFirstPrompt[entry.sessionId]
    ) {
      const display = entry.display.trim();
      if (display.startsWith("/") && display.length < 30) continue;
      sessionFirstPrompt[entry.sessionId] = display;
    }
  }

  const projectDirs = fs.readdirSync(projectsDir).filter((d) => {
    return fs.statSync(path.join(projectsDir, d)).isDirectory();
  });

  const sessions = [];
  const dailyMap = {};
  const modelMap = {};
  const allPrompts = []; // for "most expensive prompts" across all sessions

  for (const projectDir of projectDirs) {
    const dir = path.join(projectsDir, projectDir);
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));

    for (const file of files) {
      const filePath = path.join(dir, file);
      const sessionId = path.basename(file, ".jsonl");

      let entries;
      try {
        entries = await parseJSONLFile(filePath);
      } catch {
        continue;
      }
      if (entries.length === 0) continue;

      const queries = extractSessionData(entries);
      if (queries.length === 0) continue;

      let inputTokens = 0, outputTokens = 0;
      let freshInputTokens = 0, cacheWriteTokens = 0, cacheReadTokens = 0;
      let estimatedCost = 0;
      for (const q of queries) {
        inputTokens     += q.inputTokens;
        outputTokens    += q.outputTokens;
        freshInputTokens += q.freshInputTokens;
        cacheWriteTokens += q.cacheWriteTokens;
        cacheReadTokens  += q.cacheReadTokens;
        estimatedCost   += q.estimatedCost;
      }
      const totalTokens = inputTokens + outputTokens;

      const firstTimestamp = entries.find((e) => e.timestamp)?.timestamp;
      const date = firstTimestamp ? firstTimestamp.split("T")[0] : "unknown";

      // Primary model
      const modelCounts = {};
      for (const q of queries) {
        modelCounts[q.model] = (modelCounts[q.model] || 0) + 1;
      }
      const primaryModel =
        Object.entries(modelCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ||
        "unknown";

      const firstPrompt =
        sessionFirstPrompt[sessionId] ||
        queries.find((q) => q.userPrompt)?.userPrompt ||
        "(no prompt)";

      // Collect per-prompt data for "most expensive prompts"
      // Group consecutive queries under the same user prompt
      let currentPrompt = null;
      let promptInput = 0, promptOutput = 0;
      let promptQueries = [];
      let cumulativeContext = 0;
      const flushPrompt = () => {
        if (currentPrompt && (promptInput + promptOutput) > 0) {
          const costAnalysis = analyzePromptQuality(currentPrompt, promptQueries, cumulativeContext);
          allPrompts.push({
            prompt: currentPrompt.substring(0, 300),
            inputTokens: promptInput,
            outputTokens: promptOutput,
            totalTokens: promptInput + promptOutput,
            date,
            sessionId,
            model: primaryModel,
            costAnalysis,
          });
        }
      };
      
      let runningContextTracker = 0;
      for (const q of queries) {
        if (q.userPrompt && q.userPrompt !== currentPrompt) {
          flushPrompt();
          currentPrompt = q.userPrompt;
          cumulativeContext = runningContextTracker;
          promptInput = 0;
          promptOutput = 0;
          promptQueries = [];
        }
        promptInput += q.inputTokens;
        promptOutput += q.outputTokens;
        promptQueries.push(q);
        runningContextTracker += q.inputTokens;
      }
      flushPrompt();

      const snowballData = computeSnowballData(queries);
      const breakEvenPoint = computeBreakEvenPoint(snowballData);
      const toolAnalysis = analyzeToolUsage(queries);

      sessions.push({
        sessionId,
        project: projectDir,
        date,
        timestamp: firstTimestamp,
        firstPrompt: firstPrompt.substring(0, 200),
        model: primaryModel,
        queryCount: queries.length,
        queries,
        freshInputTokens,
        cacheWriteTokens,
        cacheReadTokens,
        inputTokens,
        outputTokens,
        totalTokens,
        estimatedCost,
        snowballData,
        breakEvenPoint,
        toolAnalysis,
      });

      // Daily
      if (date !== 'unknown') {
        if (!dailyMap[date]) {
          dailyMap[date] = {
            date,
            inputTokens: 0, outputTokens: 0, totalTokens: 0,
            cacheReadTokens: 0, cacheWriteTokens: 0,
            estimatedCost: 0,
            sessions: 0, queries: 0,
          };
        }
        dailyMap[date].inputTokens  += inputTokens;
        dailyMap[date].outputTokens += outputTokens;
        dailyMap[date].totalTokens  += totalTokens;
        dailyMap[date].cacheReadTokens  += cacheReadTokens;
        dailyMap[date].cacheWriteTokens += cacheWriteTokens;
        dailyMap[date].estimatedCost    += estimatedCost;
        dailyMap[date].sessions += 1;
        dailyMap[date].queries  += queries.length;
      }

      // Model
      for (const q of queries) {
        if (q.model === '<synthetic>' || q.model === 'unknown') continue;
        if (!modelMap[q.model]) {
          modelMap[q.model] = {
            model: q.model,
            inputTokens: 0, outputTokens: 0, totalTokens: 0,
            cacheReadTokens: 0, cacheWriteTokens: 0,
            estimatedCost: 0, queryCount: 0,
          };
        }
        modelMap[q.model].inputTokens     += q.inputTokens;
        modelMap[q.model].outputTokens    += q.outputTokens;
        modelMap[q.model].totalTokens     += q.totalTokens;
        modelMap[q.model].cacheReadTokens  += q.cacheReadTokens;
        modelMap[q.model].cacheWriteTokens += q.cacheWriteTokens;
        modelMap[q.model].estimatedCost    += q.estimatedCost;
        modelMap[q.model].queryCount       += 1;
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
        inputTokens: 0, outputTokens: 0, totalTokens: 0,
        cacheReadTokens: 0, cacheWriteTokens: 0,
        estimatedCost: 0,
        sessionCount: 0, queryCount: 0,
        modelMap: {}, allPrompts: [],
      };
    }
    const p = projectMap[proj];
    p.inputTokens      += session.inputTokens;
    p.outputTokens     += session.outputTokens;
    p.totalTokens      += session.totalTokens;
    p.cacheReadTokens  += session.cacheReadTokens;
    p.cacheWriteTokens += session.cacheWriteTokens;
    p.estimatedCost    += session.estimatedCost;
    p.sessionCount += 1;
    p.queryCount   += session.queryCount;

    for (const q of session.queries) {
      if (q.model === '<synthetic>' || q.model === 'unknown') continue;
      if (!p.modelMap[q.model]) {
        p.modelMap[q.model] = {
          model: q.model,
          inputTokens: 0, outputTokens: 0, totalTokens: 0,
          estimatedCost: 0, queryCount: 0,
        };
      }
      const m = p.modelMap[q.model];
      m.inputTokens  += q.inputTokens;
      m.outputTokens += q.outputTokens;
      m.totalTokens  += q.totalTokens;
      m.estimatedCost += q.estimatedCost;
      m.queryCount   += 1;
    }

    // Per-project prompt grouping with tool tracking + cost
    let curPrompt = null, curInput = 0, curOutput = 0, curCost = 0, curConts = 0;
    let curModels = {}, curTools = {};
    const flushProjectPrompt = () => {
      if (curPrompt && (curInput + curOutput) > 0) {
        const topModel = Object.entries(curModels).sort((a, b) => b[1] - a[1])[0]?.[0] || session.model;
        p.allPrompts.push({
          prompt: curPrompt.substring(0, 300),
          inputTokens: curInput,
          outputTokens: curOutput,
          totalTokens: curInput + curOutput,
          estimatedCost: curCost,
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
        curInput = 0; curOutput = 0; curCost = 0; curConts = 0;
        curModels = {}; curTools = {};
      } else if (!q.userPrompt) {
        curConts++;
      }
      curInput  += q.inputTokens;
      curOutput += q.outputTokens;
      curCost   += q.estimatedCost;
      if (q.model && q.model !== '<synthetic>') curModels[q.model] = (curModels[q.model] || 0) + 1;
      for (const t of q.tools || []) curTools[t.name] = (curTools[t.name] || 0) + 1;
    }
    flushProjectPrompt();
  }

  const projectBreakdown = Object.values(projectMap)
    .map((p) => ({
      project: p.project,
      inputTokens: p.inputTokens,
      outputTokens: p.outputTokens,
      totalTokens: p.totalTokens,
      cacheReadTokens: p.cacheReadTokens,
      cacheWriteTokens: p.cacheWriteTokens,
      estimatedCost: p.estimatedCost,
      sessionCount: p.sessionCount,
      queryCount: p.queryCount,
      modelBreakdown: Object.values(p.modelMap).sort((a, b) => b.totalTokens - a.totalTokens),
      topPrompts: (p.allPrompts || []).sort((a, b) => b.totalTokens - a.totalTokens).slice(0, 10),
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens);

  const dailyUsage = Object.values(dailyMap).sort((a, b) =>
    a.date.localeCompare(b.date),
  );

  // Top 20 most expensive individual prompts — accumulate cost per group too
  const allPromptsMap = {};
  for (const session of sessions) {
    let curPrompt = null, curInput = 0, curOutput = 0, curCost = 0;
    const flush = () => {
      if (curPrompt && (curInput + curOutput) > 0) {
        const key = curPrompt + '|' + session.sessionId;
        if (!allPromptsMap[key]) {
          allPromptsMap[key] = {
            prompt: curPrompt.substring(0, 300),
            inputTokens: 0, outputTokens: 0, totalTokens: 0,
            estimatedCost: 0,
            date: session.date, sessionId: session.sessionId, model: session.model,
          };
        }
        allPromptsMap[key].inputTokens  += curInput;
        allPromptsMap[key].outputTokens += curOutput;
        allPromptsMap[key].totalTokens  += curInput + curOutput;
        allPromptsMap[key].estimatedCost += curCost;
      }
    };
    for (const q of session.queries) {
      if (q.userPrompt && q.userPrompt !== curPrompt) {
        flush();
        curPrompt = q.userPrompt; curInput = 0; curOutput = 0; curCost = 0;
      }
      curInput  += q.inputTokens;
      curOutput += q.outputTokens;
      curCost   += q.estimatedCost;
    }
    flush();
  }
  const allPromptsList = Object.values(allPromptsMap)
    .sort((a, b) => b.totalTokens - a.totalTokens);
  const topPrompts = allPromptsList.slice(0, 20);

  const totalEstimatedCost = sessions.reduce((s, x) => s + x.estimatedCost, 0);
  const totalCacheReadTokens  = sessions.reduce((s, x) => s + x.cacheReadTokens, 0);
  const totalCacheWriteTokens = sessions.reduce((s, x) => s + x.cacheWriteTokens, 0);
  const totalFreshInputTokens = sessions.reduce((s, x) => s + x.freshInputTokens, 0);
  // Cache savings: what would those cacheRead tokens have cost as fresh input?
  const cacheSavingsDollars = sessions.reduce((sum, s) => {
    // For each session, savings per query = cacheRead * (input_rate - cacheRead_rate) / 1M
    return sum + s.queries.reduce((qs, q) => {
      const p = getPricing(q.model);
      return qs + q.cacheReadTokens * (p.input - p.cacheRead) / 1_000_000;
    }, 0);
  }, 0);

  const grandTotals = {
    totalSessions: sessions.length,
    totalQueries: sessions.reduce((sum, s) => sum + s.queryCount, 0),
    totalTokens: sessions.reduce((sum, s) => sum + s.totalTokens, 0),
    totalInputTokens: sessions.reduce((sum, s) => sum + s.inputTokens, 0),
    totalOutputTokens: sessions.reduce((sum, s) => sum + s.outputTokens, 0),
    totalFreshInputTokens,
    totalCacheReadTokens,
    totalCacheWriteTokens,
    totalEstimatedCost,
    cacheSavingsDollars,
    cacheHitRate: totalFreshInputTokens + totalCacheReadTokens > 0
      ? totalCacheReadTokens / (totalFreshInputTokens + totalCacheReadTokens)
      : 0,
    avgTokensPerQuery: 0,
    avgTokensPerSession: 0,
    totalToolCalls: sessions.reduce((sum, s) => sum + (s.toolAnalysis?.totalToolCalls || 0), 0),
    avgSpecificityScore: allPrompts.length ? allPrompts.reduce((sum, p) => sum + p.costAnalysis.specificityScore, 0) / allPrompts.length : 0,
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

  if (grandTotals.totalSessions > 0) {
    grandTotals.avgTokensPerSession = Math.round(grandTotals.totalTokens / grandTotals.totalSessions);
  }

  // Calculate Efficiency Score (F6)
  // 1. Cache Utilization (40%)
  const cacheRatio = totalFreshInputTokens + totalCacheReadTokens > 0
    ? totalCacheReadTokens / (totalFreshInputTokens + totalCacheReadTokens)
    : 0;
  const cacheScore = cacheRatio * 40;

  // 2. Tool Efficiency (30%)
  let totalQueries = 0;
  let reworkQueries = 0; // count queries where Claude had to rewrite files multiple times
  allPrompts.forEach(p => {
      totalQueries++;
      if (p.costAnalysis.reworkLoops > 0) reworkQueries++;
  });
  const toolEfficiency = totalQueries > 0 ? (1 - (reworkQueries / totalQueries)) : 1;
  const toolScore = toolEfficiency * 30;

  // 3. Context Discipline (30%)
  const marathonSessions = sessions.filter(s => s.queryCount > 50).length;
  const contextDiscipline = sessions.length > 0 ? (1 - (marathonSessions / sessions.length)) : 1;
  const contextScore = contextDiscipline * 30;

  const rawEfficiencyScore = Math.min(100, Math.round(cacheScore + toolScore + contextScore));
  let efficiencyGrade = 'D';
  if (rawEfficiencyScore >= 90) efficiencyGrade = 'A+';
  else if (rawEfficiencyScore >= 80) efficiencyGrade = 'A';
  else if (rawEfficiencyScore >= 70) efficiencyGrade = 'B';
  else if (rawEfficiencyScore >= 60) efficiencyGrade = 'C';

  grandTotals.efficiency = {
      score: rawEfficiencyScore,
      grade: efficiencyGrade,
      cacheRatio,
      toolEfficiency,
      contextDiscipline
  };

  // Generate insights
  const insights = generateInsights(sessions, allPrompts, grandTotals);

  return {
    sessions,
    dailyUsage,
    modelBreakdown: Object.values(modelMap),
    projectBreakdown,
    topPrompts,
    totals: grandTotals,
    insights,
  };
}

function generateInsights(sessions, allPrompts, totals) {
  const insights = [];

  // 1. Short, vague messages that cost a lot
  const shortExpensive = allPrompts.filter(
    (p) => p.prompt.trim().length < 30 && p.totalTokens > 100_000,
  );
  if (shortExpensive.length > 0) {
    const totalWasted = shortExpensive.reduce((s, p) => s + p.totalTokens, 0);
    const examples = [
      ...new Set(shortExpensive.map((p) => p.prompt.trim())),
    ].slice(0, 4);
    insights.push({
      id: "vague-prompts",
      type: "warning",
      title: "Short, vague messages are costing you the most",
      description: `${shortExpensive.length} times you sent a short message like ${examples.map((e) => '"' + e + '"').join(", ")} -- and each time, Claude used over 100K tokens to respond. That adds up to ${fmt(totalWasted)} tokens total. When you say just "Yes" or "Do it", Claude doesn't know exactly what you want, so it tries harder -- reading more files, running more tools, making more attempts. Each of those steps re-sends the entire conversation, which multiplies the cost.`,
      action:
        'Try being specific. Instead of "Yes", say "Yes, update the login page and run the tests." It gives Claude a clear target, so it finishes faster and uses fewer tokens.',
    });
  }

  // 2. Long conversations getting more expensive over time
  const longSessions = sessions.filter((s) => s.queries.length > 50);
  if (longSessions.length > 0) {
    const growthData = longSessions
      .map((s) => {
        const first5 =
          s.queries.slice(0, 5).reduce((sum, q) => sum + q.totalTokens, 0) /
          Math.min(5, s.queries.length);
        const last5 =
          s.queries.slice(-5).reduce((sum, q) => sum + q.totalTokens, 0) /
          Math.min(5, s.queries.length);
        return {
          session: s,
          first5,
          last5,
          ratio: last5 / Math.max(first5, 1),
        };
      })
      .filter((g) => g.ratio > 2);

    if (growthData.length > 0) {
      const avgGrowth = (
        growthData.reduce((s, g) => s + g.ratio, 0) / growthData.length
      ).toFixed(1);
      const worstSession = growthData.sort((a, b) => b.ratio - a.ratio)[0];
      insights.push({
        id: "context-growth",
        type: "warning",
        title: "The longer you chat, the more each message costs",
        description: `In ${growthData.length} of your conversations, the messages near the end cost ${avgGrowth}x more than the ones at the start. Why? Every time you send a message, Claude re-reads the entire conversation from the beginning. So message #5 is cheap, but message #80 is expensive because Claude is re-reading 79 previous messages plus all the code it wrote. Your longest conversation ("${worstSession.session.firstPrompt.substring(0, 50)}...") grew ${worstSession.ratio.toFixed(1)}x more expensive by the end.`,
        action:
          "Start a fresh conversation when you move to a new task. If you need context from before, paste a short summary in your first message. This gives Claude a clean slate instead of re-reading hundreds of old messages.",
      });
    }
  }

  // 3. Marathon conversations
  const turnCounts = sessions.map((s) => s.queryCount);
  const medianTurns =
    turnCounts.sort((a, b) => a - b)[Math.floor(turnCounts.length / 2)] || 0;
  const longCount = sessions.filter((s) => s.queryCount > 200).length;
  if (longCount >= 3) {
    const longTokens = sessions
      .filter((s) => s.queryCount > 200)
      .reduce((s, ses) => s + ses.totalTokens, 0);
    const longPct = (
      (longTokens / Math.max(totals.totalTokens, 1)) *
      100
    ).toFixed(0);
    insights.push({
      id: "marathon-sessions",
      type: "info",
      title: `Just ${longCount} long conversations used ${longPct}% of all your tokens`,
      description: `You have ${longCount} conversations with over 200 messages each. These alone consumed ${fmt(longTokens)} tokens -- that's ${longPct}% of everything. Meanwhile, your typical conversation is about ${medianTurns} messages. Long conversations aren't always bad, but they're disproportionately expensive because of how context builds up.`,
      action:
        "Try keeping one conversation per task. When a conversation starts drifting into different topics, that is a good time to start a new one.",
    });
  }

  // 4. Most tokens are re-reading, not writing
  if (totals.totalTokens > 0) {
    const outputPct = (totals.totalOutputTokens / totals.totalTokens) * 100;
    if (outputPct < 2) {
      insights.push({
        id: "input-heavy",
        type: "info",
        title: `${outputPct.toFixed(1)}% of your tokens are Claude actually writing`,
        description: `Here's something surprising: out of ${fmt(totals.totalTokens)} total tokens, only ${fmt(totals.totalOutputTokens)} are from Claude writing responses. The other ${(100 - outputPct).toFixed(1)}% is Claude re-reading your conversation history, files, and context before each response. This means the biggest factor in token usage isn't how much Claude writes -- it's how long your conversations are.`,
        action:
          "Keeping conversations shorter has more impact than asking for shorter answers. A 20-message conversation costs far less than a 200-message one, even if the total output is similar.",
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
    const dayNames = [
      "Sunday",
      "Monday",
      "Tuesday",
      "Wednesday",
      "Thursday",
      "Friday",
      "Saturday",
    ];
    const days = Object.entries(dayOfWeekMap).map(([d, v]) => ({
      day: dayNames[d],
      ...v,
      avg: v.tokens / v.sessions,
    }));
    if (days.length >= 3) {
      days.sort((a, b) => b.avg - a.avg);
      const busiest = days[0];
      const quietest = days[days.length - 1];
      insights.push({
        id: "day-pattern",
        type: "neutral",
        title: `You use Claude the most on ${busiest.day}s`,
        description: `Your ${busiest.day} conversations average ${fmt(Math.round(busiest.avg))} tokens each, compared to ${fmt(Math.round(quietest.avg))} on ${quietest.day}s. This could mean you tackle bigger tasks on ${busiest.day}s, or your conversations tend to run longer.`,
        action: null,
      });
    }
  }

  // 6. Model mismatch -- Opus used for simple conversations
  const opusSessions = sessions.filter((s) => s.model.includes("opus"));
  if (opusSessions.length > 0) {
    const simpleOpus = opusSessions.filter(
      (s) => s.queryCount < 10 && s.totalTokens < 200_000,
    );
    if (simpleOpus.length >= 3) {
      const wastedTokens = simpleOpus.reduce(
        (s, ses) => s + ses.totalTokens,
        0,
      );
      const examples = simpleOpus
        .slice(0, 3)
        .map((s) => '"' + s.firstPrompt.substring(0, 40) + '"')
        .join(", ");
      insights.push({
        id: "model-mismatch",
        type: "warning",
        title: `${simpleOpus.length} simple conversations used Opus unnecessarily`,
        description: `These conversations had fewer than 10 messages and used ${fmt(wastedTokens)} tokens on Opus: ${examples}. Opus is the most capable model but also the most expensive. For quick questions and small tasks, Sonnet or Haiku would give similar results at a fraction of the cost.`,
        action:
          "Use /model to switch to Sonnet or Haiku for simple tasks. Save Opus for complex multi-file changes, architecture decisions, or tricky debugging.",
      });
    }
  }

  // 7. Tool-heavy conversations
  if (sessions.length >= 5) {
    const toolHeavy = sessions.filter((s) => {
      const userMessages = s.queries.filter((q) => q.userPrompt).length;
      const toolCalls = s.queryCount - userMessages;
      return userMessages > 0 && toolCalls > userMessages * 3;
    });
    if (toolHeavy.length >= 3) {
      const totalToolTokens = toolHeavy.reduce(
        (s, ses) => s + ses.totalTokens,
        0,
      );
      const avgRatio =
        toolHeavy.reduce((s, ses) => {
          const userMsgs = ses.queries.filter((q) => q.userPrompt).length;
          return s + (ses.queryCount - userMsgs) / Math.max(userMsgs, 1);
        }, 0) / toolHeavy.length;
      insights.push({
        id: "tool-heavy",
        type: "info",
        title: `${toolHeavy.length} conversations had ${Math.round(avgRatio)}x more tool calls than messages`,
        description: `In these conversations, Claude made ~${Math.round(avgRatio)} tool calls for every message you sent. Each tool call (reading files, running commands, searching code) is a full round trip that re-reads the entire conversation. These ${toolHeavy.length} conversations used ${fmt(totalToolTokens)} tokens total.`,
        action:
          'Point Claude to specific files and line numbers when you can. "Fix the bug in src/auth.js line 42" triggers fewer tool calls than "fix the login bug" where Claude has to search for the right file first.',
      });
    }
  }

  // 8. One project dominates usage
  if (sessions.length >= 5) {
    const projectTokens = {};
    for (const s of sessions) {
      const proj = s.project || "unknown";
      projectTokens[proj] = (projectTokens[proj] || 0) + s.totalTokens;
    }
    const sorted = Object.entries(projectTokens).sort((a, b) => b[1] - a[1]);
    if (sorted.length >= 2) {
      const [topProject, topTokens] = sorted[0];
      const pct = ((topTokens / Math.max(totals.totalTokens, 1)) * 100).toFixed(
        0,
      );
      if (pct >= 60) {
        const projName =
          topProject
            .replace(/^C--Users-[^-]+-?/, "")
            .replace(/^Projects-?/, "")
            .replace(/-/g, "/") || "~";
        insights.push({
          id: "project-dominance",
          type: "info",
          title: `${pct}% of your tokens went to one project: ${projName}`,
          description: `Your "${projName}" project used ${fmt(topTokens)} tokens out of ${fmt(totals.totalTokens)} total. That is ${pct}% of all your usage. The next closest project used ${fmt(sorted[1][1])} tokens.`,
          action:
            "Not necessarily a problem, but worth knowing. If this project has long-running conversations, breaking them into smaller sessions could reduce its footprint.",
        });
      }
    }
  }

  // 9. Conversation efficiency -- short vs long conversations cost per message
  if (sessions.length >= 10) {
    const shortSessions = sessions.filter(
      (s) => s.queryCount >= 3 && s.queryCount <= 15,
    );
    const longSessions2 = sessions.filter((s) => s.queryCount > 80);
    if (shortSessions.length >= 3 && longSessions2.length >= 2) {
      const shortAvg = Math.round(
        shortSessions.reduce(
          (s, ses) => s + ses.totalTokens / ses.queryCount,
          0,
        ) / shortSessions.length,
      );
      const longAvg = Math.round(
        longSessions2.reduce(
          (s, ses) => s + ses.totalTokens / ses.queryCount,
          0,
        ) / longSessions2.length,
      );
      const ratio = (longAvg / Math.max(shortAvg, 1)).toFixed(1);
      if (ratio >= 2) {
        insights.push({
          id: "conversation-efficiency",
          type: "warning",
          title: `Each message costs ${ratio}x more in long conversations`,
          description: `In your short conversations (under 15 messages), each message costs ~${fmt(shortAvg)} tokens. In your long ones (80+ messages), each message costs ~${fmt(longAvg)} tokens. That is ${ratio}x more per message, because Claude re-reads the entire history every turn.`,
          action:
            "This is the single biggest lever for reducing token usage. Start fresh conversations more often. A 5-conversation workflow costs far less than one 500-message marathon.",
        });
      }
    }
  }

  // 10. Heavy context on first message (large CLAUDE.md or system prompts)
  if (sessions.length >= 5) {
    const heavyStarts = sessions.filter((s) => {
      const firstQuery = s.queries[0];
      return firstQuery && firstQuery.inputTokens > 50_000;
    });
    if (heavyStarts.length >= 5) {
      const avgStartTokens = Math.round(
        heavyStarts.reduce((s, ses) => s + ses.queries[0].inputTokens, 0) /
          heavyStarts.length,
      );
      const totalOverhead = heavyStarts.reduce(
        (s, ses) => s + ses.queries[0].inputTokens,
        0,
      );
      insights.push({
        id: "heavy-context",
        type: "info",
        title: `${heavyStarts.length} conversations started with ${fmt(avgStartTokens)}+ tokens of context`,
        description: `Before you even type your first message, Claude reads your CLAUDE.md, project files, and system context. In ${heavyStarts.length} conversations, this starting context averaged ${fmt(avgStartTokens)} tokens. Across all of them, that is ${fmt(totalOverhead)} tokens just on setup -- and this context gets re-read with every message.`,
        action:
          "Keep your CLAUDE.md files concise. Remove sections you rarely need. A smaller starting context compounds into savings across every message in the conversation.",
      });
    }
  }
  // Cache savings insight
  if (totals.cacheSavingsDollars > 0.05) {
    const pct = (totals.cacheHitRate * 100).toFixed(0);
    const savings = totals.cacheSavingsDollars;
    const fmtSav = savings >= 1 ? '$' + savings.toFixed(2) : '$' + savings.toFixed(3);
    insights.push({
      id: 'cache-savings',
      type: 'info',
      title: `Prompt caching saved you ~${fmtSav}`,
      description: `${pct}% of your input tokens were served from Anthropic's prompt cache at a fraction of the normal price. This saved you an estimated ${fmtSav} compared to charging full input price for repeated context (like CLAUDE.md and system prompts).`,
      action: 'Projects with large, stable CLAUDE.md files get the most cache benefit because that context is re-read every turn. Keep your CLAUDE.md consistent to maximize cache hits.',
    });
  } else if (totals.totalTokens > 100_000 && totals.cacheHitRate < 0.05) {
    insights.push({
      id: 'no-cache',
      type: 'neutral',
      title: 'You\'re not benefiting from prompt caching yet',
      description: `Less than 5% of your input appears to be served from cache. Prompt caching can significantly reduce costs when you have repeated context (system prompts, CLAUDE.md, large reference files) across turns.`,
      action: 'Ensure you have a CLAUDE.md in your project root. Claude Code uses this as stable context that gets cached across turns.',
    });
  }

  // 11. Smarter Insights (F8): High Tool Rework
  const reworkHeavyPrompts = allPrompts.filter(p => p.costAnalysis && p.costAnalysis.reworkLoops >= 2);
  if (reworkHeavyPrompts.length > 5) {
      insights.push({
          id: "high-rework",
          type: "warning",
          title: "Claude is frequently rewriting the same files",
          description: `In ${reworkHeavyPrompts.length} of your prompts, Claude had to execute multiple 'Write File' operations to the exact same file to satisfy your request. This usually happens when the initial instructions are vague, forcing Claude to take multiple guesses at the implementation.`,
          action: "Provide stricter acceptance criteria in your prompt. If you want a specific architectural pattern or library used, state it upfront so Claude doesn't have to refactor its own work."
      });
  }

  return insights;
}

function fmt(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 10_000) return (n / 1_000).toFixed(0) + "K";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return n.toLocaleString();
}

function analyzePromptQuality(promptText, queries, cumulativeInputTokens) {
  let specificityScore = 0;
  if (/(\/|\.js|\.py|\.html|\.ts|src\/)/i.test(promptText)) specificityScore += 0.25;
  if (/(line \d+|L\d+|:\d+)/i.test(promptText)) specificityScore += 0.25;
  if (/[a-z]+[A-Z][a-zA-Z]+|[A-Z][a-zA-Z]+/.test(promptText) && promptText.length > 20) specificityScore += 0.20;
  if (promptText.length > 100) specificityScore += 0.15;
  if (/(error|exception|trace|failed|undefined|null)/i.test(promptText)) specificityScore += 0.15;
  specificityScore = Math.min(1.0, specificityScore);

  let searchAttempts = 0;
  let uniqueTools = new Set();
  let fileWrites = {};
  let reworkLoops = 0;

  for (const q of queries) {
    for (const t of q.tools || []) {
      uniqueTools.add(t.name);
      if (t.name === 'Search' || t.name === 'List Directory') searchAttempts++;
      if (t.name === 'Read File' && searchAttempts > 0) searchAttempts++;
      if (t.name === 'Write File') {
        const file = t.input?.file_path || t.input?.path || 'unknown';
        fileWrites[file] = (fileWrites[file] || 0) + 1;
        if (fileWrites[file] > 1) reworkLoops++;
      }
    }
  }

  let totalQueryInput = queries.reduce((s, q) => s + q.inputTokens, 0);
  let toolCallOverhead = Math.max(0, totalQueryInput - (queries[0]?.inputTokens || 0));

  let drivers = [];
  if (cumulativeInputTokens > 50000) {
    drivers.push({ driver: 'context-depth', impact: 0.6, label: `Deep context (${fmt(cumulativeInputTokens)} prior tokens)`, tokens: cumulativeInputTokens });
  }
  if (searchAttempts > 2) {
    drivers.push({ driver: 'tool-fanout', impact: 0.2, label: `Searched/read ${searchAttempts} items before final answer`, tokens: toolCallOverhead });
  }
  if (reworkLoops > 0) {
    drivers.push({ driver: 'rework', impact: 0.15, label: `Claude retried ${reworkLoops} approaches`, tokens: Math.floor(toolCallOverhead * 0.5) });
  }
  if (promptText.length < 30) {
    drivers.push({ driver: 'vague-prompt', impact: 0.05, label: `Prompt was ${promptText.length} chars`, tokens: 0 });
  }
  drivers.sort((a,b) => b.impact - a.impact);

  let suggestion = null;
  if (specificityScore < 0.3 && searchAttempts > 2) suggestion = 'Tip: Mention exact file paths or line numbers to skip expensive searches.';
  else if (reworkLoops > 0) suggestion = 'Tip: Claude had to rewrite files multiple times. Include clearer acceptance criteria or exact examples.';
  else if (promptText.length < 20) suggestion = 'Tip: Very short prompts force Claude to guess intent. Add one sentence clarifying what you really want changed.';

  return {
    promptLength: promptText.length,
    specificityScore,
    contextPosition: 0,
    contextTokensAtTurn: cumulativeInputTokens,
    toolCallCount: queries.reduce((s, q) => s + (q.tools?.length || 0), 0),
    uniqueToolCalls: uniqueTools.size,
    searchAttempts,
    reworkLoops,
    costDrivers: drivers,
    suggestion
  };
}

function computeSnowballData(queries) {
  let data = [];
  let cumulative = 0;
  for (let i = 0; i < queries.length; i++) {
    cumulative += queries[i].inputTokens;
    data.push({
      turn: i + 1,
      inputTokens: queries[i].inputTokens,
      cumulativeInput: cumulative,
      outputTokens: queries[i].outputTokens,
    });
  }
  return data;
}

function computeBreakEvenPoint(snowballData) {
  if (snowballData.length < 5) return null;
  let totalCtxTax = 0;
  let firstTurnTokens = snowballData[0].inputTokens;
  for (let i = 1; i < snowballData.length; i++) {
    let tax = snowballData[i].inputTokens - firstTurnTokens;
    if (tax > 0) totalCtxTax += tax;
  }
  return { turn: Math.floor(snowballData.length / 2), savings: Math.floor(totalCtxTax * 0.3) };
}

function analyzeToolUsage(queries) {
  let totalCalls = 0;
  let uniqueTools = {};
  let toolChains = [];
  let fileAccessMap = {};
  let totalSearches = 0;
  let firstTrySuccesses = 0;

  let currentChain = [];
  let chainSearches = 0;
  let chainReads = 0;
  let chainTokens = 0;

  for (let i = 0; i < queries.length; i++) {
    let q = queries[i];
    if (q.userPrompt && currentChain.length > 0) {
      if (chainSearches > 0 && chainReads <= 1) firstTrySuccesses++;
      toolChains.push({ chain: currentChain, length: currentChain.length, tokens: chainTokens });
      currentChain = [];
      chainSearches = 0;
      chainReads = 0;
      chainTokens = 0;
    }
    
    for (let t of (q.tools || [])) {
      totalCalls++;
      uniqueTools[t.name] = (uniqueTools[t.name] || 0) + 1;
      currentChain.push(t.name);
      chainTokens += q.inputTokens; 

      if (t.name === 'Search' || t.name === 'List Directory') {
        chainSearches++;
        totalSearches++;
      }
      if (t.name === 'Read File') chainReads++;
      
      let file = t.input?.file_path || t.input?.path || t.input?.target || null;
      if (file) {
        if (!fileAccessMap[file]) fileAccessMap[file] = { reads: 0, writes: 0 };
        if (t.name === 'Read File') fileAccessMap[file].reads++;
        if (t.name === 'Write File') fileAccessMap[file].writes++;
      }
    }
  }
  if (currentChain.length > 0) {
    if (chainSearches > 0 && chainReads <= 1) firstTrySuccesses++;
    toolChains.push({ chain: currentChain, length: currentChain.length, tokens: chainTokens });
  }

  return {
    totalToolCalls: totalCalls,
    uniqueTools,
    searchEfficiency: {
      totalSearches,
      firstTrySuccesses
    },
    toolChains,
    fileAccessMap
  };
}

module.exports = { parseAllSessions };

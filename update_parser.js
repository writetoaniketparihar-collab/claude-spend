const fs = require('fs');

let content = fs.readFileSync('src/parser.js', 'utf8');

// 1. Tool extraction
content = content.replace(
  /if \(block\.type === 'tool_use' && block\.name\) tools\.push\(block\.name\);/g,
  `if (block.type === 'tool_use' && block.name) tools.push({ name: block.name, input: block.input || {} });`
);

// 2. Project tools aggregation
content = content.replace(
  /for \(const t of q\.tools \|\| \[\]\) curTools\[t\] = \(curTools\[t\] \|\| 0\) \+ 1;/g,
  `for (const t of q.tools || []) curTools[t.name] = (curTools[t.name] || 0) + 1;`
);

// 3. Prompt data collection
content = content.replace(
  `      // Group consecutive queries under the same user prompt
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
      flushPrompt();`,
`      // Group consecutive queries under the same user prompt
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
      flushPrompt();`
);

// 4. Session additions (snowball, toolAnalysis)
content = content.replace(
  `      sessions.push({
        sessionId,
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
      });`,
`      const snowballData = computeSnowballData(queries);
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
        inputTokens,
        outputTokens,
        totalTokens,
        snowballData,
        breakEvenPoint,
        toolAnalysis,
      });`
);

// 5. grandTotals metrics
content = content.replace(
  `    avgTokensPerQuery: 0,
    avgTokensPerSession: 0,`,
`    avgTokensPerQuery: 0,
    avgTokensPerSession: 0,
    totalToolCalls: sessions.reduce((sum, s) => sum + (s.toolAnalysis?.totalToolCalls || 0), 0),
    avgSpecificityScore: allPrompts.length ? allPrompts.reduce((sum, p) => sum + p.costAnalysis.specificityScore, 0) / allPrompts.length : 0,`
);

// 6. Append new functions
const newFunctions = \`
// --- PHASE 2 COACHING FUNCTIONS ---

function analyzePromptQuality(promptText, queries, cumulativeInputTokens) {
  let specificityScore = 0;
  if (/(\\/|\\.js|\\.py|\\.html|\\.ts|src\\/)/i.test(promptText)) specificityScore += 0.25;
  if (/(line \\d+|L\\d+|:\\d+)/i.test(promptText)) specificityScore += 0.25;
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
    drivers.push({ driver: 'context-depth', impact: 0.6, label: \`Deep context (\${fmt(cumulativeInputTokens)} prior tokens)\`, tokens: cumulativeInputTokens });
  }
  if (searchAttempts > 2) {
    drivers.push({ driver: 'tool-fanout', impact: 0.2, label: \`Searched/read \${searchAttempts} items before final answer\`, tokens: toolCallOverhead });
  }
  if (reworkLoops > 0) {
    drivers.push({ driver: 'rework', impact: 0.15, label: \`Claude retried \${reworkLoops} approaches\`, tokens: Math.floor(toolCallOverhead * 0.5) });
  }
  if (promptText.length < 30) {
    drivers.push({ driver: 'vague-prompt', impact: 0.05, label: \`Prompt was \${promptText.length} chars\`, tokens: 0 });
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
      // marginalCost approximation is hard without model pricing so we just focus on tokens
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
      chainTokens += q.inputTokens; // rudimentary tool step cost

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
\`;

content = content.replace('module.exports = { parseAllSessions };', newFunctions + '\\nmodule.exports = { parseAllSessions };');

fs.writeFileSync('src/parser.js', content);
console.log('parser.js updated successfully!');

const { MeterProvider, PeriodicExportingMetricReader } = require('@opentelemetry/sdk-metrics');
const { OTLPMetricExporter } = require('@opentelemetry/exporter-metrics-otlp-http');
const { resourceFromAttributes } = require('@opentelemetry/resources');

let meterProvider = null;

/**
 * Resolve the full OTLP metrics URL from a base endpoint.
 */
function resolveUrl(endpoint) {
  return endpoint.endsWith('/v1/metrics')
    ? endpoint
    : `${endpoint.replace(/\/$/, '')}/v1/metrics`;
}

/**
 * Test connectivity to an OTLP endpoint by sending an empty metrics payload.
 * Throws with a descriptive message if the endpoint is unreachable or rejects.
 */
async function testEndpoint(endpoint, headers) {
  const url = resolveUrl(endpoint);

  // Minimal valid OTLP metrics JSON payload (empty)
  const body = JSON.stringify({ resourceMetrics: [] });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body,
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (res.status >= 400) {
      const text = await res.text().catch(() => '');
      throw new Error(`${res.status} ${res.statusText}${text ? ': ' + text.slice(0, 200) : ''}`);
    }

    return { ok: true, status: res.status };
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') {
      throw new Error(`Connection timed out after 8s — is ${url} reachable?`);
    }
    if (err.cause?.code === 'ECONNREFUSED') {
      throw new Error(`Connection refused — no service listening at ${url}`);
    }
    if (err.cause?.code === 'ENOTFOUND') {
      throw new Error(`DNS lookup failed — hostname not found for ${endpoint}`);
    }
    throw err;
  }
}

/**
 * Initialize the OTLP metrics pipeline.
 */
function initOTLP({ endpoint, headers }) {
  const exporter = new OTLPMetricExporter({
    url: resolveUrl(endpoint),
    headers: headers || {},
  });

  const reader = new PeriodicExportingMetricReader({
    exporter,
    exportIntervalMillis: 60_000, // doesn't matter — we force flush
  });

  meterProvider = new MeterProvider({
    resource: resourceFromAttributes({
      'service.name': 'coding-agent-usage',
      'service.version': '1.0.0',
    }),
    readers: [reader],
  });

  const meter = meterProvider.getMeter('coding-agent-usage');

  return {
    meter,
    flush: () => reader.forceFlush(),
    shutdown: () => meterProvider.shutdown(),
  };
}

/**
 * Record all parsed session data as OpenTelemetry metrics and flush to the OTLP endpoint.
 *
 * Metrics exported:
 *
 *   Counters (cumulative totals, broken down by attributes):
 *     agent.usage.tokens.input   — total input tokens   {model, project}
 *     agent.usage.tokens.output  — total output tokens   {model, project}
 *     agent.usage.queries        — total query count     {model, project}
 *     agent.usage.sessions       — total session count   {project}
 *
 *   Histograms (distribution of per-session values):
 *     agent.usage.session.tokens     — token count per session  {model, project}
 *     agent.usage.session.queries    — query count per session  {model, project}
 *
 *   Gauges (point-in-time snapshots for daily breakdown):
 *     agent.usage.daily.tokens.input  — daily input tokens  {date}
 *     agent.usage.daily.tokens.output — daily output tokens {date}
 *     agent.usage.daily.sessions      — daily session count {date}
 *
 * @param {object} otel - Return value from initOTLP()
 * @param {object} data - Return value from parseAllSessions()
 */
async function exportMetrics(otel, data) {
  const { meter, flush } = otel;
  const { sessions, dailyUsage, modelBreakdown, totals } = data;

  // --- Counters: per-session token usage (additive) ---
  const inputTokensCounter = meter.createCounter('agent.usage.tokens.input', {
    description: 'Total input tokens consumed across coding agent sessions',
    unit: 'tokens',
  });

  const outputTokensCounter = meter.createCounter('agent.usage.tokens.output', {
    description: 'Total output tokens generated across coding agent sessions',
    unit: 'tokens',
  });

  const queriesCounter = meter.createCounter('agent.usage.queries', {
    description: 'Total number of queries (user-assistant round trips)',
  });

  const sessionsCounter = meter.createCounter('agent.usage.sessions', {
    description: 'Total number of coding agent sessions',
  });

  // --- Histograms: per-session distribution ---
  const sessionTokensHist = meter.createHistogram('agent.usage.session.tokens', {
    description: 'Distribution of total tokens per session',
    unit: 'tokens',
  });

  const sessionQueriesHist = meter.createHistogram('agent.usage.session.queries', {
    description: 'Distribution of query count per session',
  });

  // Record per-session data
  for (const session of sessions) {
    const attrs = {
      model: session.model,
      project: session.project,
      date: session.date,
    };

    inputTokensCounter.add(session.inputTokens, attrs);
    outputTokensCounter.add(session.outputTokens, attrs);
    queriesCounter.add(session.queryCount, attrs);
    sessionsCounter.add(1, { project: session.project });

    sessionTokensHist.record(session.totalTokens, attrs);
    sessionQueriesHist.record(session.queryCount, attrs);
  }

  // --- Gauges: daily breakdown (using UpDownCounter as observable gauge proxy) ---
  const dailyInputGauge = meter.createUpDownCounter('agent.usage.daily.tokens.input', {
    description: 'Input tokens consumed per day',
    unit: 'tokens',
  });
  const dailyOutputGauge = meter.createUpDownCounter('agent.usage.daily.tokens.output', {
    description: 'Output tokens consumed per day',
    unit: 'tokens',
  });
  const dailySessionsGauge = meter.createUpDownCounter('agent.usage.daily.sessions', {
    description: 'Number of sessions per day',
  });

  for (const day of dailyUsage) {
    const attrs = { date: day.date };
    dailyInputGauge.add(day.inputTokens, attrs);
    dailyOutputGauge.add(day.outputTokens, attrs);
    dailySessionsGauge.add(day.sessions, attrs);
  }

  // --- Gauges: per-model breakdown ---
  const modelInputGauge = meter.createUpDownCounter('agent.usage.model.tokens.input', {
    description: 'Input tokens per model',
    unit: 'tokens',
  });
  const modelOutputGauge = meter.createUpDownCounter('agent.usage.model.tokens.output', {
    description: 'Output tokens per model',
    unit: 'tokens',
  });
  const modelQueriesGauge = meter.createUpDownCounter('agent.usage.model.queries', {
    description: 'Query count per model',
  });

  for (const m of modelBreakdown) {
    const attrs = { model: m.model };
    modelInputGauge.add(m.inputTokens, attrs);
    modelOutputGauge.add(m.outputTokens, attrs);
    modelQueriesGauge.add(m.queryCount, attrs);
  }

  // Flush everything to the OTLP endpoint
  await flush();
}

/**
 * Gracefully shut down the meter provider.
 */
async function shutdownOTLP() {
  if (meterProvider) {
    try { await meterProvider.shutdown(); } catch { /* ignore shutdown errors */ }
    meterProvider = null;
  }
}

module.exports = { initOTLP, exportMetrics, shutdownOTLP, testEndpoint };

/**
 * log.vnoc.com — VNOC Centralized Error Hub
 *
 * Cloudflare Worker + D1 + Resend
 *
 * All API projects POST errors here → one dashboard, daily email digests.
 *
 * Routes:
 *   POST /ingest          — Log errors (ingest key)
 *   GET  /logs            — Query raw logs
 *   GET  /summary         — Aggregated stats
 *   GET  /sources         — List API sources
 *   POST /clear           — Clear logs
 *   GET  /                — Dashboard HTML
 *   GET  /health          — Health check
 *   POST /send-digest     — Trigger email digest manually (dashboard key)
 *   POST /analyze         — AI-powered single error analysis (CF Workers AI)
 *   GET  /agent           — Error Log Agent chat page
 *   POST /agent/chat      — Agent chat API (context-aware, multi-turn)
 *   GET  /install         — One-click setup page for new projects
 *
 * Cron: daily at 8 AM UTC → sends digest email via Resend
 */

export interface Env {
  DB: D1Database;
  AI: any;
  VNOC_API_URL: string;
  VNOC_API_KEY: string;
  RESEND_API_KEY: string;
  RESEND_FROM: string;
  ALERT_RECIPIENTS: string;
}

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key",
};

// ── Router ──────────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === "/ingest" && request.method === "POST") return handleIngest(request, env);
      if (path === "/logs") return handleLogs(url, env, request);
      if (path === "/summary") return handleSummary(url, env, request);
      if (path === "/sources") return handleSources(env, request);
      if (path === "/clear" && request.method === "POST") return handleClear(request, env);
      if (path === "/send-digest" && request.method === "POST") return handleManualDigest(env, request);
      if (path === "/analyze" && request.method === "POST") return handleAnalyze(request, env);
      if (path === "/agent/chat" && request.method === "POST") return handleAgentChat(request, env);
      if (path === "/agent") return handleAgentPage();
      if (path === "/install") return handleInstall();
      if (path === "/health") return json({ status: "ok", ts: new Date().toISOString() });
      if (path === "/" || path === "/dashboard") return handleDashboard(env, request);
      return json({ error: "Not found" }, 404);
    } catch (err: any) {
      return json({ error: err.message || "Internal error" }, 500);
    }
  },

  // Cron trigger: daily error digest
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(sendDailyDigest(env));
  },
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function json(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status, headers: { "Content-Type": "application/json", ...CORS },
  });
}

// ── POST /ingest ────────────────────────────────────────────────────────────

async function handleIngest(request: Request, env: Env): Promise<Response> {
  let body: { api_source: string; errors: any[] };
  try { body = await request.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
  if (!body.api_source) return json({ error: "api_source required" }, 400);
  if (!body.errors?.length) return json({ error: "errors array empty" }, 400);

  const stmts = body.errors.map((e: any) =>
    env.DB.prepare(
      `INSERT INTO error_logs (api_source, error_type, endpoint, method, message, ip, user_agent, query_params, domain)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      body.api_source.substring(0, 50),
      (e.error_type || "error").substring(0, 30),
      (e.endpoint || "").substring(0, 255),
      (e.method || "GET").substring(0, 10),
      (e.message || "").substring(0, 2000),
      (e.ip || "").substring(0, 45),
      (e.user_agent || "").substring(0, 500),
      (e.query_params || "").substring(0, 2000),
      (e.domain || "").substring(0, 100),
    )
  );

  await env.DB.batch(stmts);
  return json({ success: true, logged: body.errors.length });
}

// ── GET /logs ───────────────────────────────────────────────────────────────

async function handleLogs(url: URL, env: Env, req: Request): Promise<Response> {
  const source = url.searchParams.get("source") || "";
  const errorType = url.searchParams.get("type") || "";
  const endpoint = url.searchParams.get("endpoint") || "";
  const domain = url.searchParams.get("domain") || "";
  const search = url.searchParams.get("search") || "";
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "100"), 500);
  const offset = parseInt(url.searchParams.get("offset") || "0");

  let where = "1=1"; const p: any[] = [];
  if (source) { where += " AND api_source = ?"; p.push(source); }
  if (errorType) { where += " AND error_type = ?"; p.push(errorType); }
  if (endpoint) { where += " AND endpoint LIKE ?"; p.push(`%${endpoint}%`); }
  if (domain) { where += " AND domain LIKE ?"; p.push(`%${domain}%`); }
  if (search) { where += " AND message LIKE ?"; p.push(`%${search}%`); }

  const cnt = await env.DB.prepare(`SELECT COUNT(*) as total FROM error_logs WHERE ${where}`).bind(...p).first<{total:number}>();
  const rows = await env.DB.prepare(`SELECT * FROM error_logs WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`).bind(...p, limit, offset).all();

  return json({ success: true, total: cnt?.total||0, limit, offset, logs: rows.results });
}

// ── GET /summary ────────────────────────────────────────────────────────────

async function handleSummary(url: URL, env: Env, req: Request): Promise<Response> {
  const source = url.searchParams.get("source") || "";
  const hours = parseInt(url.searchParams.get("hours") || "24");
  const since = new Date(Date.now() - hours * 3600000).toISOString();

  let w = "created_at >= ?"; const p: any[] = [since];
  if (source) { w += " AND api_source = ?"; p.push(source); }

  const bySrc = await env.DB.prepare(`SELECT api_source, error_type, COUNT(*) as count FROM error_logs WHERE ${w} GROUP BY api_source, error_type ORDER BY count DESC`).bind(...p).all();
  const topEp = await env.DB.prepare(`SELECT api_source, endpoint, error_type, COUNT(*) as count, MAX(created_at) as last_seen FROM error_logs WHERE ${w} GROUP BY api_source, endpoint, error_type ORDER BY count DESC LIMIT 50`).bind(...p).all();
  const total = await env.DB.prepare(`SELECT COUNT(*) as total FROM error_logs WHERE ${w}`).bind(...p).first<{total:number}>();
  const hist = await env.DB.prepare(`SELECT strftime('%Y-%m-%d %H:00', created_at) as hour, COUNT(*) as count FROM error_logs WHERE ${w} GROUP BY hour ORDER BY hour`).bind(...p).all();
  const byDomain = await env.DB.prepare(`SELECT domain, COUNT(*) as count FROM error_logs WHERE ${w} AND domain != '' GROUP BY domain ORDER BY count DESC LIMIT 30`).bind(...p).all();

  return json({ success: true, hours, total: total?.total||0, by_source: bySrc.results, top_endpoints: topEp.results, histogram: hist.results, by_domain: byDomain.results });
}

// ── GET /sources ────────────────────────────────────────────────────────────

async function handleSources(env: Env, req: Request): Promise<Response> {
  const rows = await env.DB.prepare(`SELECT api_source, COUNT(*) as total, MAX(created_at) as last_error, COUNT(DISTINCT domain) as domains FROM error_logs GROUP BY api_source ORDER BY total DESC`).all();
  return json({ success: true, sources: rows.results });
}

// ── POST /clear ─────────────────────────────────────────────────────────────

async function handleClear(req: Request, env: Env): Promise<Response> {
  let body: { source?: string; older_than_hours?: number };
  try { body = await req.json(); } catch { body = {}; }

  let sql = "DELETE FROM error_logs"; const p: any[] = [];
  if (body.source && body.older_than_hours) {
    sql += " WHERE api_source = ? AND created_at < ?";
    p.push(body.source, new Date(Date.now() - body.older_than_hours * 3600000).toISOString());
  } else if (body.source) { sql += " WHERE api_source = ?"; p.push(body.source); }
  else if (body.older_than_hours) { sql += " WHERE created_at < ?"; p.push(new Date(Date.now() - body.older_than_hours * 3600000).toISOString()); }

  const result = await env.DB.prepare(sql).bind(...p).run();
  return json({ success: true, deleted: result.meta.changes });
}

// ── POST /analyze — AI Error Analysis ──────────────────────────────────────

async function handleAnalyze(request: Request, env: Env): Promise<Response> {
  let body: { error_type?: string; endpoint?: string; method?: string; message?: string; api_source?: string; query_params?: string; user_agent?: string };
  try { body = await request.json(); } catch { return json({ error: "Invalid JSON" }, 400); }

  if (!body.message) return json({ error: "message is required" }, 400);

  const prompt = `You are an expert API error analyst for VNOC, a web platform company. Analyze the following API error and provide:
1. A clear diagnosis of what likely caused the error
2. Specific steps to fix it
3. A severity rating (critical, high, medium, low)

Error Details:
- API Source: ${body.api_source || "unknown"}
- Error Type: ${body.error_type || "unknown"}
- HTTP Method: ${body.method || "unknown"}
- Endpoint: ${body.endpoint || "unknown"}
- Error Message: ${body.message}
${body.query_params ? `- Query Params: ${body.query_params}` : ""}
${body.user_agent ? `- User Agent: ${body.user_agent}` : ""}

Respond in this exact JSON format (no markdown, no code fences):
{"diagnosis":"...","suggested_fix":"...","severity":"critical|high|medium|low","category":"..."}`;

  try {
    const result = await env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
      messages: [
        { role: "system", content: "You are an API error analyst. Always respond with valid JSON only, no markdown formatting." },
        { role: "user", content: prompt },
      ],
      max_tokens: 512,
      temperature: 0.3,
    });

    const text = (result.response || "").trim();

    // Try to parse AI response as JSON
    let analysis: any;
    try {
      // Strip markdown code fences if the model added them
      const cleaned = text.replace(/^```json?\n?/i, "").replace(/\n?```$/i, "").trim();
      analysis = JSON.parse(cleaned);
    } catch {
      // If AI didn't return valid JSON, wrap the raw text
      analysis = {
        diagnosis: text,
        suggested_fix: "Review the error details and check server logs for more context.",
        severity: "medium",
        category: "uncategorized",
      };
    }

    return json({ success: true, analysis });
  } catch (err: any) {
    return json({ success: false, error: `AI analysis failed: ${err.message || "Unknown error"}` }, 500);
  }
}

// ── POST /agent/chat — Context-Aware Error Agent ───────────────────────────

async function buildAgentContext(env: Env, source?: string, hours = 24): Promise<string> {
  const since = new Date(Date.now() - hours * 3600000).toISOString();
  let w = "created_at >= ?"; const p: any[] = [since];
  if (source) { w += " AND api_source = ?"; p.push(source); }

  const total = await env.DB.prepare(`SELECT COUNT(*) as total FROM error_logs WHERE ${w}`).bind(...p).first<{total:number}>();
  const bySrc = await env.DB.prepare(`SELECT api_source, error_type, COUNT(*) as count FROM error_logs WHERE ${w} GROUP BY api_source, error_type ORDER BY count DESC LIMIT 30`).bind(...p).all();
  const topEp = await env.DB.prepare(`SELECT api_source, endpoint, method, error_type, COUNT(*) as count, MAX(message) as sample_message, MAX(created_at) as last_seen FROM error_logs WHERE ${w} GROUP BY api_source, endpoint, method, error_type ORDER BY count DESC LIMIT 25`).bind(...p).all();
  const recentErrors = await env.DB.prepare(`SELECT api_source, error_type, endpoint, method, message, domain, ip, created_at FROM error_logs WHERE ${w} ORDER BY created_at DESC LIMIT 20`).bind(...p).all();
  const byDomain = await env.DB.prepare(`SELECT domain, COUNT(*) as count FROM error_logs WHERE ${w} AND domain != '' GROUP BY domain ORDER BY count DESC LIMIT 15`).bind(...p).all();
  const sources = await env.DB.prepare(`SELECT api_source, COUNT(*) as total, MAX(created_at) as last_error FROM error_logs GROUP BY api_source ORDER BY total DESC`).all();

  const srcSummary = (bySrc.results || []).map((r: any) => `  ${r.api_source} → ${r.error_type}: ${r.count}`).join("\n");
  const epSummary = (topEp.results || []).map((r: any) => `  [${r.count}x] ${r.method} ${r.api_source}${r.endpoint} (${r.error_type}) — "${(r.sample_message || "").substring(0, 120)}"`).join("\n");
  const recentList = (recentErrors.results || []).map((r: any) => `  ${(r.created_at||"").substring(0,19)} | ${r.api_source} | ${r.error_type} | ${r.method} ${r.endpoint} | ${(r.message||"").substring(0,150)}${r.domain ? " | domain:"+r.domain : ""}`).join("\n");
  const domainList = (byDomain.results || []).map((r: any) => `  ${r.domain}: ${r.count} errors`).join("\n");
  const srcList = (sources.results || []).map((r: any) => `  ${r.api_source} (${r.total} total, last: ${(r.last_error||"").substring(0,19)})`).join("\n");

  return `=== LIVE ERROR DATA (last ${hours}h${source ? ", filtered to: " + source : ""}) ===
Total errors: ${total?.total || 0}

REGISTERED API SOURCES (all time):
${srcList || "  None"}

ERRORS BY SOURCE + TYPE:
${srcSummary || "  None"}

TOP ERROR ENDPOINTS (grouped by frequency):
${epSummary || "  None"}

MOST RECENT 20 ERRORS:
${recentList || "  None"}

TOP DOMAINS TRIGGERING ERRORS:
${domainList || "  None"}
=== END LIVE DATA ===`;
}

async function handleAgentChat(request: Request, env: Env): Promise<Response> {
  let body: { messages: { role: string; content: string }[]; source?: string; hours?: number; focus_error?: any };
  try { body = await request.json(); } catch { return json({ error: "Invalid JSON" }, 400); }

  if (!body.messages?.length) return json({ error: "messages array required" }, 400);

  // Build live context from D1
  const context = await buildAgentContext(env, body.source, body.hours || 24);

  // If there's a specific error to focus on, add it
  let focusCtx = "";
  if (body.focus_error) {
    const fe = body.focus_error;
    focusCtx = `\n\n=== FOCUSED ERROR ===
The user clicked "Analyze" on this specific error:
- Source: ${fe.api_source || "?"}
- Type: ${fe.error_type || "?"}
- Method: ${fe.method || "?"}
- Endpoint: ${fe.endpoint || "?"}
- Message: ${fe.message || "?"}
- User Agent: ${fe.user_agent || "?"}
- Query Params: ${fe.query_params || "?"}
Please analyze this error specifically.
=== END FOCUSED ERROR ===`;
  }

  const systemPrompt = `You are the VNOC Error Log Agent — an expert AI assistant for diagnosing and resolving API errors across the VNOC platform.

You have LIVE access to the error database. Below is real-time data from the error hub:

${context}${focusCtx}

YOUR CAPABILITIES:
- Diagnose individual errors and explain root causes in plain language
- Spot patterns: recurring errors, spikes, correlated failures across services
- Recommend specific code fixes with file paths and code snippets when possible
- Assess severity and prioritize which errors to fix first
- Identify bot/scanner traffic vs real user errors
- Track error trends over time

VNOC PLATFORM CONTEXT:
- api-contrib1 (api1.contrib.co): Next.js API — domains, members, challenge, icontent controllers
- api-contrib2 (api2.contrib.co): Next.js API — request, jobs, challenges, vertical, forum controllers
- api-contentagent (api.contentagent.com): Next.js API — content management
- api-socialagent (api.socialagent.com): Next.js API — social features
- api-dntrademark (api.dntrademark.com): Next.js API — trademark search + domain tools
- All use MySQL backends, fire-and-forget error reporting to this hub

RESPONSE STYLE:
- Be direct and actionable. No fluff.
- Use bullet points for clarity
- When you see patterns, call them out proactively
- If an error is from a bot/scanner (e.g. /.env, /wp-admin, /.git), say so
- Rate severity: 🔴 Critical, 🟠 High, 🟡 Medium, 🟢 Low
- If you don't have enough data, say so honestly

When the conversation starts, give a brief status overview if the user hasn't asked a specific question.`;

  const messages = [
    { role: "system", content: systemPrompt },
    ...body.messages.slice(-10), // Keep last 10 messages for context window
  ];

  try {
    const result = await env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
      messages,
      max_tokens: 1024,
      temperature: 0.4,
    });

    return json({ success: true, response: result.response || "No response from AI." });
  } catch (err: any) {
    return json({ success: false, error: `Agent error: ${err.message || "Unknown"}` }, 500);
  }
}

// ── POST /send-digest (manual trigger) ──────────────────────────────────────

async function handleManualDigest(env: Env, req: Request): Promise<Response> {
  const result = await sendDailyDigest(env);
  return json(result);
}

// ── Resend Email ───────────────────────────────────────────────────────────

async function sendDailyDigest(env: Env): Promise<{ success: boolean; message: string }> {
  const hours = 24;
  const since = new Date(Date.now() - hours * 3600000).toISOString();

  const total = await env.DB.prepare("SELECT COUNT(*) as total FROM error_logs WHERE created_at >= ?").bind(since).first<{total:number}>();
  const totalCount = total?.total || 0;

  if (totalCount === 0) {
    await env.DB.prepare("INSERT INTO alert_history (recipients, total_errors, critical_count, period_hours, status) VALUES (?, 0, 0, 24, 'skipped')").bind(env.ALERT_RECIPIENTS).run();
    return { success: true, message: "No errors in last 24h — skipped" };
  }

  const bySrc = await env.DB.prepare("SELECT api_source, error_type, COUNT(*) as count FROM error_logs WHERE created_at >= ? GROUP BY api_source, error_type ORDER BY count DESC").bind(since).all();
  const topEp = await env.DB.prepare("SELECT api_source, endpoint, error_type, COUNT(*) as count, MAX(created_at) as last_seen FROM error_logs WHERE created_at >= ? GROUP BY api_source, endpoint, error_type ORDER BY count DESC LIMIT 20").bind(since).all();
  const byDomain = await env.DB.prepare("SELECT domain, COUNT(*) as count FROM error_logs WHERE created_at >= ? AND domain != '' GROUP BY domain ORDER BY count DESC LIMIT 15").bind(since).all();

  const criticalCount = (bySrc.results || []).filter((r: any) => r.error_type === 'error' || r.error_type === 'internal_error').reduce((a: number, r: any) => a + r.count, 0);

  const html = buildDigestEmail(totalCount, criticalCount, bySrc.results || [], topEp.results || [], byDomain.results || [], hours);

  const subject = criticalCount > 50
    ? `CRITICAL: ${criticalCount} server errors in last ${hours}h — VNOC`
    : criticalCount > 0
    ? `${totalCount} API errors in last ${hours}h — VNOC`
    : `${totalCount} API events in last ${hours}h — VNOC`;

  const recipients = env.ALERT_RECIPIENTS.split(",").map(e => e.trim()).filter(Boolean);

  if (!env.RESEND_API_KEY) {
    await env.DB.prepare("INSERT INTO alert_history (recipients, total_errors, critical_count, period_hours, status) VALUES (?, ?, ?, 24, 'failed')").bind(env.ALERT_RECIPIENTS, totalCount, criticalCount).run();
    return { success: false, message: "RESEND_API_KEY not configured." };
  }

  try {
    await sendResendEmail(env, recipients, subject, html);
    await env.DB.prepare("INSERT INTO alert_history (recipients, total_errors, critical_count, period_hours, status) VALUES (?, ?, ?, 24, 'sent')").bind(env.ALERT_RECIPIENTS, totalCount, criticalCount).run();
    return { success: true, message: `Digest sent to ${recipients.length} recipients (${totalCount} errors, ${criticalCount} critical)` };
  } catch (err: any) {
    await env.DB.prepare("INSERT INTO alert_history (recipients, total_errors, critical_count, period_hours, status) VALUES (?, ?, ?, 24, 'failed')").bind(env.ALERT_RECIPIENTS, totalCount, criticalCount).run();
    return { success: false, message: `Resend failed: ${err.message}` };
  }
}

async function sendResendEmail(env: Env, to: string[], subject: string, html: string): Promise<void> {
  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: env.RESEND_FROM,
      to,
      subject,
      html,
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Resend ${resp.status}: ${errText.substring(0, 500)}`);
  }
}

// ── Email template ──────────────────────────────────────────────────────────

function buildDigestEmail(total: number, critical: number, bySrc: any[], topEp: any[], byDomain: any[], hours: number): string {
  const srcRows = bySrc.map((r: any) =>
    `<tr><td style="padding:6px 12px;border-bottom:1px solid #334155">${esc(r.api_source)}</td>
     <td style="padding:6px 12px;border-bottom:1px solid #334155"><span style="background:${r.error_type==='error'||r.error_type==='internal_error'?'#dc2626':r.error_type==='404'?'#d97706':'#475569'};color:#fff;padding:2px 6px;border-radius:3px;font-size:11px">${esc(r.error_type)}</span></td>
     <td style="padding:6px 12px;border-bottom:1px solid #334155;font-weight:700;text-align:right">${r.count}</td></tr>`
  ).join("");

  const epRows = topEp.slice(0, 15).map((r: any) =>
    `<tr><td style="padding:4px 10px;border-bottom:1px solid #e2e8f0;font-size:12px">${esc(r.api_source)}</td>
     <td style="padding:4px 10px;border-bottom:1px solid #e2e8f0;font-size:12px">${esc(r.endpoint)}</td>
     <td style="padding:4px 10px;border-bottom:1px solid #e2e8f0;font-size:12px">${esc(r.error_type)}</td>
     <td style="padding:4px 10px;border-bottom:1px solid #e2e8f0;font-weight:700;text-align:right;font-size:12px">${r.count}</td></tr>`
  ).join("");

  const domainRows = byDomain.slice(0, 10).map((r: any) =>
    `<tr><td style="padding:4px 10px;border-bottom:1px solid #e2e8f0;font-size:12px">${esc(r.domain)}</td>
     <td style="padding:4px 10px;border-bottom:1px solid #e2e8f0;font-weight:700;text-align:right;font-size:12px">${r.count}</td></tr>`
  ).join("");

  const statusColor = critical > 50 ? "#dc2626" : critical > 0 ? "#d97706" : "#22c55e";
  const statusLabel = critical > 50 ? "CRITICAL" : critical > 0 ? "WARNING" : "HEALTHY";

  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f8fafc;padding:20px;color:#1e293b">
<div style="max-width:650px;margin:0 auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1)">

<div style="background:linear-gradient(135deg,#1e293b,#334155);padding:20px 24px;color:#f8fafc">
  <img src="https://www.vnoc.com/images/logo/logo-vnoc-with-ecorp-forwhite.svg" alt="VNOC" style="height:30px;margin-bottom:8px">
  <div style="font-size:20px;font-weight:700">VNOC Error Hub</div>
  <div style="color:#94a3b8;font-size:13px;margin-top:4px">Daily Digest — ${new Date().toLocaleDateString("en-US",{weekday:"long",year:"numeric",month:"long",day:"numeric"})}</div>
</div>

<div style="padding:20px 24px">
  <div style="display:flex;gap:12px;margin-bottom:20px">
    <div style="flex:1;background:#f1f5f9;border-radius:8px;padding:14px;text-align:center">
      <div style="color:#64748b;font-size:11px;text-transform:uppercase">Status</div>
      <div style="font-size:18px;font-weight:700;color:${statusColor};margin-top:2px">${statusLabel}</div>
    </div>
    <div style="flex:1;background:#f1f5f9;border-radius:8px;padding:14px;text-align:center">
      <div style="color:#64748b;font-size:11px;text-transform:uppercase">Total (${hours}h)</div>
      <div style="font-size:22px;font-weight:700;margin-top:2px">${total}</div>
    </div>
    <div style="flex:1;background:#fef2f2;border-radius:8px;padding:14px;text-align:center">
      <div style="color:#64748b;font-size:11px;text-transform:uppercase">Critical</div>
      <div style="font-size:22px;font-weight:700;color:#dc2626;margin-top:2px">${critical}</div>
    </div>
  </div>

  <h3 style="font-size:14px;color:#475569;margin:16px 0 8px;text-transform:uppercase;letter-spacing:0.5px">Errors by Source</h3>
  <table style="width:100%;border-collapse:collapse;background:#f8fafc;border-radius:6px">
    <tr style="background:#e2e8f0"><th style="padding:6px 12px;text-align:left;font-size:11px">Source</th><th style="padding:6px 12px;text-align:left;font-size:11px">Type</th><th style="padding:6px 12px;text-align:right;font-size:11px">Count</th></tr>
    ${srcRows || '<tr><td colspan="3" style="padding:12px;text-align:center;color:#94a3b8">No errors</td></tr>'}
  </table>

  <h3 style="font-size:14px;color:#475569;margin:20px 0 8px;text-transform:uppercase;letter-spacing:0.5px">Top Error Endpoints</h3>
  <table style="width:100%;border-collapse:collapse;background:#f8fafc;border-radius:6px">
    <tr style="background:#e2e8f0"><th style="padding:4px 10px;text-align:left;font-size:11px">Source</th><th style="padding:4px 10px;text-align:left;font-size:11px">Endpoint</th><th style="padding:4px 10px;text-align:left;font-size:11px">Type</th><th style="padding:4px 10px;text-align:right;font-size:11px">Hits</th></tr>
    ${epRows || '<tr><td colspan="4" style="padding:12px;text-align:center;color:#94a3b8">No data</td></tr>'}
  </table>

  ${domainRows ? `
  <h3 style="font-size:14px;color:#475569;margin:20px 0 8px;text-transform:uppercase;letter-spacing:0.5px">Top Domains with Errors</h3>
  <table style="width:100%;border-collapse:collapse;background:#f8fafc;border-radius:6px">
    <tr style="background:#e2e8f0"><th style="padding:4px 10px;text-align:left;font-size:11px">Domain</th><th style="padding:4px 10px;text-align:right;font-size:11px">Errors</th></tr>
    ${domainRows}
  </table>` : ''}

  <div style="margin-top:24px;padding-top:16px;border-top:1px solid #e2e8f0;text-align:center">
    <a href="https://log.vnoc.com" style="display:inline-block;background:#3b82f6;color:#fff;padding:10px 24px;border-radius:6px;text-decoration:none;font-weight:600;font-size:14px">View Full Dashboard</a>
  </div>
</div>

<div style="background:#f1f5f9;padding:12px 24px;color:#94a3b8;font-size:11px;text-align:center">
  VNOC Error Hub — log.vnoc.com — This is an automated daily digest.
</div>
</div></body></html>`;
}

function esc(s: any): string { return String(s || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }

// ── GET /agent — Error Log Agent Chat Page ─────────────────────────────────

function handleAgentPage(): Response {
  return new Response(agentHTML(), {
    headers: { "Content-Type": "text/html; charset=utf-8", ...CORS },
  });
}

function agentHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Error Log Agent — VNOC</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🤖</text></svg>">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0f172a;color:#e2e8f0;height:100vh;display:flex;flex-direction:column}
.hdr{background:linear-gradient(135deg,#1e293b,#334155);padding:12px 20px;border-bottom:1px solid #475569;display:flex;align-items:center;gap:10px;flex-shrink:0}
.hdr img{height:24px}
.hdr h1{font-size:16px;font-weight:600;color:#f8fafc}
.hdr .agent-badge{background:linear-gradient(135deg,#7c3aed,#6d28d9);color:#fff;font-size:11px;padding:3px 10px;border-radius:12px;font-weight:600;display:flex;align-items:center;gap:4px}
.hdr .agent-badge .dot{width:6px;height:6px;background:#22c55e;border-radius:50%;animation:pulse 2s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
.hdr .rt{margin-left:auto;display:flex;gap:8px;align-items:center}
.hdr a{color:#94a3b8;text-decoration:none;font-size:12px;padding:4px 10px;border-radius:6px;border:1px solid #334155}
.hdr a:hover{background:#334155;color:#f8fafc}
.hdr select{background:#0f172a;border:1px solid #475569;color:#e2e8f0;padding:4px 8px;border-radius:6px;font-size:12px}

.chat-wrap{flex:1;display:flex;flex-direction:column;max-width:900px;width:100%;margin:0 auto;overflow:hidden}
.messages{flex:1;overflow-y:auto;padding:16px 20px;display:flex;flex-direction:column;gap:12px}
.msg{max-width:85%;padding:12px 16px;border-radius:12px;font-size:14px;line-height:1.65;word-wrap:break-word}
.msg-agent{background:#1e293b;border:1px solid #334155;align-self:flex-start;border-bottom-left-radius:4px}
.msg-user{background:#3b82f6;color:#fff;align-self:flex-end;border-bottom-right-radius:4px}
.msg-agent .sender{font-size:11px;color:#7c3aed;font-weight:600;margin-bottom:4px;display:flex;align-items:center;gap:4px}
.msg-user .sender{font-size:11px;color:rgba(255,255,255,.7);font-weight:600;margin-bottom:4px;text-align:right}
.msg-agent .body{color:#e2e8f0}
.msg-agent .body p{margin-bottom:8px}
.msg-agent .body ul,.msg-agent .body ol{margin:6px 0 8px 18px}
.msg-agent .body li{margin-bottom:3px}
.msg-agent .body code{background:#0f172a;padding:1px 5px;border-radius:3px;font-size:12px;color:#a5b4fc}
.msg-agent .body pre{background:#0f172a;border:1px solid #334155;border-radius:6px;padding:10px;overflow-x:auto;margin:8px 0}
.msg-agent .body pre code{background:none;padding:0}
.msg-agent .body strong{color:#f8fafc}
.msg-agent .body h1,.msg-agent .body h2,.msg-agent .body h3{color:#f8fafc;margin:10px 0 4px;font-size:14px}

.typing{align-self:flex-start;padding:12px 16px;background:#1e293b;border:1px solid #334155;border-radius:12px;border-bottom-left-radius:4px;display:none}
.typing.show{display:block}
.typing-dots{display:flex;gap:4px;align-items:center}
.typing-dots span{width:7px;height:7px;background:#7c3aed;border-radius:50%;animation:blink 1.4s infinite}
.typing-dots span:nth-child(2){animation-delay:.2s}
.typing-dots span:nth-child(3){animation-delay:.4s}
@keyframes blink{0%,100%{opacity:.3}50%{opacity:1}}

.quick-actions{padding:8px 20px;display:flex;gap:6px;flex-wrap:wrap;flex-shrink:0}
.qa-btn{background:#1e293b;border:1px solid #334155;color:#94a3b8;padding:6px 12px;border-radius:8px;cursor:pointer;font-size:12px;transition:all .15s}
.qa-btn:hover{background:#334155;color:#f8fafc;border-color:#475569}

.input-wrap{padding:12px 20px 16px;flex-shrink:0;display:flex;gap:8px;align-items:end}
.input-box{flex:1;display:flex;background:#1e293b;border:1px solid #475569;border-radius:12px;overflow:hidden;transition:border-color .2s}
.input-box:focus-within{border-color:#7c3aed}
.input-box textarea{flex:1;background:none;border:none;color:#e2e8f0;padding:12px 16px;font-size:14px;font-family:inherit;resize:none;outline:none;max-height:120px;min-height:44px;line-height:1.4}
.send-btn{background:#7c3aed;color:#fff;border:none;width:42px;height:42px;border-radius:10px;cursor:pointer;font-size:18px;display:flex;align-items:center;justify-content:center;transition:background .15s;flex-shrink:0}
.send-btn:hover{background:#6d28d9}
.send-btn:disabled{background:#334155;cursor:not-allowed}

.status-bar{padding:6px 20px;background:#0f172a;border-top:1px solid #1e293b;display:flex;align-items:center;gap:8px;flex-shrink:0;font-size:11px;color:#64748b}
.status-bar .dot{width:5px;height:5px;border-radius:50%}
.dot-green{background:#22c55e}.dot-yellow{background:#eab308}.dot-red{background:#ef4444}
</style>
</head>
<body>
<div class="hdr">
  <img src="https://www.vnoc.com/images/logo/logo-vnoc-with-ecorp-forwhite.svg" alt="VNOC" style="height:24px">
  <h1>Error Log Agent</h1>
  <span class="agent-badge"><span class="dot"></span> Online</span>
  <div class="rt">
    <select id="srcFilter" onchange="resetChat()"><option value="">All Sources</option></select>
    <a href="/">Dashboard</a>
    <a href="/install">Install</a>
  </div>
</div>

<div class="chat-wrap">
  <div class="messages" id="messages"></div>
  <div class="typing" id="typing"><div class="typing-dots"><span></span><span></span><span></span></div></div>

  <div class="quick-actions" id="quickActions">
    <button class="qa-btn" onclick="ask('What\\'s the current status? Give me a quick health check of all APIs.')">🔍 Status Check</button>
    <button class="qa-btn" onclick="ask('What are the most critical errors right now? Prioritize what I should fix first.')">🔴 Critical Issues</button>
    <button class="qa-btn" onclick="ask('Are there any error patterns or spikes? What trends do you see?')">📊 Spot Patterns</button>
    <button class="qa-btn" onclick="ask('Which errors are from bots/scanners vs real users? Help me filter the noise.')">🤖 Bot vs Real</button>
    <button class="qa-btn" onclick="ask('Give me a daily briefing — summary of the last 24 hours of errors across all services.')">📋 Daily Briefing</button>
    <button class="qa-btn" onclick="ask('Which API source has the most problems? Break it down.')">🏷️ Worst Source</button>
  </div>

  <div class="input-wrap">
    <div class="input-box">
      <textarea id="input" placeholder="Ask about your errors... (e.g. 'Why is api-contrib1 throwing 404s?')" rows="1" onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();send()}"></textarea>
    </div>
    <button class="send-btn" id="sendBtn" onclick="send()">↑</button>
  </div>

  <div class="status-bar">
    <span class="dot dot-green" id="statusDot"></span>
    <span id="statusText">Loading error data...</span>
  </div>
</div>

<script>
const B=location.origin;
let chatHistory=[];
let sending=false;

async function F(p,o={}){return(await fetch(B+p,o)).json()}

// Load sources dropdown
async function loadSources(){
  try{
    const d=await F('/sources');
    const sel=document.getElementById('srcFilter');
    (d.sources||[]).forEach(r=>{
      const o=document.createElement('option');
      o.value=r.api_source;
      o.textContent=r.api_source+' ('+r.total+')';
      sel.appendChild(o);
    });
    const total=(d.sources||[]).reduce((a,r)=>a+r.total,0);
    const srcCount=(d.sources||[]).length;
    setStatus('green','Connected — '+srcCount+' sources, '+total+' total errors in database');
  }catch(e){
    setStatus('red','Failed to connect to error hub');
  }
}

function setStatus(color,text){
  document.getElementById('statusDot').className='dot dot-'+color;
  document.getElementById('statusText').textContent=text;
}

function addMessage(role,content){
  const div=document.createElement('div');
  div.className='msg msg-'+role;
  if(role==='agent'){
    div.innerHTML='<div class="sender">🤖 Error Log Agent</div><div class="body">'+formatMd(content)+'</div>';
  }else{
    div.innerHTML='<div class="sender">You</div>'+esc(content);
  }
  document.getElementById('messages').appendChild(div);
  scrollBottom();
}

function scrollBottom(){
  const m=document.getElementById('messages');
  m.scrollTop=m.scrollHeight;
}

function formatMd(text){
  // Basic markdown-like formatting
  let html=esc(text);
  // Bold
  html=html.replace(/\\*\\*(.+?)\\*\\*/g,'<strong>$1</strong>');
  // Inline code
  html=html.replace(/\`([^\`]+)\`/g,'<code>$1</code>');
  // Code blocks
  html=html.replace(/\`\`\`([\\s\\S]*?)\`\`\`/g,'<pre><code>$1</code></pre>');
  // Headers
  html=html.replace(/^### (.+)$/gm,'<h3>$1</h3>');
  html=html.replace(/^## (.+)$/gm,'<h2>$1</h2>');
  html=html.replace(/^# (.+)$/gm,'<h1>$1</h1>');
  // Bullet points
  html=html.replace(/^[\\-\\*] (.+)$/gm,'<li>$1</li>');
  html=html.replace(/(<li>.*<\\/li>)/gs,function(m){return '<ul>'+m+'</ul>';});
  // Fix nested ul
  html=html.replace(/<\\/ul>\\s*<ul>/g,'');
  // Numbered lists
  html=html.replace(/^\\d+\\. (.+)$/gm,'<li>$1</li>');
  // Paragraphs
  html=html.replace(/\\n\\n/g,'</p><p>');
  html=html.replace(/\\n/g,'<br>');
  return '<p>'+html+'</p>';
}

function esc(s){if(!s)return'';const d=document.createElement('div');d.textContent=s;return d.innerHTML}

async function send(){
  if(sending)return;
  const input=document.getElementById('input');
  const text=input.value.trim();
  if(!text)return;

  input.value='';
  input.style.height='auto';
  addMessage('user',text);
  chatHistory.push({role:'user',content:text});

  sending=true;
  document.getElementById('sendBtn').disabled=true;
  document.getElementById('typing').classList.add('show');
  setStatus('yellow','Agent is thinking...');
  scrollBottom();

  try{
    const source=document.getElementById('srcFilter').value;
    const r=await F('/agent/chat',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({
        messages:chatHistory,
        source:source||undefined,
        hours:24
      })
    });

    document.getElementById('typing').classList.remove('show');

    if(r.success){
      const reply=r.response;
      chatHistory.push({role:'assistant',content:reply});
      addMessage('agent',reply);
      setStatus('green','Ready');
    }else{
      addMessage('agent','Sorry, I encountered an error: '+(r.error||'Unknown error')+'. Please try again.');
      setStatus('red','Error — try again');
    }
  }catch(e){
    document.getElementById('typing').classList.remove('show');
    addMessage('agent','Failed to reach the agent backend. Is log.vnoc.com running?');
    setStatus('red','Connection failed');
  }

  sending=false;
  document.getElementById('sendBtn').disabled=false;
  input.focus();
}

function ask(text){
  document.getElementById('input').value=text;
  send();
}

function resetChat(){
  chatHistory=[];
  document.getElementById('messages').innerHTML='';
  addWelcome();
}

// Check for URL params (e.g. from dashboard "Analyze" button)
function checkParams(){
  const p=new URLSearchParams(location.search);
  if(p.get('msg')){
    // Pre-populate from dashboard analyze click
    const q='Analyze this specific error:\\n- Source: '+
      (p.get('src')||'?')+'\\n- Type: '+(p.get('type')||'?')+
      '\\n- Endpoint: '+(p.get('method')||'?')+' '+(p.get('ep')||'?')+
      '\\n- Message: '+(p.get('msg')||'?');
    setTimeout(()=>ask(q),500);
    return true;
  }
  return false;
}

function addWelcome(){
  addMessage('agent',\`Hey! I'm your **Error Log Agent**. I have live access to all your API error data across every connected service.

Here's what I can do:
- **Diagnose errors** — explain what went wrong and how to fix it
- **Spot patterns** — find recurring issues, spikes, and correlated failures
- **Prioritize** — tell you what to fix first based on severity and frequency
- **Filter noise** — separate bot/scanner traffic from real user errors

Use the quick action buttons below, or just ask me anything about your errors.\`);
}

// Auto-resize textarea
document.getElementById('input').addEventListener('input',function(){
  this.style.height='auto';
  this.style.height=Math.min(this.scrollHeight,120)+'px';
});

// Init
loadSources().then(()=>{
  addWelcome();
  if(!checkParams()){
    // Auto-status on load
    setTimeout(()=>ask('Give me a quick status check — how are things looking across all APIs right now?'),800);
  }
});
</script>
</body></html>`;
}

// ── GET /install — Setup Page ───────────────────────────────────────────────

function handleInstall(): Response {
  return new Response(installHTML(), {
    headers: { "Content-Type": "text/html; charset=utf-8", ...CORS },
  });
}

function installHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Install — VNOC Error Hub</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🔌</text></svg>">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0f172a;color:#e2e8f0;min-height:100vh}
.hdr{background:linear-gradient(135deg,#1e293b,#334155);padding:16px 24px;border-bottom:1px solid #475569;display:flex;align-items:center;gap:12px}
.hdr h1{font-size:18px;font-weight:600;color:#f8fafc}.hdr a{color:#3b82f6;text-decoration:none;font-size:13px;margin-left:auto}
.cnt{max-width:900px;margin:0 auto;padding:24px}
h2{font-size:22px;font-weight:700;margin-bottom:8px}
p.sub{color:#94a3b8;font-size:14px;margin-bottom:20px}
.step{background:#1e293b;border:1px solid #334155;border-radius:10px;padding:20px;margin-bottom:16px}
.step h3{font-size:15px;color:#f8fafc;margin-bottom:8px;display:flex;align-items:center;gap:8px}
.step h3 .num{background:#3b82f6;color:#fff;width:26px;height:26px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700}
label{color:#94a3b8;font-size:12px;text-transform:uppercase;letter-spacing:.5px;display:block;margin-bottom:4px;margin-top:12px}
input,select{width:100%;background:#0f172a;border:1px solid #475569;color:#e2e8f0;padding:10px 14px;border-radius:8px;font-size:14px;font-family:inherit}
input:focus,select:focus{outline:none;border-color:#3b82f6}
.fw-row{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:8px}
.fw-btn{background:#0f172a;border:2px solid #334155;border-radius:10px;padding:14px;text-align:center;cursor:pointer;transition:all .2s}
.fw-btn:hover{border-color:#475569}.fw-btn.active{border-color:#3b82f6;background:#1e293b}
.fw-btn .icon{font-size:28px;margin-bottom:4px}.fw-btn .name{font-size:13px;font-weight:600;color:#f8fafc}.fw-btn .desc{font-size:11px;color:#64748b;margin-top:2px}
pre{background:#0f172a;border:1px solid #334155;border-radius:8px;padding:16px;overflow-x:auto;font-size:12px;line-height:1.6;color:#e2e8f0;font-family:'SF Mono','Fira Code',monospace;position:relative;margin-top:8px}
.copy-btn{position:absolute;top:8px;right:8px;background:#3b82f6;color:#fff;border:none;padding:4px 10px;border-radius:4px;cursor:pointer;font-size:11px;font-weight:600}
.copy-btn:hover{background:#2563eb}
.code-header{display:flex;justify-content:space-between;align-items:center;margin-top:12px}
.code-header span{color:#64748b;font-size:12px;font-family:monospace}
.tag{display:inline-block;background:#22c55e;color:#fff;font-size:10px;font-weight:600;padding:2px 6px;border-radius:3px;margin-left:6px}
.test-box{background:#064e3b;border:1px solid #059669;border-radius:8px;padding:14px;margin-top:16px}
.test-box h4{color:#22c55e;font-size:13px;margin-bottom:6px}
.test-box code{color:#6ee7b7;font-size:12px}
</style>
</head>
<body>
<div class="hdr">
  <img src="https://www.vnoc.com/images/logo/logo-vnoc-with-ecorp-forwhite.svg" alt="VNOC" style="height:28px">
  <h1>Install Error Hub Client</h1>
  <a href="/">← Back to Dashboard</a>
</div>
<div class="cnt">
  <h2>Add Error Logging in 2 Minutes</h2>
  <p class="sub">Pick your framework, paste the file, and every error from your API automatically flows into log.vnoc.com.</p>

  <div class="step">
    <h3><span class="num">1</span> Project Name</h3>
    <label>API Source Identifier (e.g. api-myproject)</label>
    <input id="projName" placeholder="api-myproject" value="" oninput="gen()">
  </div>

  <div class="step">
    <h3><span class="num">2</span> Framework</h3>
    <div class="fw-row">
      <div class="fw-btn active" onclick="selFw('nextjs',this)">
        <div class="icon">▲</div><div class="name">Next.js</div><div class="desc">App Router (src/lib/)</div>
      </div>
      <div class="fw-btn" onclick="selFw('worker',this)">
        <div class="icon">⚡</div><div class="name">CF Worker</div><div class="desc">Cloudflare Workers</div>
      </div>
      <div class="fw-btn" onclick="selFw('generic',this)">
        <div class="icon">📦</div><div class="name">Generic</div><div class="desc">Any Node / JS runtime</div>
      </div>
    </div>
  </div>

  <div class="step">
    <h3><span class="num">3</span> Copy & Paste <span class="tag">auto-generated</span></h3>
    <div id="output"></div>
  </div>

  <div class="step">
    <h3><span class="num">4</span> Wire Up Your Routes</h3>
    <div id="usage"></div>
  </div>

  <div class="test-box">
    <h4>✅ Test It</h4>
    <p style="color:#d1fae5;font-size:13px;margin-bottom:8px">After deploying, send a test error:</p>
    <code id="testCmd">curl -X POST https://log.vnoc.com/ingest -H "Content-Type: application/json" -d '{"api_source":"api-myproject","errors":[{"error_type":"test","endpoint":"/test","method":"GET","message":"Test error from install page"}]}'</code>
  </div>
</div>

<script>
let fw='nextjs';
function selFw(f,el){fw=f;document.querySelectorAll('.fw-btn').forEach(b=>b.classList.remove('active'));el.classList.add('active');gen()}

function gen(){
const name=document.getElementById('projName').value.trim()||'api-myproject';
document.getElementById('testCmd').textContent='curl -X POST https://log.vnoc.com/ingest -H "Content-Type: application/json" -d \\'{"api_source":"'+name+'","errors":[{"error_type":"test","endpoint":"/test","method":"GET","message":"Test error from install page"}]}\\'';

if(fw==='nextjs'){
document.getElementById('output').innerHTML=codeBlock('src/lib/error-hub.ts',\`const HUB_URL = process.env.ERROR_HUB_URL || "https://log.vnoc.com";
const API_SOURCE = process.env.ERROR_HUB_SOURCE || "\${name}";

interface HubError {
  error_type: string;
  endpoint: string;
  method: string;
  message: string;
  ip?: string;
  user_agent?: string;
  query_params?: string;
  domain?: string;
}

export function sendToHub(entry: HubError): void {
  if (!HUB_URL) return;
  fetch(\\\`\\\${HUB_URL}/ingest\\\`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_source: API_SOURCE, errors: [entry] }),
  }).catch(() => {});
}

export function hubErrorFromRequest(
  req: Request, errorType: string, message: string
): HubError {
  let refDomain = "";
  try {
    const ref = req.headers.get("referer");
    if (ref) refDomain = new URL(ref).hostname;
  } catch {}
  const url = new URL(req.url);
  return {
    error_type: errorType,
    endpoint: url.pathname,
    method: req.method,
    message,
    ip: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "",
    user_agent: (req.headers.get("user-agent") || "").substring(0, 500),
    query_params: url.search.substring(0, 2000),
    domain: refDomain,
  };
}

/** Wraps a route handler with automatic error catching */
export function safe(
  handler: (req: Request, ctx?: any) => Promise<Response>
): (req: Request, ctx?: any) => Promise<Response> {
  return async (req, ctx) => {
    try {
      return await handler(req, ctx);
    } catch (err: any) {
      sendToHub(hubErrorFromRequest(req, "internal_error", err?.message || "Unknown error"));
      console.error("[error]", req.method, new URL(req.url).pathname, err);
      return Response.json(
        { success: false, message: "Internal server error" },
        { status: 500, headers: { "Access-Control-Allow-Origin": "*" } }
      );
    }
  };
}\`);

document.getElementById('usage').innerHTML=\`<p style="color:#94a3b8;font-size:13px;margin-bottom:8px">Import in your route handlers:</p>\`+codeBlock('Example: src/app/api/route.ts',\`import { sendToHub, hubErrorFromRequest, safe } from "@/lib/error-hub";

// Option A: Use the safe() wrapper (recommended)
export const GET = safe(async function GET(req: Request) {
  // your handler code...
  return Response.json({ success: true });
});

// Option B: Manual sendToHub
export async function POST(req: Request) {
  try {
    // your handler code...
    return Response.json({ success: true });
  } catch (err: any) {
    sendToHub(hubErrorFromRequest(req, "internal_error", err.message));
    return Response.json({ success: false }, { status: 500 });
  }
}\`)+\`<p style="color:#94a3b8;font-size:13px;margin-top:12px">Optional: add to <code style="color:#e2e8f0">.env.local</code></p>\`+codeBlock('.env.local',\`ERROR_HUB_URL=https://log.vnoc.com
ERROR_HUB_SOURCE=\${name}\`);

}else if(fw==='worker'){
document.getElementById('output').innerHTML=codeBlock('src/error-hub.ts',\`const HUB_URL = "https://log.vnoc.com";
const API_SOURCE = "\${name}";

interface HubError {
  error_type: string;
  endpoint: string;
  method: string;
  message: string;
  ip?: string;
  user_agent?: string;
  query_params?: string;
  domain?: string;
}

export function sendToHub(entry: HubError): void {
  fetch(\\\`\\\${HUB_URL}/ingest\\\`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_source: API_SOURCE, errors: [entry] }),
  }).catch(() => {});
}

export function hubErrorFromRequest(
  req: Request, errorType: string, message: string
): HubError {
  const url = new URL(req.url);
  let refDomain = "";
  try {
    const ref = req.headers.get("referer");
    if (ref) refDomain = new URL(ref).hostname;
  } catch {}
  return {
    error_type: errorType,
    endpoint: url.pathname,
    method: req.method,
    message,
    ip: req.headers.get("cf-connecting-ip") || "",
    user_agent: (req.headers.get("user-agent") || "").substring(0, 500),
    query_params: url.search.substring(0, 2000),
    domain: refDomain,
  };
}\`);

document.getElementById('usage').innerHTML=\`<p style="color:#94a3b8;font-size:13px;margin-bottom:8px">Import in your worker fetch handler:</p>\`+codeBlock('src/index.ts',\`import { sendToHub, hubErrorFromRequest } from "./error-hub";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      // your routes...
      return new Response("OK");
    } catch (err: any) {
      sendToHub(hubErrorFromRequest(request, "internal_error", err.message));
      return new Response("Internal error", { status: 500 });
    }
  }
};\`);

}else{
document.getElementById('output').innerHTML=codeBlock('lib/error-hub.js',\`const HUB_URL = process.env.ERROR_HUB_URL || "https://log.vnoc.com";
const API_SOURCE = process.env.ERROR_HUB_SOURCE || "\${name}";

async function sendToHub(entry) {
  try {
    await fetch(\\\`\\\${HUB_URL}/ingest\\\`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_source: API_SOURCE, errors: [entry] }),
    });
  } catch {}
}

function hubError(endpoint, method, errorType, message) {
  return { error_type: errorType, endpoint, method, message };
}

module.exports = { sendToHub, hubError };\`);

document.getElementById('usage').innerHTML=\`<p style="color:#94a3b8;font-size:13px;margin-bottom:8px">Import and use:</p>\`+codeBlock('Example usage',\`const { sendToHub, hubError } = require("./lib/error-hub");

// In your error handler:
app.use((err, req, res, next) => {
  sendToHub(hubError(req.path, req.method, "internal_error", err.message));
  res.status(500).json({ error: "Internal server error" });
});\`);
}
}

function codeBlock(file,code){
return '<div class="code-header"><span>'+esc(file)+'</span></div><pre><button class="copy-btn" onclick="copyCode(this)">Copy</button>'+esc(code)+'</pre>';
}
function esc(s){const d=document.createElement('div');d.textContent=s;return d.innerHTML}
function copyCode(btn){const pre=btn.parentElement;const t=pre.textContent.replace('Copy','').trim();navigator.clipboard.writeText(t);btn.textContent='Copied!';setTimeout(()=>btn.textContent='Copy',1500)}

gen();
</script>
</body></html>`;
}

// ── GET / — Dashboard HTML ──────────────────────────────────────────────────

async function handleDashboard(env: Env, req: Request): Promise<Response> {
  return new Response(dashboardHTML(), {
    headers: { "Content-Type": "text/html; charset=utf-8", ...CORS },
  });
}

function dashboardHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>log.vnoc.com — VNOC Error Hub</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>📊</text></svg>">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0f172a;color:#e2e8f0;min-height:100vh}
.hdr{background:linear-gradient(135deg,#1e293b,#334155);padding:16px 24px;border-bottom:1px solid #475569;display:flex;align-items:center;gap:12px}
.hdr h1{font-size:18px;font-weight:600;color:#f8fafc}.hdr .sub{color:#64748b;font-size:13px}
.hdr .badge{background:#ef4444;color:#fff;font-size:11px;padding:2px 8px;border-radius:10px;font-weight:600}
.hdr .rt{margin-left:auto;display:flex;gap:8px;align-items:center}
.cnt{max-width:1440px;margin:0 auto;padding:16px}
.btn{background:#3b82f6;color:#fff;border:none;padding:8px 16px;border-radius:6px;cursor:pointer;font-weight:500;font-size:13px}
.btn:hover{background:#2563eb}
.btn-red{background:#dc2626}.btn-red:hover{background:#b91c1c}
.btn-green{background:#059669}.btn-green:hover{background:#047857}
.btn-ghost{background:#334155}.btn-ghost:hover{background:#475569}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;margin-bottom:16px}
.card{background:#1e293b;border:1px solid #334155;border-radius:8px;padding:14px}
.card .lb{color:#94a3b8;font-size:11px;text-transform:uppercase;letter-spacing:.5px}
.card .val{font-size:26px;font-weight:700;margin-top:2px}
.red{color:#ef4444}.ylw{color:#eab308}.grn{color:#22c55e}.blu{color:#3b82f6}.pur{color:#a855f7}
.fil{display:flex;gap:6px;margin-bottom:12px;flex-wrap:wrap}
.fil select,.fil input{background:#1e293b;border:1px solid #475569;color:#e2e8f0;padding:5px 8px;border-radius:6px;font-size:12px}
.tbl{background:#1e293b;border:1px solid #334155;border-radius:8px;overflow:auto}
table{width:100%;border-collapse:collapse;font-size:12px}
th{background:#334155;color:#94a3b8;text-align:left;padding:8px 10px;font-weight:600;text-transform:uppercase;font-size:10px;letter-spacing:.5px;position:sticky;top:0}
td{padding:6px 10px;border-top:1px solid rgba(71,85,105,.3)}
tr:hover td{background:#334155}
.bt{padding:2px 6px;border-radius:3px;font-size:10px;font-weight:600}
.bt-err{background:#dc2626;color:#fff}.bt-404{background:#d97706;color:#fff}
.bt-auth{background:#7c3aed;color:#fff}.bt-val{background:#0891b2;color:#fff}.bt-unk{background:#475569;color:#fff}
.st{background:#1e40af;color:#93c5fd;padding:2px 6px;border-radius:3px;font-size:10px;font-weight:500}
.pg{display:flex;gap:8px;justify-content:center;padding:12px}
.pg button{background:#334155;color:#e2e8f0;border:none;padding:5px 12px;border-radius:6px;cursor:pointer;font-size:12px}
.pg button:disabled{opacity:.3;cursor:default}
.pg button:not(:disabled):hover{background:#3b82f6}
.empty{text-align:center;padding:30px;color:#64748b}
.chart{display:flex;align-items:end;gap:1px;height:60px;margin-top:6px}
.chart .bar{background:#3b82f6;border-radius:2px 2px 0 0;min-width:4px;flex:1;transition:height .3s}
.chart .bar:hover{background:#60a5fa}
.dom-tags{display:flex;flex-wrap:wrap;gap:4px;margin-top:8px}
.dom-tag{background:#1e293b;border:1px solid #334155;padding:3px 8px;border-radius:4px;font-size:11px;color:#94a3b8}
.dom-tag b{color:#e2e8f0}
#toast{position:fixed;bottom:20px;right:20px;background:#22c55e;color:#fff;padding:10px 20px;border-radius:8px;display:none;font-weight:500;z-index:100;font-size:13px}
.tab-row{display:flex;gap:2px;margin-bottom:12px}.tab-btn{padding:6px 14px;border-radius:6px 6px 0 0;background:#1e293b;color:#94a3b8;border:1px solid #334155;border-bottom:none;cursor:pointer;font-size:12px;font-weight:500}
.tab-btn.active{background:#334155;color:#f8fafc}
.ai-btn{display:inline-block;background:#7c3aed;color:#fff;padding:3px 8px;border-radius:4px;font-size:10px;font-weight:600;white-space:nowrap;text-align:center}
.ai-btn:hover{background:#6d28d9}
</style>
</head>
<body>
<div class="hdr">
  <img src="https://www.vnoc.com/images/logo/logo-vnoc-with-ecorp-forwhite.svg" alt="VNOC" style="height:28px">
  <h1>log.vnoc.com</h1>
  <span class="badge" id="totalBadge">—</span>
  <div class="rt">
    <a href="/agent" class="btn" style="background:#7c3aed;text-decoration:none" title="Chat with the Error Log Agent">🤖 Agent</a>
    <a href="/install" class="btn btn-ghost" title="Add a new project" style="text-decoration:none">🔌 Install</a>
    <button class="btn btn-green" onclick="sendDigest()" title="Send email digest now">📧 Send Digest</button>
    <span class="sub">VNOC Error Hub</span>
  </div>
</div>
<div class="cnt">
  <div id="dash">
    <div class="grid" id="statsRow"></div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
      <div class="card"><div class="lb">Error Volume — Last 24h</div><div class="chart" id="hist"></div></div>
      <div class="card"><div class="lb">Top Domains with Errors</div><div class="dom-tags" id="domTags"></div></div>
    </div>
    <div class="fil">
      <select id="fSrc"><option value="">All Sources</option></select>
      <select id="fType"><option value="">All Types</option><option value="error">error</option><option value="internal_error">internal_error</option><option value="404">404</option><option value="auth">auth</option><option value="validation">validation</option><option value="unknown_controller">unknown_controller</option><option value="unknown_action">unknown_action</option></select>
      <input id="fEp" placeholder="Endpoint...">
      <input id="fDom" placeholder="Domain...">
      <input id="fSearch" placeholder="Search message...">
      <button class="btn" onclick="load()">Filter</button>
      <div class="tab-row" style="margin-left:8px">
        <button class="tab-btn active" id="tabLogs" onclick="switchTab('logs')">Logs</button>
        <button class="tab-btn" id="tabSummary" onclick="switchTab('summary')">Summary</button>
      </div>
      <button class="btn btn-red" onclick="clearL()" style="margin-left:auto">Clear Source</button>
    </div>
    <div class="tbl" style="max-height:500px;overflow:auto"><table><thead id="th"></thead><tbody id="tb"></tbody></table></div>
    <div class="pg"><button id="prevB" onclick="pg(-1)" disabled>&laquo;</button><span id="pgInfo" style="color:#64748b;padding:4px 8px;font-size:12px"></span><button id="nextB" onclick="pg(1)" disabled>&raquo;</button></div>
  </div>
</div>
<div id="toast"></div>
<script>
const B=location.origin;let off=0,tot=0,tab='logs';const L=50;
function toast(m,c='#22c55e'){const t=document.getElementById('toast');t.textContent=m;t.style.background=c;t.style.display='block';setTimeout(()=>t.style.display='none',3000)}
function bc(t){return t==='error'||t==='internal_error'?'bt-err':t==='404'?'bt-404':t==='auth'?'bt-auth':t==='validation'?'bt-val':'bt-unk'}
async function F(p,o={}){return(await fetch(B+p,o)).json()}
async function init(){try{const d=await F('/sources');const s=document.getElementById('fSrc');s.innerHTML='<option value="">All Sources</option>';(d.sources||[]).forEach(r=>{const o=document.createElement('option');o.value=r.api_source;o.textContent=r.api_source+' ('+r.total+')';s.appendChild(o)});await Promise.all([stats(),load()])}catch(e){toast('Failed to load','#ef4444')}}
async function stats(){const src=document.getElementById('fSrc').value;const d=await F('/summary?hours=24'+(src?'&source='+src:''));if(!d.success)return;document.getElementById('totalBadge').textContent=d.total+' errors';
const errs=(d.by_source||[]).filter(r=>r.error_type==='error'||r.error_type==='internal_error').reduce((a,r)=>a+r.count,0);
const nf=(d.by_source||[]).filter(r=>r.error_type==='404'||r.error_type==='unknown_controller'||r.error_type==='unknown_action').reduce((a,r)=>a+r.count,0);
const au=(d.by_source||[]).filter(r=>r.error_type==='auth').reduce((a,r)=>a+r.count,0);
const srcs=new Set((d.by_source||[]).map(r=>r.api_source));
document.getElementById('statsRow').innerHTML='<div class="card"><div class="lb">Total 24h</div><div class="val red">'+d.total+'</div></div><div class="card"><div class="lb">Server Errors</div><div class="val red">'+errs+'</div></div><div class="card"><div class="lb">404 / Unknown</div><div class="val ylw">'+nf+'</div></div><div class="card"><div class="lb">Auth Fails</div><div class="val blu">'+au+'</div></div><div class="card"><div class="lb">Sources</div><div class="val grn">'+srcs.size+'</div></div><div class="card"><div class="lb">Domains</div><div class="val pur">'+(d.by_domain||[]).length+'</div></div>';
const h=d.histogram||[];const mx=Math.max(...h.map(x=>x.count),1);
document.getElementById('hist').innerHTML=h.map(x=>'<div class="bar" style="height:'+Math.max((x.count/mx)*100,4)+'%" title="'+x.hour+': '+x.count+'"></div>').join('');
document.getElementById('domTags').innerHTML=(d.by_domain||[]).slice(0,12).map(r=>'<span class="dom-tag"><b>'+esc(r.domain)+'</b> '+r.count+'</span>').join('')||(('<span class="dom-tag">No domain data</span>'))}
async function load(){if(tab==='summary')return loadSum();const src=document.getElementById('fSrc').value,ty=document.getElementById('fType').value,ep=document.getElementById('fEp').value,dom=document.getElementById('fDom').value,s=document.getElementById('fSearch').value;
let q='?limit='+L+'&offset='+off;if(src)q+='&source='+encodeURIComponent(src);if(ty)q+='&type='+encodeURIComponent(ty);if(ep)q+='&endpoint='+encodeURIComponent(ep);if(dom)q+='&domain='+encodeURIComponent(dom);if(s)q+='&search='+encodeURIComponent(s);
const d=await F('/logs'+q);if(!d.success)return;tot=d.total;
document.getElementById('th').innerHTML='<tr><th>Time</th><th>Source</th><th>Type</th><th>Method</th><th>Endpoint</th><th>Message</th><th>Domain</th><th>IP</th><th style="width:60px">AI</th></tr>';
document.getElementById('tb').innerHTML=(d.logs||[]).map(l=>'<tr><td style="white-space:nowrap;color:#64748b">'+(l.created_at||'').replace('T',' ').substring(0,19)+'</td><td><span class="st">'+esc(l.api_source)+'</span></td><td><span class="bt '+bc(l.error_type)+'">'+esc(l.error_type)+'</span></td><td>'+esc(l.method)+'</td><td style="max-width:200px;overflow:hidden;text-overflow:ellipsis" title="'+esc(l.endpoint)+'">'+esc(l.endpoint)+'</td><td style="max-width:250px;overflow:hidden;text-overflow:ellipsis;color:#94a3b8" title="'+esc(l.message)+'">'+esc(l.message)+'</td><td style="color:#a855f7;font-size:11px">'+esc(l.domain)+'</td><td style="color:#64748b;font-size:11px">'+esc(l.ip)+'</td><td><a class="ai-btn" href="/agent?src='+encodeURIComponent(l.api_source||'')+'&type='+encodeURIComponent(l.error_type||'')+'&ep='+encodeURIComponent(l.endpoint||'')+'&method='+encodeURIComponent(l.method||'')+'&msg='+encodeURIComponent((l.message||'').substring(0,200))+'" target="_blank" style="text-decoration:none">🤖</a></td></tr>').join('')||'<tr><td colspan="9" class="empty">No errors found</td></tr>';
upPg();stats()}
async function loadSum(){const src=document.getElementById('fSrc').value;const d=await F('/summary?hours=24'+(src?'&source='+src:''));if(!d.success)return;
document.getElementById('th').innerHTML='<tr><th>Source</th><th>Endpoint</th><th>Type</th><th>Hits</th><th>Last Seen</th></tr>';
document.getElementById('tb').innerHTML=(d.top_endpoints||[]).map(r=>'<tr><td><span class="st">'+esc(r.api_source)+'</span></td><td>'+esc(r.endpoint)+'</td><td><span class="bt '+bc(r.error_type)+'">'+esc(r.error_type)+'</span></td><td style="font-weight:700">'+r.count+'</td><td style="color:#64748b">'+(r.last_seen||'').replace('T',' ').substring(0,19)+'</td></tr>').join('')||'<tr><td colspan="6" class="empty">No data</td></tr>';
document.getElementById('prevB').disabled=document.getElementById('nextB').disabled=true;document.getElementById('pgInfo').textContent=(d.top_endpoints||[]).length+' grouped endpoints'}
function switchTab(t){tab=t;document.getElementById('tabLogs').className='tab-btn'+(t==='logs'?' active':'');document.getElementById('tabSummary').className='tab-btn'+(t==='summary'?' active':'');off=0;load()}
function upPg(){const p=Math.floor(off/L)+1,tp=Math.ceil(tot/L);document.getElementById('pgInfo').textContent='Page '+p+'/'+tp+' ('+tot+')';document.getElementById('prevB').disabled=off===0;document.getElementById('nextB').disabled=off+L>=tot}
function pg(d){off=Math.max(0,off+d*L);load()}
async function clearL(){const src=document.getElementById('fSrc').value;if(!src){toast('Select a source','#d97706');return}if(!confirm('Clear all logs for '+src+'?'))return;const d=await F('/clear',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({source:src})});if(d.success){toast('Cleared '+d.deleted);off=0;load()}else toast(d.error||'Failed','#ef4444')}
async function sendDigest(){if(!confirm('Send error digest email now?'))return;const d=await F('/send-digest',{method:'POST'});toast(d.message||'Done',d.success?'#22c55e':'#ef4444')}
function esc(s){if(!s)return'';const d=document.createElement('div');d.textContent=s;return d.innerHTML}
init();
</script></body></html>`;
}

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
 *   POST /analyze         — AI-powered error analysis (CF Workers AI)
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
.ai-btn{background:#7c3aed;color:#fff;border:none;padding:3px 8px;border-radius:4px;cursor:pointer;font-size:10px;font-weight:600;white-space:nowrap}
.ai-btn:hover{background:#6d28d9}.ai-btn:disabled{opacity:.5;cursor:wait}
.modal-bg{position:fixed;inset:0;background:rgba(0,0,0,.6);display:none;z-index:200;align-items:center;justify-content:center}
.modal-bg.show{display:flex}
.modal{background:#1e293b;border:1px solid #475569;border-radius:12px;max-width:600px;width:90%;max-height:80vh;overflow:auto;box-shadow:0 20px 60px rgba(0,0,0,.5)}
.modal-hdr{padding:16px 20px;border-bottom:1px solid #334155;display:flex;align-items:center;gap:10px}
.modal-hdr h3{font-size:16px;color:#f8fafc;flex:1}.modal-close{background:none;border:none;color:#94a3b8;font-size:20px;cursor:pointer}
.modal-body{padding:20px}
.ai-section{margin-bottom:16px}
.ai-section h4{font-size:12px;color:#64748b;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px}
.ai-section p{font-size:14px;line-height:1.6;color:#e2e8f0}
.sev-badge{display:inline-block;padding:3px 10px;border-radius:4px;font-size:11px;font-weight:700;text-transform:uppercase}
.sev-critical{background:#dc2626;color:#fff}.sev-high{background:#ea580c;color:#fff}.sev-medium{background:#d97706;color:#fff}.sev-low{background:#059669;color:#fff}
.ai-loading{text-align:center;padding:40px;color:#94a3b8}
.ai-loading .spinner{display:inline-block;width:24px;height:24px;border:3px solid #334155;border-top:3px solid #7c3aed;border-radius:50%;animation:spin 1s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.ai-error-ctx{background:#0f172a;border:1px solid #334155;border-radius:8px;padding:12px;margin-bottom:16px;font-size:12px;color:#94a3b8}
.ai-error-ctx span{color:#e2e8f0}
</style>
</head>
<body>
<div class="hdr">
  <img src="https://www.vnoc.com/images/logo/logo-vnoc-with-ecorp-forwhite.svg" alt="VNOC" style="height:28px">
  <h1>log.vnoc.com</h1>
  <span class="badge" id="totalBadge">—</span>
  <div class="rt">
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
<div class="modal-bg" id="aiModal" onclick="if(event.target===this)closeAI()">
<div class="modal">
<div class="modal-hdr"><span style="font-size:20px">🤖</span><h3>AI Error Analysis</h3><button class="modal-close" onclick="closeAI()">&times;</button></div>
<div class="modal-body" id="aiBody"><div class="ai-loading"><div class="spinner"></div><p style="margin-top:10px">Analyzing error with AI...</p></div></div>
</div></div>
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
document.getElementById('tb').innerHTML=(d.logs||[]).map(l=>'<tr><td style="white-space:nowrap;color:#64748b">'+(l.created_at||'').replace('T',' ').substring(0,19)+'</td><td><span class="st">'+esc(l.api_source)+'</span></td><td><span class="bt '+bc(l.error_type)+'">'+esc(l.error_type)+'</span></td><td>'+esc(l.method)+'</td><td style="max-width:200px;overflow:hidden;text-overflow:ellipsis" title="'+esc(l.endpoint)+'">'+esc(l.endpoint)+'</td><td style="max-width:250px;overflow:hidden;text-overflow:ellipsis;color:#94a3b8" title="'+esc(l.message)+'">'+esc(l.message)+'</td><td style="color:#a855f7;font-size:11px">'+esc(l.domain)+'</td><td style="color:#64748b;font-size:11px">'+esc(l.ip)+'</td><td><button class="ai-btn" onclick="analyzeErr(this)" data-src="'+esc(l.api_source)+'" data-type="'+esc(l.error_type)+'" data-ep="'+esc(l.endpoint)+'" data-method="'+esc(l.method)+'" data-msg="'+esc(l.message)+'" data-ua="'+esc(l.user_agent)+'" data-qp="'+esc(l.query_params)+'">🤖</button></td></tr>').join('')||'<tr><td colspan="9" class="empty">No errors found</td></tr>';
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
async function analyzeErr(btn){
const data={api_source:btn.dataset.src,error_type:btn.dataset.type,endpoint:btn.dataset.ep,method:btn.dataset.method,message:btn.dataset.msg,user_agent:btn.dataset.ua,query_params:btn.dataset.qp};
document.getElementById('aiModal').classList.add('show');
document.getElementById('aiBody').innerHTML='<div class="ai-loading"><div class="spinner"></div><p style="margin-top:10px">Analyzing error with AI...</p></div>';
btn.disabled=true;btn.textContent='...';
try{
const r=await F('/analyze',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
if(r.success&&r.analysis){
const a=r.analysis;const sevClass='sev-'+(a.severity||'medium');
document.getElementById('aiBody').innerHTML=
'<div class="ai-error-ctx"><b>Error:</b> <span>'+esc(data.message)+'</span><br><b>Source:</b> <span>'+esc(data.api_source)+'</span> &middot; <b>Endpoint:</b> <span>'+esc(data.method)+' '+esc(data.endpoint)+'</span> &middot; <b>Type:</b> <span>'+esc(data.error_type)+'</span></div>'+
'<div class="ai-section"><h4>Severity</h4><span class="sev-badge '+sevClass+'">'+esc(a.severity||'medium')+'</span>'+(a.category?' <span style="color:#94a3b8;font-size:12px;margin-left:8px">'+esc(a.category)+'</span>':'')+'</div>'+
'<div class="ai-section"><h4>Diagnosis</h4><p>'+esc(a.diagnosis)+'</p></div>'+
'<div class="ai-section"><h4>Suggested Fix</h4><p>'+esc(a.suggested_fix)+'</p></div>';
}else{
document.getElementById('aiBody').innerHTML='<div class="ai-loading" style="color:#ef4444"><p>'+esc(r.error||'Analysis failed')+'</p></div>';
}
}catch(e){
document.getElementById('aiBody').innerHTML='<div class="ai-loading" style="color:#ef4444"><p>Failed to reach AI: '+esc(e.message)+'</p></div>';
}
btn.disabled=false;btn.textContent='🤖';
}
function closeAI(){document.getElementById('aiModal').classList.remove('show')}
init();
</script></body></html>`;
}

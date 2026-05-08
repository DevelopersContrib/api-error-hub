/**
 * log.vnoc.com — VentureOS Centralized Error Hub
 *
 * Cloudflare Worker + D1 + AWS SES
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
 *
 * Cron: daily at 8 AM UTC → sends digest email via AWS SES
 */

export interface Env {
  DB: D1Database;
  VNOC_API_URL: string;
  VNOC_API_KEY: string;
  SES_REGION: string;
  SES_FROM: string;
  ALERT_RECIPIENTS: string;
  AWS_ACCESS_KEY_ID?: string;
  AWS_SECRET_ACCESS_KEY?: string;
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

// ── POST /send-digest (manual trigger) ──────────────────────────────────────

async function handleManualDigest(env: Env, req: Request): Promise<Response> {
  const result = await sendDailyDigest(env);
  return json(result);
}

// ── AWS SES Email ───────────────────────────────────────────────────────────

async function sendDailyDigest(env: Env): Promise<{ success: boolean; message: string }> {
  const hours = 24;
  const since = new Date(Date.now() - hours * 3600000).toISOString();

  // Get summary data
  const total = await env.DB.prepare("SELECT COUNT(*) as total FROM error_logs WHERE created_at >= ?").bind(since).first<{total:number}>();
  const totalCount = total?.total || 0;

  // Skip if no errors
  if (totalCount === 0) {
    await env.DB.prepare("INSERT INTO alert_history (recipients, total_errors, critical_count, period_hours, status) VALUES (?, 0, 0, 24, 'skipped')").bind(env.ALERT_RECIPIENTS).run();
    return { success: true, message: "No errors in last 24h — skipped" };
  }

  const bySrc = await env.DB.prepare("SELECT api_source, error_type, COUNT(*) as count FROM error_logs WHERE created_at >= ? GROUP BY api_source, error_type ORDER BY count DESC").bind(since).all();
  const topEp = await env.DB.prepare("SELECT api_source, endpoint, error_type, COUNT(*) as count, MAX(created_at) as last_seen FROM error_logs WHERE created_at >= ? GROUP BY api_source, endpoint, error_type ORDER BY count DESC LIMIT 20").bind(since).all();
  const byDomain = await env.DB.prepare("SELECT domain, COUNT(*) as count FROM error_logs WHERE created_at >= ? AND domain != '' GROUP BY domain ORDER BY count DESC LIMIT 15").bind(since).all();

  const criticalCount = (bySrc.results || []).filter((r: any) => r.error_type === 'error' || r.error_type === 'internal_error').reduce((a: number, r: any) => a + r.count, 0);

  // Build HTML email
  const html = buildDigestEmail(totalCount, criticalCount, bySrc.results || [], topEp.results || [], byDomain.results || [], hours);

  const subject = criticalCount > 50
    ? `🔴 CRITICAL: ${criticalCount} server errors in last ${hours}h — VentureOS`
    : criticalCount > 0
    ? `⚠️ ${totalCount} API errors in last ${hours}h — VentureOS`
    : `📊 ${totalCount} API events in last ${hours}h — VentureOS`;

  const recipients = env.ALERT_RECIPIENTS.split(",").map(e => e.trim()).filter(Boolean);

  if (!env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY) {
    await env.DB.prepare("INSERT INTO alert_history (recipients, total_errors, critical_count, period_hours, status) VALUES (?, ?, ?, 24, 'failed')").bind(env.ALERT_RECIPIENTS, totalCount, criticalCount).run();
    return { success: false, message: "AWS SES credentials not configured. Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY as worker secrets." };
  }

  try {
    await sendSESEmail(env, recipients, subject, html);
    await env.DB.prepare("INSERT INTO alert_history (recipients, total_errors, critical_count, period_hours, status) VALUES (?, ?, ?, 24, 'sent')").bind(env.ALERT_RECIPIENTS, totalCount, criticalCount).run();
    return { success: true, message: `Digest sent to ${recipients.length} recipients (${totalCount} errors, ${criticalCount} critical)` };
  } catch (err: any) {
    await env.DB.prepare("INSERT INTO alert_history (recipients, total_errors, critical_count, period_hours, status) VALUES (?, ?, ?, 24, 'failed')").bind(env.ALERT_RECIPIENTS, totalCount, criticalCount).run();
    return { success: false, message: `SES send failed: ${err.message}` };
  }
}

async function sendSESEmail(env: Env, to: string[], subject: string, htmlBody: string): Promise<void> {
  const region = env.SES_REGION || "us-west-2";
  const host = `email.${region}.amazonaws.com`;
  const endpoint = `https://${host}/v2/email/outbound-emails`;

  const body = JSON.stringify({
    FromEmailAddress: env.SES_FROM,
    Destination: { ToAddresses: to },
    Content: {
      Simple: {
        Subject: { Data: subject, Charset: "UTF-8" },
        Body: { Html: { Data: htmlBody, Charset: "UTF-8" } },
      },
    },
  });

  const now = new Date();
  const dateStamp = now.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
  const shortDate = dateStamp.substring(0, 8);

  // AWS Signature V4
  const credentialScope = `${shortDate}/${region}/ses/aws4_request`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Host: host,
    "X-Amz-Date": dateStamp,
  };

  const signedHeaderKeys = Object.keys(headers).sort().map(k => k.toLowerCase());
  const signedHeadersStr = signedHeaderKeys.join(";");

  const canonicalHeaders = signedHeaderKeys.map(k => `${k}:${headers[k.charAt(0).toUpperCase() + k.slice(1)] || headers[k]}`).join("\n") + "\n";

  const payloadHash = await sha256Hex(body);

  const canonicalRequest = [
    "POST",
    "/v2/email/outbound-emails",
    "",
    canonicalHeaders,
    signedHeadersStr,
    payloadHash,
  ].join("\n");

  const stringToSign = [
    "AWS4-HMAC-SHA256",
    dateStamp,
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join("\n");

  const signingKey = await getSignatureKey(env.AWS_SECRET_ACCESS_KEY!, shortDate, region, "ses");
  const signature = await hmacHex(signingKey, stringToSign);

  const authHeader = `AWS4-HMAC-SHA256 Credential=${env.AWS_ACCESS_KEY_ID}/${credentialScope}, SignedHeaders=${signedHeadersStr}, Signature=${signature}`;

  const resp = await fetch(endpoint, {
    method: "POST",
    headers: { ...headers, Authorization: authHeader },
    body,
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`SES ${resp.status}: ${errText.substring(0, 500)}`);
  }
}

// AWS Sig V4 helpers
async function sha256Hex(data: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

async function hmacSha256(key: ArrayBuffer, data: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(data));
}

async function hmacHex(key: ArrayBuffer, data: string): Promise<string> {
  const buf = await hmacSha256(key, data);
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

async function getSignatureKey(secretKey: string, dateStamp: string, region: string, service: string): Promise<ArrayBuffer> {
  let key = await hmacSha256(new TextEncoder().encode("AWS4" + secretKey).buffer as ArrayBuffer, dateStamp);
  key = await hmacSha256(key, region);
  key = await hmacSha256(key, service);
  key = await hmacSha256(key, "aws4_request");
  return key;
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
  <div style="font-size:20px;font-weight:700">VentureOS Error Hub</div>
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
  VentureOS Error Hub — log.vnoc.com — This is an automated daily digest.
</div>
</div></body></html>`;
}

function esc(s: any): string { return String(s || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }

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
<title>log.vnoc.com — VentureOS Error Hub</title>
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
</style>
</head>
<body>
<div class="hdr">
  <svg width="22" height="22" fill="none" viewBox="0 0 24 24"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" stroke="#3b82f6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
  <h1>log.vnoc.com</h1>
  <span class="badge" id="totalBadge">—</span>
  <div class="rt">
    <button class="btn btn-green" onclick="sendDigest()" title="Send email digest now">📧 Send Digest</button>
    <span class="sub">VentureOS Error Hub</span>
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
document.getElementById('th').innerHTML='<tr><th>Time</th><th>Source</th><th>Type</th><th>Method</th><th>Endpoint</th><th>Message</th><th>Domain</th><th>IP</th></tr>';
document.getElementById('tb').innerHTML=(d.logs||[]).map(l=>'<tr><td style="white-space:nowrap;color:#64748b">'+(l.created_at||'').replace('T',' ').substring(0,19)+'</td><td><span class="st">'+esc(l.api_source)+'</span></td><td><span class="bt '+bc(l.error_type)+'">'+esc(l.error_type)+'</span></td><td>'+esc(l.method)+'</td><td style="max-width:200px;overflow:hidden;text-overflow:ellipsis" title="'+esc(l.endpoint)+'">'+esc(l.endpoint)+'</td><td style="max-width:250px;overflow:hidden;text-overflow:ellipsis;color:#94a3b8" title="'+esc(l.message)+'">'+esc(l.message)+'</td><td style="color:#a855f7;font-size:11px">'+esc(l.domain)+'</td><td style="color:#64748b;font-size:11px">'+esc(l.ip)+'</td></tr>').join('')||'<tr><td colspan="8" class="empty">No errors found</td></tr>';
upPg();stats()}
async function loadSum(){const src=document.getElementById('fSrc').value;const d=await F('/summary?hours=24'+(src?'&source='+src:''));if(!d.success)return;
document.getElementById('th').innerHTML='<tr><th>Source</th><th>Endpoint</th><th>Type</th><th>Hits</th><th>Last Seen</th></tr>';
document.getElementById('tb').innerHTML=(d.top_endpoints||[]).map(r=>'<tr><td><span class="st">'+esc(r.api_source)+'</span></td><td>'+esc(r.endpoint)+'</td><td><span class="bt '+bc(r.error_type)+'">'+esc(r.error_type)+'</span></td><td style="font-weight:700">'+r.count+'</td><td style="color:#64748b">'+(r.last_seen||'').replace('T',' ').substring(0,19)+'</td></tr>').join('')||'<tr><td colspan="5" class="empty">No data</td></tr>';
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

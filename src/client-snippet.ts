/**
 * Error Hub Client — drop this into any Next.js API project.
 *
 * Usage:
 *   import { reportError, reportBatch } from '@/lib/error-hub';
 *
 *   // Single error (fire-and-forget)
 *   reportError('api-contrib1', {
 *     error_type: 'internal_error',
 *     endpoint: '/v2/domains/getdomainconfig',
 *     method: 'GET',
 *     message: 'Unknown column d.tawk_widget_id',
 *   });
 *
 *   // Batch (flush buffer)
 *   reportBatch();  // called automatically every 30s or on 50 errors
 *
 * Environment variables needed in each project:
 *   ERROR_HUB_URL=https://api-error-hub.<your-subdomain>.workers.dev
 *   ERROR_HUB_KEY=errhub_k8x2mNqP7vRtYwZs4jL6
 */

const HUB_URL = process.env.ERROR_HUB_URL || "";
const HUB_KEY = process.env.ERROR_HUB_KEY || "";
const API_SOURCE = process.env.ERROR_HUB_SOURCE || "unknown";

interface ErrorEntry {
  error_type?: string;
  endpoint?: string;
  method?: string;
  message?: string;
  ip?: string;
  user_agent?: string;
  query_params?: string;
  domain?: string;
}

// Buffer for batching
let buffer: ErrorEntry[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Queue a single error for batched delivery.
 */
export function reportError(source: string, entry: ErrorEntry): void {
  if (!HUB_URL) return; // Hub not configured — skip silently
  buffer.push(entry);
  // Auto-flush at 50 or start a 30s timer
  if (buffer.length >= 50) {
    flush(source);
  } else if (!flushTimer) {
    flushTimer = setTimeout(() => flush(source), 30_000);
  }
}

/**
 * Immediately send all buffered errors.
 */
export function reportBatch(source?: string): void {
  flush(source || API_SOURCE);
}

function flush(source: string): void {
  if (!buffer.length || !HUB_URL) return;
  const errors = [...buffer];
  buffer = [];
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }

  // Fire-and-forget POST
  fetch(`${HUB_URL}/ingest`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": HUB_KEY,
    },
    body: JSON.stringify({ api_source: source, errors }),
  }).catch(() => {
    // Silently drop — don't let error reporting cause more errors
  });
}

/**
 * Helper: extract error info from a Request object.
 */
export function errorFromRequest(
  req: Request,
  errorType: string,
  message: string,
): ErrorEntry {
  const url = new URL(req.url);
  return {
    error_type: errorType,
    endpoint: url.pathname,
    method: req.method,
    message,
    ip: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "",
    user_agent: (req.headers.get("user-agent") || "").substring(0, 500),
    query_params: url.search.substring(0, 2000),
    domain: req.headers.get("referer") ? new URL(req.headers.get("referer")!).hostname : "",
  };
}

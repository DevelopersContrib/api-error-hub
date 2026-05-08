-- API Error Hub — D1 schema
-- Centralized error log for all API projects (log.vnoc.com)

CREATE TABLE IF NOT EXISTS error_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  api_source TEXT NOT NULL,              -- 'api-contrib1', 'api-contrib2', 'api-contentagent', etc.
  error_type TEXT NOT NULL DEFAULT 'error', -- 'error', '404', 'auth', 'validation', 'unknown_controller', 'unknown_action'
  endpoint TEXT NOT NULL DEFAULT '',      -- '/v2/domains/getdomainconfig'
  method TEXT NOT NULL DEFAULT 'GET',
  message TEXT DEFAULT '',
  ip TEXT DEFAULT '',
  user_agent TEXT DEFAULT '',
  query_params TEXT DEFAULT '',
  domain TEXT DEFAULT '',                -- requesting domain (from referer or param)
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_source ON error_logs(api_source);
CREATE INDEX IF NOT EXISTS idx_type ON error_logs(error_type);
CREATE INDEX IF NOT EXISTS idx_created ON error_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_source_type ON error_logs(api_source, error_type);
CREATE INDEX IF NOT EXISTS idx_endpoint ON error_logs(endpoint);
CREATE INDEX IF NOT EXISTS idx_domain ON error_logs(domain);

-- Alert history — track when digest emails were sent
CREATE TABLE IF NOT EXISTS alert_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sent_at TEXT DEFAULT (datetime('now')),
  recipients TEXT NOT NULL,
  total_errors INTEGER NOT NULL DEFAULT 0,
  critical_count INTEGER NOT NULL DEFAULT 0,
  period_hours INTEGER NOT NULL DEFAULT 24,
  status TEXT NOT NULL DEFAULT 'sent'     -- 'sent', 'failed', 'skipped'
);

CREATE INDEX IF NOT EXISTS idx_alert_sent ON alert_history(sent_at);

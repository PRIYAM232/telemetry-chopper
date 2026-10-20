-- Test rules for the Datadog harness, added beside the seed's three trace
-- rules (drop http.status_code=404, drop http.route~/healthz, sample
-- service.name=checkout-service). Fixed ids and spaced createdAt pin the
-- evaluation order; re-running replaces them.
DELETE FROM "PolicyRule" WHERE id::text LIKE 'dd000000-%';
INSERT INTO "PolicyRule"
  (id, "fleetId", name, "actionType", "targetSignal", "conditionField", "conditionOp", "conditionValue", "targetDestination", "createdAt", "updatedAt")
VALUES
  ('dd000000-0000-4000-8000-000000000001', 'f1ee7000-0000-4000-8000-000000000001', 'dd-drop-debug-logs',      'DROP',          'LOGS',    'log.severity', 'EQUALS',      'DEBUG',               NULL,           now() + interval '1 s', now()),
  ('dd000000-0000-4000-8000-000000000002', 'f1ee7000-0000-4000-8000-000000000001', 'dd-redact-emails',        'REDACT',        'LOGS',    'user.email',   'REGEX_MATCH', '[^@\s]+@[^@\s]+',     NULL,           now() + interval '2 s', now()),
  ('dd000000-0000-4000-8000-000000000003', 'f1ee7000-0000-4000-8000-000000000001', 'dd-exclude-healthz-logs', 'EXCLUDE_INDEX', 'LOGS',    'http.route',   'CONTAINS',    '/healthz',            NULL,           now() + interval '3 s', now()),
  ('dd000000-0000-4000-8000-000000000004', 'f1ee7000-0000-4000-8000-000000000001', 'dd-route-archive-logs',   'ROUTE',         'LOGS',    'tier',         'EQUALS',      'archive',             'cold-storage', now() + interval '4 s', now()),
  ('dd000000-0000-4000-8000-000000000005', 'f1ee7000-0000-4000-8000-000000000001', 'dd-drop-noise-metric',    'DROP',          'METRICS', 'metric.name',  'EQUALS',      'chopper.test.noise',  NULL,           now() + interval '5 s', now()),
  -- Spans from Datadog tracing libraries (send-ddtrace). The datadog receiver
  -- renames Datadog tags to OTel names, so http.status_code arrives as
  -- http.response.status_code and the seed's 404 rule doesn't match it.
  ('dd000000-0000-4000-8000-000000000006', 'f1ee7000-0000-4000-8000-000000000001', 'dd-redact-span-emails',   'REDACT',        'TRACES',  'user.email',   'REGEX_MATCH', '[^@\s]+@[^@\s]+',     NULL,           now() + interval '6 s', now()),
  ('dd000000-0000-4000-8000-000000000007', 'f1ee7000-0000-4000-8000-000000000001', 'dd-drop-404-spans',       'DROP',          'TRACES',  'http.response.status_code', 'EQUALS', '404',         NULL,           now() + interval '7 s', now());

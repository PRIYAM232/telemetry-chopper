#!/usr/bin/env python3
"""Send one labelled batch of test telemetry to the harness collector.

Every record carries chopper.test.run=<run id>, so each class can be counted
exactly in Datadog. Usage: send.py [run-id]  (default: current epoch secs).
"""
import json, os, random, sys, time, urllib.request

ENDPOINT = os.environ.get("CHOPPER_OTLP_HTTP", "http://127.0.0.1:14428")
RUN = (sys.argv[1] if len(sys.argv) > 1 else "") or str(int(time.time()))
SERVICE = "chopper-dd-test"
N = 20


def attrs(d):
    return [{"key": k, "value": {"stringValue": str(v)}} for k, v in d.items()]


def resource(extra=None):
    return {"attributes": attrs({"service.name": SERVICE, "deployment.environment": "chopper-test", **(extra or {})})}


def post(path, body):
    req = urllib.request.Request(ENDPOINT + path, json.dumps(body).encode(), {"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=10) as r:
        r.read()


def now_ns():
    return str(time.time_ns())


def logs(case, severity, number, body, extra, res_extra=None):
    records = [{
        "timeUnixNano": now_ns(), "severityText": severity, "severityNumber": number,
        "body": {"stringValue": body},
        "attributes": attrs({"chopper.test.run": RUN, "chopper.test.case": case, **extra}),
    } for _ in range(N)]
    post("/v1/logs", {"resourceLogs": [{"resource": resource(res_extra), "scopeLogs": [{"logRecords": records}]}]})


def traces(case, route, status):
    spans = []
    for _ in range(N):
        start = time.time_ns()
        spans.append({
            "traceId": "%032x" % random.getrandbits(128), "spanId": "%016x" % random.getrandbits(64),
            "name": "GET " + route, "kind": 2,
            "startTimeUnixNano": str(start), "endTimeUnixNano": str(start + 25_000_000),
            "attributes": attrs({"chopper.test.run": RUN, "chopper.test.case": case,
                                 "http.route": route, "http.status_code": status, "http.method": "GET"}),
        })
    post("/v1/traces", {"resourceSpans": [{"resource": resource(), "scopeSpans": [{"spans": spans}]}]})


def metrics():
    def gauge(name):
        return {"name": name, "gauge": {"dataPoints": [{
            "timeUnixNano": now_ns(), "asInt": "1",
            "attributes": attrs({"chopper.test.run": RUN})}]}}
    post("/v1/metrics", {"resourceMetrics": [{"resource": resource(), "scopeMetrics": [{"metrics": [
        gauge("chopper.test.kept"), gauge("chopper.test.noise")]}]}]})


logs("info-kept", "INFO", 9, "order placed", {})
logs("debug-dropped", "DEBUG", 5, "cache lookup", {})
logs("email-redacted", "INFO", 9, "user signed in", {"user.email": "alice@example.com"})
logs("healthz-unindexed", "INFO", 9, "GET /healthz 200", {"http.route": "/healthz"})
logs("archive-routed", "INFO", 9, "audit record", {}, {"tier": "archive"})
traces("checkout-kept", "/checkout", "200")
traces("healthz-dropped", "/healthz", "200")
traces("notfound-dropped", "/missing", "404")
metrics()
print(RUN)

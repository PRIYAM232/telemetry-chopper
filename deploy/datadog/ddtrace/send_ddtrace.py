"""Send labelled traces with Datadog's own tracing library (ddtrace) to the
collector's Datadog receiver. Usage: send_ddtrace.py [run-id]

Each case is 5 traces of a flask.request root span and a postgres.query
child, tagged chopper.test.run / chopper.test.case:
  dd-checkout-kept    no rule
  dd-healthz-dropped  root dropped by the seed's http.route ~ /healthz rule
  dd-notfound         root dropped by dd-drop-404-spans
  dd-email-redacted   user.email masked by dd-redact-span-emails
  dd-p0-userreject    manual.drop: the Datadog Agent drops the whole trace
"""
import os, sys, time
from ddtrace.trace import tracer

RUN = (sys.argv[1] if len(sys.argv) > 1 else "") or str(int(time.time()))
SERVICE = "chopper-dd-tracer"
N = 5

def request(case, route, status, email=None, drop=False):
    for _ in range(N):
        with tracer.trace("flask.request", service=SERVICE, resource="GET " + route, span_type="web") as span:
            span.set_tag("span.kind", "server")
            span.set_tag("http.method", "GET")
            span.set_tag("http.route", route)
            span.set_tag("http.status_code", str(status))
            span.set_tag("chopper.test.run", RUN)
            span.set_tag("chopper.test.case", case)
            if email:
                span.set_tag("user.email", email)
            if drop:
                span.set_tag("manual.drop")
            with tracer.trace("postgres.query", service=SERVICE + "-db", resource="SELECT * FROM orders", span_type="sql") as db:
                db.set_tag("span.kind", "client")
                db.set_tag("db.system", "postgresql")  # as ddtrace's psycopg integration does
                db.set_tag("chopper.test.run", RUN)
                db.set_tag("chopper.test.case", case)
                time.sleep(0.002)

request("dd-checkout-kept", "/checkout", 200)
request("dd-healthz-dropped", "/healthz", 200)
request("dd-notfound", "/missing", 404)
request("dd-email-redacted", "/account", 200, email="alice@example.com")
request("dd-p0-userreject", "/checkout", 200, drop=True)
tracer.flush()
tracer.shutdown()
print(RUN)

"""Exercise the Datadog features besides tracing through the collector's
Agent passthrough. Usage: send_ddextras.py [run-id]

Starts ddtrace the way ddtrace-run does (import ddtrace.auto), with
DD_TRACE_AGENT_URL pointing at the collector, and runs for about 25 seconds:
  - Continuous Profiler: CPU and heap profiles every 10 seconds
  - Data Streams Monitoring: produce/consume checkpoints on a test topic
  - remote configuration: the tracer polls /v0.7/config every second
  - instrumentation telemetry: app-started, heartbeats, app-closing
  - 5 traces (case dd-extras-kept), to show traces still go through the rules
Prints the endpoints the tracer found in the collector's /info.
"""
import os, sys, time

os.environ.setdefault("DD_SERVICE", "chopper-dd-extras")
os.environ.setdefault("DD_PROFILING_ENABLED", "true")
os.environ.setdefault("DD_PROFILING_UPLOAD_INTERVAL", "10")
os.environ.setdefault("DD_DATA_STREAMS_ENABLED", "true")
os.environ.setdefault("DD_REMOTE_CONFIG_POLL_INTERVAL_SECONDS", "1")
os.environ.setdefault("DD_TELEMETRY_HEARTBEAT_INTERVAL", "5")

import ddtrace.auto  # noqa: F401  (what ddtrace-run does)
from ddtrace.trace import tracer
from ddtrace.data_streams import set_consume_checkpoint, set_produce_checkpoint
from ddtrace.internal import agent

RUN = (sys.argv[1] if len(sys.argv) > 1 else "") or str(int(time.time()))

info = agent.info() or {}
print("tracer sees /info endpoints:", " ".join(info.get("endpoints", [])), flush=True)

for i in range(5):
    with tracer.trace("worker.job", resource="process order", span_type="worker") as span:
        span.set_tag("chopper.test.run", RUN)
        span.set_tag("chopper.test.case", "dd-extras-kept")

deadline = time.time() + 25
n = 0
while time.time() < deadline:
    headers = {}
    set_produce_checkpoint("kafka", "chopper-dd-orders", headers.setdefault)
    set_consume_checkpoint("kafka", "chopper-dd-orders", headers.get)
    sum(i * i for i in range(200_000))  # something for the CPU profile
    n += 1
    time.sleep(0.5)

tracer.flush()
print(f"{RUN}: {n} DSM checkpoint pairs", flush=True)
# ddtrace's exit hooks upload the last profile and send app-closing telemetry.

# Senders for run.sh send-ddtrace and send-ddextras: Datadog's Python
# tracing library, pinned.
FROM python:3.12-slim
RUN pip install --no-cache-dir ddtrace==4.16.0
COPY send_ddtrace.py send_ddextras.py /
ENTRYPOINT ["python", "/send_ddtrace.py"]

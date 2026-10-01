# Stats reporting API

Collectors report what they processed to the control plane with the stats API. `otelcol-chopper` calls it automatically every 10 seconds. This reference is for building your own integration or troubleshooting heartbeats.

## Report stats

```http
POST /api/v1/telemetry/{fleetId}/stats
Authorization: Bearer <fleet API key>
Content-Type: application/json
```

Each request reports one interval: the counts since the collector's previous successful report. The control plane stores each report and sums reports to build the dashboard. A report with every count at zero is valid; it tells the dashboard the collector is online.

### Path parameters

| Parameter | Description |
|---|---|
| `fleetId` | The fleet's ID (a UUID). |

### Request body

Every field is optional. A missing field counts as `0`. Counts must be non-negative integers.

| Field | Description |
|---|---|
| `traces_received`, `logs_received`, `metrics_received` | Records received this interval |
| `traces_dropped`, `logs_dropped`, `metrics_dropped` | Records removed by rules |
| `traces_dropped_bytes`, `logs_dropped_bytes`, `metrics_dropped_bytes` | OTLP protobuf bytes of the removed records |
| `traces_forwarded_bytes`, `logs_forwarded_bytes`, `metrics_forwarded_bytes` | OTLP protobuf bytes passed downstream |
| `traces_unindexed`, `logs_unindexed` | Records forwarded with `chopper.index = false` |
| `rules` | Per-rule counts for this interval (see below). Include only rules with activity. |

Each entry in `rules`:

| Field | Description |
|---|---|
| `rule_id` | The rule's ID |
| `matched` | Records whose condition this rule matched |
| `dropped` | Records this rule removed |
| `dropped_bytes` | OTLP protobuf bytes of those records |
| `unindexed` | Records this rule kept out of the index |

Entries for rules that don't belong to the fleet, such as a rule deleted since the collector's last sync, are ignored.

### Example

```json
{
  "traces_received": 5120,
  "traces_dropped": 640,
  "traces_dropped_bytes": 73400,
  "traces_forwarded_bytes": 512000,
  "logs_received": 2048,
  "logs_dropped": 1024,
  "logs_dropped_bytes": 281600,
  "logs_forwarded_bytes": 290000,
  "rules": [
    { "rule_id": "0a000000-0000-4000-8000-000000000001", "matched": 640, "dropped": 640, "dropped_bytes": 73400, "unindexed": 0 },
    { "rule_id": "0d000000-0000-4000-8000-000000000003", "matched": 1536, "dropped": 1024, "dropped_bytes": 281600, "unindexed": 0 }
  ]
}
```

### Responses

| Status | Meaning |
|---|---|
| `204 No Content` | The report was stored. |
| `400 Bad Request` | The body isn't JSON, a count is negative or not an integer, `rules` is malformed, or `fleetId` isn't a UUID. |
| `401 Unauthorized` | The API key is missing or doesn't belong to the fleet. |

If a report fails, the collector keeps its counts and adds them to the next report, so no counts are lost during an outage.

## Compatibility

Fields were added over several releases. A collector that omits newer fields is still accepted; its missing values count as `0`, and the dashboard notes where data is incomplete, for example drops that can't be priced. A control plane ignores fields it doesn't recognize, so you can upgrade collectors and the control plane in either order.

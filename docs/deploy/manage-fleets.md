# Create fleets and rotate fleet keys

A **fleet** is a group of collectors that share one set of rules and one **fleet key**. Collectors send the key with every policy poll and heartbeat, and the control plane rejects requests without a valid key. Manage fleets on the **Fleets** page.

Use a separate fleet for each group of collectors that should run different rules, such as each environment or region. Each fleet has its own rules, pricing settings and savings.

## Create a fleet

1. Open **Fleets** in the top bar.
2. Under **Create a fleet**, enter a **Name** and, optionally, a **Description**. Names must be unique.
3. Click **Create fleet**.
4. Copy the key from the yellow panel. It's shown only this once: the control plane stores a hash of it, not the key itself. If you lose it, [rotate the key](#rotate-a-fleet-key) to get a new one.
5. Click **I've saved the key**.

The panel also shows a `chopper_filter` configuration for the new fleet. Give it to the fleet's collectors, with the key in the `CHOPPER_FLEET_KEY` environment variable:

```yaml
processors:
  chopper_filter:
    sync_endpoint: http://<control-plane>:3000/api/v1/policies/<fleet-id>
    stats_endpoint: http://<control-plane>:3000/api/v1/telemetry/<fleet-id>/stats
    fleet_key: ${env:CHOPPER_FLEET_KEY}
```

The panel fills in the address you opened the console at. Replace it if your collectors reach the control plane at a different address, such as an internal service name.

With the Helm chart, set the fleet ID and key as chart values instead:

```bash
helm upgrade chopper deploy/helm/telemetry-chopper -n chopper --reuse-values \
  --set fleet.id=<fleet-id> --set fleet.key=<fleet-key>
```

## Choose which fleet the console shows

When there's more than one fleet, the fleet name at the top of the **Dashboard** and **Pricing** pages becomes a menu. Pick a fleet to switch both pages to it. Your choice is remembered in this browser. Until you pick one, the console shows the oldest fleet.

## Rotate a fleet key

Rotate a key when it may have leaked, when someone who had it leaves, or on a regular schedule.

1. On the **Fleets** page, click **Rotate key** on the fleet.
2. Under **Current key stops working**, choose how long collectors can keep using the current key:
   - **After 24 hours** (the default), **After 1 hour** or **After 7 days**: time to move every collector to the new key before the old one stops working.
   - **Immediately**: if the current key may have leaked.
3. Click **Rotate key**, then copy the new key from the yellow panel. Like a new fleet's key, it's shown only once.
4. Give the new key to each of the fleet's collectors, and restart them so they read it.

While the previous key still works, the fleet shows when it stops working and how many online collectors still use it, for example **1 of 3 online collectors still use it**. Each collector moves off the list with its first heartbeat that uses the new key.

When no online collector uses the previous key, click **Revoke now** to stop accepting it before its time runs out.

Only one previous key works at a time. If you rotate again before the previous key stops working, the previous key stops working at once, and the key you just replaced takes its place.

### What a collector does when its key stops working

A collector whose key no longer works keeps enforcing the last rules it received, but it can't receive rule changes until it has a valid key. Its log shows:

```
chopper_filter policy sync: unexpected status, keeping last known-good rules  {"status": 401}
chopper_filter stats report failed, counts carry over to next interval
```

Its stats aren't lost straight away: the collector keeps counting in memory and sends the totals with its next successful report. Restarting it to give it the new key discards those counts, though, so the dashboard misses the traffic from that gap. Rotating with a grace period avoids the gap.

## Replace the development fleet's key

The Docker Compose quick start, the sandbox, the pilot rehearsal and the Helm chart (with `migrator.seed=true`, the default) create a fleet named `local-dev-fleet`. Its key is published in this repository, so anyone can use it. Before collectors carry real telemetry, either rotate that fleet's key with **Immediately**, or create a new fleet and point your collectors at it.

The seed step that creates `local-dev-fleet` runs every time these stacks start or upgrade. It only creates the fleet when it doesn't exist, so it never changes a rotated key, or the fleet's rules, back.

## Audit log entries

The [audit log](sign-in-and-operators.md#review-the-audit-log) records **Created fleet**, **Rotated fleet key** and **Revoked previous fleet key**, with who did it and when. Entries show only the last four characters of a key.

## FAQ

### Can I see a fleet key again?

No. The control plane stores only a hash of each key, so it can't show a key after the first time. To get a usable key again, rotate it.

### Do I have to change my collectors when upgrading to this release?

No. Existing keys keep working. The upgrade replaces each stored key with its hash, so collectors authenticate exactly as before.

### Can several fleets share a key?

No. Every fleet has its own key, and a key only works for its own fleet's policy and stats endpoints.

# Data usage history

This feature adds optional reporting tables and read-only controller queries. It does not change portal authentication, voucher redemption, gateway processing, package limits or wallet accounting. Complimentary rewards use the existing manual grant action.

## Install and enable

1. Pull `master` on the application server.
2. Run `npm run usage:migrate`. This applies only `024_usage_history.sql`, without replaying earlier migrations. It is safe to rerun.
3. Run `npm run usage:check` on that server. It prints the controller version, whether history recording is enabled, row field names and parser compatibility. It does not print tokens, secrets, customer names or MAC addresses, and does not change controller settings.
4. Restart only the WiFi process: `npx pm2 restart smallgarden-wifi`.
5. As owner/platform administrator, open **Data usage → Usage history** and enable each desired site. Every site starts paused. The worker runs without an open browser, beginning within about one minute.

Verify the first customer's download/upload totals against the controller before using the report for rewards. The public manufacturer OpenAPI was checked during implementation; the deployed controller version and permissions still need the on-server check. Older controllers can omit history endpoints or expose different fields. Such results remain visibly incomplete instead of being treated as zero usage.

For Omada v6, controller settings include **Global View → Settings → History Data Retention → Clients’ History Data**. Enable adequate retention in the controller if history is required. The app never changes this setting. Earlier controller versions may place these controls elsewhere. Pause and enable collection again after correcting history permissions/settings to retry the capability check.

## Data sources and units

Manufacturer specification: `https://use1-omada-northbound.tplinkcloud.com/v3/api-docs`.

The additional calls are GET requests, using the existing OAuth token flow:

- `/openapi/v1/{omadacId}/sites/{siteId}/clients`: paginated live devices. `trafficDown` and `trafficUp` are bytes; `lastSeen` is milliseconds and `uptime` is seconds.
- `/openapi/v1/{omadacId}/sites/{siteId}/insight/clients`: known clients, including offline devices, with millisecond time filters.
- `/openapi/v1/{omadacId}/sites/{siteId}/clients/{clientMac}/client-history`: visits with `associated`, `lastSeen`, `download` and `upload` counters. Historical timestamps accept epoch seconds or milliseconds.
- `/openapi/v1/{omadacId}/controller/client/history-enable`: checks history recording without altering it.

The current client/auth API methods retain their existing behavior. All additional listings are paginated; repeated/incomplete pages are rejected. A cycle has a 200-request budget. Historical devices are processed gradually, ten per site per cycle by default.

## Reconciliation and accuracy

- A visit is identified by site, device MAC and the recorded connection start timestamp, preserving millisecond precision. Controller IDs alone are not assumed to identify unique visits. Live uptime is never used to create guessed visit records.
- Only increases in recorded connection-history counters are added to saved daily buckets. Final controller history fills the unrecorded tail instead of adding an entire visit twice. Repeated or concurrent imports are idempotent. Live client counters supply connection status only; they are not added as independently guessed visits. If history is unsupported/disabled, new usage totals remain unavailable instead of being fabricated from resettable live counters.
- Saved daily totals survive reconnects, app restarts and later counter resets. Unexplained decreases within one connection are marked incomplete; saved bytes are not removed.
- Days use Africa/Dar_es_Salaam. Observed interval bytes crossing midnight are divided by interval duration, preserving every byte, and explicitly marked as estimated. This is not a claim to measure the exact second each byte crossed midnight.
- Ongoing visits are provisional until retained history confirms their completion. Outages, unsupported history, missing fields, pagination problems and delayed collection are shown. Usage before tracking can only be imported if the controller retained it. In the UI, “Live readings / awaiting history” labels these ongoing connection-history measurements.
- These are device traffic counters, which may include local traffic. They are not an ISP WAN billing measurement.
- Tracking is per device/site. A person with multiple devices or changed private MAC addresses appears separately. Known paid customer names/phones are looked up within the same business; anonymous voucher users retain their device identity.
- Report summaries cover all matching saved records; the ranking displays the top 100 devices. Device drill-down displays the latest 100 whole visits. Daily totals cover the selected dates.
- Granting free access is a manual owner/admin action, stored as complimentary access, separate from voucher sales and wallet money.

## Operations and rollback

Optional environment settings: `USAGE_HISTORY_POLL_MS` (minimum 60000), `USAGE_HISTORY_DAYS` (1–365, default 30), and `USAGE_HISTORY_CLIENTS_PER_TICK` (1–20, default 10). Set `USAGE_HISTORY_ENABLED=false` and restart to stop the new worker globally, or pause individual sites in the page. Saved history remains available.

`npm run usage:sync` runs one reporting collection cycle for already-enabled sites. No sites are enabled by this command. Missing reporting tables are detected without failing application startup. Reverting the feature code leaves the new tables unused and preserves the existing access/payment paths.

For a production rollout, retain a database backup before applying any migration and monitor the first collection cycle. `npm test` includes the existing voucher/accounting suite and the new PostgreSQL usage regressions.

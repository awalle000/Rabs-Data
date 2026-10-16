# Supplier Reconciliation Rollout

`SUPPLIER_RECONCILIATION_ENABLED` controls only the periodic supplier status-check scheduler. The API, payment verification, webhook processing, and payment-triggered fulfillment remain available when the periodic scheduler is paused.

- `SUPPLIER_RECONCILIATION_ENABLED` unset or `false`: scheduler paused. Startup logs say paused; `/api/health` reports `supplierReconciliation.mode: "paused"`.
- `SUPPLIER_RECONCILIATION_ENABLED=true`: scheduler enabled. Startup logs say it polls every 60 seconds; `/api/health` reports `mode: "enabled"`.

The opt-in default is intentional for rollout safety. The previous application revision does not understand this setting or the reconciliation lease fields, so a new revision's lease cannot fence an old scheduler.

`SUPPLIER_CATALOG_REFRESH_ENABLED` independently controls periodic catalog refresh (default paused); authenticated manual refresh remains available. `PAYMENT_ORDER_RECOVERY_ENABLED` controls background recovery of persisted successful order payments (default paused). Immediate inline recovery after a successful payment remains active. Health reports the configured state of both background loops.

## Initial rollout

1. Confirm Render service type, instance count/scaling, auto-deploy setting, shutdown delay and overlapping-deploy policy in the dashboard; these are not present in the repository.
2. After review/approval, deploy with `SUPPLIER_RECONCILIATION_ENABLED=false`, `SUPPLIER_CATALOG_REFRESH_ENABLED=false`, and `PAYMENT_ORDER_RECOVERY_ENABLED=false`. The API stays available, while all new periodic supplier/catalog/payment-recovery loops remain paused. Old binaries can still run their legacy scheduler during overlap.
3. Wait for traffic switch, then confirm in Render Events/Logs that every old instance exited. Check the new instance's `/api/health` reports `mode: "paused"` and its log says paused. Do not infer process exit from a cleared local timer.
4. Before enabling payment recovery, create and validate its index in staging, then apply it to production only through an approved controlled migration. Keep `PAYMENT_ORDER_RECOVERY_ENABLED=false` until that index is confirmed present and the plan reviewed.
5. Only when no legacy instance remains, change `SUPPLIER_RECONCILIATION_ENABLED=true`, `SUPPLIER_CATALOG_REFRESH_ENABLED=true`, and (after index approval) `PAYMENT_ORDER_RECOVERY_ENABLED=true`. The currently running revision remains paused while replacement starts. Verify old paused instances exit and health reports all intended loops enabled.
6. Monitor order age, lease recovery, supplier failures, catalog refresh state, outbox pending age/attempts, and stale-order diagnostics. Actual MongoDB claim/payment-recovery query plans and index costs remain deployment blockers until validated on isolated staging.

## PadodaTagh order-status fix rollout and recovery

1. After code review, deploy the reviewed backend revision with `SUPPLIER_RECONCILIATION_ENABLED=false` or unset. Do not enable the scheduler as part of the code deployment. Keep the existing catalog and payment-recovery flags at their separately approved values.
2. In Render, verify the deployed commit SHA matches the reviewed revision. Check `/api/health` reports `ready: true`, the matching `revision`, and `supplierReconciliation.mode: "paused"`. Use Render deployment events/logs to confirm all prior instances have exited before continuing; health from one instance does not prove that an old instance is gone.
3. In Render's environment settings, confirm the PadodaTagh credentials and backend URL are configured without copying or logging their values, and confirm the reconciliation flag remains unset or `false`. Do not use a real order or contact the supplier to test configuration. Use the mocked backend regression tests and health endpoint for this step.
4. After the backend is healthy and only the intended revision is serving, separately enable `SUPPLIER_RECONCILIATION_ENABLED=true` through the approved Render change process. Confirm the replacement instance reports `supplierReconciliation.mode: "enabled"` and verify all paused/old instances have exited before relying on periodic checks.
5. Monitor reconciliation logs and order-age/stale-order diagnostics. Confirm that eligible checks reach a terminal supplier result or remain pending/uncertain without resubmitting purchases. Review errors, lease recovery, and stale counts; do not infer delivery from age or from RabsData's prior `processing` state.

The worker checks submitted PadodaTagh orders only within the existing 24-hour window. Existing in-window orders whose supplier status was stored as `processing` are eligible after the scheduler is enabled. Orders older than 24 hours remain outside automatic checks and appear in the Admin Orders stale-supplier review list.

For an older order, an authorized administrator can open Admin Orders, choose **View review list**, open the order ID, and select **Check Supplier Status**. This protected action queries PadodaTagh's authenticated status API and applies a result only after the supplier identity is verified. A confirmed completion uses the normal fulfillment path to update the existing order and timestamps; a pending result remains processing, and uncertain/mismatched results remain flagged for review. Do not resubmit the supplier purchase or manually mark the order successful. If supplier identity is unavailable or cannot be verified, preserve the review state and escalate using the supplier's support process. Check older orders individually and review the returned supplier status before taking any separate refund or customer-support action.

## Rollback

For rollback, first set all three flags to `false` and wait for every active new-code worker to exit. If rolling back to a revision that understands these flags, restore it paused, verify it is the only revision, then enable only the approved loops. For rollback to a pre-flag revision, use a planned Render service stop/maintenance window and verify every instance is stopped before restoring the old revision. This may cause API downtime. Never rely on the old revision to honor the flags.

The pause flag does not pause payment-triggered order fulfillment. It pauses only periodic supplier status checks. Reconciliation never resubmits a supplier purchase. Shutdown clears and drains registered background job timers, waits for active reconciliation/catalog runs and then disconnects MongoDB. If Render sends SIGKILL at its deadline, persisted leases expire and stale result writes remain token-fenced.

## Recovery and catalog behavior

New successful order payments atomically receive `orderRecoveryState: "pending"` in the same Payment document update that records provider success. Inline recovery immediately uses a UUID lease and existing order/reference checks; simultaneous webhook/verification invocations compete for the same atomic claim. Periodic recovery uses bounded batches, backs off failures, and reclaims expired leases. Ambiguous submitted orders remain in processing/status reconciliation and are never resubmitted by this payment recovery path. Legacy successful order payments missing recovery state are promoted at most 20 per run only when `PAYMENT_ORDER_RECOVERY_ENABLED=true`; each successful promotion leaves the missing-state predicate, so migration progresses in bounded batches.

No recovery index is declared in the application schema, so Mongoose `autoIndex` will not create it automatically. Before enabling the worker, validate and create this index explicitly in isolated staging, then plan an approved production migration:

```javascript
db.payments.createIndex(
	{ status: 1, purpose: 1, orderRecoveryState: 1, orderRecoveryNextAt: 1, orderRecoveryLeaseUntil: 1, createdAt: 1 },
	{ partialFilterExpression: { status: 'successful', purpose: 'order' }, name: 'payment_order_recovery_due' }
)
```

Run `explain("executionStats")` for the missing-state legacy promotion query and the pending/expired-lease due query on synthetic data. Confirm index-build cost and query bounds before production. No isolated MongoDB was available locally, so no real plan/index result is claimed. Rollout order: deploy with all three flags false; verify all legacy instances exited; run the approved index migration; verify the index and plans; enable payment recovery and confirm health; then separately enable catalog refresh and supplier reconciliation after their corresponding checks. Do not enable payment recovery until its index exists.

Public catalog reads return HTTP 503 with `Retry-After: 15` while a supplier refresh is in progress or after a refresh fails after starting newer than the last successful refresh. This prevents returning the per-package partially updated set. It favors consistent availability over serving the last-known-good snapshot: no immutable catalog snapshot is stored, so catalog browsing can remain unavailable until a later full refresh succeeds. Measure refresh duration and failure behavior in staging before production rollout.

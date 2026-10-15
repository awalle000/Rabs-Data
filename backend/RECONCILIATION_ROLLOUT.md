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

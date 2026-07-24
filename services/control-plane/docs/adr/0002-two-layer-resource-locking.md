# ADR 0002: Device leases plus a short Xiaowei transport lock

- Status: accepted
- Date: 2026-07-24

## Decision

Every UI action owns one exclusive `device:<deviceId>` lease. Jobs on different devices may run concurrently. Calls that use Xiaowei additionally acquire `transport:xiaowei:22222` only for the vendor request, using a tokenized file lock with heartbeat and stale-lock recovery.

Scheduled jobs queue FIFO per device. Interactive exploration fails with `423 DEVICE_BUSY` instead of silently waiting or preempting.

## Consequences

The device lease protects workflows; the transport lock prevents cross-process WebSocket response mixing. A transport lock is never held while waiting for a device lease.

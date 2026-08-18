# ADR 0001: Windows-local authority and SSH CLI

- Status: accepted
- Date: 2026-07-24

## Decision

`DESKTOP-3I1EVHE` is the sole v1 control authority. The control API binds only to `127.0.0.1:17920`. Remote agents use `devicectl` through the `xhs-windows` SSH identity; no control port is exposed to the LAN or tailnet.

Every durable record includes `nodeId` so another Windows node can be added later without changing job or device identifiers.

## Consequences

Windows runtime state is authoritative. Mac and GPFS copies are source, documentation, and sanitized evidence only. Local OS/SSH access is the v1 security boundary.

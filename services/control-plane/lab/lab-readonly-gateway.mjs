// XHS lab-only read-only FastOperator entry — gateway (Plan V2, xhs-lab-readonly-fast-entry-v1).
//
// A current-user Node process, Node stdlib only. This gateway is the SINGLE
// trust boundary for lab actions: no caller-supplied FastOperator bodies, URLs,
// ports, tokens, deviceIds or runtimeIds ever reach the forwarding code. It is
// explicitly NOT the production control plane: an in-memory lab authority whose
// module graph contains no production modules of any kind (asserted by the lab
// tests) and never the FastOperator lease bypass environment.
//
// Loopback listeners:
//   17920 (default)  FastOperator-compat lease authorization + leases + health
//   17930 (default)  agent-entry.md / agent-entry.json / health
//
// Claim boundary: LAB_READ_ONLY_SLOT_REACHED only. productionAcceptance=false.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

export const SLOT_MAP = Object.freeze({
  "01": Object.freeze({ port: 17895, deviceId: "lab-slot-01" }),
  "02": Object.freeze({ port: 17897, deviceId: "lab-slot-02" }),
});

export const DEFAULT_CONTROL_PORT = 17920;
export const DEFAULT_ENTRY_PORT = 17930;

const LEASE_TTL_MS = 30_000;
const OUTBOUND_TIMEOUT_MS = Object.freeze({ focus: 60_000, dump: 120_000 });
const MAX_BODY_BYTES = 4096;
const MAX_REMEMBERED_REQUESTS = 512;
const LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/;
const LIVE_STATES = Object.freeze(new Set(["PENDING", "AUTHORIZED", "IN_FLIGHT", "IN_FLIGHT_UNCERTAIN"]));

export class LabError extends Error {
  constructor(code, status) {
    super(code);
    this.name = "LabError";
    this.code = code;
    this.status = status;
  }
}

// The only function in the lab that ever constructs an outbound FastOperator
// body. Anything not on the focus/dump allowlist fails closed here, before any
// HTTP call is possible (mutation-probe anchor).
export function buildFoBody(action, label) {
  if (action === "focus") {
    return Object.freeze({ action: "focus" });
  }
  if (action === "dump") {
    if (label !== undefined && !LABEL_PATTERN.test(label)) {
      throw new LabError("LABEL_INVALID", 400);
    }
    return Object.freeze({ action: "dump", label: label ?? "lab-dump" });
  }
  throw new LabError("LAB_ACTION_FORBIDDEN", 403);
}

function safeEqual(a, b) {
  const ha = createHmac("sha256", "lab-const-compare").update(String(a)).digest();
  const hb = createHmac("sha256", "lab-const-compare").update(String(b)).digest();
  return timingSafeEqual(ha, hb);
}

function listenOnce(server, port) {
  return new Promise((resolveListen, rejectListen) => {
    const onError = (error) => {
      server.close();
      rejectListen(error);
    };
    server.once("error", onError);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", onError);
      resolveListen();
    });
  });
}

function readBody(req, maxBytes) {
  return new Promise((resolveBody, rejectBody) => {
    let size = 0;
    let oversize = false;
    const kept = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        // Keep draining (bounded from the client connection itself) but never
        // buffer an oversized payload; answer after the request drains.
        oversize = true;
        return;
      }
      kept.push(chunk);
    });
    req.on("end", () => {
      if (oversize) {
        rejectBody(new LabError("BODY_TOO_LARGE", 413));
        return;
      }
      resolveBody(Buffer.concat(kept).toString("utf8"));
    });
    req.on("error", () => rejectBody(new LabError("BODY_READ_FAILED", 400)));
  });
}

export class LabReadonlyGateway {
  constructor({
    clientToken,
    slotMap = SLOT_MAP,
    controlPort = DEFAULT_CONTROL_PORT,
    entryPort = DEFAULT_ENTRY_PORT,
    fetchImpl = globalThis.fetch,
    nowMs = () => Date.now(),
    receiptPath = null,
  } = {}) {
    if (typeof clientToken !== "string" || clientToken.length < 32) {
      throw new LabError("CLIENT_TOKEN_INVALID", 500);
    }
    this.clientToken = clientToken;
    this.slotMap = slotMap;
    this.controlPort = controlPort;
    this.entryPort = entryPort;
    this.fetchImpl = fetchImpl;
    this.nowMs = nowMs;
    this.receiptPath = receiptPath;
    this.startedAtMs = nowMs();
    this.leasesByLeaseId = new Map();
    this.activeBySlot = new Map();
    this.runtimeHmacBySlot = new Map(); // ephemeral, process-local only
    this.rememberedRequests = new Map(); // requestId -> slot (replay guard)
    this.runtimeKey = randomBytes(32);
    this.controlServer = null;
    this.entryServer = null;
  }

  // ---------------------------------------------------------------- utilities

  receipt(lease, event, extra = {}) {
    if (!this.receiptPath) return;
    try {
      mkdirSync(dirname(this.receiptPath), { recursive: true });
      // Metadata only: never tokens, runtime ids, device ids, UI XML or bodies.
      appendFileSync(this.receiptPath, `${JSON.stringify({
        ts: this.nowMs(),
        event,
        requestId: lease.requestId,
        slot: lease.slot,
        action: lease.action,
        leaseId: lease.leaseId,
        state: lease.state,
        ...extra,
      })}\n`);
    } catch {
      // receipts are best-effort metadata audit; never fail an operation on it
    }
  }

  rejectBrowser(headers) {
    if (headers["origin"] !== undefined || headers["referer"] !== undefined) {
      throw new LabError("BROWSER_ORIGIN_FORBIDDEN", 403);
    }
  }

  requireClientToken(headers) {
    const token = headers["x-lab-client-token"];
    if (typeof token !== "string" || token.length === 0) {
      throw new LabError("CLIENT_TOKEN_REQUIRED", 401);
    }
    if (!safeEqual(token, this.clientToken)) {
      throw new LabError("CLIENT_TOKEN_INVALID", 401);
    }
  }

  parseJson(rawBody) {
    if (typeof rawBody !== "string" || rawBody.length === 0) {
      throw new LabError("MALFORMED_BODY", 400);
    }
    let parsed;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      throw new LabError("MALFORMED_BODY", 400);
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new LabError("MALFORMED_BODY", 400);
    }
    return parsed;
  }

  // --------------------------------------------------------------- client API

  async submitRequest(rawBody, headers) {
    this.rejectBrowser(headers);
    this.requireClientToken(headers);
    const body = this.parseJson(rawBody);

    // Exact command surface: the client may name a slot and an intent, nothing
    // else. Everything the FastOperator receives is built from constants.
    const action = body.action;
    if (action !== "focus" && action !== "dump") {
      throw new LabError("LAB_ACTION_FORBIDDEN", 403);
    }
    const expectedKeys = action === "dump"
      ? ["action", "requestId", "slot"]
      : ["action", "requestId", "slot"];
    const bodyKeys = Object.keys(body);
    if (action === "dump" && body.label !== undefined) expectedKeys.push("label");
    if (bodyKeys.length !== expectedKeys.length || expectedKeys.some((key) => !bodyKeys.includes(key))) {
      throw new LabError("FORBIDDEN_KEYS", 400);
    }
    for (const key of bodyKeys) {
      if (!expectedKeys.includes(key)) throw new LabError("FORBIDDEN_KEYS", 400);
    }
    const slot = body.slot;
    if (typeof slot !== "string" || !Object.hasOwn(this.slotMap, slot)) {
      throw new LabError("UNKNOWN_SLOT", 400);
    }
    if (typeof body.requestId !== "string" || !REQUEST_ID_PATTERN.test(body.requestId)) {
      throw new LabError("MALFORMED_BODY", 400);
    }
    if (action === "dump" && body.label !== undefined) {
      if (typeof body.label !== "string" || !LABEL_PATTERN.test(body.label)) {
        throw new LabError("LABEL_INVALID", 400);
      }
    }

    // Replay guard: a replayed client request never forwards again.
    if (this.rememberedRequests.has(body.requestId)) {
      throw new LabError("REPLAY_REJECTED", 409);
    }

    // Concurrency guard: at most one nonterminal lease per slot.
    const existing = this.activeBySlot.get(slot);
    if (existing && LIVE_STATES.has(existing.state)) {
      throw new LabError("SLOT_BUSY", 423);
    }

    this.rememberedRequests.set(body.requestId, slot);
    if (this.rememberedRequests.size > MAX_REMEMBERED_REQUESTS) {
      const oldest = this.rememberedRequests.keys().next().value;
      this.rememberedRequests.delete(oldest);
    }

    const lease = {
      leaseId: `lab-${randomBytes(12).toString("hex")}`,
      requestId: body.requestId,
      slot,
      action,
      label: action === "dump" ? body.label : undefined,
      deviceId: this.slotMap[slot].deviceId,
      state: "PENDING",
      createdAtMs: this.nowMs(),
      expiresAtMs: this.nowMs() + LEASE_TTL_MS,
      operatorToken: null,
      rejectionCode: null,
    };
    this.leasesByLeaseId.set(lease.leaseId, lease);
    this.activeBySlot.set(slot, lease);
    this.receipt(lease, "lease.created");

    try {
      return await this.settleLease(lease);
    } finally {
      lease.operatorToken = null; // operator token lives only for the outbound hop
    }
  }

  // The only outbound hop: gateway -> FastOperator. Constant body, lease headers.
  async settleLease(lease) {
    const { port } = this.slotMap[lease.slot];
    const operatorToken = randomBytes(32).toString("hex");
    lease.operatorToken = operatorToken;
    const foBody = buildFoBody(lease.action, lease.label);
    try {
      const response = await this.fetchImpl(`http://127.0.0.1:${port}/`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-control-lease-id": lease.leaseId,
          "x-control-token": operatorToken,
          "x-control-device-id": lease.deviceId,
        },
        body: JSON.stringify(foBody),
        signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS[lease.action]),
      });
      let payload = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }
      if (!response.ok || payload?.ok !== true) {
        // A definite response — even an error response — settles the lease.
        this.markTerminal(lease, "RELEASED");
        const code = lease.rejectionCode ?? "FO_REQUEST_FAILED";
        this.receipt(lease, "lease.error", { code, httpStatus: response.status });
        return { ok: false, code, slot: lease.slot, action: lease.action, requestId: lease.requestId };
      }
      this.markTerminal(lease, "RELEASED");
      this.receipt(lease, "lease.released");
      return {
        ok: true,
        slot: lease.slot,
        action: lease.action,
        requestId: lease.requestId,
        result: payload.result ?? null,
      };
    } catch {
      // Outbound timeout or unknown connection state: fail-stop, no release,
      // no retry, no guess about whether the device work happened.
      lease.state = "IN_FLIGHT_UNCERTAIN";
      this.receipt(lease, "lease.uncertain");
      return { ok: false, code: "IN_FLIGHT_UNCERTAIN", slot: lease.slot, requestId: lease.requestId };
    }
  }

  markTerminal(lease, state) {
    if (lease.state === "RELEASED" || lease.state === "REJECTED") return; // single terminal transition
    lease.state = state;
  }

  // ------------------------------------------------- FastOperator authorize

  authorizeFoCallback(headers, rawBody) {
    const body = this.parseJson(rawBody);
    const callbackKeys = Object.keys(body).sort();
    if (
      callbackKeys.length !== 3
      || callbackKeys[0] !== "deviceId"
      || callbackKeys[1] !== "leaseId"
      || callbackKeys[2] !== "runtimeId"
    ) {
      throw new LabError("AUTH_REJECTED", 403);
    }
    const { leaseId, deviceId, runtimeId } = body;
    if (typeof leaseId !== "string" || typeof deviceId !== "string" || runtimeId === undefined) {
      throw new LabError("AUTH_REJECTED", 403);
    }
    const lease = this.leasesByLeaseId.get(leaseId) ?? null;
    if (!lease) throw new LabError("AUTH_REJECTED", 403);
    const token = headers["x-control-token"];
    if (typeof token !== "string" || !lease.operatorToken || !safeEqual(token, lease.operatorToken)) {
      // Forged or unknown operator token: the lease is untouched, no work released.
      throw new LabError("AUTH_REJECTED", 403);
    }
    if (lease.state !== "PENDING") {
      throw new LabError("AUTH_REJECTED", 403); // single use: never authorize again
    }
    if (!safeEqual(deviceId, lease.deviceId)) {
      throw new LabError("AUTH_REJECTED", 403);
    }
    if (this.nowMs() > lease.expiresAtMs) {
      this.markTerminal(lease, "REJECTED");
      throw new LabError("LEASE_EXPIRED", 403);
    }

    // Runtime consistency: the first callback binds an ephemeral in-process
    // HMAC; the raw runtimeId is never stored, logged or returned. Drift in the
    // same gateway lifetime fails closed.
    const runtimeHmac = createHmac("sha256", this.runtimeKey).update(String(runtimeId)).digest("hex");
    const bound = this.runtimeHmacBySlot.get(lease.slot);
    if (bound === undefined) {
      this.runtimeHmacBySlot.set(lease.slot, runtimeHmac);
    } else if (!safeEqual(bound, runtimeHmac)) {
      lease.rejectionCode = "RUNTIME_DRIFT";
      this.markTerminal(lease, "REJECTED");
      this.receipt(lease, "lease.runtime-drift");
      throw new LabError("RUNTIME_DRIFT", 409);
    }

    lease.state = "AUTHORIZED";
    lease.state = "IN_FLIGHT"; // device work starts after authorize
    return {
      ok: true,
      authorized: true,
      lease: {
        leaseId: lease.leaseId,
        deviceId: lease.deviceId,
        kind: "lab-readonly",
        expiresAt: lease.expiresAtMs,
      },
    };
  }

  // ----------------------------------------------------------------- read API

  publicLeases() {
    const leases = [];
    for (const lease of this.leasesByLeaseId.values()) {
      if (!LIVE_STATES.has(lease.state)) continue;
      leases.push({
        slot: lease.slot,
        action: lease.action,
        state: lease.state,
        createdAtMs: lease.createdAtMs,
        expiresAtMs: lease.expiresAtMs,
        runtimeHmac: this.runtimeHmacBySlot.get(lease.slot) ?? null,
      });
    }
    return leases;
  }

  health() {
    const nowMs = this.nowMs();
    return {
      ok: true,
      lab: true,
      mode: "LAB_READ_ONLY",
      productionAcceptance: false,
      controlPort: this.controlPort,
      entryPort: this.entryPort,
      pid: process.pid,
      startedAtMs: this.startedAtMs,
      uptimeMs: nowMs - this.startedAtMs,
      activeLeases: this.publicLeases().length,
    };
  }

  agentEntry() {
    return {
      schema: "xw.lab.agent-entry.v1",
      mode: "LAB_READ_ONLY",
      labOnly: true,
      claimedStatus: "LAB_READ_ONLY_SLOT_REACHED",
      productionAcceptance: false,
      slots: {
        "01": { port: this.slotMap["01"].port },
        "02": { port: this.slotMap["02"].port },
      },
      allowedActions: ["focus", "dump"],
      forbiddenActions: [
        "tap", "scroll", "open", "launch", "back", "input", "like", "collect",
        "comment", "publish", "message", "follow", "login", "settings", "payment",
        "rawShell", "adb", "port22222Forwarding",
      ],
      runtimeBinding:
        "first-callback runtime is bound as an ephemeral in-process HMAC for consistency only; it is never a trusted device identity",
      identitySemantics: "slot-only; no production alias or device identity is claimed",
      dumpByproduct:
        "FastOperator dump fallback may leave /sdcard/fo-dump.xml on the device; the gateway never persists raw dump content",
      persistence: "client token + metadata-only receipts under .xw-lab/ (Git-ignored)",
      activeLeases: this.publicLeases(),
      pid: process.pid,
      startedAtMs: this.startedAtMs,
      uptimeMs: this.nowMs() - this.startedAtMs,
    };
  }

  agentEntryMarkdown() {
    const entry = this.agentEntry();
    const leaseLines = entry.activeLeases.length === 0
      ? "none"
      : entry.activeLeases.map((l) => `- slot ${l.slot} ${l.action} ${l.state}`).join("\n");
    return [
      "# XW Platform — XHS Lab Read-Only Agent Entry",
      "",
      `- mode: ${entry.mode} (labOnly=${entry.labOnly})`,
      `- claimedStatus: ${entry.claimedStatus}`,
      `- productionAcceptance=false — lab receipts count no production acceptance.`,
      `- identitySemantics: ${entry.identitySemantics}`,
      `- runtimeBinding: ${entry.runtimeBinding}`,
      `- allowedActions: ${entry.allowedActions.join(", ")}`,
      `- slots: 01 -> 127.0.0.1:${entry.slots["01"].port}, 02 -> 127.0.0.1:${entry.slots["02"].port}`,
      `- forbiddenActions: ${entry.forbiddenActions.join(", ")}`,
      `- dumpByproduct: ${entry.dumpByproduct}`,
      `- persistence: ${entry.persistence}`,
      "",
      "## activeLeases",
      "",
      leaseLines,
      "",
    ].join("\n");
  }

  // ----------------------------------------------------------------- dispatch

  async dispatch(req, res, role) {
    try {
      this.rejectBrowser(req.headers);
      const body = req.method === "POST" ? await readBody(req, MAX_BODY_BYTES) : "";
      if (req.method === "GET" && req.url === "/healthz") {
        return this.json(res, 200, this.health());
      }
      if (req.method === "GET" && req.url === "/control/v1/health") {
        return this.json(res, 200, this.health());
      }
      if (role === "control") {
        if (req.method === "POST" && req.url === "/control/v1/leases/authorize") {
          return this.json(res, 200, this.authorizeFoCallback(req.headers, body));
        }
        if (req.method === "GET" && req.url === "/control/v1/leases") {
          this.requireClientToken(req.headers);
          return this.json(res, 200, { leases: this.publicLeases() });
        }
        if (req.method === "POST" && req.url === "/lab/v1/requests") {
          const result = await this.submitRequest(body, req.headers);
          return this.json(res, 200, result);
        }
        throw new LabError("NOT_FOUND", 404);
      }
      if (role === "entry") {
        if (req.method === "GET" && req.url === "/agent-entry.md") {
          res.writeHead(200, { "content-type": "text/markdown; charset=utf-8" });
          res.end(this.agentEntryMarkdown());
          return;
        }
        if (req.method === "GET" && req.url === "/agent-entry.json") {
          return this.json(res, 200, this.agentEntry());
        }
        throw new LabError("NOT_FOUND", 404);
      }
      throw new LabError("NOT_FOUND", 404);
    } catch (error) {
      const status = error instanceof LabError ? error.status : 500;
      const code = error instanceof LabError ? error.code : (error?.code ?? "INTERNAL");
      this.json(res, status, { ok: false, code, message: code });
    }
  }

  json(res, status, body) {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
  }

  async listen() {
    this.controlServer = createServer((req, res) => {
      this.dispatch(req, res, "control").catch(() => {});
    });
    await listenOnce(this.controlServer, this.controlPort);
    this.controlPort = this.controlServer.address().port;
    try {
      this.entryServer = createServer((req, res) => {
        this.dispatch(req, res, "entry").catch(() => {});
      });
      await listenOnce(this.entryServer, this.entryPort);
      this.entryPort = this.entryServer.address().port;
    } catch (error) {
      await new Promise((r) => this.controlServer.close(r));
      this.controlServer = null;
      this.entryServer = null;
      throw error;
    }
    return this;
  }

  async close() {
    if (this.controlServer) await new Promise((r) => this.controlServer.close(r));
    if (this.entryServer) await new Promise((r) => this.entryServer.close(r));
    this.controlServer = null;
    this.entryServer = null;
  }

  actualControlPort() {
    return this.controlServer === null ? this.controlPort : this.controlServer.address().port;
  }

  actualEntryPort() {
    return this.entryServer === null ? this.entryPort : this.entryServer.address().port;
  }
}

// ------------------------------------------------------------------ CLI mode

export function labDataDir() {
  return process.env.XHS_LAB_DATA_DIR || join(HERE, "..", "..", "..", ".xw-lab");
}

export function loadOrCreateClientToken(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  const tokenPath = join(dataDir, "client-token.json");
  const readToken = () => {
    const parsed = JSON.parse(readFileSync(tokenPath, "utf8"));
    if (typeof parsed?.token !== "string" || parsed.token.length < 32) {
      throw new LabError("CLIENT_TOKEN_INVALID", 500);
    }
    return parsed.token;
  };
  try {
    return readToken();
  } catch (error) {
    if (error instanceof LabError) throw error;
    const token = randomBytes(32).toString("hex");
    try {
      writeFileSync(tokenPath, `${JSON.stringify({ schema: "xw.lab.client-token.v1", token })}\n`, { flag: "wx", mode: 0o600 });
    } catch (writeError) {
      if (writeError?.code !== "EEXIST") throw writeError;
    }
    return readToken();
  }
}

async function runGatewayCli() {
  if (process.argv.length !== 2) {
    process.stderr.write(`${JSON.stringify({ ok: false, code: "LAB_ARGUMENT_FORBIDDEN" })}\n`);
    process.exitCode = 2;
    return;
  }
  const dataDir = labDataDir();
  const gateway = new LabReadonlyGateway({
    clientToken: loadOrCreateClientToken(dataDir),
    receiptPath: join(dataDir, "receipts.jsonl"),
  });
  try {
    await gateway.listen();
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      code: error?.code === "EADDRINUSE" ? "PORT_OCCUPIED" : (error?.code ?? "GATEWAY_START_FAILED"),
      message: error?.code ?? "GATEWAY_START_FAILED",
    })}\n`);
    process.exitCode = 2;
    return;
  }
  writeFileSync(join(dataDir, "gateway.pid"), `${process.pid}\n`);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    lab: true,
    mode: "LAB_READ_ONLY",
    controlPort: gateway.controlPort,
    entryPort: gateway.entryPort,
    pid: process.pid,
  })}\n`);
  const stop = async () => {
    await gateway.close();
    try { rmSync(join(dataDir, "gateway.pid")); } catch { /* pid file is best-effort */ }
    process.exit(0);
  };
  process.once("SIGINT", () => { void stop(); });
  process.once("SIGTERM", () => { void stop(); });
  setInterval(() => {}, 3_600_000); // stay alive; lifecycle is signal-driven
}

const invokedDirectly = (() => {
  try {
    const argvPath = process.argv[1];
    if (!argvPath) return false;
    return pathToFileURL(argvPath).href === import.meta.url;
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  void runGatewayCli();
}
import dgram from "node:dgram";
import dns from "node:dns";
import dnsPromises from "node:dns/promises";
import http from "node:http";
import http2 from "node:http2";
import https from "node:https";
import net from "node:net";
import { syncBuiltinESMExports } from "node:module";
import tls from "node:tls";

function denied(kind, target = "") {
  const error = new Error(`M6 sealed live child denied ${kind}${target ? `: ${target}` : ""}`);
  error.code = "M6_LIVE_CHILD_NETWORK_DENIED";
  return error;
}

function endpoint() {
  let base;
  try { base = new URL(process.env.XW_M6_LIVE_PROVIDER_BASE_URL); } catch {
    throw denied("an invalid provider endpoint");
  }
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) {
    throw denied("an unsealed provider endpoint");
  }
  const prefix = base.pathname.replace(/\/+$/u, "");
  return Object.freeze({
    origin: base.origin,
    chatPath: `${prefix}/chat/completions`.replace(/^\/+/u, "/"),
  });
}

const allowed = endpoint();
const originalFetch = globalThis.fetch;
if (typeof originalFetch !== "function") throw denied("missing global fetch");

// The live runtime requires exactly one egress: the sealed provider's
// chat-completions path. Redirects cannot escape because every hop re-enters
// this wrapper. Credentials and query strings are rejected.
globalThis.fetch = async function m6SealedFetch(input, init) {
  const requestUrl = input instanceof Request ? input.url : String(input);
  let url;
  try { url = new URL(requestUrl); } catch { throw denied("fetch", "invalid URL"); }
  if (url.protocol !== "https:" || url.origin !== allowed.origin || url.pathname !== allowed.chatPath
    || url.username || url.password || url.search || url.hash) {
    throw denied("fetch", `${url.origin}${url.pathname}`);
  }
  return originalFetch(input, { ...init, redirect: "manual" });
};

const rejectDirectSocket = (kind) => function rejectM6DirectSocket(...args) {
  const callback = args.find((value) => typeof value === "function");
  const error = denied(kind);
  if (callback) queueMicrotask(() => callback(error));
  throw error;
};

// Content-addressed dependencies are trusted, but a compromised dependency
// must not open a second network path to localhost, ADB, Control Plane, or an
// arbitrary host. Native fetch remains available only through the wrapper.
net.connect = rejectDirectSocket("net.connect");
net.createConnection = net.connect;
net.Socket.prototype.connect = rejectDirectSocket("net.Socket.connect");
net.Server.prototype.listen = rejectDirectSocket("net.Server.listen");
net.createServer = rejectDirectSocket("net.createServer");
tls.connect = rejectDirectSocket("tls.connect");
http.request = rejectDirectSocket("http.request");
http.get = rejectDirectSocket("http.get");
https.request = rejectDirectSocket("https.request");
https.get = rejectDirectSocket("https.get");
http.Agent.prototype.createConnection = rejectDirectSocket("http.Agent.createConnection");
https.Agent.prototype.createConnection = rejectDirectSocket("https.Agent.createConnection");
http2.connect = rejectDirectSocket("http2.connect");
http2.createServer = rejectDirectSocket("http2.createServer");
http2.createSecureServer = rejectDirectSocket("http2.createSecureServer");
dgram.createSocket = rejectDirectSocket("dgram.createSocket");
dgram.Socket.prototype.bind = rejectDirectSocket("dgram.Socket.bind");
dgram.Socket.prototype.connect = rejectDirectSocket("dgram.Socket.connect");
dgram.Socket.prototype.send = rejectDirectSocket("dgram.Socket.send");

// Node's built-in WHATWG WebSocket uses undici's own connector and does not
// traverse the public `node:net` functions above. The live child has no sealed
// WebSocket destination, so remove that constructor authority altogether.
if (typeof globalThis.WebSocket === "function") {
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: false,
    enumerable: true,
    writable: false,
    value: class M6DeniedWebSocket {
      constructor() { throw denied("WebSocket"); }
    },
  });
}

// `node:dns` can create UDP/TCP traffic through c-ares without going through
// `node:dgram` or `node:net`. A dependency must not encode credentials in a
// query name or replace the resolver with a local/attacker-controlled server.
// Native provider fetch keeps using Node's internal resolver; only the public
// DNS authority exposed to child JavaScript is removed here.
for (const method of [
  "getServers", "lookup", "lookupService", "resolve", "resolve4", "resolve6",
  "resolveAny", "resolveCaa", "resolveCname", "resolveMx", "resolveNaptr",
  "resolveNs", "resolvePtr", "resolveSoa", "resolveSrv", "resolveTxt", "reverse",
  "setServers",
]) {
  dns[method] = rejectDirectSocket(`dns.${method}`);
  if (typeof dnsPromises[method] === "function") dnsPromises[method] = rejectDirectSocket(`dns.promises.${method}`);
}
dns.Resolver = class M6DeniedDnsResolver {
  constructor() { throw denied("dns.Resolver"); }
};
dnsPromises.Resolver = class M6DeniedDnsPromisesResolver {
  constructor() { throw denied("dns.promises.Resolver"); }
};
syncBuiltinESMExports();

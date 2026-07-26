import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

import { ControlPlaneError, errorBody } from "./lib/errors.mjs";

export const DEFAULT_REMOTE_REPO = "C:\\Users\\Public\\xhs-routing-v1-1";
const FORWARDED_ARGV_FLAG = "--forwarded-argv-base64";

function option(argv, name, fallback = undefined) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : fallback;
}

function flag(argv, name) {
  return argv.includes(name);
}

function options(argv, name) {
  const result = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === name && argv[index + 1] !== undefined) result.push(argv[index + 1]);
  }
  return result;
}

function requireOption(argv, name) {
  const value = option(argv, name);
  if (value === undefined) throw new ControlPlaneError("CLI_OPTION_REQUIRED", `${name} is required`);
  return value;
}

function parseJsonOption(argv, name, fallback = {}) {
  const value = option(argv, name);
  if (value === undefined) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    throw new ControlPlaneError("CLI_JSON_INVALID", `${name} must be valid JSON`);
  }
}

function placementOptions(argv) {
  const placement = {};
  const nodeId = option(argv, "--node");
  const physicalLabel = option(argv, "--physical-label");
  const requiredTags = options(argv, "--require-tag");
  if (nodeId !== undefined) placement.nodeId = nodeId;
  if (physicalLabel !== undefined) placement.physicalLabel = physicalLabel;
  if (requiredTags.length > 0) placement.requiredTags = requiredTags;
  return {
    ...(option(argv, "--device") !== undefined ? { deviceId: option(argv, "--device") } : {}),
    ...(Object.keys(placement).length > 0 ? { placement } : {}),
  };
}

async function requestJson(baseUrl, method, path, body) {
  const response = await fetch(new URL(path, baseUrl), {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const result = await response.json();
  if (!response.ok) {
    throw new ControlPlaneError(
      result?.error?.code || "CONTROL_REQUEST_FAILED",
      result?.error?.message || `request failed with ${response.status}`,
      { status: response.status, details: result?.error?.details || {} },
    );
  }
  return result;
}

export function encodeForwardedArgv(argv) {
  if (!Array.isArray(argv) || argv.some((value) => typeof value !== "string")) {
    throw new ControlPlaneError("CLI_FORWARDED_ARGS_INVALID", "forwarded arguments must be strings");
  }
  return Buffer.from(JSON.stringify(argv), "utf8").toString("base64");
}

export function decodeForwardedArgv(encoded) {
  try {
    const decoded = JSON.parse(Buffer.from(String(encoded || ""), "base64").toString("utf8"));
    if (!Array.isArray(decoded) || decoded.some((value) => typeof value !== "string")) throw new Error("not string[]");
    return decoded;
  } catch {
    throw new ControlPlaneError("CLI_FORWARDED_ARGS_INVALID", "forwarded arguments are invalid");
  }
}

export function remotePowerShell(repo, encodedArgs, expectedHost) {
  const quote = (value) => String(value).replace(/'/g, "''");
  return [
    `$actualHost=[System.Net.Dns]::GetHostName()`,
    `if ($actualHost -ine '${quote(expectedHost)}') { throw "authority host mismatch: $actualHost" }`,
    `$repo='${quote(repo)}'`,
    `Set-Location -LiteralPath $repo`,
    `& node 'control-plane\\devicectl.mjs' '--local' '${FORWARDED_ARGV_FLAG}' '${quote(encodedArgs)}'`,
    `exit $LASTEXITCODE`,
  ].join("; ");
}

function runRemote(argv, alias) {
  const repo = process.env.DEVICECTL_REMOTE_REPO || DEFAULT_REMOTE_REPO;
  const expectedHost = process.env.CONTROL_PLANE_EXPECTED_HOST || "DESKTOP-3I1EVHE";
  const encodedArgs = encodeForwardedArgv(argv);
  return new Promise((resolve, reject) => {
    const child = spawn("ssh", [
      alias,
      "powershell",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "-",
    ], { stdio: ["pipe", "inherit", "inherit"], shell: false });
    child.stdin.end(remotePowerShell(repo, encodedArgs, expectedHost));
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`remote devicectl exited ${code}`)));
  });
}

function help() {
  return `devicectl [--ssh xhs-windows] <command>

  health | nodes | devices | capabilities | leases
  route plan --actor ID --capability ID [--device ID | --node ID --physical-label LABEL --require-tag TAG]
  job submit --actor ID --capability ID --idempotency-key KEY [--device ID | placement selectors] [--params JSON]
  job status|watch|cancel --job ID
  approval approve|deny --job ID --actor ID [--reason TEXT]
  session acquire --actor ID [--device ID | --capability ID with placement selectors] [--canary]
  session heartbeat|release --session ID --token TOKEN
  session action --session ID --token TOKEN --capability ID --idempotency-key KEY [--params JSON]
  lab action --session ID --token TOKEN --action NAME --idempotency-key KEY [--data JSON]
  evidence show --run ID`;
}

export async function main(argv = process.argv.slice(2)) {
  const forwardedArgv = option(argv, FORWARDED_ARGV_FLAG);
  if (forwardedArgv !== undefined) {
    if (!flag(argv, "--local")) {
      throw new ControlPlaneError("CLI_FORWARDED_ARGS_INVALID", `${FORWARDED_ARGV_FLAG} is remote-internal only`);
    }
    argv = ["--local", ...decodeForwardedArgv(forwardedArgv)];
  }
  const sshAlias = option(argv, "--ssh");
  if (sshAlias && !flag(argv, "--local")) {
    const forwarded = argv.filter((value, index) => value !== "--ssh" && argv[index - 1] !== "--ssh");
    await runRemote(forwarded, sshAlias);
    return;
  }
  argv = argv.filter((value) => value !== "--local");
  const baseUrl = option(argv, "--url", process.env.CONTROL_PLANE_URL || "http://127.0.0.1:17920/");
  argv = argv.filter((value, index) => value !== "--url" && argv[index - 1] !== "--url");
  const [group, action] = argv;
  if (!group || ["help", "--help", "-h"].includes(group)) {
    console.log(help());
    return;
  }
  let result;
  if (["health", "nodes", "devices", "capabilities", "leases"].includes(group)) {
    result = await requestJson(baseUrl, "GET", `/control/v1/${group}`);
  } else if (group === "route" && action === "plan") {
    result = await requestJson(baseUrl, "POST", "/control/v1/routes/plan", {
      actorId: requireOption(argv, "--actor"),
      capabilityId: requireOption(argv, "--capability"),
      params: parseJsonOption(argv, "--params", {}),
      canary: flag(argv, "--canary"),
      ...placementOptions(argv),
    });
  } else if (group === "job" && action === "submit") {
    result = await requestJson(baseUrl, "POST", "/control/v1/jobs", {
      actorId: requireOption(argv, "--actor"),
      capabilityId: requireOption(argv, "--capability"),
      idempotencyKey: requireOption(argv, "--idempotency-key"),
      params: parseJsonOption(argv, "--params", {}),
      canary: flag(argv, "--canary"),
      ...placementOptions(argv),
    });
  } else if (group === "job" && action === "status") {
    result = await requestJson(baseUrl, "GET", `/control/v1/jobs/${encodeURIComponent(requireOption(argv, "--job"))}`);
  } else if (group === "job" && action === "cancel") {
    result = await requestJson(baseUrl, "POST", `/control/v1/jobs/${encodeURIComponent(requireOption(argv, "--job"))}/cancel`, {});
  } else if (group === "job" && action === "watch") {
    const jobId = requireOption(argv, "--job");
    while (true) {
      result = await requestJson(baseUrl, "GET", `/control/v1/jobs/${encodeURIComponent(jobId)}`);
      if (["succeeded", "failed", "ambiguous", "recovery_required", "cancelled", "waiting_approval"].includes(result.job.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  } else if (group === "approval" && ["approve", "deny"].includes(action)) {
    result = await requestJson(baseUrl, "POST", `/control/v1/approvals/${encodeURIComponent(requireOption(argv, "--job"))}`, {
      decision: action,
      actorId: requireOption(argv, "--actor"),
      reason: option(argv, "--reason", null),
    });
  } else if (group === "session" && action === "acquire") {
    result = await requestJson(baseUrl, "POST", "/control/v1/sessions", {
      actorId: requireOption(argv, "--actor"),
      ...(option(argv, "--capability") !== undefined ? { capabilityId: option(argv, "--capability") } : {}),
      canary: flag(argv, "--canary"),
      ...placementOptions(argv),
    });
  } else if (group === "session" && ["heartbeat", "release"].includes(action)) {
    const sessionId = requireOption(argv, "--session");
    result = await requestJson(baseUrl, "POST", `/control/v1/sessions/${encodeURIComponent(sessionId)}/${action}`, {
      token: requireOption(argv, "--token"),
    });
  } else if (group === "session" && action === "action") {
    const sessionId = requireOption(argv, "--session");
    result = await requestJson(baseUrl, "POST", `/control/v1/sessions/${encodeURIComponent(sessionId)}/actions`, {
      token: requireOption(argv, "--token"),
      capabilityId: requireOption(argv, "--capability"),
      idempotencyKey: requireOption(argv, "--idempotency-key"),
      params: parseJsonOption(argv, "--params", {}),
    });
  } else if (group === "lab" && action === "action") {
    const sessionId = requireOption(argv, "--session");
    result = await requestJson(baseUrl, "POST", `/control/v1/sessions/${encodeURIComponent(sessionId)}/actions`, {
      token: requireOption(argv, "--token"),
      capabilityId: "xiaowei.lab.raw",
      idempotencyKey: requireOption(argv, "--idempotency-key"),
      params: {
        action: requireOption(argv, "--action"),
        data: parseJsonOption(argv, "--data", {}),
      },
    });
  } else if (group === "evidence" && action === "show") {
    result = await requestJson(baseUrl, "GET", `/control/v1/runs/${encodeURIComponent(requireOption(argv, "--run"))}/evidence`);
  } else {
    throw new ControlPlaneError("CLI_COMMAND_UNKNOWN", `unknown command: ${argv.slice(0, 2).join(" ")}`);
  }
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(JSON.stringify(errorBody(error), null, 2));
    process.exitCode = 1;
  });
}

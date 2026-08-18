import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";

import { validateCompletionBundle } from "./repair-proposal.mjs";

const SHA40 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;

export function createRepairAuthorityVerifiers({
  macRepoRoot,
  trustedMacRef = "refs/remotes/origin/main",
  outboxRoot,
  completionRoot,
  replayAuthorizationPublicKeys = {},
}) {
  return {
    verifyClaimLock: (context) => verifyClaimLockArtifact(context, { outboxRoot }),
    verifyMacReviewAuthority: (context) => verifyMacReviewAuthorityArtifact(context, { macRepoRoot, trustedMacRef }),
    verifyReplayAuthorization: (context) => verifyReplayAuthorizationArtifact(context, { macRepoRoot, trustedMacRef, replayAuthorizationPublicKeys }),
    verifyCompletionBundle: (context) => verifyCompletionBundleArtifact(context, { completionRoot }),
  };
}

export function verifyClaimLockArtifact({ proposal, projection, event, lock }, { outboxRoot }) {
  try {
    const packet = readHashedJson(outboxRoot, lock.lockRef, lock.lockSha256);
    return packet.schemaId === "xhs.repair-claim-lock.v1"
      && packet.schemaVersion === 1
      && packet.proposalId === proposal.proposalId
      && packet.proposalSha256 === projection.proposalSha256
      && packet.attempt === event.attempt
      && packet.actorId === event.actor.id
      && packet.claimedAt === event.occurredAt
      && packet.expiresAt === lock.expiresAt;
  } catch {
    return false;
  }
}

export function verifyMacReviewAuthorityArtifact({ proposal, projection, event, authority }, { macRepoRoot, trustedMacRef }) {
  try {
    if (!macRepoRoot || !SHA40.test(authority.macCommit ?? "") || !safeRelativePath(authority.reviewReceiptPath)) return false;
    const ancestor = spawnSync("git", ["merge-base", "--is-ancestor", authority.macCommit, trustedMacRef], { cwd: macRepoRoot, stdio: "ignore" });
    if (ancestor.status !== 0) return false;
    const shown = spawnSync("git", ["show", `${authority.macCommit}:${authority.reviewReceiptPath}`], { cwd: macRepoRoot, encoding: null, maxBuffer: 4 * 1024 * 1024 });
    if (shown.status !== 0 || rawSha256(shown.stdout) !== authority.reviewReceiptSha256) return false;
    const receipt = JSON.parse(shown.stdout.toString("utf8"));
    const verdict = {
      review_approved: "approved",
      review_request_changes: "request_changes",
      mark_deployable: "deployable",
      cancel: "cancelled",
    }[event.eventType];
    return receipt.schemaId === "xhs.repair-review-authority.v1"
      && receipt.schemaVersion === 1
      && receipt.proposalId === proposal.proposalId
      && receipt.proposalSha256 === projection.proposalSha256
      && receipt.sourceCheckpointSha256 === (projection.lastSourceCheckpoint?.bundleSha256 ?? null)
      && receipt.verdict === verdict
      && receipt.reviewedAt === event.occurredAt
      && (event.eventType !== "mark_deployable" || receipt.resultCommit === event.payload.resultCommit);
  } catch {
    return false;
  }
}

export function verifyReplayAuthorizationArtifact({ proposal, projection, event, authorization }, { macRepoRoot, trustedMacRef, replayAuthorizationPublicKeys = {} }) {
  try {
    if (!macRepoRoot || !SHA40.test(authorization.authorizationCommit ?? "") || !safeRelativePath(authorization.authorizationRef)) return false;
    const ancestor = spawnSync("git", ["merge-base", "--is-ancestor", authorization.authorizationCommit, trustedMacRef], { cwd: macRepoRoot, stdio: "ignore" });
    if (ancestor.status !== 0) return false;
    const shown = spawnSync("git", ["show", `${authorization.authorizationCommit}:${authorization.authorizationRef}`], { cwd: macRepoRoot, encoding: null, maxBuffer: 4 * 1024 * 1024 });
    if (shown.status !== 0 || rawSha256(shown.stdout) !== authorization.authorizationSha256) return false;
    const packet = JSON.parse(shown.stdout.toString("utf8"));
    if (!exactKeys(packet, ["schemaId", "schemaVersion", "proposalId", "proposalSha256", "deployableEventId", "resultCommit", "scope", "authorizedAt", "expiresAt", "issuer", "externalEffect", "paymentTransport", "signature"])
      || !exactKeys(packet.issuer, ["subject", "role", "keyId"])) return false;
    const { signature, ...unsigned } = packet;
    const publicKey = replayAuthorizationPublicKeys[packet.issuer?.keyId];
    if (!publicKey || !canonicalEd25519Signature(signature)) return false;
    const keyObject = createPublicKey(publicKey);
    if (keyObject.asymmetricKeyType !== "ed25519"
      || !verifySignature(null, Buffer.from(canonicalJson(unsigned)), keyObject, Buffer.from(signature, "base64"))) return false;
    return packet.schemaId === "xhs.repair-replay-authorization.v1"
      && packet.schemaVersion === 1
      && packet.proposalId === proposal.proposalId
      && packet.proposalSha256 === projection.proposalSha256
      && packet.deployableEventId === projection.deployableEventId
      && packet.resultCommit === projection.deployableResultCommit
      && packet.scope === "windows_deploy_and_read_only_replay"
      && packet.issuer?.role === "human"
      && typeof packet.issuer?.subject === "string"
      && packet.issuer.subject.length > 0
      && packet.externalEffect === false
      && packet.paymentTransport === 0
      && Number.isFinite(Date.parse(packet.authorizedAt))
      && Number.isFinite(Date.parse(packet.expiresAt))
      && Date.parse(packet.authorizedAt) <= Date.parse(event.occurredAt)
      && Date.parse(packet.expiresAt) > Date.parse(event.occurredAt);
  } catch {
    return false;
  }
}

export function verifyCompletionBundleArtifact({ proposal, projection, event, completion }, { completionRoot }) {
  try {
    const packet = readHashedJson(completionRoot, completion.bundleRef, completion.bundleSha256);
    const validation = validateCompletionBundle(proposal, packet);
    return validation.ok
      && packet.attempt === projection.attempt
      && packet.sourceCheckpointSha256 === projection.lastSourceCheckpoint?.bundleSha256
      && packet.resultCommit === projection.deployableResultCommit
      && packet.macReview.approvedEventId === projection.approvedEventId
      && packet.macReview.deployableEventId === projection.deployableEventId
      && packet.replay.authorizationRef === projection.replayAuthorizationRef
      && packet.replay.authorizationSha256 === projection.replayAuthorizationSha256
      && packet.replay.authorizationCommit === projection.replayAuthorizationCommit;
  } catch {
    return false;
  }
}

function readHashedJson(root, ref, expectedSha256) {
  if (!root || !safeRelativePath(ref) || !SHA256.test(expectedSha256 ?? "")) throw new Error("invalid artifact reference");
  const rootPath = resolve(root);
  const target = resolve(rootPath, ref);
  const rel = relative(rootPath, target);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("artifact escapes configured root");
  if (lstatSync(rootPath).isSymbolicLink()) throw new Error("configured root symlinks are forbidden");
  let cursor = rootPath;
  for (const part of rel.split(sep)) {
    cursor = resolve(cursor, part);
    if (lstatSync(cursor).isSymbolicLink()) throw new Error("artifact path component symlinks are forbidden");
  }
  const realRoot = realpathSync(rootPath);
  const realTarget = realpathSync(target);
  const realRel = relative(realRoot, realTarget);
  if (!realRel || realRel.startsWith("..") || isAbsolute(realRel)) throw new Error("artifact real path escapes configured root");
  const bytes = readFileSync(realTarget);
  if (rawSha256(bytes) !== expectedSha256) throw new Error("artifact hash mismatch");
  return JSON.parse(bytes.toString("utf8"));
}

function safeRelativePath(value) {
  return typeof value === "string"
    && value.length > 0
    && !isAbsolute(value)
    && !value.includes("\\")
    && !value.split("/").includes("..")
    && !value.startsWith("./");
}

function rawSha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function canonicalEd25519Signature(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) return false;
  const bytes = Buffer.from(value, "base64");
  return bytes.length === 64 && bytes.toString("base64") === value;
}

function exactKeys(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

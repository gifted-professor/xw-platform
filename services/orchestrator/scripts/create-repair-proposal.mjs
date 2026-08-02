#!/usr/bin/env node
/**
 * 从 Mac Review finding 生成不可变 xhs.repair-proposal.v1 与 registry knowledge 信封。
 * 纯离线：不 POST registry、不 SSH、不碰设备、不部署。
 *
 *   node scripts/create-repair-proposal.mjs <input.json> [--knowledge]
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createRepairProposal, proposalKnowledgeEnvelope, validateRepairProposal } from "./lib/repair-proposal.mjs";

export function createProposalPacket(input) {
  const proposal = createRepairProposal(input);
  return { proposal, knowledge: proposalKnowledgeEnvelope(proposal) };
}

export function packetFromExistingProposal(proposal) {
  const validation = validateRepairProposal(proposal);
  if (!validation.ok) throw new Error(`repair proposal invalid: ${validation.errors.join("; ")}`);
  return { proposal, knowledge: proposalKnowledgeEnvelope(proposal) };
}

const invokedPath = process.argv[1] ? fileURLToPath(new URL(`file://${process.argv[1]}`)) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const inputPath = args.find((arg) => !arg.startsWith("--"));
  if (!inputPath) {
    console.log("用法: node scripts/create-repair-proposal.mjs <input.json> [--knowledge]");
    process.exitCode = 4;
  } else {
    const input = JSON.parse(readFileSync(inputPath, "utf8"));
    const packet = args.includes("--existing") ? packetFromExistingProposal(input) : createProposalPacket(input);
    process.stdout.write(`${JSON.stringify(args.includes("--knowledge") ? packet : packet.proposal, null, 2)}\n`);
  }
}

import test from "node:test";
import assert from "node:assert/strict";
import { scanText, scanFiles } from "../secret-scan.mjs";

test("detects SSH private key header", () => {
  const hits = scanText("-----BEGIN OPENSSH PRIVATE KEY-----\nignored");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, "ssh_private_key");
});

test("detects age recipient and tailscale keys", () => {
  const hits = scanText("recipient: age1" + "a".repeat(60));
  assert.ok(hits.some((h) => h.id === "age_recipient"));
  const hits2 = scanText("tskey-auth-abcdef0123456789deadbeef");
  assert.ok(hits2.some((h) => h.id === "tailscale_key"));
});

test("detects github PAT and bearer token", () => {
  assert.ok(scanText("GH_TOKEN=ghp_" + "a".repeat(36)).some((h) => h.id === "github_pat"));
  assert.ok(scanText("Authorization: Bearer " + "a".repeat(40)).some((h) => h.id === "bearer_token"));
});

test("detects .env SECRET= value assignment", () => {
  const hits = scanText("FEISHU_APP_SECRET=abcdefghijklmnop1234567890");
  assert.ok(hits.some((h) => h.id === "env_secret_value"));
});

test("does not flag short/placeholder values", () => {
  // short value below the {8,} threshold
  assert.equal(scanText("SECRET=short").length, 0);
  assert.equal(scanText("# SECRET=<placeholder>").length, 0);
});

test("redacts matched snippet so the value is not leaked in the finding", () => {
  const hits = scanText("API_KEY=" + "z".repeat(60));
  assert.ok(hits.length >= 1);
  for (const h of hits) {
    assert.ok(!h.snippet.includes("zzzzzzzz"), "snippet must redact the secret value");
  }
});

test("scanFiles reports path and line per finding", () => {
  const hits = scanFiles({ "a.env": "TOKEN=abcdefghijklmnopqrstuvwxyz0123456789" });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].path, "a.env");
  assert.equal(hits[0].line, 1);
});
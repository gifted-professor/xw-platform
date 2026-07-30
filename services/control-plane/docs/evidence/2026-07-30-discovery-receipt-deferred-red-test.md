# Deferred Discovery receipt red test — provenance record

Status: deferred, not an enabled Discovery producer contract.

## Provenance and byte verification

The source is the `tool_result` with timestamp `2026-07-30T07:46:45.285Z` in
`/Users/a1234/.claude/projects/-Users-a1234-Desktop-Coding-xhs-registry/0bf7af63-dfc4-46c1-a96e-ffc56b24b4ca.jsonl`.
It reports the original dirty test content at lines 56–72 of
`tests/control-plane-adapters.test.mjs`. The transcript is local audit evidence;
it is not runtime input.

Exact unified diff bytes, reconstructed from that transcript content against the
Batch0 base blob, have these independently recomputed identifiers:

```text
git hash-object --stdin = 3bae0c181f12dda3e69ceaa841fae44c152425eb
sha256 = 419e7610be042e9f400381ecbbde4e4b29ead6e784ae644ee47bd4a9ac10e3e7
```

Reproduction uses the transcript test bytes, the `b29d9ef` base blob, and the
complete diff below as the byte stream:

```sh
git hash-object --stdin < exact-original-diff.patch
shasum -a 256 exact-original-diff.patch
```

The Batch0 REPORT previously stated SHA-256
`4df3227dc16e2cb88316959f70388927ae56cb616ec21739d0df10f9659532a7`.
That value was produced from a malformed transcription that omitted the two
backticks around the template literal on the assertion below. It is incorrect
for the original diff and is retained here only as a transparent correction.

## Exact original dirty diff

```diff
diff --git a/tests/control-plane-adapters.test.mjs b/tests/control-plane-adapters.test.mjs
index d6ed92f..c42f09e 100644
--- a/tests/control-plane-adapters.test.mjs
+++ b/tests/control-plane-adapters.test.mjs
@@ -53,6 +53,24 @@ test("XHS adapter uses a per-device loopback serve and fail-closed verifier", as
   }), { ok: false, ambiguous: true, mode: "custom" });
 });
 
+test("default production R0 XHS capabilities emit a controlled Discovery receipt", async () => {
+  const adapter = createXhsAdapter({
+    fetchImpl: async (_url, options) => {
+      const action = JSON.parse(options.body).action;
+      return new Response(JSON.stringify({
+        ok: true,
+        result: action === "feedCards" ? { cards: [] } : { online: true },
+        metrics: {},
+      }), { status: 200, headers: { "content-type": "application/json" } });
+    },
+  });
+  const r0 = ["xhs.observe.metrics", "xhs.observe.feed"].map((id) => registry.require(id));
+  for (const capability of r0) {
+    const execution = await adapter.execute({ capability, device: privateDevice, params: {}, leaseAuthorization });
+    assert.ok(execution.output?.discoveryReceipt, `${capability.id} lacks a parser-owned discoveryReceipt`);
+  }
+});
+
 test("XHS adapter surfaces inner serve rejection instead of masking it as verification failure", async () => {
   const adapter = createXhsAdapter({
     fetchImpl: async () => new Response(JSON.stringify({
```

The original red command was:

```sh
node --test tests/control-plane-adapters.test.mjs
```

Recorded result: 5 passing tests and 1 failure:
`xhs.observe.metrics lacks a parser-owned discoveryReceipt`.

## Disposition and controlled future recovery

Batch0 deliberately changed this unproven positive assertion into a negative
Phase1 regression: generic `xhs.observe.metrics` and `xhs.observe.feed` must
not claim `execution.output.discoveryReceipt`. No receipt, producer map, or
adapter contract was enabled by that change.

The exact reverse of the historical patch is removal of the 18 added lines in
the diff above from the `c42f09e` postimage, restoring the `d6ed92f` preimage.
It is valid only for that historical base and must not be mechanically applied
to the current negative regression. A future Task3 may replace the negative
test only after an independently reviewed parser-owned receipt contract proves
fresh observed surface, stable target/identity/page binding, source/content
hashes, and fail-closed handling. That task must first reproduce the two hashes
above from this exact hunk, then use an explicit reviewed patch; it must not
restore the assertion solely because the historical diff existed.

This record contains no token, private runtime id, raw screen path, account,
identity value, or other PII.

import test from "node:test";
import assert from "node:assert/strict";
import {
  assembleIdleFixture,
  composeMatchesProduct,
  findTuoguanClose,
  normalizeSelect,
  stillTuoguanPromo,
} from "../ops/feishu-to-xianyu-idle-lib.mjs";

test("assembleIdleFixture skips sku and leaves compose", () => {
  const fixture = assembleIdleFixture(
    { name: "测试商品", copyD: "出一件 全新\n货号X", price: 129 },
    [{ phonePath: "/sdcard/Pictures/XianyuIdle/01.jpg", sha256: "abc", name: "01.jpg" }],
    { stock: "10", freight: "包邮", album: "XianyuIdle" },
  );
  assert.equal(fixture.skipSku, true);
  assert.equal(fixture.leaveOnCompose, true);
  assert.equal(fixture.awaitingAccept, true);
  assert.equal(fixture.saveDraft, false);
  assert.equal(fixture.price, 129);
  assert.equal(fixture.stock, "10");
  assert.equal(fixture.maxImages, 1);
  assert.equal(fixture.descriptionBody.includes("货号X"), true);
});

test("normalizeSelect handles arrays and dash text", () => {
  assert.deepEqual(normalizeSelect(["M", "L"]), ["M", "L"]);
  assert.deepEqual(normalizeSelect("S-M-L"), ["S", "M", "L"]);
});

test("composeMatchesProduct passes on price or title fragment", () => {
  const product = { name: "全新 耐克运动鞋 42码", price: 129 };
  assert.deepEqual(composeMatchesProduct('<node text="129" bounds="[0,0][1,1]"/>', product), { ok: true, via: "price" });
  assert.deepEqual(composeMatchesProduct('<node text="耐克运动鞋" bounds="[0,0][1,1]"/>', product), { ok: true, via: "title" });
  assert.deepEqual(composeMatchesProduct('<node text="随便一个页面" bounds="[0,0][1,1]"/>', product), {
    ok: false,
    reason: "compose-mismatch",
  });
  // 不同价格 1290 不应误匹配 129（词边界挡住）
  assert.deepEqual(composeMatchesProduct('<node text="1290" bounds="[0,0][1,1]"/>', product), {
    ok: false,
    reason: "compose-mismatch",
  });
});

test("tuoguan dismiss prefers modal X ImageView", () => {
  const xml = `
    <node class="android.widget.ImageView" bounds="[987,1014][1053,1080]" clickable="false"/>
    <node class="android.view.View" content-desc="立即托管" bounds="[452,2109][628,2175]" clickable="false"/>
  `;
  assert.equal(stillTuoguanPromo(xml), true);
  const t = findTuoguanClose(xml);
  assert.equal(t.kind, "modal-x");
  assert.equal(t.cx, 1020);
  assert.equal(t.cy, 1047);
});

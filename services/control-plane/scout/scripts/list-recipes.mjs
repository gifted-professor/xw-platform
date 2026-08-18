// REX Phase 5 B6a: recipe 只作为优选提示——输出版本/hash/confidence 字段，
// 不把「没有 recipe」映射成 unsupported。scout 继续探索，recipe 缺失不影响派发。
// 用法：node scout/scripts/list-recipes.mjs [--endpoint http://127.0.0.1:17930] [--app xhs]

const endpoint = (process.argv.includes("--endpoint") ? process.argv[process.argv.indexOf("--endpoint") + 1] : "http://127.0.0.1:17930");
const appFilter = (process.argv.includes("--app") ? process.argv[process.argv.indexOf("--app") + 1] : "xhs");

fetch(`${endpoint}/api/knowledge?app=${encodeURIComponent(appFilter)}`)
  .then((r) => r.json())
  .then((d) => {
    const items = d.knowledge || [];
    console.log("Total:", items.length);
    const byCat = {};
    items.forEach((i) => { byCat[i.category] = (byCat[i.category] || 0) + 1; });
    console.log("By category:", JSON.stringify(byCat));
    console.log("\n=== RECIPES (all) ===");
    items.filter((i) => i.category === "recipe").forEach((r) => {
      const verifiedBy = JSON.stringify(r.verifiedBy || []);
      const verifyMode = r.verifyMode || (r.content && r.content.includes("步骤") ? "constraint" : "rule");
      const appliesTo = JSON.stringify(r.appliesTo || []);
      console.log(`${r.id} | verifyMode=${verifyMode} | appliesTo=${appliesTo} | verifiedBy=${verifiedBy} | ${r.title.slice(0, 60)}`);
    });
    console.log("\n=== UNVERIFIED (any category, verifiedBy=[]) ===");
    items.filter((i) => !i.verifiedBy || i.verifiedBy.length === 0).forEach((r) => {
      console.log(`${r.id} | ${r.category} | ${r.title.slice(0, 60)}`);
    });
  })
  .catch((e) => {
    // recipe 列表读不到只影响优选提示，不影响 Explorer（debt，不是任务失败）。
    process.stdout.write(JSON.stringify({ ok: false, debt: true, error: e.message }) + "\n");
  });

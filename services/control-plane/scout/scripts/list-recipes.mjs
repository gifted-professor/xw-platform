fetch("http://127.0.0.1:17930/api/knowledge?app=xhs")
  .then(r => r.json())
  .then(d => {
    const items = d.knowledge || [];
    console.log("Total:", items.length);
    const byCat = {};
    items.forEach(i => { byCat[i.category] = (byCat[i.category] || 0) + 1; });
    console.log("By category:", JSON.stringify(byCat));
    console.log("\n=== RECIPES (all) ===");
    items.filter(i => i.category === "recipe").forEach(r => {
      const vb = JSON.stringify(r.verifiedBy || []);
      const hasSteps = r.content && r.content.includes("步骤");
      console.log(`${r.id} | verifiedBy=${vb} | ${r.title.slice(0, 60)}`);
    });
    console.log("\n=== UNVERIFIED (any category, verifiedBy=[]) ===");
    items.filter(i => !i.verifiedBy || i.verifiedBy.length === 0).forEach(r => {
      console.log(`${r.id} | ${r.category} | ${r.title.slice(0, 60)}`);
    });
  })
  .catch(e => console.error(e.message));

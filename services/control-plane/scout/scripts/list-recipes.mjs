fetch("http://127.0.0.1:17930/api/knowledge?app=xhs&category=recipe")
  .then(r => r.json())
  .then(d => {
    const rs = d.knowledge || [];
    console.log("recipes:", rs.length);
    rs.forEach(r => {
      const vb = JSON.stringify(r.verifiedBy || []);
      console.log(`${r.id} | verifiedBy=${vb} | ${r.title.slice(0, 60)}`);
    });
  })
  .catch(e => console.error(e.message));

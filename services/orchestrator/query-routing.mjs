import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(process.env.CONTROL_PLANE_DB || String.raw`C:\Users\Public\xw-runtime\state\control-plane\control.db`, { readOnly: true });
for (const r of db.prepare("SELECT device_id, alias, online, quarantined, routing_json FROM devices").all()) {
  console.log(JSON.stringify(r));
}

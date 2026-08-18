import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(String.raw`C:\Users\Public\xhs-agent-control\control.db`, { readOnly: true });
for (const r of db.prepare("SELECT device_id, alias, online, quarantined, routing_json FROM devices").all()) {
  console.log(JSON.stringify(r));
}

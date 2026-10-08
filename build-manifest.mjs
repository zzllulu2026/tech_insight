// Rebuild leads/manifest.json from all leads/*.json — run after adding new lead files
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(ROOT, "leads");
const files = fs.readdirSync(dir).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f));
const leads = files.flatMap(f => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")));
leads.sort((a, b) => (b.date || "").localeCompare(a.date || "") || (b.score || 0) - (a.score || 0));
const tagCounts = {};
for (const l of leads) for (const t of l.tags || []) tagCounts[t] = (tagCounts[t] || 0) + 1;
const manifest = {
  generatedAt: new Date().toISOString(),
  total: leads.length,
  tagCounts,
  leads
};
fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest));
console.log(`manifest: ${leads.length} leads from ${files.length} day file(s)`);

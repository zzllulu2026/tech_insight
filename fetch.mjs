// tech-insight fetcher — zero dependency, Node >= 18
// Usage: node fetch.mjs [date]   (date defaults to today, YYYY-MM-DD)
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
const UA = { "User-Agent": "tech-insight-bot/0.1 (personal research)", Accept: "*/*" };
const YESTERDAY = new Date(Date.now() - 864e5).toISOString().slice(0, 10);

function today() {
  return process.argv[2] || new Date().toISOString().slice(0, 10);
}
function hash(s) {
  return crypto.createHash("sha1").update(s).digest("hex").slice(0, 12);
}
function stripHtml(s = "") {
  return s.replace(/<[^>]+>/g, " ").replace(/&\w+;/g, " ").replace(/\s+/g, " ").trim();
}
function pick(block, tag) {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return m ? m[1].trim() : "";
}
function decodeCdata(s = "") {
  const c = s.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
  return (c ? c[1] : s).trim();
}

// ---------- generic RSS/Atom parser ----------
function parseFeed(xml) {
  const items = [];
  const itemBlocks = [...xml.matchAll(/<(item|entry)[\s\S]*?<\/\1>/gi)].map(m => m[0]);
  for (const b of itemBlocks) {
    const title = stripHtml(decodeCdata(pick(b, "title")));
    if (!title) continue;
    let link = "";
    const linkTag = b.match(/<link[^>]*href="([^"]+)"/i);
    if (linkTag) link = linkTag[1];
    if (!link) link = stripHtml(decodeCdata(pick(b, "link")));
    const desc = stripHtml(decodeCdata(pick(b, "description") || pick(b, "summary") || pick(b, "content"))).slice(0, 400);
    const pub = pick(b, "pubDate") || pick(b, "published") || pick(b, "updated");
    const guid = stripHtml(decodeCdata(pick(b, "guid") || pick(b, "id"))) || link || title;
    items.push({ title, url: link, summary: desc, published: pub ? new Date(pub).toISOString() : null, guid });
  }
  return items;
}

// ---------- per-type fetchers ----------
async function fetchJson(url) {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

const fetchers = {
  async hn(src) {
    const d = await fetchJson(src.url);
    return (d.hits || []).filter(h => h.title).map(h => ({
      title: h.title, url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
      summary: "", published: h.created_at,
      guid: `hn-${h.objectID}`,
      extra: { points: h.points || 0, comments: h.num_comments || 0 }
    }));
  },
  async github(src) {
    const url = src.url.replace("{YESTERDAY}", YESTERDAY);
    const d = await fetchJson(url);
    return (d.items || []).map(r => ({
      title: `${r.full_name}: ${(r.description || "").slice(0, 120)}`,
      url: r.html_url, summary: r.description || "", published: r.created_at,
      guid: `gh-${r.id}`,
      extra: { stars: r.stargazers_count, language: r.language }
    }));
  },
  async json(src) {
    const d = await fetchJson(src.url);
    let rows = d;
    if (src.path === "$[*].paper") rows = d.map(x => x.paper || x);
    return rows.slice(0, CONFIG.maxItemsPerSource).map(p => {
      const pid = p.id || p.paper?.id || hash(p.title || "");
      return {
        title: (p.title || "").replace(/\s+/g, " ").trim(),
        url: `https://huggingface.co/papers/${pid}`,
        summary: (p.summary || "").replace(/\s+/g, " ").trim().slice(0, 400),
        published: p.publishedAt || p.upvoted_date || null,
        guid: `hfp-${pid}`,
        extra: { upvotes: p.upvotes ?? 0 }
      };
    });
  },
  async rss(src) {
    const r = await fetch(src.url, { headers: UA });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const text = await r.text();
    return parseFeed(text);
  },
  async atom(src) {
    const r = await fetch(src.url, { headers: UA });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const text = await r.text();
    return parseFeed(text).map(it => {
      const idm = it.guid.match(/abs\/([\w.\-/]+v?\d*)/);
      const abs = idm ? idm[1].split("v")[0] : null;
      return { ...it, guid: abs ? `arxiv-${abs}` : it.guid, url: abs ? `https://arxiv.org/abs/${abs}` : it.url };
    });
  }
};

// ---------- categorize & score ----------
function categorize(text, domains) {
  const t = text.toLowerCase();
  const hits = [];
  for (const [dom, kws] of Object.entries(domains)) {
    if (kws.some(k => t.includes(k.toLowerCase()))) hits.push(dom);
  }
  return hits;
}

function scoreItem(it, src) {
  const sc = CONFIG.scoring;
  let s = 3;
  if (it.extra?.points) s += Math.min(3, it.extra.points * sc.hnPointsWeight);
  if (it.extra?.stars) s += Math.min(3, it.extra.stars * sc.githubStarsWeight);
  if (it.extra?.upvotes) s += Math.min(2, it.extra.upvotes * sc.upvotesWeight);
  if (it.categories?.length) s += sc.domainKeywordBonus;
  if (it.published) {
    const h = (Date.now() - new Date(it.published).getTime()) / 36e5;
    if (h > 0) s -= Math.min(3, h * sc.recencyHoursDecay);
  }
  return Math.max(0, Math.min(sc.maxScore, Math.round(s * 10) / 10));
}

// ---------- main ----------
async function main() {
  const date = today();
  const results = [];
  const all = [];
  await Promise.all(CONFIG.sources.map(async src => {
    try {
      let items = await fetchers[src.type](src);
      items = items.slice(0, CONFIG.maxItemsPerSource).map(it => ({
        ...it,
        id: `${date}#${src.id}-${hash(it.guid || it.url || it.title)}`,
        source: src.id, sourceName: src.name, lang: src.lang, group: src.group
      }));
      results.push({ id: src.id, name: src.name, ok: true, count: items.length });
      all.push(...items);
    } catch (e) {
      results.push({ id: src.id, name: src.name, ok: false, count: 0, error: String(e.message || e) });
    }
  }));

  for (const it of all) {
    it.categories = categorize(`${it.title} ${it.summary}`, CONFIG.domains);
    it.score = scoreItem(it, src0(it));
  }
  function src0(it) { return CONFIG.sources.find(s => s.id === it.source) || {}; }

  // cross-day dedup against seen.json
  const seenPath = path.join(ROOT, "state", "seen.json");
  const seen = fs.existsSync(seenPath) ? JSON.parse(fs.readFileSync(seenPath, "utf8")) : {};
  const fresh = all.filter(it => !seen[it.guid]);
  for (const it of all) seen[it.guid] = date;
  fs.mkdirSync(path.dirname(seenPath), { recursive: true });
  fs.writeFileSync(seenPath, JSON.stringify(seen, null, 1));

  // keep seen.json from growing unbounded: drop entries older than 30 days
  const cutoff = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
  for (const [g, d] of Object.entries(seen)) if (d < cutoff) delete seen[g];

  all.sort((a, b) => b.score - a.score);
  const out = { fetchedAt: new Date().toISOString(), date, sources: results, total: all.length, fresh: fresh.length, items: all };
  const outFile = path.join(ROOT, "out", `raw-${date}.json`);
  fs.writeFileSync(outFile, JSON.stringify(out, null, 1));
  console.log(`saved ${outFile}`);
  console.log(`total=${all.length} fresh(frist-run-items)=${fresh.length}`);
  for (const r of results) console.log(`${r.ok ? "OK " : "ERR"} ${r.name}: ${r.ok ? r.count : r.error}`);
}

main().catch(e => { console.error(e); process.exit(1); });

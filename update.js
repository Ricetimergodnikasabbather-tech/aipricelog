// Daily: fetch open LLM price data, save a dated snapshot, log changes vs the last snapshot, rebuild the site.
// Usage: node update.js   (run from this folder)
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";

const SOURCE = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const PROVIDERS = { openai: "OpenAI", anthropic: "Anthropic", gemini: "Google", xai: "xAI", deepseek: "DeepSeek", mistral: "Mistral" };
const SITE_URL = "https://aipricelog.com";
const today = new Date().toISOString().slice(0, 10);

mkdirSync("data/snapshots", { recursive: true });
const OUT = process.env.OUT || "site";
mkdirSync(OUT, { recursive: true });

// --- 1. Fetch and normalize ---
const raw = await (await fetch(SOURCE)).json();
const models = {};
for (const [key, v] of Object.entries(raw)) {
  if (!PROVIDERS[v.litellm_provider] || v.mode !== "chat") continue;
  if (!v.input_cost_per_token || !v.output_cost_per_token) continue;
  const name = key.split("/").pop();
  if (/-\d{8}$|-\d{4}-\d{2}-\d{2}$/.test(name)) continue; // skip dated duplicates of the same model
  models[name] = {
    provider: PROVIDERS[v.litellm_provider],
    input: +(v.input_cost_per_token * 1e6).toFixed(4),
    output: +(v.output_cost_per_token * 1e6).toFixed(4),
    context: v.max_input_tokens || null,
  };
}
if (Object.keys(models).length < 50) throw new Error(`only ${Object.keys(models).length} models parsed; source format may have changed, not overwriting`);

// --- 2. Diff against the previous snapshot ---
const snaps = readdirSync("data/snapshots").filter(f => f.endsWith(".json") && !f.startsWith(today)).sort();
const prev = snaps.length ? JSON.parse(readFileSync(`data/snapshots/${snaps.at(-1)}`, "utf-8")) : null;
writeFileSync(`data/snapshots/${today}.json`, JSON.stringify(models, null, 1));

const changesFile = "data/changes.json";
const changes = existsSync(changesFile) ? JSON.parse(readFileSync(changesFile, "utf-8")) : [];
if (prev) {
  const fresh = [];
  for (const [name, m] of Object.entries(models)) {
    const p = prev[name];
    if (!p) { fresh.push({ date: today, model: name, provider: m.provider, type: "added", note: `$${m.input} in / $${m.output} out` }); continue; }
    for (const f of ["input", "output", "context"]) {
      if (p[f] !== m[f]) fresh.push({ date: today, model: name, provider: m.provider, type: f, old: p[f], new: m[f] });
    }
  }
  for (const [name, p] of Object.entries(prev)) {
    if (!models[name]) fresh.push({ date: today, model: name, provider: p.provider, type: "removed" });
  }
  changes.unshift(...fresh);
  console.log(`${fresh.length} change(s) logged`);
} else {
  console.log("first snapshot: tracking starts today");
}
writeFileSync(changesFile, JSON.stringify(changes, null, 1));

// --- 3. Build the site ---
const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const usd = n => (n == null ? "–" : n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(3)}`);
const ctx = n => (n == null ? "–" : n >= 1e6 ? `${(n / 1e6).toFixed(n % 1e6 ? 1 : 0)}M` : `${Math.round(n / 1000)}K`);

const STYLE = `
:root{--bg:#fff;--fg:#141414;--muted:#666;--line:#e6e6e6;--accent:#0b5fff;--up:#c0392b;--down:#1e8449}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--fg:#eceff4;--muted:#9aa3ad;--line:#262a31;--accent:#6ea8ff;--up:#ff7b6b;--down:#5fd38d}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
header,main,footer{max-width:1000px;margin:0 auto;padding:0 16px}
header{padding-top:20px;display:flex;gap:16px;align-items:baseline;flex-wrap:wrap}
header a.logo{font-weight:800;font-size:1.3rem;color:var(--fg);text-decoration:none}nav a{color:var(--muted);margin-right:12px}
h1{font-size:1.8rem;line-height:1.2;margin:24px 0 8px}p.lead{color:var(--muted);margin:0 0 16px}
input{width:100%;max-width:360px;padding:9px 12px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg);font:inherit}
.tablewrap{overflow-x:auto;margin:14px 0 28px}table{border-collapse:collapse;width:100%;font-size:.95rem}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);white-space:nowrap}
th{cursor:pointer;user-select:none;color:var(--muted);font-weight:600}td.n{font-variant-numeric:tabular-nums}
.up{color:var(--up)}.down{color:var(--down)}.muted{color:var(--muted)}footer{color:var(--muted);font-size:.85rem;padding:30px 16px 50px}
a{color:var(--accent)}`;

const page = (title, desc, path, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}"><link rel="canonical" href="${SITE_URL}${path}"><style>${STYLE}</style></head><body>
<header><a class="logo" href="/">AI Price Log</a><nav><a href="/">Prices</a><a href="/changes.html">Change log</a></nav></header>
<main>${body}</main>
<footer>Updated ${today}. Prices are per 1 million tokens, in US dollars, for standard API usage. Data comes from the open <a href="https://github.com/BerriAI/litellm">LiteLLM price database</a>, checked daily. Always confirm on the provider's official pricing page before buying.</footer>
</body></html>`;

const describe = c => {
  if (c.type === "added") return `New model listed: ${c.note}`;
  if (c.type === "removed") return "Removed from listings";
  const label = c.type === "context" ? "Context window" : `${c.type[0].toUpperCase()}${c.type.slice(1)} price`;
  const fmt = c.type === "context" ? ctx : usd;
  const dir = c.new > c.old ? "up" : "down";
  return `${label}: ${fmt(c.old)} → <span class="${dir}">${fmt(c.new)}</span>`;
};
const changeRows = list => list.map(c => `<tr><td>${c.date}</td><td>${esc(c.provider)}</td><td>${esc(c.model)}</td><td>${describe(c)}</td></tr>`).join("");

const rows = Object.entries(models)
  .sort((a, b) => a[1].provider.localeCompare(b[1].provider) || a[0].localeCompare(b[0]))
  .map(([n, m]) => `<tr><td>${esc(m.provider)}</td><td>${esc(n)}</td><td class="n" data-v="${m.input}">${usd(m.input)}</td><td class="n" data-v="${m.output}">${usd(m.output)}</td><td class="n" data-v="${m.context ?? 0}">${ctx(m.context)}</td></tr>`)
  .join("");

const SCRIPT = `<script>
const q=document.getElementById('q'),tb=document.querySelector('#prices tbody');
q.addEventListener('input',()=>{const s=q.value.toLowerCase();for(const r of tb.rows)r.hidden=!r.textContent.toLowerCase().includes(s)});
document.querySelectorAll('#prices th').forEach((th,i)=>th.addEventListener('click',()=>{const asc=th.dataset.asc!=='1';th.dataset.asc=asc?'1':'0';
const rs=[...tb.rows];rs.sort((a,b)=>{const x=a.cells[i],y=b.cells[i];const v=(x.dataset.v!==undefined)?(+x.dataset.v-+y.dataset.v):x.textContent.localeCompare(y.textContent);return asc?v:-v});rs.forEach(r=>tb.appendChild(r))}));
</script>`;

const recent = changes.slice(0, 10);
writeFileSync(`${OUT}/index.html`, page(
  "AI API Prices Compared: OpenAI, Claude, Gemini, Grok (Updated Daily) | AI Price Log",
  `Current API prices per million tokens for ${Object.keys(models).length} AI models from OpenAI, Anthropic, Google, xAI, DeepSeek and Mistral, checked every day, with a log of every price change.`,
  "/",
  `<h1>AI API prices, compared and updated daily</h1>
<p class="lead">Input and output prices per million tokens for ${Object.keys(models).length} models from OpenAI, Anthropic (Claude), Google (Gemini), xAI (Grok), DeepSeek and Mistral. Checked every day. Every change gets logged with its date, so you can see when a price moved and by how much.</p>
<h2>Recent price changes</h2>
${recent.length ? `<div class="tablewrap"><table><thead><tr><th>Date</th><th>Provider</th><th>Model</th><th>Change</th></tr></thead><tbody>${changeRows(recent)}</tbody></table></div><p><a href="/changes.html">Full change log →</a></p>` : `<p class="muted">Tracking started ${today}. Changes show up here as soon as a price moves.</p>`}
<h2>All models</h2>
<input id="q" type="search" placeholder="Filter: claude, gpt, gemini…" aria-label="Filter models">
<div class="tablewrap"><table id="prices"><thead><tr><th>Provider</th><th>Model</th><th>Input / 1M</th><th>Output / 1M</th><th>Context</th></tr></thead><tbody>${rows}</tbody></table></div>
<p class="muted">Click a column header to sort. Input is what you pay for the text you send; output is what you pay for the text the model writes back. Output usually costs several times more, so for long answers it matters most.</p>
${SCRIPT}`));

writeFileSync(`${OUT}/changes.html`, page(
  "AI API Price Change Log: Every Price Change, Dated | AI Price Log",
  "A dated log of every AI API price change, new model and context window change across OpenAI, Anthropic, Google, xAI, DeepSeek and Mistral.",
  "/changes.html",
  `<h1>AI price change log</h1><p class="lead">Every price change, new model and context-window change we detect, newest first. Tracking started ${snaps[0]?.slice(0, 10) || today}.</p>
${changes.length ? `<div class="tablewrap"><table><thead><tr><th>Date</th><th>Provider</th><th>Model</th><th>Change</th></tr></thead><tbody>${changeRows(changes)}</tbody></table></div>` : `<p class="muted">No changes detected yet.</p>`}`));

writeFileSync(`${OUT}/sitemap.xml`, `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${SITE_URL}/</loc><lastmod>${today}</lastmod></url><url><loc>${SITE_URL}/changes.html</loc><lastmod>${today}</lastmod></url></urlset>`);
writeFileSync(`${OUT}/robots.txt`, `User-agent: *\nAllow: /\nSitemap: ${SITE_URL}/sitemap.xml\n`);
writeFileSync(`${OUT}/CNAME`, "aipricelog.com\n");
writeFileSync(`${OUT}/.nojekyll`, "");
console.log(`built site: ${Object.keys(models).length} models, ${changes.length} logged changes`);

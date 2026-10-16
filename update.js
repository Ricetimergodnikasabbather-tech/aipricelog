// Daily: fetch open LLM price data, save a dated snapshot, log changes vs the last snapshot, rebuild the site.
// Usage: node update.js   (OUT=. in GitHub Actions; defaults to ./site for local previews)
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, rmSync } from "node:fs";
import { normalize, diff, cleanHistory, PROVIDERS } from "./lib.js";

const SOURCE = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const SITE_URL = "https://aipricelog.com";
const REPO = "https://github.com/Ricetimergodnikasabbather-tech/aipricelog";
const now = new Date();
const today = now.toISOString().slice(0, 10);
const checkedAt = now.toISOString().slice(11, 16);

mkdirSync("data/snapshots", { recursive: true });
const OUT = process.env.OUT || "site";
mkdirSync(OUT, { recursive: true });

// --- 1. Fetch and normalize ---
const raw = await (await fetch(SOURCE)).json();
const models = normalize(raw, today);
const count = Object.keys(models).length;
if (count < 50) throw new Error(`only ${count} models parsed; source format may have changed, not overwriting`);

// --- 2. Diff against the previous snapshot ---
const snaps = readdirSync("data/snapshots").filter(f => f.endsWith(".json") && !f.startsWith(today)).sort();
const prev = snaps.length ? JSON.parse(readFileSync(`data/snapshots/${snaps.at(-1)}`, "utf-8")) : null;
writeFileSync(`data/snapshots/${today}.json`, JSON.stringify(models, null, 1));

const changesFile = "data/changes.json";
let changes = existsSync(changesFile) ? JSON.parse(readFileSync(changesFile, "utf-8")) : [];
if (prev) {
  // The LiteLLM commit behind today's data, so every change links to its source. Optional: the build works without it.
  const commit = await fetch("https://api.github.com/repos/BerriAI/litellm/commits?path=model_prices_and_context_window.json&per_page=1")
    .then(r => r.json()).then(j => j[0]?.sha).catch(() => undefined);
  const fresh = diff(prev, models, today, commit);
  changes = cleanHistory([...fresh, ...changes.filter(c => c.date !== today)]);
  console.log(`${fresh.length} change(s) logged`);
} else {
  console.log("no earlier snapshot: change log starts today");
}
writeFileSync(changesFile, JSON.stringify(changes, null, 1));
const trackingStart = changes.at(-1)?.date ?? snaps[0]?.slice(0, 10) ?? today;

// --- 3. Helpers ---
const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const usd = n => (n == null ? "–" : n >= 1 ? `$${n.toFixed(2)}` : n >= 0.01 ? `$${n.toFixed(3).replace(/0$/, "")}` : `$${n.toFixed(4)}`);
const money = n => (n < 0.01 ? `$${+n.toPrecision(2)}` : n < 100 ? `$${n.toFixed(2)}` : `$${Math.round(n).toLocaleString("en-US")}`);
const ctx = n => (n == null ? "–" : n >= 1e6 ? `${+(n / 1e6).toFixed(2)}M` : `${Math.round(n / 1000)}K`);
const blended = m => (3 * m.input + m.output) / 4;
const tier = m => (m.output >= 15 ? "Premium" : m.output >= 2 ? "Standard" : "Budget");
const longDate = d => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
const shortDate = d => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const monthYear = new Date(`${today}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
const slugOf = p => p.toLowerCase();
// What people actually type: "claude api pricing", not "anthropic api pricing".
const SEARCH_NAME = { OpenAI: "OpenAI", Anthropic: "Claude", Google: "Gemini", xAI: "Grok", DeepSeek: "DeepSeek", Mistral: "Mistral AI" };
const short = n => (Number.isInteger(n) ? `$${n}` : usd(n));
const clip = (s, n = 155) => (s.length <= n ? s : `${s.slice(0, n - 1).replace(/[\s,.;:]+\S*$/, "")}…`);
const costOf = (m, i, o) => { const long = m.longAt && i > m.longAt; return (i * (long ? m.longIn : m.input) + o * (long ? m.longOut ?? m.output : m.output)) / 1e6; };
const COLORS = { OpenAI: "#10a37f", Anthropic: "#d97757", Google: "#4285f4", xAI: "#8a8f98", DeepSeek: "#4d6bfe", Mistral: "#fa520f" };
const dot = p => `<span class="dot" style="background:${COLORS[p]}"></span>`;
const modelUrl = key => `/models/${key}/`;
const list = Object.entries(models).map(([key, m]) => ({ key, ...m, blend: blended(m) })).sort((a, b) => a.blend - b.blend);
const changesFor = key => changes.filter(c => c.key === key);
const recentChange = key => changesFor(key).find(c => c.date >= new Date(now - 30 * 864e5).toISOString().slice(0, 10) && c.type !== "removed");
const caps = m => [m.vision && "Vision", m.reasoning && "Reasoning", m.caching && "Prompt caching", m.tools && "Tool use", m.pdf && "PDF input", m.web && "Web search"].filter(Boolean);

const describe = c => {
  if (c.type === "added") return `New model listed: ${esc(c.note)}`;
  if (c.type === "removed") return "Removed from listings";
  if (c.type === "version") return `Name now points to a newer version: ${esc(c.note)}`;
  const label = c.type === "context" ? "Context window" : `${c.type[0].toUpperCase()}${c.type.slice(1)} price`;
  const fmt = c.type === "context" ? ctx : usd;
  if (c.old == null || c.new == null) return `${label}: ${fmt(c.old)} → ${fmt(c.new)}`;
  const pct = Math.round(((c.new - c.old) / c.old) * 100);
  const cls = c.type === "context" ? (c.new > c.old ? "down" : "up") : c.new > c.old ? "up" : "down";
  return `${label}: ${fmt(c.old)} → <span class="${cls}">${fmt(c.new)} (${pct > 0 ? "+" : ""}${pct}%)</span>`;
};
const changeTable = rows => `<div class="tablewrap"><table class="log"><thead><tr><th>Date</th><th>Model</th><th>Change</th></tr></thead><tbody>${rows
  .map(c => `<tr><td class="n">${c.date}</td><td>${dot(c.provider)}${models[c.key] ? `<a href="${modelUrl(c.key)}">${esc(c.model)}</a>` : esc(c.model)}</td><td>${describe(c)}${c.commit ? ` <a class="src" href="https://github.com/BerriAI/litellm/commits/${c.commit}/model_prices_and_context_window.json" rel="nofollow noopener" title="See the source data change">source</a>` : ""}</td></tr>`)
  .join("")}</tbody></table></div>`;
const badge = m => {
  const c = recentChange(m.key);
  let b = "";
  if (c?.type === "added") b += `<span class="badge new">New ${shortDate(c.date)}</span>`;
  else if (c && c.type !== "context") b += `<span class="badge ${c.new > c.old ? "up" : "down"}">${c.new > c.old ? "↑" : "↓"} ${shortDate(c.date)}</span>`;
  if (m.preview && !/preview/i.test(m.name)) b += `<span class="badge">Preview</span>`;
  if (m.deprecates) b += `<span class="badge warn" title="Scheduled to be retired">Retires ${shortDate(m.deprecates)}${m.deprecates.slice(0, 4) === today.slice(0, 4) ? "" : ` ${m.deprecates.slice(0, 4)}`}</span>`;
  return b;
};

// --- 4. Page shell ---
const STYLE = `
:root{--bg:#fbfbfa;--card:#fff;--fg:#16181d;--muted:#5f6670;--line:#e7e7e4;--soft:#f2f2ef;--accent:#0b5fff;--up:#c0392b;--down:#1e8449;--warn:#a15c00}
@media (prefers-color-scheme:dark){:root{--bg:#0e1014;--card:#15181e;--fg:#e9ecf1;--muted:#98a1ad;--line:#262b33;--soft:#1c2028;--accent:#7aa7ff;--up:#ff8a7a;--down:#62d394;--warn:#f0b35a}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:15.5px/1.55 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
.wrap{max-width:1120px;margin:0 auto;padding:0 16px}
header.top{border-bottom:1px solid var(--line);background:var(--card)}
header.top .wrap{display:flex;gap:18px;align-items:center;flex-wrap:wrap;min-height:56px}
.logo{font-weight:800;font-size:1.1rem;letter-spacing:-.01em;color:var(--fg);text-decoration:none}.logo b{color:var(--accent)}
nav{display:flex;gap:14px;flex-wrap:wrap}nav a{color:var(--muted);text-decoration:none;font-size:.93rem}nav a:hover{color:var(--fg)}
h1{font-size:clamp(1.6rem,3.5vw,2.2rem);line-height:1.15;letter-spacing:-.02em;margin:28px 0 8px}
h2{font-size:1.2rem;margin:34px 0 10px;letter-spacing:-.01em}
p.lead{color:var(--muted);margin:0 0 14px;max-width:760px}
.stats{display:flex;gap:8px 22px;flex-wrap:wrap;color:var(--muted);font-size:.9rem;margin:6px 0 18px}.stats b{color:var(--fg)}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px}
.calc{display:grid;gap:12px}.calc .row{display:flex;gap:10px;flex-wrap:wrap;align-items:end}
label{font-size:.82rem;color:var(--muted);display:flex;flex-direction:column;gap:4px}
input,select{padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg);font:inherit;min-width:0}
input[type=number]{width:130px}input[type=search]{width:240px;max-width:100%}
button.chip,.chip{border:1px solid var(--line);background:var(--bg);color:var(--fg);border-radius:999px;padding:5px 12px;font:inherit;font-size:.86rem;cursor:pointer}
.chip[aria-pressed=true]{background:var(--fg);color:var(--bg);border-color:var(--fg)}
.filters{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:14px 0 8px}
.filters .sep{width:1px;height:22px;background:var(--line);margin:0 4px}
.check{flex-direction:row;align-items:center;gap:6px;font-size:.86rem;color:var(--fg)}
.tablewrap{overflow-x:auto;border:1px solid var(--line);border-radius:12px;background:var(--card)}
table{border-collapse:collapse;width:100%;font-size:.92rem}
th,td{text-align:left;padding:9px 12px;border-bottom:1px solid var(--line);white-space:nowrap}
tr:last-child td{border-bottom:0}
thead th{position:sticky;top:0;background:var(--soft);color:var(--muted);font-weight:600;font-size:.8rem;text-transform:uppercase;letter-spacing:.03em}
#prices th[data-k]{cursor:pointer;user-select:none}#prices th[data-k]:hover{color:var(--fg)}
th .arr{opacity:.9}td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}
#prices td:first-child,#prices th:first-child{position:sticky;left:0;background:var(--card);z-index:1}#prices th:first-child{background:var(--soft)}
td a{color:var(--fg);text-decoration:none;font-weight:600}td a:hover{color:var(--accent);text-decoration:underline}
.prov{display:block;color:var(--muted);font-size:.78rem;font-weight:400}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:7px;vertical-align:1px}
.badge{display:inline-block;margin-left:6px;padding:1px 7px;border-radius:999px;font-size:.72rem;background:var(--soft);color:var(--muted);font-weight:500}
.badge.new{color:var(--accent)}.badge.down{color:var(--down)}.badge.up{color:var(--up)}.badge.warn{color:var(--warn)}
td.cost{font-weight:700}a.src{font-size:.75rem;color:var(--muted);font-weight:400;margin-left:6px}
.up{color:var(--up)}.down{color:var(--down)}.muted{color:var(--muted)}a{color:var(--accent)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px}
.pick h3{margin:0 0 4px;font-size:.8rem;text-transform:uppercase;letter-spacing:.03em;color:var(--muted)}
.pick a{font-weight:700;color:var(--fg);text-decoration:none}.pick a:hover{color:var(--accent)}.pick p{margin:2px 0 0;color:var(--muted);font-size:.88rem}
figure svg{max-height:240px}.big{font-size:2rem;font-weight:800;letter-spacing:-.02em}
.kv{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px}
.kv div span{display:block;color:var(--muted);font-size:.8rem}
.crumbs{font-size:.85rem;color:var(--muted);margin-top:18px}.crumbs a{color:var(--muted)}
.prose{max-width:760px}.prose p{margin:0 0 12px}
footer{border-top:1px solid var(--line);margin-top:48px;color:var(--muted);font-size:.85rem}footer .wrap{padding:22px 16px 40px}footer a{color:var(--muted)}
tr.nofit td{opacity:.45}
@media (max-width:640px){.hide-sm{display:none}#prices td:first-child{white-space:normal;min-width:150px;max-width:48vw}#prices .badge{margin:2px 4px 0 0}th,td{padding:8px 9px}input[type=number]{width:100%}.calc .row label{flex:1 1 40%}}`;

const page = ({ title, desc, path, body, head = "" }) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}"><link rel="canonical" href="${SITE_URL}${path}">
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}"><meta property="og:url" content="${SITE_URL}${path}"><meta property="og:type" content="website">
<link rel="alternate" type="application/rss+xml" title="AI Price Log changes" href="/feed.xml">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%230b5fff'/%3E%3Ctext x='16' y='22' font-size='16' font-family='Arial' font-weight='700' fill='white' text-anchor='middle'%3E$%3C/text%3E%3C/svg%3E">
<style>${STYLE}</style>${head}</head><body>
<header class="top"><div class="wrap"><a class="logo" href="/">AI Price<b>Log</b></a><nav><a href="/">All prices</a>${Object.values(PROVIDERS).map(p => `<a href="/${slugOf(p)}/">${p}</a>`).join("")}<a href="/changes.html">Change log</a></nav></div></header>
<main class="wrap">${body}</main>
<footer><div class="wrap">Prices are per 1 million tokens in US dollars, standard API rates. Data from the open <a href="https://github.com/BerriAI/litellm">LiteLLM price database</a>, checked daily (last check ${today} ${checkedAt} UTC). Always confirm on the provider's pricing page before you commit.<br>
<a href="/about.html">How this works</a> · <a href="/changes.html">Change log</a> · <a href="/feed.xml">RSS</a> · <a href="/prices.json">JSON</a> · <a href="/prices.csv">CSV</a> · <a href="${REPO}/issues/new?title=Wrong%20price">Report a wrong price</a></div></footer>
</body></html>`;

// --- 5. Main price table (shared by home and provider pages) ---
const PRESETS = [
  ["Chatbot reply", 1000, 500, 10000],
  ["Summarize a long document", 20000, 1000, 1000],
  ["Coding agent step", 50000, 2000, 2000],
];
const priceTable = rows => `
<section class="card calc" aria-label="Cost calculator">
  <div><b>What would it cost you?</b> <span class="muted">Pick a typical task or enter your own numbers. A token is roughly ¾ of a word. Long-prompt surcharges are applied where providers charge them.</span></div>
  <div class="row" id="presets">${PRESETS.map(([n, i, o, r], k) => `<button class="chip" type="button" aria-pressed="${k === 0}" data-i="${i}" data-o="${o}" data-r="${r}">${n}</button>`).join("")}</div>
  <div class="row">
    <label>Input tokens per request<input type="number" id="ti" min="0" value="${PRESETS[0][1]}"></label>
    <label>Output tokens per request<input type="number" id="to" min="0" value="${PRESETS[0][2]}"></label>
    <label>Requests per month<input type="number" id="tr" min="0" value="${PRESETS[0][3]}"></label>
  </div>
</section>
<div class="filters" id="filters">
  <input type="search" id="q" placeholder="Search models…" aria-label="Search models">
  <span class="sep"></span>
  ${["Budget", "Standard", "Premium"].map(t => `<button class="chip" type="button" data-tier="${t}" aria-pressed="false">${t}</button>`).join("")}
  <span class="sep"></span>
  <label class="check"><input type="checkbox" data-cap="vision">Vision</label>
  <label class="check"><input type="checkbox" data-cap="reasoning">Reasoning</label>
  <label class="check"><input type="checkbox" data-cap="caching">Caching</label>
  <label class="check"><input type="checkbox" id="np" checked>Hide previews</label>
</div>
<p class="muted" id="sortnote" style="margin:4px 0 8px;font-size:.86rem">Sorted by <b>your estimated monthly cost, cheapest first</b>. Click any column to sort by it. Tiers go by output price: Budget under $2, Standard $2–15, Premium $15+ per 1M tokens.</p>
<div class="tablewrap"><table id="prices"><thead><tr>
<th data-k="name">Model</th><th class="n" data-k="cost">Your cost / mo <span class="arr">▲</span></th><th class="n" data-k="in">Input / 1M</th><th class="n" data-k="out">Output / 1M</th><th class="n hide-sm" data-k="cached">Cached input</th><th class="n hide-sm" data-k="ctx">Context</th>
</tr></thead><tbody>${[...rows].sort((a, b) => costOf(a, PRESETS[0][1], PRESETS[0][2]) - costOf(b, PRESETS[0][1], PRESETS[0][2]))
  .map(m => `<tr data-name="${esc((m.name + " " + m.provider + " " + m.apiNames.join(" ")).toLowerCase())}" data-in="${m.input}" data-out="${m.output}" data-cached="${m.cached ?? ""}" data-li="${m.longIn ?? ""}" data-lo="${m.longOut ?? ""}" data-la="${m.longAt ?? ""}" data-ctx="${m.context ?? 0}" data-max="${m.maxOutput ?? 0}" data-tier="${tier(m)}" data-vision="${+m.vision}" data-reasoning="${+m.reasoning}" data-caching="${+m.caching}" data-preview="${+m.preview}">
<td>${dot(m.provider)}<a href="${modelUrl(m.key)}">${esc(m.name)}</a>${badge(m)}<span class="prov">${m.provider} · ${tier(m)}</span></td><td class="n cost">${money(costOf(m, PRESETS[0][1], PRESETS[0][2]) * PRESETS[0][3])}</td><td class="n">${usd(m.input)}</td><td class="n">${usd(m.output)}</td><td class="n hide-sm">${usd(m.cached)}</td><td class="n hide-sm">${ctx(m.context)}</td></tr>`)
  .join("")}</tbody></table></div>
<p class="muted" id="shown" style="font-size:.86rem"></p>
<script>
(()=>{const $=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)];
const tb=$('#prices tbody'),rows=[...tb.rows];let sortK='cost',asc=true;
const fmt=n=>n<0.01?'$'+ +n.toPrecision(2):n<100?'$'+n.toFixed(2):'$'+Math.round(n).toLocaleString('en-US');
function cost(r){const i=+$('#ti').value,o=+$('#to').value,d=r.dataset,L=d.la&&i>+d.la;return(i*(L?+d.li:+d.in)+o*(L&&d.lo?+d.lo:+d.out))/1e6*+$('#tr').value}
function fits(r){const c=+r.dataset.ctx,mx=+r.dataset.max;return(!c||+$('#ti').value+ +$('#to').value<=c)&&(!mx||+$('#to').value<=mx)}
function val(r,k){return k==='name'?r.dataset.name:k==='cost'?(fits(r)?cost(r):Infinity):k==='cached'?(r.dataset.cached===''?Infinity:+r.dataset.cached):+r.dataset[k]}
function render(){const q=$('#q').value.toLowerCase().trim(),tiers=$$('[data-tier][aria-pressed=true]').map(b=>b.dataset.tier),
caps=$$('[data-cap]:checked').map(c=>c.dataset.cap),np=$('#np').checked;let n=0;
for(const r of rows){const f=fits(r);r.cells[1].textContent=f?fmt(cost(r)):"Too long";r.cells[1].title=f?'':'Request is larger than this model can take';r.classList.toggle('nofit',!f);
const ok=(!q||r.dataset.name.includes(q))&&(!tiers.length||tiers.includes(r.dataset.tier))&&caps.every(c=>r.dataset[c]==='1')&&!(np&&r.dataset.preview==='1');r.hidden=!ok;n+=ok}
rows.sort((a,b)=>{const x=val(a,sortK),y=val(b,sortK);const d=typeof x==='string'?x.localeCompare(y):x-y;return asc?d:-d}).forEach(r=>tb.appendChild(r));
$$('#prices th[data-k]').forEach(th=>{const a=th.querySelector('.arr');if(a)a.remove();if(th.dataset.k===sortK)th.insertAdjacentHTML('beforeend',' <span class="arr">'+(asc?'▲':'▼')+'</span>')});
const label={name:'model name',cost:'your estimated monthly cost',in:'input price',out:'output price',cached:'cached input price',ctx:'context window'}[sortK];
$('#sortnote b').textContent=label+(asc?(sortK==='name'?', A to Z':sortK==='ctx'?', smallest first':', cheapest first'):(sortK==='name'?', Z to A':sortK==='ctx'?', largest first':', most expensive first'));
$('#shown').textContent='Showing '+n+' of '+rows.length+' models.';
history.replaceState(null,'','#i='+$('#ti').value+'&o='+$('#to').value+'&r='+$('#tr').value)}
const h=new URLSearchParams(location.hash.slice(1));if(h.has('i')){$('#ti').value=h.get('i');$('#to').value=h.get('o')||0;$('#tr').value=h.get('r')||0;$$('#presets .chip').forEach(x=>x.setAttribute('aria-pressed',x.dataset.i===h.get('i')&&x.dataset.o===h.get('o')&&x.dataset.r===h.get('r')))}
$$('#prices th[data-k]').forEach(th=>th.addEventListener('click',()=>{const k=th.dataset.k;asc=k===sortK?!asc:k!=='ctx';sortK=k;render()}));
$$('#presets .chip').forEach(b=>b.addEventListener('click',()=>{$$('#presets .chip').forEach(x=>x.setAttribute('aria-pressed',x===b));$('#ti').value=b.dataset.i;$('#to').value=b.dataset.o;$('#tr').value=b.dataset.r;render()}));
['#ti','#to','#tr'].forEach(s=>$(s).addEventListener('input',()=>{$$('#presets .chip').forEach(x=>x.setAttribute('aria-pressed','false'));render()}));
$$('[data-tier]').forEach(b=>b.addEventListener('click',()=>{b.setAttribute('aria-pressed',b.getAttribute('aria-pressed')!=='true');render()}));
$$('#filters input').forEach(i=>i.addEventListener('input',render));
addEventListener('hashchange',()=>{const h=new URLSearchParams(location.hash.slice(1));if(h.has('i')){$('#ti').value=h.get('i');$('#to').value=h.get('o')||0;$('#tr').value=h.get('r')||0;render()}});render()})();
</script>`;

// --- 6. Auto "cheapest" picks: objective, from data only ---
const cheapest = (label, filter, why) => {
  const m = list.filter(m => !m.preview && filter(m))[0];
  return m ? `<div class="card pick"><h3>${label}</h3>${dot(m.provider)}<a href="${modelUrl(m.key)}">${esc(m.name)}</a><p>${usd(m.input)} in / ${usd(m.output)} out per 1M${why ? ` · ${why(m)}` : ""}</p></div>` : "";
};
const picks = `<h2>Cheapest by need</h2><p class="muted" style="margin-top:-4px">Lowest blended price (3 parts input to 1 part output) among non-preview models with each feature. Price only, not a quality ranking.</p><div class="grid">
${cheapest("Cheapest overall", () => true)}
${cheapest("Cheapest with vision", m => m.vision)}
${cheapest("Cheapest with reasoning", m => m.reasoning)}
${cheapest("Cheapest with 1M+ context", m => m.context >= 1e6, m => `${ctx(m.context)} context`)}
${cheapest("Cheapest Premium-tier model", m => tier(m) === "Premium")}
${cheapest("Cheapest with prompt caching", m => m.caching && m.cached, m => `cached input ${usd(m.cached)}`)}
</div>`;

// Biggest cuts in the last 12 months, one row per model (its largest output or input cut).
const yearAgo = new Date(now - 365 * 864e5).toISOString().slice(0, 10);
const bigCuts = Object.values(changes
  .filter(c => (c.type === "output" || c.type === "input") && c.old && c.new < c.old && c.date >= yearAgo && models[c.key])
  .reduce((best, c) => ((best[c.key]?.pct ?? 0) > (c.new - c.old) / c.old ? { ...best, [c.key]: { ...c, pct: (c.new - c.old) / c.old } } : best), {}))
  .sort((a, b) => a.pct - b.pct).slice(0, 10);
const cutsBlock = bigCuts.length ? `<h2>Biggest price cuts, last 12 months</h2>${changeTable(bigCuts)}` : "";

const recentBlock = n => {
  const r = changes.filter(c => c.type !== "removed").slice(0, n);
  return r.length ? `<h2>Latest price changes</h2>${changeTable(r)}<p><a href="/changes.html">Full change log →</a></p>` : "";
};

rmSync(`${OUT}/models`, { recursive: true, force: true });
const write = (path, html) => {
  const file = path.endsWith("/") ? `${OUT}${path}index.html` : `${OUT}${path}`;
  mkdirSync(file.slice(0, file.lastIndexOf("/")), { recursive: true });
  writeFileSync(file, html);
};

// --- 7. Home ---
write("/", page({
  title: `AI API Pricing Compared: GPT, Claude, Gemini, Grok (${monthYear})`,
  desc: clip(`API prices for ${count} models from OpenAI, Anthropic, Google, xAI, DeepSeek and Mistral, checked daily. Estimate your monthly cost and see every dated price change.`),
  path: "/",
  head: `<script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@type": "Dataset", name: "AI API prices and price change history", description: `Daily API prices per million tokens for ${count} AI models from OpenAI, Anthropic, Google, xAI, DeepSeek and Mistral, with a dated log of price changes since ${trackingStart}.`, url: `${SITE_URL}/`, license: "https://creativecommons.org/licenses/by/4.0/", isAccessibleForFree: true, dateModified: today, temporalCoverage: `${trackingStart}/${today}`, creator: { "@type": "Organization", name: "AI Price Log", url: SITE_URL }, distribution: [{ "@type": "DataDownload", encodingFormat: "application/json", contentUrl: `${SITE_URL}/prices.json` }, { "@type": "DataDownload", encodingFormat: "text/csv", contentUrl: `${SITE_URL}/prices.csv` }] })}</script>`,
  body: `<h1>AI API pricing, compared</h1>
<p class="lead">Current prices for ${count} models from OpenAI, Anthropic, Google, xAI, DeepSeek and Mistral. Estimate what your workload would cost on each one, then check the dated log of every price change.</p>
<div class="stats"><span><b>${count}</b> models</span><span><b>6</b> providers</span><span>Checked <b>${today} ${checkedAt} UTC</b></span><span><b>${changes.length}</b> changes logged since ${trackingStart}</span></div>
${priceTable(list)}
${picks}
${recentBlock(8)}
${cutsBlock}
<h2>How to read these prices</h2><div class="prose"><p>AI APIs charge per token. A token is about ¾ of a word, so 1 million tokens is roughly 750,000 words. <b>Input</b> is the text you send (your prompt, documents, chat history). <b>Output</b> is the text the model writes back, and it usually costs 4–8 times more. <b>Cached input</b> is the discounted rate when you resend the same long prompt, which matters for chatbots and agents.</p><p>The calculator multiplies your token counts by each model's standard rate. Batch processing, long-context surcharges and regional pricing can change the real bill; each model page lists those rates where providers publish them.</p></div>`,
}));

// Step chart of input/output price over time, from the change log. Only drawn when the price has moved.
function priceChart(m, hist) {
  // Only chart the current version: stop at the last time the name was re-pointed to another model.
  const v = hist.findIndex(c => c.type === "version");
  const cur = v === -1 ? hist : hist.slice(0, v + 1);
  const moves = cur.filter(c => (c.type === "input" || c.type === "output") && c.old != null && c.new != null).reverse();
  if (!moves.length) return "";
  const start = cur.at(-1).date;
  const series = { input: [[start, moves.find(c => c.type === "input")?.old ?? m.input]], output: [[start, moves.find(c => c.type === "output")?.old ?? m.output]] };
  for (const c of moves) series[c.type].push([c.date, c.new]);
  for (const k of ["input", "output"]) series[k].push([today, m[k]]);
  const t = d => Date.parse(d), t0 = t(start), t1 = Math.max(t(today), t0 + 864e5);
  const max = Math.max(...series.output.map(p => p[1]), ...series.input.map(p => p[1]));
  const W = 640, H = 170, P = 44, x = d => P + ((t(d) - t0) / (t1 - t0)) * (W - P - 8), y = v => H - 22 - (v / max) * (H - 40);
  const path = pts => pts.map(([d, v], i) => (i ? `H${x(d).toFixed(1)}V${y(v).toFixed(1)}` : `M${x(d).toFixed(1)} ${y(v).toFixed(1)}`)).join("");
  return `<figure class="card" style="margin:0 0 12px"><svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="${esc(m.name)} price history chart">
<line x1="${P}" x2="${W - 8}" y1="${H - 22}" y2="${H - 22}" stroke="var(--line)"/>
<text x="${P - 6}" y="${y(max) + 4}" text-anchor="end" font-size="11" fill="var(--muted)">${usd(max)}</text>
<text x="${P - 6}" y="${H - 18}" text-anchor="end" font-size="11" fill="var(--muted)">$0</text>
<text x="${P}" y="${H - 4}" font-size="11" fill="var(--muted)">${start}</text><text x="${W - 8}" y="${H - 4}" text-anchor="end" font-size="11" fill="var(--muted)">${today}</text>
<path d="${path(series.output)}" fill="none" stroke="var(--accent)" stroke-width="2.5"/><path d="${path(series.input)}" fill="none" stroke="var(--muted)" stroke-width="2" stroke-dasharray="5 4"/>
</svg><figcaption class="muted" style="font-size:.82rem">Per 1M tokens. <span style="color:var(--accent)">━ Output</span> · ┅ Input</figcaption></figure>`;
}
const ordinal = n => `${n}${["th", "st", "nd", "rd"][(n % 100 > 10 && n % 100 < 14) || n % 10 > 3 ? 0 : n % 10]}`;
const firstListed = key => changesFor(key).filter(c => c.type === "added").at(-1)?.date;
const pctDiff = (a, b) => Math.round(((a - b) / b) * 100);
const PRICING_PAGE = { OpenAI: "https://openai.com/api/pricing/", Anthropic: "https://www.anthropic.com/pricing#api", Google: "https://ai.google.dev/gemini-api/docs/pricing", xAI: "https://docs.x.ai/docs/models", DeepSeek: "https://api-docs.deepseek.com/quick_start/pricing", Mistral: "https://mistral.ai/pricing#api-pricing" };

// --- 8. Model pages ---
for (const m of list) {
  const hist = changesFor(m.key);
  const sameProv = list.filter(x => x.provider === m.provider && x.key !== m.key).sort((a, b) => b.blend - a.blend);
  const near = list.filter(x => x.key !== m.key && !x.preview).sort((a, b) => Math.abs(Math.log(a.blend / m.blend)) - Math.abs(Math.log(b.blend / m.blend))).slice(0, 6).sort((a, b) => a.blend - b.blend);
  const rateRows = [
    ["Input (standard)", m.input],
    ["Output (standard)", m.output],
    ["Cached input (read)", m.cached],
    ["Cache write", m.cacheWrite],
    ["Batch input", m.batchIn],
    ["Batch output", m.batchOut],
    [m.longAt && `Input, prompts over ${ctx(m.longAt)} tokens`, m.longIn],
    [m.longAt && `Output, prompts over ${ctx(m.longAt)} tokens`, m.longOut],
  ].filter(([l, v]) => l && v != null);
  const ex = PRESETS.map(([n, i, o]) => {
    const per = costOf(m, i, o);
    return `<tr><td>${n}</td><td class="n">${i.toLocaleString("en-US")} in / ${o.toLocaleString("en-US")} out</td><td class="n">${money(per)}</td><td class="n">${money(per * 1000)}</td></tr>`;
  }).join("");
  const mini = rows => `<div class="tablewrap"><table><thead><tr><th>Model</th><th class="n">Input / 1M</th><th class="n">Output / 1M</th></tr></thead><tbody>${rows
    .map(x => `<tr><td>${dot(x.provider)}<a href="${modelUrl(x.key)}">${esc(x.name)}</a></td><td class="n">${usd(x.input)}</td><td class="n">${usd(x.output)}</td></tr>`).join("")}</tbody></table></div>`;
  const provList = list.filter(x => x.provider === m.provider);
  const provRank = provList.findIndex(x => x.key === m.key) + 1;
  const rival = list.filter(x => x.provider !== m.provider && !x.preview && tier(x) === tier(m)).sort((a, b) => Math.abs(a.blend - m.blend) - Math.abs(b.blend - m.blend))[0];
  const twins = list.filter(x => x.key !== m.key && x.input === m.input && x.output === m.output);
  const first = firstListed(m.key);
  const moved = hist.filter(c => (c.type === "input" || c.type === "output") && c.old != null && c.new != null);
  const cuts = new Set(moved.filter(c => c.new < c.old).map(c => c.date)).size, rises = new Set(moved.filter(c => c.new > c.old).map(c => c.date)).size;
  const facts = [
    `It is the ${provRank === 1 ? "cheapest" : provRank === provList.length ? "most expensive" : `${ordinal(provRank)} cheapest`} of ${provList.length} ${SEARCH_NAME[m.provider]} models tracked here, by blended price.`,
    rival && `The closest ${tier(m)}-tier model from another provider is <a href="${modelUrl(rival.key)}">${esc(rival.name)}</a> (${rival.provider}) at ${usd(rival.input)} / ${usd(rival.output)}${rival.blend === m.blend ? ", the same blended price" : `; ${esc(m.name)} is ${Math.abs(pctDiff(m.blend, rival.blend))}% ${m.blend > rival.blend ? "more expensive" : "cheaper"}`}.`,
    twins.length && `Same list price as ${twins.slice(0, 4).map(x => `<a href="${modelUrl(x.key)}">${esc(x.name)}</a>`).join(", ")}${twins.length > 4 ? ` and ${twins.length - 4} more` : ""}.`,
    first && `First listed in the LiteLLM price data on ${longDate(first)}.`,
    (cuts || rises) && `Its price has been cut ${cuts} time${cuts === 1 ? "" : "s"} and raised ${rises} time${rises === 1 ? "" : "s"} since.`,
    m.longAt && `Prompts longer than ${ctx(m.longAt)} tokens are billed at ${usd(m.longIn)} input / ${usd(m.longOut ?? m.output)} output.`,
  ].filter(Boolean);
  const src = m.source ?? PRICING_PAGE[m.provider];
  write(modelUrl(m.key), page({
    title: `${m.name} API Pricing: ${short(m.input)} / ${short(m.output)} per 1M (${monthYear})`,
    desc: clip(`${m.name} API costs ${usd(m.input)} per 1M input tokens and ${usd(m.output)} per 1M output${m.cached ? `, ${usd(m.cached)} cached` : ""}. ${ctx(m.context)} context. Cost examples and dated price history.`),
    path: modelUrl(m.key),
    head: `<script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: [
      { "@type": "ListItem", position: 1, name: "AI Price Log", item: `${SITE_URL}/` },
      { "@type": "ListItem", position: 2, name: m.provider, item: `${SITE_URL}/${slugOf(m.provider)}/` },
      { "@type": "ListItem", position: 3, name: m.name, item: `${SITE_URL}${modelUrl(m.key)}` }] })}</script>`,
    body: `<div class="crumbs"><a href="/">All prices</a> › <a href="/${slugOf(m.provider)}/">${m.provider}</a> › ${esc(m.name)}</div>
<h1>${esc(m.name)} API pricing</h1>
<p class="lead">As of ${longDate(today)}, ${esc(m.name)} costs <b>${usd(m.input)}</b> per million input tokens and <b>${usd(m.output)}</b> per million output tokens on the ${m.provider} API.${m.cached ? ` Cached input is ${usd(m.cached)} per million.` : ""}${m.deprecates ? ` ${m.provider} plans to retire it on ${longDate(m.deprecates)}.` : ""}</p>
<div>${badge(m)}</div>
<p class="prose">${facts.join(" ")}</p>
<div class="kv card" style="margin-top:14px">
<div><span>Input / 1M tokens</span><b class="big">${usd(m.input)}</b></div>
<div><span>Output / 1M tokens</span><b class="big">${usd(m.output)}</b></div>
<div><span>Context window</span><b class="big">${ctx(m.context)}</b></div>
<div><span>Max output</span><b class="big">${ctx(m.maxOutput)}</b></div>
</div>
<h2>Every published rate</h2>
<div class="tablewrap"><table><thead><tr><th>Rate</th><th class="n">Per 1M tokens</th></tr></thead><tbody>${rateRows.map(([l, v]) => `<tr><td>${l}</td><td class="n">${usd(v)}</td></tr>`).join("")}</tbody></table></div>
<h2>What it costs in practice</h2>
<div class="tablewrap"><table><thead><tr><th>Task</th><th class="n">Tokens</th><th class="n">Per request</th><th class="n">Per 1,000 requests</th></tr></thead><tbody>${ex}</tbody></table></div>
<p class="muted" style="font-size:.86rem">Standard rates, no caching or batch discount${m.longAt ? `; prompts over ${ctx(m.longAt)} tokens are billed at the higher long-prompt rate` : ""}. <a href="/">Compare your own numbers across all models →</a></p>
<h2>Price history</h2>
${priceChart(m, hist)}${hist.length ? changeTable(hist) + `<p class="muted" style="font-size:.82rem">Dates are when each change first appeared in the LiteLLM price data, usually within days of the provider's announcement.</p>` : `<p class="muted">No price changes recorded since tracking began on ${trackingStart}. When the price moves, it will show up here with the date.</p>`}
<h2>Details</h2>
<div class="tablewrap"><table><tbody>
<tr><td>Provider</td><td><a href="/${slugOf(m.provider)}/">${m.provider}</a></td></tr>
<tr><td>Price tier</td><td>${tier(m)}</td></tr>
<tr><td>Features</td><td style="white-space:normal">${caps(m).join(", ") || "–"}</td></tr>
<tr><td>API model names</td><td style="white-space:normal"><code>${m.apiNames.map(esc).join("</code>, <code>")}</code></td></tr>
${m.deprecates ? `<tr><td>Retirement date</td><td>${longDate(m.deprecates)}</td></tr>` : ""}
<tr><td>Official pricing</td><td><a href="${esc(src)}" rel="nofollow noopener">${esc(new URL(src).hostname)}</a></td></tr>
</tbody></table></div>
<h2>Models at a similar price</h2>${mini(near)}
${sameProv.length ? `<h2>Other ${m.provider} models</h2>${mini(sameProv)}` : ""}`,
  }));
}

// --- 9. Provider pages ---
for (const p of Object.values(PROVIDERS)) {
  const rows = list.filter(m => m.provider === p);
  const pc = changes.filter(c => c.provider === p && c.type !== "removed").slice(0, 15);
  const top = [...rows].filter(m => !m.preview).sort((a, b) => b.blend - a.blend)[0];
  const low = rows.filter(m => !m.preview)[0];
  write(`/${slugOf(p)}/`, page({
    title: `${SEARCH_NAME[p]} API Pricing${SEARCH_NAME[p].startsWith(p) ? "" : ` (${p})`}: ${rows.length} Models, ${monthYear}`,
    desc: clip(`Every ${SEARCH_NAME[p]} API model and its price per 1M tokens${low && top ? `, from ${low.name} at ${usd(low.input)} input to ${top.name} at ${usd(top.input)}` : ""}. Cost calculator and price history.`),
    path: `/${slugOf(p)}/`,
    body: `<div class="crumbs"><a href="/">All prices</a> › ${p}</div>
<h1>${SEARCH_NAME[p]} API pricing${SEARCH_NAME[p].startsWith(p) ? "" : ` <span class="muted" style="font-weight:500">(${p})</span>`}</h1>
<p class="lead">${rows.length} ${p} models, checked ${longDate(today)}.${low && top ? ` Prices run from ${usd(low.input)} input / ${usd(low.output)} output per million tokens (${esc(low.name)}) up to ${usd(top.input)} / ${usd(top.output)} (${esc(top.name)}).` : ""}</p>
${priceTable(rows)}
${pc.length ? `<h2>Recent ${p} price changes</h2>${changeTable(pc)}` : ""}`,
  }));
}

// --- 10. Change log, about, feeds, data ---
write("/changes.html", page({
  title: "AI API Price Change Log: Every Price Change, Dated",
  desc: "A dated log of every AI API price change, new model and context-window change across OpenAI, Anthropic, Google, xAI, DeepSeek and Mistral.",
  path: "/changes.html",
  body: `<h1>AI price change log</h1><p class="lead">Every price change, new model and context-window change, newest first. Tracking since ${trackingStart}. <a href="/feed.xml">Subscribe by RSS</a>. Dates are when each change first appeared in the open LiteLLM price data.</p>
${cutsBlock}<h2>Every change</h2>
${changes.length ? changeTable(changes) : `<p class="muted">No changes detected yet.</p>`}`,
}));

write("/about.html", page({
  title: "How AI Price Log Works",
  desc: "Where AI Price Log's data comes from, how often it updates, and how models and prices are cleaned up.",
  path: "/about.html",
  body: `<h1>How this works</h1><div class="prose">
<p>Every day at about 06:17 UTC a script downloads the open <a href="https://github.com/BerriAI/litellm">LiteLLM model price database</a>, which developers across the industry use to track API costs. It keeps the six providers' own chat models, compares them with the day before, logs every change with its date, and rebuilds this site.</p>
<p><b>Cleaning.</b> Providers list the same model under many names (dated snapshots, "-latest" aliases, reasoning and non-reasoning variants at one price). Those are folded into one entry; every API name is still listed on the model's page. Fine-tuned models, audio-only models and models past their retirement date are left out.</p>
<p><b>Change dates</b> are the day the change first appeared in the data, which is usually within a day or two of the provider's announcement.</p>
<p><b>Limits.</b> Prices are standard pay-as-you-go API rates in US dollars. Volume discounts, enterprise contracts, regional pricing and taxes are not included. Always check the provider's official page, linked on each model page, before you commit.</p>
<p>Spotted a wrong price? <a href="${REPO}/issues/new?title=Wrong%20price">Report it</a>. The full data is free to use: <a href="/prices.json">JSON</a>, <a href="/prices.csv">CSV</a>, <a href="/feed.xml">RSS feed of changes</a>.</p></div>`,
}));

const rssDate = d => new Date(`${d}T06:17:00Z`).toUTCString();
writeFileSync(`${OUT}/feed.xml`, `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>AI Price Log: price changes</title><link>${SITE_URL}/changes.html</link><description>Dated AI API price changes across OpenAI, Anthropic, Google, xAI, DeepSeek and Mistral.</description>
${changes.slice(0, 50).map(c => `<item><title>${esc(`${c.model} (${c.provider}): ${describe(c).replace(/<[^>]+>/g, "")}`)}</title><link>${SITE_URL}${models[c.key] ? modelUrl(c.key) : "/changes.html"}</link><guid isPermaLink="false">${esc(`${c.date}-${c.key}-${c.type}`)}</guid><pubDate>${rssDate(c.date)}</pubDate></item>`).join("\n")}
</channel></rss>`);

writeFileSync(`${OUT}/prices.json`, JSON.stringify({ updated: `${today}T${checkedAt}Z`, unit: "USD per 1M tokens", source: SITE_URL, models: list.map(({ blend, ...m }) => m) }, null, 1));
const csvCell = v => (v == null ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v);
writeFileSync(`${OUT}/prices.csv`, ["key,name,provider,input,output,cached_input,batch_input,batch_output,context,max_output,vision,reasoning,caching,preview,retires",
  ...list.map(m => [m.key, m.name, m.provider, m.input, m.output, m.cached, m.batchIn, m.batchOut, m.context, m.maxOutput, m.vision, m.reasoning, m.caching, m.preview, m.deprecates].map(csvCell).join(","))].join("\n") + "\n");

// Sitemap: lastmod moves only when that page's data actually changed.
const lastChange = key => changesFor(key)[0]?.date ?? trackingStart;
const urls = [
  ["/", changes[0]?.date ?? trackingStart],
  ["/changes.html", changes[0]?.date ?? trackingStart],
  ["/about.html", trackingStart],
  ...Object.values(PROVIDERS).map(p => [`/${slugOf(p)}/`, changes.find(c => c.provider === p)?.date ?? trackingStart]),
  ...list.map(m => [modelUrl(m.key), lastChange(m.key)]),
];
writeFileSync(`${OUT}/sitemap.xml`, `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map(([u, d]) => `<url><loc>${SITE_URL}${u}</loc><lastmod>${d}</lastmod></url>`).join("\n")}\n</urlset>\n`);
writeFileSync(`${OUT}/robots.txt`, `User-agent: *\nAllow: /\nSitemap: ${SITE_URL}/sitemap.xml\n`);
writeFileSync(`${OUT}/CNAME`, "aipricelog.com\n");
writeFileSync(`${OUT}/.nojekyll`, "");
writeFileSync(`${OUT}/404.html`, page({ title: "Page not found | AI Price Log", desc: "Page not found.", path: "/404.html", body: `<h1>Page not found</h1><p>That model may have been renamed or retired. <a href="/">See all current prices →</a></p>` }));
console.log(`built site: ${count} models, ${urls.length} pages, ${changes.length} logged changes`);

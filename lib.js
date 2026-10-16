// Turns the raw LiteLLM price file into a clean list of models: one row per real model,
// no fine-tunes, no dead models, aliases and dated copies folded into the model they point to.
// Shared by update.js (daily) and backfill.js (history from LiteLLM's git log).

export const PROVIDERS = { openai: "OpenAI", anthropic: "Anthropic", gemini: "Google", xai: "xAI", deepseek: "DeepSeek", mistral: "Mistral" };

// Not general chat models, or not the provider's own model.
const SKIP = /^ft:|audio|tts|robotics|customtools|vibe-cli|fim|computer-use|search-preview|glm|^chat-latest$|daybreak/;
const NOISE = new Set(["latest", "beta", "experimental", "reasoning", "non", "gv2"]);

const per1M = v => (v ? +(v * 1e6).toFixed(4) : null);

// "grok-4.20-beta-0309-reasoning" -> "grok-4-20"; "gemini-3.1-pro-preview" -> "gemini-3-1-pro-preview"
export function baseKey(name) {
  return name
    .replace(/-\d{8}$|-\d{4}-\d{2}-\d{2}$|-\d{2}-\d{4}$/, "")
    .replace(/\./g, "-")
    .split("-")
    .filter(t => !NOISE.has(t) && !/^\d{4}$/.test(t))
    .join("-")
    .replace(/-0$/, "")
    .replace(/^ministral-(\d+b)$/, "ministral-3-$1"); // Mistral lists the Ministral 3 family under both names
}

const WORDS = { gpt: "GPT", deepseek: "DeepSeek", it: "IT", er: "ER", api: "API" };
export function prettyName(key) {
  const out = [];
  for (const t of key.split("-")) {
    const last = out.length - 1;
    if (/^\d+$/.test(t) && /^V?\d+(\.\d+)*$/.test(out[last] ?? "")) out[last] += `.${t}`;
    else if (/^\d+$/.test(t) || /^\d+(o|b|k)$/.test(t)) out.push(t.replace(/[bk]$/, c => c.toUpperCase()));
    else if (/^[ov]\d/.test(t)) out.push(t[0] === "v" ? t.toUpperCase() : t);
    else out.push(WORDS[t] ?? t[0].toUpperCase() + t.slice(1));
  }
  // "GPT 5.4 Mini" -> "GPT-5.4 Mini"
  return out.join(" ").replace(/^GPT (\S+)/, "GPT-$1").replace(/^Gemini Gemma/, "Gemma").replace(/^Deep Research/, "Gemini Deep Research");
}

// Some models charge more once the prompt passes a size (100K, 128K, 200K, 272K tokens). Use the lowest threshold.
function longContext(v) {
  const at = Object.keys(v).map(f => f.match(/^input_cost_per_token_above_(\d+)k_tokens$/)?.[1]).filter(Boolean).map(Number).sort((a, b) => a - b)[0];
  if (!at) return { longIn: null, longOut: null, longAt: null };
  return { longIn: per1M(v[`input_cost_per_token_above_${at}k_tokens`]), longOut: per1M(v[`output_cost_per_token_above_${at}k_tokens`]), longAt: at * 1000 };
}

export function normalize(raw, today) {
  const groups = {};
  for (const [fullKey, v] of Object.entries(raw)) {
    if (!PROVIDERS[v.litellm_provider] || v.mode !== "chat") continue;
    if (!v.input_cost_per_token || !v.output_cost_per_token) continue;
    if (v.deprecation_date && v.deprecation_date < today) continue;
    const name = fullKey.split("/").pop();
    if (SKIP.test(name)) continue;
    const key = baseKey(name);
    (groups[key] ??= []).push({ name, v });
  }

  const models = {};
  for (const [key, members] of Object.entries(groups)) {
    // A group made only of "-latest" aliases points at some other model: drop it.
    if (members.every(m => m.name.includes("latest"))) continue;
    // Price source: the -latest alias (tracks the current price), else the bare name, else the newest dated copy.
    const pick =
      members.find(m => m.name.endsWith("-latest")) ??
      members.find(m => baseKey(m.name) === m.name.replace(/\./g, "-")) ??
      [...members].sort((a, b) => b.name.localeCompare(a.name))[0];
    const v = pick.v;
    const same = members.filter(m => m.v.input_cost_per_token === v.input_cost_per_token && m.v.output_cost_per_token === v.output_cost_per_token);
    const deps = same.map(m => m.v.deprecation_date).filter(Boolean).sort();
    models[key] = {
      name: prettyName(key),
      provider: PROVIDERS[v.litellm_provider],
      input: per1M(v.input_cost_per_token),
      output: per1M(v.output_cost_per_token),
      cached: per1M(v.cache_read_input_token_cost),
      cacheWrite: per1M(v.cache_creation_input_token_cost),
      batchIn: per1M(v.input_cost_per_token_batches),
      batchOut: per1M(v.output_cost_per_token_batches),
      ...longContext(v),
      context: v.max_input_tokens || null,
      maxOutput: v.max_output_tokens || null,
      vision: !!v.supports_vision,
      reasoning: !!v.supports_reasoning,
      caching: !!v.supports_prompt_caching,
      tools: !!v.supports_function_calling,
      pdf: !!v.supports_pdf_input,
      web: !!v.supports_web_search,
      preview: /preview|exp/.test(key),
      deprecates: deps[0] ?? null,
      apiNames: [...new Set(same.map(m => m.name))].sort(),
      source: v.source ?? null,
    };
  }
  // "mistral-large" (a -latest alias) at the same price as "mistral-large-3": fold the alias into the versioned model.
  for (const [key, members] of Object.entries(groups)) {
    if (!models[key] || !members.some(m => m.name.includes("latest"))) continue;
    const m = models[key];
    const target = Object.keys(models)
      .filter(k => k.startsWith(`${key}-`) && models[k].input === m.input && models[k].output === m.output)
      .sort().at(-1);
    if (!target) continue;
    models[target].apiNames = [...new Set([...models[target].apiNames, ...m.apiNames])].sort();
    delete models[key];
  }
  // Same model listed twice at one price: "gpt-5-5-cyber" + "-preview", "grok-code-fast" + "-1".
  for (const key of Object.keys(models)) {
    const m = models[key];
    if (!m) continue;
    const twin = Object.keys(models).find(k => k !== key && models[k]?.provider === m.provider && models[k].input === m.input && models[k].output === m.output &&
      (k === `${key}-preview` || (/^\d+$/.test(k.slice(key.length + 1)) && k.startsWith(`${key}-`) && !/\d$/.test(key))));
    if (!twin) continue;
    const keep = twin.endsWith("-preview") ? key : twin, drop = keep === key ? twin : key;
    models[keep].apiNames = [...new Set([...models[keep].apiNames, ...models[drop].apiNames])].sort();
    delete models[drop];
  }
  return models;
}

// Self-check: node lib.js
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/").replace(/^(?=[A-Za-z]:)/, "/")}`) {
  const assert = (await import("node:assert")).strict;
  assert.equal(baseKey("grok-4.20-beta-0309-non-reasoning"), "grok-4-20");
  assert.equal(baseKey("claude-opus-4-6-20260205"), "claude-opus-4-6");
  assert.equal(baseKey("ministral-14b-2512"), "ministral-3-14b");
  assert.equal(baseKey("mistral-medium-3.5"), baseKey("mistral-medium-3-5"));
  assert.equal(prettyName("claude-sonnet-5-5"), "Claude Sonnet 5.5");
  assert.equal(prettyName("gpt-5-4-mini"), "GPT-5.4 Mini");
  assert.equal(prettyName("gpt-4o-mini"), "GPT-4o Mini");
  assert.equal(prettyName("grok-4-20"), "Grok 4.20");
  assert.equal(prettyName("deepseek-v4-pro"), "DeepSeek V4 Pro");
  assert.equal(prettyName("o3"), "o3");
  assert.equal(prettyName("ministral-3-8b"), "Ministral 3 8B");
  assert.equal(prettyName("deepseek-v3-2"), "DeepSeek V3.2");
  const raw = {
    "a/claude-x-1": { litellm_provider: "anthropic", mode: "chat", input_cost_per_token: 1e-6, output_cost_per_token: 5e-6 },
    "claude-x-1-20250101": { litellm_provider: "anthropic", mode: "chat", input_cost_per_token: 1e-6, output_cost_per_token: 5e-6 },
    "gpt-old": { litellm_provider: "openai", mode: "chat", input_cost_per_token: 1e-6, output_cost_per_token: 1e-6, deprecation_date: "2020-01-01" },
    "gpt-z-latest": { litellm_provider: "openai", mode: "chat", input_cost_per_token: 1e-6, output_cost_per_token: 1e-6 },
  };
  const m = normalize(raw, "2026-10-16");
  assert.deepEqual(Object.keys(m), ["claude-x-1"]);
  assert.deepEqual(m["claude-x-1"].apiNames, ["claude-x-1", "claude-x-1-20250101"]);
  console.log("lib.js self-check ok");
}

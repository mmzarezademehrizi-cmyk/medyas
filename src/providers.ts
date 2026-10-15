// LLM providers for the agent. Everything speaks the OpenAI chat-completions protocol, so one client covers them all.
// The admin can save a key for several providers (each free tier is separate); the active one is tried first and the others
// act as automatic fallbacks. A provider that just ran out of quota / balance is put on a short cooldown so it is not retried
// on every call.
import { dec, enc } from "./crypto";
import { Env } from "./env";

export type ProviderId = "gemini" | "groq" | "cerebras" | "openrouter" | "mistral" | "github" | "cloudflare" | "deepseek" | "openai" | "custom";
export interface ProviderInfo { name: string; base: string; model: string; cost: string; keyUrl: string; json: boolean }

export const PROVIDERS: Record<ProviderId, ProviderInfo> = {
  gemini: { name: "Gemini (گوگل)", base: "https://generativelanguage.googleapis.com/v1beta/openai", model: "gemini-flash-latest", cost: "🆓 رایگان (بدون کارت بانکی)", keyUrl: "aistudio.google.com/apikey", json: true },
  groq: { name: "Groq", base: "https://api.groq.com/openai/v1", model: "openai/gpt-oss-120b", cost: "🆓 رایگان (حدود ۱۰۰۰ درخواست و ۲۰۰ هزار توکن در روز)", keyUrl: "console.groq.com/keys", json: true },
  cerebras: { name: "Cerebras", base: "https://api.cerebras.ai/v1", model: "gpt-oss-120b", cost: "🆓 رایگان (حدود ۱ میلیون توکن در روز، ۵ درخواست در دقیقه)", keyUrl: "cloud.cerebras.ai", json: true },
  openrouter: { name: "OpenRouter", base: "https://openrouter.ai/api/v1", model: "openrouter/free", cost: "🆓 مدل‌های :free (۵۰ درخواست در روز؛ با ۱۰ دلار شارژ ۱۰۰۰)", keyUrl: "openrouter.ai/keys", json: false },
  mistral: { name: "Mistral", base: "https://api.mistral.ai/v1", model: "mistral-small-latest", cost: "🆓 سطح Experiment (داده‌ها برای آموزش مدل استفاده می‌شود)", keyUrl: "console.mistral.ai/api-keys", json: true },
  github: { name: "GitHub Models", base: "https://models.github.ai/inference", model: "openai/gpt-4.1-mini", cost: "🆓 رایگان با حساب گیت‌هاب (توکن شخصی با دسترسی models)", keyUrl: "github.com/settings/personal-access-tokens", json: true },
  cloudflare: { name: "Cloudflare Workers AI", base: "", model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", cost: "🆓 ۱۰ هزار Neuron در روز (در حساب Cloudflare خودتان)", keyUrl: "dash.cloudflare.com ← AI ← Workers AI", json: false },
  deepseek: { name: "DeepSeek", base: "https://api.deepseek.com", model: "deepseek-chat", cost: "💳 پولی (حساب جدید اعتبار ندارد)", keyUrl: "platform.deepseek.com", json: true },
  openai: { name: "ChatGPT (OpenAI)", base: "https://api.openai.com/v1", model: "gpt-4o-mini", cost: "💳 پولی (API رایگان ندارد)", keyUrl: "platform.openai.com/api-keys", json: true },
  custom: { name: "سفارشی (سازگار با OpenAI)", base: "", model: "", cost: "", keyUrl: "", json: false },
};
export const PROVIDER_IDS = Object.keys(PROVIDERS) as ProviderId[];
export const isProvider = (x: string): x is ProviderId => x in PROVIDERS;

export interface LlmCfg { id: ProviderId; name: string; base: string; model: string; key: string; json: boolean }

const envOf = (env: Env, name: string): string => ((env as unknown as Record<string, string | undefined>)[name] || "").trim();

// ---- settings: ONE query per invocation (free-plan D1 limit is 50 queries per request), cached for a few seconds
let cache: { at: number; map: Map<string, string> } | null = null;
async function all(env: Env): Promise<Map<string, string>> {
  if (cache && Date.now() - cache.at < 15_000) return cache.map;
  const rows = (await env.DB.prepare("SELECT key, value FROM settings WHERE key LIKE 'llm_%'").all<{ key: string; value: string }>()).results;
  cache = { at: Date.now(), map: new Map(rows.map((r) => [r.key, r.value])) };
  return cache.map;
}
const put = async (env: Env, key: string, value: string) => {
  await env.DB.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(key, value).run();
  cache = null;
};
const del = async (env: Env, key: string) => { await env.DB.prepare("DELETE FROM settings WHERE key=?").bind(key).run(); cache = null; };

/** Key from a Secret (GEMINI_API_KEY, GROQ_API_KEY, … ; legacy LLM_API_KEY = DeepSeek, or "custom" when LLM_BASE_URL is set) or the one the admin saved. */
async function keyOf(env: Env, id: ProviderId, m: Map<string, string>): Promise<{ key: string; fromEnv: boolean }> {
  const legacy = envOf(env, "LLM_API_KEY") && (envOf(env, "LLM_BASE_URL") ? id === "custom" : id === "deepseek") ? envOf(env, "LLM_API_KEY") : "";
  const e = envOf(env, `${id.toUpperCase()}_API_KEY`) || legacy;
  if (e) return { key: e, fromEnv: true };
  const s = m.get(`llm_key:${id}`);
  return { key: s ? await dec(env.SECRET_KEY, s) : "", fromEnv: false };
}

export interface ProviderState { id: ProviderId; info: ProviderInfo; hasKey: boolean; fromEnv: boolean; model: string; base: string; active: boolean; coolUntil: number }

export async function listProviders(env: Env): Promise<ProviderState[]> {
  const m = await all(env), active = m.get("llm_active") as ProviderId | undefined;
  const out: ProviderState[] = [];
  for (const id of PROVIDER_IDS) {
    const info = PROVIDERS[id], k = await keyOf(env, id, m);
    const base = envOf(env, `${id.toUpperCase()}_BASE_URL`) || (id === "custom" ? envOf(env, "LLM_BASE_URL") : "") || m.get(`llm_base:${id}`) || info.base;
    const model = (id === "custom" ? envOf(env, "LLM_MODEL") : "") || m.get(`llm_model:${id}`) || info.model;
    out.push({ id, info, hasKey: !!k.key, fromEnv: k.fromEnv, model, base: base.replace(/\/+$/, ""), active: active === id, coolUntil: parseInt(m.get(`llm_cool:${id}`) || "0", 10) });
  }
  return out;
}

/** Providers usable right now: the active one first, then the rest in free-first order. Providers on cooldown go last. */
export async function llmChain(env: Env): Promise<LlmCfg[]> {
  const m = await all(env), t = Math.floor(Date.now() / 1000);
  const ok = (await listProviders(env)).filter((p) => p.hasKey && p.base && p.model);
  ok.sort((a, b) => Number(a.coolUntil > t) - Number(b.coolUntil > t) || Number(b.active) - Number(a.active));
  const out: LlmCfg[] = [];
  for (const p of ok) out.push({ id: p.id, name: p.info.name, base: p.base, model: p.model, key: (await keyOf(env, p.id, m)).key, json: p.info.json });
  return out;
}
export const llmReady = async (env: Env): Promise<boolean> => (await llmChain(env)).length > 0;

/** Called by the client after a failure: quota/balance/key problems rest for a while, outages only briefly. */
export async function markCooldown(env: Env, id: ProviderId, seconds: number): Promise<void> {
  await put(env, `llm_cool:${id}`, String(Math.floor(Date.now() / 1000) + seconds));
}
export const clearCooldown = (env: Env, id: ProviderId) => del(env, `llm_cool:${id}`);

export async function saveKey(env: Env, id: ProviderId, key: string): Promise<void> {
  await put(env, `llm_key:${id}`, await enc(env.SECRET_KEY, key));
  await del(env, `llm_cool:${id}`);
  if (!(await all(env)).get("llm_active")) await put(env, "llm_active", id);   // the first provider becomes active automatically
}
export async function clearKey(env: Env, id: ProviderId): Promise<void> {
  await del(env, `llm_key:${id}`);
  if ((await all(env)).get("llm_active") === id) await del(env, "llm_active");
}
export const setModel = (env: Env, id: ProviderId, model: string) => put(env, `llm_model:${id}`, model);
export const setBase = (env: Env, id: ProviderId, base: string) => put(env, `llm_base:${id}`, base);
export const setActive = (env: Env, id: ProviderId) => put(env, "llm_active", id);

export async function cfgFor(env: Env, id: ProviderId): Promise<LlmCfg | null> {
  const m = await all(env), p = (await listProviders(env)).find((x) => x.id === id);
  if (!p || !p.hasKey || !p.base || !p.model) return null;
  return { id, name: p.info.name, base: p.base, model: p.model, key: (await keyOf(env, id, m)).key, json: p.info.json };
}

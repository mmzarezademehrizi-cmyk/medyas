// LLM providers for the agent. Everything speaks the OpenAI chat-completions protocol, so one client covers them all.
// The admin can save a key for several providers; the active one is tried first and the others act as automatic fallbacks
// (handy with free tiers that run out of quota or are temporarily unreachable).
import { dec, enc } from "./crypto";
import { Env } from "./env";

export type ProviderId = "gemini" | "openrouter" | "deepseek" | "openai" | "custom";
export interface ProviderInfo { name: string; base: string; model: string; cost: string; keyUrl: string; json: boolean }

export const PROVIDERS: Record<ProviderId, ProviderInfo> = {
  gemini: { name: "Gemini (گوگل)", base: "https://generativelanguage.googleapis.com/v1beta/openai", model: "gemini-flash-latest", cost: "🆓 سطح رایگان دارد", keyUrl: "aistudio.google.com/apikey", json: true },
  openrouter: { name: "OpenRouter", base: "https://openrouter.ai/api/v1", model: "openrouter/free", cost: "🆓 مدل‌های رایگان (محدود)", keyUrl: "openrouter.ai/keys", json: false },
  deepseek: { name: "DeepSeek", base: "https://api.deepseek.com", model: "deepseek-chat", cost: "💳 پولی (حساب جدید اعتبار ندارد)", keyUrl: "platform.deepseek.com", json: true },
  openai: { name: "ChatGPT (OpenAI)", base: "https://api.openai.com/v1", model: "gpt-4o-mini", cost: "💳 پولی (API رایگان ندارد)", keyUrl: "platform.openai.com/api-keys", json: true },
  custom: { name: "سفارشی (سازگار با OpenAI)", base: "", model: "", cost: "", keyUrl: "", json: false },
};
export const PROVIDER_IDS = Object.keys(PROVIDERS) as ProviderId[];
export const isProvider = (x: string): x is ProviderId => x in PROVIDERS;

export interface LlmCfg { id: ProviderId; name: string; base: string; model: string; key: string; json: boolean }

const envOf = (env: Env, name: string): string => ((env as unknown as Record<string, string | undefined>)[name] || "").trim();
async function setting(env: Env, key: string): Promise<string> {
  const r = await env.DB.prepare("SELECT value FROM settings WHERE key=?").bind(key).first<{ value: string }>();
  return r ? r.value : "";
}
const put = (env: Env, key: string, value: string) =>
  env.DB.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(key, value).run();
const del = (env: Env, key: string) => env.DB.prepare("DELETE FROM settings WHERE key=?").bind(key).run();

/** Key from a Secret (GEMINI_API_KEY, OPENROUTER_API_KEY, … ; legacy LLM_API_KEY = DeepSeek, or "custom" when LLM_BASE_URL is set) or the one the admin saved. */
async function keyOf(env: Env, id: ProviderId): Promise<{ key: string; fromEnv: boolean }> {
  const e = envOf(env, `${id.toUpperCase()}_API_KEY`) || (envOf(env, "LLM_API_KEY") && (envOf(env, "LLM_BASE_URL") ? id === "custom" : id === "deepseek") ? envOf(env, "LLM_API_KEY") : "");
  if (e) return { key: e, fromEnv: true };
  const s = await setting(env, `llm_key:${id}`);
  return { key: s ? await dec(env.SECRET_KEY, s) : "", fromEnv: false };
}

export interface ProviderState { id: ProviderId; info: ProviderInfo; hasKey: boolean; fromEnv: boolean; model: string; base: string; active: boolean }

export async function listProviders(env: Env): Promise<ProviderState[]> {
  const active = (await setting(env, "llm_active")) as ProviderId;
  const out: ProviderState[] = [];
  for (const id of PROVIDER_IDS) {
    const info = PROVIDERS[id], k = await keyOf(env, id);
    const base = envOf(env, `${id.toUpperCase()}_BASE_URL`) || (id === "custom" ? envOf(env, "LLM_BASE_URL") : "") || (await setting(env, `llm_base:${id}`)) || info.base;
    const model = (id === "custom" ? envOf(env, "LLM_MODEL") : "") || (await setting(env, `llm_model:${id}`)) || info.model;
    out.push({ id, info, hasKey: !!k.key, fromEnv: k.fromEnv, model, base: base.replace(/\/+$/, ""), active: active === id });
  }
  return out;
}

/** Providers that can be used right now: the active one first, then the others in a sensible free-first order. */
export async function llmChain(env: Env): Promise<LlmCfg[]> {
  const all = (await listProviders(env)).filter((p) => p.hasKey && p.base && p.model);
  all.sort((a, b) => Number(b.active) - Number(a.active));
  const out: LlmCfg[] = [];
  for (const p of all) out.push({ id: p.id, name: p.info.name, base: p.base, model: p.model, key: (await keyOf(env, p.id)).key, json: p.info.json });
  return out;
}
export const llmReady = async (env: Env): Promise<boolean> => (await llmChain(env)).length > 0;

export async function saveKey(env: Env, id: ProviderId, key: string): Promise<void> {
  await put(env, `llm_key:${id}`, await enc(env.SECRET_KEY, key));
  if (!(await setting(env, "llm_active"))) await put(env, "llm_active", id);   // the first provider becomes active automatically
}
export async function clearKey(env: Env, id: ProviderId): Promise<void> {
  await del(env, `llm_key:${id}`);
  if ((await setting(env, "llm_active")) === id) await del(env, "llm_active");
}
export const setModel = (env: Env, id: ProviderId, model: string) => put(env, `llm_model:${id}`, model);
export const setBase = (env: Env, id: ProviderId, base: string) => put(env, `llm_base:${id}`, base);
export const setActive = (env: Env, id: ProviderId) => put(env, "llm_active", id);

export async function cfgFor(env: Env, id: ProviderId): Promise<LlmCfg | null> {
  const p = (await listProviders(env)).find((x) => x.id === id);
  if (!p || !p.hasKey || !p.base || !p.model) return null;
  return { id, name: p.info.name, base: p.base, model: p.model, key: (await keyOf(env, id)).key, json: p.info.json };
}

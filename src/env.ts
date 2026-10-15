export interface Env {
  DB: D1Database;
  AI?: { run(model: string, input: Record<string, unknown>): Promise<any> };   // Workers AI binding: free, no API key needed
  DISABLE_WORKERS_AI?: string;   // set to 1 to ignore the Workers AI binding
  BOT_TOKEN: string;
  SECRET_KEY: string;
  WEBHOOK_SECRET: string;
  ADMIN_IDS?: string;
  TG_API_BASE?: string;     // default https://api.telegram.org
  EITAA_API_BASE?: string;  // default https://eitaayar.ir/api  (point at your own relay if eitaayar blocks Cloudflare IPs)
  EITAA_WEB_BASE?: string;  // default https://eitaa.com
  LLM_API_KEY?: string;      // optional: DeepSeek (or any OpenAI-compatible) key for the agent; otherwise the admin sets it from the bot
  LLM_BASE_URL?: string;     // default https://api.deepseek.com
  LLM_MODEL?: string;        // default deepseek-chat
}
export const tgBase = (e: Env) => (e.TG_API_BASE || "https://api.telegram.org").replace(/\/$/, "");
export const eitaaBase = (e: Env) => (e.EITAA_API_BASE || "https://eitaayar.ir/api").replace(/\/$/, "");
export const eitaaWeb = (e: Env) => (e.EITAA_WEB_BASE || "https://eitaa.com").replace(/\/$/, "");
export const adminIds = (e: Env): number[] => (e.ADMIN_IDS || "").split(/[,\s]+/).filter((x) => /^\d+$/.test(x)).map(Number);
export const llmBase = (e: Env) => (e.LLM_BASE_URL || "https://api.deepseek.com").replace(/\/$/, "");
export const llmModel = (e: Env) => e.LLM_MODEL || "deepseek-chat";

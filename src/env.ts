export interface Env {
  DB: D1Database;
  BOT_TOKEN: string;
  SECRET_KEY: string;
  WEBHOOK_SECRET: string;
  ADMIN_IDS?: string;
  TG_API_BASE?: string;     // default https://api.telegram.org
  EITAA_API_BASE?: string;  // default https://eitaayar.ir/api  (point at your own relay if eitaayar blocks Cloudflare IPs)
  EITAA_WEB_BASE?: string;  // default https://eitaa.com
  RUBIKA_BOT_TOKEN?: string; // optional: platform Rubika bot token (otherwise the admin sets it from the bot)
  RUBIKA_API_BASE?: string;  // default https://botapi.rubika.ir/v3
}
export const tgBase = (e: Env) => (e.TG_API_BASE || "https://api.telegram.org").replace(/\/$/, "");
export const eitaaBase = (e: Env) => (e.EITAA_API_BASE || "https://eitaayar.ir/api").replace(/\/$/, "");
export const eitaaWeb = (e: Env) => (e.EITAA_WEB_BASE || "https://eitaa.com").replace(/\/$/, "");
export const adminIds = (e: Env): number[] => (e.ADMIN_IDS || "").split(/[,\s]+/).filter((x) => /^\d+$/.test(x)).map(Number);
export const rubikaBase = (e: Env) => (e.RUBIKA_API_BASE || "https://botapi.rubika.ir/v3").replace(/\/$/, "");

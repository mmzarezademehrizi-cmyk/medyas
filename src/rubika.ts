// Rubika Bot API client (https://botapi.rubika.ir/v3/{token}/{method}, JSON in / {status, data} out).
import { Env, rubikaBase } from "./env";

export class RubikaError extends Error {}
export class RubikaNetworkError extends RubikaError {}

export interface RbOpts { silent?: boolean }

async function call(env: Env, token: string, method: string, body: Record<string, unknown> = {}): Promise<any> {
  const clean = (m: string) => m.split(token).join("***");
  let r: Response;
  try {
    r = await fetch(`${rubikaBase(env)}/${token}/${method}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
  } catch (e) {
    throw new RubikaNetworkError(clean(`${(e as Error).name}: ${(e as Error).message}`));
  }
  let j: any;
  try { j = await r.json(); } catch { throw new RubikaError(`پاسخ نامعتبر از روبیکا (HTTP ${r.status})`); }
  if (!j || typeof j !== "object" || (j.status && j.status !== "OK")) {
    throw new RubikaError(clean(String((j && (j.status_det || j.status || j.message)) || `HTTP ${r.status}`)));
  }
  return j.data ?? j;
}

export const getMe = async (env: Env, token: string) => { const d = await call(env, token, "getMe"); return d.bot ?? d; };
export const getChat = async (env: Env, token: string, chatId: string) => { const d = await call(env, token, "getChat", { chat_id: chatId }); return d.chat ?? d; };
export const deleteMessage = (env: Env, token: string, chatId: string, messageId: string) =>
  call(env, token, "deleteMessage", { chat_id: chatId, message_id: messageId });

export async function sendMessage(env: Env, token: string, chatId: string, text: string, o: RbOpts = {}): Promise<string> {
  const d = await call(env, token, "sendMessage", { chat_id: chatId, text, ...(o.silent ? { disable_notification: true } : {}) });
  return String(d.message_id ?? d.new_message_id ?? "");
}

function fileType(name: string): "Image" | "Video" | "Music" | "File" {
  const ext = (name.split(".").pop() || "").toLowerCase();
  if (["jpg", "jpeg", "png", "webp"].includes(ext)) return "Image";
  if (["mp4", "mov", "mkv", "webm"].includes(ext)) return "Video";
  if (["mp3", "ogg", "m4a", "wav", "aac"].includes(ext)) return "Music";
  return "File";
}

/** requestSendFile -> upload -> sendFile (the documented 3-step flow). */
export async function sendFile(env: Env, token: string, chatId: string, name: string, bytes: Uint8Array, caption: string, o: RbOpts = {}): Promise<string> {
  const req = await call(env, token, "requestSendFile", { type: fileType(name) });
  const url = req.upload_url;
  if (!url) throw new RubikaError("روبیکا آدرس آپلود نداد.");
  const form = new FormData();
  form.set("file", new Blob([bytes.slice().buffer as ArrayBuffer]), name);
  let up: Response;
  try { up = await fetch(url, { method: "POST", body: form }); }
  catch (e) { throw new RubikaNetworkError(`آپلود به روبیکا ناموفق بود: ${(e as Error).message}`); }
  const uj: any = await up.json().catch(() => ({}));
  const fileId = uj?.data?.file_id ?? uj?.file_id;
  if (!fileId) throw new RubikaError(String(uj?.status_det || uj?.status || `آپلود ناموفق (HTTP ${up.status})`));
  const d = await call(env, token, "sendFile", { chat_id: chatId, file_id: fileId, text: caption || undefined, ...(o.silent ? { disable_notification: true } : {}) });
  return String(d.message_id ?? d.new_message_id ?? "");
}

export type Verify = { ok: true; title: string } | { ok: false; reason: string };

/** The bot must be able to post in the channel: getChat must resolve it AND a probe message must go through. */
export async function verifyChannel(env: Env, token: string, chatId: string): Promise<Verify> {
  let title = "";
  try {
    const chat = await getChat(env, token, chatId);
    title = String(chat?.title || chat?.first_name || "").trim();
    const type = String(chat?.chat_type || chat?.type || "");
    if (type && !/channel/i.test(type)) return { ok: false, reason: "این شناسه کانال نیست (گروه یا کاربر است)." };
  } catch (e) {
    return { ok: false, reason: `کانال پیدا نشد یا ربات به آن دسترسی ندارد (${(e as Error).message}).` };
  }
  try {
    const mid = await sendMessage(env, token, chatId, "✅ اتصال برقرار شد");
    if (mid) { try { await deleteMessage(env, token, chatId, mid); } catch { /* best effort */ } }
  } catch (e) {
    return { ok: false, reason: `ربات هنوز اجازه‌ی ارسال در این کانال را ندارد؛ آن را ادمین کنید (${(e as Error).message}).` };
  }
  return { ok: true, title: title.slice(0, 100) };
}

/** Accepts a channel GUID (c0…), @username, or a rubika.ir link. */
export function normalizeRubikaChat(raw: string): string {
  const t = raw.replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0)).trim();
  const m = t.match(/rubika\.ir\/(?:joinc\/)?([^/?\s]+)/i);
  return (m ? m[1] : t).replace(/^@/, "").trim();
}

/** Rubika's API only accepts the internal chat id (GUID) of a channel, not @username or links. */
export const isGuid = (id: string): boolean => /^[A-Za-z0-9]{20,}$/.test(id);

export async function getUpdates(env: Env, token: string, limit = 100): Promise<any[]> {
  const d = await call(env, token, "getUpdates", { limit });
  return Array.isArray(d?.updates) ? d.updates : [];
}

/** Channels the bot has recently seen activity in (the bot must already be an admin there). */
export async function discoverChannels(env: Env, token: string): Promise<{ chat_id: string; title: string }[]> {
  const ids: string[] = [];
  for (const u of await getUpdates(env, token)) {
    const id = String(u?.chat_id ?? u?.new_message?.chat_id ?? "");
    if (id && !ids.includes(id)) ids.push(id);
  }
  const out: { chat_id: string; title: string }[] = [];
  for (const id of ids.slice(-10)) {
    try {
      const chat = await getChat(env, token, id);
      if (/channel/i.test(String(chat?.chat_type || chat?.type || ""))) out.push({ chat_id: id, title: String(chat?.title || id).slice(0, 100) });
    } catch { /* not resolvable: skip */ }
  }
  return out;
}

import { dec, enc } from "./crypto";
import { Env } from "./env";

export interface UserRow {
  id: number; name: string; username: string; eitaa_token_enc: string; eitaa_account: string;
  expires_at: number | null; banned: number; created_at: number;
}
export interface ChannelRow { id: number; user_id: number; chat_id: string; title: string; platform: string }
export interface PostRow {
  id: number; user_id: number; channel_id: number; kind: string; text: string; file_id: string; file_name: string; title: string;
  silent: number; pin: number; view_delete: number; run_at: number; status: string; error: string;
}
export const now = (): number => Math.floor(Date.now() / 1000);

export async function getSession(env: Env, uid: number): Promise<{ state: string; data: Record<string, any> }> {
  const r = await env.DB.prepare("SELECT state, data FROM sessions WHERE user_id=?").bind(uid).first<{ state: string; data: string }>();
  if (!r) return { state: "", data: {} };
  try { return { state: r.state, data: JSON.parse(r.data) }; } catch { return { state: r.state, data: {} }; }
}
export async function setSession(env: Env, uid: number, state: string, data: Record<string, any> = {}): Promise<void> {
  await env.DB.prepare("INSERT INTO sessions(user_id,state,data,updated_at) VALUES(?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET state=excluded.state,data=excluded.data,updated_at=excluded.updated_at")
    .bind(uid, state, JSON.stringify(data), now()).run();
}
export const clearSession = (env: Env, uid: number) => setSession(env, uid, "", {});

export async function touchUser(env: Env, id: number, name: string, username: string): Promise<UserRow> {
  await env.DB.prepare("INSERT INTO users(id,name,username,created_at) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, username=excluded.username")
    .bind(id, name.slice(0, 100), (username || "").slice(0, 64), now()).run();
  return (await env.DB.prepare("SELECT * FROM users WHERE id=?").bind(id).first<UserRow>())!;
}
export const getUser = (env: Env, id: number) => env.DB.prepare("SELECT * FROM users WHERE id=?").bind(id).first<UserRow>();
export const getChannel = (env: Env, id: number) => env.DB.prepare("SELECT * FROM channels WHERE id=?").bind(id).first<ChannelRow>();
export const userChannels = async (env: Env, uid: number) =>
  (await env.DB.prepare("SELECT * FROM channels WHERE user_id=? ORDER BY id").bind(uid).all<ChannelRow>()).results;

// Platform-level Rubika bot token: RUBIKA_BOT_TOKEN secret wins, otherwise the one the admin saved from the bot (encrypted).
export async function rubikaToken(env: Env): Promise<string> {
  if (env.RUBIKA_BOT_TOKEN && env.RUBIKA_BOT_TOKEN.trim()) return env.RUBIKA_BOT_TOKEN.trim();
  const r = await env.DB.prepare("SELECT value FROM settings WHERE key='rubika_token_enc'").first<{ value: string }>();
  return r ? await dec(env.SECRET_KEY, r.value) : "";
}
export async function saveRubikaToken(env: Env, token: string): Promise<void> {
  await env.DB.prepare("INSERT INTO settings(key,value) VALUES('rubika_token_enc',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(await enc(env.SECRET_KEY, token)).run();
}
export const clearRubikaToken = (env: Env) => env.DB.prepare("DELETE FROM settings WHERE key='rubika_token_enc'").run();

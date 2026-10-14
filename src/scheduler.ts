// Delivery of posts: called right away for "send now" and from the cron tick for scheduled ones.
import { dec } from "./crypto";
import { ChannelRow, PostRow, UserRow, now, rubikaToken } from "./db";
import * as eitaa from "./eitaa";
import { Env } from "./env";
import * as rubika from "./rubika";
import * as tg from "./tg";
import { esc, fmtDt } from "./util";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function sendRubika(env: Env, token: string, p: PostRow, ch: ChannelRow): Promise<string> {
  const text = (p.title ? `🏷 ${p.title}\n\n` : "") + p.text;
  const o = { silent: !!p.silent };
  return p.kind === "text"
    ? rubika.sendMessage(env, token, ch.chat_id, text, o)
    : rubika.sendFile(env, token, ch.chat_id, p.file_name || "file", await tg.download(env, p.file_id), text, o);
}

async function sendOnce(env: Env, token: string, p: PostRow, ch: ChannelRow): Promise<string> {
  if (ch.platform === "rubika") return sendRubika(env, token, p, ch);
  const o: eitaa.PostOpts = { title: p.title || undefined, silent: !!p.silent, pin: !!p.pin, viewDelete: p.view_delete || undefined };
  const res = p.kind === "text"
    ? await eitaa.sendMessage(env, token, ch.chat_id, p.text, o)
    : await eitaa.sendFile(env, token, ch.chat_id, p.file_name || "file", await tg.download(env, p.file_id), p.text, o);
  const id = res && (res.message_id ?? res.id ?? res.result?.message_id);
  return id ? String(id) : "";
}

/** Claims the post (pending -> sending) so two ticks can never send the same post twice, then sends with retries. */
export async function deliver(env: Env, postId: number): Promise<void> {
  const claim = await env.DB.prepare("UPDATE posts SET status='sending', claimed_at=? WHERE id=? AND status='pending'").bind(now(), postId).run();
  if (!claim.meta.changes) return;
  const p = (await env.DB.prepare("SELECT * FROM posts WHERE id=?").bind(postId).first<PostRow>())!;
  const user = await env.DB.prepare("SELECT * FROM users WHERE id=?").bind(p.user_id).first<UserRow>();
  const ch = await env.DB.prepare("SELECT * FROM channels WHERE id=?").bind(p.channel_id).first<ChannelRow>();
  const fail = async (msg: string) => {
    await env.DB.prepare("UPDATE posts SET status='failed', error=? WHERE id=?").bind(msg.slice(0, 300), p.id).run();
    await tg.send(env, p.user_id, `❌ ارسال پست #${p.id} ناموفق بود:\n${esc(msg)}`);
  };
  if (!user || !ch) return fail("کاربر یا کانال دیگر وجود ندارد.");
  const isRb = ch.platform === "rubika";
  const token = isRb ? await rubikaToken(env) : await dec(env.SECRET_KEY, user.eitaa_token_enc);
  if (!token) return fail(isRb ? "ربات روبیکا فعلاً در دسترس نیست. با مدیر تماس بگیرید." : "توکن ایتایار ثبت نشده یا نامعتبر است. آن را دوباره در «برنامه‌های متصل» ثبت کنید.");
  let last = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const mid = await sendOnce(env, token, p, ch);
      await env.DB.prepare("UPDATE posts SET status='sent', sent_at=?, eitaa_message_id=?, error='' WHERE id=?").bind(now(), mid, p.id).run();
      await tg.send(env, p.user_id, `✅ پست #${p.id} در ${isRb ? "🟣" : "🟠"} «${esc(ch.title)}» ارسال شد.`);
      return;
    } catch (e) {
      last = (e as Error).message;
      const retryable = e instanceof eitaa.EitaaNetworkError || e instanceof rubika.RubikaNetworkError;
      if (!retryable || attempt === 2) break;
      await sleep(2000 * (attempt + 1));
    }
  }
  await fail(last || "خطای نامشخص");
}

/** Cron tick (every minute). Small batches keep each invocation inside the free-plan limits. */
export async function tick(env: Env): Promise<void> {
  const t = now();
  await env.DB.prepare("UPDATE posts SET status='failed', error='ارسال نیمه‌کاره ماند؛ لطفاً دوباره زمان‌بندی کنید.' WHERE status='sending' AND claimed_at < ?").bind(t - 900).run();
  const due = (await env.DB.prepare("SELECT id FROM posts WHERE status='pending' AND run_at<=? ORDER BY run_at LIMIT 3").bind(t).all<{ id: number }>()).results;
  for (const d of due) {
    try { await deliver(env, d.id); } catch (e) { console.error("deliver failed", d.id, (e as Error).message); }
  }
}

export const describe = (p: PostRow) => `#${p.id} · ${fmtDt(p.run_at)}`;

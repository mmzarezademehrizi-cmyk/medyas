// Live conversation with the agent inside the bot: the owner talks, the agent acts right away with real tools
// (read a public channel, send to his channel and wait for the real delivery result, schedule) and reports what actually happened.
import { RefInfo, readChannel } from "./agent";
import { ChannelRow, UserRow, getSession, now, setSession, userChannels } from "./db";
import { Env } from "./env";
import { ChatMsg, ToolDef, chatTools } from "./llm";
import { llmReady } from "./providers";
import { deliver } from "./scheduler";
import { fetchChannel } from "./source";
import * as tg from "./tg";
import { TgMessage } from "./tg";
import { esc, fmtDt, jalaliLong, pad2, parseWhen, toLocal } from "./util";

type Ctx = { env: Env; wait: (p: Promise<unknown>) => void };
const MAX_STEPS = 6;
const BUDGET_MS = 42_000;
const STEP_TIMEOUT_MS = 20_000;
const HIST_KEEP = 10;

const INTRO = "💬 <b>گفتگوی زنده با ایجنت</b>\n\nهر چه می‌خواهید بنویسید؛ همان لحظه انجام می‌دهد و نتیجه‌ی واقعی را می‌گوید. مثلاً:\n" +
  "• <i>برای تست یک «سلام» توی کانالم بفرست</i>\n• <i>از کانال @name آخرین پست‌ها را نشانم بده</i>\n• <i>از @name یک استیکر تقویم پیدا کن و بفرست</i>\n• <i>فردا ساعت ۹ این متن را بگذار: …</i>\n\n" +
  "خروج: /cancel یا هر دکمه‌ی منو.";

export async function start(env: Env, u: UserRow): Promise<void> {
  if (!(await llmReady(env))) return void (await tg.send(env, u.id, "⏳ ایجنت هنوز فعال نشده است (مدیر باید یک سرویس هوش مصنوعی را در «🛠 مدیریت» تنظیم کند)."));
  if (!u.eitaa_token_enc) return void (await tg.send(env, u.id, "ابتدا از «برنامه‌های متصل» توکن ایتایار را ثبت کنید."));
  if (!(await userChannels(env, u.id)).length) return void (await tg.send(env, u.id, "ابتدا از «کانال‌ها» کانال خودتان را اضافه کنید."));
  await setSession(env, u.id, "chat", { hist: [], last_mid: 0, busy_until: 0 });
  await tg.send(env, u.id, INTRO);
}

const TOOLS: ToolDef[] = [
  { type: "function", function: { name: "list_channels", description: "List the owner's own channels (the ones you can post to).", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "get_current_time", description: "Current date/time in Tehran (Jalali date, weekday, clock).", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "read_channel", description: "Read the latest posts of a PUBLIC Eitaa channel by its @id. Newest first. Each post has a ref, text, has_image, has_sticker.",
    parameters: { type: "object", properties: { channel: { type: "string" }, limit: { type: "integer", description: "default 12, max 20" } }, required: ["channel"] } } },
  { type: "function", function: { name: "post_to_channel", description: "Send a post to one of the owner's channels RIGHT NOW and wait for the real result: {status:'sent'} or {status:'failed', error}. Optionally attach the image — or send the sticker — of a post you read (image_ref); for a sticker leave text empty.",
    parameters: { type: "object", properties: { text: { type: "string" }, image_ref: { type: "string", description: "ref from read_channel, e.g. \"name/123\"" }, channel_id: { type: "integer", description: "id from list_channels (optional if the owner has one channel)" } }, required: ["text"] } } },
  { type: "function", function: { name: "schedule_post", description: "Schedule a text post for later. `when` examples: \"18:30\", \"فردا 09:00\", \"+45\" (minutes from now), \"1405/07/20 18:30\" (Tehran time).",
    parameters: { type: "object", properties: { text: { type: "string" }, when: { type: "string" }, channel_id: { type: "integer" } }, required: ["text", "when"] } } },
];

export async function turn(c: Ctx, user: UserRow, m: TgMessage, text: string, data: Record<string, any>): Promise<void> {
  const { env } = c, uid = user.id, t0 = Date.now();
  if (!text) return void (await tg.send(env, uid, "در گفتگو فعلاً فقط پیام متنی می‌فهمم. (برای ارسال فایل از «✍️ پست جدید» استفاده کنید.)"));
  if (m.message_id <= (data.last_mid || 0)) return;                                  // Telegram re-delivery of a message already handled
  if ((data.busy_until || 0) > now()) return void (await tg.send(env, uid, "⏳ هنوز دارم پیام قبلی را انجام می‌دهم؛ چند ثانیه صبر کنید."));
  await setSession(env, uid, "chat", { ...data, last_mid: m.message_id, busy_until: now() + 70 });

  await tg.typing(env, uid);
  const mid = await tg.send(env, uid, "🤔 …");
  const show = (t: string) => (mid ? tg.edit(env, uid, mid, t) : Promise.resolve());

  const chans = await userChannels(env, uid);
  const st = { channels: new Map<string, Awaited<ReturnType<typeof fetchChannel>>>(), refs: new Map<string, RefInfo>() };
  const tnow = now(), l = toLocal(tnow);
  const system =
    `You are the LIVE assistant of the owner of Eitaa channel(s), chatting with him in Persian inside a Telegram bot. You can act for real with your tools.\n` +
    `LIVE CHAT RULES\n- When he clearly asks for an action (send a message, test message, read a channel, send a sticker…), DO IT NOW with the tools — do not ask for confirmation. Ask ONE short question only if something essential is missing (which channel, what text).\n` +
    `- Post exactly the text he asked for (e.g. "send سلام" → text "سلام"). Never add a signature unless asked.\n` +
    `- After acting, answer briefly and truthfully using the tool result: say it was sent, or that it failed and why. NEVER claim success if the tool returned failed or an error.\n` +
    `- You can only read PUBLIC channels he names (no global search). Posts have has_image / has_sticker; to forward a sticker or image use post_to_channel with image_ref.\n` +
    `- If a source post contains the source channel's name/@id/links, remove them from text you forward.\n` +
    `- Today (Tehran): ${jalaliLong(tnow)} — ${l.y}-${pad2(l.mo)}-${pad2(l.d)}, ${pad2(l.h)}:${pad2(l.mi)}.\n` +
    `HIS CHANNELS: ${chans.map((x) => `id=${x.id} «${x.title}» (@${x.chat_id})`).join("; ")}`;
  const hist: { r: "u" | "a"; t: string }[] = Array.isArray(data.hist) ? data.hist : [];
  const messages: ChatMsg[] = [{ role: "system", content: system }, ...hist.map((h) => ({ role: h.r === "u" ? "user" : "assistant", content: h.t }) as ChatMsg), { role: "user", content: text }];

  const pick = (id: unknown): ChannelRow | string => {
    if (id === undefined || id === null || id === "") return chans.length === 1 ? chans[0] : "specify channel_id (he has several channels: ask him which one)";
    return chans.find((x) => x.id === Number(id)) || "unknown channel_id";
  };
  const insert = async (ch: ChannelRow, kind: "text" | "file", body: string, file: string, name: string, runAt: number) =>
    (await env.DB.prepare("INSERT INTO posts(user_id,channel_id,kind,text,file_id,file_name,title,silent,pin,view_delete,run_at,status,created_at,src_url) VALUES(?,?,?,?,'',?,'',0,0,0,?,'pending',?,?)")
      .bind(uid, ch.id, kind, body, name, runAt, now(), file).run()).meta.last_row_id as number;

  const exec = async (name: string, a: any): Promise<unknown> => {
    switch (name) {
      case "list_channels": return chans.map((x) => ({ id: x.id, title: x.title, username: x.chat_id }));
      case "get_current_time": { const n = now(), q = toLocal(n); return { jalali: jalaliLong(n), gregorian: `${q.y}-${pad2(q.mo)}-${pad2(q.d)}`, time: `${pad2(q.h)}:${pad2(q.mi)}` }; }
      case "read_channel": { await show(`🔎 در حال خواندن @${esc(String(a.channel || ""))}…`); return readChannel(env, st, a, null, 4); }
      case "post_to_channel": {
        const ch = pick(a.channel_id);
        if (typeof ch === "string") return { status: "failed", error: ch };
        const ri = a.image_ref ? st.refs.get(String(a.image_ref)) : undefined;
        if (a.image_ref && !ri?.image) return { status: "failed", error: "image_ref has no image/sticker" };
        const body = ri?.sticker ? "" : String(a.text || "").trim();
        if (!body && !ri) return { status: "failed", error: "empty text" };
        if (body.length > (ri ? 1000 : 3900)) return { status: "failed", error: ri ? "caption too long (max 1000 chars)" : "text too long" };
        await show(`📤 در حال ارسال به «${esc(ch.title)}»…`);
        const id = await insert(ch, ri ? "file" : "text", body, ri?.image || "", ri?.sticker ? "sticker.webp" : "", now());
        await deliver(env, id, true);
        const r = await env.DB.prepare("SELECT status, error FROM posts WHERE id=?").bind(id).first<{ status: string; error: string }>();
        return r?.status === "sent" ? { status: "sent", post_id: id, channel: ch.title } : { status: "failed", error: r?.error || "unknown error" };
      }
      case "schedule_post": {
        const ch = pick(a.channel_id);
        if (typeof ch === "string") return { status: "failed", error: ch };
        const at = parseWhen(String(a.when || ""));
        const body = String(a.text || "").trim();
        if (at === null) return { status: "failed", error: "invalid or past time; use formats like 18:30, فردا 09:00, +45, 1405/07/20 18:30" };
        if (!body || body.length > 3900) return { status: "failed", error: "empty or too long text" };
        const id = await insert(ch, "text", body, "", "", at);
        return { status: "scheduled", post_id: id, at: fmtDt(at), channel: ch.title };
      }
    }
    return { error: `unknown tool ${name}` };
  };

  let answer = "", failedWhy = "";
  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      if (Date.now() - t0 > BUDGET_MS) { answer = "⏱ زمان این درخواست تمام شد؛ اگر کار کامل نشد دوباره بگویید."; break; }
      const r = await chatTools(env, messages, TOOLS, STEP_TIMEOUT_MS);
      messages.push(r);
      if (!r.tool_calls?.length) { answer = (r.content || "").trim(); break; }
      for (const call of r.tool_calls) {
        let out: unknown;
        try { out = await exec(call.function.name, JSON.parse(call.function.arguments || "{}")); } catch (e) { out = { error: (e as Error).message }; }
        messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(out).slice(0, 25_000) });
      }
    }
  } catch (e) { failedWhy = (e as Error).message; }

  const final = failedWhy ? `❌ ${esc(failedWhy)}` : esc(answer || "انجام شد.");
  if (mid) await tg.edit(env, uid, mid, final.slice(0, 4000)); else await tg.send(env, uid, final);
  const keep = [...hist, { r: "u" as const, t: text.slice(0, 600) }, { r: "a" as const, t: (failedWhy ? `(خطا: ${failedWhy})` : answer).slice(0, 600) }].slice(-HIST_KEEP);
  const cur = await getSession(env, uid);
  if (cur.state === "chat") await setSession(env, uid, "chat", { hist: keep, last_mid: m.message_id, busy_until: 0 });
}

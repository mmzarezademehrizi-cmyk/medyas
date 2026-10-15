// The agent: the owner describes a task in plain Persian ("every morning at 7 post the good-morning message of @x with today's date",
// "twice a day bring 2 posts about sport from these public channels and sign them with my id"). An LLM carries it out with a few tools:
// read a public Eitaa channel, ask the date, publish to the owner's channel, retry later. Code (not the model) owns the schedule,
// the owner's signature, duplicate protection and delivery.
import { JobRow, getChannel, now } from "./db";
import { Env } from "./env";
import { ChatMsg, ToolDef, chatJson, chatTools } from "./llm";
import { llmReady } from "./providers";
import { cleanText, fetchChannel, norm } from "./source";
import * as tg from "./tg";
import { Btn, ikb } from "./tg";
import { WEEKDAYS, atTime, esc, fmtDt, fromLocal, jalaliLong, normDigits, normalizeChatId, pad2, slotKey, toLocal } from "./util";

const MAX_STEPS = 9;
const MAX_CHANNELS_PER_RUN = 5;
const MAX_POSTS_PER_RUN = 8;
const RETRY_WINDOW_S = 120 * 60;   // a slot may be retried (e.g. "the good-morning post is not there yet") for up to 2 hours
const STALE_S = 3 * 3600;          // a slot that was never started and is older than this is skipped (worker was down)
const RUN_BUDGET_MS = 100_000;

// ------------------------------------------------------------------ schedule helpers
export interface Plan { name: string; times: string[]; days: number[] | null; onceAt: number | null; summary: string }

export const parseJson = <T>(s: string | null | undefined, d: T): T => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

/** "07:00 20:30" / "۷:۰۰" -> sorted unique HH:MM list; "الان" -> "now"; otherwise null. */
export function parseTimes(text: string): string[] | "now" | null {
  const t = normDigits(text).replace(/،/g, " ");
  if (/(^|\s)(الان|همین ?الان|now)(\s|$)/i.test(t)) return "now";
  const out = new Set<string>();
  for (const m of t.matchAll(/(?<!\d)(\d{1,2})[:٫.](\d{2})(?!\d)/g)) {
    const h = +m[1], mi = +m[2];
    if (h > 23 || mi > 59) return null;
    out.add(`${pad2(h)}:${pad2(mi)}`);
  }
  return out.size && out.size <= 8 ? [...out].sort() : null;
}

export function describeSchedule(j: { times: string; days: string | null; once_at: number | null }): string {
  if (j.once_at) return `یک‌بار، ${fmtDt(j.once_at)}`;
  const times = parseJson<string[]>(j.times, []), days = parseJson<number[] | null>(j.days, null);
  if (!times.length) return "فقط با دکمه‌ی «اجرا الان»";
  const d = days && days.length && days.length < 7 ? days.map((x) => WEEKDAYS[x]).join("، ") : "هر روز";
  return `${d}، ساعت ${times.join(" و ")} (وقت تهران)`;
}

/** Turns the owner's sentence into a schedule + short name + a one-line summary of what the agent will do. */
export async function planJob(env: Env, instruction: string): Promise<Plan | null> {
  const t = now(), l = toLocal(t);
  const r = await chatJson(env,
    "You read a Persian task description for a channel-content agent and extract its schedule. Reply with a JSON object only: " +
    '{"name": short Persian title (max 30 chars), "times": array of "HH:MM" 24h Tehran times the task runs each day (empty array if no time is stated), ' +
    '"days": null if every day, otherwise array of weekday numbers 0=Sunday,1=Monday,...,6=Saturday (Saturday=شنبه, Friday=جمعه), ' +
    '"once": null, or "YYYY-MM-DD HH:MM" (Gregorian, Tehran time) if the task is a ONE-TIME task (e.g. "tomorrow at 9", "today 18:00"), ' +
    '"summary": one Persian sentence saying exactly what the agent will do}. ' +
    `Now in Tehran: ${l.y}-${pad2(l.mo)}-${pad2(l.d)} ${pad2(l.h)}:${pad2(l.mi)} (${jalaliLong(t)}).`,
    instruction, 600);
  if (!r) return null;
  const times = Array.isArray(r.times) ? (parseTimes((r.times as unknown[]).join(" ")) as string[] | "now" | null) : null;
  const days = Array.isArray(r.days) ? (r.days as unknown[]).map(Number).filter((x) => x >= 0 && x <= 6) : null;
  let onceAt: number | null = null;
  const om = typeof r.once === "string" ? r.once.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})/) : null;
  if (om) { onceAt = fromLocal({ y: +om[1], mo: +om[2], d: +om[3], h: +om[4], mi: +om[5] }); if (onceAt < t + 30) onceAt = t + 60; }
  return {
    name: String(r.name || "ایجنت").slice(0, 40),
    times: onceAt || !Array.isArray(times) ? [] : times, days: days && days.length ? days : null, onceAt,
    summary: String(r.summary || "").slice(0, 400),
  };
}

// ------------------------------------------------------------------ tick (called every minute from the cron)
interface Slot { key: string; epoch: number; kind: "daily" | "once" | "manual" }

function dueSlot(j: JobRow, t: number): Slot | null {
  if (j.run_now) return { key: `manual-${t}`, epoch: t, kind: "manual" };
  if (j.once_at) return !j.last_key && j.once_at <= t ? { key: "once", epoch: j.once_at, kind: "once" } : null;
  const times = parseJson<string[]>(j.times, []), days = parseJson<number[] | null>(j.days, null);
  const l = toLocal(t);
  if (days && days.length && !days.includes(new Date(Date.UTC(l.y, l.mo - 1, l.d)).getUTCDay())) return null;
  for (const hhmm of times) {
    const epoch = atTime(t, hhmm), key = slotKey(epoch);
    if (epoch <= t && key > j.last_key) return { key, epoch, kind: "daily" };
  }
  return null;
}

export async function agentTick(env: Env): Promise<void> {
  if (!(await llmReady(env))) return;
  const t = now();
  const jobs = (await env.DB.prepare("SELECT * FROM agent_jobs WHERE enabled=1 AND (retry_at IS NULL OR retry_at<=?) ORDER BY id LIMIT 200").bind(t).all<JobRow>()).results;
  let ran = 0;
  for (const j of jobs) {
    const slot = dueSlot(j, t);
    if (!slot) continue;
    // a daily slot that was never started and is long past (worker was down) is skipped instead of firing at a strange hour
    if (slot.kind === "daily" && j.attempts === 0 && t - slot.epoch > STALE_S) {
      await env.DB.prepare("UPDATE agent_jobs SET last_key=? WHERE id=?").bind(slot.key, j.id).run();
      continue;
    }
    if (ran >= 2) break;   // keep each invocation within free-plan limits; the rest wait for the next minute
    ran++;
    try { await runJob(env, j, slot, t); } catch (e) { console.error("agent job failed", j.id, (e as Error).message); }
  }
}

async function runJob(env: Env, j: JobRow, slot: Slot, t: number): Promise<void> {
  const claim = await env.DB.prepare("UPDATE agent_jobs SET retry_at=?, attempts=attempts+1, run_now=0 WHERE id=? AND (retry_at IS NULL OR retry_at<=?) AND attempts=?")
    .bind(t + 300, j.id, t, j.attempts).run();
  if (!claim.meta.changes) return;
  const final = slot.kind === "manual" || j.attempts + 1 >= 3 || t - slot.epoch > RETRY_WINDOW_S;
  let res: RunResult;
  try { res = await runAgent(env, j, slot, final); }
  catch (e) { res = { summary: (e as Error).message, posts: 0, retryMin: null, error: true }; }
  const retry = !final && res.retryMin ? Math.min(Math.max(res.retryMin, 2), 30) : 0;
  const info = `${fmtDt(now())} — ${res.posts} پست — ${res.summary}`.slice(0, 500);
  if (retry) {
    await env.DB.prepare("UPDATE agent_jobs SET retry_at=?, last_info=? WHERE id=?").bind(now() + retry * 60, info, j.id).run();
  } else {
    await env.DB.prepare(`UPDATE agent_jobs SET ${slot.kind === "manual" ? "" : "last_key=?, "}retry_at=NULL, attempts=0, last_info=?${slot.kind === "once" ? ", enabled=0" : ""} WHERE id=?`)
      .bind(...(slot.kind === "manual" ? [info, j.id] : [slot.key, info, j.id])).run();
  }
  if (!retry && (res.posts === 0 || res.error || slot.kind === "manual"))
    await tg.send(env, j.user_id, `🤖 <b>${esc(j.name || "ایجنت")}</b>\n${res.error ? "❌ " : ""}${esc(res.summary)}${res.posts ? `\n📝 ${res.posts} پست ساخته شد.` : ""}`);
  if (retry) console.log("agent retry", j.id, retry);
}

// ------------------------------------------------------------------ the agent loop
interface RunResult { summary: string; posts: number; retryMin: number | null; error?: boolean }

const TOOLS = (final: boolean): ToolDef[] => [
  { type: "function", function: { name: "read_channel", description: "Read the latest posts of a PUBLIC Eitaa channel (by its @id / username). Returns newest first. Text already has the channel's own signature removed. Posts with used=true were already published by this agent before.",
    parameters: { type: "object", properties: { channel: { type: "string", description: "channel username without @" }, limit: { type: "integer", description: "how many posts, default 12, max 20" } }, required: ["channel"] } } },
  { type: "function", function: { name: "get_current_time", description: "Current date and time in Tehran: Jalali (Persian) date, weekday, Gregorian date, clock.", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "post_to_channel", description: "Publish a post to the owner's channel. The owner's signature is appended automatically — do NOT add a signature yourself. Optionally attach the image of a post you read (image_ref).",
    parameters: { type: "object", properties: {
      text: { type: "string", description: "final post text in Persian (for posts with an image: max 900 chars)" },
      image_ref: { type: "string", description: "ref of a read post whose image should be attached, e.g. \"channel/123\"" },
      source_refs: { type: "array", items: { type: "string" }, description: "refs of the posts this one is based on (marks them as used)" },
      delay_minutes: { type: "integer", description: "publish after this many minutes (0 = now, max 720). Use it to spread several posts." } }, required: ["text"] } } },
  ...(final ? [] : [{ type: "function" as const, function: { name: "retry_later", description: "Use when the thing the task needs does not exist YET (e.g. today's good-morning post has not been published by the source). The whole task is retried after the given minutes. Only call it if you published nothing in this run.",
    parameters: { type: "object", properties: { minutes: { type: "integer", description: "5-30" }, reason: { type: "string" } }, required: ["minutes", "reason"] } } }]),
  { type: "function", function: { name: "finish", description: "Call when the task is complete (or when nothing suitable was found). The summary is a short Persian explanation for the owner.",
    parameters: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] } } },
];

async function runAgent(env: Env, j: JobRow, slot: Slot, final: boolean): Promise<RunResult> {
  const ch = await getChannel(env, j.channel_id);
  if (!ch || ch.user_id !== j.user_id) return { summary: "کانال مقصد دیگر وجود ندارد.", posts: 0, retryMin: null, error: true };
  const t0 = Date.now(), t = now();
  const recent = (await env.DB.prepare("SELECT text, created_at FROM posts WHERE job_id=? AND created_at>? AND status IN ('pending','draft','sending','sent') ORDER BY id DESC LIMIT 12").bind(j.id, t - 3 * 86400).all<{ text: string; created_at: number }>()).results;
  const state = { posts: 0, retryMin: null as number | null, summary: "", done: false, channels: new Map<string, Awaited<ReturnType<typeof fetchChannel>>>(), refs: new Map<string, { image: string; text: string }>() };
  const recentNorm = new Set(recent.map((r) => norm(r.text).replace(/\s+/g, " ").slice(0, 120)));

  const system =
    `You are an autonomous content agent working for the owner of an Eitaa channel ("${ch.title}"). Do exactly the task the owner wrote, using your tools. Write in Persian.\n\n` +
    `OWNER'S TASK (verbatim):\n"""\n${j.instruction}\n"""\n\n` +
    `RULES\n- Today (Tehran): ${jalaliLong(t)} — ${new Date(t * 1000).toISOString().slice(0, 10)}, now ${pad2(toLocal(t).h)}:${pad2(toLocal(t).mi)}. Use get_current_time if you need it.\n` +
    `- Only use channels the owner named. Never invent posts. When you reuse a source post, keep its meaning and wording; remove the source channel's name, @id, links and "join us" lines (a signature of the owner is added by the system — never add one yourself).\n` +
    `- Skip advertisements, giveaways, promotions, and anything unrelated to the task. Skip posts with used=true. Do not publish near-duplicates of what was already published (see list below).\n` +
    `- If the task says "N posts", N is the maximum for this run; publish fewer (or none) rather than bad content. Spread several posts with delay_minutes (e.g. 0, 20, 40...).\n` +
    `- If the task needs a date, it must be today's date (${jalaliLong(t)}). A source post that shows a different date is NOT acceptable.\n` +
    (final ? "- This is the LAST attempt: if no suitable source post exists, compose the post yourself according to the task (e.g. a good-morning text with today's date) and publish it.\n"
           : "- If the content the task depends on is not available yet and you published nothing, call retry_later instead of settling for something worse.\n") +
    `- Finish by calling finish with a one-sentence Persian summary.\n\n` +
    `RECENTLY PUBLISHED BY THIS TASK (do not repeat):\n${recent.length ? recent.map((r) => `- ${r.text.replace(/\s+/g, " ").slice(0, 110)}`).join("\n") : "(nothing yet)"}`;

  const exec = async (name: string, a: any): Promise<unknown> => {
    switch (name) {
      case "get_current_time": {
        const n = now(), l = toLocal(n);
        return { jalali: jalaliLong(n), gregorian: `${l.y}-${pad2(l.mo)}-${pad2(l.d)}`, time: `${pad2(l.h)}:${pad2(l.mi)}`, timezone: "Asia/Tehran" };
      }
      case "read_channel": {
        const cid = normalizeChatId(String(a.channel || "")).replace(/^@/, "");
        if (!/^[A-Za-z0-9_.]{3,64}$/.test(cid) || /^\d+$/.test(cid)) return { error: "invalid channel username" };
        if (!state.channels.has(cid) && state.channels.size >= MAX_CHANNELS_PER_RUN) return { error: `at most ${MAX_CHANNELS_PER_RUN} channels per run` };
        let r = state.channels.get(cid);
        if (!r) { r = await fetchChannel(env, cid); state.channels.set(cid, r); }
        if (!r.ok) return { error: r.note || "could not read channel (is it public?)" };
        const limit = Math.min(Math.max(parseInt(a.limit, 10) || 12, 1), 20);
        const msgs = r.messages.slice(-limit).reverse();
        const seen = new Set((await env.DB.prepare("SELECT k FROM agent_seen WHERE job_id=?").bind(j.id).all<{ k: string }>()).results.map((x) => x.k));
        return {
          channel: cid, title: r.title,
          posts: msgs.map((m) => {
            const ref = `${cid}/${m.id}`, text = cleanText(m.text, cid, r!.title);
            state.refs.set(ref, { image: m.image, text });
            const d = m.ts ? toLocal(m.ts) : null;
            return { ref, date: d ? `${d.y}-${pad2(d.mo)}-${pad2(d.d)} ${pad2(d.h)}:${pad2(d.mi)}` : null, text: text.slice(0, 1200), has_image: !!m.image, has_video: m.video, used: seen.has(ref) };
          }),
        };
      }
      case "post_to_channel": {
        if (state.posts >= MAX_POSTS_PER_RUN) return { error: "post limit for this run reached" };
        let text = String(a.text || "").trim();
        const refs: string[] = Array.isArray(a.source_refs) ? a.source_refs.map(String).slice(0, 10) : [];
        const imageRef = a.image_ref ? String(a.image_ref) : "";
        const img = imageRef ? state.refs.get(imageRef)?.image || "" : "";
        if (imageRef && !img) return { error: "image_ref has no image (use a ref from read_channel with has_image=true) — publish without image_ref or fix it" };
        if (!text && !img) return { error: "empty post" };
        const full = text + (j.footer ? `${text ? "\n\n" : ""}${j.footer}` : "");
        if (img && full.length > 1000) return { error: "text + signature too long for a post with image (max 1000 chars): shorten it or publish without image_ref" };
        if (full.length > 3900) return { error: "text too long (max ~3900 chars)" };
        const sig = norm(text).replace(/\s+/g, " ").slice(0, 120);
        if (sig && recentNorm.has(sig)) return { error: "duplicate of something this task already published" };
        const delay = Math.min(Math.max(parseInt(a.delay_minutes, 10) || 0, 0), 720);
        const draft = !!j.approve;
        const ins = await env.DB.prepare("INSERT INTO posts(user_id,channel_id,kind,text,file_id,file_name,title,silent,pin,view_delete,run_at,status,created_at,src_url,job_id) VALUES(?,?,?,?,'',?,'',0,0,0,?,?,?,?,?)")
          .bind(j.user_id, j.channel_id, img ? "file" : "text", full, img ? "image.jpg" : "", now() + delay * 60, draft ? "draft" : "pending", now(), img, j.id).run();
        const postId = ins.meta.last_row_id as number;
        recentNorm.add(sig);
        state.posts++;
        const keys = [...new Set([...refs, ...(imageRef ? [imageRef] : [])])].filter((k) => /^[A-Za-z0-9_.]+\/\d+$/.test(k));
        if (keys.length) await env.DB.batch(keys.map((k) => env.DB.prepare("INSERT OR IGNORE INTO agent_seen(job_id,k,seen_at) VALUES(?,?,?)").bind(j.id, k, now())));
        if (draft) await tg.send(env, j.user_id, `📝 <b>پیش‌نویس ایجنت «${esc(j.name)}»</b> (#${postId})${img ? " 🖼" : ""}\n\n${esc(full.slice(0, 1500))}`,
          ikb([[["✅ انتشار", `ag:go:${postId}`], ["🗑 حذف", `ag:no:${postId}`]]] as Btn[][]));
        return { ok: true, post_id: postId, status: draft ? "waiting for owner approval" : delay ? `scheduled in ${delay} min` : "queued for sending now" };
      }
      case "retry_later": {
        if (final) return { error: "not allowed in the last attempt — publish something now" };
        if (state.posts) return { error: "you already published in this run" };
        state.retryMin = Math.min(Math.max(parseInt(a.minutes, 10) || 10, 5), 30);
        state.summary = String(a.reason || "").slice(0, 300);
        state.done = true;
        return { ok: true };
      }
      case "finish": state.summary = String(a.summary || "").slice(0, 400); state.done = true; return { ok: true };
    }
    return { error: `unknown tool ${name}` };
  };

  const messages: ChatMsg[] = [{ role: "system", content: system }, { role: "user", content: "Start the task now." }];
  const tools = TOOLS(final);
  for (let step = 0; step < MAX_STEPS && !state.done; step++) {
    if (Date.now() - t0 > RUN_BUDGET_MS) { state.summary ||= "زمان اجرا تمام شد."; break; }
    const m = await chatTools(env, messages, tools);
    messages.push(m);
    if (!m.tool_calls?.length) { state.summary ||= (m.content || "").trim().slice(0, 400); break; }
    for (const c of m.tool_calls) {
      let out: unknown;
      try { out = await exec(c.function.name, JSON.parse(c.function.arguments || "{}")); }
      catch (e) { out = { error: (e as Error).message }; }
      messages.push({ role: "tool", tool_call_id: c.id, content: JSON.stringify(out).slice(0, 30_000) });
    }
  }
  if (!state.summary) state.summary = state.posts ? "انجام شد." : "کاری انجام نشد.";
  return { summary: state.summary, posts: state.posts, retryMin: state.retryMin };
}

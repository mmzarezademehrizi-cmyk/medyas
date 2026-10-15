// Admin panel for the agent's AI providers (inside the bot): save keys, pick the model, choose the active provider, test.
import { clearSession, setSession } from "./db";
import { Env } from "./env";
import { testProvider } from "./llm";
import { PROVIDERS, PROVIDER_IDS, ProviderId, cfgFor, clearKey, isProvider, listProviders, saveKey, setActive, setBase, setModel } from "./providers";
import * as tg from "./tg";
import { Btn, TgCallback, TgMessage, ikb } from "./tg";
import { esc } from "./util";

export async function panelText(env: Env): Promise<string> {
  const list = await listProviders(env);
  const lines = list.filter((p) => p.id !== "custom" || p.hasKey).map((p) => `${p.active ? "⭐" : "▫️"} ${p.info.name}: ${p.hasKey ? "✅" : "❌"}${p.hasKey ? ` · <code>${esc(p.model)}</code>` : ""}`);
  return `<b>🧠 هوش مصنوعی ایجنت</b>\n\n${lines.join("\n")}\n\n⭐ سرویس فعال اول امتحان می‌شود؛ اگر سهمیه‌اش تمام شد یا خطا داد، سرویس‌های دیگرِ دارای کلید خودکار جایگزین می‌شوند.\n` +
    `🆓 برای کار رایگان: Gemini (کلید از aistudio.google.com/apikey) و OpenRouter. DeepSeek و OpenAI برای API پول می‌خواهند.`;
}
export async function panel(env: Env, uid: number, mid?: number): Promise<void> {
  const rows: Btn[][] = PROVIDER_IDS.map((id) => [[`${PROVIDERS[id].name}`, `ad:pv:${id}`] as Btn]);
  const text = await panelText(env);
  if (mid) await tg.edit(env, uid, mid, text, ikb(rows)); else await tg.send(env, uid, text, ikb(rows));
}
async function providerView(env: Env, uid: number, id: ProviderId, mid?: number): Promise<void> {
  const p = (await listProviders(env)).find((x) => x.id === id)!;
  const text = `<b>${esc(p.info.name)}</b> ${p.active ? "⭐ فعال" : ""}\n${p.info.cost}\n\n🔑 کلید: ${p.hasKey ? (p.fromEnv ? "✅ (از تنظیمات دیپلوی)" : "✅ ثبت شده") : "❌ ثبت نشده"}\n` +
    `🎯 مدل: <code>${esc(p.model || "—")}</code>${id === "custom" ? `\n🌐 آدرس: <code>${esc(p.base || "—")}</code>` : ""}` +
    (p.info.keyUrl ? `\n\nدریافت کلید: ${esc(p.info.keyUrl)}` : "");
  const rows: Btn[][] = [[["🔑 ثبت/تغییر کلید", `ad:pk:${id}`], ["🎯 تغییر مدل", `ad:pm:${id}`]]];
  if (id === "custom") rows.push([["🌐 آدرس API", `ad:pb:${id}`]]);
  rows.push([...(p.hasKey ? [["⭐ فعال‌سازی", `ad:pa:${id}`] as Btn, ["🧪 تست", `ad:pt:${id}`] as Btn] : []), ...(p.hasKey && !p.fromEnv ? [["🗑 حذف کلید", `ad:pd:${id}`] as Btn] : [])].filter(Boolean) as Btn[]);
  rows.push([["⬅️ برگشت", "ad:pl:x"]]);
  if (mid) await tg.edit(env, uid, mid, text, ikb(rows)); else await tg.send(env, uid, text, ikb(rows));
}

export async function onCallback(env: Env, q: TgCallback, uid: number, act: string, arg: string): Promise<void> {
  const mid = q.message?.message_id;
  await tg.answer(env, q.id);
  if (act === "pl") return panel(env, uid, mid);
  if (!isProvider(arg)) return;
  const id = arg;
  switch (act) {
    case "pv": return providerView(env, uid, id, mid);
    case "pk": await setSession(env, uid, "ai_key", { provider: id }); return void (await tg.send(env, uid, `🔑 کلید API «${esc(PROVIDERS[id].name)}» را بفرستید\n🧹 پیام شما بعد از خواندن پاک می‌شود. لغو: /cancel`));
    case "pm": await setSession(env, uid, "ai_model", { provider: id }); return void (await tg.send(env, uid, `🎯 نام مدل را بفرستید (پیش‌فرض: <code>${esc(PROVIDERS[id].model || "—")}</code>).\nمدل باید «function calling» را پشتیبانی کند.`));
    case "pb": await setSession(env, uid, "ai_base", { provider: id }); return void (await tg.send(env, uid, "🌐 آدرس پایه‌ی API را بفرستید (مثلاً <code>https://example.com/v1</code>؛ همان که بعدش /chat/completions می‌آید)."));
    case "pa": await setActive(env, id); return providerView(env, uid, id, mid);
    case "pd": await clearKey(env, id); return providerView(env, uid, id, mid);
    case "pt": {
      const cfg = await cfgFor(env, id);
      if (!cfg) return void (await tg.send(env, uid, "❌ ابتدا کلید (و برای سفارشی: آدرس و مدل) را ثبت کنید."));
      await tg.send(env, uid, `🧪 در حال آزمایش ${esc(cfg.name)}…`);
      try { await tg.send(env, uid, `✅ کار می‌کند. پاسخ مدل: <code>${esc(await testProvider(cfg))}</code>`); }
      catch (e) { await tg.send(env, uid, `❌ ${esc((e as Error).message)}`); }
    }
  }
}

export async function onText(env: Env, uid: number, m: TgMessage, state: string, d: Record<string, any>, text: string): Promise<void> {
  const id = d.provider as ProviderId;
  if (!isProvider(id)) return void (await clearSession(env, uid));
  if (state === "ai_key") {
    await tg.del(env, uid, m.message_id);
    const key = text.trim();
    if (!/^[A-Za-z0-9_\-.:]{8,300}$/.test(key)) return void (await tg.send(env, uid, "❌ قالب کلید درست نیست. دوباره بفرستید (یا /cancel)."));
    await saveKey(env, id, key);
    await clearSession(env, uid);
    await tg.send(env, uid, "✅ کلید ثبت شد. برای اطمینان «🧪 تست» را بزنید.");
    return providerView(env, uid, id);
  }
  if (state === "ai_model") {
    const model = text.trim();
    if (!/^[A-Za-z0-9_\-./:]{2,100}$/.test(model)) return void (await tg.send(env, uid, "❌ نام مدل معتبر نیست. دوباره بفرستید (یا /cancel)."));
    await setModel(env, id, model);
    await clearSession(env, uid);
    return providerView(env, uid, id);
  }
  if (state === "ai_base") {
    const base = text.trim().replace(/\/+$/, "");
    if (!/^https:\/\/[^\s]+$/.test(base) && !/^http:\/\/(127\.0\.0\.1|localhost)[:/][^\s]*$/.test(base)) return void (await tg.send(env, uid, "❌ آدرس باید با https:// شروع شود. دوباره بفرستید (یا /cancel)."));
    await setBase(env, id, base);
    await clearSession(env, uid);
    return providerView(env, uid, id);
  }
}

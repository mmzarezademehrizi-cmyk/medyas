// Marketing site served by the Worker itself (no assets/build step, so it deploys with the bot).
import { Env, tgBase } from "./env";

// ---- edit these to brand / price the product ----
const BRAND = "مدیاس";
const TAGLINE = "پست فوری، زمان‌بندی‌شده و ایجنت هوشمند برای ایتا";
const PLANS: { name: string; period: string; price: string; note: string; hot?: boolean }[] = [
  { name: "ماهانه", period: "۳۰ روز", price: "تماس با پشتیبانی", note: "شروع بدون تعهد" },
  { name: "سه‌ماهه", period: "۹۰ روز", price: "تماس با پشتیبانی", note: "پیشنهاد ما", hot: true },
  { name: "سالانه", period: "۳۶۵ روز", price: "تماس با پشتیبانی", note: "به‌صرفه‌ترین" },
];
// --------------------------------------------------

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

let cachedUser = "";
async function botUsername(env: Env): Promise<string> {
  if (cachedUser) return cachedUser;
  try {
    const r = await fetch(`${tgBase(env)}/bot${env.BOT_TOKEN}/getMe`);
    const j: any = await r.json();
    if (j?.ok && j.result?.username) cachedUser = String(j.result.username);
  } catch { /* link falls back to telegram.org */ }
  return cachedUser;
}

const FEATURES = [
  ["⚡️", "ارسال فوری", "متن، عکس، ویدیو، سند و صدا را با یک دکمه در کانال منتشر کنید."],
  ["⏰", "زمان‌بندی دقیق", "به وقت تهران و با تاریخ شمسی؛ مثل «فردا ۰۹:۰۰» یا «+۴۵»."],
  ["🟠", "کانال‌های ایتا", "اتصال با توکن ایتایار؛ بی‌صدا، پین، عنوان و حذف پس از بازدید."],
  ["🤖", "ایجنت هوشمند", "با زبان ساده بگویید چه کاری و چه ساعتی؛ ایجنت از کانال‌های عمومی محتوا می‌آورد یا خودش می‌نویسد."],
  ["🔐", "امن", "توکن‌ها رمزنگاری‌شده (AES‑GCM) ذخیره می‌شوند و پیام حاوی توکن پاک می‌شود."],
  ["📲", "بدون نصب", "همه‌چیز داخل تلگرام است؛ نه اپ لازم است و نه سرور."],
];
const STEPS = [
  ["۱", "ربات را باز کنید", "در تلگرام /start بزنید و اشتراک را فعال کنید."],
  ["۲", "کانال را وصل کنید", "از «برنامه‌های متصل» توکن ایتایار را ثبت کنید."],
  ["۳", "پست بفرستید", "متن یا فایل را بدهید؛ ارسال الان یا زمان‌بندی."],
];
const FAQ = [
  ["اشتراک چطور فعال می‌شود؟", "پس از خرید، مدیر اشتراک شما را در ربات فعال می‌کند و پیام تأیید می‌گیرید."],
  ["حجم فایل چقدر می‌تواند باشد؟", "تا ۲۰ مگابایت برای هر فایل."],
  ["ربات به چه دسترسی‌ای نیاز دارد؟", "فقط ادمین بودن در کانال با اجازه‌ی ارسال پیام. به چیز دیگری دسترسی ندارد."],
  ["اگر پستی ارسال نشد چه می‌شود؟", "علت خطا همان لحظه در تلگرام برایتان فرستاده می‌شود و می‌توانید دوباره زمان‌بندی کنید."],
];

const CSS = `
:root{--bg:#fff;--fg:#14161a;--mut:#6b7280;--line:#e8eaee;--card:#f7f8fa;--ac:#4f46e5;--acfg:#fff}
@media(prefers-color-scheme:dark){:root{--bg:#0e1013;--fg:#eceef2;--mut:#9aa1ad;--line:#23272e;--card:#15181d;--ac:#818cf8;--acfg:#0e1013}}
*{box-sizing:border-box}html{scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.8 Vazirmatn,Tahoma,"Segoe UI",system-ui,sans-serif;-webkit-font-smoothing:antialiased}
a{color:inherit;text-decoration:none}
.w{max-width:960px;margin:0 auto;padding:0 20px}
nav{display:flex;align-items:center;justify-content:space-between;padding:18px 0}
.logo{font-weight:800;font-size:19px}.logo b{color:var(--ac)}
.btn{display:inline-block;background:var(--ac);color:var(--acfg);padding:10px 22px;border-radius:12px;font-weight:700;transition:.15s}
.btn:hover{opacity:.88;transform:translateY(-1px)}
.btn.o{background:transparent;color:var(--fg);border:1px solid var(--line)}
.hero{text-align:center;padding:72px 0 56px}
.hero h1{font-size:clamp(28px,5vw,44px);line-height:1.5;margin:0 0 14px;font-weight:800}
.hero p{color:var(--mut);font-size:18px;max-width:560px;margin:0 auto 28px}
.hero .row{display:flex;gap:10px;justify-content:center;flex-wrap:wrap}
.pills{display:flex;gap:8px;justify-content:center;margin-bottom:22px;flex-wrap:wrap}
.pill{border:1px solid var(--line);background:var(--card);border-radius:99px;padding:3px 14px;font-size:14px;color:var(--mut)}
section{padding:44px 0}
h2{font-size:24px;margin:0 0 6px;font-weight:800}
.sub{color:var(--mut);margin:0 0 24px}
.g{display:grid;gap:14px}.g3{grid-template-columns:repeat(auto-fit,minmax(250px,1fr))}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:20px}
.card h3{margin:6px 0 4px;font-size:17px}.card p{margin:0;color:var(--mut);font-size:15px}
.ic{font-size:26px}
.num{display:inline-grid;place-items:center;width:32px;height:32px;border-radius:50%;background:var(--ac);color:var(--acfg);font-weight:800}
.plan{text-align:center}.plan.hot{border-color:var(--ac);box-shadow:0 0 0 1px var(--ac)}
.plan .pr{font-size:18px;font-weight:800;margin:10px 0 2px}.plan small{color:var(--mut)}
details{border-bottom:1px solid var(--line);padding:14px 0}summary{cursor:pointer;font-weight:700}
details p{margin:8px 0 0;color:var(--mut)}
footer{border-top:1px solid var(--line);margin-top:30px;padding:26px 0;color:var(--mut);font-size:14px;text-align:center}
`;

function page(botUser: string): string {
  const link = botUser ? `https://t.me/${esc(botUser)}` : "https://telegram.org";
  const cards = (rows: string[][]) => rows.map(([i, t, d]) => `<div class="card"><div class="ic">${i}</div><h3>${t}</h3><p>${d}</p></div>`).join("");
  return `<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${BRAND} | ${TAGLINE}</title><meta name="description" content="${TAGLINE}. ربات تلگرام برای مدیریت کانال‌های ایتا.">
<meta name="theme-color" content="#4f46e5"><link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E%F0%9F%9A%80%3C/text%3E%3C/svg%3E">
<style>${CSS}</style></head><body><div class="w">
<nav><a class="logo" href="/">🚀 ${BRAND}<b>.</b></a><a class="btn" href="${link}">شروع در تلگرام</a></nav>
<header class="hero"><div class="pills"><span class="pill">🟠 ایتا</span><span class="pill">🤖 ایجنت</span><span class="pill">✈️ تلگرام</span></div>
<h1>${TAGLINE}</h1><p>از همین‌جا کانال‌هایتان را مدیریت کنید. بدون نصب، بدون سرور، فقط یک ربات تلگرام.</p>
<div class="row"><a class="btn" href="${link}">✨ شروع کنید</a><a class="btn o" href="#plans">💎 پلن‌ها</a></div></header>
<section><h2>قابلیت‌ها</h2><p class="sub">هرچه برای انتشار منظم لازم دارید.</p><div class="g g3">${cards(FEATURES)}</div></section>
<section><h2>چطور کار می‌کند</h2><p class="sub">در سه قدم.</p><div class="g g3">${STEPS.map(([n, t, d]) => `<div class="card"><span class="num">${n}</span><h3>${t}</h3><p>${d}</p></div>`).join("")}</div></section>
<section id="plans"><h2>پلن‌ها</h2><p class="sub">همه‌ی قابلیت‌ها در همه‌ی پلن‌ها.</p><div class="g g3">${PLANS.map((p) => `<div class="card plan${p.hot ? " hot" : ""}"><h3>${p.hot ? "⭐️ " : ""}${p.name}</h3><small>${p.period}</small><div class="pr">${p.price}</div><p>${p.note}</p><p style="margin-top:14px"><a class="btn${p.hot ? "" : " o"}" href="${link}">دریافت</a></p></div>`).join("")}</div></section>
<section><h2>سؤالات متداول</h2><p class="sub"></p>${FAQ.map(([q, a]) => `<details><summary>${q}</summary><p>${a}</p></details>`).join("")}</section>
<footer>© ${BRAND} · ساخته‌شده روی Cloudflare ☁️</footer></div></body></html>`;
}

export async function handleSite(env: Env, path: string): Promise<Response | null> {
  if (path === "/") {
    return new Response(page(await botUsername(env)), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300" } });
  }
  if (path === "/robots.txt") return new Response("User-agent: *\nAllow: /\n", { headers: { "content-type": "text/plain" } });
  return null;
}

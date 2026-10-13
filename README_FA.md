# medyas — نسخه‌ی رایگان روی Cloudflare Workers (فاز ۱)

ربات تلگرام برای ارسال فوری و زمان‌بندی‌شده‌ی پست در کانال‌های ایتا (ایتایار).
**Worker + D1 + Cron** — بدون سرور، بدون Container، روی پلن رایگان Cloudflare.

## قابلیت‌های فاز ۱
- ثبت توکن ایتایار (رمزنگاری AES‑GCM)، افزودن/تغییر نام/حذف کانال (نام کانال خودکار از صفحه‌ی عمومی ایتا)
- پست متن یا فایل (عکس، ویدیو، سند، صدا؛ تا ۲۰ مگابایت)، بی‌صدا، پین، عنوان، حذف پس از N بازدید
- ارسال فوری یا زمان‌بندی (`18:30`، `فردا 09:00`، `+45`، `1405/07/20 18:30` شمسی) با وقت تهران
- فهرست و لغو پست‌های زمان‌بندی‌شده؛ Cron هر دقیقه
- دسترسی با اشتراک: مدیر با `/grant ID DAYS` فعال می‌کند؛ `/ban` `/unban` `/stats`
- پرداخت آنلاین، روبیکا، دستیار هوشمند ← فازهای بعد

## گذاشتن روی گیت‌هاب
محتوای **همین پوشه** را (بدون `node_modules` و `.dev.vars`) در ریشه‌ی ریپو بگذارید. فایل‌های قدیمی پایتون ریپو (`app/`، `Dockerfile`، `requirements.txt` …) را حذف کنید.

## دیپلوی
**راه ساده (ربات cfdeploy):** توکن Cloudflare ← لینک گیت‌هاب ← مقدارهای خواسته‌شده (`BOT_TOKEN`، `ADMIN_IDS`) ← «شروع». D1 را می‌سازد، مهاجرت را اجرا می‌کند، Secretها (از جمله `SECRET_KEY` و `WEBHOOK_SECRET`) را می‌گذارد و webhook تلگرام را ثبت می‌کند.

**دستی:**
```
npm install
npx wrangler d1 create medyas-db            # database_id را در wrangler.jsonc بگذارید
npx wrangler d1 migrations apply medyas-db --remote
npx wrangler secret put BOT_TOKEN           # و ADMIN_IDS، SECRET_KEY، WEBHOOK_SECRET
npx wrangler deploy
```
سپس در مرورگر باز کنید: `https://<worker>.workers.dev/setup/<WEBHOOK_SECRET>` تا webhook ثبت شود.

## متغیرهای اختیاری
`EITAA_API_BASE` (رله‌ی ایتایار اگر مستقیم از Cloudflare کار نکرد) · `EITAA_WEB_BASE` · `TG_API_BASE`

## تست محلی
`bash test/run_e2e.sh` — Worker واقعی (workerd + D1 محلی) را با تلگرام/ایتایار شبیه‌سازی‌شده اجرا می‌کند (۳۳ بررسی).

## نکته‌های مهم
- اولین کاربری که ربات را باز می‌کند بدون `/grant` دسترسی ندارد؛ مدیر (ADMIN_IDS) همیشه دسترسی دارد.
- فایل‌ها هنگام ارسال از تلگرام دانلود و به ایتایار آپلود می‌شوند (ارسال فایل تا یک دقیقه در صف Cron می‌ماند).

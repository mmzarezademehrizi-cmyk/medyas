import datetime, json, subprocess, time, httpx, jdatetime

W, M, SEC = "http://localhost:8787", "http://127.0.0.1:9999", "whsecret123"
ADMIN, USER, OTHER = 1, 2, 3
uid = [0]
c = httpx.Client(timeout=30)


def post(update, secret=SEC, header=SEC, path=None):
    uid[0] += 1
    return c.post(f"{W}{path or '/tg/' + secret}", json={"update_id": uid[0], **update},
                  headers={"x-telegram-bot-api-secret-token": header})


def msg(user, text=None, **extra):
    return post({"message": {"message_id": uid[0] + 100, "from": {"id": user, "first_name": f"u{user}", "username": f"user{user}"},
                             "chat": {"id": user, "type": "private"}, **({"text": text} if text is not None else {}), **extra}})


def cb(user, data, mid=50):
    return post({"callback_query": {"id": f"cb{uid[0]}", "from": {"id": user, "first_name": f"u{user}"}, "data": data,
                                    "message": {"message_id": mid, "chat": {"id": user, "type": "private"}}}})


def log(): return c.get(f"{M}/_log").json()
def clear(): c.post(f"{M}/_clear")
def sent_to(user): return [e["body"]["text"] for e in log() if e["svc"] == "tg" and e["method"] == "sendMessage" and e["body"]["chat_id"] == user]
def eitaa_calls(m): return [e for e in log() if e["svc"] == "eitaa" and e["method"] == m]
def d1(sql): return subprocess.run(["npx", "wrangler", "d1", "execute", "medyas-db", "--local", "--command", sql], capture_output=True, text=True).stdout
def settle(): time.sleep(1.5)
def chat_wait(): time.sleep(6)   # a chat turn = several LLM round-trips


def check(name, cond, extra=""):
    print(("PASS " if cond else "FAIL ") + name + (f"  {extra}" if not cond else ""))
    assert cond, name

# ---------------- security of the webhook endpoint
check("wrong path secret -> 404", post({}, secret="nope").status_code == 404)
check("wrong header secret -> 403", post({"message": {}}, header="bad").status_code == 403)
check("GET not allowed on webhook", c.get(f"{W}/tg/{SEC}").status_code == 404)

# ---------------- access control
msg(USER, "/start"); settle()
check("new user told to get a subscription", any("اشتراک فعال ندارید" in t for t in sent_to(USER)))
clear(); msg(USER, "✍️ پست جدید"); settle()
check("menu blocked without access", any("اشتراک" in t for t in sent_to(USER)))
clear(); msg(USER, "/grant 2 30"); settle()
check("non-admin cannot /grant", not sent_to(USER) or all("فعال شد" not in t for t in sent_to(USER)))
clear(); msg(ADMIN, "/start"); msg(ADMIN, "/grant 2 30"); settle()
check("admin /grant works and notifies user", any("اشتراک شما تا" in t for t in sent_to(USER)))

# ---------------- token (bad token message must never echo the token)
clear(); msg(USER, "🔌 برنامه‌های متصل"); cb(USER, "tk:set"); msg(USER, "badtoken123456"); settle()
out = " ".join(sent_to(USER))
check("bad token rejected, secret not echoed", "نپذیرفت" in out and "badtoken123456" not in out, out)
check("token message deleted", any(e["method"] == "deleteMessage" for e in log()))
clear(); msg(USER, "goodtoken_ABC123"); settle()
check("good token stored", any("ثبت شد" in t for t in sent_to(USER)))
stored = d1("SELECT eitaa_token_enc, eitaa_account FROM users WHERE id=2")
check("token encrypted at rest", "goodtoken" not in stored and "eitaayar_acc" in stored, stored[:300])

# ---------------- channels
clear(); msg(USER, "📣 کانال‌ها"); cb(USER, "ch:add"); msg(USER, "https://eitaa.com/ghost"); settle()
check("unknown channel rejected", any("پیدا نشد" in t for t in sent_to(USER)))
clear(); msg(USER, "@mychan"); settle()
check("channel added with its real name", any("کانال من" in t and "اضافه شد" in t for t in sent_to(USER)), str(sent_to(USER)))
clear(); msg(USER, "📣 کانال‌ها"); cb(USER, "ch:add"); msg(USER, "mychan"); settle()
check("duplicate channel refused", any("قبلاً" in t for t in sent_to(USER)))

# ---------------- send a text post immediately
clear(); msg(USER, "✍️ پست جدید"); settle()
check("single channel skips the picker", any("متن یا فایل" in t for t in sent_to(USER)))
msg(USER, "سلام دنیا\nخط دوم"); cb(USER, "np:silent"); cb(USER, "np:now"); time.sleep(3)
em = eitaa_calls("sendMessage")
check("post delivered to eitaayar", len(em) == 1 and em[0]["token"] == "goodtoken_ABC123" and em[0]["form"]["chat_id"] == "mychan"
      and em[0]["form"]["text"] == "سلام دنیا\nخط دوم" and em[0]["form"].get("disable_notification") == "1", str(em))
check("user got the success notice", any("ارسال شد" in t for t in sent_to(USER)))
check("status sent in DB", "sent" in d1("SELECT status FROM posts ORDER BY id DESC LIMIT 1"))

# ---------------- photo post (download from Telegram -> upload to Eitaa)
clear(); msg(USER, "✍️ پست جدید")
msg(USER, None, photo=[{"file_id": "small", "file_unique_id": "a", "file_size": 100}, {"file_id": "BIG", "file_unique_id": "b", "file_size": 5000}], caption="کپشن تست")
cb(USER, "np:now"); settle()
check("file posts wait for the cron tick (no waitUntil limit)", not eitaa_calls("sendFile"))
c.get(f"{W}/__scheduled"); time.sleep(3)
ef = eitaa_calls("sendFile")
check("photo uploaded with caption", len(ef) == 1 and ef[0]["form"]["caption"] == "کپشن تست" and ef[0]["form"]["file"]["filename"] == "photo.jpg"
      and ef[0]["form"]["file"]["size"] > 2000, str(ef))
check("largest photo size was fetched", any(e["method"] == "getFile" and e["body"]["file_id"] == "BIG" for e in log()))
clear(); msg(USER, "✍️ پست جدید"); msg(USER, None, document={"file_id": "d", "file_unique_id": "d", "file_name": "x.zip", "file_size": 30 * 1024 * 1024}); settle()
check("file over 20MB refused", any("۲۰ مگابایت" in t for t in sent_to(USER)))

# ---------------- scheduling through the cron tick
clear(); msg(USER, "✍️ پست جدید"); msg(USER, "پست زمان‌بندی‌شده"); cb(USER, "np:sch"); msg(USER, "گذشته 10:00"); settle()
check("garbage time rejected", any("نامعتبر" in t for t in sent_to(USER)))
clear(); msg(USER, "+2"); settle()
check("schedule confirmed in Jalali", any("زمان‌بندی شد" in t for t in sent_to(USER)), str(sent_to(USER)))
clear(); msg(USER, "⏰ زمان‌بندی‌شده‌ها"); settle()
check("pending list shows it", any("⏰ #" in t for t in sent_to(USER)))
c.get(f"{W}/__scheduled"); time.sleep(1)
check("cron does not send before the time", not eitaa_calls("sendMessage"))
d1("UPDATE posts SET run_at = run_at - 3600 WHERE status='pending'")
c.get(f"{W}/__scheduled"); time.sleep(3)
check("cron sends when due", len(eitaa_calls("sendMessage")) == 1 and eitaa_calls("sendMessage")[0]["form"]["text"] == "پست زمان‌بندی‌شده")
c.get(f"{W}/__scheduled"); time.sleep(1)
check("no double sending on the next tick", len(eitaa_calls("sendMessage")) == 1)

# ---------------- cancel a scheduled post, and channel isolation between users
clear(); msg(USER, "✍️ پست جدید"); msg(USER, "لغو می‌شود"); cb(USER, "np:sch"); msg(USER, "+5"); settle()
pid = d1("SELECT id FROM posts WHERE status='pending'").split('"id": ')[1].split()[0].strip(",}")
clear(); r = cb(OTHER, f"sp:del:{pid}"); settle()
check("other user cannot cancel it", "pending" in d1(f"SELECT status FROM posts WHERE id={pid}"))
cb(USER, f"sp:del:{pid}"); settle()
check("owner can cancel it", "canceled" in d1(f"SELECT status FROM posts WHERE id={pid}"))

# ---------------- ban + stats
clear(); msg(ADMIN, "/ban 2"); msg(USER, "✍️ پست جدید"); settle()
check("banned user blocked", any("مسدود" in t for t in sent_to(USER)))
msg(ADMIN, "/unban 2"); clear(); msg(ADMIN, "/stats"); settle()
check("admin stats", any("کاربران" in t for t in sent_to(ADMIN)))
# ---------------- website
r = c.get(f"{W}/")
check("site home is served", r.status_code == 200 and "text/html" in r.headers["content-type"] and "مدیاس" in r.text and "روبیکا" not in r.text and "ایجنت" in r.text)
check("unknown page still 404", c.get(f"{W}/nope").status_code == 404)


FA = "۰۱۲۳۴۵۶۷۸۹"; MONTHS = ["فروردین", "اردیبهشت", "خرداد", "تیر", "مرداد", "شهریور", "مهر", "آبان", "آذر", "دی", "بهمن", "اسفند"]
tnow = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=3, minutes=30)
jd = jdatetime.date.fromgregorian(date=tnow.date())
fa = lambda n: str(n).translate(str.maketrans("0123456789", FA))
TODAY = f"{fa(jd.day)} {MONTHS[jd.month - 1]} {fa(jd.year)}"
YEST = f"{fa((jd - jdatetime.timedelta(days=1)).day)} {MONTHS[(jd - jdatetime.timedelta(days=1)).month - 1]} {fa((jd - jdatetime.timedelta(days=1)).year)}"
ISO = tnow.strftime("%Y-%m-%dT%H:%M:%S+03:30")
OLD_MORNING = {"id": 10, "ts": ISO, "text": f"🌞 صبح بخیر\n{YEST}\n\n📢 عضویت در کانال\n🆔 @goodmorning_ch", "image": None}
NEW_MORNING = {"id": 11, "ts": ISO, "text": f"🌞 صبح بخیر\n{TODAY}\nروزتان پر از انرژی\n\n📢 عضویت در کانال ما\n🆔 @goodmorning_ch", "image": f"{M}/img/m11.jpg"}
def job_id(): return d1j("SELECT id FROM agent_jobs ORDER BY id DESC LIMIT 1")[0]["id"]

# ======================================================================= AGENT
def d1j(sql):
    out = subprocess.run(["npx", "wrangler", "d1", "execute", "medyas-db", "--local", "--json", "--command", sql], capture_output=True, text=True).stdout
    return json.loads(out)[0]["results"]
def tick(n=1):
    for _ in range(n):
        c.get(f"{W}/__scheduled"); time.sleep(4)
def setpage(name, posts): c.post(f"{M}/_page/{name}", json=posts)
def buttons(user):
    return " ".join(json.dumps(e["body"].get("reply_markup", ""), ensure_ascii=False) for e in log() if e["svc"] == "tg" and e["method"] == "sendMessage" and e["body"]["chat_id"] == user)
# ---------------- the brain = Workers AI binding (replaced by the fake LLM in tests); no keys, no AI panel
clear(); msg(ADMIN, "🛠 مدیریت"); settle()
check("admin panel has no key/provider settings", "ad:pl" not in buttons(ADMIN) and any("هوش مصنوعی ایجنت: ✅" in t for t in sent_to(ADMIN)), str(sent_to(ADMIN)))
clear(); msg(USER, "🤖 ایجنت هوشمند"); settle()
check("agents available immediately", not any("هنوز فعال نشده" in t for t in sent_to(USER)), str(sent_to(USER)))

# ---------------- create a free-text "good morning" agent
setpage("goodmorning_ch", [OLD_MORNING, NEW_MORNING])
clear(); msg(USER, "🤖 ایجنت هوشمند"); cb(USER, "ag:new"); settle()
check("asks for the free-text task", any("به ایجنت بگویید" in t for t in sent_to(USER)), str(sent_to(USER)))
msg(USER, "هر روز ساعت ۷ صبح از کانال @goodmorning_ch پیام صبح بخیر امروز را که تاریخ امروز دارد در کانالم بگذار"); settle()
check("asks for the signature", any("امضای ثابت" in t for t in sent_to(USER)))
clear(); msg(USER, "🆔 @mychan | کانال تست"); settle()
check("plan confirmation with the schedule parsed by the LLM", "ag:mk" in buttons(USER) and any("07:00" in t for t in sent_to(USER)), str(sent_to(USER)))
clear(); cb(USER, "ag:mk"); settle()
J1 = job_id(); row = d1j(f"SELECT * FROM agent_jobs WHERE id={J1}")[0]
check("job stored with schedule + signature, no backlog", row["times"] == '["07:00"]' and row["footer"] == "🆔 @mychan | کانال تست" and row["last_key"] != "", str(row))

# ---------------- run now: copies today's post (with its image), strips the source signature, adds mine
clear(); cb(USER, f"ag:run:{J1}"); tick(2)
ef = eitaa_calls("sendFile")
check("agent published today's post with its image", len(ef) == 1 and ef[0]["form"]["file"]["filename"] == "image.jpg" and ef[0]["form"]["file"]["size"] > 2000, str(ef))
cap = ef[0]["form"]["caption"] if ef else ""
check("caption has today's date and my signature", TODAY in cap and cap.endswith("🆔 @mychan | کانال تست"), cap)
check("source signature removed", "@goodmorning_ch" not in cap and "عضویت" not in cap and YEST not in cap, cap)
check("owner got the run report", any("🤖" in t or "ارسال شد" in t for t in sent_to(USER)))

# ---------------- daily slot: today's post is NOT there yet -> retry later; then it appears
setpage("goodmorning_ch", [OLD_MORNING])
slot = (tnow - datetime.timedelta(minutes=1)).strftime("%H:%M")
d1(f"UPDATE agent_jobs SET times='[\"{slot}\"]', last_key='2000-01-01 00:00', attempts=0, retry_at=NULL, run_now=0 WHERE id={J1}")
d1("DELETE FROM agent_seen")
clear(); tick(1)
row = d1j(f"SELECT * FROM agent_jobs WHERE id={J1}")[0]
check("yesterday's poster is rejected and a retry is scheduled", not eitaa_calls("sendFile") and not eitaa_calls("sendMessage") and row["retry_at"] and row["attempts"] == 1 and row["last_key"] == "2000-01-01 00:00", str(row))
setpage("goodmorning_ch", [OLD_MORNING, {**NEW_MORNING, "id": 12, "image": None, "text": f"🌞 صبح بخیر\n{TODAY}\nسلامتی و شادی برای شما\n\n🆔 @goodmorning_ch"}])
d1(f"UPDATE agent_jobs SET retry_at=0 WHERE id={J1}")
clear(); tick(2)
em = eitaa_calls("sendMessage")
row = d1j(f"SELECT * FROM agent_jobs WHERE id={J1}")[0]
check("retry found today's post and published it as text", len(em) == 1 and TODAY in em[0]["form"]["text"] and "@goodmorning_ch" not in em[0]["form"]["text"], str(em))
check("slot closed after success", row["attempts"] == 0 and row["retry_at"] is None and row["last_key"] > "2000", str(row))
clear(); tick(1)
check("slot is not run twice", not eitaa_calls("sendMessage") and not eitaa_calls("sendFile"))

# ---------------- last attempt: nothing found for 2+ hours -> the agent writes the post itself
if tnow.hour >= 3:
    setpage("goodmorning_ch", [OLD_MORNING])
    old = (tnow - datetime.timedelta(minutes=150)).strftime("%H:%M")
    d1(f"UPDATE agent_jobs SET times='[\"{old}\"]', last_key='2000-01-01 00:00', attempts=1, retry_at=0 WHERE id={J1}")
    clear(); tick(2)
    em = eitaa_calls("sendMessage")
    check("fallback post with today's date after the retry window", len(em) == 1 and em[0]["form"]["text"].startswith("🌞 صبح بخیر") and TODAY in em[0]["form"]["text"], str(em))
d1(f"UPDATE agent_jobs SET enabled=0 WHERE id={J1}")

# ---------------- curate from several public channels
def sp(i, t): return {"id": i, "ts": ISO, "text": t, "image": None}
setpage("sport_ch", [sp(20, "فوتبال: نتایج هفته‌ی ایران\n\n📢 @sport_ch"), sp(21, "تبلیغ ویژه! خرید ارزان لوازم ورزش\n@sport_ch"),
                     sp(22, "ورزش صبحگاهی برای قلب سالم‌تر\n\nعضو شوید 👈 @sport_ch"), sp(23, "ورزش مفید برای کمردرد\n🆔 @sport_ch")])
clear(); cb(USER, "ag:new"); msg(USER, "روزی سه بار ساعت ۹ و ۱۴ از کانال @sport_ch دو مطلب درباره‌ی ورزش بیاور، تبلیغ نباشد"); msg(USER, "🆔 @mychan"); cb(USER, "ag:mk"); settle()
J2 = job_id()
check("planner extracted two daily times", d1j(f"SELECT times FROM agent_jobs WHERE id={J2}")[0]["times"] == '["09:00","14:00"]')
clear(); cb(USER, f"ag:run:{J2}"); tick(1)
rows = d1j(f"SELECT text, run_at, created_at, status FROM posts WHERE job_id={J2} ORDER BY id")
check("two posts created, ad skipped, second one spread by 20 min",
      len(rows) == 2 and all("تبلیغ" not in r["text"] and "@sport_ch" not in r["text"] and r["text"].endswith("🆔 @mychan") for r in rows)
      and 1100 < rows[1]["run_at"] - rows[0]["run_at"] < 1300, str(rows))
tick(1)
check("only the first (due) post was sent now", len([e for e in eitaa_calls("sendMessage") if "🆔 @mychan" in e["form"]["text"]]) == 1)
clear(); cb(USER, f"ag:run:{J2}"); tick(1)
rows = d1j(f"SELECT text FROM posts WHERE job_id={J2} ORDER BY id")
check("second run brings only unused content", len(rows) == 3 and "فوتبال" in rows[2]["text"], str(rows))
clear(); cb(USER, f"ag:run:{J2}"); tick(1)
check("third run: nothing new -> owner told why, no new post", len(d1j(f"SELECT id FROM posts WHERE job_id={J2}")) == 3 and any("مناسب" in t for t in sent_to(USER)), str(sent_to(USER)))

# ---------------- manual approval mode
cb(USER, f"ag:ap:{J2}"); d1("DELETE FROM agent_seen"); setpage("sport_ch", [sp(40, "ورزش جدید برای تقویت عضلات"), sp(41, "فوتبال: گزارش بازی دیشب")]); d1(f"UPDATE posts SET run_at=run_at-7200 WHERE job_id={J2}")
clear(); cb(USER, f"ag:run:{J2}"); tick(1)
drafts = d1j(f"SELECT id FROM posts WHERE job_id={J2} AND status='draft'")
check("approval mode: drafts waiting + approve buttons sent", len(drafts) >= 1 and "ag:go:" in buttons(USER), str(drafts))
clear(); cb(USER, f"ag:go:{drafts[0]['id']}"); settle(); tick(1)
check("approved draft is published", "sent" in d1(f"SELECT status FROM posts WHERE id={drafts[0]['id']}"))
if len(drafts) > 1:
    cb(USER, f"ag:no:{drafts[1]['id']}"); settle()
    check("rejected draft is canceled", "canceled" in d1(f"SELECT status FROM posts WHERE id={drafts[1]['id']}"))


# ---------------- stickers: a scheduled agent can find a sticker on a source channel and send it
setpage("sticker_ch", [{"id": 31, "ts": ISO, "text": "یک پست عادی", "image": None},
                       {"id": 30, "ts": ISO, "text": "", "image": None, "sticker": f"{M}/img/cal30.webp"}])
clear(); cb(USER, "ag:new"); msg(USER, "هر روز ساعت ۷ یک استیکر تقویم از کانال @sticker_ch پیدا کن و بفرست"); msg(USER, "-"); cb(USER, "ag:mk"); settle()
J3 = job_id(); clear(); cb(USER, f"ag:run:{J3}"); tick(2)
ef = eitaa_calls("sendFile")
check("sticker found on the source channel and sent as sticker.webp (no caption)", len(ef) == 1 and ef[0]["form"]["file"]["filename"] == "sticker.webp" and "caption" not in ef[0]["form"], str(ef))

# ---------------- live chat: act now, report the real result
clear(); msg(USER, "💬 گفتگو با ایجنت"); chat_wait()
check("chat intro shown", any("گفتگوی زنده" in t for t in sent_to(USER)), str(sent_to(USER)))
clear(); msg(USER, "برای تست یک سلام توی کانالم بفرست"); chat_wait()
em = eitaa_calls("sendMessage")
edits = [e["body"]["text"] for e in log() if e["svc"] == "tg" and e["method"] == "editMessageText"]
check("chat sent the message for real", len(em) == 1 and em[0]["form"]["text"] == "سلام", str(em))
check("chat reports success in one reply, without the extra delivery notice", any("ارسال شد" in t for t in edits) and not any("✅ پست #" in t for t in sent_to(USER)), str((edits, sent_to(USER))))
llm_calls = [e for e in log() if e["svc"] == "llm"]
check("sending one message costs a single LLM call", len(llm_calls) == 1, str(llm_calls))
clear(); mid = uid[0] + 500
post({"message": {"message_id": mid, "from": {"id": USER, "first_name": "u2"}, "chat": {"id": USER, "type": "private"}, "text": "یک سلام بفرست"}}); chat_wait()
post({"message": {"message_id": mid, "from": {"id": USER, "first_name": "u2"}, "chat": {"id": USER, "type": "private"}, "text": "یک سلام بفرست"}}); chat_wait()
check("Telegram re-delivery of the same message does not send twice", len(eitaa_calls("sendMessage")) == 1, str(eitaa_calls("sendMessage")))
msg(USER, "💬 گفتگو با ایجنت"); chat_wait()   # (the artificial big message id above would otherwise look like a re-delivery for the next ones)
clear(); msg(USER, "یک استیکر از کانال @sticker_ch بفرست"); chat_wait()
ef = eitaa_calls("sendFile")
check("chat forwards a sticker", len(ef) == 1 and ef[0]["form"]["file"]["filename"] == "sticker.webp", str(ef))
# a failing destination is reported honestly (never "sent")
d1("INSERT INTO channels(user_id,chat_id,title,platform,created_at) VALUES(2,'failchan','خراب','eitaa',0)")
clear(); msg(USER, "سلام را به کانال خراب بفرست"); chat_wait()
edits = [e["body"]["text"] for e in log() if e["svc"] == "tg" and e["method"] == "editMessageText"]
check("failure is reported truthfully", any("نشد" in t and "chat not found" in t for t in edits) and "failed" in d1("SELECT status FROM posts ORDER BY id DESC LIMIT 1"), str(edits))
d1("DELETE FROM channels WHERE chat_id='failchan'")
clear(); msg(USER, "✍️ پست جدید"); chat_wait()

# ---------------- every AI model out of quota -> the rule-based engine still does the job
chj = d1j(f"SELECT channel_id, user_id FROM agent_jobs WHERE id={J2}")[0]
setpage("sport_ch", [sp(50, "تبلیغ ویژه! خرید ارزان لوازم ورزش\n@sport_ch"), sp(51, "ورزش و تمرین‌های مفید برای تقویت عضلات پا و بدنسازی در خانه\n\nعضو شوید 👈 @sport_ch")])
d1("DELETE FROM agent_seen")
d1(f"INSERT INTO agent_jobs(user_id,channel_id,name,instruction,times,days,once_at,footer,approve,enabled,run_now,last_key,attempts,created_at) VALUES({chj['user_id']},{chj['channel_id']},'quota','از کانال @sport_ch یک مطلب درباره‌ی ورزش بیاور QUOTA','[]',NULL,NULL,'🆔 @mychan',0,1,1,'',0,0)")
QJ = job_id()
clear(); tick(3)
qrows = d1j(f"SELECT text FROM posts WHERE job_id={QJ}")
check("quota exhausted: rules-based fallback published a clean, non-ad post", len(qrows) == 1 and "تبلیغ" not in qrows[0]["text"] and "@sport_ch" not in qrows[0]["text"] and qrows[0]["text"].endswith("🆔 @mychan"), str(qrows))
d1(f"DELETE FROM agent_jobs WHERE id={QJ}")
# ---------------- isolation + cleanup
clear(); cb(OTHER, f"ag:tg:{J2}"); settle()
check("another user cannot touch my agent", d1j(f"SELECT enabled FROM agent_jobs WHERE id={J2}")[0]["enabled"] == 1)
cid = d1j("SELECT id FROM channels WHERE user_id=2")[0]["id"]
cb(USER, f"ch:dy:{cid}"); settle()
check("deleting the channel deletes its agents", not d1j("SELECT id FROM agent_jobs"))

clear(); msg(ADMIN, "/src goodmorning_ch"); msg(ADMIN, "/src nochannel_x"); settle()
check("/src diagnostics for admins", any("پیام‌های شناسایی‌شده: 2" in t for t in sent_to(ADMIN)) and any("پیامی در آن شناسایی نشد" in t for t in sent_to(ADMIN)), str(sent_to(ADMIN)))
print("ALL E2E CHECKS PASSED")

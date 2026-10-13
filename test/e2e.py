import json, subprocess, time, httpx

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
clear(); msg(USER, "پست جدید"); settle()
check("menu blocked without access", any("اشتراک" in t for t in sent_to(USER)))
clear(); msg(USER, "/grant 2 30"); settle()
check("non-admin cannot /grant", not sent_to(USER) or all("فعال شد" not in t for t in sent_to(USER)))
clear(); msg(ADMIN, "/start"); msg(ADMIN, "/grant 2 30"); settle()
check("admin /grant works and notifies user", any("اشتراک شما تا" in t for t in sent_to(USER)))

# ---------------- token (bad token message must never echo the token)
clear(); msg(USER, "برنامه‌های متصل"); cb(USER, "tk:set"); msg(USER, "badtoken123456"); settle()
out = " ".join(sent_to(USER))
check("bad token rejected, secret not echoed", "نپذیرفت" in out and "badtoken123456" not in out, out)
check("token message deleted", any(e["method"] == "deleteMessage" for e in log()))
clear(); msg(USER, "goodtoken_ABC123"); settle()
check("good token stored", any("ثبت شد" in t for t in sent_to(USER)))
stored = d1("SELECT eitaa_token_enc, eitaa_account FROM users WHERE id=2")
check("token encrypted at rest", "goodtoken" not in stored and "eitaayar_acc" in stored, stored[:300])

# ---------------- channels
clear(); msg(USER, "کانال‌ها"); cb(USER, "ch:add"); msg(USER, "https://eitaa.com/ghost"); settle()
check("unknown channel rejected", any("پیدا نشد" in t for t in sent_to(USER)))
clear(); msg(USER, "@mychan"); settle()
check("channel added with its real name", any("کانال من" in t and "اضافه شد" in t for t in sent_to(USER)), str(sent_to(USER)))
clear(); msg(USER, "کانال‌ها"); cb(USER, "ch:add"); msg(USER, "mychan"); settle()
check("duplicate channel refused", any("قبلاً" in t for t in sent_to(USER)))

# ---------------- send a text post immediately
clear(); msg(USER, "پست جدید"); settle()
check("single channel skips the picker", any("متن یا فایل" in t for t in sent_to(USER)))
msg(USER, "سلام دنیا\nخط دوم"); cb(USER, "np:silent"); cb(USER, "np:now"); time.sleep(3)
em = eitaa_calls("sendMessage")
check("post delivered to eitaayar", len(em) == 1 and em[0]["token"] == "goodtoken_ABC123" and em[0]["form"]["chat_id"] == "mychan"
      and em[0]["form"]["text"] == "سلام دنیا\nخط دوم" and em[0]["form"].get("disable_notification") == "1", str(em))
check("user got the success notice", any("ارسال شد" in t for t in sent_to(USER)))
check("status sent in DB", "sent" in d1("SELECT status FROM posts ORDER BY id DESC LIMIT 1"))

# ---------------- photo post (download from Telegram -> upload to Eitaa)
clear(); msg(USER, "پست جدید")
msg(USER, None, photo=[{"file_id": "small", "file_unique_id": "a", "file_size": 100}, {"file_id": "BIG", "file_unique_id": "b", "file_size": 5000}], caption="کپشن تست")
cb(USER, "np:now"); settle()
check("file posts wait for the cron tick (no waitUntil limit)", not eitaa_calls("sendFile"))
c.get(f"{W}/__scheduled"); time.sleep(3)
ef = eitaa_calls("sendFile")
check("photo uploaded with caption", len(ef) == 1 and ef[0]["form"]["caption"] == "کپشن تست" and ef[0]["form"]["file"]["filename"] == "photo.jpg"
      and ef[0]["form"]["file"]["size"] > 2000, str(ef))
check("largest photo size was fetched", any(e["method"] == "getFile" and e["body"]["file_id"] == "BIG" for e in log()))
clear(); msg(USER, "پست جدید"); msg(USER, None, document={"file_id": "d", "file_unique_id": "d", "file_name": "x.zip", "file_size": 30 * 1024 * 1024}); settle()
check("file over 20MB refused", any("۲۰ مگابایت" in t for t in sent_to(USER)))

# ---------------- scheduling through the cron tick
clear(); msg(USER, "پست جدید"); msg(USER, "پست زمان‌بندی‌شده"); cb(USER, "np:sch"); msg(USER, "گذشته 10:00"); settle()
check("garbage time rejected", any("نامعتبر" in t for t in sent_to(USER)))
clear(); msg(USER, "+2"); settle()
check("schedule confirmed in Jalali", any("زمان‌بندی شد" in t for t in sent_to(USER)), str(sent_to(USER)))
clear(); msg(USER, "زمان‌بندی‌شده‌ها"); settle()
check("pending list shows it", any("⏰ #" in t for t in sent_to(USER)))
c.get(f"{W}/__scheduled"); time.sleep(1)
check("cron does not send before the time", not eitaa_calls("sendMessage"))
d1("UPDATE posts SET run_at = run_at - 3600 WHERE status='pending'")
c.get(f"{W}/__scheduled"); time.sleep(3)
check("cron sends when due", len(eitaa_calls("sendMessage")) == 1 and eitaa_calls("sendMessage")[0]["form"]["text"] == "پست زمان‌بندی‌شده")
c.get(f"{W}/__scheduled"); time.sleep(1)
check("no double sending on the next tick", len(eitaa_calls("sendMessage")) == 1)

# ---------------- cancel a scheduled post, and channel isolation between users
clear(); msg(USER, "پست جدید"); msg(USER, "لغو می‌شود"); cb(USER, "np:sch"); msg(USER, "+5"); settle()
pid = d1("SELECT id FROM posts WHERE status='pending'").split('"id": ')[1].split()[0].strip(",}")
clear(); r = cb(OTHER, f"sp:del:{pid}"); settle()
check("other user cannot cancel it", "pending" in d1(f"SELECT status FROM posts WHERE id={pid}"))
cb(USER, f"sp:del:{pid}"); settle()
check("owner can cancel it", "canceled" in d1(f"SELECT status FROM posts WHERE id={pid}"))

# ---------------- ban + stats
clear(); msg(ADMIN, "/ban 2"); msg(USER, "پست جدید"); settle()
check("banned user blocked", any("مسدود" in t for t in sent_to(USER)))
msg(ADMIN, "/unban 2"); clear(); msg(ADMIN, "/stats"); settle()
check("admin stats", any("کاربران" in t for t in sent_to(ADMIN)))
print("ALL E2E CHECKS PASSED")

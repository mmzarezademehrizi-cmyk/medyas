"""Fake Telegram + Eitayar + eitaa.com (public channel pages) + an LLM (scripted tool-calling) on one port; records every call."""
import html, json, re
from aiohttp import web

LOG, MID = [], [1000]
PAGES = {}   # channel name -> list of {"id", "text", "ts", "image"}


async def tg(req):
    m = req.match_info["method"]
    body = await req.json() if req.can_read_body else {}
    LOG.append({"svc": "tg", "method": m, "body": body})
    if m == "sendMessage":
        MID[0] += 1
        return web.json_response({"ok": True, "result": {"message_id": MID[0]}})
    if m == "getFile":
        return web.json_response({"ok": True, "result": {"file_path": "photos/x.jpg"}})
    return web.json_response({"ok": True, "result": True})


async def tgfile(req):
    return web.Response(body=b"JPEGDATA-" + b"x" * 2000)


async def eitaa(req):
    m, tok = req.match_info["method"], req.match_info["token"]
    form = {}
    if req.content_type.startswith("multipart"):
        r = await req.multipart()
        async for part in r:
            form[part.name] = (await part.read()).decode("utf-8") if part.filename is None else {"filename": part.filename, "size": len(await part.read())}
    LOG.append({"svc": "eitaa", "method": m, "token": tok, "form": form})
    if tok.startswith("bad"):
        return web.json_response({"ok": False, "description": f"invalid token {tok}"})
    if m == "getMe":
        return web.json_response({"ok": True, "result": {"username": "eitaayar_acc"}})
    if form.get("chat_id") == "failchan":
        return web.json_response({"ok": False, "description": "chat not found or bot is not admin"})
    return web.json_response({"ok": True, "result": {"message_id": 777}})


def render(name):
    out = ['<html><head><meta property="og:title" content="کانال %s - Eitaa"></head><body><div class="tgme_widget_message_history">' % name]
    for p in PAGES.get(name, []):
        media = ""
        if p.get("image"):
            media = '<a class="tgme_widget_message_photo_wrap" href="x" style="width:453px;background-image:url(\'%s\')"></a>' % p["image"]
        if p.get("sticker"):
            media = '<a class="tgme_widget_message_sticker_wrap" href="x"><i class="tgme_widget_message_sticker" data-webp="%s" style="background-image:url(\'%s\')"></i></a>' % (p["sticker"], p["sticker"])
        text = ""
        if p["text"]:
            text = '<div class="tgme_widget_message_text js-message_text" dir="auto">%s</div>' % html.escape(p["text"]).replace("\n", "<br/>")
        out.append('<div class="tgme_widget_message_wrap js-widget_message_wrap"><div class="tgme_widget_message text_not_supported_wrap js-widget_message" data-post="%s/%s">' % (name, p["id"])
                   + media + text + '<div class="tgme_widget_message_footer"><a class="tgme_widget_message_date" href="x"><time datetime="%s" class="time">12:00</time></a></div></div></div>' % p["ts"])
    out.append("</div></body></html>")
    return "".join(out)


async def page(req):
    name = req.match_info["name"]
    if name == "ghost":
        return web.Response(status=404)
    if name in PAGES:
        return web.Response(text=render(name), content_type="text/html")
    return web.Response(text='<html><head><meta property="og:title" content="کانال من - Eitaa"></head><body>۱۲۰ مشترک</body></html>', content_type="text/html")


async def setpage(req):
    PAGES[req.match_info["name"]] = await req.json()
    return web.Response(text="ok")


async def img(req):
    return web.Response(body=b"\xff\xd8\xff" + b"I" * 3000, content_type="image/jpeg")


# ------------------------------------------------------------------ scripted LLM (OpenAI-compatible chat/completions)
def tool_call(i, name, args):
    return {"id": f"call{i}", "type": "function", "function": {"name": name, "arguments": json.dumps(args, ensure_ascii=False)}}


def reply(content=None, calls=None):
    msg = {"role": "assistant", "content": content}
    if calls:
        msg["tool_calls"] = calls
    return web.json_response({"choices": [{"message": msg}]})


async def llm(req):
    body = await req.json()
    if req.headers.get("authorization") == "Bearer testkey_NOBALANCE":
        return web.json_response({"error": {"message": "Insufficient Balance"}}, status=402)
    if req.headers.get("authorization") != "Bearer testkey_LLM123":
        return web.json_response({"error": "bad key"}, status=401)
    msgs, tools = body["messages"], body.get("tools")
    system = msgs[0]["content"]
    LOG.append({"svc": "llm", "tools": bool(tools), "n": len(msgs)})
    if "LIVE CHAT RULES" in system:
        return live_chat(msgs, system)
    if not tools:      # planner
        instr = msgs[-1]["content"]
        times = ["07:00"] if ("۷" in instr or "7" in instr) else (["09:00", "14:00"] if "۹ و ۱۴" in instr else [])
        return reply(json.dumps({"name": "ایجنت تست", "times": times, "days": None, "once": None, "summary": "خلاصه‌ی تست"}, ensure_ascii=False))
    # --- agent loop: decide the next step from what has been called already
    names = {c["id"]: c["function"]["name"] for m in msgs if m.get("tool_calls") for c in m["tool_calls"]}
    results = {names[m["tool_call_id"]]: json.loads(m["content"]) for m in msgs if m["role"] == "tool"}
    called = list(names.values())
    task = system.split('"""')[1]
    can_retry = any(t["function"]["name"] == "retry_later" for t in tools)
    if "صبح" in task:
        if not called:
            return reply(calls=[tool_call(1, "get_current_time", {}), tool_call(2, "read_channel", {"channel": "goodmorning_ch"})])
        if "post_to_channel" not in called and "retry_later" not in called:
            jal = results["get_current_time"]["jalali"].split(" ", 1)[1]          # "۲۳ مهر ۱۴۰۵" without the weekday
            hit = [p for p in results["read_channel"].get("posts", []) if "صبح بخیر" in p["text"] and jal in p["text"] and not p["used"]]
            if hit:
                p = hit[0]
                return reply(calls=[tool_call(3, "post_to_channel", {"text": p["text"], "image_ref": p["ref"] if p["has_image"] else None, "source_refs": [p["ref"]]})])
            if can_retry:
                return reply(calls=[tool_call(3, "retry_later", {"minutes": 10, "reason": "پست امروز هنوز نیامده"})])
            return reply(calls=[tool_call(3, "post_to_channel", {"text": "🌞 صبح بخیر\n" + results["get_current_time"]["jalali"]})])
        return reply(calls=[tool_call(4, "finish", {"summary": "پیام صبح بخیر امروز منتشر شد."})])
    if "استیکر" in task:
        if not called:
            return reply(calls=[tool_call(1, "read_channel", {"channel": "sticker_ch"})])
        if "post_to_channel" not in called:
            st = [p for p in results["read_channel"]["posts"] if p["has_sticker"] and not p["used"]]
            if not st:
                return reply(calls=[tool_call(5, "finish", {"summary": "استیکری پیدا نشد."})])
            return reply(calls=[tool_call(7, "post_to_channel", {"text": "", "image_ref": st[0]["ref"], "source_refs": [st[0]["ref"]]})])
        return reply(calls=[tool_call(8, "finish", {"summary": "استیکر فرستاده شد."})])
    if "ورزش" in task:
        if not called:
            return reply(calls=[tool_call(1, "read_channel", {"channel": "sport_ch"})])
        if "post_to_channel" not in called:
            good = [p for p in results["read_channel"]["posts"] if ("فوتبال" in p["text"] or "ورزش" in p["text"]) and "تبلیغ" not in p["text"] and not p["used"]][:2]
            if not good:
                return reply(calls=[tool_call(5, "finish", {"summary": "مطلب مناسب جدیدی نبود."})])
            return reply(calls=[tool_call(10 + i, "post_to_channel", {"text": p["text"], "source_refs": [p["ref"]], "delay_minutes": 20 * i}) for i, p in enumerate(good)])
        return reply(calls=[tool_call(6, "finish", {"summary": "مطالب ورزشی منتشر شد."})])
    return reply(content="کاری برای انجام نبود.")


def live_chat(msgs, system):
    utext = [m for m in msgs if m["role"] == "user"][-1]["content"]
    names = {c["id"]: c["function"]["name"] for m in msgs if m.get("tool_calls") for c in m["tool_calls"]}
    results = {names[m["tool_call_id"]]: json.loads(m["content"]) for m in msgs if m["role"] == "tool"}
    called = list(names.values())
    # the current turn's tool calls are everything after the last user message
    if "post_to_channel" in called:
        r = results["post_to_channel"]
        return reply(content=("فرستادم ✅ (" + r["channel"] + ")") if r["status"] == "sent" else ("نشد ❌: " + r["error"]))
    if "استیکر" in utext:
        if "read_channel" not in called:
            return reply(calls=[tool_call(1, "read_channel", {"channel": "sticker_ch"})])
        st = [p for p in results["read_channel"]["posts"] if p["has_sticker"]]
        return reply(calls=[tool_call(2, "post_to_channel", {"text": "", "image_ref": st[0]["ref"]})])
    if "سلام" in utext:
        args = {"text": "سلام"}
        mm = re.search(r"id=(\d+) «خراب»", system)
        if "خراب" in utext and mm:
            args["channel_id"] = int(mm.group(1))
        return reply(calls=[tool_call(3, "post_to_channel", args)])
    return reply(content="چه کاری انجام بدهم؟")


async def log(req):
    return web.json_response(LOG)


async def clear(req):
    LOG.clear()
    return web.Response(text="ok")

app = web.Application()
app.add_routes([web.post("/bot{token}/{method}", tg), web.get("/file/bot{token}/{path:.*}", tgfile),
                web.post("/api/bot{token}/{method}", eitaa), web.post("/llm/chat/completions", llm),
                web.get("/_log", log), web.post("/_clear", clear), web.post("/_page/{name}", setpage),
                web.get("/img/{f}", img), web.get("/s/{name}", page), web.get("/{name}", page)])
if __name__ == "__main__":
    web.run_app(app, port=9999, print=None)

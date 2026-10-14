"""Fake Telegram + Eitaayar + eitaa.com on one port; records every call so tests can assert on them."""
import json
from aiohttp import web

LOG, MID = [], [1000]


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
    return web.json_response({"ok": True, "result": {"message_id": 777}})


async def rubika(req):
    m, tok = req.match_info["method"], req.match_info["token"]
    body = await req.json() if req.can_read_body else {}
    LOG.append({"svc": "rubika", "method": m, "token": tok, "body": body})
    if tok.startswith("badrb"):
        return web.json_response({"status": "INVALID_ACCESS", "status_det": f"invalid token {tok}"})
    cid = body.get("chat_id", "")
    if m == "getMe":
        return web.json_response({"status": "OK", "data": {"bot": {"username": "medyas_rb_bot"}}})
    if m == "getChat":
        if "GHOST" in cid:
            return web.json_response({"status": "INVALID_INPUT", "status_det": "chat not found"})
        return web.json_response({"status": "OK", "data": {"chat": {"chat_id": cid, "chat_type": "User" if cid.startswith("b0") else "Channel", "title": "کانال روبیکا"}}})
    if m == "getUpdates":
        return web.json_response({"status": "OK", "data": {"updates": [{"type": "NewMessage", "chat_id": "cCHAN0000000000000001"}, {"type": "NewMessage", "chat_id": "b0USERCHAT000000000001"}], "next_offset_id": ""}})
    if m == "sendMessage":
        if "NOADMIN" in cid:
            return web.json_response({"status": "INVALID_ACCESS", "status_det": "bot is not admin"})
        return web.json_response({"status": "OK", "data": {"message_id": "rb1"}})
    return web.json_response({"status": "OK", "data": {}})


async def page(req):
    if req.match_info["name"] == "ghost":
        return web.Response(status=404)
    return web.Response(text='<html><head><meta property="og:title" content="کانال من - Eitaa"></head><body>۱۲۰ مشترک</body></html>', content_type="text/html")


async def log(req):
    return web.json_response(LOG)


async def clear(req):
    LOG.clear()
    return web.Response(text="ok")

app = web.Application()
app.add_routes([web.post("/bot{token}/{method}", tg), web.get("/file/bot{token}/{path:.*}", tgfile),
                web.post("/api/{token}/{method}", eitaa), web.post("/rubika/{token}/{method}", rubika), web.get("/_log", log), web.post("/_clear", clear), web.get("/{name}", page)])
if __name__ == "__main__":
    web.run_app(app, port=9999, print=None)

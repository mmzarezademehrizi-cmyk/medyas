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
                web.post("/api/{token}/{method}", eitaa), web.get("/_log", log), web.post("/_clear", clear), web.get("/{name}", page)])
if __name__ == "__main__":
    web.run_app(app, port=9999, print=None)

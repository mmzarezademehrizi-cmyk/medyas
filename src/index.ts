import { handleUpdate } from "./bot";
import { Env, tgBase } from "./env";
import { tick } from "./scheduler";
import { TgUpdate } from "./tg";

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/health") return new Response("ok");

    // one-time helper: open https://<worker>/setup/<WEBHOOK_SECRET> in a browser to register the Telegram webhook
    if (req.method === "GET" && url.pathname === `/setup/${env.WEBHOOK_SECRET}` && env.WEBHOOK_SECRET) {
      const r = await fetch(`${tgBase(env)}/bot${env.BOT_TOKEN}/setWebhook`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: `${url.origin}/tg/${env.WEBHOOK_SECRET}`, secret_token: env.WEBHOOK_SECRET, allowed_updates: ["message", "callback_query"] }),
      });
      return new Response(await r.text(), { headers: { "content-type": "application/json" } });
    }

    if (req.method === "POST" && env.WEBHOOK_SECRET && url.pathname === `/tg/${env.WEBHOOK_SECRET}`) {
      if (req.headers.get("x-telegram-bot-api-secret-token") !== env.WEBHOOK_SECRET) return new Response("forbidden", { status: 403 });
      let update: TgUpdate;
      try { update = await req.json(); } catch { return new Response("bad request", { status: 400 }); }
      try { await handleUpdate({ env, wait: (p) => ctx.waitUntil(p.catch((e) => console.error("bg", e?.message))) }, update); }
      catch (e) { console.error("update failed", (e as Error).message); }   // always 200: Telegram must not retry-loop on our bugs
      return new Response("ok");
    }
    return new Response("not found", { status: 404 });
  },

  async scheduled(_e: ScheduledController, env: Env): Promise<void> {
    await tick(env);
  },
} satisfies ExportedHandler<Env>;

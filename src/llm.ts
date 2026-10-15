// Minimal OpenAI-compatible chat client (DeepSeek by default). Used by the agent for judgement calls only.
import { Env, llmBase, llmModel } from "./env";

/** Readable Persian reason for an LLM HTTP failure (shown to the owner instead of a vague "no answer"). */
export function httpReason(status: number): string {
  if (status === 401 || status === 403) return "کلید API هوش مصنوعی نامعتبر است (از مدیر بخواهید دوباره ثبتش کند)";
  if (status === 402) return "موجودی حساب دیپ‌سیک کافی نیست؛ حساب را در platform.deepseek.com شارژ کنید";
  if (status === 429) return "تعداد درخواست‌ها به سرویس هوش مصنوعی زیاد است؛ چند دقیقه بعد دوباره امتحان کنید";
  if (status >= 500) return "سرویس هوش مصنوعی موقتاً در دسترس نیست؛ کمی بعد دوباره امتحان کنید";
  return `سرویس هوش مصنوعی خطا داد (HTTP ${status})`;
}

/** Asks for a JSON object. Throws an Error with a readable Persian message on failure. */
export async function chatJson(env: Env, key: string, system: string, user: string, maxTokens = 1500): Promise<any | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 40_000);
  try {
    const r = await fetch(`${llmBase(env)}/chat/completions`, {
      method: "POST", signal: ctl.signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: llmModel(env), temperature: 0.3, max_tokens: maxTokens, response_format: { type: "json_object" },
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
      }),
    });
    if (!r.ok) { console.error("llm http", r.status); throw new Error(httpReason(r.status)); }
    const j: any = await r.json();
    const content: string = j?.choices?.[0]?.message?.content || "";
    const m = content.match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : null;
  } catch (e) {
    console.error("llm failed", (e as Error).message);
    throw new Error((e as Error).name === "AbortError" ? "سرویس هوش مصنوعی پاسخ نداد (timeout)" : (e as Error).message);
  }
  finally { clearTimeout(timer); }
}

export interface ToolDef { type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } }
export interface ChatMsg { role: "system" | "user" | "assistant" | "tool"; content?: string | null; tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[]; tool_call_id?: string }

/** One step of a tool-calling conversation (OpenAI-compatible function calling). Throws with a readable message on failure. */
export async function chatTools(env: Env, key: string, messages: ChatMsg[], tools: ToolDef[]): Promise<ChatMsg> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 45_000);
  try {
    const r = await fetch(`${llmBase(env)}/chat/completions`, {
      method: "POST", signal: ctl.signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: llmModel(env), temperature: 0.3, max_tokens: 2500, messages, tools, tool_choice: "auto" }),
    });
    if (!r.ok) { console.error("llm http", r.status); throw new Error(httpReason(r.status)); }
    const j: any = await r.json();
    const m = j?.choices?.[0]?.message;
    if (!m) throw new Error("پاسخ نامعتبر از سرویس هوش مصنوعی");
    return { role: "assistant", content: m.content ?? null, ...(m.tool_calls?.length ? { tool_calls: m.tool_calls } : {}) };
  } catch (e) {
    throw new Error((e as Error).name === "AbortError" ? "سرویس هوش مصنوعی پاسخ نداد (timeout)" : (e as Error).message);
  } finally { clearTimeout(timer); }
}

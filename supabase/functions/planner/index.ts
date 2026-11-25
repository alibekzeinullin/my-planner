// Личный планер: Telegram-бот + ИИ-разбор задач + напоминания + API для сайта
import postgres from "npm:postgres@3.4.5";

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, {
  prepare: false,
  max: 3,
  transform: { undefined: null },
});
const TG = Deno.env.get("PLANNER_BOT_TOKEN") ?? ""; // отдельный секрет: TELEGRAM_BOT_TOKEN занят квиз-ботом
const AK = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const MODEL_FAST = Deno.env.get("CLAUDE_MODEL_FAST") ?? "claude-haiku-5-5";
const MODEL_SMART = Deno.env.get("CLAUDE_MODEL_SMART") ?? "claude-sonnet-5-5";
const OK = Deno.env.get("OPENAI_API_KEY") ?? "";
const OPENAI_MODEL = Deno.env.get("OPENAI_MODEL") ?? "gpt-5.4-mini";
const HAS_AI = !!(AK || OK);
const FN_URL = `${Deno.env.get("SUPABASE_URL")}/functions/v1/planner`;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, x-api-key",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

// ---------- настройки ----------
type S = Record<string, string | null>;
async function getSettings(): Promise<S> {
  const rows = await sql`select key, value from life.settings`;
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}
async function setSetting(k: string, v: string | null) {
  await sql`insert into life.settings(key, value) values (${k}, ${v})
            on conflict (key) do update set value = excluded.value`;
}

// ---------- время (локальное, UTC+5 по умолчанию) ----------
let OFF = 5;
const localNow = () => new Date(Date.now() + OFF * 3600e3); // читать через getUTC*
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const todayStr = () => ymd(localNow());
function addDays(s: string, n: number) {
  const d = new Date(s + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return ymd(d);
}
const dowOf = (s: string) => new Date(s + "T00:00:00Z").getUTCDay(); // 0=вс
function localToUtc(date: string, time: string) {
  return new Date(new Date(`${date}T${time.slice(0, 5)}:00Z`).getTime() - OFF * 3600e3);
}
const toLocalStr = (d: Date) =>
  new Date(d.getTime() + OFF * 3600e3).toISOString().slice(0, 16).replace("T", " ");
const WD = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];
const WD_FULL = ["воскресенье", "понедельник", "вторник", "среда", "четверг", "пятница", "суббота"];

// ---------- Telegram ----------
async function tg(method: string, body: unknown) {
  if (!TG) return { ok: false, description: "no PLANNER_BOT_TOKEN" };
  const r = await fetch(`https://api.telegram.org/bot${TG}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!j.ok) console.error("tg", method, JSON.stringify(j));
  return j;
}
const esc = (s: unknown) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
async function send(chat: string | number, text: string, extra: Record<string, unknown> = {}) {
  if (text.length > 4000) text = text.slice(0, 3990) + "…";
  const j = await tg("sendMessage", {
    chat_id: chat, text, parse_mode: "HTML", disable_web_page_preview: true, ...extra,
  });
  if (!j.ok && String(j.description).includes("parse")) {
    return tg("sendMessage", { chat_id: chat, text: text.replace(/<[^>]+>/g, ""), ...extra });
  }
  return j;
}

// ---------- задачи ----------
const TASK_COLS = sql`t.id, t.title, t.notes, t.area_id, t.goal_id, t.parent_id, t.priority, t.status,
  t.due_date::text as due_date, to_char(t.due_time, 'HH24:MI') as due_time, t.remind_at, t.reminded,
  t.estimate_min, t.recurrence, t.postponed_count, t.created_at, t.done_at, t.source,
  a.name as area, a.emoji as area_emoji`;

// deno-lint-ignore no-explicit-any
type Task = any;

const PRI: Record<number, string> = { 1: "🔴", 2: "🟠", 3: "🔵", 4: "⚪" };
function fmtDate(s: string) {
  const t = todayStr();
  if (s === t) return "сегодня";
  if (s === addDays(t, 1)) return "завтра";
  if (s === addDays(t, -1)) return "вчера";
  const [, m, d] = s.split("-");
  return `${WD[dowOf(s)]} ${d}.${m}`;
}
const fmtMin = (m: number) =>
  m >= 60 ? `${Math.floor(m / 60)}ч${m % 60 ? " " + (m % 60) + "м" : ""}` : `${m}м`;
function fmtTask(t: Task) {
  let s = `${PRI[t.priority] ?? "🔵"} ${esc(t.title)}`;
  const bits: string[] = [];
  if (t.due_date) {
    const over = t.due_date < todayStr();
    bits.push((over ? "⚠️ " : "") + fmtDate(t.due_date) + (t.due_time ? " " + t.due_time : ""));
  }
  if (t.area) bits.push(`${t.area_emoji ?? ""} ${esc(t.area)}`);
  if (t.estimate_min) bits.push("~" + fmtMin(t.estimate_min));
  if (t.recurrence) bits.push("🔁");
  if (bits.length) s += `\n     <i>${bits.join(" · ")}</i>`;
  return s;
}
const taskKb = (id: number) => ({
  inline_keyboard: [
    [
      { text: "✅ Готово", callback_data: `d:${id}` },
      { text: "⏰ +1 час", callback_data: `h:${id}` },
      { text: "📅 Завтра", callback_data: `t:${id}` },
    ],
    [{ text: "🗑 Удалить", callback_data: `x:${id}` }],
  ],
});
function listMsg(title: string, tasks: Task[], empty = "Пусто 🎉") {
  if (!tasks.length) return { text: `<b>${title}</b>\n\n${empty}`, extra: {} };
  const shown = tasks.slice(0, 30);
  const lines = shown.map((t, i) => `${i + 1}. ${fmtTask(t)}`);
  const btns = shown.map((t, i) => ({ text: `✅ ${i + 1}`, callback_data: `d:${t.id}` }));
  const rows = [];
  for (let i = 0; i < btns.length; i += 5) rows.push(btns.slice(i, i + 5));
  const more = tasks.length > 30 ? `\n…и ещё ${tasks.length - 30}` : "";
  return {
    text: `<b>${title}</b>\n\n${lines.join("\n")}${more}`,
    extra: { reply_markup: { inline_keyboard: rows } },
  };
}

async function openTasks(): Promise<Task[]> {
  return await sql`select ${TASK_COLS} from life.tasks t left join life.areas a on a.id = t.area_id
    where t.status = 'todo'
    order by t.due_date nulls last, t.due_time nulls last, t.priority, t.id`;
}
async function getTask(id: number): Promise<Task | null> {
  const r = await sql`select ${TASK_COLS} from life.tasks t left join life.areas a on a.id = t.area_id where t.id = ${id}`;
  return r[0] ?? null;
}
async function areaId(name?: string | null, id?: number | null) {
  if (id) return id;
  if (!name) return null;
  const r = await sql`select id from life.areas where lower(name) = lower(${name}) limit 1`;
  return r[0]?.id ?? null;
}
function defaultRemind(due_date?: string | null, due_time?: string | null) {
  if (!due_date || !due_time) return null;
  const due = localToUtc(due_date, due_time).getTime();
  const r = due - 30 * 60e3;
  if (r > Date.now()) return new Date(r);
  if (due > Date.now()) return new Date(due);
  return null;
}
async function logEvent(kind: string, task_id: number | null, payload: unknown = null) {
  await sql`insert into life.events(kind, task_id, payload) values (${kind}, ${task_id}, ${payload ? sql.json(payload as never) : null})`;
}

// deno-lint-ignore no-explicit-any
async function addTask(a: any, source = "bot"): Promise<Task> {
  let remind_at: Date | null = null;
  if (a.remind_at && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(a.remind_at)) {
    remind_at = localToUtc(a.remind_at.slice(0, 10), a.remind_at.slice(11, 16));
    if (remind_at.getTime() < Date.now()) remind_at = new Date(Date.now() + 60e3);
  } else remind_at = defaultRemind(a.due_date, a.due_time);
  const row = {
    title: String(a.title).slice(0, 300),
    notes: a.notes || null,
    area_id: await areaId(a.area, a.area_id),
    goal_id: a.goal_id || null,
    parent_id: a.parent_id || null,
    priority: [1, 2, 3, 4].includes(+a.priority) ? +a.priority : 3,
    due_date: a.due_date || null,
    due_time: a.due_time || null,
    remind_at,
    estimate_min: a.estimate_min ? +a.estimate_min : null,
    recurrence: a.recurrence || null,
    source,
  };
  const [r] = await sql`insert into life.tasks ${sql(row)} returning id`;
  await logEvent("add", r.id);
  if (Array.isArray(a.subtasks)) {
    for (const st of a.subtasks.slice(0, 10)) {
      if (!st) continue;
      await sql`insert into life.tasks ${sql({
        title: String(st).slice(0, 300), parent_id: r.id, area_id: row.area_id,
        priority: row.priority, due_date: row.due_date, source,
      })}`;
    }
  }
  return await getTask(r.id);
}

function nextDate(rec: string, from: string): string | null {
  const r = rec.trim().toLowerCase();
  if (r === "daily") return addDays(from, 1);
  if (r === "weekdays") {
    let d = addDays(from, 1);
    while ([0, 6].includes(dowOf(d))) d = addDays(d, 1);
    return d;
  }
  if (r === "biweekly") return addDays(from, 14);
  if (r === "monthly") {
    const d = new Date(from + "T00:00:00Z");
    d.setUTCMonth(d.getUTCMonth() + 1);
    return ymd(d);
  }
  if (r.startsWith("weekly")) {
    const days = (r.split(":")[1] ?? "").split(",").map((x) => +x % 7).filter((x) => !isNaN(x));
    if (!days.length) return addDays(from, 7);
    for (let i = 1; i <= 7; i++) {
      const d = addDays(from, i);
      if (days.includes(dowOf(d))) return d;
    }
  }
  return null;
}

async function completeTask(id: number): Promise<string> {
  const t = await getTask(id);
  if (!t) return "Задача не найдена";
  if (t.status === "done") return `Уже было готово: ${t.title}`;
  await sql`update life.tasks set status = 'done', done_at = now() where id = ${id}`;
  await logEvent("done", id);
  let extra = "";
  if (t.recurrence) {
    const base = t.due_date && t.due_date > todayStr() ? t.due_date : (t.due_date ?? todayStr());
    let nd = nextDate(t.recurrence, base);
    while (nd && nd < todayStr()) nd = nextDate(t.recurrence, nd);
    if (nd) {
      await sql`insert into life.tasks ${sql({
        title: t.title, notes: t.notes, area_id: t.area_id, goal_id: t.goal_id, priority: t.priority,
        due_date: nd, due_time: t.due_time, remind_at: defaultRemind(nd, t.due_time),
        estimate_min: t.estimate_min, recurrence: t.recurrence, source: "recurrence",
      })}`;
      extra = ` · следующая: ${fmtDate(nd)}`;
    }
  }
  return `✅ ${t.title}${extra}`;
}

const EDITABLE = ["title", "notes", "area_id", "goal_id", "priority", "due_date", "due_time",
  "estimate_min", "recurrence", "status", "parent_id"];
// deno-lint-ignore no-explicit-any
async function updateTask(id: number, f: any): Promise<Task | null> {
  const t = await getTask(id);
  if (!t) return null;
  // deno-lint-ignore no-explicit-any
  const patch: any = {};
  for (const k of EDITABLE) if (k in f) patch[k] = f[k] === "" ? null : f[k];
  if ("area" in f) patch.area_id = await areaId(f.area);
  const nd = "due_date" in patch ? patch.due_date : t.due_date;
  const nt = "due_time" in patch ? patch.due_time : t.due_time;
  if (f.remind_at && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(f.remind_at)) {
    patch.remind_at = localToUtc(f.remind_at.slice(0, 10), f.remind_at.slice(11, 16));
    patch.reminded = false;
  } else if ("due_date" in patch || "due_time" in patch) {
    patch.remind_at = defaultRemind(nd, nt);
    patch.reminded = false;
  }
  if (patch.due_date && t.due_date && patch.due_date > t.due_date) patch.postponed_count = (t.postponed_count ?? 0) + 1;
  if (patch.status === "done") patch.done_at = new Date();
  if (patch.status === "todo") patch.done_at = null;
  if (!Object.keys(patch).length) return t;
  await sql`update life.tasks set ${sql(patch)} where id = ${id}`;
  await logEvent("update", id, patch);
  return await getTask(id);
}

async function view(scope: string): Promise<{ text: string; extra: Record<string, unknown> }> {
  const all = await openTasks();
  const top = all.filter((t) => !t.parent_id);
  const today = todayStr();
  switch (scope) {
    case "tomorrow": {
      const d = addDays(today, 1);
      return listMsg(`📅 Завтра, ${WD_FULL[dowOf(d)]}`, top.filter((t) => t.due_date === d));
    }
    case "week": {
      const end = addDays(today, 6);
      return listMsg("🗓 Неделя", top.filter((t) => t.due_date && t.due_date <= end));
    }
    case "overdue":
      return listMsg("⚠️ Просрочено", top.filter((t) => t.due_date && t.due_date < today), "Ничего не просрочено 👌");
    case "inbox":
      return listMsg("📥 Без даты", top.filter((t) => !t.due_date));
    case "all":
      return listMsg("📋 Все задачи", top);
    default:
      return listMsg(`☀️ Сегодня, ${WD_FULL[dowOf(today)]}`, top.filter((t) => t.due_date && t.due_date <= today));
  }
}

// ---------- ИИ: Claude или OpenAI (что подключено) ----------
// deno-lint-ignore no-explicit-any
async function claude(model: string, system: string, messages: any[], tools?: any[], tool_choice?: any, max_tokens = 1500) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": AK, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model, max_tokens, system, messages, tools, tool_choice }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`Claude ${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
  return j;
}

let OPENAI_WORKING_MODEL: string | null = null;
// deno-lint-ignore no-explicit-any
async function openai(system: string, user: string, tool?: any, max_tokens = 1500) {
  const models = OPENAI_WORKING_MODEL ? [OPENAI_WORKING_MODEL] : [...new Set([OPENAI_MODEL, "gpt-5.4-mini", "gpt-4.1-mini", "gpt-4o-mini"])];
  let lastErr = "";
  for (const model of models) {
    // deno-lint-ignore no-explicit-any
    const body: any = {
      model,
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      max_completion_tokens: max_tokens,
    };
    if (tool) {
      body.tools = [{ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.input_schema } }];
      body.tool_choice = { type: "function", function: { name: tool.name } };
    }
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${OK}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const j = await r.json();
    if (!r.ok) {
      lastErr = `OpenAI ${r.status} (${model}): ${JSON.stringify(j).slice(0, 300)}`;
      if (r.status === 404 || String(j?.error?.code ?? "").includes("model")) continue; // модели нет — пробуем следующую
      throw new Error(lastErr);
    }
    OPENAI_WORKING_MODEL = model;
    const msg = j.choices?.[0]?.message ?? {};
    const args = msg.tool_calls?.[0]?.function?.arguments;
    return { input: args ? JSON.parse(args) : null, text: msg.content ?? "" };
  }
  throw new Error(lastErr || "OpenAI: нет доступной модели");
}

// единая точка: tier fast — разбор сообщений, smart — план дня
// deno-lint-ignore no-explicit-any
async function llm(tier: "fast" | "smart", system: string, user: string, tool?: any, max_tokens = 1500) {
  if (AK) {
    const j = await claude(tier === "fast" ? MODEL_FAST : MODEL_SMART, system, [{ role: "user", content: user }],
      tool ? [tool] : undefined, tool ? { type: "tool", name: tool.name } : undefined, max_tokens);
    // deno-lint-ignore no-explicit-any
    const input = j.content.find((c: any) => c.type === "tool_use")?.input ?? null;
    // deno-lint-ignore no-explicit-any
    const text = j.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
    return { input, text };
  }
  return await openai(system, user, tool, max_tokens);
}

const ACT_TOOL = {
  name: "act",
  description: "Выполнить действия с задачами и ответить пользователю",
  input_schema: {
    type: "object",
    properties: {
      reply: { type: "string", description: "Короткий ответ пользователю по-русски, обычный текст без HTML. Можно пустой." },
      actions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            type: { type: "string", enum: ["add", "complete", "update", "delete", "show", "plan", "goal_add"] },
            id: { type: "integer", description: "id существующей задачи (для complete/update/delete)" },
            title: { type: "string" },
            notes: { type: "string" },
            area: { type: "string", description: "одна из сфер из списка или пусто" },
            due_date: { type: "string", description: "YYYY-MM-DD" },
            due_time: { type: "string", description: "HH:MM" },
            remind_at: { type: "string", description: "YYYY-MM-DD HH:MM местное время, только если явно просили напомнить в другое время" },
            priority: { type: "integer", description: "1 срочно, 2 важно, 3 обычно, 4 когда-нибудь" },
            estimate_min: { type: "integer" },
            recurrence: { type: "string", description: "daily | weekdays | weekly:N[,N] (1=пн..6=сб,7=вс) | biweekly | monthly" },
            subtasks: { type: "array", items: { type: "string" } },
            scope: { type: "string", enum: ["today", "tomorrow", "week", "overdue", "inbox", "all"] },
            goal_kind: { type: "string", enum: ["dream", "goal"] },
            target_date: { type: "string" },
          },
          required: ["type"],
        },
      },
    },
    required: ["reply", "actions"],
  },
};

async function context() {
  const areas = await sql`select id, name from life.areas where not archived order by sort`;
  const tasks = await openTasks();
  const goals = await sql`select id, kind, title, target_date::text from life.goals where status = 'active' order by id`;
  return { areas, tasks, goals };
}

function nowLine() {
  const ln = localNow();
  const t = todayStr();
  return `Сейчас: ${t} (${WD_FULL[ln.getUTCDay()]}), ${ln.toISOString().slice(11, 16)} местного времени (UTC+${OFF}).`;
}

type Out = { reply: string; sends: { text: string; extra: Record<string, unknown> }[]; plan?: boolean };

async function processText(text: string, source = "bot"): Promise<Out> {
  const out: Out = { reply: "", sends: [] };
  if (!HAS_AI) {
    const t = await addTask({ title: text, priority: 3 }, source);
    out.sends.push({ text: `📝 Записал (без ИИ, ключ не подключён):\n\n${fmtTask(t)}`, extra: { reply_markup: taskKb(t.id) } });
    return out;
  }
  const { areas, tasks, goals } = await context();
  const today = todayStr();
  const days = Array.from({ length: 8 }, (_, i) => {
    const d = addDays(today, i);
    return `${WD_FULL[dowOf(d)]} = ${d}`;
  }).join("; ");
  const system = `Ты — умный личный планировщик в Telegram. Пользователь пишет тебе по-русски (иногда по-казахски или английски) обычным текстом.
${nowLine()}
Ближайшие дни: ${days}.
Сферы: ${areas.map((a) => a.name).join(", ")}.
Открытые задачи (id | задача | срок | сфера):
${tasks.slice(0, 120).map((t) => `${t.id} | ${t.title} | ${t.due_date ?? "-"}${t.due_time ? " " + t.due_time : ""} | ${t.area ?? "-"}`).join("\n") || "(нет)"}
Цели и мечты: ${goals.map((g) => `${g.id}:${g.title}`).join("; ") || "(нет)"}

Правила:
- Если человек описывает дело (даже без глагола "добавь") → add. Несколько дел в одном сообщении → несколько add.
- Дату выводи из фраз: "завтра", "в пятницу", "через неделю", "к концу месяца" (последний день месяца), "на выходных" (суббота). Если даты нет — не выдумывай, оставь пустой.
- Время → due_time. Напоминание по умолчанию система ставит сама за 30 минут; remind_at заполняй только если просят "напомни в ..." / "за час".
- "Напомни в 15:00 позвонить" → add с due_date сегодня (или указанной датой) и due_time 15:00.
- priority: 1 — срочно/горит/сегодня обязательно; 2 — важно; 3 — обычно; 4 — "когда-нибудь", "было бы неплохо".
- estimate_min — разумная оценка времени.
- area — выбери подходящую сферу из списка по смыслу, иначе пусто.
- Если задача большая и явно состоит из шагов (проект, подготовка, переезд), добавь 2–5 subtasks. Простые задачи не дроби.
- Повторяющееся ("каждую субботу", "по будням", "раз в две недели") → recurrence + due_date ближайшего раза.
- "Сделал/готово/закрыл X" → complete с id подходящей задачи. "Перенеси X на ..." → update с новыми полями. "Удали/отмени X" → delete.
- "Что на сегодня/завтра/неделю", "что просрочено", "покажи всё" → show со scope.
- "Спланируй день", "что делать сейчас", "с чего начать" → plan.
- "Хочу/мечтаю/цель ..." (про жизнь, не конкретное дело) → goal_add (goal_kind dream или goal, title).
- reply: 1 короткая фраза, по делу, без воды. Для show/plan reply можно оставить пустым. На общие вопросы отвечай в reply кратко.`;

  // deno-lint-ignore no-explicit-any
  let input: any;
  try {
    input = (await llm("fast", system, text, ACT_TOOL)).input;
  } catch (e) {
    console.error(e);
    const t = await addTask({ title: text, priority: 3 }, source);
    out.sends.push({ text: `📝 Записал как есть (ИИ сейчас недоступен):\n\n${fmtTask(t)}`, extra: { reply_markup: taskKb(t.id) } });
    return out;
  }
  if (!input) return { reply: "Не понял 🤔 Попробуй иначе", sends: [] };
  out.reply = input.reply ?? "";
  const ids = new Set(tasks.map((t) => t.id));
  const added: Task[] = [];
  for (const a of input.actions ?? []) {
    try {
      if (a.type === "add" && a.title) added.push(await addTask(a, source));
      else if (a.type === "complete" && ids.has(a.id)) out.sends.push({ text: esc(await completeTask(a.id)), extra: {} });
      else if (a.type === "update" && ids.has(a.id)) {
        const t = await updateTask(a.id, a);
        if (t) out.sends.push({ text: `✏️ Обновил:\n\n${fmtTask(t)}`, extra: { reply_markup: taskKb(t.id) } });
      } else if (a.type === "delete" && ids.has(a.id)) {
        await updateTask(a.id, { status: "cancelled" });
        out.sends.push({ text: "🗑 Удалил", extra: {} });
      } else if (a.type === "show") out.sends.push(await view(a.scope ?? "today"));
      else if (a.type === "plan") out.plan = true;
      else if (a.type === "goal_add" && a.title) {
        await sql`insert into life.goals ${sql({ kind: a.goal_kind === "dream" ? "dream" : "goal", title: a.title, target_date: a.target_date || null, area_id: await areaId(a.area) })}`;
        out.sends.push({ text: `${a.goal_kind === "dream" ? "✨ Мечта" : "🎯 Цель"} записана: ${esc(a.title)}`, extra: {} });
      }
    } catch (e) {
      console.error("action", a, e);
    }
  }
  if (added.length === 1) {
    const t = added[0];
    const sub = await sql`select title from life.tasks where parent_id = ${t.id} order by id`;
    const subTxt = sub.length ? "\n\n" + sub.map((s) => `   ◦ ${esc(s.title)}`).join("\n") : "";
    const rem = t.remind_at ? `\n⏰ напомню ${toLocalStr(new Date(t.remind_at)).slice(11)}${t.due_date !== todayStr() ? " " + fmtDate(toLocalStr(new Date(t.remind_at)).slice(0, 10)) : ""}` : "";
    out.sends.unshift({ text: `📝 Записал:\n\n${fmtTask(t)}${subTxt}${rem}`, extra: { reply_markup: taskKb(t.id) } });
  } else if (added.length > 1) {
    out.sends.unshift(listMsg(`📝 Записал ${added.length}`, added));
  }
  return out;
}

// ---------- план дня ----------
async function planText(kind: "morning" | "manual"): Promise<string> {
  const all = (await openTasks()).filter((t) => !t.parent_id);
  const today = todayStr();
  const todays = all.filter((t) => t.due_date === today);
  const overdue = all.filter((t) => t.due_date && t.due_date < today);
  const inbox = all.filter((t) => !t.due_date).sort((a, b) => a.priority - b.priority).slice(0, 8);
  const load = [...todays, ...overdue].reduce((s, t) => s + (t.estimate_min ?? 30), 0);
  const fallback = () => {
    const parts = [`<b>${kind === "morning" ? "Доброе утро! " : ""}План на ${WD_FULL[dowOf(today)]}</b>`];
    parts.push(`Задач на сегодня: ${todays.length}, просрочено: ${overdue.length}, нагрузка ~${fmtMin(load)}.`);
    if (load > 7 * 60) parts.push("⚠️ День перегружен — часть стоит перенести.");
    return parts.join("\n");
  };
  if (!HAS_AI) return fallback();
  const line = (t: Task) =>
    `- [${t.id}] ${t.title} | приоритет ${t.priority} | ${t.due_time ?? "без времени"} | ~${t.estimate_min ?? 30} мин | ${t.area ?? ""}${t.postponed_count ? ` | переносилась ${t.postponed_count} раз` : ""}${t.due_date && t.due_date < today ? ` | просрочена с ${t.due_date}` : ""}`;
  const prompt = `${nowLine()}
Задачи на сегодня:
${todays.map(line).join("\n") || "(нет)"}
Просроченные:
${overdue.map(line).join("\n") || "(нет)"}
Без даты (самые важные):
${inbox.map(line).join("\n") || "(нет)"}
Суммарная нагрузка сегодня+просрочка: ~${load} мин.`;
  const system = `Ты — личный планировщик. Составь ${kind === "morning" ? "утренний " : ""}план дня. Обращайся на "ты". Пиши обычным текстом без HTML и без markdown (никаких * и #), можно немного эмодзи.
Структура:
1) одна строка приветствия/настроя${kind === "morning" ? "" : " (можно пропустить)"};
2) порядок дня: сначала дела со временем, остальное блоками по приоритету (утро/день/вечер), указывай оценку времени;
3) если нагрузка больше ~6 часов или задач слишком много — честно скажи и предложи конкретно, что перенести;
4) если есть просроченные больше 2 дней или задачи, перенесённые 3+ раз — спроси прямо: делаем, разбиваем на шаги или удаляем;
5) если сегодня пусто — предложи 1–2 задачи из "без даты".
Максимум 15 строк. Без воды.`;
  try {
    const txt = (await llm("smart", system, prompt, undefined, 900)).text.trim();
    return esc(txt) || fallback();
  } catch (e) {
    console.error(e);
    return fallback();
  }
}

const unesc = (s: string) => s.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
async function savePlan(txt: string) {
  await setSetting("last_plan", unesc(txt));
  await setSetting("last_plan_at", todayStr());
}

async function sendPlan(chat: string | number, kind: "morning" | "manual") {
  const txt = await planText(kind);
  await savePlan(txt);
  await send(chat, txt);
  const v = await view("today");
  await send(chat, v.text, v.extra);
}

async function evening(chat: string | number) {
  const today = todayStr();
  const done = await sql`select title from life.tasks
    where status = 'done' and (done_at + make_interval(hours => ${OFF}))::date = ${today}::date order by done_at`;
  const left = (await openTasks()).filter((t) => !t.parent_id && t.due_date && t.due_date <= today);
  let text = `🌙 <b>Итог дня</b>\n\nСделано: ${done.length}`;
  if (done.length) text += "\n" + done.slice(0, 15).map((d) => `✅ ${esc(d.title)}`).join("\n");
  if (left.length) text += `\n\nОсталось: ${left.length}\n` + left.slice(0, 15).map((t) => `• ${esc(t.title)}`).join("\n");
  else text += "\n\nВсё на сегодня закрыто 💪";
  const extra = left.length
    ? { reply_markup: { inline_keyboard: [[{ text: "📅 Перенести оставшиеся на завтра", callback_data: "pa" }]] } }
    : {};
  await send(chat, text, extra);
  if (dowOf(today) === 0) await send(chat, await weekly());
}

async function weekly(): Promise<string> {
  const from = addDays(todayStr(), -6);
  const done = await sql`select coalesce(a.name, 'Без сферы') as area, count(*)::int as n from life.tasks t
    left join life.areas a on a.id = t.area_id
    where t.status = 'done' and (t.done_at + make_interval(hours => ${OFF}))::date >= ${from}::date
    group by 1 order by 2 desc`;
  const created = await sql`select count(*)::int as n from life.tasks where (created_at + make_interval(hours => ${OFF}))::date >= ${from}::date`;
  const stuck = await sql`select title, postponed_count from life.tasks where status = 'todo' and postponed_count >= 3 order by postponed_count desc limit 5`;
  const inbox = await sql`select count(*)::int as n from life.tasks where status = 'todo' and due_date is null and parent_id is null`;
  const total = done.reduce((s, r) => s + r.n, 0);
  let t = `📊 <b>Неделя</b>\n\nЗакрыто: ${total} (новых: ${created[0].n})`;
  if (done.length) t += "\n" + done.map((r) => `• ${esc(r.area)}: ${r.n}`).join("\n");
  if (stuck.length) t += "\n\n🧱 Буксуют:\n" + stuck.map((s) => `• ${esc(s.title)} (переносов: ${s.postponed_count})`).join("\n");
  if (inbox[0].n) t += `\n\n📥 Без даты: ${inbox[0].n} — разберём? /inbox`;
  return t;
}

// ---------- tick (pg_cron каждые 5 минут) ----------
async function tick() {
  const s = await getSettings();
  const chat = s.owner_chat_id;
  if (!chat) return "no owner";
  const due = await sql`select ${TASK_COLS} from life.tasks t left join life.areas a on a.id = t.area_id
    where t.status = 'todo' and t.reminded = false and t.remind_at <= now() order by t.remind_at limit 20`;
  for (const t of due) {
    await sql`update life.tasks set reminded = true where id = ${t.id}`;
    await send(chat, `⏰ <b>Напоминание</b>\n\n${fmtTask(t)}`, { reply_markup: taskKb(t.id) });
  }
  const h = localNow().getUTCHours();
  const today = todayStr();
  const mh = +(s.morning_hour ?? 8), eh = +(s.evening_hour ?? 21);
  if (h >= mh && h < mh + 3 && s.last_morning !== today) {
    await setSetting("last_morning", today);
    await sendPlan(chat, "morning");
  }
  if (h >= eh && s.last_evening !== today) {
    await setSetting("last_evening", today);
    await evening(chat);
  }
  return `ok, reminders: ${due.length}`;
}

// ---------- Telegram webhook ----------
const HELP = `Я твой личный планер 🗂

Просто пиши задачи обычным текстом:
• завтра в 15:00 созвон с родителями ученика
• к пятнице подготовить презентацию для 2 группы
• каждую субботу в 10 групповая встреча
• купить подгузники, позвонить в банк, оплатить интернет
• напомни через 2 часа выпить витамины

Ещё можно: «сделал презентацию», «перенеси банк на понедельник», «что на неделю?», «спланируй день», «мечтаю съездить в Японию с семьёй».

Команды:
/today — сегодня
/tomorrow — завтра
/week — неделя
/overdue — просрочено
/inbox — без даты
/plan — план дня
/goals — цели и мечты
/site — ссылка на сайт

Каждое утро в 8:00 пришлю план, вечером в 21:00 — итог.`;

// deno-lint-ignore no-explicit-any
async function onUpdate(u: any, s: S) {
  if (u.callback_query) return onCallback(u.callback_query, s);
  const m = u.message;
  if (!m || !m.chat) return;
  const chat = String(m.chat.id);
  const text: string = (m.text ?? m.caption ?? "").trim();

  if (!s.owner_chat_id) {
    if (text.startsWith("/start")) {
      await setSetting("owner_chat_id", chat);
      await send(chat, "Готово, теперь я твой 👋\n\n" + esc(HELP));
    }
    return;
  }
  if (chat !== s.owner_chat_id) {
    await send(chat, "Это личный бот, извини 🙂");
    return;
  }
  if (m.voice || m.audio) {
    await send(chat, "Голосовые пока не понимаю — напиши текстом 🙏");
    return;
  }
  if (!text) return;

  const cmd = text.split(/[\s@]/)[0].toLowerCase();
  const views: Record<string, string> = { "/today": "today", "/tomorrow": "tomorrow", "/week": "week", "/overdue": "overdue", "/inbox": "inbox", "/all": "all" };
  if (views[cmd]) {
    const v = await view(views[cmd]);
    return send(chat, v.text, v.extra);
  }
  if (cmd === "/start" || cmd === "/help") return send(chat, esc(HELP));
  if (cmd === "/plan") return sendPlan(chat, "manual");
  if (cmd === "/week_review") return send(chat, await weekly());
  if (cmd === "/goals") {
    const g = await sql`select kind, title, target_date::text as td, progress from life.goals where status = 'active' order by kind, id`;
    if (!g.length) return send(chat, "Целей пока нет. Напиши, например: «мечтаю выучить японский до N3» ✨");
    return send(chat, "<b>Цели и мечты</b>\n\n" + g.map((x) => `${x.kind === "dream" ? "✨" : "🎯"} ${esc(x.title)}${x.td ? ` <i>до ${x.td}</i>` : ""}`).join("\n"));
  }
  if (cmd === "/site") {
    const url = s.site_url ? `${s.site_url}#key=${s.api_key}` : null;
    return send(chat, url ? `🌐 Твой дашборд:\n${esc(url)}\n\nСсылка с ключом — никому не пересылай.` : `Ключ для сайта: <code>${esc(s.api_key)}</code>`);
  }

  await tg("sendChatAction", { chat_id: chat, action: "typing" });
  const out = await processText(text, "bot");
  if (out.reply) await send(chat, esc(out.reply));
  for (const x of out.sends) await send(chat, x.text, x.extra);
  if (out.plan) await sendPlan(chat, "manual");
}

// deno-lint-ignore no-explicit-any
async function onCallback(q: any, s: S) {
  const chat = String(q.message?.chat?.id ?? "");
  if (chat !== s.owner_chat_id) return tg("answerCallbackQuery", { callback_query_id: q.id });
  const data: string = q.data ?? "";
  const [op, idStr] = data.split(":");
  const id = +idStr;
  const msg = q.message;
  let toast = "";
  const kb = msg?.reply_markup?.inline_keyboard ?? [];
  const isSingle = kb.flat().some((b: { callback_data?: string }) => b.callback_data?.startsWith("h:"));

  const finishSingle = async (label: string) => {
    if (isSingle) {
      await tg("editMessageText", { chat_id: chat, message_id: msg.message_id, text: `${msg.text}\n\n${label}`.slice(0, 4000) });
    } else {
      // убрать нажатую кнопку из списка
      const rows = kb.map((r: { callback_data?: string }[]) => r.filter((b) => b.callback_data !== data)).filter((r: unknown[]) => r.length);
      await tg("editMessageReplyMarkup", { chat_id: chat, message_id: msg.message_id, reply_markup: { inline_keyboard: rows } });
    }
  };

  if (op === "d") {
    toast = await completeTask(id);
    await finishSingle(toast);
  } else if (op === "h") {
    await sql`update life.tasks set remind_at = now() + interval '1 hour', reminded = false where id = ${id}`;
    toast = "⏰ Напомню через час";
    await finishSingle(toast);
  } else if (op === "t") {
    const t = await getTask(id);
    if (t) {
      const tomorrow = addDays(todayStr(), 1);
      await updateTask(id, { due_date: tomorrow });
      toast = "📅 Перенёс на завтра";
      await finishSingle(toast);
    }
  } else if (op === "x") {
    await updateTask(id, { status: "cancelled" });
    toast = "🗑 Удалено";
    await finishSingle(toast);
  } else if (op === "pa") {
    const today = todayStr();
    const left = (await openTasks()).filter((t) => !t.parent_id && t.due_date && t.due_date <= today);
    for (const t of left) await updateTask(t.id, { due_date: addDays(today, 1) });
    toast = `📅 Перенёс ${left.length} на завтра`;
    await tg("editMessageReplyMarkup", { chat_id: chat, message_id: msg.message_id, reply_markup: { inline_keyboard: [] } });
    await send(chat, toast);
  }
  await tg("answerCallbackQuery", { callback_query_id: q.id, text: toast.slice(0, 190) });
}

// ---------- API для сайта ----------
// deno-lint-ignore no-explicit-any
async function api(body: any) {
  const op = body.op;
  if (op === "bootstrap") {
    const tasks = await sql`select ${TASK_COLS} from life.tasks t left join life.areas a on a.id = t.area_id
      where t.status = 'todo' or (t.status = 'done' and t.done_at > now() - interval '30 days')
      order by t.due_date nulls last, t.due_time nulls last, t.priority, t.id`;
    const areas = await sql`select * from life.areas where not archived order by sort, id`;
    const goals = await sql`select id, kind, title, description, area_id, parent_id, target_date::text as target_date, status, progress from life.goals where status <> 'dropped' order by id`;
    const s = await getSettings();
    const plan = s.last_plan_at === todayStr() ? s.last_plan : null;
    return { tasks, areas, goals, plan, today: todayStr(), tz_offset: OFF, morning_hour: s.morning_hour, evening_hour: s.evening_hour };
  }
  if (op === "plan") {
    const txt = await planText("manual");
    await savePlan(txt);
    return { text: unesc(txt) };
  }
  if (op === "quick_add") {
    const out = await processText(String(body.text ?? ""), "web");
    return { reply: out.reply, messages: out.sends.map((x) => x.text.replace(/<[^>]+>/g, "")) };
  }
  if (op === "task_add") return { task: await addTask(body.task ?? {}, "web") };
  if (op === "task_update") return { task: await updateTask(+body.id, body.patch ?? {}) };
  if (op === "task_done") return { message: await completeTask(+body.id) };
  if (op === "task_undo") return { task: await updateTask(+body.id, { status: "todo" }) };
  if (op === "task_delete") return { task: await updateTask(+body.id, { status: "cancelled" }) };
  if (op === "goal_save") {
    const g = body.goal ?? {};
    const row = {
      kind: ["dream", "goal", "milestone"].includes(g.kind) ? g.kind : "goal",
      title: String(g.title ?? "").slice(0, 300), description: g.description || null,
      area_id: g.area_id || null, parent_id: g.parent_id || null, target_date: g.target_date || null,
      status: g.status || "active", progress: Math.max(0, Math.min(100, +g.progress || 0)),
    };
    if (g.id) await sql`update life.goals set ${sql(row)} where id = ${+g.id}`;
    else await sql`insert into life.goals ${sql(row)}`;
    return { ok: true };
  }
  if (op === "area_save") {
    const a = body.area ?? {};
    const row = { name: String(a.name ?? "").slice(0, 60), emoji: a.emoji || "📁", color: a.color || "#6b7280", archived: !!a.archived };
    if (a.id) await sql`update life.areas set ${sql(row)} where id = ${+a.id}`;
    else await sql`insert into life.areas ${sql(row)}`;
    return { ok: true };
  }
  if (op === "settings_save") {
    for (const k of ["morning_hour", "evening_hour"]) if (k in body) await setSetting(k, String(+body[k]));
    return { ok: true };
  }
  return { error: "unknown op" };
}

// ---------- роутер ----------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = new URL(req.url);
  const action = url.searchParams.get("action");
  try {
    const s = await getSettings();
    OFF = +(s.tz_offset ?? 5);

    if (action === "api") {
      if (!s.api_key || req.headers.get("x-api-key") !== s.api_key) {
        return Response.json({ error: "unauthorized" }, { status: 401, headers: CORS });
      }
      const body = req.method === "POST" ? await req.json() : { op: "bootstrap" };
      return Response.json(await api(body), { headers: CORS });
    }

    if (action === "tick" || action === "setup") {
      if (url.searchParams.get("key") !== s.cron_key) return new Response("forbidden", { status: 403 });
      if (action === "tick") return new Response(await tick());
      const wh = await tg("setWebhook", {
        url: FN_URL, secret_token: s.webhook_secret, allowed_updates: ["message", "callback_query"], drop_pending_updates: true,
      });
      await tg("setMyCommands", {
        commands: [
          { command: "today", description: "Задачи на сегодня" },
          { command: "tomorrow", description: "На завтра" },
          { command: "week", description: "На неделю" },
          { command: "plan", description: "План дня" },
          { command: "overdue", description: "Просрочено" },
          { command: "inbox", description: "Без даты" },
          { command: "goals", description: "Цели и мечты" },
          { command: "site", description: "Сайт-дашборд" },
          { command: "help", description: "Как пользоваться" },
        ],
      });
      const me = await tg("getMe", {});
      return Response.json({ webhook: wh, bot: me?.result?.username });
    }

    // Telegram webhook
    if (req.method === "POST") {
      if (req.headers.get("x-telegram-bot-api-secret-token") !== s.webhook_secret) {
        return new Response("forbidden", { status: 403 });
      }
      const u = await req.json();
      await onUpdate(u, s);
      return new Response("ok");
    }
    return new Response("planner ok");
  } catch (e) {
    console.error(e);
    if (action === "api") return Response.json({ error: String(e) }, { status: 500, headers: CORS });
    return new Response("error", { status: 200 }); // Telegram не должен ретраить бесконечно
  }
});

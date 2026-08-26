/**
 * convert.js — 解析 DeepSeek 网页版导出的 conversations.json（ChatGPT 导出格式），
 * 构建成 DSH 会话事件日志。
 *
 * 导出格式要点（与 chat.deepseek.com 的浏览器导出一致）：
 *   - 顶层是会话数组；每个会话有 id / title / inserted_at / mapping
 *   - mapping 是节点树：每个节点 { id, parent, children[], message }，
 *     message = { model, inserted_at, fragments: [{type: "REQUEST"|"RESPONSE", content}] }
 *   - 节点沿「最后一个 child」构成当前分支的对话链
 *
 * 输出事件序列（与 DSH agent-loop 一致）：
 *   turn/start → step/start → user/message → assistant/message → step/end → turn/end
 *   （每轮一组），随后 session/title（保留网页版原标题，source=user 固定），
 *   最后 session/end-seed。
 */

const MAX_TITLE_BYTES = 80;

/** 标题规范化：去控制字符、压缩空白、按 UTF-8 字节截断（与 DSH 服务一致） */
export function normalizeTitle(title) {
  const cleaned = String(title)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  let out = "";
  let used = 0;
  for (const ch of cleaned) {
    const bytes = Buffer.byteLength(ch, "utf8");
    if (used + bytes > MAX_TITLE_BYTES) break;
    out += ch;
    used += bytes;
  }
  return out.trimEnd();
}

function parseTime(iso) {
  if (typeof iso !== "string") return undefined;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : undefined;
}

/** 把一条导出消息解析成 user / assistant 文本行 */
function parseMessage(m) {
  const frags = Array.isArray(m.fragments) ? m.fragments : [];
  const userParts = [];
  const assistantParts = [];
  for (const f of frags) {
    if (!f || typeof f !== "object") continue;
    const content = typeof f.content === "string" ? f.content : f.content == null ? "" : String(f.content);
    if (content.length === 0) continue;
    if (f.type === "REQUEST") userParts.push(content);
    else assistantParts.push(content);
  }
  const user = userParts.join("\n").trim();
  const assistant = assistantParts.join("\n").trim();
  if (!user && !assistant) return null;
  const model = typeof m.model === "string" && m.model.length > 0 ? m.model : "deepseek-chat";
  return {
    role: user ? "user" : "assistant",
    text: user || assistant,
    model,
    time: parseTime(m.inserted_at),
  };
}

/** 沿 mapping 树走「最后一条子链」，得到当前分支的消息序列 */
function linearize(conv) {
  const mapping = conv.mapping;
  if (!mapping || typeof mapping !== "object") return [];
  const root = mapping.root;
  if (!root || typeof root !== "object") return [];
  const rows = [];
  let node = root;
  const seen = new Set();
  while (node && typeof node === "object" && !seen.has(node.id)) {
    seen.add(node.id);
    if (node.message && typeof node.message === "object") {
      const r = parseMessage(node.message);
      if (r) rows.push(r);
    }
    const children = Array.isArray(node.children) ? node.children.filter((c) => mapping[c]) : [];
    node = children.length > 0 ? mapping[children[children.length - 1]] : null;
  }
  return rows;
}

let msgCounter = 0;

function makeUserMessage(sid, n, row) {
  return {
    id: `msg-${sid}-${n}`,
    role: "user",
    content: [{ type: "text", text: row.text }],
    source: { kind: "user" },
  };
}

function makeAssistantMessage(sid, n, row) {
  return {
    id: `msg-${sid}-${n}`,
    role: "assistant",
    content: [{ type: "text", text: row.text }],
    source: { kind: "model", provider: "deepseek-official", model: row.model },
  };
}

/**
 * 把一个导出会话构建成 DSH 事件数组。
 * @param {object} conv - conversations.json 里的一个会话对象。
 * @param {string} cwd - 会话归属的工作区目录（写入头部 cwd）。
 * @returns {{ id: string, title: string|null, createdAt: number, events: object[], error?: string }}
 */
export function buildSession(conv, cwd) {
  const id = String(conv.id ?? "").trim();
  if (!id) return { error: "会话没有 id" };
  const rows = linearize(conv);
  if (rows.length === 0) return { error: "会话里没有消息" };

  // 分组：user + 紧接的 assistant 算一轮；孤立消息各算一轮
  const turns = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r.role === "user") {
      if (i + 1 < rows.length && rows[i + 1].role === "assistant") {
        turns.push({ user: r, assistant: rows[i + 1] });
        i++;
      } else {
        turns.push({ user: r });
      }
    } else {
      turns.push({ assistant: r });
    }
  }

  const createdAt = parseTime(conv.inserted_at) ?? Date.now();
  const events = [];
  let seq = 0;
  const push = (type, data, time, extra) => {
    events.push({ type, seq: seq++, time, data, ...extra });
  };

  for (let t = 0; t < turns.length; t++) {
    const turn = t + 1;
    const tr = turns[t];
    const userTime = tr.user?.time ?? tr.assistant?.time ?? createdAt;
    const asstTime = tr.assistant?.time ?? userTime;
    push("turn/start", { turn }, userTime);
    push("step/start", { turn, step: 1 }, userTime);
    if (tr.user) push("user/message", makeUserMessage(id, ++msgCounter, tr.user), userTime, { surfaceOp: "append" });
    if (tr.assistant) push("assistant/message", { turn, step: 1, message: makeAssistantMessage(id, ++msgCounter, tr.assistant) }, asstTime, { surfaceOp: "append" });
    push("step/end", { turn, step: 1 }, asstTime);
    push("turn/end", { turn, reason: { kind: "completed" } }, asstTime);
  }

  // 网页版原标题 → session/title 事件（source=user 固定，防止被自动改标题）
  const rawTitle = typeof conv.title === "string" ? normalizeTitle(conv.title) : "";
  if (rawTitle) {
    push("session/title", { title: rawTitle, messageSeqs: [], source: { kind: "user" } }, events[events.length - 1].time);
  }
  push("session/end-seed", {}, events[events.length - 1].time);

  return { id, title: rawTitle || null, createdAt, events };
}

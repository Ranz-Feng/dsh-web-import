/**
 * domains.js — 读写 DeepSeek Harness 的领域数据文件：
 *   - workspace.json（工作区注册表：工作区记录 + 会话归属 + 顺序）
 *   - session_projcache.json（投影缓存：标题等列表行）
 *
 * 这些文件位于 $DSH_HOME/storages/ 下，由 storage-json 后端管理。
 * 注意：改动后需要重启 dsh web 才会被服务端加载。
 */

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const WORKSPACE_UNIT = { name: "workspace", version: 2 };
const PROJCACHE_UNIT = { name: "session_projcache", version: 3 };

export function workspaceFile(dshHome) {
  return path.join(dshHome, "storages", "workspace.json");
}

export function projCacheFile(dshHome) {
  return path.join(dshHome, "storages", "session_projcache.json");
}

function readJson(file) {
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJsonWithBackup(file, data) {
  try {
    fs.copyFileSync(file, `${file}.bak`);
  } catch {
    /* 首次创建时没有旧文件可备份 */
  }
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}

// ---------------------------------------------------------------------------
// workspace.json
// ---------------------------------------------------------------------------

/** 读取工作区注册表；不存在则返回空结构 */
export function loadWorkspaceData(dshHome) {
  const file = workspaceFile(dshHome);
  const data = readJson(file);
  if (data !== null) return { file, data };
  return {
    file,
    data: {
      unit: WORKSPACE_UNIT,
      global: { initialized: true, workspaceIds: [], archivedSessionIds: [] },
      tables: { workspaces: {} },
    },
  };
}

/** 规范化工作区数据形状，返回 { workspaces, global } */
function normalize(data) {
  if (!data.tables || typeof data.tables !== "object") data.tables = {};
  if (!data.tables.workspaces || typeof data.tables.workspaces !== "object") data.tables.workspaces = {};
  if (!data.global || typeof data.global !== "object") data.global = { initialized: true, workspaceIds: [], archivedSessionIds: [] };
  if (!Array.isArray(data.global.workspaceIds)) data.global.workspaceIds = [];
  if (!Array.isArray(data.global.archivedSessionIds)) data.global.archivedSessionIds = [];
  return data;
}

/** 列出全部工作区（按注册顺序） */
export function listWorkspaces(dshHome) {
  const { data } = loadWorkspaceData(dshHome);
  normalize(data);
  const byId = data.tables.workspaces;
  const out = [];
  for (const id of data.global.workspaceIds) {
    const rec = byId[id];
    if (!rec) continue;
    out.push({ id, title: rec.title, path: rec.path, sessionIds: rec.sessionIds ?? [] });
  }
  return out;
}

/**
 * 找到目标工作区：先按注册表路径，再按标题，再按 id。
 * @returns {{ id: string, record: object } | null}
 */
export function findWorkspace(dshHome, query) {
  const { data } = loadWorkspaceData(dshHome);
  normalize(data);
  const workspaces = data.tables.workspaces;
  for (const [id, rec] of Object.entries(workspaces)) {
    if (rec && (rec.path === query || rec.title === query || id === query)) return { id, record: rec };
  }
  return null;
}

/**
 * 把会话挂到指定工作区（幂等：已在列表里的 id 跳过，新 id 按给定顺序前置）。
 * 写回前自动备份。返回该工作区最新的会话数。
 */
export function attachSessionsToWorkspace(dshHome, workspaceId, sessionIds, now = new Date().toISOString()) {
  const { file, data } = loadWorkspaceData(dshHome);
  normalize(data);
  const workspaces = data.tables.workspaces;
  const rec = workspaces[workspaceId];
  if (!rec) throw new Error(`工作区不存在：${workspaceId}`);
  const existing = new Set(rec.sessionIds ?? []);
  const fresh = sessionIds.filter((id) => !existing.has(id));
  rec.sessionIds = [...fresh, ...(rec.sessionIds ?? [])];
  rec.updatedAt = now;
  writeJsonWithBackup(file, data);
  return rec.sessionIds.length;
}

/**
 * 新建工作区：目录必须存在（可先用 fs.mkdirSync 创建）。
 * 若同路径已存在工作区则复用；否则创建新记录并置顶。
 * @returns {{ id: string, created: boolean }}
 */
export function createWorkspace(dshHome, canonicalDir, title, now = new Date().toISOString()) {
  const { file, data } = loadWorkspaceData(dshHome);
  normalize(data);
  const workspaces = data.tables.workspaces;
  for (const [id, rec] of Object.entries(workspaces)) {
    if (rec && rec.path === canonicalDir) return { id, created: false };
  }
  const id = randomUUID();
  workspaces[id] = { path: canonicalDir, title, sessionIds: [], createdAt: now, updatedAt: now };
  data.global.workspaceIds = [id, ...data.global.workspaceIds];
  writeJsonWithBackup(file, data);
  return { id, created: true };
}

// ---------------------------------------------------------------------------
// session_projcache.json
// ---------------------------------------------------------------------------

/** 折叠一个会话的标题（最后一个 session/title 事件的 title；无则 null） */
export function foldTitle(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.type === "session/title" && typeof ev.data?.title === "string" && ev.data.title) {
      return ev.data.title;
    }
  }
  return null;
}

/** 折叠列表元数据：blank（是否有 turn/start）与 lastPromptAt（最近一次用户消息时间） */
export function foldListMetadata(events) {
  let blank = true;
  let lastPromptAt = null;
  for (const ev of events) {
    if (ev.type === "turn/start") blank = false;
    if (ev.type === "user/message" && ev.data?.source?.kind === "user") {
      const t = ev.time;
      if (typeof t === "number" && (lastPromptAt === null || t > lastPromptAt)) lastPromptAt = t;
    }
  }
  return { blank, lastPromptAt };
}

/**
 * 为给定会话预填充投影缓存行（title + sessionListMetadata），
 * 让侧边栏列表无需打开会话就能显示标题。写回前自动备份。
 * @param {Array<{id: string, createdAt: number, cwd: string, events: object[]}>} sessions
 * @returns {number} 写入的会话数
 */
export function prefillProjectionCache(dshHome, sessions) {
  const file = projCacheFile(dshHome);
  let data = readJson(file);
  if (data === null) {
    data = { unit: PROJCACHE_UNIT, global: null, tables: { sessions: {} } };
  }
  if (!data.tables || typeof data.tables !== "object") data.tables = {};
  if (!data.tables.sessions || typeof data.tables.sessions !== "object") data.tables.sessions = {};
  const table = data.tables.sessions;

  let written = 0;
  for (const s of sessions) {
    const eventCount = s.events.length;
    const title = foldTitle(s.events);
    const meta = foldListMetadata(s.events);
    const existing = table[s.id] && typeof table[s.id] === "object" ? table[s.id] : {};
    const identity = { createdAt: s.createdAt, cwd: s.cwd };
    table[s.id] = {
      ...existing,
      identity,
      rows: {
        ...(existing.rows && typeof existing.rows === "object" ? existing.rows : {}),
        title: { ver: 1, seq: eventCount, val: title },
        sessionListMetadata: { ver: 1, seq: eventCount, val: meta },
      },
    };
    written++;
  }
  writeJsonWithBackup(file, data);
  return written;
}

/**
 * dsh.js — DeepSeek Harness 存储原语。
 *
 * 与本机 DSH 后端（@deepseek-ai/dsh-session-persistence-jsonl /
 * @deepseek-ai/dsh-session）保持一致的：
 *   - 会话 id / cwd 的路径编码（encodeSegment / projectKey）
 *   - zstd 会话日志读写（两帧：头行一帧 + 事件一帧，带校验和）
 *   - session/title 事件插入与日志校验
 */

import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { zstdCompress, zstdDecompressSync, constants } from "node:zlib";

const zstdCompressAsync = promisify(zstdCompress);
const CHECKSUM_OPTIONS = { params: { [constants.ZSTD_c_checksumFlag]: 1 } };
const ZSTD_MAGIC = 4247762216; // 0xFD2FB528 (LE)

/** 会话 id 编码为安全的单段路径（复刻 DSH 后端 encodeSegment） */
export function encodeSegment(raw) {
  if (raw.length === 0) throw new Error("cannot encode an empty path segment");
  if (raw === ".") return "~002E";
  if (raw === "..") return "~002E~002E";
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) out += ch;
    else out += "~" + code.toString(16).toUpperCase().padStart(4, "0");
  }
  return out;
}

/** 项目目录键（复刻 DSH 后端 projectKey） */
export function projectKey(cwd) {
  if (cwd.length === 0) throw new Error("cannot encode an empty project path");
  let readable = "";
  let separatorRun = false;
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch === "/" || ch === "\\" || ch === ":") {
      if (!separatorRun) readable += "-";
      separatorRun = true;
    } else if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch;
      separatorRun = false;
    } else {
      readable += "~" + code.toString(16).toUpperCase().padStart(4, "0");
      separatorRun = false;
    }
  }
  return `--${(readable.replace(/^-+/, "") || "root").slice(0, 251)}--`;
}

/** 会话日志在磁盘上的完整路径；cwd 缺省时归入 _no-cwd 项目目录（与 DSH 后端一致） */
export function sessionLogPath(sessionsRoot, cwd, id) {
  const project = cwd === undefined ? "_no-cwd" : projectKey(cwd);
  return path.join(sessionsRoot, project, encodeSegment(id), "session.jsonl.zstd");
}

/** 扫描 zstd 帧边界（复刻 DSH 后端 scanZstdFrames） */
export function scanZstdFrames(buffer, maxFrames = Number.POSITIVE_INFINITY) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) break;
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) break;
    offset += 4;
    if (offset === buffer.length) break;
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) break;
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) break;
    offset += remainingHeaderBytes;
    for (;;) {
      if (buffer.length - offset < 3) return frames;
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) return frames;
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) return frames;
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) return frames;
      offset += 4;
    }
    frames.push({ start, end: offset });
    if (frames.length === maxFrames) return frames;
  }
  return frames;
}

/** 读会话日志的全部明文行：lines[0] 是头部 JSON 行，其余是事件行 */
export function readLogLines(filePath) {
  const buf = fs.readFileSync(filePath);
  const frames = scanZstdFrames(buf);
  if (frames.length === 0) throw new Error("无完整帧");
  const lastFrame = frames[frames.length - 1];
  if (lastFrame.end < buf.length) {
    throw new Error("日志存在未完成的尾部帧（上次可能不是正常停止）");
  }
  const parts = [];
  for (const f of frames) parts.push(zstdDecompressSync(buf.subarray(f.start, f.end)));
  const text = Buffer.concat(parts).toString("utf8");
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  if (lines.length < 2) throw new Error("日志过短");
  return { lines };
}

/** 把明文行写回 zstd 文件（头行一帧 + 事件一帧），先备份原文件为 .orig */
export async function writeLogLines(filePath, lines) {
  const headerJson = lines[0] + "\n";
  const bodyJson = lines.slice(1).join("\n") + "\n";
  const headerFrame = await zstdCompressAsync(Buffer.from(headerJson), CHECKSUM_OPTIONS);
  const eventFrame = await zstdCompressAsync(Buffer.from(bodyJson), CHECKSUM_OPTIONS);
  const content = Buffer.concat([headerFrame, eventFrame]);
  const bak = `${filePath}.orig`;
  if (!fs.existsSync(bak)) fs.copyFileSync(filePath, bak);
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, filePath);
}

/** 校验日志行：seq 从 0 连续（兼容 packed row 的 seq0） */
export function verifyLines(lines) {
  for (let i = 1; i < lines.length; i++) {
    const ev = JSON.parse(lines[i]);
    if (typeof ev.seq0 === "number") {
      if (ev.seq0 !== i - 1) throw new Error(`seq 不连续：第 ${i} 行期望 ${i - 1}，实际 ${ev.seq0}`);
    } else if (ev.seq !== i - 1) {
      throw new Error(`seq 不连续：第 ${i} 行期望 ${i - 1}，实际 ${ev.seq}`);
    }
  }
}

/** 读会话日志头部（第一条记录） */
export function readLogHeader(filePath) {
  const buf = fs.readFileSync(filePath);
  const frames = scanZstdFrames(buf, 1);
  if (frames.length === 0) return null;
  const plain = zstdDecompressSync(buf.subarray(frames[0].start, frames[0].end)).toString("utf8");
  const firstLine = plain.split("\n", 1)[0];
  if (!firstLine) return null;
  const header = JSON.parse(firstLine);
  if (header.type !== "session" || typeof header.id !== "string" || !header.id) return null;
  return header;
}

/** 递归收集会话日志文件 */
export function walkSessionFiles(root) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name === "session.jsonl.zstd" || entry.name === "session.jsonl") out.push(p);
    }
  };
  walk(root);
  return out;
}

/** 检查日志里是否已有 session/title 事件 */
export function hasTitleEvent(lines) {
  for (let i = 1; i < lines.length; i++) {
    if (JSON.parse(lines[i]).type === "session/title") return true;
  }
  return false;
}

/** 把事件数组序列化成日志行（行 0 是头部） */
export function eventsToLines(headerLine, events) {
  const lines = [typeof headerLine === "string" ? headerLine : JSON.stringify(headerLine)];
  for (const ev of events) lines.push(typeof ev === "string" ? ev : JSON.stringify(ev));
  return lines;
}

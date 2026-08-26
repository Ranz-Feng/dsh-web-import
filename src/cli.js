/**
 * cli.js — dsh-web-import 命令行入口。
 *
 * 把 DeepSeek 网页版导出的 conversations.json 导入 DeepSeek Harness：
 *   1. 解析导出文件，构建 DSH 会话（保留网页版原标题）；
 *   2. 选择/新建一个工作区（交互式选择或 --workspace / --new-workspace）；
 *   3. 写入会话日志（$DSH_HOME/sessions），挂载到工作区（workspace.json），
 *      预填充投影缓存让列表直接显示标题（session_projcache.json）。
 *
 * 注意：完整导入（含工作区与缓存）要求 dsh web 处于停止状态；
 * 若检测到服务在运行，默认拒绝执行（可用 --import-only 只导入会话文件）。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { stdin as input, stdout as output } from "node:process";

import { sessionLogPath, verifyLines, eventsToLines, writeLogLines } from "./dsh.js";
import { buildSession, normalizeTitle } from "./convert.js";
import {
  listWorkspaces,
  findWorkspace,
  attachSessionsToWorkspace,
  createWorkspace,
  prefillProjectionCache,
  workspaceFile,
  projCacheFile,
} from "./domains.js";

const DEFAULT_PORT = 3080;

const HELP = `dsh-web-import — 把 DeepSeek 网页版聊天记录导入 DeepSeek Harness

用法：
  dsh-web-import <conversations.json> [选项]
  dsh-web-import --list-workspaces
  dsh-web-import --help

参数：
  <conversations.json>        导出文件路径；省略时自动查找当前目录下的
                              conversations.json 或 deepseek_data-* 文件夹
  --workspace <标题|id|路径>   挂到已有工作区（按标题、id 或目录路径匹配）
  --new-workspace <标题>       新建工作区（配合 --workspace-dir 指定目录，
                              不指定则默认 ~/Documents/<标题>）
  --workspace-dir <目录>       新工作区指向的目录（不存在会自动创建）
  --list-workspaces           列出已有工作区后退出
  --home <目录>               指定 DSH 家目录（默认 $DSH_HOME 或 ~/.dsh）
  --port <端口>               检测 dsh web 的端口（默认 3080）
  --import-only               服务运行中也可执行：只导入会话文件，
                              跳过工作区挂载与缓存预填充（之后可重跑补全）
  --dry-run                   只解析与统计，不写入任何文件
  --yes                       非交互模式：跳过所有提示（需配合
                              --workspace 或 --new-workspace 使用）
  -h, --help                  显示帮助

示例：
  dsh-web-import conversations.json
  dsh-web-import conversations.json --workspace workspace
  dsh-web-import conversations.json --new-workspace "我的聊天" --workspace-dir ~/Documents/chats
`;

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { positionals: [], workspace: undefined, newWorkspace: undefined, workspaceDir: undefined, home: undefined, port: DEFAULT_PORT, importOnly: false, dryRun: false, yes: false, listWorkspaces: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--workspace": args.workspace = argv[++i]; break;
      case "--new-workspace": args.newWorkspace = argv[++i]; break;
      case "--workspace-dir": args.workspaceDir = argv[++i]; break;
      case "--home": args.home = argv[++i]; break;
      case "--port": args.port = Number(argv[++i]); break;
      case "--import-only": args.importOnly = true; break;
      case "--dry-run": args.dryRun = true; break;
      case "--yes": args.yes = true; break;
      case "--list-workspaces": args.listWorkspaces = true; break;
      case "-h":
      case "--help": args.help = true; break;
      default:
        if (a.startsWith("--")) throw new Error(`未知选项：${a}`);
        args.positionals.push(a);
    }
  }
  return args;
}

function dshHomeOf(args) {
  return args.home ? path.resolve(args.home) : process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
}

function serverRunning(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: "127.0.0.1", port, timeout: 1500 }, () => {
      sock.destroy();
      resolve(true);
    });
    sock.on("error", () => resolve(false));
    sock.on("timeout", () => {
      sock.destroy();
      resolve(false);
    });
  });
}

function findConversationsFile(positional) {
  if (positional) {
    if (!fs.existsSync(positional)) throw new Error(`找不到文件：${positional}`);
    return path.resolve(positional);
  }
  const cwd = process.cwd();
  const direct = path.join(cwd, "conversations.json");
  if (fs.existsSync(direct)) return direct;
  let entries = [];
  try {
    entries = fs.readdirSync(cwd);
  } catch { /* 忽略 */ }
  for (const name of entries.sort().reverse()) {
    if (name.startsWith("deepseek_data-")) {
      const candidate = path.join(cwd, name, "conversations.json");
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  throw new Error("找不到 conversations.json：请传入导出文件路径，或把它放到当前目录");
}

function readConversations(file) {
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  const list = Array.isArray(data) ? data : Array.isArray(data?.conversations) ? data.conversations : null;
  if (!list) throw new Error(`conversations.json 格式无法识别：${file}`);
  return list;
}

// ---------------------------------------------------------------------------
// 交互式工作区选择
// ---------------------------------------------------------------------------

async function prompt(rl, question, defaultValue) {
  const suffix = defaultValue !== undefined ? ` [${defaultValue}]` : "";
  const raw = await rl.question(`${question}${suffix}: `);
  const trimmed = raw.trim();
  if (trimmed === "") return defaultValue !== undefined ? defaultValue : "";
  return trimmed;
}

/**
 * 交互式选择工作区：列出已有工作区 + 「新建工作区」。
 * @returns {Promise<{id: string|null, record: object|null, title: string, dir: string|null}>}
 */
async function pickWorkspaceInteractive(dshHome) {
  const rl = readline.createInterface({ input, output });
  try {
    const workspaces = listWorkspaces(dshHome);
    console.log("\n可用的工作区：");
    if (workspaces.length === 0) {
      console.log("  （暂无工作区）");
    }
    workspaces.forEach((w, i) => {
      console.log(`  ${i + 1}) ${w.title}  → ${w.path}`);
    });
    console.log(`  ${workspaces.length + 1}) 新建工作区…`);
    const choiceRaw = await prompt(rl, `请选择 [${workspaces.length + 1}]`);
    const choice = choiceRaw === "" ? workspaces.length + 1 : Number(choiceRaw);
    if (!Number.isInteger(choice) || choice < 1 || choice > workspaces.length + 1) {
      throw new Error("无效选择");
    }
    if (choice <= workspaces.length) {
      const w = workspaces[choice - 1];
      return { id: w.id, record: null, title: w.title, dir: w.path };
    }
    // 新建
    const title = await prompt(rl, "工作区标题", "workspace");
    if (!title) throw new Error("工作区标题不能为空");
    const defaultDir = path.join(os.homedir(), "Documents", title);
    const dirRaw = await prompt(rl, "工作区目录（不存在会自动创建）", defaultDir);
    const dir = dirRaw ? path.resolve(dirRaw.replace(/^~(?=$|\/)/, os.homedir())) : defaultDir;
    return { id: null, record: null, title, dir };
  } finally {
    rl.close();
  }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

export async function runCli() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`错误：${e.message}\n`);
    console.error(HELP);
    process.exit(1);
  }
  if (args.help) {
    console.log(HELP);
    return;
  }

  const dshHome = dshHomeOf(args);

  if (args.listWorkspaces) {
    const workspaces = listWorkspaces(dshHome);
    console.log(`DSH 家目录：${dshHome}`);
    console.log(`工作区 ${workspaces.length} 个：`);
    for (const w of workspaces) console.log(`  ${w.title}  → ${w.path}（${w.sessionIds.length} 个会话）`);
    return;
  }

  // 1. 找到并解析导出文件
  const src = findConversationsFile(args.positionals[0]);
  console.log(`导出文件  : ${src}`);
  const conversations = readConversations(src);
  console.log(`会话数量  : ${conversations.length}`);

  // 2. 构建会话（dry-run 也走这里做统计）
  const built = [];
  let skippedEmpty = 0;
  for (const conv of conversations) {
    const b = buildSession(conv, ""); // cwd 稍后由工作区决定
    if (b.error) {
      skippedEmpty++;
      continue;
    }
    built.push(b);
  }
  console.log(`可导入    : ${built.length}（无消息跳过 ${skippedEmpty}）`);
  if (built.length === 0) {
    console.error("没有可导入的会话，退出。");
    process.exit(1);
  }

  // 3. 确定工作区
  let workspace = null; // { id, title, dir }
  if (args.workspace) {
    const found = findWorkspace(dshHome, args.workspace);
    if (!found) throw new Error(`找不到工作区：${args.workspace}（可用 --list-workspaces 查看）`);
    workspace = { id: found.id, title: found.record.title, dir: found.record.path };
  } else if (args.newWorkspace) {
    const title = normalizeTitle(args.newWorkspace) || "workspace";
    let dir = args.workspaceDir ? path.resolve(args.workspaceDir.replace(/^~(?=$|\/)/, os.homedir())) : path.join(os.homedir(), "Documents", title);
    workspace = { id: null, title, dir };
  } else if (input.isTTY && !args.yes) {
    workspace = await pickWorkspaceInteractive(dshHome);
  } else {
    throw new Error("需要选择工作区：用 --workspace <标题|id|路径> 或 --new-workspace <标题>（交互模式可省略）");
  }

  if (workspace.dir) {
    if (!fs.existsSync(workspace.dir)) {
      fs.mkdirSync(workspace.dir, { recursive: true });
      console.log(`已创建目录: ${workspace.dir}`);
    }
    workspace.dir = fs.realpathSync(workspace.dir);
  }
  console.log(`工作区    : ${workspace.title} → ${workspace.dir ?? "(未挂载)"}`);

  // 4. 服务运行检测
  const running = await serverRunning(args.port);
  if (running) {
    if (args.importOnly) {
      console.warn(`⚠️  检测到 dsh web 正在运行（端口 ${args.port}），将以 --import-only 模式只导入会话文件（跳过工作区与缓存）。`);
      workspace.id = null;
    } else if (args.dryRun) {
      console.warn(`⚠️  检测到 dsh web 正在运行（端口 ${args.port}）；--dry-run 不写入，可继续。`);
    } else {
      console.error(`检测到 dsh web 正在运行（端口 ${args.port}）。`);
      console.error("完整导入（工作区挂载 + 缓存预填充）需要停止服务：在运行 dsh web 的终端按 Ctrl+C 后再运行。");
      console.error("如果只想导入会话文件，可加 --import-only。");
      process.exit(1);
    }
  }

  if (args.dryRun) {
    console.log("\n--dry-run：不写入任何文件。预计：");
    console.log(`  新建会话文件: ${built.length}`);
    if (workspace.id !== null || workspace.id === null && workspace.dir) {
      console.log(`  工作区「${workspace.title}」挂载 ${built.length} 个会话`);
      console.log(`  投影缓存预填充 ${built.length} 个会话的标题`);
    }
    const countType = (type) => built.reduce((acc, b) => acc + b.events.filter((e) => e.type === type).length, 0);
    const totalTurns = countType("turn/end");
    const totalMessages = countType("user/message") + countType("assistant/message");
    console.log(`  总轮数 ${totalTurns}，总消息 ${totalMessages}`);
    return;
  }

  // 5. 写入会话文件
  const sessionsRoot = path.join(dshHome, "sessions");
  fs.mkdirSync(sessionsRoot, { recursive: true });
  const cwd = workspace.dir ?? undefined;
  const imported = [];
  const skipped = [];
  const failed = [];

  for (const b of built) {
    const logPath = sessionLogPath(sessionsRoot, cwd, b.id);
    if (fs.existsSync(logPath)) {
      skipped.push(b.id);
      continue;
    }
    try {
      const header = { type: "session", version: 0, id: b.id, createdAt: b.createdAt, ...(cwd !== undefined ? { cwd } : {}), delegationDepth: 0 };
      const lines = eventsToLines(header, b.events);
      verifyLines(lines);
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      await writeLogLines(logPath, lines);
      imported.push({ ...b, cwd: cwd ?? null });
    } catch (e) {
      failed.push({ id: b.id, error: e.message });
      try {
        fs.rmSync(logPath, { force: true });
      } catch { /* 忽略 */ }
    }
  }
  console.log(`\n导入会话  : 成功 ${imported.length}，跳过（已存在）${skipped.length}，失败 ${failed.length}`);

  // 6. 工作区挂载 + 缓存预填充（import-only 或未选工作区时跳过）。
  //    用 built（而非仅本次新写入的 imported），使 --import-only 之后的
  //    重跑能补全挂载与缓存（attach / prefill 均为幂等操作）。
  if (!args.importOnly && workspace.dir) {
    // 已有工作区：按 id；新建工作区：先建记录
    let workspaceId = workspace.id;
    if (workspaceId === null) {
      const created = createWorkspace(dshHome, workspace.dir, workspace.title);
      workspaceId = created.id;
      console.log(`新建工作区: ${workspace.title}（${workspace.dir}）`);
    }
    if (built.length > 0) {
      const toAttach = [...built].sort((a, b) => b.createdAt - a.createdAt || String(a.id).localeCompare(String(b.id)));
      const total = attachSessionsToWorkspace(dshHome, workspaceId, toAttach.map((s) => s.id));
      console.log(`工作区挂载: 「${workspace.title}」现有 ${total} 个会话`);
    }
    const cached = prefillProjectionCache(dshHome, built);
    console.log(`缓存预填充: ${cached} 个会话的标题已写入投影缓存`);
  }

  // 7. 汇总
  if (failed.length > 0) {
    console.error("\n失败的会话：");
    for (const f of failed) console.error(`  ${f.id}: ${f.error}`);
  }
  console.log(`\nDSH 家目录: ${dshHome}`);
  console.log(`会话目录  : ${path.join(dshHome, "sessions")}`);
  console.log(`工作区文件: ${workspaceFile(dshHome)}`);
  console.log(`缓存文件  : ${projCacheFile(dshHome)}`);
  console.log("\n下一步：启动（或重启）dsh web 并刷新页面（Cmd+R），");
  console.log(`导入的会话就会出现在「${workspace.title}」分组里，标题为网页版原标题。`);
  console.log("提示：想删除某个导入会话，删除对应的会话目录即可。");
}

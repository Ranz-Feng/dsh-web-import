# dsh-web-import

[![npm version](https://img.shields.io/npm/v/dsh-web-import.svg)](https://www.npmjs.com/package/dsh-web-import)
[![License](https://img.shields.io/npm/l/dsh-web-import.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22.10-blue.svg)](package.json)
[![GitHub stars](https://img.shields.io/github/stars/Ranz-Feng/dsh-web-import?style=social)](https://github.com/Ranz-Feng/dsh-web-import)

把 DeepSeek 网页版（chat.deepseek.com）的聊天记录导入 **DeepSeek Harness**，成为可继续对话的会话——自动保留网页版原标题、自动挂到所选工作区分组。

Import DeepSeek Web (chat.deepseek.com) chat history into **DeepSeek Harness** as resumable sessions — original titles preserved, automatically grouped into the workspace you choose.

---

## 功能特性 / Features

- ✅ 解析 DeepSeek 网页版导出的 `conversations.json`（ChatGPT 导出格式）
- ✅ 完整保留对话结构（轮次 / 消息 / 模型来源）
- ✅ 保留网页版原标题，侧边栏列表**直接显示**（无需逐个点击）
- ✅ 选择已有工作区，或新建工作区（自定义标题 + 目录）
- ✅ 幂等：重复导入自动跳过已存在的会话
- ✅ 安全：不覆盖任何已有文件，写入后自动校验，重要文件自动备份
- ✅ `--dry-run` 预演、`--list-workspaces` 查看工作区

## 环境要求 / Requirements

- Node.js ≥ 22.10（使用内置 zstd）
- 已安装 DeepSeek Harness（`dsh web` 可用）

## 安装 / Install

```bash
npm install -g dsh-web-import
# 或者不安装直接运行
npx dsh-web-import --help
```

## 第一步：导出网页版聊天记录 / Step 1: Export from DeepSeek Web

DeepSeek 网页版没有一键导出按钮，用浏览器开发者工具获取：

1. 打开 [chat.deepseek.com](https://chat.deepseek.com) 并登录；
2. 按 `F12` 打开开发者工具 → **Network（网络）**；
3. 在列表里筛选 `chat/history`（刷新页面或打开一个会话触发请求）；
4. 右键该请求的 **Response（响应）** → **Copy → Copy response**；
5. 粘贴保存为 `conversations.json`。

（也可以使用任意能导出 DeepSeek 网页会话为 ChatGPT 格式 `conversations.json` 的浏览器插件。）

<img width="2908" height="1662" alt="image" src="https://github.com/user-attachments/assets/9c0fde06-693b-4608-84f7-406dce5249f9" />


## 使用 / Usage

```bash
# 交互式：选择或新建工作区
dsh-web-import conversations.json

# 指定已有工作区（按标题 / id / 目录路径匹配）
dsh-web-import conversations.json --workspace workspace

# 新建工作区
dsh-web-import conversations.json --new-workspace "我的聊天" --workspace-dir ~/Documents/chats

# 先看会导入什么（不写入）
dsh-web-import conversations.json --dry-run

# 查看已有工作区
dsh-web-import --list-workspaces

# 指定 DSH 家目录 / 服务端口
dsh-web-import conversations.json --home ~/.dsh --port 3080
```
<img width="2076" height="1086" alt="image" src="https://github.com/user-attachments/assets/b2ee31a2-cfbe-421e-bfa1-a20e9434e693" />


### 重要：先停止 dsh web / Important: stop dsh web first

完整导入（工作区挂载 + 缓存预填充）需要 **dsh web 处于停止状态**，否则服务端的内存状态会覆盖我们的写入。工具会自动检测端口（默认 3080）并阻止执行。

```bash
# 1. 在运行 dsh web 的终端按 Ctrl+C 停止
# 2. 运行导入
dsh-web-import conversations.json
# 3. 重新启动
dsh web
# 4. 刷新页面（Cmd+R），会话出现在所选工作区分组里
```

服务正在运行但只想导入会话文件时，可用 `--import-only`（之后停止服务重跑一次即可补全工作区挂载与缓存）。

## 命令参数 / Options

| 参数 | 说明 |
|---|---|
| `<conversations.json>` | 导出文件路径；省略时自动查找当前目录 |
| `--workspace <标题\|id\|路径>` | 挂到已有工作区 |
| `--new-workspace <标题>` | 新建工作区 |
| `--workspace-dir <目录>` | 新工作区目录（不存在自动创建） |
| `--list-workspaces` | 列出已有工作区 |
| `--home <目录>` | DSH 家目录（默认 `$DSH_HOME` 或 `~/.dsh`） |
| `--port <端口>` | dsh web 检测端口（默认 3080） |
| `--import-only` | 只导入会话文件，跳过工作区与缓存 |
| `--dry-run` | 只解析统计，不写入 |
| `--yes` | 非交互模式（需配合工作区参数） |
| `-h, --help` | 帮助 |

## 工作原理 / How it works

直接写入 DSH 的原生存储，不经过任何 API：

- 会话日志 → `$DSH_HOME/sessions/<项目目录>/<会话id>/session.jsonl.zstd`
  （zstd 双帧：头部一帧 + 事件一帧，事件序列与 DSH agent-loop 一致：
  `turn/start → step/start → user/message → assistant/message → step/end → turn/end`，
  末尾 `session/title`（网页版原标题，固定）与 `session/end-seed`）
- 工作区挂载 → `$DSH_HOME/storages/workspace.json`（新会话 id 前置到所选工作区）
- 列表标题 → `$DSH_HOME/storages/session_projcache.json` 预填充
  （DSH 的 `session.list` 对冷会话只读投影缓存，预填充后列表直接显示标题）

写入前校验（seq 连续、末行为 `session/end-seed`）；重写文件前自动备份为 `.orig` / `.bak`。

## 常见问题 / Troubleshooting

- **报「检测到 dsh web 正在运行」**：按上文先 Ctrl+C 停止服务再导入。
- **Node 版本太旧**：`node -v` 需 ≥ 22.10（内置 zstd）。
- **导入后列表还是文件夹名**：确认是完整模式（非 `--import-only`）导入，然后**重启** `dsh web` 并刷新。
- **想删除某个导入会话**：删除对应会话目录即可（路径见导入输出）。

## 开发 / Development

```bash
git clone https://github.com/Ranz-Feng/dsh-web-import.git
cd dsh-web-import
npm link          # 本地链接 dsh-web-import 命令
npm test          # 运行单元测试（node --test）

# 用示例文件在临时家目录试跑（不碰真实数据）
node bin/dsh-web-import.js examples/sample-conversations.json --home /tmp/dsh-test --dry-run
```

## License

MIT

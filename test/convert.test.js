import test from "node:test";
import assert from "node:assert/strict";
import { buildSession } from "../src/convert.js";

function conv(overrides = {}) {
  return {
    id: "conv-1",
    title: "测试会话",
    inserted_at: "2026-08-01T10:00:00.000000+08:00",
    mapping: {
      root: { id: "root", parent: null, children: ["1"], message: null },
      "1": {
        id: "1",
        parent: "root",
        children: ["2"],
        message: {
          model: "deepseek-chat",
          inserted_at: "2026-08-01T10:00:00.000000+08:00",
          fragments: [{ type: "REQUEST", content: "你好" }],
        },
      },
      "2": {
        id: "2",
        parent: "1",
        children: [],
        message: {
          model: "deepseek-chat",
          inserted_at: "2026-08-01T10:00:05.000000+08:00",
          fragments: [{ type: "RESPONSE", content: "你好！有什么可以帮你？" }],
        },
      },
    },
    ...overrides,
  };
}

test("构建会话：一轮 user + assistant 生成完整事件序列", () => {
  const b = buildSession(conv(), "/tmp/ws");
  assert.equal(b.error, undefined);
  assert.equal(b.id, "conv-1");
  assert.equal(b.title, "测试会话");
  const types = b.events.map((e) => e.type);
  assert.deepEqual(types, [
    "turn/start",
    "step/start",
    "user/message",
    "assistant/message",
    "step/end",
    "turn/end",
    "session/title",
    "session/end-seed",
  ]);
  // seq 连续
  b.events.forEach((e, i) => assert.equal(e.seq, i));
  // 用户消息与助手消息
  const userMsg = b.events.find((e) => e.type === "user/message");
  assert.equal(userMsg.data.role, "user");
  assert.equal(userMsg.data.content[0].text, "你好");
  const asstMsg = b.events.find((e) => e.type === "assistant/message");
  assert.equal(asstMsg.data.message.role, "assistant");
  assert.equal(asstMsg.data.message.source.kind, "model");
  // 标题事件固定
  const titleEv = b.events.find((e) => e.type === "session/title");
  assert.equal(titleEv.data.title, "测试会话");
  assert.equal(titleEv.data.source.kind, "user");
  // 末行 end-seed
  assert.equal(types[types.length - 1], "session/end-seed");
});

test("多轮对话：每轮 turn/end 数量等于轮数", () => {
  const mapping = {
    root: { id: "root", parent: null, children: ["1"], message: null },
    "1": { id: "1", parent: "root", children: ["2"], message: { fragments: [{ type: "REQUEST", content: "一" }] } },
    "2": { id: "2", parent: "1", children: ["3"], message: { fragments: [{ type: "RESPONSE", content: "答一" }] } },
    "3": { id: "3", parent: "2", children: ["4"], message: { fragments: [{ type: "REQUEST", content: "二" }] } },
    "4": { id: "4", parent: "3", children: [], message: { fragments: [{ type: "RESPONSE", content: "答二" }] } },
  };
  const b = buildSession({ id: "conv-2", title: "", inserted_at: null, mapping }, "/tmp/ws");
  const turnEnds = b.events.filter((e) => e.type === "turn/end").length;
  assert.equal(turnEnds, 2);
  assert.equal(b.title, null); // 无标题时不写 title 事件
  assert.ok(!b.events.some((e) => e.type === "session/title"));
});

test("孤立 user 消息（无回复）也构成一轮", () => {
  const mapping = {
    root: { id: "root", parent: null, children: ["1"], message: null },
    "1": { id: "1", parent: "root", children: [], message: { fragments: [{ type: "REQUEST", content: "只问不答" }] } },
  };
  const b = buildSession({ id: "conv-3", title: "孤", inserted_at: null, mapping }, "/tmp/ws");
  const types = b.events.map((e) => e.type);
  assert.ok(types.includes("user/message"));
  assert.ok(!types.includes("assistant/message"));
  assert.equal(b.events.filter((e) => e.type === "turn/end").length, 1);
});

test("没有消息的会话返回 error", () => {
  const b = buildSession({ id: "conv-4", title: "", inserted_at: null, mapping: { root: { id: "root", children: [] } } }, "/tmp/ws");
  assert.ok(b.error);
});

test("标题超长时按 UTF-8 字节截断", () => {
  const long = "长".repeat(100);
  const b = buildSession(conv({ title: long }), "/tmp/ws");
  const titleEv = b.events.find((e) => e.type === "session/title");
  assert.ok(Buffer.byteLength(titleEv.data.title, "utf8") <= 80);
});

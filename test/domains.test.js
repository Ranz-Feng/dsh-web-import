import test from "node:test";
import assert from "node:assert/strict";
import { foldTitle, foldListMetadata } from "../src/domains.js";

function ev(type, data, time) {
  return { type, seq: 0, time, data };
}

test("foldTitle：取最后一个 session/title 事件", () => {
  const events = [
    ev("user/message", { content: [], source: { kind: "user" } }, 1),
    ev("session/title", { title: "旧标题", messageSeqs: [], source: { kind: "fallback" } }, 2),
    ev("session/title", { title: "新标题", messageSeqs: [], source: { kind: "user" } }, 3),
  ];
  assert.equal(foldTitle(events), "新标题");
});

test("foldTitle：无标题事件返回 null", () => {
  const events = [ev("user/message", { content: [], source: { kind: "user" } }, 1)];
  assert.equal(foldTitle(events), null);
});

test("foldListMetadata：有 turn/start 则非空白，记录最近用户消息时间", () => {
  const events = [
    ev("turn/start", { turn: 1 }, 10),
    ev("user/message", { content: [], source: { kind: "user" } }, 20),
    ev("assistant/message", { message: {} }, 30),
    ev("user/message", { content: [], source: { kind: "user" } }, 40),
  ];
  const meta = foldListMetadata(events);
  assert.equal(meta.blank, false);
  assert.equal(meta.lastPromptAt, 40);
});

test("foldListMetadata：空白会话返回 blank=true 且 lastPromptAt=null", () => {
  const meta = foldListMetadata([]);
  assert.equal(meta.blank, true);
  assert.equal(meta.lastPromptAt, null);
});

test("foldListMetadata：非 user 来源的消息不计入 lastPromptAt", () => {
  const events = [
    ev("turn/start", { turn: 1 }, 10),
    ev("user/message", { content: [], source: { kind: "plugin", plugin: "x" } }, 50),
  ];
  const meta = foldListMetadata(events);
  assert.equal(meta.lastPromptAt, null);
});

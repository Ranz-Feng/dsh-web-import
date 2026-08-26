import test from "node:test";
import assert from "node:assert/strict";
import { encodeSegment, projectKey, verifyLines } from "../src/dsh.js";

test("encodeSegment：安全字符原样保留", () => {
  assert.equal(encodeSegment("26e439a0-276e-42fc-9361-06ca4a2b44b0"), "26e439a0-276e-42fc-9361-06ca4a2b44b0");
});

test("encodeSegment：不安全字符转义且可逆", () => {
  assert.equal(encodeSegment("a b~c/d"), "a~0020b~007Ec~002Fd");
  assert.equal(encodeSegment(".."), "~002E~002E");
  assert.equal(encodeSegment("."), "~002E");
});

test("projectKey：路径分隔符变 '-'，空格转义", () => {
  assert.equal(projectKey("/Users/x/My Folder"), "--Users-x-My~0020Folder--");
  assert.equal(projectKey("/a/b/c"), "--a-b-c--");
});

test("verifyLines：连续 seq 通过", () => {
  const lines = [
    JSON.stringify({ type: "session", version: 0, id: "s", createdAt: 0, delegationDepth: 0 }),
    JSON.stringify({ type: "turn/start", seq: 0, time: 1, data: { turn: 1 } }),
    JSON.stringify({ type: "turn/end", seq: 1, time: 2, data: { turn: 1, reason: { kind: "completed" } } }),
  ];
  verifyLines(lines); // 不抛错即通过
});

test("verifyLines：seq 断裂抛错", () => {
  const lines = [
    JSON.stringify({ type: "session", version: 0, id: "s", createdAt: 0, delegationDepth: 0 }),
    JSON.stringify({ type: "turn/start", seq: 0, time: 1, data: { turn: 1 } }),
    JSON.stringify({ type: "turn/end", seq: 5, time: 2, data: { turn: 1, reason: { kind: "completed" } } }),
  ];
  assert.throws(() => verifyLines(lines), /seq 不连续/);
});

test("verifyLines：packed row 用 seq0 校验", () => {
  const lines = [
    JSON.stringify({ type: "session", version: 0, id: "s", createdAt: 0, delegationDepth: 0 }),
    JSON.stringify({ type: "text-chunks", seq0: 0, time0: 1, data: { turn: 1, step: 1, index: 0, dt: [1], texts: ["a", "b"] } }),
    JSON.stringify({ type: "turn/end", seq: 2, time: 3, data: { turn: 1, reason: { kind: "completed" } } }),
  ];
  verifyLines(lines);
});

import { expect, test } from "bun:test";
import { applyMessage, applyParts, canonical, messageId, partsOf, textPart, type Block } from "../../src/content.ts";

test("every kind of block becomes a part, by position", () => {
  const parts = partsOf("m", [
    { type: "text", text: "hi" },
    { type: "thinking", thinking: "hm" },
    { type: "toolCall", id: "c", name: "read", arguments: { path: "x" } },
    { type: "image", data: "aGk=", mimeType: "image/png" },
  ]);
  expect(parts.map((part) => [part.id, part.kind, part.category])).toEqual([
    ["m#0", "text", undefined],
    ["m#1", "text", "reasoning"],
    ["m#2", "text", "tool_call"],
    ["m#3", "attachment", undefined],
  ]);
});

test("identities hold across requests and tell apart one millisecond", () => {
  const seen = new Map<string, number>();
  const native = { role: "custom", timestamp: 5, content: "x" };
  expect(messageId("s", native, seen)).toBe("s:custom:5");
  expect(messageId("s", native, seen)).toBe("s:custom:5:1");
  expect(messageId("s", { role: "toolResult", toolCallId: "c", timestamp: 5 })).toBe("c:result");
});

test("messages pi has no provider role for become user messages", () => {
  expect(canonical("s", { role: "custom", timestamp: 1, content: "x" }).role).toBe("user");
  const summary = canonical("s", { role: "compactionSummary", timestamp: 1, summary: "short" });
  expect(summary.parts[0]).toMatchObject({ text: "short", category: "summary" });
  expect(canonical("s", { role: "toolResult", toolCallId: "c", content: [] }).role).toBe("tool");
});

test("unchanged parts leave the same array", () => {
  const content: Block[] = [{ type: "text", text: "a" }];
  expect(applyParts("m", content, partsOf("m", content))).toBe(content);
  expect(applyParts("m", content, undefined)).toBe(content);
});

test("text changes, parts left out go, new text is added", () => {
  const content: Block[] = [{ type: "text", text: "a" }, { type: "image", data: "x", mimeType: "image/png" }, { type: "text", text: "b" }];
  const next = applyParts("m", content, [textPart("m#0", "A"), textPart("new", "c")]);
  expect(next).toEqual([{ type: "text", text: "A" }, { type: "text", text: "c" }]);
});

test("in a transcript a tool call stays whatever a rewrite leaves out", () => {
  const content: Block[] = [{ type: "text", text: "a" }, { type: "toolCall", id: "c", name: "read", arguments: {} }];
  const next = applyParts("m", content, [textPart("new", "z")], { keepToolCalls: true });
  expect(next).toEqual([{ type: "toolCall", id: "c", name: "read", arguments: {} }, { type: "text", text: "z" }]);
});

test("in a response a tool call can go, or run with other arguments", () => {
  const content: Block[] = [{ type: "toolCall", id: "c", name: "read", arguments: { path: "a" } }];
  expect(applyParts("m", content, [textPart("new", "z")])).toEqual([{ type: "text", text: "z" }]);
  const edited = textPart("m#0", JSON.stringify({ id: "c", name: "read", arguments: { path: "b" } }), "tool_call");
  expect(applyParts("m", content, [edited])).toEqual([{ type: "toolCall", id: "c", name: "read", arguments: { path: "b" } }]);
});

test("messages that hold text in their own fields take a rewrite there", () => {
  const summary = { role: "compactionSummary", timestamp: 1, summary: "short" };
  expect(applyMessage("m", summary, [textPart("m#0", "shorter")])).toMatchObject({ summary: "shorter" });
  const bash = { role: "bashExecution", timestamp: 1, command: "ls", output: "secret" };
  expect(canonical("s", bash).parts.map((part) => (part as { text: string }).text)).toEqual(["ls", "secret"]);
  expect(applyMessage("m", bash, [textPart("m#0", "ls"), textPart("m#1", "gone")])).toMatchObject({ output: "gone" });
  
});

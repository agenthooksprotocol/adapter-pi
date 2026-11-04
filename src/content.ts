// pi's messages as canonical AHP content, and effective content back onto them.
// Structured values (tool calls) travel as their JSON in a text part; images are
// attachments, uploaded only when a subscription selects the body.
import { Attachment } from "agenthooksprotocol/client";

export type Role = "system" | "developer" | "user" | "assistant" | "tool";

export type TextPart = {
  id: string;
  kind: "text";
  mediaType: "text/plain";
  selection: "body";
  text: string;
  category?: string;
};

export type AttachmentPart = { id: string; kind: "attachment"; mediaType: string; body: Attachment; category?: string };

export type Part = TextPart | AttachmentPart;

export type Message = {
  id: string;
  role: Role;
  parts: Part[];
  synthesized?: boolean;
};

/** A value as the JSON the SDK's payload types declare. */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
export function json<T = { [key: string]: Json }>(value: unknown): T {
  return value as T;
}

export function textPart(id: string, text: string, category?: string): TextPart {
  return { id, kind: "text", mediaType: "text/plain", selection: "body", text, ...(category ? { category } : {}) };
}

export function message(id: string, role: Role, text: string, options: { category?: string; synthesized?: boolean } = {}): Message {
  return {
    id,
    role,
    parts: [textPart(`${id}#0`, text, options.category)],
    ...(options.synthesized ? { synthesized: true } : {}),
  };
}

/** Serialize any value as text. */
export function asText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** The text of every part of the messages, in order. */
export function texts(messages: readonly unknown[] | undefined): string[] {
  const out: string[] = [];
  for (const entry of messages ?? []) {
    const parts = (entry as { parts?: unknown[] })?.parts;
    for (const part of parts ?? []) {
      const text = (part as { text?: unknown })?.text;
      if (typeof text === "string" && text !== "") out.push(text);
    }
  }
  return out;
}

/** A block of a pi message's content. */
export type Block = {
  type: string;
  text?: string;
  thinking?: string;
  data?: string;
  mimeType?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
};

export type NativeMessage = {
  role: string;
  content?: string | readonly Block[];
  timestamp?: number;
  toolCallId?: string;
  summary?: string;
  command?: string;
  output?: string;
  /** A `!!` command: its output is the person's, and the model does not read it. */
  excludeFromContext?: boolean;
  customType?: string;
};

export function blocks(content: string | readonly Block[] | undefined): readonly Block[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content ?? [];
}

/** Content blocks as canonical parts, by position: effective parts find their
 * blocks again by these ids. */
export function partsOf(id: string, content: string | readonly Block[] | undefined): Part[] {
  return blocks(content).flatMap((block, index): Part[] => {
    const partId = `${id}#${index}`;
    switch (block.type) {
      case "text":
        return [textPart(partId, block.text ?? "")];
      case "thinking":
        return [textPart(partId, block.thinking ?? "", "reasoning")];
      case "toolCall":
        return [textPart(partId, asText({ id: block.id, name: block.name, arguments: block.arguments }), "tool_call")];
      case "image": {
        const data = block.data ?? "";
        return [{ id: partId, kind: "attachment", mediaType: block.mimeType ?? "application/octet-stream", body: Attachment.lazy(() => new Uint8Array(Buffer.from(data, "base64"))) }];
      }
      default:
        return [];
    }
  });
}

const ROLES: Record<string, Role> = { user: "user", assistant: "assistant", toolResult: "tool", system: "system" };

/** What tells a custom message from another: its timestamp changes on the way
 * from pi.sendMessage into the session. */
export function customKey(customType: unknown, content: unknown): string {
  return `${String(customType)}\0${asText(content)}`;
}

/** A message's identity: pi's messages have none until they are saved, and only
 * then under their entry. Its timestamp is what stays put from the moment it
 * exists, across requests and resumes. `seen` tells apart two in one millisecond. */
export function messageId(session: string, native: NativeMessage, seen?: Map<string, number>): string {
  if (native.role === "toolResult" && native.toolCallId) return `${native.toolCallId}:result`;
  const base = `${session}:${native.role}:${native.timestamp ?? 0}`;
  const count = seen?.get(base) ?? 0;
  seen?.set(base, count + 1);
  return count ? `${base}:${count}` : base;
}

/** One native message as a canonical message. */
export function canonical(session: string, native: NativeMessage, seen?: Map<string, number>): Message {
  const id = messageId(session, native, seen);
  const role = ROLES[native.role] ?? "user";
  const base = { id, role, synthesized: true };
  switch (native.role) {
    case "compactionSummary":
    case "branchSummary":
      return { ...base, parts: [textPart(`${id}#0`, native.summary ?? "", "summary")] };
    case "bashExecution":
      return { ...base, parts: [textPart(`${id}#0`, native.command ?? "", "tool_call"), textPart(`${id}#1`, native.output ?? "", "tool_result")] };
    default:
      return { ...base, parts: partsOf(id, native.content) };
  }
}

/** Effective parts back onto a message's blocks. Returns the blocks unchanged, the
 * same array, when nothing differs.
 *
 * `keepToolCalls` is for a transcript, where a provider refuses calls and results
 * that no longer pair. A response not yet acted on has no results: there a call a
 * backend leaves out goes, and one it edits runs with the new arguments. */
export function applyParts(id: string, content: readonly Block[], effective: readonly Part[] | undefined, options: { keepToolCalls?: boolean } = {}): readonly Block[] {
  if (!effective) return content;
  const byId = new Map(effective.map((part) => [part.id, part]));
  const known = new Set(content.map((_, index) => `${id}#${index}`));
  let changed = false;
  const next: Block[] = [];
  content.forEach((block, index) => {
    const part = byId.get(`${id}#${index}`);
    if (block.type === "toolCall" && options.keepToolCalls) {
      next.push(block);
      return;
    }
    if (!part) {
      changed = true;
      return;
    }
    const text = (part as TextPart).text;
    if (block.type === "text" && typeof text === "string" && text !== block.text) {
      changed = true;
      next.push({ ...block, text });
    } else if (block.type === "thinking" && typeof text === "string" && text !== block.thinking) {
      changed = true;
      next.push({ ...block, thinking: text });
    } else if (block.type === "toolCall" && typeof text === "string" && text !== asText({ id: block.id, name: block.name, arguments: block.arguments })) {
      changed = true;
      next.push({ ...block, arguments: toolArguments(text, block.arguments) });
    } else {
      next.push(block);
    }
  });
  for (const part of effective) {
    if (known.has(part.id) || typeof (part as TextPart).text !== "string") continue;
    changed = true;
    next.push({ type: "text", text: (part as TextPart).text });
  }
  return changed ? next : content;
}

function toolArguments(text: string, fallback: unknown): unknown {
  try {
    const parsed = JSON.parse(text) as { arguments?: unknown };
    return parsed.arguments ?? fallback;
  } catch {
    return fallback;
  }
}

/** Effective parts back onto a message of a request. Messages with no `content`
 * hold their text in fields of their own. Returns the same message when nothing differs. */
export function applyMessage(id: string, native: NativeMessage, effective: readonly Part[] | undefined): NativeMessage {
  if (!effective) return native;
  const text = (index: number, previous: string | undefined) => {
    const part = effective.find((item) => item.id === `${id}#${index}`) as TextPart | undefined;
    return part ? part.text : previous === undefined ? undefined : "";
  };
  if (native.role === "compactionSummary" || native.role === "branchSummary") {
    const summary = text(0, native.summary);
    return summary === native.summary ? native : { ...native, summary: summary ?? "" };
  }
  if (native.role === "bashExecution") {
    const command = text(0, native.command);
    const output = text(1, native.output);
    return command === native.command && output === native.output ? native : { ...native, command: command ?? "", output: output ?? "" };
  }
  const content = blocks(native.content);
  const applied = applyParts(id, content, effective, { keepToolCalls: true });
  return applied === content ? native : { ...native, content: applied };
}

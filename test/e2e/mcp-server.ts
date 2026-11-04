// A real MCP server over stdio, with one tool, for the end-to-end tests.
const decoder = new TextDecoder();
let buffer = "";
for await (const chunk of Bun.stdin.stream() as unknown as AsyncIterable<Uint8Array>) {
  buffer += decoder.decode(chunk);
  let end: number;
  while ((end = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, end);
    buffer = buffer.slice(end + 1);
    if (!line.trim()) continue;
    const request = JSON.parse(line) as { id?: number; method: string; params?: Record<string, any> };
    const answer = (result: unknown) => console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
    if (request.method === "initialize") answer({ protocolVersion: request.params!.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "docs", version: "1.0.0" } });
    else if (request.method === "tools/list") answer({ tools: [{ name: "search", description: "Search the docs", inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] } }] });
    else if (request.method === "tools/call") answer({ content: [{ type: "text", text: `mcp result for ${request.params!.arguments.q}` }] });
    else if (request.id !== undefined) answer({});
  }
}

export {};

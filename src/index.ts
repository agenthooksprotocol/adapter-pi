// The pi extension: one instance per session runtime.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Adapter } from "./adapter.js";
import { lifecycle } from "./events/lifecycle.js";
import { model } from "./events/model.js";
import { tools } from "./events/tools.js";
import { turns } from "./events/turns.js";

export default function agentHooksProtocol(pi: ExtensionAPI): void {
  const adapter = new Adapter(pi);
  lifecycle(adapter);
  turns(adapter);
  model(adapter);
  tools(adapter);

  pi.registerCommand("ahp", {
    description: "Agent Hooks Protocol sign-in: /ahp status | login [backend] | logout <backend>",
    getArgumentCompletions: (prefix) => {
      const words = ["status", "login", "logout", ...(adapter.logins?.ids() ?? []).flatMap((id) => [`login ${id}`, `logout ${id}`, `status ${id}`])];
      const matches = words.filter((word) => word.startsWith(prefix)).map((value) => ({ value, label: value }));
      return matches.length ? matches : null;
    },
    handler: async (args, ctx) => {
      adapter.ctx = ctx;
      if (!adapter.logins) return adapter.notify("Agent Hooks Protocol: no backends are registered.", "warning");
      adapter.initialization();
      await adapter.logins.command(args);
    },
  });
  // A turn begins: show the links of the sign-ins its backends asked for.
  pi.on("agent_start", (_event, ctx) => {
    adapter.ctx = ctx;
    adapter.initialization();
    adapter.logins?.turnStart();
  });
}

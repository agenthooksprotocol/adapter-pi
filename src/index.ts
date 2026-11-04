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
}

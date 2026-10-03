import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { cwd } from "node:process";
import { extractChatGptTurnEnvironment } from "../src/adapters/chatgpt-web/environment";
import { defaultConfig } from "../src/config";
import { messagesRequest } from "../src/messages";

for (const latest of [
  "# Environment\n- Primary working directory: relative-project",
  "# Environment\n- Platform: darwin",
  "",
]) {
  for (const hasTopLevel of [true, false]) {
    test(`Claude cwd never revives older system context (latest=${JSON.stringify(latest)}, top-level=${hasTopLevel})`, async () => {
      const fallback = hasTopLevel ? resolve("authorized-current-project") : cwd();
      const stale = resolve("stale-project");
      const invalidExplicitDirectory = latest.includes("Primary working directory: relative-project");
      let adapterCalled = false;
      const response = await messagesRequest(new Request("http://127.0.0.1:17841/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-chatgpt-web-high",
          system: hasTopLevel ? `You are Claude Code.\n- Primary working directory: ${fallback}` : "You are Claude Code.",
          messages: [
            { role: "system", content: `# Environment\n- Primary working directory: ${stale}` },
            { role: "system", content: [{ type: "text", text: latest }] },
            { role: "user", content: "Inspect the current project." },
          ],
        }),
      }), defaultConfig("full"), () => ({
        name: "claude-cwd-precedence-test",
        async runTurn(parsed, _incoming, emit) {
          adapterCalled = true;
          expect(extractChatGptTurnEnvironment(parsed).cwd).toBe(fallback);
          emit({ type: "text_delta", text: "Ready.", phase: "final_answer" });
          emit({ type: "done", stopReason: "stop", endTurn: true });
        },
      }));
      // An explicit malformed machine directory must fail closed, not silently
      // fall back to another workspace and execute tools there.
      expect(response.status).toBe(invalidExplicitDirectory ? 400 : 200);
      expect(adapterCalled).toBe(!invalidExplicitDirectory);
      if (invalidExplicitDirectory) expect(await response.text()).toContain("invalid working directory");
    });
  }
}

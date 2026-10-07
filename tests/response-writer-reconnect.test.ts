import {expect, test} from "bun:test";
import {ChatGptBrowserWorker, type BrowserTurn} from "../src/adapters/chatgpt-web/browser-worker";
import {createChatGptWebAdapter} from "../src/adapters/chatgpt-web/index";
import type {AdapterEvent, CodexProviderConfig} from "../src/types";
import {rawWireRequest, environmentXml} from "./chatgpt-harness-fixture";

test("a closed response writer detaches without cancelling accepted browser work", async () => {
    for (const failureAt of ["text", "heartbeat"]) {
      const provider: CodexProviderConfig = {
        adapter: "chatgpt-web", baseUrl: `browser://writer-disconnect-${failureAt}-${Date.now()}`,
        chatgptWeb: { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true },
      };
      const worker = ChatGptBrowserWorker.forProvider(provider);
      const originalRun = worker.run.bind(worker);
      let browserStarts = 0;
      let browserSignal: AbortSignal | undefined;
      let finish!: () => void;
      (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = turn => {
        browserStarts += 1;
        browserSignal = turn.abortSignal;
        turn.onSendActivated?.();
        turn.onSubmitted?.();
        if (failureAt === "text") turn.onTextDelta("First ");
        return new Promise(resolve => { finish = () => {
          turn.onTextDelta("complete");
          resolve(failureAt === "text" ? "First complete" : "complete");
        }; });
      };
      const request = rawWireRequest(environmentXml);
      let heartbeats = 0;
      try {
        let failure: unknown;
        try {
          await createChatGptWebAdapter(provider).runTurn!(request, { headers: new Headers() }, event => {
            if (event.type === "heartbeat") heartbeats += 1;
            if ((failureAt === "text" && event.type === "text_delta" && event.phase === "final_answer")
              || (failureAt === "heartbeat" && event.type === "heartbeat" && heartbeats > 1)) {
              // Closed stream controllers throw even if no request AbortSignal has fired yet.
              throw new TypeError("Controller is already closed");
            }
          });
        } catch (error) { failure = error; }
        expect(failure).toMatchObject({ name: "AbortError" });
        expect(browserSignal?.aborted).toBeFalse();
        const events: AdapterEvent[] = [];
        const reconnect = createChatGptWebAdapter(provider).runTurn!(request, { headers: new Headers() }, event => events.push(event));
        finish();
        await reconnect;
        finish = () => {};
        expect(browserStarts).toBe(1);
        expect(events.filter((event): event is Extract<AdapterEvent, { type: "text_delta" }> => event.type === "text_delta"
          && event.phase === "final_answer").map(event => event.text).join(""))
          .toBe(failureAt === "text" ? "First complete" : "complete");
      } finally {
        finish?.();
        (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = originalRun;
      }
    }
  }, 20_000);

test("an observer failure in the middle of a drained text batch loses no reconnect data", async () => {
    const provider: CodexProviderConfig = {
      adapter: "chatgpt-web",
      baseUrl: `browser://chatgpt-batched-reconnect-${Date.now()}`,
      chatgptWeb: { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true },
    };
    const worker = ChatGptBrowserWorker.forProvider(provider);
    const originalRun = worker.run.bind(worker);
    let browserStarts = 0;
    let finishBrowser!: () => void;
    (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = turn => {
      browserStarts += 1;
      turn.onTextDelta("batch-one ");
      turn.onTextDelta("batch-two ");
      return new Promise<string>(resolve => {
        finishBrowser = () => {
          turn.onTextDelta("batch-three");
          resolve("batch-one batch-two batch-three");
        };
      });
    };
    const request = rawWireRequest(environmentXml);
    const disconnect = new AbortController();
    let textEvents = 0;
    try {
      const first = createChatGptWebAdapter(provider).runTurn!(
        request,
        { headers: new Headers(), abortSignal: disconnect.signal },
        event => {
          if (event.type !== "text_delta" || event.phase !== "final_answer") return;
          textEvents += 1;
          if (textEvents === 1) {
            disconnect.abort();
            throw new DOMException("observer disconnected", "AbortError");
          }
        },
      );
      await expect(first).rejects.toMatchObject({ name: "AbortError" });

      const replayed: AdapterEvent[] = [];
      const reconnect = createChatGptWebAdapter(provider).runTurn!(
        request,
        { headers: new Headers() },
        event => replayed.push(event),
      );
      await Bun.sleep(0);
      finishBrowser();
      await reconnect;
      expect(browserStarts).toBe(1);
      expect(replayed
        .filter((event): event is Extract<AdapterEvent, { type: "text_delta" }> => (
          event.type === "text_delta" && event.phase === "final_answer"
        ))
        .map(event => event.text)
        .join(""))
        .toBe("batch-one batch-two batch-three");
    } finally {
      (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = originalRun;
    }
  });

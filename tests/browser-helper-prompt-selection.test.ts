import { expect, test } from "bun:test";
import { createBrowserHelperPromptSelection } from "../src/adapters/chatgpt-web/browser-helper-prompt-selection";

test("browser helper prompt cancellation rejects only an awaiting consumer", async () => {
  const selection = createBrowserHelperPromptSelection();
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  process.on("unhandledRejection", onUnhandled);
  try {
    selection.cancel();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(unhandled).toEqual([]);
    await expect(selection.wait()).rejects.toMatchObject({
      name: "AbortError",
      message: "Browser helper prompt selection aborted",
    });
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("browser helper prompt selection delivers the selected prompt", async () => {
  const selection = createBrowserHelperPromptSelection();
  selection.select({ text: "continue", images: [] });
  await expect(selection.wait()).resolves.toEqual({ text: "continue", images: [] });
});

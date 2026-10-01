import { expect, test } from "bun:test";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";

test("model readiness starts independent read-only checks together", async () => {
  const reads: string[] = [];
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const read = async <T>(name: string, value: T): Promise<T> => { reads.push(name); await hold; return value; };
  const control: any = { locator: () => control, filter: () => control, first: () => control,
    count: async () => 1, innerText: () => read("label", "5.6 Sol 極高"),
    getAttribute: () => read("expanded", "false") };
  const worker: any = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
    activeComposer: async () => ({ locator: () => control, isEditable: () => read("editable", true) }),
  });
  const pending = worker.assertSelectedEffort({ url: () => "same" },
    { selection: { url: "same", label: "5.6 Sol 極高" } }, false);
  try {
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(reads).toEqual(["label", "expanded", "editable"]);
  } finally { release(); await pending; }
});

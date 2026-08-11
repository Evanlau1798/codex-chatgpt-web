import { expect, test } from "bun:test";
import {
  ChatGptSteeringFeed,
  ChatGptTextFeed,
  ChatGptTraceFeed,
  ChatGptTurnSessions,
} from "../src/adapters/chatgpt-web/turn-execution";

test("does not redeliver a native revision after a transient transcript rollback", () => {
  const sessions = new ChatGptTurnSessions();
  const steering = new ChatGptSteeringFeed();
  const session = sessions.getOrCreate("root", () => ({
    mode: "read-only",
    browser: new Promise<string>(() => {}),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    steering,
    cancel: () => {},
  }));

  expect(session.updateUserRevision("revision-a", "Initial prompt")).toBeUndefined();
  expect(session.updateUserRevision("revision-b", "Steering prompt")).toBe("Steering prompt");
  expect(steering.take()).toBe("Steering prompt");
  expect(session.updateUserRevision("revision-a", "Initial prompt")).toBeUndefined();
  expect(session.updateUserRevision("revision-b", "Steering prompt")).toBeUndefined();
  expect(steering.take()).toBeUndefined();
});

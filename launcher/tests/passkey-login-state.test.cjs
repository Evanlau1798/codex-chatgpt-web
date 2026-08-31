const test = require("node:test");
const assert = require("node:assert/strict");
const { validatePasskeyLoginState } = require("../electron/passkey-login-state.cjs");

function cookie(name, domain, extra = {}) {
  return {
    name,
    value: `${name}-value`,
    domain,
    path: "/",
    expires: -1,
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    ...extra,
  };
}

test("passkey transfer retains only portable ChatGPT/OpenAI state", () => {
  const state = validatePasskeyLoginState({
    cookies: [
      cookie("chatgpt", ".chatgpt.com"),
      cookie("openai", "auth.openai.com"),
      cookie("partitioned", ".chatgpt.com", { partitionKey: "https://accounts.google.com" }),
      cookie("identity-provider", ".accounts.google.com"),
      cookie("lookalike", ".chatgpt.com.attacker.example"),
      cookie("userinfo", "attacker.example@chatgpt.com"),
      cookie("port", "chatgpt.com:443"),
    ],
    origins: [
      { origin: "https://chatgpt.com", localStorage: [{ name: "chat", value: "kept" }] },
      { origin: "https://auth.openai.com", localStorage: [{ name: "auth", value: "ignored" }] },
      { origin: "https://accounts.google.com", localStorage: [{ name: "idp", value: "ignored" }] },
    ],
  });

  assert.deepEqual(state.cookies.map(value => value.name), ["chatgpt", "openai"]);
  assert.equal(state.cookies[0].domain, ".chatgpt.com");
  assert.equal(state.cookies[1].domain, undefined);
  assert.deepEqual(state.localStorage, [{ name: "chat", value: "kept" }]);
});

test("passkey transfer fails closed without an allowed session cookie", () => {
  assert.throws(() => validatePasskeyLoginState({
    cookies: [cookie("google", ".accounts.google.com")],
    origins: [],
  }), /no ChatGPT\/OpenAI cookies/);
});

test("passkey transfer rejects malformed allowed-domain cookie fields", () => {
  assert.throws(() => validatePasskeyLoginState({
    cookies: [cookie("broken", ".chatgpt.com", { path: "relative" })],
    origins: [],
  }), /invalid cookie path/);
  assert.throws(() => validatePasskeyLoginState({
    cookies: [cookie("broken", ".chatgpt.com", { sameSite: "Unknown" })],
    origins: [],
  }), /invalid cookie SameSite/);
});

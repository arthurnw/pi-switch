import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const home = await mkdtemp(join(tmpdir(), "pi-switch-test-"));
await mkdir(join(home, ".pi", "agent"), { recursive: true });
await writeFile(join(home, ".pi", "agent", "pi-switch.json"), JSON.stringify({
  defaultProvider: "openai-codex",
  defaultTier: 1,
  providers: { "openai-codex": { "1": "gpt-6.1-sol" } },
}));
const originalHome = process.env.HOME;
process.env.HOME = home;
const { default: extension } = await import("./pi-switch.ts");
if (originalHome === undefined) delete process.env.HOME;
else process.env.HOME = originalHome;
after(() => rm(home, { recursive: true, force: true }));

function harness(mode) {
  const events = new Map();
  const commands = new Map();
  const models = [];
  const model = { provider: "anthropic", id: "claude-opus-5-5" };
  const ctx = {
    mode,
    hasUI: mode === "tui" || mode === "rpc",
    model,
    modelRegistry: { find: (provider, id) => ({ provider, id }) },
    ui: {
      setStatus() {},
      notify() {},
      onTerminalInput() {},
    },
  };
  extension({
    on: (name, handler) => events.set(name, handler),
    registerCommand: (name, command) => commands.set(name, command),
    setModel: async (next) => { models.push(next); ctx.model = next; return true; },
    setThinkingLevel() {},
  });
  return { events, commands, models, ctx, model };
}

for (const mode of ["rpc", "json", "print"]) {
  test(`${mode} preserves the startup model and ignores pi-switch inputs and commands`, async () => {
    const { events, commands, models, ctx, model } = harness(mode);
    ctx.ui = new Proxy({}, { get() { throw new Error("non-TUI must not use terminal UI"); } });
    await events.get("session_start")({}, ctx);
    await events.get("turn_start")({}, ctx);
    assert.equal(await events.get("input")({ text: "/t1 hello" }, ctx), undefined);
    assert.equal(await events.get("input")({ text: "/t1" }, ctx), undefined);
    await commands.get("switch").handler("openai-codex/gpt-6.1-sol", ctx);
    await commands.get("default").handler("reset", ctx);
    await events.get("agent_end")({}, ctx);
    assert.deepEqual(models, []);
    assert.equal(ctx.model, model);
  });
}

test("TUI still applies defaults and switches models", async () => {
  const { events, commands, models, ctx } = harness("tui");
  await events.get("session_start")({}, ctx);
  assert.deepEqual(models[0], { provider: "openai-codex", id: "gpt-6.1-sol" });
  assert.deepEqual(await events.get("input")({ text: "/t1 hello" }, ctx), {
    action: "transform", text: "hello",
  });
  await events.get("agent_end")({}, ctx);
  await commands.get("switch").handler("anthropic/claude-opus-5-5", ctx);
  assert.deepEqual(models.at(-1), { provider: "anthropic", id: "claude-opus-5-5" });
});

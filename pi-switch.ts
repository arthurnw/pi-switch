/**
 * pi-switch — deliberate model switching for pi via slash-command shortcuts.
 *
 * Shortcuts:
 *   /t1 <message>              one-shot: use default provider's tier 1 for this turn, revert after
 *   /t0:anthropic <message>    one-shot with explicit provider (tier 0 = top-of-line)
 *   /t3:sonnet <message>       one-shot with nickname (nickname overrides tier)
 *   /t1                        persistent: change default tier to 1
 *   /t1:openai                 persistent: change default provider and default tier together
 *
 * Real commands:
 *   /default provider <name>   set default provider
 *   /default tier <0|1|2|3>    set default tier
 *   /default show              show current defaults + active model
 *   /default reset             reload config file
 *   /switch <provider/model>   direct setModel without sending a message
 *   /switch <nickname>         same, resolved through nicknames
 *
 * Config: ~/.pi/agent/pi-switch.json
 */

import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

type Tier = 0 | 1 | 2 | 3;
type TierKey = "0" | "1" | "2" | "3";
const TIER_KEYS = ["0", "1", "2", "3"] as const;

// Mirrors @mariozechner/pi-agent-core ThinkingLevel; redeclared to avoid
// importing a transitive dep just for the union.
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
const THINKING_LEVELS = new Set<ThinkingLevel>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

interface ProvidersConfig {
  [provider: string]: Partial<Record<TierKey, string>>;
}

interface Config {
  defaultProvider: string;
  defaultTier: Tier;
  providers: ProvidersConfig;
  nicknames: Record<string, string>; // nickname -> "provider/model-id"
  thinking: Record<string, ThinkingLevel>; // "provider/model-id" -> level
}

const CONFIG_PATH = join(homedir(), ".pi", "agent", "pi-switch.json");

const SEED_CONFIG: Config = {
  defaultProvider: "anthropic",
  defaultTier: 1,
  providers: {
    anthropic: {
      "0": "claude-fable-5",
      "1": "claude-opus-4-8",
      "2": "claude-sonnet-4-6",
      "3": "claude-haiku-4-5",
    },
    openai: {
      "0": "gpt-5.5-pro",
      "1": "gpt-5.5",
      "2": "gpt-5.4",
      "3": "gpt-5.4-mini",
    },
    google: {
      "0": "gemini-3.1-pro-preview",
      "1": "gemini-3.5-flash",
      "2": "gemini-3.1-flash-lite",
    },
  },
  nicknames: {
    fable: "anthropic/claude-fable-5",
    opus: "anthropic/claude-opus-4-8",
    sonnet: "anthropic/claude-sonnet-4-6",
    haiku: "anthropic/claude-haiku-4-5",
    pro: "google/gemini-3.1-pro-preview",
    flash: "google/gemini-3.5-flash",
  },
  thinking: {
    "anthropic/claude-fable-5": "xhigh",
    "anthropic/claude-opus-4-8": "xhigh",
    "anthropic/claude-sonnet-4-6": "high",
    "anthropic/claude-haiku-4-5": "high",
    "openai/gpt-5.5-pro": "xhigh",
    "openai/gpt-5.4": "xhigh",
    "openai/gpt-5.4-mini": "xhigh",
    "openai/gpt-5.4-nano": "xhigh",
    "google/gemini-3.1-pro-preview": "high",
    "google/gemini-3.5-flash": "high",
    "google/gemini-3.1-flash-lite": "high",
  },
};

const PREFIX_RE = /^\/t([0-3])(?::([a-zA-Z0-9_-]+))?(?:\s+([\s\S]*)|$)/;

export default function (pi: ExtensionAPI) {
  let config: Config = structuredClone(SEED_CONFIG);
  // True while the current active model is a one-shot override that should be
  // reverted to defaults at agent_end. Plain-message state = false.
  let hasActiveOverride = false;
  // Cache to skip no-op setStatus calls (avoids unnecessary footer re-renders).
  let lastPendingStatus: string | undefined;
  let lastFooterText: string | undefined;

  // ─── Config ────────────────────────────────────────────────────────────────

  async function loadConfig(): Promise<void> {
    try {
      const raw = await readFile(CONFIG_PATH, "utf8");
      config = normalizeConfig(JSON.parse(raw));
    } catch (err: unknown) {
      if (isNodeEnoent(err)) {
        config = structuredClone(SEED_CONFIG);
        await saveConfig();
        return;
      }
      throw err;
    }
  }

  async function saveConfig(): Promise<void> {
    await writeFile(
      CONFIG_PATH,
      `${JSON.stringify(config, null, 2)}\n`,
      "utf8",
    );
  }

  function normalizeConfig(raw: unknown): Config {
    const input = (raw ?? {}) as Partial<Config>;
    const result: Config = structuredClone(SEED_CONFIG);

    if (input.providers && typeof input.providers === "object") {
      result.providers = {};
      for (const [name, tiers] of Object.entries(input.providers)) {
        if (!tiers || typeof tiers !== "object") continue;
        const entry: Partial<Record<TierKey, string>> = {};
        for (const tier of TIER_KEYS) {
          const v = (tiers as Record<string, unknown>)[tier];
          if (typeof v === "string" && v.trim()) entry[tier] = v.trim();
        }
        if (Object.keys(entry).length > 0) result.providers[name] = entry;
      }
    }

    const providerKeys = Object.keys(result.providers);
    if (providerKeys.length === 0) {
      // Invalid config (no providers); fall back to seed so the extension
      // still loads with something usable.
      result.providers = structuredClone(SEED_CONFIG.providers);
    }

    if (
      typeof input.defaultProvider === "string" &&
      result.providers[input.defaultProvider]
    ) {
      result.defaultProvider = input.defaultProvider;
    } else {
      // Fall back to first provider defined in config.
      result.defaultProvider = Object.keys(result.providers)[0]!;
    }

    if (
      input.defaultTier === 0 ||
      input.defaultTier === 1 ||
      input.defaultTier === 2 ||
      input.defaultTier === 3
    ) {
      result.defaultTier = input.defaultTier;
    } else {
      result.defaultTier = 1;
    }

    result.nicknames = {};
    if (input.nicknames && typeof input.nicknames === "object") {
      for (const [nick, target] of Object.entries(input.nicknames)) {
        if (typeof target === "string" && target.includes("/")) {
          result.nicknames[nick] = target;
        }
      }
    }

    result.thinking = {};
    if (input.thinking && typeof input.thinking === "object") {
      for (const [key, level] of Object.entries(input.thinking)) {
        if (typeof level !== "string") continue;
        if (!THINKING_LEVELS.has(level as ThinkingLevel)) continue;
        if (!key.includes("/")) continue;
        result.thinking[key] = level as ThinkingLevel;
      }
    }

    return result;
  }

  // ─── Resolution ────────────────────────────────────────────────────────────

  type Resolved = { provider: string; modelId: string };

  function resolveNickname(
    nickname: string,
  ): Resolved | { error: string } | undefined {
    const target = config.nicknames[nickname];
    if (!target) return undefined;
    const [provider, ...rest] = target.split("/");
    const modelId = rest.join("/");
    if (!provider || !modelId) {
      return {
        error: `Nickname "${nickname}" has invalid target "${target}" (expected "provider/model-id")`,
      };
    }
    return { provider, modelId };
  }

  function resolveSpec(
    tier: Tier,
    suffix: string | undefined,
  ): Resolved | { error: string } {
    // Nickname wins over provider when suffix is ambiguous.
    const nick = suffix ? resolveNickname(suffix) : undefined;
    if (nick) return nick;

    const provider = suffix ?? config.defaultProvider;
    const tiers = config.providers[provider];
    if (!tiers) {
      const known = [
        ...Object.keys(config.providers),
        ...Object.keys(config.nicknames),
      ].join(", ");
      return {
        error: `Unknown provider or nickname: "${suffix}". Known: ${known}`,
      };
    }

    const modelId = tiers[String(tier) as TierKey];
    if (!modelId) {
      return { error: `Provider "${provider}" has no tier ${tier} configured` };
    }
    return { provider, modelId };
  }

  function resolveDefault(): Resolved | { error: string } {
    return resolveSpec(config.defaultTier, undefined);
  }

  // ─── Model application ────────────────────────────────────────────────────

  async function applyModel(ctx: any, resolved: Resolved): Promise<boolean> {
    const model = ctx.modelRegistry.find(resolved.provider, resolved.modelId);
    if (!model) {
      ctx.ui.notify(
        `Model not found in registry: ${resolved.provider}/${resolved.modelId}`,
        "error",
      );
      return false;
    }
    const ok = await pi.setModel(model);
    if (!ok) {
      ctx.ui.notify(
        `Failed to set model: ${resolved.provider}/${resolved.modelId} (no API key?)`,
        "error",
      );
      return false;
    }
    // Apply configured thinking level for this model. pi clamps to model
    // capabilities, so unsupported levels degrade gracefully. Only fires when
    // pi-switch is the cause of the model change — plain messages don't
    // trigger applyModel, so manual shift+tab overrides between turns persist.
    const key = `${resolved.provider}/${resolved.modelId}`;
    const level = config.thinking[key];
    if (level) pi.setThinkingLevel(level);
    return true;
  }

  // ─── Status bar ───────────────────────────────────────────────────────────
  //
  // Single status key "pi-switch". Shows dim default normally; when the user is
  // typing a prefix the pending override replaces it (bright, to draw attention).
  // Status text contains only pi-switch's own data — separators between footer
  // items are the footer renderer's concern, not ours.

  const DIM = "\x1b[2m";
  const DIM_RESET = "\x1b[22m";

  function defaultStatusText(): string {
    return `${DIM}default: ${config.defaultProvider}/t${config.defaultTier}${DIM_RESET}`;
  }

  function setFooterStatus(ctx: any, text: string): void {
    if (text === lastFooterText) return;
    lastFooterText = text;
    ctx.ui.setStatus("pi-switch", text);
  }

  function updateDefaultStatus(ctx: any): void {
    lastPendingStatus = undefined;
    setFooterStatus(ctx, defaultStatusText());
  }

  function updatePendingStatus(ctx: any, pending: string | undefined): void {
    if (pending === lastPendingStatus) return;
    lastPendingStatus = pending;
    setFooterStatus(ctx, pending !== undefined ? pending : defaultStatusText());
  }

  function formatPending(resolved: Resolved): string {
    return `→ ${resolved.provider}/${resolved.modelId}`;
  }

  // ─── Live footer preview ──────────────────────────────────────────────────

  function previewFromDraft(ctx: any, draft: string): void {
    const match = draft.match(PREFIX_RE);
    if (!match) {
      updatePendingStatus(ctx, undefined);
      return;
    }
    const tier = Number(match[1]) as Tier;
    const suffix = match[2];
    const resolved = resolveSpec(tier, suffix);
    if ("error" in resolved) {
      updatePendingStatus(ctx, `⚠ ${resolved.error.slice(0, 60)}`);
      return;
    }
    updatePendingStatus(ctx, formatPending(resolved));
  }

  // ─── Error helpers ────────────────────────────────────────────────────────

  function isNodeEnoent(err: unknown): boolean {
    return (
      typeof err === "object" &&
      err !== null &&
      (err as { code?: string }).code === "ENOENT"
    );
  }

  // ─── Session lifecycle ────────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    await loadConfig();
    updateDefaultStatus(ctx);

    // Apply defaults to active model at session start.
    const resolved = resolveDefault();
    if ("error" in resolved) {
      ctx.ui.notify(`pi-switch: ${resolved.error}`, "error");
      return;
    }
    await applyModel(ctx, resolved);

    // Wire live preview. Defer reading the editor until after the keystroke is
    // applied (onTerminalInput fires before the editor processes input).
    if (ctx.hasUI) {
      ctx.ui.onTerminalInput((_data: string) => {
        queueMicrotask(() => {
          const draft = ctx.ui.getEditorText();
          previewFromDraft(ctx, draft);
        });
        return undefined;
      });
    }
  });

  pi.on("turn_start", (_event, ctx) => {
    // Clear stale pending preview at turn boundaries (input is cleared on submit).
    updatePendingStatus(ctx, undefined);
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (!hasActiveOverride) return;
    hasActiveOverride = false;
    const resolved = resolveDefault();
    if ("error" in resolved) {
      ctx.ui.notify(`pi-switch revert failed: ${resolved.error}`, "error");
      return;
    }
    await applyModel(ctx, resolved);
  });

  // ─── Input handler ────────────────────────────────────────────────────────

  pi.on("input", async (event, ctx) => {
    const match = event.text.match(PREFIX_RE);
    if (!match) return;

    const tier = Number(match[1]) as Tier;
    const suffix = match[2];
    const body = (match[3] ?? "").trim();

    const resolved = resolveSpec(tier, suffix);
    if ("error" in resolved) {
      ctx.ui.notify(`pi-switch: ${resolved.error}`, "error");
      // Fall through with stripped prefix so the user's intent isn't lost.
      return body
        ? { action: "transform" as const, text: body }
        : { action: "handled" as const };
    }

    if (!body) {
      // Persistent change: update defaults, save, apply.
      // If suffix was a nickname, we can't meaningfully update defaultProvider/
      // defaultTier (nicknames override tier), so we just set the active model.
      if (suffix && config.nicknames[suffix]) {
        const ok = await applyModel(ctx, resolved);
        if (ok)
          ctx.ui.notify(
            `Active model: ${resolved.provider}/${resolved.modelId}`,
            "info",
          );
        return { action: "handled" as const };
      }
      if (suffix) config.defaultProvider = suffix;
      config.defaultTier = tier;
      await saveConfig();
      updateDefaultStatus(ctx);
      const ok = await applyModel(ctx, resolved);
      if (ok) {
        ctx.ui.notify(
          `Defaults: ${config.defaultProvider}/t${config.defaultTier} (${resolved.modelId})`,
          "info",
        );
      }
      return { action: "handled" as const };
    }

    // One-shot: apply override, transform out the prefix, schedule revert.
    const ok = await applyModel(ctx, resolved);
    if (ok) {
      hasActiveOverride = true;
      ctx.ui.notify(
        `→ ${resolved.provider}/${resolved.modelId} (one-shot)`,
        "info",
      );
    }
    return { action: "transform" as const, text: body };
  });

  // ─── Commands ─────────────────────────────────────────────────────────────

  pi.registerCommand("default", {
    description:
      "Configure pi-switch defaults (provider, tier). See: /default show",
    getArgumentCompletions: (prefix) => {
      const [head, ...tail] = prefix.split(/\s+/);
      if (tail.length === 0) {
        const opts: Array<{ value: string; label: string }> = [
          { value: "provider", label: "set default provider" },
          { value: "tier", label: "set default tier" },
          { value: "show", label: "show current defaults" },
          { value: "reset", label: "reload config from disk" },
        ];
        return opts.filter((o) => o.value.startsWith(head ?? ""));
      }
      if (head === "provider" && tail.length === 1) {
        return Object.keys(config.providers)
          .filter((p) => p.startsWith(tail[0] ?? ""))
          .map((p) => ({ value: `provider ${p}`, label: p }));
      }
      if (head === "tier" && tail.length === 1) {
        return [...TIER_KEYS]
          .filter((n) => n.startsWith(tail[0] ?? ""))
          .map((n) => ({ value: `tier ${n}`, label: `tier ${n}` }));
      }
      return [];
    },
    handler: async (args, ctx) => {
      const trimmed = args.trim();

      if (trimmed === "" || trimmed === "show") {
        const active = ctx.model
          ? `${ctx.model.provider}/${ctx.model.id}`
          : "(none)";
        const nicknames = Object.keys(config.nicknames);
        const lines = [
          `default provider: ${config.defaultProvider}`,
          `default tier:     ${config.defaultTier}`,
          `active model:     ${active}`,
          `providers:        ${Object.keys(config.providers).join(", ")}`,
          `nicknames:        ${nicknames.length ? nicknames.join(", ") : "(none)"}`,
        ];
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }

      if (trimmed === "reset") {
        await loadConfig();
        updateDefaultStatus(ctx);
        const resolved = resolveDefault();
        if ("error" in resolved) {
          ctx.ui.notify(`pi-switch: ${resolved.error}`, "error");
          return;
        }
        await applyModel(ctx, resolved);
        ctx.ui.notify(
          `pi-switch: reloaded config. Defaults: ${config.defaultProvider}/t${config.defaultTier}`,
          "info",
        );
        return;
      }

      const providerMatch = trimmed.match(/^provider\s+(\S+)$/);
      if (providerMatch) {
        const name = providerMatch[1]!;
        if (!config.providers[name]) {
          const known = Object.keys(config.providers).join(", ");
          ctx.ui.notify(`Unknown provider "${name}". Known: ${known}`, "error");
          return;
        }
        // Verify the current default-tier exists for the new provider before committing.
        if (
          !config.providers[name]![String(config.defaultTier) as TierKey]
        ) {
          ctx.ui.notify(
            `Provider "${name}" has no tier ${config.defaultTier} configured. ` +
              `Change tier first with /default tier <n>, or add the tier to pi-switch.json.`,
            "error",
          );
          return;
        }
        config.defaultProvider = name;
        await saveConfig();
        updateDefaultStatus(ctx);
        const resolved = resolveDefault();
        if ("error" in resolved) {
          ctx.ui.notify(`pi-switch: ${resolved.error}`, "error");
          return;
        }
        await applyModel(ctx, resolved);
        ctx.ui.notify(
          `default provider: ${name} (${resolved.modelId})`,
          "info",
        );
        return;
      }

      const tierMatch = trimmed.match(/^tier\s+([0-3])$/);
      if (tierMatch) {
        const tier = Number(tierMatch[1]) as Tier;
        if (
          !config.providers[config.defaultProvider]![String(tier) as TierKey]
        ) {
          ctx.ui.notify(
            `Provider "${config.defaultProvider}" has no tier ${tier} configured`,
            "error",
          );
          return;
        }
        config.defaultTier = tier;
        await saveConfig();
        updateDefaultStatus(ctx);
        const resolved = resolveDefault();
        if ("error" in resolved) {
          ctx.ui.notify(`pi-switch: ${resolved.error}`, "error");
          return;
        }
        await applyModel(ctx, resolved);
        ctx.ui.notify(
          `default tier: ${tier} (${resolved.provider}/${resolved.modelId})`,
          "info",
        );
        return;
      }

      ctx.ui.notify(
        "Usage:\n  /default show\n  /default provider <name>\n  /default tier <0|1|2|3>\n  /default reset",
        "error",
      );
    },
  });

  pi.registerCommand("switch", {
    description:
      "Directly switch active model without sending a message. Arg: provider/model-id or nickname",
    getArgumentCompletions: (prefix) =>
      Object.entries(config.nicknames)
        .filter(([nick]) => nick.startsWith(prefix.trim()))
        .map(([nick, target]) => ({ value: nick, label: `${nick} → ${target}` })),
    handler: async (args, ctx) => {
      const usage = "Usage: /switch <provider>/<model-id> | <nickname>";
      const spec = args.trim();
      let resolved: Resolved;
      if (spec.includes("/")) {
        const [provider, ...rest] = spec.split("/");
        const modelId = rest.join("/");
        if (!provider || !modelId) {
          ctx.ui.notify(usage, "error");
          return;
        }
        resolved = { provider, modelId };
      } else {
        const nick = spec ? resolveNickname(spec) : undefined;
        if (!nick) {
          const known = Object.keys(config.nicknames).join(", ") || "(none)";
          ctx.ui.notify(
            spec ? `Unknown nickname: "${spec}". Known: ${known}` : usage,
            "error",
          );
          return;
        }
        if ("error" in nick) {
          ctx.ui.notify(nick.error, "error");
          return;
        }
        resolved = nick;
      }
      const { provider, modelId } = resolved;
      const ok = await applyModel(ctx, { provider, modelId });
      // `/switch` is intentionally non-reverting: we leave hasActiveOverride false
      // so agent_end won't fight the user's explicit choice.
      if (ok) ctx.ui.notify(`Active model: ${provider}/${modelId}`, "info");
    },
  });
}

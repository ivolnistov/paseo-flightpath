import { describe, expect, it } from "vitest";
import { snapshotBody } from "./run-test-kit";
import { resolveSettings, type HostCatalog } from "./settings-resolve";

const catalog: HostCatalog = {
  profiles: [{ id: "coder", name: "Coder", provider: "alpha", model: "a1", thinkingOptionId: "high" }],
  providers: [
    { id: "alpha", models: ["a1", "a2"], defaultModel: "a1", supportsMcp: true },
    { id: "beta", models: ["b1"], supportsMcp: true },
    { id: "nomcp", models: null, supportsMcp: false },
  ],
};

function graphOf(agent: string, extra = ""): ReturnType<typeof snapshotBody>["graph"] {
  return snapshotBody(`
jobs:
  build:
    uses: agent
    with:
      prompt: Build it
      agent: ${agent}
    done:
      - criterion: It builds
${extra}`).graph;
}

describe("resolveSettings", () => {
  it("resolves a profile and the reviewer that inherits it, with no fallback unless written", () => {
    const result = resolveSettings(graphOf("{ profile: coder, retries: 1 }"), catalog);
    expect(result).toEqual({
      ok: true,
      settings: {
        build: {
          worker: { primary: { provider: "alpha", model: "a1", profile: "coder", reasoning: "high", thinkingOptionId: "high" }, retries: 1 },
          reviewer: { primary: { provider: "alpha", model: "a1", profile: "coder", reasoning: "high", thinkingOptionId: "high" }, retries: 1 },
        },
      },
    });
  });

  it("captures a profile's launch bundle, with options over feature values and written reasoning over its thinking option", () => {
    const bundle: HostCatalog = {
      ...catalog,
      profiles: [
        {
          id: "tuned",
          name: "Tuned",
          provider: "alpha",
          model: "a2",
          modeId: "auto",
          thinkingOptionId: "max",
          featureValues: { fast_mode: true, service_tier: "flex" },
          options: { service_tier: "priority", nested: { depth: [1, 2] } },
        },
      ],
    };
    const own = resolveSettings(graphOf("{ profile: tuned }"), bundle);
    expect(own.ok && own.settings.build?.worker?.primary).toEqual({
      provider: "alpha",
      model: "a2",
      profile: "tuned",
      modeId: "auto",
      thinkingOptionId: "max",
      options: { fast_mode: true, service_tier: "priority", nested: { depth: [1, 2] } },
    });
    const overridden = resolveSettings(graphOf("{ profile: tuned, reasoning: low }"), bundle);
    expect(overridden.ok && overridden.settings.build?.worker?.primary).toMatchObject({ reasoning: "low", thinkingOptionId: "low", modeId: "auto" });
    const broken = resolveSettings(graphOf("{ profile: tuned }"), { ...bundle, profiles: [{ id: "tuned", name: "T", provider: "alpha", options: { when: new Date(0) } }] });
    expect(new Set(broken.ok ? [] : broken.issues.map((issue) => issue.code))).toEqual(new Set(["profile_options_invalid"]));
  });

  it("resolves an explicit model with its written fallback", () => {
    const result = resolveSettings(graphOf("{ model: alpha/a2, reasoning: low, fallback: { model: beta/b1, reasoning: medium } }"), catalog);
    expect(result.ok && result.settings.build?.worker).toEqual({
      primary: { provider: "alpha", model: "a2", reasoning: "low" },
      fallback: { provider: "beta", model: "b1", reasoning: "medium" },
      retries: 2,
    });
  });

  it.each([
    ["{ profile: missing }", "profile_unknown"],
    ["{ model: alpha/zzz }", "model_unknown"],
    ["{ model: gamma/g1 }", "provider_unknown"],
    ["{ model: nomcp/any }", "provider_no_mcp"],
    ["{ model: alpha/a1, fallback: { model: beta/nope } }", "model_unknown"],
  ])("refuses %s with %s", (agent, code) => {
    const result = resolveSettings(graphOf(agent), catalog);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.map((issue) => issue.code)).toContain(code);
  });
});

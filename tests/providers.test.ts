import { describe, expect, it } from "vitest";
import { configuredProfiles, inferProvider, moveProvider, orderedProviderIds, presetProfile, providerMark, PROVIDER_ORDER, PROVIDER_PRESETS, restoreProviders, validateProviderName } from "../src/review/providers";
import { REVIEW_PERSPECTIVES, validatePerspective } from "../src/review/perspectives";
import { captureContent } from "../src/ui";

describe("supplier-first configuration", () => {
  it("ignores untouched presets while retaining edited profiles in a stable order", () => {
    const changed = { ...presetProfile("volcengine"), modelKey: "test-secret" };
    const custom = { ...presetProfile("custom_gateway"), modelName: "test-model" };
    expect(configuredProfiles({ google: presetProfile("google"), volcengine: changed, custom_gateway: custom })).toEqual({ custom_gateway: custom, volcengine: changed });
    expect(JSON.stringify(configuredProfiles({ volcengine: changed, custom_gateway: custom }))).toBe(JSON.stringify(configuredProfiles({ custom_gateway: custom, volcengine: changed })));
  });
  it("restores a complete unique order and moves built-in and custom suppliers without changing IDs", () => {
    const custom = [{ id: "custom_gateway" as const, label: "Gateway" }];
    const order = orderedProviderIds(custom, ["google", "custom_missing", "google", "custom_gateway"]);
    expect(order).toEqual(["google", "custom_gateway", ...PROVIDER_ORDER.filter(id => id !== "google")]);
    expect(moveProvider(order, "custom_gateway", "google")).toEqual(["custom_gateway", "google", ...order.slice(2)]);
    expect(moveProvider(order, "google", "custom_gateway", true)).toEqual(["custom_gateway", "google", ...order.slice(2)]);
    expect(moveProvider(order, "custom_missing", "google")).toEqual(order);
    expect(restoreProviders({ customProviders: custom, providerOrder: order }).providerOrder).toEqual(order);
    expect(orderedProviderIds([], order)).not.toContain("custom_gateway");
  });

  it("keeps Kimi API and Kimi Code as separate credential profiles", () => {
    expect(inferProvider("https://api.kimi.com/coding/")).toBe("kimi_code");
    expect(inferProvider("https://api.moonshot.cn/v1")).toBe("kimi_api");
    expect(PROVIDER_PRESETS.kimi_code.modelFormat).toBe("anthropic");
    expect(PROVIDER_PRESETS.kimi_code.modelName).toBe("kimi-for-coding");
    expect(PROVIDER_PRESETS.kimi_api.modelFormat).toBe("openai_chat");
  });

  it("recognizes current MiniMax, DeepSeek and both Kimi Code regional endpoints without rewriting saved profiles", () => {
    expect(inferProvider("https://api.minimax.cn/v1")).toBe("minimax");
    expect(inferProvider("https://api.minimaxi.com/v1")).toBe("minimax");
    expect(inferProvider("https://api.deepseek.com/v1")).toBe("deepseek");
    expect(inferProvider("https://api.kimi.ai/coding/v1")).toBe("kimi_code");
    expect(presetProfile("minimax").modelBaseUrl).toBe("https://api.minimax.cn/v1");
    expect(presetProfile("deepseek").modelFormat).toBe("openai_chat");
    const previous = { ...presetProfile("minimax"), modelBaseUrl: "https://api.minimaxi.com/v1", modelKey: "old-key" };
    expect(restoreProviders({ activeProvider: "minimax", modelProfiles: { minimax: previous } }).modelProfiles.minimax).toEqual(previous);
  });

  it("migrates an existing Kimi Code key and keeps other saved profiles", () => {
    const previous = restoreProviders({ modelBaseUrl: "https://api.kimi.com/coding/", modelFormat: "anthropic", modelKey: "old-secret", modelName: "kimi-for-coding", modelVisionCapable: true, imageReview: true });
    expect(previous.activeProvider).toBe("kimi_code");
    expect(previous.modelProfiles.kimi_code?.modelKey).toBe("old-secret");
    expect(previous.imageProvider).toBe("kimi_code");
    const switched = restoreProviders({ ...previous, modelProfiles: { ...previous.modelProfiles, zhipu: { modelFormat: "openai_chat", modelBaseUrl: PROVIDER_PRESETS.zhipu.modelBaseUrl, modelKey: "other-secret", modelName: "glm", modelVisionCapable: false } } });
    expect(switched.modelProfiles.kimi_code?.modelKey).toBe("old-secret");
    expect(switched.modelProfiles.zhipu?.modelKey).toBe("other-secret");
  });

  it("migrates the old custom profile without losing credentials or image selection", () => {
    const profile = { modelFormat: "openai_chat" as const, modelBaseUrl: "https://gateway.example/v1", modelKey: "legacy-secret", modelName: "vision", modelVisionCapable: true };
    const restored = restoreProviders({ activeProvider: "custom", modelProfiles: { custom: profile }, imageProvider: "custom", ...profile });
    expect(restored.customProviders).toEqual([{ id: "custom", label: "自定义" }]);
    expect(restored.modelProfiles.custom).toEqual(profile);
    expect(restored.imageProvider).toBe("custom");
    const again = restoreProviders(restored);
    expect(again).toEqual(restored);
  });

  it("restores named providers and drops references to removed providers", () => {
    const profile = { modelFormat: "anthropic" as const, modelBaseUrl: "https://gateway.example", modelKey: "secret", modelName: "model", modelVisionCapable: true };
    const restored = restoreProviders({ activeProvider: "custom_test", customProviders: [{ id: "custom_test", label: "My Gateway" }], modelProfiles: { custom_test: profile }, imageProvider: "custom_missing" });
    expect(restored.activeProvider).toBe("custom_test");
    expect(restored.modelKey).toBe("secret");
    expect(restored.imageProvider).toBe("");
    expect(providerMark("custom_test", "my gateway")).toBe("MY");
    expect(validateProviderName(" new ", restored.customProviders)).toBe("new");
    expect(() => validateProviderName("my gateway", restored.customProviders)).toThrow("已存在");
    expect(() => validateProviderName("Kimi API", [])).toThrow("已存在");
  });

  it("shows supplier presets and text template editing without the SiYuan AI option", () => {
    const content = captureContent();
    expect(content).toContain('data-field="modelProvider"');
    expect(content).toContain('data-field="imageProvider"');
    expect(content).toContain('data-field="templateEditor"');
    expect(content).toContain('data-role="providerList"');
    expect(content).not.toContain("使用思源已配置的 AI");
    expect(content).not.toContain("可视化格式");
  });

  it("treats article format as natural-language guidance", () => {
    const base = REVIEW_PERSPECTIVES.original;
    expect(validatePerspective(base)).toBeUndefined();
    expect(validatePerspective({ ...base, template: "不要摘要，按要点组织内容，最后总结。" })).toBeUndefined();
    expect(() => validatePerspective({ ...base, template: "" })).toThrow("文章格式要求");
    expect(base.template).toContain("---\n\n## AI 摘要");
    expect(base.template).toContain("---\n\n## 正文");
    expect(REVIEW_PERSPECTIVES.novice.template).toContain("## 阅读前准备");
    expect(base.template).not.toContain("{{");
    const content = captureContent();
    expect(content).not.toContain("套用要点式范例");
    expect(content).not.toContain("占位符规则");
    expect(content).not.toContain("直接写希望 AI 生成的文章结构");
    expect(content).not.toContain("AI 会按这里的要求生成 Markdown");
  });
});

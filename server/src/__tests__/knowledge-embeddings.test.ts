import { describe, expect, it } from "vitest";
import {
  chunkText,
  deterministicEmbeddingProvider,
  dotProduct,
  normalize,
  resolveEmbeddingProvider,
} from "../services/knowledge-embeddings.js";

describe("knowledge embeddings(JIN-55)", () => {
  it("向量落库前就是单位向量 —— 所以检索期的余弦退化成点积", async () => {
    const provider = deterministicEmbeddingProvider();
    const [vector] = await provider.embed(["离婚财产分割案例"]);
    const magnitude = Math.sqrt(vector!.reduce((sum, value) => sum + value * value, 0));
    expect(magnitude).toBeCloseTo(1, 5);
  });

  it("确定性:同样的文本永远同样的向量(测试才测得干净)", async () => {
    const provider = deterministicEmbeddingProvider();
    const [a] = await provider.embed(["高净值客户开头模板"]);
    const [b] = await provider.embed(["高净值客户开头模板"]);
    expect(a).toEqual(b);
  });

  it("字面重合越多,分数越高", async () => {
    const provider = deterministicEmbeddingProvider();
    const [query, near, far] = await provider.embed([
      "离婚财产分割",
      "离婚财产分割的实务要点",
      "短视频拍摄的灯光布置",
    ]);
    expect(dotProduct(query!, near!)).toBeGreaterThan(dotProduct(query!, far!));
  });

  it("维度不一致判 0 分,不抛 —— 换过 embedding 模型后,一条旧向量不该炸掉整次检索", () => {
    expect(dotProduct([1, 0, 0], [1, 0])).toBe(0);
  });

  it("零向量不产生 NaN", () => {
    expect(normalize([0, 0, 0])).toEqual([0, 0, 0]);
  });

  it("切片带重叠,不把一句话切断在边界上", () => {
    const text = "甲".repeat(1200);
    const chunks = chunkText(text, 500, 80);
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks[0]!.length).toBe(500);
    // 相邻切片有重叠 → 总字数一定大于原文
    expect(chunks.reduce((sum, chunk) => sum + chunk.length, 0)).toBeGreaterThan(text.length);
  });

  it("短文本只出一个切片;空文本不出切片", () => {
    expect(chunkText("禁用表达清单")).toEqual(["禁用表达清单"]);
    expect(chunkText("   ")).toEqual([]);
  });

  it("有 GLM key 就走 GLM 原生端点;没 key 退到 deterministic —— 且绝不硬编码 key", () => {
    const withKey = resolveEmbeddingProvider({
      GLM_OPENAI_BASE_URL: "https://open.bigmodel.cn/api/paas/v4",
      GLM_OPENAI_API_KEY: "test-key-not-real",
    });
    expect(withKey.name).toBe("glm");
    expect(withKey.model).toBe("embedding-3");

    // 没配 key 的开发者也该能把知识库跑起来,只是检索质量退化成「字面重合」。
    // provider.name 会如实暴露这一点,不假装自己用的是真模型。
    const withoutKey = resolveEmbeddingProvider({});
    expect(withoutKey.name).toBe("deterministic");
  });
});

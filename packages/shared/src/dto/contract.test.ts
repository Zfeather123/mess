import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { buildContractSchemas, findContractBreaks } from "./contract.js";
import { toJsonSchema, type JsonSchema } from "./json-schema.js";
import { agentFeedbackNoteDto } from "./agent-feedback-note.js";
import { squadDto, squadMemberDto } from "./squad.js";

const baseline = JSON.parse(
  readFileSync(new URL("./api-contract.baseline.json", import.meta.url), "utf8"),
) as Record<string, JsonSchema>;

/**
 * 这个文件就是那道闸门。
 *
 * 「后端改了响应形状、前端没跟上」在此之前是**静默**的:前端读到 undefined,页面少块东西,
 * 没有任何测试会红。现在它会红。
 */
describe("API 契约闸门", () => {
  it("当前 DTO 必须与冻结的契约基线向后兼容", () => {
    const breaks = findContractBreaks(baseline, buildContractSchemas());

    // 这条红了,说明你删了 / 改名了 / 改类型了某个**对外**字段。
    // 想清楚前端会怎么静默拿错东西;确实要改就 pnpm contract:accept-breaking,
    // 让基线的 diff 进 PR,给 reviewer 看见。
    expect(breaks).toEqual([]);
  });

  it("契约里登记的四条对外资源都在", () => {
    expect(Object.keys(buildContractSchemas()).sort()).toEqual([
      "AgentFeedbackNote",
      "Squad",
      "SquadDispatch",
      "SquadMember",
    ]);
  });
});

describe("破坏性判定(消费者视角)", () => {
  const base: Record<string, JsonSchema> = {
    Squad: {
      type: "object",
      properties: {
        id: { type: "string", format: "uuid" },
        name: { type: "string" },
        status: { type: "string", enum: ["active", "archived"] },
      },
      required: ["id", "name", "status"],
      additionalProperties: false,
    },
  };

  it("加字段不算破坏 —— 后端加一列不该逼前端改代码", () => {
    const current: Record<string, JsonSchema> = {
      Squad: {
        ...base.Squad!,
        properties: { ...base.Squad!.properties, motto: { type: "string" } },
        required: [...base.Squad!.required!, "motto"],
      },
    };
    expect(findContractBreaks(base, current)).toEqual([]);
  });

  it("枚举加取值不算破坏(老前端最多不认识,不会解析错)", () => {
    const current: Record<string, JsonSchema> = {
      Squad: {
        ...base.Squad!,
        properties: {
          ...base.Squad!.properties,
          status: { type: "string", enum: ["active", "archived", "paused"] },
        },
      },
    };
    expect(findContractBreaks(base, current)).toEqual([]);
  });

  it("字段改名 = 删一个 + 加一个 —— 删的那个必须红", () => {
    const current: Record<string, JsonSchema> = {
      Squad: {
        ...base.Squad!,
        properties: {
          id: { type: "string", format: "uuid" },
          title: { type: "string" }, // name → title
          status: { type: "string", enum: ["active", "archived"] },
        },
        required: ["id", "title", "status"],
      },
    };
    const breaks = findContractBreaks(base, current);
    expect(breaks).toHaveLength(1);
    expect(breaks[0]).toMatchObject({ schema: "Squad", field: "name", kind: "field_removed" });
  });

  it("改类型必须红(前端会按老类型解析)", () => {
    const current: Record<string, JsonSchema> = {
      Squad: {
        ...base.Squad!,
        properties: { ...base.Squad!.properties, id: { type: "integer" } },
      },
    };
    expect(findContractBreaks(base, current)[0]).toMatchObject({
      field: "id",
      kind: "type_changed",
    });
  });

  it("枚举减取值必须红(前端正在处理的取值消失了)", () => {
    const current: Record<string, JsonSchema> = {
      Squad: {
        ...base.Squad!,
        properties: {
          ...base.Squad!.properties,
          status: { type: "string", enum: ["active"] },
        },
      },
    };
    expect(findContractBreaks(base, current)[0]).toMatchObject({
      field: "status",
      kind: "type_changed",
    });
  });

  it("必填变可选必须红(前端没写 undefined 分支)", () => {
    const current: Record<string, JsonSchema> = {
      Squad: { ...base.Squad!, required: ["id", "status"] },
    };
    expect(findContractBreaks(base, current)[0]).toMatchObject({
      field: "name",
      kind: "became_optional",
    });
  });

  it("整个资源消失必须红", () => {
    expect(findContractBreaks(base, {})[0]).toMatchObject({ kind: "schema_removed" });
  });
});

describe("DTO 形状", () => {
  it("响应契约一律 strict —— 契约里没有的字段,线上不该有", () => {
    for (const dto of [squadDto, squadMemberDto, agentFeedbackNoteDto]) {
      expect(toJsonSchema(dto).additionalProperties).toBe(false);
    }
  });

  it("裸表行喂进 DTO 会被拒:未声明的列不许出线", () => {
    const row = {
      id: "3f1a0c34-1f1e-4a5f-9c1a-2b7d9f0e1a11",
      companyId: "3f1a0c34-1f1e-4a5f-9c1a-2b7d9f0e1a12",
      projectId: null,
      name: "普法一队",
      description: null,
      leaderAgentId: null,
      douyinAccountId: null,
      status: "active",
      dispatchPolicy: {},
      metadata: {},
      createdAt: "2026-07-15T00:00:00.000Z",
      updatedAt: "2026-07-15T00:00:00.000Z",
      // 明天某个 agent 往 squads 表加的列。裸表行直出 = 它自动变成对外契约。
      internalRoutingSecret: "不该出线的东西",
    };

    const parsed = squadDto.safeParse(row);
    expect(parsed.success).toBe(false);
  });

  it("时间戳出线是 ISO 字符串,不是 Date", () => {
    const result = squadDto.shape.createdAt.safeParse(new Date());
    expect(result.success).toBe(false);
    expect(squadDto.shape.createdAt.safeParse("2026-07-15T00:00:00.000Z").success).toBe(true);
  });

  it("DTO 只许用受支持的原语 —— 生成器认不出就抛,不静默降级", () => {
    const smuggled = z.object({ weird: z.union([z.string(), z.number()]) });
    expect(() => toJsonSchema(smuggled)).toThrow(/DTO 词汇表不认识/);
  });
});

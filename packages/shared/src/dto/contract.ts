import type { z } from "zod";
import {
  accountProfileDto,
  douyinAccountDto,
  douyinSyncResultDto,
  profileFactWriteResultDto,
  profileGuidanceDto,
  profileGuidanceItemDto,
  profileSyncSourceDto,
} from "./account-profile.js";
import { agentFeedbackNoteDto } from "./agent-feedback-note.js";
import {
  todayTaskDto,
  todayTaskIssueDto,
  todayTaskOpenApprovalDto,
  todayTaskPageDto,
  todayTaskProgressDto,
  todayTaskSummaryDto,
} from "./today-task.js";
import { toJsonSchema, type JsonSchema } from "./json-schema.js";
import { squadDispatchDto, squadDto, squadMemberDto } from "./squad.js";

/**
 * 对外响应契约的登记处。
 *
 * 想让一条路由「有契约」,就把它的 DTO 登记在这里 —— 登记之后它自动获得三样东西:
 *   1. OpenAPI:`server/src/routes/openapi.ts` 把这些 DTO 注册成 components,
 *      并挂到对应路由的响应上(前端据 `/api/openapi` 对接)
 *   2. 破坏性变更闸门:对着 `api-contract.baseline.json` 比,删 / 改名 / 改类型 → 红
 *   3. 运行时形状断言:路由测试里 strict-parse 真实响应体
 */
export const API_CONTRACT_SCHEMAS = {
  Squad: squadDto,
  SquadMember: squadMemberDto,
  SquadDispatch: squadDispatchDto,
  AgentFeedbackNote: agentFeedbackNoteDto,
  // ---- 账号档案 / TikHub 同步(JIN-54)----
  AccountProfile: accountProfileDto,
  DouyinAccount: douyinAccountDto,
  ProfileSyncSource: profileSyncSourceDto,
  ProfileGuidance: profileGuidanceDto,
  ProfileGuidanceItem: profileGuidanceItemDto,
  DouyinSyncResult: douyinSyncResultDto,
  ProfileFactWriteResult: profileFactWriteResultDto,
  // ---- 今日任务(JIN-54)----
  TodayTask: todayTaskDto,
  TodayTaskIssue: todayTaskIssueDto,
  TodayTaskOpenApproval: todayTaskOpenApprovalDto,
  TodayTaskProgress: todayTaskProgressDto,
  TodayTaskPage: todayTaskPageDto,
  TodayTaskSummary: todayTaskSummaryDto,
} as const satisfies Record<string, z.ZodTypeAny>;

export type ApiContractSchemaName = keyof typeof API_CONTRACT_SCHEMAS;

export function buildContractSchemas(): Record<string, JsonSchema> {
  const out: Record<string, JsonSchema> = {};
  for (const [name, schema] of Object.entries(API_CONTRACT_SCHEMAS)) {
    out[name] = toJsonSchema(schema);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 破坏性变更闸门
 * ------------------------------------------------------------------ */

export type ContractBreak = {
  schema: string;
  field?: string;
  kind: "schema_removed" | "field_removed" | "type_changed" | "became_optional";
  detail: string;
};

function describe(schema: JsonSchema | undefined): string {
  return JSON.stringify(schema ?? null);
}

/**
 * 「当前 DTO」相对「基线契约」是否向后兼容。
 *
 * 消费者视角判定 —— 只有**前端会静默拿错东西**的改动才算破坏:
 *   - 删 schema / 删字段        → 破坏(前端读到 undefined)
 *   - 改类型、改 format、缩枚举 → 破坏(前端按老类型解析)
 *   - 必填变可选               → 破坏(前端没做 undefined 分支)
 *   - **加字段 → 不破坏**       ← 这正是本条 issue 要的:后端加列不该逼前端改代码
 *
 * 枚举「加值」也不判红(服务端多发一种 state,老前端最多不认识,不会解析错)。
 * 枚举「减值」会被 `type_changed` 抓到 —— 深比较扛的就是这个。
 */
export function findContractBreaks(
  baseline: Record<string, JsonSchema>,
  current: Record<string, JsonSchema>,
): ContractBreak[] {
  const breaks: ContractBreak[] = [];

  for (const [name, baseSchema] of Object.entries(baseline)) {
    const currentSchema = current[name];
    if (!currentSchema) {
      breaks.push({
        schema: name,
        kind: "schema_removed",
        detail: `契约里的 ${name} 没了 —— 前端还在按它解析响应`,
      });
      continue;
    }

    const baseProps = baseSchema.properties ?? {};
    const currentProps = currentSchema.properties ?? {};
    const baseRequired = new Set(baseSchema.required ?? []);
    const currentRequired = new Set(currentSchema.required ?? []);

    for (const [field, baseField] of Object.entries(baseProps)) {
      const currentField = currentProps[field];
      if (!currentField) {
        breaks.push({
          schema: name,
          field,
          kind: "field_removed",
          detail: `${name}.${field} 被删了或改了名 —— 前端会静默读到 undefined`,
        });
        continue;
      }
      if (!isTypeCompatible(baseField, currentField)) {
        breaks.push({
          schema: name,
          field,
          kind: "type_changed",
          detail: `${name}.${field} 类型变了:${describe(baseField)} → ${describe(currentField)}`,
        });
      }
      if (baseRequired.has(field) && !currentRequired.has(field)) {
        breaks.push({
          schema: name,
          field,
          kind: "became_optional",
          detail: `${name}.${field} 从必填变成可选 —— 前端没有 undefined 分支`,
        });
      }
    }
  }

  return breaks;
}

/**
 * 字段级兼容:类型/format 必须一致;枚举只许加值,不许减值(减值 = 前端已经在处理的取值消失了)。
 */
function isTypeCompatible(base: JsonSchema, current: JsonSchema): boolean {
  const baseTypes = JSON.stringify(normalizeType(base.type));
  const currentTypes = JSON.stringify(normalizeType(current.type));
  if (baseTypes !== currentTypes) return false;
  if (base.format !== current.format) return false;

  if (base.enum) {
    if (!current.enum) return false;
    const currentValues = new Set(current.enum);
    if (!base.enum.every((value) => currentValues.has(value))) return false;
  }

  if (base.items || current.items) {
    if (!base.items || !current.items) return false;
    if (!isTypeCompatible(base.items, current.items)) return false;
  }

  return true;
}

function normalizeType(type: JsonSchema["type"]): string[] {
  if (type === undefined) return [];
  return (Array.isArray(type) ? [...type] : [type]).sort();
}

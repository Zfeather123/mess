import { z } from "zod";

/**
 * Zod → JSON Schema(2020-12,OpenAPI 3.1 直接可用)。
 *
 * 为什么手写而不是装 `zod-to-json-schema`:zod 还是 3.x(没有原生 `z.toJSONSchema`),
 * 而这层只需要认 `primitives.ts` 那几个原语。为了这点面积拉一个依赖进 lock 文件不划算 ——
 * 而且**认不出的类型直接抛错**才是我们要的:它逼着响应契约留在那个窄词汇表里,
 * 而不是有人往 DTO 里塞了个 `z.union` / `z.lazy`,生成器悄悄降级成 `{}`,OpenAPI 变成一句废话。
 */

export type JsonSchema = {
  type?: string | string[];
  format?: string;
  enum?: readonly string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
};

class UnsupportedDtoTypeError extends Error {
  constructor(typeName: string, path: string) {
    super(
      `DTO 词汇表不认识 ${typeName}(位置:${path || "<root>"})。` +
        `响应契约请只用 packages/shared/src/dto/primitives.ts 里的原语;` +
        `确实需要新原语时,先在这里加一条 case,别让生成器静默降级。`,
    );
    this.name = "UnsupportedDtoTypeError";
  }
}

/** `type: "string"` + nullable → `type: ["string", "null"]`(JSON Schema 2020-12 的写法) */
function withNull(schema: JsonSchema): JsonSchema {
  if (schema.type === undefined) return schema;
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types.includes("null")) return schema;
  return { ...schema, type: [...types, "null"] };
}

function stringFormat(def: z.ZodStringDef): string | undefined {
  for (const check of def.checks) {
    if (check.kind === "uuid") return "uuid";
    if (check.kind === "datetime") return "date-time";
  }
  return undefined;
}

export function toJsonSchema(schema: z.ZodTypeAny, path = ""): JsonSchema {
  const def = schema._def as { typeName: z.ZodFirstPartyTypeKind } & Record<string, unknown>;

  switch (def.typeName) {
    case z.ZodFirstPartyTypeKind.ZodString: {
      const format = stringFormat(def as unknown as z.ZodStringDef);
      return format ? { type: "string", format } : { type: "string" };
    }
    case z.ZodFirstPartyTypeKind.ZodNumber: {
      const isInt = (def as unknown as z.ZodNumberDef).checks.some(
        (check) => check.kind === "int",
      );
      return { type: isInt ? "integer" : "number" };
    }
    case z.ZodFirstPartyTypeKind.ZodBoolean:
      return { type: "boolean" };
    case z.ZodFirstPartyTypeKind.ZodEnum:
      return { type: "string", enum: [...(def.values as readonly string[])] };
    case z.ZodFirstPartyTypeKind.ZodNullable:
      return withNull(toJsonSchema(def.innerType as z.ZodTypeAny, path));
    case z.ZodFirstPartyTypeKind.ZodOptional:
      return toJsonSchema(def.innerType as z.ZodTypeAny, path);
    case z.ZodFirstPartyTypeKind.ZodArray:
      return { type: "array", items: toJsonSchema(def.type as z.ZodTypeAny, `${path}[]`) };
    case z.ZodFirstPartyTypeKind.ZodRecord:
      // jsonb 口袋:值的形状由执行层解释,契约只保证「是个对象」
      return { type: "object", additionalProperties: true };
    case z.ZodFirstPartyTypeKind.ZodUnknown:
    case z.ZodFirstPartyTypeKind.ZodAny:
      return {};
    case z.ZodFirstPartyTypeKind.ZodObject: {
      const shape = (schema as z.ZodObject<z.ZodRawShape>).shape;
      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(shape) as [string, z.ZodTypeAny][]) {
        properties[key] = toJsonSchema(value, path ? `${path}.${key}` : key);
        if (!value.isOptional()) required.push(key);
      }
      return {
        type: "object",
        properties,
        required,
        // DTO 一律 .strict():契约说没有的字段,线上就不该有
        additionalProperties: (def.unknownKeys as string) !== "strip" ? false : true,
      };
    }
    default:
      throw new UnsupportedDtoTypeError(String(def.typeName), path);
  }
}

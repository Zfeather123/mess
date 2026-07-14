import { z } from "zod";

/**
 * DTO 词汇表(响应契约只许用这里的原语)。
 *
 * 刻意窄:每多一种类型,`toJsonSchema()` 就要多认一种,OpenAPI 就多一条可能出错的边。
 * 想不出怎么用这些原语表达某个响应字段时,通常说明那个字段本来就不该对外发。
 */

/** 主键 / 外键:线上一律 uuid 字符串。 */
export const dtoUuid = () => z.string().uuid();

/** better-auth 的 user id 是裸 text(见 squad_members.user_id 注释),不是 uuid。 */
export const dtoUserId = () => z.string();

/** 时间戳一律 ISO-8601 字符串出线。DB 里是 Date —— 由 mapper 负责转,契约里不许出现 Date。 */
export const dtoTimestamp = () => z.string().datetime({ offset: true });

/** jsonb 口袋(dispatchPolicy / metadata):形状由执行层解释,契约只保证「是个对象」。 */
export const dtoJsonObject = () => z.record(z.unknown());

/**
 * Date | string → ISO 字符串。
 *
 * drizzle 给回 Date,而 `res.json()` 恰好也会把 Date 序列化成 ISO —— 正因为「恰好一样」,
 * 裸表行直出时这层转换是隐式的、没人声明过的。mapper 里显式转一次,契约里 `dtoTimestamp` 显式声明一次,
 * 从此「线上是 ISO 字符串」是被测试钉住的事实,不是 JSON.stringify 的副作用。
 */
export function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

export function toIsoOrNull(value: Date | string | null | undefined): string | null {
  return value === null || value === undefined ? null : toIso(value);
}

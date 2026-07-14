/**
 * 账号档案字段规格(PROFILE_FIELD_SPEC)—— 完整度的**分母**。
 *
 * 0148 的 account_profiles.spec_version 注释里写死了这个契约:
 *   「字段规格版本:完整度分母来自代码里的 PROFILE_FIELD_SPEC[specVersion]」
 * 这里把它兑现。
 *
 * 为什么分母在代码里而不在库里:
 *   完整度 = 已填权重 / 规格总权重。如果分母存在库里,每加一个字段就要写迁移回填,
 *   而且历史档案的完整度会被**追溯改写**(昨天 100% 今天变 80%,用户会以为数据丢了)。
 *   放在代码里 + 档案行上记 spec_version:老档案继续按 v1 算,新档案按 v2 算,
 *   什么时候升版是一次显式的、可控的动作,不是加个字段的副作用。
 *
 * 权重不是拍脑袋:positioning / target_audience 各占 20 —— 这两项是所有 AI 员工写内容时
 * 的第一上下文,缺了它们,文案编导只能写「泛法律科普」,这正是产品要解决的问题。
 * banned_expressions 占 10 且 required:它是合规审稿员的硬约束来源,缺了就等于没有合规红线。
 */

export const PROFILE_SPEC_VERSION_V1 = "v1" as const;

/** 事实来源,与 account_profile_facts.source 的 CHECK 约束逐字对齐 */
export const PROFILE_FACT_SOURCES = ["user", "resume", "tikhub", "history_content", "agent_inference"] as const;
export type ProfileFactSource = (typeof PROFILE_FACT_SOURCES)[number];

/**
 * 来源优先级:用户手填 > 简历 > TikHub 实测 > 历史文案推断 > 模型推断。
 * 与 0148 的表注释逐字一致(user=100 > resume=80 > tikhub=60 > history_content=40 > agent_inference=10)。
 *
 * 这是**冲突消解**的唯一依据:模型推断出「离婚律师」,用户手填「股权律师」,用户赢,
 * 且模型那条不是被删掉、而是被 superseded —— 证据链留着,以后能回答「凭什么覆盖」。
 */
export const PROFILE_SOURCE_PRIORITY: Record<ProfileFactSource, number> = {
  user: 100,
  resume: 80,
  tikhub: 60,
  history_content: 40,
  agent_inference: 10,
};

export type ProfileFieldValueType = "string" | "string_array" | "object_array" | "number";

export type ProfileFieldGroup = "basic" | "positioning" | "expression" | "method";

export interface ProfileFieldSpec {
  readonly key: string;
  readonly label: string;
  readonly group: ProfileFieldGroup;
  readonly valueType: ProfileFieldValueType;
  /** 完整度权重。v1 的总和刚好 100,但公式一律按 总权重 归一,加字段不会静默算错 */
  readonly weight: number;
  /** required=false 的字段不计入「缺失引导」的必答项,但仍计入完整度分母 */
  readonly required: boolean;
  /** 哪些来源能自动填这个字段 —— 决定「重新同步」能补掉哪些空,以及哪些只能问用户 */
  readonly autoFillableFrom: readonly ProfileFactSource[];
  /** 缺失时,档案管家拿这句去问用户(原型:「缺失信息引导补全」) */
  readonly guidance: string;
  /** 用户说「不会填,帮我诊断一下」时,诊断师按这条策略去推断 */
  readonly diagnosisStrategy: string;
}

export const PROFILE_FIELD_SPEC_V1: readonly ProfileFieldSpec[] = [
  // ---- 账号定位:所有 AI 员工的第一上下文,权重最高 ----
  {
    key: "positioning",
    label: "账号定位",
    group: "positioning",
    valueType: "string",
    weight: 20,
    required: true,
    autoFillableFrom: ["user", "agent_inference"],
    guidance: "你的账号想让人一眼记住你是「哪一类律师」?例如「高净值离婚财产分割律师」——越具体越好,「专业律师」等于没定位。",
    diagnosisStrategy:
      "读 douyin_accounts.signature + 近 20 条作品的 description/hashtags,找反复出现的案件类型与人群词,聚合成一句「面向 X 人群的 Y 类律师」,以 agent_inference 落库(优先级最低,用户一改就被覆盖)。",
  },
  {
    key: "target_audience",
    label: "目标客户",
    group: "positioning",
    valueType: "string_array",
    weight: 20,
    required: true,
    autoFillableFrom: ["user", "agent_inference"],
    guidance: "你最想成交的是谁?例如「公司老板 / 高净值家庭 / 股权房产纠纷当事人」。写你想要的客户,不是所有可能的客户。",
    diagnosisStrategy:
      "TikHub 拿不到人口学画像(见 TIKHUB_CAPABILITIES.md §5),改用**评论语义**:抓 Top 作品的评论,聚类咨询意图(「离婚怎么分财产」「能加微信吗」),反推真实来问的人是谁。这是本产品最有价值且完全合法可得的受众信号。",
  },
  {
    key: "practice_areas",
    label: "业务领域",
    group: "basic",
    valueType: "string_array",
    weight: 15,
    required: true,
    autoFillableFrom: ["user", "resume", "history_content", "agent_inference"],
    guidance: "你实际接的案子集中在哪几类?(如 婚姻家事 / 股权纠纷 / 房产继承)",
    diagnosisStrategy: "从简历的执业领域字段;无简历则从作品 hashtags + description 里的案由词统计词频取 Top 3。",
  },

  // ---- 表达偏好 / 禁用表达:文案编导与合规审稿员的直接输入 ----
  {
    key: "tone_preferences",
    label: "表达偏好",
    group: "expression",
    valueType: "string_array",
    weight: 10,
    required: true,
    autoFillableFrom: ["user", "history_content", "agent_inference"],
    guidance: "你希望内容听起来像什么?例如「更像律师说人话」「开头先给具体身份+风险场景」「结尾给一条明确建议」。",
    diagnosisStrategy: "从历史文案里互动最好的几条,提炼共同的开头结构、句长、称呼方式,作为 history_content 事实。",
  },
  {
    key: "banned_expressions",
    label: "禁用表达",
    group: "expression",
    valueType: "string_array",
    weight: 10,
    required: true,
    autoFillableFrom: ["user"],
    guidance: "有哪些话你绝对不说?(如 夸大承诺、绝对化结果「一定赢」、情绪营销词)——这条会成为合规审稿员的硬红线。",
    diagnosisStrategy:
      "**不自动推断**。这是合规红线,只接受用户手填(autoFillableFrom 只有 user)。可以给出律师广告合规的默认建议清单让用户勾选,但必须由用户确认后以 source=user 落库 —— 模型替律师承诺「不会说什么」是不可接受的风险。",
  },

  // ---- 基础资料:权重低,但缺了会让内容失去在地性与可信度 ----
  {
    key: "city",
    label: "执业城市",
    group: "basic",
    valueType: "string",
    weight: 5,
    required: true,
    autoFillableFrom: ["user", "resume", "tikhub"],
    guidance: "你主要在哪个城市执业?(涉及地域管辖与本地化选题)",
    diagnosisStrategy: "TikHub 的 ip_location(IP 属地)可作弱信号(用户可能在外地刷)。简历里的执业地更可信。",
  },
  {
    key: "law_firm",
    label: "所属律所",
    group: "basic",
    valueType: "string",
    weight: 5,
    required: true,
    autoFillableFrom: ["user", "resume", "tikhub"],
    guidance: "你所在的律所全称?",
    diagnosisStrategy:
      "TikHub 的 custom_verify(个人认证)常年就是「XX律所律师」——这是**认证过的**字段,可信度高于签名里的自述,优先用它。",
  },
  {
    key: "years_of_practice",
    label: "执业年限",
    group: "basic",
    valueType: "number",
    weight: 5,
    required: true,
    autoFillableFrom: ["user", "resume"],
    guidance: "执业多少年了?(内容里的「从业 X 年」需要它,写错了会翻车)",
    diagnosisStrategy: "只从简历的执业起始年份推算。**不从视频文案里猜** —— 说错年限是硬伤。",
  },

  // ---- 有效方法:从历史效果提炼,非用户手填,不设为 required ----
  {
    key: "effective_methods",
    label: "有效方法",
    group: "method",
    valueType: "object_array",
    weight: 10,
    required: false,
    autoFillableFrom: ["history_content", "agent_inference"],
    guidance: "(无需手填)系统会从你历史内容的实际效果里提炼「什么写法对你有效」。",
    diagnosisStrategy:
      "取该账号互动表现 Top N 的作品,与中位数作品对比,提炼差异化写法;每条方法的 evidence_ref 必须指回具体 aweme_id —— 「有效」是有证据的断言,不是形容词。⚠️ 播放量必须来自专用统计接口(见 TIKHUB_CAPABILITIES.md §4.1),列表里的 play_count 不可信,拿它排序会把没拉到数据的作品误判成扑街。",
  },
];

export const PROFILE_FIELD_SPECS: Record<string, readonly ProfileFieldSpec[]> = {
  [PROFILE_SPEC_VERSION_V1]: PROFILE_FIELD_SPEC_V1,
};

export function getProfileFieldSpec(specVersion: string): readonly ProfileFieldSpec[] {
  const spec = PROFILE_FIELD_SPECS[specVersion];
  if (!spec) {
    throw new Error(
      `Unknown profile spec version: ${specVersion}. Known: ${Object.keys(PROFILE_FIELD_SPECS).join(", ")}`,
    );
  }
  return spec;
}

/**
 * 一条事实的值算不算「填了」。
 *
 * 空字符串、空数组、空对象都**不算** —— 事实行存在 ≠ 字段有内容。
 * 少了这一层,「同步跑过但什么都没拉到」会写进一堆空事实,把完整度刷成 100%,
 * 用户看到满格却发现 AI 还是不懂他的账号。这是最容易骗过自己的一种 bug。
 */
export function isProfileValueFilled(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.some((item) => isProfileValueFilled(item));
  if (typeof value === "object") return Object.keys(value as Record<string, unknown>).length > 0;
  return false;
}

export interface ProfileCompleteness {
  readonly completenessPct: number;
  /** 缺失字段 key,按权重降序 —— UI 与档案管家都按这个顺序引导补全,先问最要紧的 */
  readonly missingFields: readonly string[];
  readonly filledFields: readonly string[];
  /** 缺失且 required 的字段,是「引导补全」的必答项 */
  readonly missingRequiredFields: readonly string[];
}

/**
 * 完整度 = 已填权重 / 规格总权重。
 *
 * 传入的 values 是「每个 field_key 的当前生效事实值」(active fact),
 * 由调用方从 account_profile_facts 里按 status='active' 取出。
 */
export function computeProfileCompleteness(
  values: Readonly<Record<string, unknown>>,
  specVersion: string = PROFILE_SPEC_VERSION_V1,
): ProfileCompleteness {
  const spec = getProfileFieldSpec(specVersion);
  const totalWeight = spec.reduce((sum, field) => sum + field.weight, 0);

  const filled: ProfileFieldSpec[] = [];
  const missing: ProfileFieldSpec[] = [];
  for (const field of spec) {
    if (isProfileValueFilled(values[field.key])) filled.push(field);
    else missing.push(field);
  }

  const filledWeight = filled.reduce((sum, field) => sum + field.weight, 0);
  // totalWeight 恒 > 0(规格非空),但除零保护留着 —— 以后有人加了个空规格版本不会炸成 NaN
  const completenessPct = totalWeight > 0 ? Math.round((filledWeight / totalWeight) * 100) : 0;

  const byWeightDesc = (a: ProfileFieldSpec, b: ProfileFieldSpec) => b.weight - a.weight || a.key.localeCompare(b.key);

  return {
    completenessPct,
    missingFields: [...missing].sort(byWeightDesc).map((f) => f.key),
    filledFields: filled.map((f) => f.key),
    missingRequiredFields: [...missing]
      .filter((f) => f.required)
      .sort(byWeightDesc)
      .map((f) => f.key),
  };
}

/**
 * 「缺失信息引导补全」:把缺失字段变成一串可以直接发进群聊的问题。
 *
 * canAutoFill 决定 UI 分两栏:能同步的(「重新同步全部来源」按钮能补掉)
 * vs 只能问你的(必须用户开口)。banned_expressions 永远在后一栏 —— 合规红线不能由模型代填。
 */
export interface ProfileGuidanceItem {
  readonly fieldKey: string;
  readonly label: string;
  readonly weight: number;
  readonly required: boolean;
  readonly question: string;
  readonly canAutoFill: boolean;
  readonly autoFillableFrom: readonly ProfileFactSource[];
  readonly diagnosisStrategy: string;
}

export function buildProfileGuidance(
  missingFields: readonly string[],
  specVersion: string = PROFILE_SPEC_VERSION_V1,
): readonly ProfileGuidanceItem[] {
  const spec = getProfileFieldSpec(specVersion);
  const byKey = new Map(spec.map((f) => [f.key, f]));

  return missingFields
    .map((key) => byKey.get(key))
    .filter((f): f is ProfileFieldSpec => Boolean(f))
    .map((field) => ({
      fieldKey: field.key,
      label: field.label,
      weight: field.weight,
      required: field.required,
      question: field.guidance,
      // 只有 user 一个来源 = 无论怎么同步都补不上,必须问用户
      canAutoFill: field.autoFillableFrom.some((source) => source !== "user"),
      autoFillableFrom: field.autoFillableFrom,
      diagnosisStrategy: field.diagnosisStrategy,
    }));
}

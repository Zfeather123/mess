import { createHash, randomUUID } from "node:crypto";
import { and, eq, desc } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentTemplates, companies } from "@paperclipai/db";
import type {
  AgentTemplateVisibility,
  CreateAgentTemplate,
  CreateAgentTemplateFromAgent,
  CreateEmployeeHire,
  EmployeeCard,
  EmployeeHireResult,
  EmployeeMarketCategory,
  EmployeeMethodTag,
  EmployeeProvenance,
  EmployeeSource,
  ListEmployeeMarketQuery,
  UpdateAgentTemplate,
} from "@paperclipai/shared";
import { JIN_EMPLOYEE_METADATA_KEY, JIN_METADATA_NAMESPACE } from "@paperclipai/shared";
import { parseFrontmatterMarkdown } from "@paperclipai/shared/frontmatter";
import { writePaperclipSkillSyncPreference } from "@paperclipai/adapter-utils/server-utils";
import { conflict, notFound, unprocessable } from "../errors.js";
import { agentService } from "./agents.js";
import { agentInstructionsService } from "./agent-instructions.js";
import { approvalService } from "./approvals.js";
import { companySkillService } from "./company-skills.js";
import { listCatalogTeams, readCatalogTeamFile } from "./teams-catalog.js";
import {
  getPresetEmployee,
  listPresetEmployees,
  parsePresetEmployeeRefId,
  presetEmployeeContentHash,
  presetEmployeeRefId,
  renderPresetEmployeeAgentsMarkdown,
  type PresetEmployee,
} from "./employee-presets.js";

/**
 * AI 员工市场 —— 双供给源,单一读模型。
 *
 * ┌ 供给源 A:操盘手预制 ─ 文件(employee-presets.ts + teams-catalog 只读展开)
 * ├ 供给源 B:用户自定义 ─ agent_templates 表(0150)
 * └ 两条路都收敛到**同一个** materializeEmployee(),前端只看见 EmployeeCard。
 *
 * ⚠️ materialize 发生在 POST /employee-hires **当场**,不是在审批回调里。
 * 为什么:agent-hires 的审批流(approvals.ts:134 → agents.activatePendingApproval)
 * 只是**激活一行早已建好的 agent** —— 里面没有任何 catalog/template 展开逻辑。
 * 把 materialize 挂到审批回调上,会静默招出一个「没有人格、没有方法包」的空壳员工:
 * 招聘"成功"了,员工是空的,而且**不报错**。
 * 所以这里在 POST 时就把 agent 建全,审批只负责把它从 pending_approval 翻成 idle。
 */

/** teams-catalog 的 bundled agent 在 frontmatter 里不声明 adapter,与 teams-catalog.ts 的安全默认保持一致 */
const DEFAULT_EMPLOYEE_ADAPTER_TYPE = process.env.PAPERCLIP_TEAMS_CATALOG_DEFAULT_ADAPTER_TYPE?.trim()
  || "claude_local";

const CATALOG_REF_PREFIX = "catalog:";

/** 招聘前,两条供给路收敛成的同一个形状。materializeEmployee() 只认它。 */
interface EmployeeSpec {
  source: EmployeeSource;
  refId: string;
  name: string;
  role: string;
  title: string | null;
  avatarUrl: string | null;
  description: string | null;
  category: EmployeeMarketCategory | null;
  /** 人格 / 系统指令 —— 招聘时写进 agent 的 AGENTS.md 指令包 */
  instructions: string;
  adapterType: string | null;
  adapterConfig: Record<string, unknown>;
  desiredSkills: SkillSelection[];
  contentHash: string;
  version: number | null;
  visibility: AgentTemplateVisibility;
  updatedAt: string | null;
}

type SkillSelection = { key: string; versionId: string | null };

export interface EmployeeMarketActor {
  actorType: "agent" | "user" | "system" | "plugin";
  actorId: string;
  agentId?: string | null;
  userId?: string | null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeSkillSelections(value: unknown): SkillSelection[] {
  if (!Array.isArray(value)) return [];
  const out = new Map<string, SkillSelection>();
  for (const entry of value) {
    if (typeof entry === "string") {
      const key = entry.trim();
      if (key && !out.has(key)) out.set(key, { key, versionId: null });
      continue;
    }
    if (isPlainRecord(entry)) {
      const key = asString(entry.key);
      if (key && !out.has(key)) {
        out.set(key, { key, versionId: asString(entry.versionId) });
      }
    }
  }
  return Array.from(out.values());
}

function normalizeCategory(value: unknown): EmployeeMarketCategory | null {
  const text = asString(value);
  if (text === "content" || text === "operations" || text === "compliance") return text;
  return null;
}

/**
 * 自定义模板的内容哈希:只覆盖**会影响招出来的员工长什么样**的列。
 * 改 description / category 这类纯展示字段不该让已招员工亮 out-of-date。
 */
function templateContentHash(row: typeof agentTemplates.$inferSelect): string {
  const canonical = JSON.stringify([
    row.name,
    row.role,
    row.title ?? null,
    row.instructions,
    row.adapterType ?? null,
    row.adapterConfig ?? {},
    normalizeSkillSelections(row.desiredSkills),
  ]);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// 供给源 A:操盘手预制
// ---------------------------------------------------------------------------

function presetToSpec(preset: PresetEmployee): EmployeeSpec {
  return {
    source: "preset",
    refId: presetEmployeeRefId(preset.slug),
    name: preset.name,
    role: preset.role,
    title: preset.title,
    avatarUrl: preset.avatarUrl,
    description: preset.description,
    category: preset.category,
    instructions: renderPresetEmployeeAgentsMarkdown(preset),
    adapterType: null,
    adapterConfig: {},
    desiredSkills: preset.desiredSkills.map((key) => ({ key, versionId: null })),
    contentHash: presetEmployeeContentHash(preset),
    version: null,
    visibility: "public",
    updatedAt: null,
  };
}

function catalogEmployeeRefId(catalogTeamId: string, agentSlug: string): string {
  return `${CATALOG_REF_PREFIX}${catalogTeamId}:${agentSlug}`;
}

function parseCatalogEmployeeRefId(refId: string): { catalogTeamId: string; agentSlug: string } | null {
  if (!refId.startsWith(CATALOG_REF_PREFIX)) return null;
  const rest = refId.slice(CATALOG_REF_PREFIX.length);
  // catalog team id 形如 `paperclipai:optional:content:content-machine`,自己带冒号 ——
  // 所以从**最后一个**冒号切,右边是 agent slug。
  const separator = rest.lastIndexOf(":");
  if (separator <= 0) return null;
  const catalogTeamId = rest.slice(0, separator).trim();
  const agentSlug = rest.slice(separator + 1).trim();
  if (!catalogTeamId || !agentSlug) return null;
  return { catalogTeamId, agentSlug };
}

/**
 * teams-catalog 的**员工粒度**索引 —— 纯只读展开,`packages/teams-catalog` 一个字节都没动。
 *
 * team 粒度 ≠ 员工粒度:线上的两个 team 各自只有 1 个 agent。市场要的是员工卡片,
 * 所以按 `team.agentSlugs` 把每个 `agents/<slug>/AGENTS.md` 展开成一张卡。
 * contentHash 直接取 manifest 里每个 agent 文件行现成的 sha256(catalog-builder 已经算好了),
 * 不用自己再读一遍文件算哈希。
 */
async function listCatalogEmployeeSpecs(): Promise<EmployeeSpec[]> {
  const teams = await listCatalogTeams();
  const specs: EmployeeSpec[] = [];

  for (const team of teams) {
    for (const agentSlug of team.agentSlugs) {
      const agentPath = `agents/${agentSlug}/AGENTS.md`;
      const fileEntry = team.files.find((file) => file.path === agentPath);
      if (!fileEntry) continue;

      let content: string;
      try {
        const file = await readCatalogTeamFile(team.id, agentPath);
        content = file.content;
      } catch {
        // 目录里没有这个 agent 文件就跳过它,不要让一个坏条目把整个市场打挂。
        continue;
      }

      const parsed = parseFrontmatterMarkdown(content);
      const name = asString(parsed.frontmatter.name) ?? agentSlug;
      const role = asString(parsed.frontmatter.role) ?? "general";

      specs.push({
        source: "preset",
        refId: catalogEmployeeRefId(team.id, agentSlug),
        name,
        role,
        title: asString(parsed.frontmatter.title),
        avatarUrl: null,
        description: asString(parsed.frontmatter.description) ?? team.description,
        category: normalizeCategory(team.category),
        instructions: content,
        adapterType: asString(parsed.frontmatter.adapter),
        adapterConfig: {},
        desiredSkills: normalizeSkillSelections(parsed.frontmatter.skills),
        // manifest 里现成的 sha256 —— 白嫖 out-of-date 检测
        contentHash: fileEntry.sha256,
        version: null,
        visibility: "public",
        updatedAt: null,
      });
    }
  }

  return specs;
}

async function listPresetSpecs(): Promise<EmployeeSpec[]> {
  const [catalogSpecs] = await Promise.all([listCatalogEmployeeSpecs()]);
  return [...listPresetEmployees().map(presetToSpec), ...catalogSpecs];
}

async function resolvePresetSpec(refId: string): Promise<EmployeeSpec> {
  const presetSlug = parsePresetEmployeeRefId(refId);
  if (presetSlug) {
    const preset = getPresetEmployee(presetSlug);
    if (!preset) throw notFound(`Preset employee not found: ${refId}`);
    return presetToSpec(preset);
  }

  const catalogRef = parseCatalogEmployeeRefId(refId);
  if (!catalogRef) {
    throw unprocessable(`Unrecognized preset employee refId: ${refId}`);
  }

  const specs = await listCatalogEmployeeSpecs();
  const spec = specs.find((candidate) => candidate.refId === refId);
  if (!spec) throw notFound(`Preset employee not found: ${refId}`);
  return spec;
}

export function employeeMarketService(db: Db) {
  const agents = agentService(db);
  const approvals = approvalService(db);
  const companySkills = companySkillService(db);
  const instructions = agentInstructionsService();

  // -------------------------------------------------------------------------
  // 供给源 B:用户自定义(agent_templates)
  // -------------------------------------------------------------------------

  function templateToSpec(row: typeof agentTemplates.$inferSelect): EmployeeSpec {
    return {
      source: "custom",
      refId: row.id,
      name: row.name,
      role: row.role,
      title: row.title,
      avatarUrl: row.avatarUrl,
      description: row.description,
      category: normalizeCategory(row.category),
      instructions: row.instructions,
      adapterType: row.adapterType,
      adapterConfig: isPlainRecord(row.adapterConfig) ? row.adapterConfig : {},
      desiredSkills: normalizeSkillSelections(row.desiredSkills),
      contentHash: templateContentHash(row),
      version: row.version,
      visibility: row.visibility as AgentTemplateVisibility,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async function listTemplateRows(companyId: string) {
    return db
      .select()
      .from(agentTemplates)
      .where(and(eq(agentTemplates.companyId, companyId), eq(agentTemplates.status, "active")))
      .orderBy(desc(agentTemplates.updatedAt));
  }

  async function getTemplateRow(companyId: string, templateId: string) {
    const row = await db
      .select()
      .from(agentTemplates)
      .where(and(eq(agentTemplates.id, templateId), eq(agentTemplates.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound("Agent template not found");
    return row;
  }

  // -------------------------------------------------------------------------
  // 读模型:EmployeeCard(preset ∪ custom,形状一致)
  // -------------------------------------------------------------------------

  /**
   * 招聘溯源写在 `agents.metadata.jin.employee` —— **不建 FK 关联表**
   * (沿用 teams-catalog 的 metadata.paperclip.catalogTeam 既有做法)。
   */
  function readEmployeeProvenance(metadata: unknown): EmployeeProvenance | null {
    if (!isPlainRecord(metadata)) return null;
    const jin = isPlainRecord(metadata[JIN_METADATA_NAMESPACE])
      ? (metadata[JIN_METADATA_NAMESPACE] as Record<string, unknown>)
      : null;
    const employee = jin && isPlainRecord(jin[JIN_EMPLOYEE_METADATA_KEY])
      ? (jin[JIN_EMPLOYEE_METADATA_KEY] as Record<string, unknown>)
      : null;
    if (!employee) return null;

    const source = asString(employee.source);
    const refId = asString(employee.refId);
    const contentHash = asString(employee.contentHash);
    if ((source !== "preset" && source !== "custom") || !refId || !contentHash) return null;

    return {
      source,
      refId,
      contentHash,
      version: typeof employee.version === "number" ? employee.version : null,
      hiredAt: asString(employee.hiredAt) ?? "",
    };
  }

  function buildEmployeeMetadata(spec: EmployeeSpec, hiredAt: Date): Record<string, unknown> {
    const provenance: EmployeeProvenance = {
      source: spec.source,
      refId: spec.refId,
      contentHash: spec.contentHash,
      version: spec.version,
      hiredAt: hiredAt.toISOString(),
    };
    return { [JIN_METADATA_NAMESPACE]: { [JIN_EMPLOYEE_METADATA_KEY]: provenance } };
  }

  interface HiredIndexEntry {
    agentIds: string[];
    contentHashes: Set<string>;
  }

  async function buildHiredIndex(companyId: string): Promise<Map<string, HiredIndexEntry>> {
    const companyAgents = await agents.list(companyId);
    const index = new Map<string, HiredIndexEntry>();

    for (const agent of companyAgents) {
      const provenance = readEmployeeProvenance(agent.metadata);
      if (!provenance) continue;
      let entry = index.get(provenance.refId);
      if (!entry) {
        entry = { agentIds: [], contentHashes: new Set<string>() };
        index.set(provenance.refId, entry);
      }
      entry.agentIds.push(agent.id);
      entry.contentHashes.add(provenance.contentHash);
    }
    return index;
  }

  /** 方法包标签:公司技能库里有的标 company/platform,没有的标 unresolved(照样展示,不阻断招聘) */
  async function buildMethodTagResolver(companyId: string) {
    const skills = await companySkills.listFull(companyId);
    const byKey = new Map(skills.map((skill) => [skill.key, skill]));

    return (selections: SkillSelection[]): EmployeeMethodTag[] =>
      selections.map((selection) => {
        const skill = byKey.get(selection.key);
        if (!skill) {
          return { key: selection.key, name: selection.key, kind: "unresolved" as const };
        }
        return {
          key: skill.key,
          name: skill.name ?? skill.key,
          kind: skill.sourceType === "catalog" ? ("platform" as const) : ("company" as const),
        };
      });
  }

  function toCard(
    spec: EmployeeSpec,
    hiredIndex: Map<string, HiredIndexEntry>,
    toMethodTags: (selections: SkillSelection[]) => EmployeeMethodTag[],
  ): EmployeeCard {
    const hit = hiredIndex.get(spec.refId);
    // out-of-date = 招聘时存下的 hash ≠ 现在的 hash。preset 和 custom 用的是同一套判定,
    // 所以「模板改了」这件事对两条供给源是一样可靠的。
    const outOfDate = Boolean(
      hit && hit.contentHashes.size > 0 && [...hit.contentHashes].some((hash) => hash !== spec.contentHash),
    );

    return {
      source: spec.source,
      refId: spec.refId,
      name: spec.name,
      role: spec.role,
      title: spec.title,
      avatarUrl: spec.avatarUrl,
      description: spec.description,
      category: spec.category,
      methodTags: toMethodTags(spec.desiredSkills),
      contentHash: spec.contentHash,
      version: spec.version,
      hired: Boolean(hit && hit.agentIds.length > 0),
      hiredAgentIds: hit?.agentIds ?? [],
      outOfDate,
      visibility: spec.visibility,
      updatedAt: spec.updatedAt,
    };
  }

  async function listEmployeeMarket(
    companyId: string,
    query: ListEmployeeMarketQuery = {},
  ): Promise<EmployeeCard[]> {
    const [presetSpecs, templateRows, hiredIndex, toMethodTags] = await Promise.all([
      listPresetSpecs(),
      listTemplateRows(companyId),
      buildHiredIndex(companyId),
      buildMethodTagResolver(companyId),
    ]);

    const specs: EmployeeSpec[] = [...presetSpecs, ...templateRows.map(templateToSpec)];
    const needle = query.q?.trim().toLowerCase() ?? "";

    return specs
      .filter((spec) => !query.source || spec.source === query.source)
      .filter((spec) => !query.category || spec.category === query.category)
      .filter((spec) => {
        if (!needle) return true;
        return [spec.name, spec.role, spec.title, spec.description]
          .filter((value): value is string => Boolean(value))
          .some((value) => value.toLowerCase().includes(needle));
      })
      .map((spec) => toCard(spec, hiredIndex, toMethodTags))
      .filter((card) => query.hired === undefined || card.hired === query.hired)
      .sort((left, right) => {
        if (left.source !== right.source) return left.source === "preset" ? -1 : 1;
        return left.name.localeCompare(right.name);
      });
  }

  // -------------------------------------------------------------------------
  // 招聘:两条供给路收敛到这里
  // -------------------------------------------------------------------------

  async function resolveSpec(companyId: string, source: EmployeeSource, refId: string): Promise<EmployeeSpec> {
    if (source === "preset") return resolvePresetSpec(refId);
    return templateToSpec(await getTemplateRow(companyId, refId));
  }

  /**
   * **唯一的 materialize 函数。** preset 和 custom 都走这里 —— 加第三条供给源时,
   * 只要它能给出 EmployeeSpec,这个函数一行都不用改。
   *
   * 建全一个员工 = 四件事,缺一件就是空壳:
   *   ① agents 行(名字/角色/adapter)
   *   ② 人格:AGENTS.md 指令包(materializeManagedBundle → adapterConfig 里的 instructions 路径)
   *   ③ 方法包:desiredSkills 写进 adapterConfig 的 skill sync preference
   *   ④ 溯源:agents.metadata.jin.employee = {source, refId, contentHash}
   */
  async function materializeEmployee(
    companyId: string,
    spec: EmployeeSpec,
    input: CreateEmployeeHire,
    actor: EmployeeMarketActor,
  ): Promise<EmployeeHireResult> {
    const warnings: string[] = [];
    const adapterType = input.adapterType ?? spec.adapterType ?? DEFAULT_EMPLOYEE_ADAPTER_TYPE;

    const company = await db
      .select()
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0] ?? null);
    if (!company) throw notFound("Company not found");

    // ③ 方法包 —— 解析不上的 key 不阻断招聘,原样留在 desiredSkills 里(前端标成 unresolved,可见可删)
    let adapterConfig: Record<string, unknown> = { ...spec.adapterConfig };
    if (spec.desiredSkills.length > 0) {
      const { resolved, unresolved } = await companySkills.resolveRequestedSkillEntries(
        companyId,
        spec.desiredSkills,
        { tolerateUnknownReferences: true },
      );
      const entries = [
        ...resolved,
        ...unresolved.map((key: string) => ({ key, versionId: null })),
      ];
      adapterConfig = writePaperclipSkillSyncPreference(adapterConfig, entries);
      if (unresolved.length > 0) {
        warnings.push(
          `这些方法包还没装进公司技能库,员工已招进来但暂时用不了:${unresolved.join(", ")}`,
        );
      }
    }

    const requiresApproval = company.requireBoardApprovalForNewAgents;
    const hiredAt = new Date();
    const agentId = randomUUID();

    // ① agents 行。⚠️ 审批只负责激活,**不负责建全** —— 所以这里当场就建全。
    const created = await agents.create(companyId, {
      id: agentId,
      name: input.nameOverride ?? spec.name,
      role: spec.role,
      title: spec.title,
      reportsTo: input.reportsTo ?? null,
      adapterType,
      adapterConfig,
      // ④ 溯源:不建 FK 关联表,写 metadata
      metadata: buildEmployeeMetadata(spec, hiredAt),
      status: requiresApproval ? "pending_approval" : "idle",
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    });

    // ② 人格:把 instructions 写成 AGENTS.md 指令包。
    // 这一步同时是「配置历史」的第一条 —— agent_config_revisions **不是自动记录的**
    // (agents.ts:529 `shouldRecordRevision = Boolean(options?.recordRevision) && ...`,
    //  而且 create() 从不记),调用方不显式传 recordRevision 的话,新招的员工
    // 一条配置历史都没有,前端的「配置历史 / 回滚」对它就是空的。
    const materialized = await instructions.materializeManagedBundle(
      created,
      { "AGENTS.md": spec.instructions },
      { entryFile: "AGENTS.md", replaceExisting: true },
    );

    const finalAgent = await agents.update(
      created.id,
      { adapterConfig: materialized.adapterConfig },
      {
        allowPendingApprovalConfigUpdate: true,
        recordRevision: {
          createdByAgentId: actor.actorType === "agent" ? actor.actorId : null,
          createdByUserId: actor.actorType === "user" ? actor.actorId : null,
          source: `employee_hire:${spec.source}`,
        },
      },
    );
    if (!finalAgent) throw notFound("Agent not found after hire");

    // 审批:agent 已经建全了,审批只把 pending_approval 翻成 idle。
    let approvalId: string | null = null;
    if (requiresApproval) {
      const approval = await approvals.create(companyId, {
        type: "hire_agent",
        requestedByAgentId: actor.actorType === "agent" ? actor.actorId : null,
        requestedByUserId: actor.actorType === "user" ? actor.actorId : null,
        status: "pending",
        payload: {
          name: finalAgent.name,
          role: finalAgent.role,
          title: finalAgent.title ?? null,
          adapterType: finalAgent.adapterType,
          // agent 已经建全,payload 只是给审批人看的快照 —— activatePendingApproval
          // 不需要靠它去展开任何东西。
          agentId: finalAgent.id,
          employee: { source: spec.source, refId: spec.refId, contentHash: spec.contentHash },
        },
        decisionNote: null,
        decidedByUserId: null,
        decidedAt: null,
        updatedAt: new Date(),
      });
      approvalId = approval.id;
    }

    const [hiredIndex, toMethodTags] = await Promise.all([
      buildHiredIndex(companyId),
      buildMethodTagResolver(companyId),
    ]);

    return {
      agentId: finalAgent.id,
      requiresApproval,
      approvalId,
      card: toCard(spec, hiredIndex, toMethodTags),
      warnings,
    };
  }

  async function hireEmployee(
    companyId: string,
    input: CreateEmployeeHire,
    actor: EmployeeMarketActor,
  ): Promise<EmployeeHireResult> {
    const spec = await resolveSpec(companyId, input.source, input.refId);
    return materializeEmployee(companyId, spec, input, actor);
  }

  // -------------------------------------------------------------------------
  // 模板 CRUD
  // -------------------------------------------------------------------------

  function creatorColumns(actor: EmployeeMarketActor) {
    if (actor.actorType === "agent") {
      return { createdByType: "agent" as const, createdByAgentId: actor.actorId, createdByUserId: null };
    }
    if (actor.actorType === "user") {
      return { createdByType: "user" as const, createdByUserId: actor.actorId, createdByAgentId: null };
    }
    throw unprocessable("Only users and agents can create agent templates");
  }

  async function createTemplate(
    companyId: string,
    input: CreateAgentTemplate,
    actor: EmployeeMarketActor,
  ): Promise<EmployeeCard> {
    const row = await db
      .insert(agentTemplates)
      .values({
        companyId,
        name: input.name,
        avatarUrl: input.avatarUrl ?? null,
        role: input.role,
        title: input.title ?? null,
        description: input.description ?? null,
        category: input.category ?? null,
        instructions: input.instructions,
        adapterType: input.adapterType ?? null,
        adapterConfig: input.adapterConfig ?? {},
        desiredSkills: input.desiredSkills ?? [],
        visibility: input.visibility ?? "company",
        metadata: input.metadata ?? {},
        ...creatorColumns(actor),
      })
      .returning()
      .then((rows) => rows[0]!)
      .catch((error: unknown) => {
        // agent_templates_company_name_uq:同公司在架模板不许重名
        if (error instanceof Error && error.message.includes("agent_templates_company_name_uq")) {
          throw conflict(`已经有一个叫「${input.name}」的员工模板了`);
        }
        throw error;
      });

    return cardForTemplate(companyId, row);
  }

  /** 「把这个员工存为模板」—— 从一个已存在的 agent 反向抽取配方 */
  async function createTemplateFromAgent(
    companyId: string,
    input: CreateAgentTemplateFromAgent,
    actor: EmployeeMarketActor,
  ): Promise<EmployeeCard> {
    const agent = await agents.getById(input.fromAgentId);
    if (!agent || agent.companyId !== companyId) throw notFound("Agent not found");

    // getBundle 只给文件摘要(没有正文),exportFiles 才带内容
    const exported = await instructions.exportFiles(agent);
    const personaMarkdown = (
      exported.files[exported.entryFile] ?? Object.values(exported.files)[0] ?? ""
    ).trim();
    if (!personaMarkdown) {
      // 没有人格的 agent 存成模板 = 造一个必定招出空壳员工的模板。挡住。
      throw unprocessable("这个员工还没有指令(AGENTS.md),存成模板会招出空壳员工");
    }

    const adapterConfig = isPlainRecord(agent.adapterConfig) ? agent.adapterConfig : {};
    const preference = readSkillPreferenceKeys(adapterConfig);

    return createTemplate(
      companyId,
      {
        name: input.name ?? agent.name,
        role: agent.role,
        title: agent.title ?? undefined,
        description: input.description ?? undefined,
        category: input.category ?? undefined,
        instructions: personaMarkdown,
        adapterType: agent.adapterType,
        // 不把 adapterConfig 整个抄进模板:里面有指令包路径、密钥绑定、runtime skill 物化产物,
        // 那些是**这一个实例**的东西,抄进模板会让下一个招进来的员工指向别人的目录。
        adapterConfig: {},
        desiredSkills: preference,
        visibility: input.visibility ?? "company",
      },
      actor,
    );
  }

  function readSkillPreferenceKeys(adapterConfig: Record<string, unknown>): SkillSelection[] {
    const paperclip = isPlainRecord(adapterConfig.paperclip)
      ? (adapterConfig.paperclip as Record<string, unknown>)
      : null;
    const skillSync = paperclip && isPlainRecord(paperclip.skillSync)
      ? (paperclip.skillSync as Record<string, unknown>)
      : null;
    return normalizeSkillSelections(skillSync?.desiredSkillEntries ?? skillSync?.desiredSkills);
  }

  async function updateTemplate(
    companyId: string,
    templateId: string,
    patch: UpdateAgentTemplate,
  ): Promise<EmployeeCard> {
    await getTemplateRow(companyId, templateId);

    // ⚠️ 故意不写 version —— 由 DB 触发器(0150)按「内容列有没有真的变」自增。
    // 应用层自己 +1 的话,任何一条漏写的更新路径都会让 out-of-date 徽章静默失灵。
    const row = await db
      .update(agentTemplates)
      .set({
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.avatarUrl !== undefined ? { avatarUrl: patch.avatarUrl } : {}),
        ...(patch.role !== undefined ? { role: patch.role } : {}),
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.category !== undefined ? { category: patch.category } : {}),
        ...(patch.instructions !== undefined ? { instructions: patch.instructions } : {}),
        ...(patch.adapterType !== undefined ? { adapterType: patch.adapterType } : {}),
        ...(patch.adapterConfig !== undefined ? { adapterConfig: patch.adapterConfig } : {}),
        ...(patch.desiredSkills !== undefined ? { desiredSkills: patch.desiredSkills } : {}),
        ...(patch.visibility !== undefined ? { visibility: patch.visibility } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
      })
      .where(and(eq(agentTemplates.id, templateId), eq(agentTemplates.companyId, companyId)))
      .returning()
      .then((rows) => rows[0]!);

    return cardForTemplate(companyId, row);
  }

  async function archiveTemplate(companyId: string, templateId: string): Promise<void> {
    await getTemplateRow(companyId, templateId);
    await db
      .update(agentTemplates)
      .set({ status: "archived" })
      .where(and(eq(agentTemplates.id, templateId), eq(agentTemplates.companyId, companyId)));
  }

  async function cardForTemplate(
    companyId: string,
    row: typeof agentTemplates.$inferSelect,
  ): Promise<EmployeeCard> {
    const [hiredIndex, toMethodTags] = await Promise.all([
      buildHiredIndex(companyId),
      buildMethodTagResolver(companyId),
    ]);
    return toCard(templateToSpec(row), hiredIndex, toMethodTags);
  }

  async function listTemplates(companyId: string): Promise<EmployeeCard[]> {
    const [rows, hiredIndex, toMethodTags] = await Promise.all([
      listTemplateRows(companyId),
      buildHiredIndex(companyId),
      buildMethodTagResolver(companyId),
    ]);
    return rows.map((row) => toCard(templateToSpec(row), hiredIndex, toMethodTags));
  }

  return {
    listEmployeeMarket,
    hireEmployee,
    listTemplates,
    createTemplate,
    createTemplateFromAgent,
    updateTemplate,
    archiveTemplate,
    readEmployeeProvenance,
  };
}

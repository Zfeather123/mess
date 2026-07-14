import type {
  EmployeeMarketCategory,
  EmployeeSource,
  AgentTemplateVisibility,
} from "../constants.js";

/**
 * AI 员工市场的**唯一读模型**。
 *
 * 供给侧有两条路(操盘手预制的文件 / 用户自定义的 agent_templates 行),
 * 前端只认这一个形状 —— **不关心底下是文件还是表**。加第三条供给源时,
 * 只要它能收敛成 EmployeeCard,前端一行都不用改。
 */
export interface EmployeeCard {
  source: EmployeeSource;
  /**
   * 招聘时原样回传给 POST /employee-hires 的坐标。
   *  - preset:`catalog:<catalogTeamId>:<agentSlug>` 或 `jin:<slug>`(操盘手预制)
   *  - custom:`agent_templates.id`
   * 前端当成不透明字符串,不要解析。
   */
  refId: string;

  name: string;
  role: string;
  title: string | null;
  avatarUrl: string | null;
  description: string | null;
  category: EmployeeMarketCategory | null;

  /** 方法包标签(平台方法 / 专属方法),= 招进来后会绑定的 skills */
  methodTags: EmployeeMethodTag[];

  /**
   * 内容哈希。招聘时写进 agents.metadata,之后「模板更新了」的判定就是:
   * 存的 hash ≠ 当前 hash。preset 用文件内容的 sha256,custom 用模板内容的 sha256。
   */
  contentHash: string;
  /** custom 才有:agent_templates.version(人看的版本号,DB 触发器兜底自增) */
  version: number | null;

  /** 已招募状态 —— 产品原型里的「已招募」分类靠这个过滤 */
  hired: boolean;
  hiredAgentIds: string[];
  /** 招进来之后模板又被改过 → 前端出「模板已更新」徽章 */
  outOfDate: boolean;

  visibility: AgentTemplateVisibility;
  updatedAt: string | null;
}

export interface EmployeeMethodTag {
  key: string;
  name: string;
  /** platform = 平台内置方法包;company = 本公司专属方法包;unresolved = 模板声明了但公司库里还没有 */
  kind: "platform" | "company" | "unresolved";
}

/**
 * 写进 `agents.metadata.jin.employee` 的招聘溯源。
 * 沿用 teams-catalog 的既有做法(metadata.paperclip.catalogTeam),**不建 FK 关联表**。
 */
export interface EmployeeProvenance {
  source: EmployeeSource;
  refId: string;
  contentHash: string;
  version?: number | null;
  hiredAt: string;
}

export interface EmployeeHireResult {
  agentId: string;
  /** 需要董事会审批时,agent 建全但停在 pending_approval,由审批激活 */
  requiresApproval: boolean;
  approvalId: string | null;
  card: EmployeeCard;
  /** 方法包没解析上之类的非致命问题 */
  warnings: string[];
}

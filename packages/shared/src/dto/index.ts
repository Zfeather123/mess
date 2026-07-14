/**
 * 对外 API 的**响应契约**(单一事实源)。
 *
 * 后端按这里的 DTO 出参(逐字段映射,不 spread 表行),前端从这里取类型(不再手抄镜像)。
 * 持久化 schema 与 API 契约就此脱钩:加一列不会自动变成对外承诺,删一列会在契约测试里变红。
 */
export {
  agentFeedbackNoteDto,
  type AgentFeedbackNoteDto,
  type CreateAgentFeedbackNoteInput,
  type UpdateAgentFeedbackNoteInput,
} from "./agent-feedback-note.js";
export {
  squadDispatchDto,
  squadDto,
  squadMemberDto,
  type AddSquadMemberInput,
  type CreateSquadInput,
  type DecideSquadDispatchInput,
  type DeclineSquadDispatchInput,
  type ListSquadDispatchesQueryInput,
  type SquadDispatchDto,
  type SquadDto,
  type SquadMemberDto,
  type UpdateSquadInput,
} from "./squad.js";
export {
  API_CONTRACT_SCHEMAS,
  buildContractSchemas,
  findContractBreaks,
  type ApiContractSchemaName,
  type ContractBreak,
} from "./contract.js";
export { toJsonSchema, type JsonSchema } from "./json-schema.js";
export { toIso, toIsoOrNull } from "./primitives.js";

import type {
  CreateAgentTemplate,
  CreateEmployeeHire,
  EmployeeCard,
  EmployeeHireResult,
  ListEmployeeMarketQuery,
} from "@paperclipai/shared";
import { api } from "./client";

// AI 员工市场 (JIN-68), against the routes that landed with JIN-67
// (`server/src/routes/employee-market.ts`; contract in docs/jin/API_JIN67.md).
//
// Supply is two-sourced — 操盘手预制 (catalog files) and 用户自定义
// (`agent_templates` rows) — but the read model is a single union: a card carries
// `source` plus an opaque `refId`, and this UI never asks what is underneath.
// Creating a template answers with an `EmployeeCard` as well, so a freshly
// authored employee drops straight back onto the same wall.

export type {
  CreateAgentTemplate,
  CreateEmployeeHire,
  EmployeeCard,
  EmployeeHireResult,
} from "@paperclipai/shared";

const enc = encodeURIComponent;

export const employeeMarketApi = {
  list: (companyId: string, query: ListEmployeeMarketQuery = {}) => {
    const params = new URLSearchParams();
    if (query.source) params.set("source", query.source);
    if (query.category) params.set("category", query.category);
    if (query.q) params.set("q", query.q);
    if (query.hired !== undefined) params.set("hired", String(query.hired));
    const search = params.toString();
    return api.get<EmployeeCard[]>(
      `/companies/${enc(companyId)}/employee-market${search ? `?${search}` : ""}`,
    );
  },

  /**
   * 招一个 AI 员工. The server materialises the whole employee (人格 / 方法包 /
   * adapter 配置) inside this POST; approval, when required, only activates an
   * agent that already exists in full.
   */
  hire: (companyId: string, input: CreateEmployeeHire) =>
    api.post<EmployeeHireResult>(`/companies/${enc(companyId)}/employee-hires`, input),

  createTemplate: (companyId: string, input: CreateAgentTemplate) =>
    api.post<EmployeeCard>(`/companies/${enc(companyId)}/agent-templates`, input),
};

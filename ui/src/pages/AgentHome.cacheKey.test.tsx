// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentHome } from "./AgentHome";
import { Dashboard } from "./Dashboard";

/**
 * Regression coverage for JIN-77: AgentHome and Dashboard both used the bare
 * `queryKeys.issues.list(companyId)` key, but AgentHome's queryFn narrows the
 * request to a single assignee. react-query served whichever page mounted
 * second from the other's cache entry, so an employee's home page listed the
 * whole company's tasks — silently, with no error. The two pages must never
 * share a cache entry, in either mount order.
 */

const AGENT_ID = "agent-1";
const OTHER_AGENT_ID = "agent-2";

const MINE = {
  id: "issue-mine",
  companyId: "company-1",
  title: "我的活",
  status: "in_progress",
  priority: "high",
  assigneeAgentId: AGENT_ID,
  identifier: "JIN-1",
  updatedAt: "2026-07-01T00:00:00Z",
  createdAt: "2026-07-01T00:00:00Z",
};
const THEIRS_A = { ...MINE, id: "issue-theirs-a", title: "别人的活A", assigneeAgentId: OTHER_AGENT_ID, identifier: "JIN-2" };
const THEIRS_B = { ...MINE, id: "issue-theirs-b", title: "别人的活B", assigneeAgentId: OTHER_AGENT_ID, identifier: "JIN-3" };

const ALL_COMPANY_ISSUES = [MINE, THEIRS_A, THEIRS_B];

// Mirrors the server: no filter => whole company; assigneeAgentId => that agent only.
const mockIssuesApi = vi.hoisted(() => ({
  list: vi.fn(),
  listCompact: vi.fn(),
  listLabels: vi.fn(),
}));
const mockAgentsApi = vi.hoisted(() => ({ get: vi.fn(), list: vi.fn(), skills: vi.fn() }));
const mockHeartbeatsApi = vi.hoisted(() => ({ list: vi.fn() }));
const mockDashboardApi = vi.hoisted(() => ({ summary: vi.fn() }));
const mockActivityApi = vi.hoisted(() => ({ list: vi.fn() }));
const mockAccessApi = vi.hoisted(() => ({ listUserDirectory: vi.fn() }));
const mockProjectsApi = vi.hoisted(() => ({ list: vi.fn() }));

vi.mock("../api/issues", () => ({ issuesApi: mockIssuesApi }));
vi.mock("../api/agents", () => ({ agentsApi: mockAgentsApi }));
vi.mock("../api/heartbeats", () => ({ heartbeatsApi: mockHeartbeatsApi }));
vi.mock("../api/dashboard", () => ({ dashboardApi: mockDashboardApi }));
vi.mock("../api/activity", () => ({ activityApi: mockActivityApi }));
vi.mock("../api/access", () => ({ accessApi: mockAccessApi }));
vi.mock("../api/projects", () => ({ projectsApi: mockProjectsApi }));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
    selectedCompany: { id: "company-1", name: "Acme", issuePrefix: "JIN" },
    companies: [{ id: "company-1", name: "Acme" }],
  }),
}));
vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));
vi.mock("../context/DialogContext", () => ({
  useDialogActions: () => ({ openOnboarding: vi.fn() }),
}));

vi.mock("@/lib/router", () => ({
  useParams: () => ({ agentId: AGENT_ID }),
  Link: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));

// Shared-polling plumbing is irrelevant to cache-key identity.
vi.mock("../hooks/useSharedPolling", () => ({
  useSharedPollingQuery: () => ({ isLeader: true, sharedData: undefined }),
  usePublishSharedQueryData: () => {},
}));

// Heavy children that issue their own queries / need a chart runtime.
vi.mock("../components/ActiveAgentsPanel", () => ({ ActiveAgentsPanel: () => null }));
vi.mock("../components/ActivityCharts", () => ({
  ChartCard: () => null,
  RunActivityChart: () => null,
  PriorityChart: () => null,
  IssueStatusChart: () => null,
  SuccessRateChart: () => null,
}));
vi.mock("../components/agent-home/FeedbackNotesSection", () => ({
  FeedbackNotesSection: () => null,
}));
vi.mock("@/plugins/slots", () => ({ PluginSlotOutlet: () => null }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let roots: Root[];
let queryClient: QueryClient;

async function mount(node: ReactNode) {
  const host = document.createElement("div");
  container.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => {
    root.render(<QueryClientProvider client={queryClient}>{node}</QueryClientProvider>);
  });
  // AgentHome's issue query only becomes enabled once the agent query resolves,
  // so keep flushing until nothing is in flight *and* nothing new was enqueued.
  for (let i = 0; i < 20; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    if (queryClient.isFetching() === 0 && i > 2) break;
  }
  return host;
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  roots = [];
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: Infinity } },
  });

  mockIssuesApi.list.mockImplementation((_companyId: string, filters?: { assigneeAgentId?: string }) =>
    Promise.resolve(
      filters?.assigneeAgentId
        ? ALL_COMPANY_ISSUES.filter((i) => i.assigneeAgentId === filters.assigneeAgentId)
        : ALL_COMPANY_ISSUES,
    ),
  );
  mockIssuesApi.listCompact.mockResolvedValue([]);
  mockIssuesApi.listLabels.mockResolvedValue([]);
  mockAgentsApi.get.mockResolvedValue({
    id: AGENT_ID,
    name: "小明",
    title: "前端工程师",
    status: "idle",
    icon: null,
    adapterConfig: null,
  });
  mockAgentsApi.list.mockResolvedValue([]);
  mockAgentsApi.skills.mockResolvedValue({ entries: [] });
  mockHeartbeatsApi.list.mockResolvedValue([]);
  mockDashboardApi.summary.mockResolvedValue({
    companyId: "company-1",
    agents: { active: 0, running: 0, paused: 0, error: 0 },
    tasks: { open: 0, inProgress: 0, blocked: 0, done: 0 },
    costs: { monthSpendCents: 0, monthBudgetCents: 0, monthUtilizationPercent: 0 },
    pendingApprovals: 0,
    budgets: { activeIncidents: 0, pendingApprovals: 0, pausedAgents: 0, pausedProjects: 0 },
    runActivity: [],
  });
  mockActivityApi.list.mockResolvedValue([]);
  mockAccessApi.listUserDirectory.mockResolvedValue({ users: [] });
  mockProjectsApi.list.mockResolvedValue([]);
});

afterEach(async () => {
  await act(async () => {
    roots.forEach((root) => root.unmount());
  });
  container.remove();
  queryClient.clear();
  vi.clearAllMocks();
});

describe("AgentHome / Dashboard issue cache isolation (JIN-77)", () => {
  it("does not serve Dashboard's company-wide issues to AgentHome", async () => {
    // Dashboard first: fills the cache with every issue in the company.
    const dashboard = await mount(<Dashboard />);
    expect(dashboard.textContent).toContain("别人的活A");

    // Then the employee home page, on the same QueryClient.
    const agentHome = await mount(<AgentHome />);

    expect(agentHome.textContent).toContain("我的活");
    expect(agentHome.textContent).not.toContain("别人的活A");
    expect(agentHome.textContent).not.toContain("别人的活B");

    // The narrowed request must actually have been issued, not short-circuited
    // by a cache hit on Dashboard's entry.
    expect(mockIssuesApi.list).toHaveBeenCalledWith("company-1", { assigneeAgentId: AGENT_ID });
  });

  it("does not serve AgentHome's filtered issues to Dashboard", async () => {
    const agentHome = await mount(<AgentHome />);
    expect(agentHome.textContent).toContain("我的活");

    const dashboard = await mount(<Dashboard />);

    // Dashboard must still be whole-company, not narrowed to agent-1.
    expect(dashboard.textContent).toContain("我的活");
    expect(dashboard.textContent).toContain("别人的活A");
    expect(dashboard.textContent).toContain("别人的活B");
  });
});

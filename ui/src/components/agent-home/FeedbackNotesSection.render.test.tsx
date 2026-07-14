// @vitest-environment jsdom

import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FeedbackNote } from "@/api/collab-types";
import { FeedbackNotesSection } from "./FeedbackNotesSection";

const mockFeedbackNotesApi = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  archive: vi.fn(),
}));

const mockProjectsApi = vi.hoisted(() => ({ list: vi.fn() }));
const mockPushToast = vi.hoisted(() => vi.fn());

vi.mock("@/api/collab", () => ({ feedbackNotesApi: mockFeedbackNotesApi }));
vi.mock("@/api/projects", () => ({ projectsApi: mockProjectsApi }));
vi.mock("@/context/ToastContext", () => ({
  useToast: () => ({ pushToast: mockPushToast }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

async function flushReact() {
  await act(async () => {
    for (let i = 0; i < 4; i += 1) {
      await Promise.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    }
  });
}

function note(overrides: Partial<FeedbackNote> & Pick<FeedbackNote, "id" | "kind">): FeedbackNote {
  return {
    agentId: "agent-1",
    content: "内容",
    scopeType: "global",
    douyinAccountId: null,
    projectId: null,
    sourceType: "manual",
    sourceMessageId: null,
    sourceIssueId: null,
    status: "active",
    weight: 100,
    timesApplied: 0,
    lastAppliedAt: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;

async function render() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  await act(() => {
    root.render(
      <QueryClientProvider client={client}>
        <FeedbackNotesSection agentId="agent-1" agentName="小镜" companyId="company-1" />
      </QueryClientProvider>,
    );
  });
  await flushReact();
}

/** The section box whose heading matches — corrections and reminders are separate columns. */
function column(title: string): HTMLElement {
  const heading = [...container.querySelectorAll("h3")].find((node) =>
    node.textContent?.startsWith(title),
  );
  if (!heading) throw new Error(`No column titled ${title}`);
  return heading.closest("div.rounded-xl") as HTMLElement;
}

beforeEach(() => {
  mockProjectsApi.list.mockResolvedValue([]);
  mockFeedbackNotesApi.archive.mockResolvedValue({ mock: true, data: null });
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe("FeedbackNotesSection", () => {
  it("renders corrections and reminders in separate columns, with source and scope", async () => {
    mockFeedbackNotesApi.list.mockResolvedValue({
      mock: false,
      data: [
        note({
          id: "n1",
          kind: "correction",
          content: "标题不要写成震惊体",
          sourceType: "approval_rejection",
          scopeType: "douyin_account",
          scopeLabel: "小镜说法",
          timesApplied: 6,
        }),
        note({ id: "n2", kind: "reminder", content: "口播稿超过 90 秒就砍" }),
      ],
    });

    await render();

    const corrections = column("最近被纠正");
    const reminders = column("下次注意");

    expect(corrections.textContent).toContain("标题不要写成震惊体");
    expect(corrections.textContent).not.toContain("口播稿超过 90 秒就砍");
    expect(reminders.textContent).toContain("口播稿超过 90 秒就砍");

    // Source, scope and applied-count are all visible on the note itself.
    expect(corrections.textContent).toContain("审批被拒");
    expect(corrections.textContent).toContain("小镜说法");
    expect(corrections.textContent).toContain("已应用 6 次");
  });

  it("archives a note through the API", async () => {
    mockFeedbackNotesApi.list.mockResolvedValue({
      mock: false,
      data: [note({ id: "n1", kind: "correction", content: "标题不要写成震惊体" })],
    });

    await render();

    const archiveButton = [...container.querySelectorAll("button")].find((button) =>
      button.getAttribute("aria-label")?.startsWith("归档这条笔记"),
    );
    expect(archiveButton).toBeTruthy();

    await act(() => archiveButton!.click());
    await flushReact();

    expect(mockFeedbackNotesApi.archive).toHaveBeenCalledWith("n1");
  });

  it("flags demo data when the backend route is not mounted yet", async () => {
    mockFeedbackNotesApi.list.mockResolvedValue({
      mock: true,
      data: [note({ id: "n1", kind: "reminder" })],
    });

    await render();

    expect(container.textContent).toContain("接口未就绪 · 演示数据");
  });
});

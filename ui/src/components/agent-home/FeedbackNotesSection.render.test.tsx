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
    companyId: "company-1",
    agentId: "agent-1",
    content: "内容",
    scopeType: "global",
    douyinAccountId: null,
    projectId: null,
    sourceType: "manual",
    sourceMessageId: null,
    sourceIssueId: null,
    sourceApprovalId: null,
    createdByUserId: null,
    createdByAgentId: null,
    status: "active",
    weight: 100,
    timesApplied: 0,
    lastAppliedAt: null,
    expiresAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    injection: "injected",
    injectLimit: 10,
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
  mockFeedbackNotesApi.archive.mockResolvedValue(note({ id: "n1", kind: "correction" }));
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe("FeedbackNotesSection", () => {
  it("renders corrections and reminders in separate columns, with source and scope", async () => {
    mockProjectsApi.list.mockResolvedValue([{ id: "p1", name: "小镜说法" }]);
    mockFeedbackNotesApi.list.mockResolvedValue([
        note({
          id: "n1",
          kind: "correction",
          content: "标题不要写成震惊体",
          sourceType: "approval_rejection",
          scopeType: "project",
          projectId: "p1",
          timesApplied: 6,
        }),
        note({ id: "n2", kind: "reminder", content: "口播稿超过 90 秒就砍" }),
    ]);

    await render();

    const corrections = column("最近被纠正");
    const reminders = column("下次注意");

    expect(corrections.textContent).toContain("标题不要写成震惊体");
    expect(corrections.textContent).not.toContain("口播稿超过 90 秒就砍");
    expect(reminders.textContent).toContain("口播稿超过 90 秒就砍");

    // Source, scope and applied-count are all visible on the note itself. The scope
    // name comes from the projects the page loaded — the note itself carries only an id.
    expect(corrections.textContent).toContain("审批被拒");
    expect(corrections.textContent).toContain("项目 · 小镜说法");
    expect(corrections.textContent).toContain("已应用 6 次");
  });

  it("archives a note through the API", async () => {
    mockFeedbackNotesApi.list.mockResolvedValue([
      note({ id: "n1", kind: "correction", content: "标题不要写成震惊体" }),
    ]);

    await render();

    const archiveButton = [...container.querySelectorAll("button")].find((button) =>
      button.getAttribute("aria-label")?.startsWith("归档这条笔记"),
    );
    expect(archiveButton).toBeTruthy();

    await act(() => archiveButton!.click());
    await flushReact();

    expect(mockFeedbackNotesApi.archive).toHaveBeenCalledWith("n1");
  });

  // JIN-80:主页列 100 条,prompt 只吃前 10 条。一条永远进不了 prompt 的笔记如果和生效的
  // 长得一模一样,用户就以为自己教会了员工 —— 实际上什么都没发生。
  it("把不会生效的笔记(超限 / 过期)和会生效的区分开", async () => {
    mockFeedbackNotesApi.list.mockResolvedValue([
        note({ id: "live", kind: "correction", content: "这条会生效" }),
        note({
          id: "over",
          kind: "correction",
          content: "这条排在第 11 位,永远进不了提示词",
          injection: "over_limit",
        }),
        note({
          id: "expired",
          kind: "reminder",
          content: "这条已经过期了",
          injection: "expired",
          expiresAt: "2026-01-01T00:00:00Z",
        }),
    ]);

    await render();

    const corrections = column("最近被纠正");
    const reminders = column("下次注意");

    // 会生效的那条不带任何「未生效」的话术
    const liveCard = [...corrections.querySelectorAll("li")].find((item) =>
      item.textContent?.includes("这条会生效"),
    )!;
    expect(liveCard.textContent).not.toContain("未生效");

    expect(corrections.textContent).toContain("未生效 · 超出前 10 条");
    expect(reminders.textContent).toContain("已过期 · 不再生效");
    // 抬头也要说清:多少条真的会生效
    expect(container.textContent).toContain("当前 1 条会生效");
  });

  // 「已记下,下次会照做」是一句承诺 —— 笔记进不了 prompt 时,它就是谎话。
  it("笔记不会生效时,toast 不再承诺「下次会照做」", async () => {
    mockFeedbackNotesApi.list.mockResolvedValue([]);
    mockFeedbackNotesApi.create.mockResolvedValue(
      note({ id: "new", kind: "correction", content: "第 11 条", injection: "over_limit" }),
    );

    await render();

    const addButton = [...container.querySelectorAll("button")].find((button) =>
      button.getAttribute("aria-label")?.startsWith("新增一条「最近被纠正」"),
    )!;
    await act(() => addButton.click());
    await flushReact();

    const textarea = document.querySelector("textarea")!;
    await act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      )!.set!;
      setter.call(textarea, "第 11 条");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flushReact();

    const saveButton = [...document.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "保存",
    )!;
    await act(() => saveButton.click());
    await flushReact();

    expect(mockFeedbackNotesApi.create).toHaveBeenCalled();
    const toast = mockPushToast.mock.calls.at(-1)?.[0];
    expect(toast.title).not.toContain("下次会照做");
    expect(toast.title).toContain("暂时不会照做");
  });

  // The whole point of JIN-63: a 404 is an error, never a cue to invent notes.
  it("shows the error state when the request fails, and no demo data", async () => {
    mockFeedbackNotesApi.list.mockRejectedValue(new Error("Feedback note not found"));

    await render();

    expect(container.textContent).toContain("Feedback note not found");
    expect(container.textContent).not.toContain("演示数据");
    expect(container.querySelectorAll("li")).toHaveLength(0);
  });
});

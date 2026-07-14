import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@/lib/router";
import { Activity, ClipboardList, Package, Settings2, Users } from "lucide-react";
import { agentsApi } from "../api/agents";
import { issuesApi } from "../api/issues";
import { heartbeatsApi } from "../api/heartbeats";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { getAgentIcon } from "../lib/agent-icons";
import { timeAgo } from "../lib/timeAgo";
import { THINKING_EFFORT_LABELS, readAgentConfigDraft } from "../lib/agent-config-draft";
import type { ThinkingEffort } from "../lib/agent-config-draft";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { StatusBadge } from "../components/StatusBadge";
import { FeedbackNotesSection } from "../components/agent-home/FeedbackNotesSection";
import { Button } from "@/components/ui/button";

const OPEN_ISSUE_STATUSES = new Set(["todo", "in_progress", "in_review", "blocked"]);

export function AgentHome() {
  const { agentId = "" } = useParams<{ agentId: string }>();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  const agentQuery = useQuery({
    queryKey: queryKeys.agents.detail(agentId),
    queryFn: () => agentsApi.get(agentId, selectedCompanyId ?? undefined),
    enabled: Boolean(agentId) && Boolean(selectedCompanyId),
  });

  const agent = agentQuery.data;

  useEffect(() => {
    setBreadcrumbs([
      { label: "通讯录", href: "/directory" },
      { label: agent?.name ?? "员工" },
    ]);
  }, [setBreadcrumbs, agent?.name]);

  const issuesQuery = useQuery({
    queryKey: queryKeys.issues.list(selectedCompanyId!),
    queryFn: () => issuesApi.list(selectedCompanyId!, { assigneeAgentId: agent!.id }),
    enabled: Boolean(selectedCompanyId) && Boolean(agent),
  });

  const skillsQuery = useQuery({
    queryKey: queryKeys.agents.skills(agent?.id ?? ""),
    queryFn: () => agentsApi.skills(agent!.id, selectedCompanyId ?? undefined),
    enabled: Boolean(agent),
  });

  const runsQuery = useQuery({
    queryKey: queryKeys.heartbeats(selectedCompanyId!, agent?.id),
    queryFn: () => heartbeatsApi.list(selectedCompanyId!, agent!.id, 8, { summary: true }),
    enabled: Boolean(selectedCompanyId) && Boolean(agent),
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={Users} message="选择一个公司后查看员工主页。" />;
  }

  if (agentQuery.isLoading) {
    return <PageSkeleton variant="detail" />;
  }

  if (agentQuery.error || !agent) {
    return (
      <EmptyState
        icon={Users}
        message={(agentQuery.error as Error | null)?.message ?? "找不到这位员工。"}
      />
    );
  }

  const AgentIcon = getAgentIcon(agent.icon);
  const { model, effort } = readAgentConfigDraft(agent.adapterConfig);
  const issues = (issuesQuery.data ?? []).filter((issue) => OPEN_ISSUE_STATUSES.has(issue.status));
  const skills = (skillsQuery.data?.entries ?? []).filter((entry) => entry.desired);
  const runs = runsQuery.data ?? [];

  return (
    <div className="space-y-8">
      <header className="relative overflow-hidden rounded-2xl border border-border bg-gradient-to-br from-muted/60 to-card p-6 sm:p-8">
        <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex items-start gap-4">
            <span className="flex size-14 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-primary/20 to-primary/5 text-primary ring-1 ring-inset ring-primary/20">
              <AgentIcon className="size-7" aria-hidden />
            </span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-2xl font-semibold tracking-tight">{agent.name}</h1>
                <StatusBadge status={agent.status} />
              </div>
              <p className="mt-1 text-sm text-muted-foreground">
                {agent.title || "AI 员工"}
                {agent.capabilities ? ` · ${agent.capabilities}` : ""}
              </p>
              <dl className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
                <div className="flex gap-1.5">
                  <dt>模型</dt>
                  <dd className="font-medium text-foreground">{model || agent.adapterType}</dd>
                </div>
                <div className="flex gap-1.5">
                  <dt>思考强度</dt>
                  <dd className="font-medium text-foreground">
                    {effort ? THINKING_EFFORT_LABELS[effort as ThinkingEffort] : "适配器默认"}
                  </dd>
                </div>
                <div className="flex gap-1.5">
                  <dt>最近活跃</dt>
                  <dd className="font-medium text-foreground">
                    {agent.lastHeartbeatAt ? timeAgo(agent.lastHeartbeatAt) : "从未"}
                  </dd>
                </div>
              </dl>
            </div>
          </div>

          <Button asChild variant="outline" className="shrink-0">
            <Link to={`/directory/${encodeURIComponent(agentId)}/config`}>
              <Settings2 className="mr-1.5 size-4" aria-hidden />
              配置
            </Link>
          </Button>
        </div>
      </header>

      <FeedbackNotesSection
        agentId={agent.id}
        agentName={agent.name}
        companyId={selectedCompanyId}
      />

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel
          icon={ClipboardList}
          title="当前负责的任务"
          count={issues.length}
          empty="手上没有进行中的任务。"
          loading={issuesQuery.isLoading}
        >
          <ul className="divide-y divide-border">
            {issues.map((issue) => (
              <li key={issue.id}>
                <Link
                  to={`/issues/${issue.identifier ?? issue.id}`}
                  className="flex items-center justify-between gap-3 py-2.5 transition-colors hover:text-primary"
                >
                  <span className="min-w-0 flex-1 truncate text-sm">{issue.title}</span>
                  <StatusBadge status={issue.status} />
                </Link>
              </li>
            ))}
          </ul>
        </Panel>

        <Panel
          icon={Package}
          title="常用方法包"
          count={skills.length}
          empty="还没有绑定方法包。"
          loading={skillsQuery.isLoading}
        >
          <ul className="flex flex-wrap gap-2 pt-1">
            {skills.map((skill) => (
              <li
                key={skill.key}
                className="rounded-full border border-border bg-muted/40 px-2.5 py-1 text-xs text-foreground transition-colors hover:border-foreground/20"
                title={skill.detail ?? skill.locationLabel ?? undefined}
              >
                {skill.runtimeName ?? skill.key}
              </li>
            ))}
          </ul>
        </Panel>
      </div>

      <Panel
        icon={Activity}
        title="工作记录"
        count={runs.length}
        empty="还没有运行记录。"
        loading={runsQuery.isLoading}
      >
        <ul className="divide-y divide-border">
          {runs.map((run) => (
            <li key={run.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
              <div className="min-w-0">
                <p className="truncate text-foreground">
                  {run.invocationSource === "assignment"
                    ? "被指派任务"
                    : run.invocationSource === "timer"
                      ? "定时唤醒"
                      : run.invocationSource === "automation"
                        ? "自动化触发"
                        : "手动唤醒"}
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {timeAgo(run.startedAt ?? run.createdAt)}
                  {run.error ? ` · ${run.error}` : ""}
                </p>
              </div>
              <StatusBadge status={run.status} />
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}

interface PanelProps {
  icon: typeof Activity;
  title: string;
  count: number;
  empty: string;
  loading: boolean;
  children: React.ReactNode;
}

function Panel({ icon: Icon, title, count, empty, loading, children }: PanelProps) {
  return (
    <section className="rounded-xl border border-border bg-card p-5">
      <div className="mb-3 flex items-center gap-2">
        <Icon className="size-4 text-muted-foreground" aria-hidden />
        <h2 className="text-sm font-medium text-foreground">
          {title}
          <span className="ml-1.5 text-xs font-normal text-muted-foreground">{count}</span>
        </h2>
      </div>
      {loading ? (
        <p className="py-6 text-center text-sm text-muted-foreground">加载中…</p>
      ) : count === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">{empty}</p>
      ) : (
        children
      )}
    </section>
  );
}

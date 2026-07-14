import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@/lib/router";
import { ArrowLeft, History, RotateCcw, Users } from "lucide-react";
import type { AgentDetail } from "@paperclipai/shared";
import { agentsApi, type AgentPermissionUpdate } from "../api/agents";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToast } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { timeAgo } from "../lib/timeAgo";
import {
  THINKING_EFFORTS,
  THINKING_EFFORT_HINTS,
  THINKING_EFFORT_LABELS,
  buildAgentConfigPatch,
  readAgentConfigDraft,
  type AgentConfigDraft,
} from "../lib/agent-config-draft";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { AgentSkillsTab } from "./agent-skills/AgentSkillsTab";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { cn } from "../lib/utils";

const ADAPTER_DEFAULT = "__adapter_default__";

/** Empty string = leave `effort` unset, i.e. follow the adapter default. */
const EFFORT_OPTIONS: Array<{ value: AgentConfigDraft["effort"]; label: string; hint: string }> = [
  ...THINKING_EFFORTS.map((effort) => ({
    value: effort as AgentConfigDraft["effort"],
    label: THINKING_EFFORT_LABELS[effort],
    hint: THINKING_EFFORT_HINTS[effort],
  })),
  { value: "", label: "适配器默认", hint: "不写 effort,交给适配器决定" },
];

export function AgentConfig() {
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
      { label: agent?.name ?? "员工", href: `/directory/${encodeURIComponent(agentId)}` },
      { label: "配置" },
    ]);
  }, [setBreadcrumbs, agent?.name, agentId]);

  if (!selectedCompanyId) {
    return <EmptyState icon={Users} message="选择一个公司后配置员工。" />;
  }

  if (agentQuery.isLoading) return <PageSkeleton variant="detail" />;

  if (agentQuery.error || !agent) {
    return (
      <EmptyState
        icon={Users}
        message={(agentQuery.error as Error | null)?.message ?? "找不到这位员工。"}
      />
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <header className="space-y-2">
        <Link
          to={`/directory/${encodeURIComponent(agentId)}`}
          className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" aria-hidden />
          返回 {agent.name} 的主页
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">配置 {agent.name}</h1>
        {/*
          配置历史只版本化 CONFIG_REVISION_FIELDS(模型 / 思考强度 / 方法包等 adapterConfig,
          以及名称、角色、预算等字段)。指令正文与权限**不在其中**,回滚回不去 ——
          文案必须照实说,别承诺「随时回滚到任意一版」(JIN-80)。
        */}
        <p className="text-sm text-muted-foreground">
          模型、思考强度、方法包等 adapter 配置的每次改动都会写入配置历史,可以回滚到其中任意一版。指令正文与权限不走配置历史,回滚不会把它们带回来。
        </p>
      </header>

      <InstructionsSection agent={agent} companyId={selectedCompanyId} />
      <ModelSection agent={agent} companyId={selectedCompanyId} />

      <ConfigSection title="方法包" description="TA 干活时能调用的方法包(skills)。">
        <AgentSkillsTab agent={agent} companyId={selectedCompanyId} />
      </ConfigSection>

      <PermissionsSection agent={agent} companyId={selectedCompanyId} />
      <RevisionsSection agent={agent} companyId={selectedCompanyId} />
    </div>
  );
}

function ConfigSection({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-border bg-card p-6">
      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-medium text-foreground">{title}</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function InstructionsSection({ agent, companyId }: { agent: AgentDetail; companyId: string }) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const [draft, setDraft] = useState<string | null>(null);

  const bundleQuery = useQuery({
    queryKey: queryKeys.agents.instructionsBundle(agent.id),
    queryFn: () => agentsApi.instructionsBundle(agent.id, companyId),
  });

  const entryFile = bundleQuery.data?.entryFile ?? "";

  const fileQuery = useQuery({
    queryKey: queryKeys.agents.instructionsFile(agent.id, entryFile),
    queryFn: () => agentsApi.instructionsFile(agent.id, entryFile, companyId),
    enabled: Boolean(entryFile),
  });

  const saved = fileQuery.data?.content ?? "";
  const content = draft ?? saved;
  const dirty = draft !== null && draft !== saved;

  const save = useMutation({
    mutationFn: (next: string) =>
      agentsApi.saveInstructionsFile(agent.id, { path: entryFile, content: next }, companyId),
    onSuccess: async (detail) => {
      setDraft(null);
      queryClient.setQueryData(queryKeys.agents.instructionsFile(agent.id, entryFile), detail);
      await queryClient.invalidateQueries({
        queryKey: queryKeys.agents.instructionsBundle(agent.id),
      });
      pushToast({ title: "指令已更新", tone: "success" });
    },
    onError: (error: Error) => pushToast({ title: "保存失败", body: error.message, tone: "error" }),
  });

  const editable = bundleQuery.data?.editable !== false && fileQuery.data?.editable !== false;

  return (
    <ConfigSection
      title="指令(人格)"
      description={`TA 是谁、怎么干活 —— 写进 ${entryFile || "指令 bundle"}。`}
      action={
        <Button
          size="sm"
          disabled={!dirty || save.isPending || !editable}
          onClick={() => save.mutate(content)}
        >
          {save.isPending ? "保存中…" : "保存指令"}
        </Button>
      }
    >
      {fileQuery.isLoading ? (
        <p className="text-sm text-muted-foreground">加载中…</p>
      ) : (
        <>
          <Textarea
            value={content}
            onChange={(event) => setDraft(event.target.value)}
            rows={14}
            disabled={!editable}
            aria-label="指令内容"
            className="font-mono text-sm leading-relaxed"
          />
          {!editable && (
            <p className="mt-2 text-xs text-muted-foreground">
              这份指令来自外部 bundle,只能在源仓库里改。
            </p>
          )}
          {bundleQuery.data?.warnings?.map((warning) => (
            <p key={warning} className="mt-2 text-xs text-amber-600 dark:text-amber-400">
              {warning}
            </p>
          ))}
        </>
      )}
    </ConfigSection>
  );
}

function ModelSection({ agent, companyId }: { agent: AgentDetail; companyId: string }) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const savedDraft = useMemo(() => readAgentConfigDraft(agent.adapterConfig), [agent.adapterConfig]);
  const [draft, setDraft] = useState<AgentConfigDraft>(savedDraft);

  useEffect(() => {
    setDraft(savedDraft);
  }, [savedDraft]);

  const modelsQuery = useQuery({
    queryKey: queryKeys.agents.adapterModels(companyId, agent.adapterType),
    queryFn: () => agentsApi.adapterModels(companyId, agent.adapterType),
  });

  const patch = buildAgentConfigPatch(agent.adapterConfig, draft);

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => agentsApi.update(agent.id, body, companyId),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.id) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.urlKey) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.configRevisions(agent.id) }),
      ]);
      pushToast({ title: "模型配置已更新", tone: "success" });
    },
    onError: (error: Error) => pushToast({ title: "保存失败", body: error.message, tone: "error" }),
  });

  const models = modelsQuery.data ?? [];

  return (
    <ConfigSection
      title="模型与思考强度"
      description="换模型、调思考深度 —— 每次保存都会记一版配置历史。"
      action={
        <Button size="sm" disabled={!patch || save.isPending} onClick={() => patch && save.mutate(patch)}>
          {save.isPending ? "保存中…" : "保存"}
        </Button>
      }
    >
      <div className="space-y-5">
        <div className="space-y-1.5">
          <Label htmlFor="agent-model">模型</Label>
          <Input
            id="agent-model"
            list="agent-model-options"
            value={draft.model}
            onChange={(event) => setDraft({ ...draft, model: event.target.value })}
            placeholder={`留空则用 ${agent.adapterType} 适配器的默认模型`}
          />
          <datalist id="agent-model-options">
            {models.map((model) => (
              <option key={model.id} value={model.id}>
                {model.label}
              </option>
            ))}
          </datalist>
        </div>

        <fieldset className="space-y-1.5">
          <legend className="mb-1.5 text-sm font-medium">思考强度</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {EFFORT_OPTIONS.map((option) => {
              const selected = draft.effort === option.value;
              return (
                <button
                  key={option.value || ADAPTER_DEFAULT}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => setDraft({ ...draft, effort: option.value })}
                  className={cn(
                    "rounded-lg border p-3 text-left transition-[border-color,background-color] duration-150",
                    selected
                      ? "border-primary bg-primary/5"
                      : "border-border hover:border-foreground/20 hover:bg-muted/40",
                  )}
                >
                  <span className="block text-sm font-medium text-foreground">{option.label}</span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">{option.hint}</span>
                </button>
              );
            })}
          </div>
        </fieldset>
      </div>
    </ConfigSection>
  );
}

function PermissionsSection({ agent, companyId }: { agent: AgentDetail; companyId: string }) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();

  const save = useMutation({
    mutationFn: (update: AgentPermissionUpdate) =>
      agentsApi.updatePermissions(agent.id, update, companyId),
    onSuccess: async (detail) => {
      queryClient.setQueryData(queryKeys.agents.detail(agent.id), detail);
      await queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.urlKey) });
      pushToast({ title: "权限已更新", tone: "success" });
    },
    onError: (error: Error) => pushToast({ title: "保存失败", body: error.message, tone: "error" }),
  });

  // `permissions` lives on its own controlled route — PATCH /agents/:id cannot
  // touch it — so every toggle sends the full trio.
  const current: AgentPermissionUpdate = {
    canCreateAgents: agent.permissions.canCreateAgents ?? false,
    canCreateSkills: agent.permissions.canCreateSkills ?? false,
    canAssignTasks: agent.access.canAssignTasks,
  };

  const toggles: Array<{ key: keyof AgentPermissionUpdate; label: string; hint: string }> = [
    { key: "canAssignTasks", label: "派活给别人", hint: "可以把任务指派给其他同事" },
    { key: "canCreateAgents", label: "招人", hint: "可以创建新的 AI 员工" },
    { key: "canCreateSkills", label: "写方法包", hint: "可以创建与修改公司方法包" },
  ];

  return (
    <ConfigSection
      title="工具 / 权限"
      description="TA 能动哪些东西。权限改动立即生效,但不进配置历史 —— 回滚不会还原它。"
    >
      <ul className="divide-y divide-border">
        {toggles.map((toggle) => (
          <li key={toggle.key} className="flex items-center justify-between gap-4 py-3">
            <div>
              <p className="text-sm font-medium text-foreground">{toggle.label}</p>
              <p className="text-xs text-muted-foreground">{toggle.hint}</p>
            </div>
            <ToggleSwitch
              checked={Boolean(current[toggle.key])}
              disabled={save.isPending}
              aria-label={toggle.label}
              onCheckedChange={(checked) => save.mutate({ ...current, [toggle.key]: checked })}
            />
          </li>
        ))}
      </ul>
    </ConfigSection>
  );
}

function RevisionsSection({ agent, companyId }: { agent: AgentDetail; companyId: string }) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();

  const revisionsQuery = useQuery({
    queryKey: queryKeys.agents.configRevisions(agent.id),
    queryFn: () => agentsApi.listConfigRevisions(agent.id, companyId),
  });

  const rollback = useMutation({
    mutationFn: (revisionId: string) =>
      agentsApi.rollbackConfigRevision(agent.id, revisionId, companyId),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.id) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.urlKey) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.configRevisions(agent.id) }),
      ]);
      pushToast({ title: "已回滚到这一版配置", tone: "success" });
    },
    onError: (error: Error) => pushToast({ title: "回滚失败", body: error.message, tone: "error" }),
  });

  const revisions = revisionsQuery.data ?? [];

  return (
    <ConfigSection
      title="配置历史"
      description="每次 adapterConfig 变更(模型、思考强度、方法包等)都会自动留档,回滚只还原这些字段;指令正文与权限不在其中。"
    >
      {revisionsQuery.isLoading ? (
        <p className="text-sm text-muted-foreground">加载中…</p>
      ) : revisions.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">还没有配置变更记录。</p>
      ) : (
        <ol className="space-y-2">
          {revisions.map((revision) => (
            <li
              key={revision.id}
              className="flex items-center justify-between gap-4 rounded-lg border border-border p-3 transition-colors hover:border-foreground/15"
            >
              <div className="min-w-0">
                <p className="flex items-center gap-1.5 text-sm text-foreground">
                  <History className="size-3.5 text-muted-foreground" aria-hidden />
                  {revision.changedKeys.length > 0
                    ? revision.changedKeys.join("、")
                    : "无字段变更"}
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {timeAgo(revision.createdAt)} · 来源 {revision.source}
                  {revision.rolledBackFromRevisionId ? " · 回滚产生" : ""}
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                disabled={rollback.isPending}
                onClick={() => rollback.mutate(revision.id)}
              >
                <RotateCcw className="mr-1.5 size-3.5" aria-hidden />
                回滚
              </Button>
            </li>
          ))}
        </ol>
      )}
    </ConfigSection>
  );
}

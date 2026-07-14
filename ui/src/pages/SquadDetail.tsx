import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "@/lib/router";
import { Crown, Trash2, UserPlus, Users } from "lucide-react";
import { agentsApi } from "@/api/agents";
import { accessApi } from "@/api/access";
import { issuesApi } from "@/api/issues";
import {
  squadsApi,
  type AddSquadMemberInput,
  type DecideDispatchInput,
  type SquadDispatch,
  type SquadMember,
} from "@/api/collab";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useToast } from "@/context/ToastContext";
import { queryKeys } from "@/lib/queryKeys";
import { buildDispatchThreads, pendingDispatches, PrincipalNames } from "@/lib/squads";
import { timeAgo } from "@/lib/timeAgo";
import { AddSquadMemberDialog } from "@/components/squads/AddSquadMemberDialog";
import { DecideDispatchDialog } from "@/components/squads/DecideDispatchDialog";
import { DispatchThreadList } from "@/components/squads/DispatchThreadList";
import { EmptyState } from "@/components/EmptyState";
import { PageSkeleton } from "@/components/PageSkeleton";
import { Button } from "@/components/ui/button";

export function SquadDetail() {
  const { squadId = "" } = useParams<{ squadId: string }>();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();

  const [addOpen, setAddOpen] = useState(false);
  const [deciding, setDeciding] = useState<SquadDispatch | null>(null);

  const squadQuery = useQuery({
    queryKey: queryKeys.squads.detail(squadId),
    queryFn: () => squadsApi.get(squadId),
    enabled: !!squadId,
  });

  const membersQuery = useQuery({
    queryKey: queryKeys.squads.members(squadId),
    queryFn: () => squadsApi.members(squadId),
    enabled: !!squadId,
  });

  const dispatchesQuery = useQuery({
    queryKey: queryKeys.squads.dispatches(squadId),
    queryFn: () => squadsApi.dispatches(squadId),
    enabled: !!squadId,
  });

  const agentsQuery = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const companyMembersQuery = useQuery({
    queryKey: queryKeys.access.companyMembers(selectedCompanyId!),
    queryFn: () => accessApi.listMembers(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const issuesQuery = useQuery({
    queryKey: queryKeys.issues.listCompact(selectedCompanyId!),
    queryFn: () => issuesApi.listCompact(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const squad = squadQuery.data;

  useEffect(() => {
    setBreadcrumbs([{ label: "小队", href: "/squads" }, { label: squad?.name ?? "小队" }]);
  }, [setBreadcrumbs, squad?.name]);

  const names = useMemo(
    () =>
      new PrincipalNames({
        agents: agentsQuery.data ?? [],
        members: companyMembersQuery.data?.members ?? [],
      }),
    [agentsQuery.data, companyMembersQuery.data],
  );

  const issueTitles = useMemo(() => {
    const titles = new Map<string, string>();
    for (const issue of issuesQuery.data ?? []) titles.set(issue.id, issue.title);
    return titles;
  }, [issuesQuery.data]);

  const issueTitle = (issueId: string) => issueTitles.get(issueId) ?? `任务 ${issueId.slice(0, 8)}`;

  const members = useMemo(() => membersQuery.data ?? [], [membersQuery.data]);
  const dispatches = useMemo(() => dispatchesQuery.data ?? [], [dispatchesQuery.data]);
  const pending = useMemo(() => pendingDispatches(dispatches), [dispatches]);
  const threads = useMemo(() => buildDispatchThreads(dispatches), [dispatches]);

  const refreshMembers = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.squads.members(squadId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.squads.detail(squadId) }),
    ]);

  const addMember = useMutation({
    mutationFn: (input: AddSquadMemberInput) => squadsApi.addMember(squadId, input),
    onSuccess: async () => {
      setAddOpen(false);
      await refreshMembers();
      pushToast({ title: "队员已加入", tone: "success" });
    },
    onError: (error: Error) => pushToast({ title: "加入失败", body: error.message, tone: "error" }),
  });

  const removeMember = useMutation({
    mutationFn: (member: SquadMember) => squadsApi.removeMember(squadId, member.id),
    onSuccess: async () => {
      await refreshMembers();
      pushToast({ title: "队员已移出小队", tone: "success" });
    },
    onError: (error: Error) => pushToast({ title: "移出失败", body: error.message, tone: "error" }),
  });

  const decide = useMutation({
    mutationFn: ({ id, input }: { id: string; input: DecideDispatchInput }) =>
      squadsApi.decide(id, input),
    onSuccess: async (dispatch) => {
      setDeciding(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.squads.dispatches(squadId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(selectedCompanyId!) }),
      ]);
      pushToast({
        title: `已派给 ${names.assignee(dispatch) ?? "队员"}`,
        body: dispatch.decisionReason ?? undefined,
        tone: "success",
      });
    },
    onError: (error: Error) => pushToast({ title: "派单失败", body: error.message, tone: "error" }),
  });

  const decline = useMutation({
    mutationFn: (dispatch: SquadDispatch) =>
      squadsApi.decline(dispatch.id, { failureReason: "队长退回:小队目前没有合适的人。" }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.squads.dispatches(squadId) });
      pushToast({ title: "已退回这条派单", tone: "success" });
    },
    onError: (error: Error) => pushToast({ title: "退回失败", body: error.message, tone: "error" }),
  });

  if (squadQuery.isLoading) return <PageSkeleton variant="detail" />;
  if (squadQuery.error) {
    return <p className="text-sm text-destructive">{(squadQuery.error as Error).message}</p>;
  }
  if (!squad) return <EmptyState icon={Users} message="没有这支小队。" />;

  return (
    <div className="space-y-8">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{squad.name}</h1>
        {squad.description && <p className="text-sm text-muted-foreground">{squad.description}</p>}
        <p className="inline-flex items-center gap-1.5 pt-1 text-sm text-muted-foreground">
          <Crown className="size-3.5 text-amber-500" aria-hidden />
          队长:{squad.leaderAgentId ? names.agent(squad.leaderAgentId) : "还没有队长 —— 加一位 AI 员工当队长,派单才有人接"}
        </p>
      </header>

      <section aria-labelledby="squad-queue-heading" className="space-y-4">
        <div>
          <h2 id="squad-queue-heading" className="text-lg font-semibold tracking-tight">
            待决策
            <span className="ml-1.5 text-sm font-normal text-muted-foreground">
              {pending.length}
            </span>
          </h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            这些任务派到了小队,还没定给谁。
          </p>
        </div>

        {dispatchesQuery.isLoading ? (
          <PageSkeleton variant="list" />
        ) : dispatchesQuery.error ? (
          <p className="text-sm text-destructive">{(dispatchesQuery.error as Error).message}</p>
        ) : pending.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
            队列是空的 —— 没有等着决策的任务。
          </p>
        ) : (
          <ul className="space-y-2">
            {pending.map((dispatch) => (
              <li
                key={dispatch.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card p-4"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-foreground">
                    {issueTitle(dispatch.issueId)}
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {timeAgo(dispatch.createdAt)}派到小队
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={decline.isPending}
                    onClick={() => decline.mutate(dispatch)}
                  >
                    退回
                  </Button>
                  <Button size="sm" onClick={() => setDeciding(dispatch)}>
                    派给…
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="squad-roster-heading" className="space-y-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <h2 id="squad-roster-heading" className="text-lg font-semibold tracking-tight">
              队员
              <span className="ml-1.5 text-sm font-normal text-muted-foreground">
                {members.length}
              </span>
            </h2>
            <p className="mt-0.5 text-sm text-muted-foreground">AI 员工和真人在同一支队伍里。</p>
          </div>
          <Button variant="outline" size="sm" onClick={() => setAddOpen(true)}>
            <UserPlus className="size-3.5" aria-hidden />
            加队员
          </Button>
        </div>

        {members.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
            还没有队员。先加一位 AI 员工当队长。
          </p>
        ) : (
          <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {members.map((member) => (
              <li
                key={member.id}
                className="group flex items-center justify-between gap-2 rounded-lg border border-border bg-card px-4 py-3"
              >
                <div className="min-w-0">
                  <p className="flex items-center gap-1.5 truncate text-sm font-medium text-foreground">
                    {names.member(member)}
                    {member.role === "leader" && (
                      <Crown className="size-3.5 shrink-0 text-amber-500" aria-label="队长" />
                    )}
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {member.memberType === "agent" ? "AI 员工" : "真人"}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={removeMember.isPending}
                  onClick={() => removeMember.mutate(member)}
                  aria-label={`把 ${names.member(member)} 移出小队`}
                  className="shrink-0 text-muted-foreground opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
                >
                  <Trash2 className="size-3.5" aria-hidden />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="squad-chain-heading" className="space-y-4">
        <div>
          <h2 id="squad-chain-heading" className="text-lg font-semibold tracking-tight">
            派单决策链
          </h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            每条任务落到谁手里,以及队长为什么这么派。改派会接在链上,原来的决策留着。
          </p>
        </div>

        {threads.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
            还没有派单记录。把任务的负责小队设成这支队伍,队长就会收到第一条。
          </p>
        ) : (
          <DispatchThreadList
            threads={threads}
            names={names}
            issueTitle={issueTitle}
            onReassign={setDeciding}
          />
        )}
      </section>

      <AddSquadMemberDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        agents={agentsQuery.data ?? []}
        members={companyMembersQuery.data?.members ?? []}
        existing={members}
        onSubmit={addMember.mutate}
        submitting={addMember.isPending}
      />

      <DecideDispatchDialog
        dispatch={deciding}
        members={members}
        names={names}
        issueTitle={deciding ? issueTitle(deciding.issueId) : ""}
        onOpenChange={(open) => !open && setDeciding(null)}
        onDecide={(id, input) => decide.mutate({ id, input })}
        submitting={decide.isPending}
      />
    </div>
  );
}

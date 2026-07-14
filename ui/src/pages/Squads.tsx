import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import { Crown, Plus, Users } from "lucide-react";
import { agentsApi } from "@/api/agents";
import { squadsApi, type CreateSquadInput } from "@/api/collab";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useToast } from "@/context/ToastContext";
import { queryKeys } from "@/lib/queryKeys";
import { PrincipalNames } from "@/lib/squads";
import { CreateSquadDialog } from "@/components/squads/CreateSquadDialog";
import { EmptyState } from "@/components/EmptyState";
import { PageSkeleton } from "@/components/PageSkeleton";
import { Button } from "@/components/ui/button";

export function Squads() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);

  useEffect(() => {
    setBreadcrumbs([{ label: "小队" }]);
  }, [setBreadcrumbs]);

  const squadsQuery = useQuery({
    queryKey: queryKeys.squads.list(selectedCompanyId!),
    queryFn: () => squadsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const agentsQuery = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const createSquad = useMutation({
    mutationFn: (input: CreateSquadInput) => squadsApi.create(selectedCompanyId!, input),
    onSuccess: async (squad) => {
      setCreateOpen(false);
      await queryClient.invalidateQueries({
        queryKey: queryKeys.squads.list(selectedCompanyId!),
      });
      pushToast({ title: `${squad.name} 建好了`, body: "接下来给它加队员。", tone: "success" });
    },
    onError: (error: Error) => pushToast({ title: "建队失败", body: error.message, tone: "error" }),
  });

  const names = useMemo(
    () => new PrincipalNames({ agents: agentsQuery.data ?? [] }),
    [agentsQuery.data],
  );

  if (!selectedCompanyId) {
    return <EmptyState icon={Users} message="选择一个公司后查看小队。" />;
  }

  const squads = squadsQuery.data ?? [];

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">小队</h1>
          <p className="text-sm text-muted-foreground">
            任务派给小队,队长决定给谁干 —— 并把理由留在链上。
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="size-4" aria-hidden />
          建一支小队
        </Button>
      </header>

      {squadsQuery.isLoading ? (
        <PageSkeleton variant="list" />
      ) : squadsQuery.error ? (
        <p className="text-sm text-destructive">{(squadsQuery.error as Error).message}</p>
      ) : squads.length === 0 ? (
        <EmptyState icon={Users} message="还没有小队。建一支,把活派给它。" />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {squads.map((squad) => (
            <Link
              key={squad.id}
              to={`/squads/${encodeURIComponent(squad.id)}`}
              className="group flex flex-col gap-3 rounded-xl border border-border bg-card p-5 transition-[transform,box-shadow,border-color] duration-200 ease-out hover:-translate-y-0.5 hover:border-foreground/20 hover:shadow-lg hover:shadow-foreground/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background motion-reduce:transition-none motion-reduce:hover:translate-y-0"
            >
              <div className="flex items-start justify-between gap-2">
                <h2 className="font-medium text-foreground">{squad.name}</h2>
                {squad.status === "archived" && (
                  <span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
                    已归档
                  </span>
                )}
              </div>

              {squad.description && (
                <p className="line-clamp-2 text-sm text-muted-foreground">{squad.description}</p>
              )}

              <p className="mt-auto inline-flex items-center gap-1.5 text-sm text-muted-foreground">
                <Crown className="size-3.5 text-amber-500" aria-hidden />
                {squad.leaderAgentId ? names.agent(squad.leaderAgentId) : "还没有队长"}
              </p>
            </Link>
          ))}
        </div>
      )}

      <CreateSquadDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        agents={agentsQuery.data ?? []}
        onSubmit={createSquad.mutate}
        submitting={createSquad.isPending}
      />
    </div>
  );
}

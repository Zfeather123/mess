import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Search, Users } from "lucide-react";
import { agentsApi } from "../api/agents";
import { accessApi } from "../api/access";
import { squadsApi } from "../api/collab";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import {
  buildDirectoryEntries,
  filterDirectoryEntries,
  type DirectoryKindFilter,
} from "../lib/directory";
import { cn } from "../lib/utils";
import { DirectoryCard } from "../components/directory/DirectoryCard";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { Input } from "@/components/ui/input";

const KIND_TABS: Array<{ value: DirectoryKindFilter; label: string }> = [
  { value: "all", label: "全部" },
  { value: "agent", label: "AI 员工" },
  { value: "user", label: "真人" },
];

const ALL_SQUADS = "__all__";

export function Directory() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<DirectoryKindFilter>("all");
  const [squadId, setSquadId] = useState<string>(ALL_SQUADS);

  useEffect(() => {
    setBreadcrumbs([{ label: "通讯录" }]);
  }, [setBreadcrumbs]);

  const agentsQuery = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const membersQuery = useQuery({
    queryKey: queryKeys.access.companyMembers(selectedCompanyId!),
    queryFn: () => accessApi.listMembers(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const squadsQuery = useQuery({
    queryKey: queryKeys.squads.list(selectedCompanyId!),
    queryFn: () => squadsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const squads = squadsQuery.data ?? [];
  const activeSquadId = squadId === ALL_SQUADS ? null : squadId;

  const squadMembersQuery = useQuery({
    queryKey: queryKeys.squads.members(activeSquadId ?? ""),
    queryFn: () => squadsApi.members(activeSquadId!),
    enabled: !!activeSquadId,
  });

  const entries = useMemo(
    () =>
      buildDirectoryEntries({
        agents: agentsQuery.data ?? [],
        members: membersQuery.data?.members ?? [],
        squadMembers: activeSquadId ? squadMembersQuery.data ?? [] : null,
      }),
    [agentsQuery.data, membersQuery.data, activeSquadId, squadMembersQuery.data],
  );

  const visible = useMemo(
    () => filterDirectoryEntries(entries, { query, kind }),
    [entries, query, kind],
  );

  if (!selectedCompanyId) {
    return <EmptyState icon={Users} message="选择一个公司后查看通讯录。" />;
  }

  if (agentsQuery.isLoading || membersQuery.isLoading) {
    return <PageSkeleton variant="list" />;
  }

  // A squad that 404s (deleted while the page was open) must say so — silently
  // widening back to the whole company would answer a question nobody asked.
  const error =
    agentsQuery.error ?? membersQuery.error ?? squadsQuery.error ?? squadMembersQuery.error;
  const agentCount = entries.filter((entry) => entry.kind === "agent").length;
  const userCount = entries.length - agentCount;

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">通讯录</h1>
        <p className="text-sm text-muted-foreground">
          团队里的每一位同事 —— {agentCount} 位 AI 员工,{userCount} 位真人协作者。
        </p>
      </header>

      {error && <p className="text-sm text-destructive">{error.message}</p>}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="inline-flex rounded-lg border border-border bg-muted/40 p-0.5">
          {KIND_TABS.map((tab) => (
            <button
              key={tab.value}
              type="button"
              onClick={() => setKind(tab.value)}
              aria-pressed={kind === tab.value}
              className={cn(
                "rounded-md px-3 py-1.5 text-sm transition-colors duration-150",
                kind === tab.value
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2">
          {squads.length > 0 && (
            <select
              value={squadId}
              onChange={(event) => setSquadId(event.target.value)}
              aria-label="按小队筛选"
              className="h-9 rounded-md border border-border bg-background px-2.5 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <option value={ALL_SQUADS}>全部小队</option>
              {squads.map((squad) => (
                <option key={squad.id} value={squad.id}>
                  {squad.name}
                </option>
              ))}
            </select>
          )}
          <div className="relative w-full sm:w-64">
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索姓名、职位、邮箱"
              aria-label="搜索通讯录"
              className="pl-8"
            />
          </div>
        </div>
      </div>

      {visible.length === 0 ? (
        <EmptyState icon={Users} message="没有匹配的同事。" />
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {visible.map((entry) => (
            <DirectoryCard key={entry.key} entry={entry} />
          ))}
        </div>
      )}
    </div>
  );
}

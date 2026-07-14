import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Search, Store, UserPlus } from "lucide-react";
import type { CreateAgentTemplate, EmployeeCard } from "@paperclipai/shared";
import { employeeMarketApi } from "@/api/employee-market";
import { companySkillsApi } from "@/api/companySkills";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useToast } from "@/context/ToastContext";
import { queryKeys } from "@/lib/queryKeys";
import { buildMarketTabs, cardKey, filterMarketCards, type MarketTab } from "@/lib/employee-market";
import { cn } from "@/lib/utils";
import { CustomEmployeeDialog } from "@/components/market/CustomEmployeeDialog";
import { EmployeeMarketCard } from "@/components/market/EmployeeMarketCard";
import { EmptyState } from "@/components/EmptyState";
import { PageSkeleton } from "@/components/PageSkeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * 招聘市场. Both supply sources — 操盘手预制 and 用户自定义 — arrive as one
 * `EmployeeCard[]`, so this page never asks which store a card came out of.
 */
export function EmployeeMarket() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();

  const [tab, setTab] = useState<MarketTab>("all");
  const [query, setQuery] = useState("");
  const [customOpen, setCustomOpen] = useState(false);
  const [hiringKey, setHiringKey] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "招聘市场" }]);
  }, [setBreadcrumbs]);

  const marketQuery = useQuery({
    queryKey: queryKeys.employeeMarket.list(selectedCompanyId!),
    queryFn: () => employeeMarketApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  // Only needed once the author dialog is open — the market itself does not use it.
  const skillsQuery = useQuery({
    queryKey: queryKeys.companySkills.list(selectedCompanyId!),
    queryFn: () => companySkillsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId && customOpen,
  });

  const refreshMarket = () =>
    Promise.all([
      queryClient.invalidateQueries({
        queryKey: queryKeys.employeeMarket.list(selectedCompanyId!),
      }),
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(selectedCompanyId!) }),
    ]);

  const hire = useMutation({
    mutationFn: (card: EmployeeCard) =>
      employeeMarketApi.hire(selectedCompanyId!, { source: card.source, refId: card.refId }),
    onMutate: (card: EmployeeCard) => setHiringKey(cardKey(card)),
    onSuccess: async (result, card) => {
      await refreshMarket();
      // Warnings (an uninstalled method pack, say) are the difference between a
      // colleague who can do the job and one who cannot — they lead the toast.
      const body = result.warnings.length
        ? result.warnings.join(" · ")
        : result.requiresApproval
          ? "等审批通过就能开工。"
          : "去通讯录里看看 TA。";
      pushToast({
        title: result.requiresApproval ? `${card.name} 已入职,待审批激活` : `${card.name} 入职了`,
        body,
        tone: result.warnings.length ? "warn" : "success",
      });
    },
    onError: (error: Error) => pushToast({ title: "招募失败", body: error.message, tone: "error" }),
    onSettled: () => setHiringKey(null),
  });

  const createTemplate = useMutation({
    mutationFn: (input: CreateAgentTemplate) =>
      employeeMarketApi.createTemplate(selectedCompanyId!, input),
    onSuccess: async (card) => {
      setCustomOpen(false);
      await refreshMarket();
      pushToast({
        title: `${card.name} 已存为模板`,
        body: "现在可以从市场把 TA 招进来了。",
        tone: "success",
      });
    },
    onError: (error: Error) => pushToast({ title: "保存失败", body: error.message, tone: "error" }),
  });

  const cards = useMemo(() => marketQuery.data ?? [], [marketQuery.data]);
  const tabs = useMemo(() => buildMarketTabs(cards), [cards]);
  const visible = useMemo(() => filterMarketCards(cards, { tab, query }), [cards, tab, query]);

  if (!selectedCompanyId) {
    return <EmptyState icon={Store} message="选择一个公司后逛市场。" />;
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">招聘市场</h1>
          <p className="text-sm text-muted-foreground">
            挑一位同事,让 TA 明天就上班 —— 现成的直接招,想要的没有就自己做一个。
          </p>
        </div>
        <Button onClick={() => setCustomOpen(true)}>
          <UserPlus className="size-4" aria-hidden />
          自定义一位
        </Button>
      </header>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div
          className="inline-flex flex-wrap rounded-lg border border-border bg-muted/40 p-0.5"
          role="tablist"
          aria-label="员工分类"
        >
          {tabs.map((item) => (
            <button
              key={item.value}
              type="button"
              role="tab"
              aria-selected={tab === item.value}
              onClick={() => setTab(item.value)}
              className={cn(
                "rounded-md px-3 py-1.5 text-sm transition-colors duration-150",
                tab === item.value
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {item.label}
              <span className="ml-1.5 text-xs text-muted-foreground">{item.count}</span>
            </button>
          ))}
        </div>

        <div className="relative w-full sm:w-64">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索名字、职责、方法包"
            aria-label="搜索员工市场"
            className="pl-8"
          />
        </div>
      </div>

      {marketQuery.isLoading ? (
        <PageSkeleton variant="list" />
      ) : marketQuery.error ? (
        <p className="text-sm text-destructive">
          市场没打开:{(marketQuery.error as Error).message}
        </p>
      ) : visible.length === 0 ? (
        <EmptyState
          icon={Store}
          message={
            cards.length === 0
              ? "市场里还没有人。自定义一位,TA 就是你们的一号员工。"
              : "没有匹配的员工。"
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {visible.map((card) => (
            <EmployeeMarketCard
              key={cardKey(card)}
              card={card}
              onHire={hire.mutate}
              hiring={hiringKey === cardKey(card)}
            />
          ))}
        </div>
      )}

      <CustomEmployeeDialog
        open={customOpen}
        onOpenChange={setCustomOpen}
        skills={skillsQuery.data ?? []}
        onSubmit={createTemplate.mutate}
        submitting={createTemplate.isPending}
      />
    </div>
  );
}

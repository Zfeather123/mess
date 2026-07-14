import { ArrowUpRight, Check, RefreshCw, Sparkles, UserRound } from "lucide-react";
import type { EmployeeCard } from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

const SOURCE_LABELS: Record<EmployeeCard["source"], string> = {
  preset: "操盘手预制",
  custom: "自己做的",
};

interface EmployeeMarketCardProps {
  card: EmployeeCard;
  onHire: (card: EmployeeCard) => void;
  hiring: boolean;
}

/**
 * A colleague, not a config row. The card leads with a face and what they are
 * here to do; the method packs they carry are their credentials. The hire button
 * is the only control — until you reach for it, the card is somebody to read.
 */
export function EmployeeMarketCard({ card, onHire, hiring }: EmployeeMarketCardProps) {
  const hiredAgentId = card.hiredAgentIds[0] ?? null;

  return (
    <article
      className={cn(
        "group relative flex flex-col gap-4 rounded-xl border border-border bg-card p-5",
        "transition-[transform,box-shadow,border-color] duration-200 ease-out",
        "hover:-translate-y-0.5 hover:border-foreground/20 hover:shadow-lg hover:shadow-foreground/5",
        "motion-reduce:transition-none motion-reduce:hover:translate-y-0",
      )}
    >
      <div className="flex items-start gap-3.5">
        {card.avatarUrl ? (
          <img
            src={card.avatarUrl}
            alt=""
            className="size-11 shrink-0 rounded-lg object-cover ring-1 ring-inset ring-border"
          />
        ) : (
          <span className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-primary/15 to-primary/5 text-primary ring-1 ring-inset ring-primary/15">
            <UserRound className="size-5" aria-hidden />
          </span>
        )}

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <h3 className="truncate font-medium text-foreground">{card.name}</h3>
            {card.source === "custom" && (
              <Sparkles
                className="size-3.5 shrink-0 text-primary"
                aria-label={SOURCE_LABELS.custom}
              />
            )}
          </div>
          <p className="mt-0.5 truncate text-sm text-muted-foreground">
            {card.title || card.role}
          </p>
        </div>

        {card.hired && (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:text-emerald-400">
            <Check className="size-3" aria-hidden />
            已在团队
          </span>
        )}
      </div>

      {card.description && (
        <p className="line-clamp-3 text-sm leading-relaxed text-foreground/80">
          {card.description}
        </p>
      )}

      {card.methodTags.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label="方法包">
          {card.methodTags.map((tag) => (
            <li
              key={tag.key}
              // An unresolved pack is declared by the template but not installed in
              // this company — say so on the card, not after the hire fails.
              title={tag.kind === "unresolved" ? "公司方法包库里还没有这一个" : undefined}
              className={cn(
                "rounded-md px-1.5 py-0.5 text-xs",
                tag.kind === "unresolved"
                  ? "border border-dashed border-border text-muted-foreground"
                  : "bg-muted text-muted-foreground",
              )}
            >
              {tag.name}
            </li>
          ))}
        </ul>
      )}

      {card.outOfDate && (
        <p className="inline-flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400">
          <RefreshCw className="size-3" aria-hidden />
          模板已更新 —— 已招的这位还是入职时的版本
        </p>
      )}

      <div className="mt-auto flex items-center justify-between gap-2 border-t border-border pt-4">
        <span className="text-xs text-muted-foreground">{SOURCE_LABELS[card.source]}</span>

        {card.hired ? (
          hiredAgentId && (
            <Link
              to={`/directory/${encodeURIComponent(hiredAgentId)}`}
              className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
              看主页
              <ArrowUpRight className="size-3.5" aria-hidden />
            </Link>
          )
        ) : (
          <Button
            size="sm"
            disabled={hiring}
            onClick={() => onHire(card)}
            aria-label={`招募 ${card.name}`}
          >
            {hiring ? "入职中…" : "招一个"}
          </Button>
        )}
      </div>
    </article>
  );
}

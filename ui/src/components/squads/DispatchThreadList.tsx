import { Link } from "@/lib/router";
import { CornerDownRight } from "lucide-react";
import type { SquadDispatch } from "@/api/collab-types";
import { DISPATCH_STATE_LABELS, describeDecision, type DispatchThread } from "@/lib/squads";
import type { PrincipalNames } from "@/lib/squads";
import { timeAgo } from "@/lib/timeAgo";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

const STATE_TONE: Record<SquadDispatch["state"], string> = {
  pending: "bg-amber-500",
  dispatched: "bg-emerald-500",
  completed: "bg-sky-500",
  reassigned: "bg-muted-foreground/40",
  declined: "bg-destructive",
  failed: "bg-destructive",
};

interface DispatchThreadListProps {
  threads: readonly DispatchThread[];
  names: PrincipalNames;
  issueTitle: (issueId: string) => string;
  onReassign: (dispatch: SquadDispatch) => void;
}

/**
 * 派单决策链. Each issue is one chain, read top to bottom: a reassignment appends
 * a link rather than rewriting the last one, so the earlier decision — and the
 * reason behind it — stays legible.
 *
 * The leader's reason is body copy, not metadata. It is the answer to the
 * question the user actually has: 为什么这活落在 TA 手里.
 */
export function DispatchThreadList({
  threads,
  names,
  issueTitle,
  onReassign,
}: DispatchThreadListProps) {
  return (
    <ul className="space-y-3">
      {threads.map((thread) => (
        <li key={thread.issueId} className="rounded-xl border border-border bg-card p-4">
          <div className="flex items-start justify-between gap-3">
            <Link
              to={`/issues/${encodeURIComponent(thread.issueId)}`}
              className="min-w-0 flex-1 text-sm font-medium text-foreground transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
              {issueTitle(thread.issueId)}
            </Link>
            {thread.latest.state === "dispatched" && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onReassign(thread.latest)}
                className="shrink-0 text-muted-foreground"
              >
                改派
              </Button>
            )}
          </div>

          <ol className="mt-3 space-y-3">
            {thread.dispatches.map((dispatch, index) => {
              const superseded = dispatch.state === "reassigned";
              const sentence = describeDecision(dispatch, names);
              return (
                <li key={dispatch.id} className="flex gap-2.5">
                  <div className="flex flex-col items-center pt-1.5">
                    <span
                      className={cn("size-2 shrink-0 rounded-full", STATE_TONE[dispatch.state])}
                      aria-hidden
                    />
                    {index < thread.dispatches.length - 1 && (
                      <span className="mt-1 w-px flex-1 bg-border" aria-hidden />
                    )}
                  </div>

                  <div className={cn("min-w-0 flex-1", superseded && "opacity-60")}>
                    <p
                      className={cn(
                        "text-sm leading-relaxed",
                        sentence ? "text-foreground" : "text-muted-foreground",
                      )}
                    >
                      {sentence ?? "任务已派给小队,等队长决定给谁。"}
                    </p>
                    <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                      <span>{DISPATCH_STATE_LABELS[dispatch.state]}</span>
                      <span aria-hidden>·</span>
                      <span>{timeAgo(dispatch.decidedAt ?? dispatch.createdAt)}</span>
                      {superseded && (
                        <span className="inline-flex items-center gap-1">
                          <CornerDownRight className="size-3" aria-hidden />
                          后面改派了
                        </span>
                      )}
                    </p>
                  </div>
                </li>
              );
            })}
          </ol>
        </li>
      ))}
    </ul>
  );
}

import { Link } from "@/lib/router";
import { Crown, Mail } from "lucide-react";
import { getAgentIcon } from "@/lib/agent-icons";
import { cn } from "@/lib/utils";
import type { DirectoryEntry } from "@/lib/directory";

const AGENT_STATUS_LABELS: Record<string, string> = {
  active: "在岗",
  paused: "已暂停",
  error: "异常",
  pending: "待入职",
  onboarding: "入职中",
};

const USER_STATUS_LABELS: Record<string, string> = {
  active: "在职",
  pending: "待加入",
  suspended: "已停用",
};

function statusTone(entry: DirectoryEntry): string {
  if (entry.status === "error") return "bg-destructive";
  if (entry.status === "paused" || entry.status === "suspended") return "bg-muted-foreground/50";
  if (entry.status === "active") return "bg-emerald-500";
  return "bg-amber-500";
}

function statusLabel(entry: DirectoryEntry): string {
  const labels = entry.kind === "agent" ? AGENT_STATUS_LABELS : USER_STATUS_LABELS;
  return labels[entry.status] ?? entry.status;
}

function initials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "?";
  // CJK names read best as their last two characters; latin ones as initials.
  if (/[一-龥]/.test(trimmed)) return trimmed.slice(-2);
  return trimmed
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

export function DirectoryCard({ entry }: { entry: DirectoryEntry }) {
  const AgentIcon = getAgentIcon(entry.icon);

  return (
    <Link
      to={entry.href}
      className={cn(
        "group relative flex flex-col gap-4 rounded-xl border border-border bg-card p-5",
        "transition-[transform,box-shadow,border-color] duration-200 ease-out",
        "hover:-translate-y-0.5 hover:border-foreground/20 hover:shadow-lg hover:shadow-foreground/5",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        "motion-reduce:transition-none motion-reduce:hover:translate-y-0",
      )}
    >
      <div className="flex items-start gap-3.5">
        <div className="relative shrink-0">
          {entry.kind === "agent" ? (
            <span className="flex size-11 items-center justify-center rounded-lg bg-gradient-to-br from-primary/15 to-primary/5 text-primary ring-1 ring-inset ring-primary/15">
              <AgentIcon className="size-5" aria-hidden />
            </span>
          ) : entry.imageUrl ? (
            <img
              src={entry.imageUrl}
              alt=""
              className="size-11 rounded-full object-cover ring-1 ring-inset ring-border"
            />
          ) : (
            <span className="flex size-11 items-center justify-center rounded-full bg-muted text-sm font-medium text-muted-foreground ring-1 ring-inset ring-border">
              {initials(entry.name)}
            </span>
          )}
          <span
            className={cn(
              "absolute -bottom-0.5 -right-0.5 size-3 rounded-full ring-2 ring-card",
              statusTone(entry),
            )}
            aria-hidden
          />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <p className="truncate font-medium text-foreground">{entry.name}</p>
            {entry.squadRole === "leader" && (
              <Crown className="size-3.5 shrink-0 text-amber-500" aria-label="队长" />
            )}
          </div>
          <p className="mt-0.5 truncate text-sm text-muted-foreground">
            {entry.title || (entry.kind === "agent" ? "AI 员工" : "协作者")}
          </p>
        </div>
      </div>

      <div className="flex items-center justify-between text-xs">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-border px-2 py-0.5 text-muted-foreground">
          <span className={cn("size-1.5 rounded-full", statusTone(entry))} aria-hidden />
          {statusLabel(entry)}
        </span>
        <span className="inline-flex items-center gap-1 text-muted-foreground">
          {entry.kind === "agent" ? (
            "AI 员工"
          ) : entry.email ? (
            <>
              <Mail className="size-3" aria-hidden />
              <span className="max-w-[10rem] truncate">{entry.email}</span>
            </>
          ) : (
            "真人"
          )}
        </span>
      </div>
    </Link>
  );
}

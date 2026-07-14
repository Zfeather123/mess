import { Archive, Globe, Hash, Repeat2, ZapOff } from "lucide-react";
import type { FeedbackNote } from "@/api/collab-types";
import { feedbackNoteEffect, feedbackScopeLabel, feedbackSourceLabel } from "@/lib/feedback-notes";
import { timeAgo } from "@/lib/timeAgo";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

interface FeedbackNoteCardProps {
  note: FeedbackNote;
  onArchive: (note: FeedbackNote) => void;
  archiving: boolean;
  /** Corrections and reminders are tinted differently so the two never blur together. */
  tone: "correction" | "reminder";
  /** Scope id → display name, so a scoped note names its project instead of a uuid. */
  scopeNames?: ReadonlyMap<string, string>;
}

const TONE_STYLES: Record<FeedbackNoteCardProps["tone"], string> = {
  correction: "border-l-rose-400 dark:border-l-rose-500/70",
  reminder: "border-l-amber-400 dark:border-l-amber-500/70",
};

export function FeedbackNoteCard({
  note,
  onArchive,
  archiving,
  tone,
  scopeNames,
}: FeedbackNoteCardProps) {
  const ScopeIcon = note.scopeType === "global" ? Globe : Hash;
  // A note that never reaches the prompt must not look like one that does: it loses the
  // kind tint, greys out, and says why — in text, not by colour alone.
  const effect = feedbackNoteEffect(note);

  return (
    <li
      className={cn(
        "group rounded-lg border border-l-2 border-border bg-card p-4",
        "transition-[border-color,box-shadow] duration-200 hover:border-foreground/15 hover:shadow-sm",
        effect.effective ? TONE_STYLES[tone] : "border-l-border border-dashed bg-muted/30",
      )}
    >
      {effect.label ? (
        <div className="mb-2">
          <p className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-foreground/80">
            <ZapOff className="size-3" aria-hidden />
            {effect.label}
          </p>
          {effect.hint ? (
            <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{effect.hint}</p>
          ) : null}
        </div>
      ) : null}

      <div className="flex items-start justify-between gap-3">
        <p
          className={cn(
            "text-sm leading-relaxed",
            effect.effective ? "text-foreground" : "text-muted-foreground",
          )}
        >
          {note.content}
        </p>
        <Button
          variant="ghost"
          size="sm"
          disabled={archiving}
          onClick={() => onArchive(note)}
          aria-label={`归档这条笔记:${note.content.slice(0, 20)}`}
          className="shrink-0 text-muted-foreground opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
        >
          <Archive className="size-3.5" aria-hidden />
        </Button>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5">
          <ScopeIcon className="size-3" aria-hidden />
          {feedbackScopeLabel(note, scopeNames)}
        </span>
        <span title="来源">来自 {feedbackSourceLabel(note)}</span>
        <span aria-hidden>·</span>
        <span>{timeAgo(note.createdAt)}</span>
        <span
          className="ml-auto inline-flex items-center gap-1"
          title={
            note.lastAppliedAt
              ? `最近一次生效:${timeAgo(note.lastAppliedAt)}`
              : "还没有被应用过"
          }
        >
          <Repeat2 className="size-3" aria-hidden />
          已应用 {note.timesApplied} 次
        </span>
      </div>
    </li>
  );
}

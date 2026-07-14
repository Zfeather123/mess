import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BellRing, Plus, SpellCheck2 } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { feedbackNotesApi } from "@/api/collab";
import type { CreateFeedbackNoteInput, FeedbackNote, FeedbackNoteKind } from "@/api/collab-types";
import { projectsApi } from "@/api/projects";
import { useToast } from "@/context/ToastContext";
import { groupFeedbackNotes } from "@/lib/feedback-notes";
import { queryKeys } from "@/lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { AddFeedbackNoteDialog } from "./AddFeedbackNoteDialog";
import { FeedbackNoteCard } from "./FeedbackNoteCard";

interface FeedbackNotesSectionProps {
  agentId: string;
  agentName: string;
  companyId: string;
}

export function FeedbackNotesSection({ agentId, agentName, companyId }: FeedbackNotesSectionProps) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const [dialogKind, setDialogKind] = useState<FeedbackNoteKind | null>(null);

  const notesQuery = useQuery({
    queryKey: queryKeys.feedbackNotes.list(agentId),
    queryFn: () => feedbackNotesApi.list(agentId),
  });

  const projectsQuery = useQuery({
    queryKey: queryKeys.projects.list(companyId),
    queryFn: () => projectsApi.list(companyId),
  });

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: queryKeys.feedbackNotes.list(agentId) });

  const createNote = useMutation({
    mutationFn: (input: CreateFeedbackNoteInput) => feedbackNotesApi.create(agentId, input),
    onSuccess: async () => {
      setDialogKind(null);
      await invalidate();
      pushToast({ title: `已记下,${agentName} 下次会照做`, tone: "success" });
    },
    onError: (error: Error) => pushToast({ title: "保存失败", body: error.message, tone: "error" }),
  });

  const archiveNote = useMutation({
    mutationFn: (note: FeedbackNote) => feedbackNotesApi.archive(note.id),
    onSuccess: async () => {
      await invalidate();
      pushToast({ title: "已归档,不再进入提示词", tone: "success" });
    },
    onError: (error: Error) => pushToast({ title: "归档失败", body: error.message, tone: "error" }),
  });

  const notes = notesQuery.data?.data ?? [];
  const grouped = useMemo(() => groupFeedbackNotes(notes), [notes]);
  const isMock = notesQuery.data?.mock ?? false;

  return (
    <section aria-labelledby="feedback-notes-heading" className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 id="feedback-notes-heading" className="text-lg font-semibold tracking-tight">
            TA 学到的东西
          </h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            纠正与提醒会按权重进入系统提示词 —— 说过一次,下次就记得。
          </p>
        </div>
        {isMock && (
          <span className="rounded-full border border-dashed border-border px-2 py-0.5 text-xs text-muted-foreground">
            接口未就绪 · 演示数据
          </span>
        )}
      </div>

      {notesQuery.isLoading ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      ) : notesQuery.error ? (
        <p className="text-sm text-destructive">{(notesQuery.error as Error).message}</p>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <NoteColumn
            icon={SpellCheck2}
            title="最近被纠正"
            hint="做错过的地方,已经改了"
            emptyText="还没有被纠正过。"
            notes={grouped.corrections}
            tone="correction"
            onAdd={() => setDialogKind("correction")}
            onArchive={archiveNote.mutate}
            archiving={archiveNote.isPending}
          />
          <NoteColumn
            icon={BellRing}
            title="下次注意"
            hint="提前立好的规矩,别再踩"
            emptyText="还没有需要注意的事。"
            notes={grouped.reminders}
            tone="reminder"
            onAdd={() => setDialogKind("reminder")}
            onArchive={archiveNote.mutate}
            archiving={archiveNote.isPending}
          />
        </div>
      )}

      <AddFeedbackNoteDialog
        open={dialogKind !== null}
        onOpenChange={(open) => setDialogKind(open ? (dialogKind ?? "correction") : null)}
        defaultKind={dialogKind ?? "correction"}
        projects={projectsQuery.data ?? []}
        onSubmit={createNote.mutate}
        submitting={createNote.isPending}
      />
    </section>
  );
}

interface NoteColumnProps {
  icon: LucideIcon;
  title: string;
  hint: string;
  emptyText: string;
  notes: FeedbackNote[];
  tone: "correction" | "reminder";
  onAdd: () => void;
  onArchive: (note: FeedbackNote) => void;
  archiving: boolean;
}

function NoteColumn({
  icon: Icon,
  title,
  hint,
  emptyText,
  notes,
  tone,
  onAdd,
  onArchive,
  archiving,
}: NoteColumnProps) {
  return (
    <div className="rounded-xl border border-border bg-muted/20 p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <Icon
            className={
              tone === "correction"
                ? "size-4 text-rose-500 dark:text-rose-400"
                : "size-4 text-amber-500 dark:text-amber-400"
            }
            aria-hidden
          />
          <div>
            <h3 className="text-sm font-medium text-foreground">
              {title}
              <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                {notes.length}
              </span>
            </h3>
            <p className="text-xs text-muted-foreground">{hint}</p>
          </div>
        </div>
        <Button variant="ghost" size="sm" onClick={onAdd} aria-label={`新增一条「${title}」`}>
          <Plus className="size-3.5" aria-hidden />
        </Button>
      </div>

      {notes.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">{emptyText}</p>
      ) : (
        <ul className="mt-3 space-y-2.5">
          {notes.map((note) => (
            <FeedbackNoteCard
              key={note.id}
              note={note}
              tone={tone}
              onArchive={onArchive}
              archiving={archiving}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

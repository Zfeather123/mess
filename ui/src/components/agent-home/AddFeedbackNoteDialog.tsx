import { useState } from "react";
import type { Project } from "@paperclipai/shared";
import type { CreateFeedbackNoteInput, FeedbackNoteKind } from "@/api/collab-types";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

const GLOBAL_SCOPE = "__global__";

interface AddFeedbackNoteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultKind: FeedbackNoteKind;
  projects: readonly Project[];
  onSubmit: (input: CreateFeedbackNoteInput) => void;
  submitting: boolean;
}

export function AddFeedbackNoteDialog({
  open,
  onOpenChange,
  defaultKind,
  projects,
  onSubmit,
  submitting,
}: AddFeedbackNoteDialogProps) {
  const [kind, setKind] = useState<FeedbackNoteKind>(defaultKind);
  const [content, setContent] = useState("");
  const [scope, setScope] = useState<string>(GLOBAL_SCOPE);

  // Reopening the dialog from a different section should start on that section's kind.
  const handleOpenChange = (next: boolean) => {
    if (next) {
      setKind(defaultKind);
      setContent("");
      setScope(GLOBAL_SCOPE);
    }
    onOpenChange(next);
  };

  const submit = () => {
    const trimmed = content.trim();
    if (!trimmed) return;
    // A note written here is by definition hand-written, and the server rejects a
    // global note that carries a scope id — so send the id only for a project note.
    const base = { kind, content: trimmed, sourceType: "manual" } as const;
    onSubmit(
      scope === GLOBAL_SCOPE
        ? { ...base, scopeType: "global" }
        : { ...base, scopeType: "project", projectId: scope },
    );
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>写一条反馈笔记</DialogTitle>
          <DialogDescription>
            这条笔记会按权重进入 TA 的系统提示词,下次干活时自动生效。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="feedback-kind">类型</Label>
            <Select value={kind} onValueChange={(value) => setKind(value as FeedbackNoteKind)}>
              <SelectTrigger id="feedback-kind">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="correction">最近被纠正 —— 这次做错了,改</SelectItem>
                <SelectItem value="reminder">下次注意 —— 提前提醒,别踩</SelectItem>
                <SelectItem value="preference">个人偏好 —— 风格与习惯</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="feedback-content">内容</Label>
            <Textarea
              id="feedback-content"
              value={content}
              onChange={(event) => setContent(event.target.value)}
              rows={4}
              placeholder="具体一点 —— 「标题别写成震惊体,把结论前置」比「注意标题质量」有用得多。"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="feedback-scope">生效范围</Label>
            <Select value={scope} onValueChange={setScope}>
              <SelectTrigger id="feedback-scope">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={GLOBAL_SCOPE}>全局 —— 这位员工的所有工作</SelectItem>
                {projects.map((project) => (
                  <SelectItem key={project.id} value={project.id}>
                    项目 · {project.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              抖音账号维度的笔记由运行时在纠正发生时自动写入,这里只支持全局与项目。
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)}>
            取消
          </Button>
          <Button onClick={submit} disabled={submitting || !content.trim()}>
            {submitting ? "保存中…" : "保存"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

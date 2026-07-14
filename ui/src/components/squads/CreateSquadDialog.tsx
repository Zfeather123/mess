import { useEffect, useState } from "react";
import type { Agent } from "@paperclipai/shared";
import type { CreateSquadInput } from "@/api/collab-types";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

const NO_LEADER = "__none__";

interface CreateSquadDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agents: readonly Agent[];
  onSubmit: (input: CreateSquadInput) => void;
  submitting: boolean;
}

export function CreateSquadDialog({
  open,
  onOpenChange,
  agents,
  onSubmit,
  submitting,
}: CreateSquadDialogProps) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [leaderAgentId, setLeaderAgentId] = useState<string>(NO_LEADER);

  useEffect(() => {
    if (open) {
      setName("");
      setDescription("");
      setLeaderAgentId(NO_LEADER);
    }
  }, [open]);

  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    onSubmit({
      name: trimmed,
      description: description.trim() || null,
      leaderAgentId: leaderAgentId === NO_LEADER ? null : leaderAgentId,
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>建一支小队</DialogTitle>
          <DialogDescription>
            一位队长带一组队员。任务派给小队,队长决定给谁 —— 并说明为什么。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="squad-name">名字</Label>
            <Input
              id="squad-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="小镜说法 · 内容组"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="squad-description">这支队伍干什么</Label>
            <Textarea
              id="squad-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              rows={3}
              placeholder="负责账号的选题、口播稿与合规初审。"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="squad-leader">队长</Label>
            <Select value={leaderAgentId} onValueChange={setLeaderAgentId}>
              <SelectTrigger id="squad-leader">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_LEADER}>先不定 —— 之后再指</SelectItem>
                {agents
                  .filter((agent) => agent.status !== "terminated")
                  .map((agent) => (
                    <SelectItem key={agent.id} value={agent.id}>
                      {agent.name}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">队长必须是 AI 员工,真人可以当队员。</p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={submit} disabled={submitting || !name.trim()}>
            {submitting ? "创建中…" : "建队"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

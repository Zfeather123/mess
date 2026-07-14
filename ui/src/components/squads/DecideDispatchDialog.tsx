import { useEffect, useState } from "react";
import type { DecideDispatchInput, SquadDispatch, SquadMember } from "@/api/collab-types";
import type { PrincipalNames } from "@/lib/squads";
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

interface DecideDispatchDialogProps {
  dispatch: SquadDispatch | null;
  members: readonly SquadMember[];
  names: PrincipalNames;
  issueTitle: string;
  onOpenChange: (open: boolean) => void;
  onDecide: (dispatchId: string, input: DecideDispatchInput) => void;
  submitting: boolean;
}

/**
 * The reason field is not a note-to-self: it is what the team reads on the task
 * afterwards. It is required by the server and required here, with a prompt that
 * asks for the comparison ("为什么是 TA,不是别人") rather than a restatement.
 */
export function DecideDispatchDialog({
  dispatch,
  members,
  names,
  issueTitle,
  onOpenChange,
  onDecide,
  submitting,
}: DecideDispatchDialogProps) {
  const [memberId, setMemberId] = useState("");
  const [reason, setReason] = useState("");

  useEffect(() => {
    if (dispatch) {
      setMemberId("");
      setReason("");
    }
  }, [dispatch]);

  const selected = members.find((member) => member.id === memberId) ?? null;
  const ready = Boolean(selected) && reason.trim().length > 0;
  const reassigning = dispatch?.state === "dispatched";

  const submit = () => {
    if (!dispatch || !selected || !ready) return;
    onDecide(dispatch.id, {
      assignedAgentId: selected.memberType === "agent" ? selected.agentId : null,
      assignedUserId: selected.memberType === "user" ? selected.userId : null,
      decisionReason: reason.trim(),
    });
  };

  return (
    <Dialog open={dispatch !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{reassigning ? "改派这条任务" : "派这条任务"}</DialogTitle>
          <DialogDescription>
            {issueTitle}
            {reassigning && " —— 改派会新开一条派单记录,原来那条留在链上,不会被抹掉。"}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="dispatch-assignee">派给谁</Label>
            <Select value={memberId} onValueChange={setMemberId}>
              <SelectTrigger id="dispatch-assignee">
                <SelectValue placeholder="选一位队员" />
              </SelectTrigger>
              <SelectContent>
                {members.map((member) => (
                  <SelectItem key={member.id} value={member.id}>
                    {names.member(member)}
                    {member.memberType === "user" ? " · 真人" : ""}
                    {member.role === "leader" ? " · 队长" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="dispatch-reason">为什么是 TA</Label>
            <Textarea
              id="dispatch-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              rows={3}
              placeholder="这条是改写口播稿,文案编导手上正好没活,选题策划师还压着两条选题。"
            />
            <p className="text-xs text-muted-foreground">
              这句话会展示在任务的派单链上 —— 团队据此知道活为什么落在 TA 手里。
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={submit} disabled={submitting || !ready}>
            {submitting ? "派单中…" : reassigning ? "确认改派" : "确认派单"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

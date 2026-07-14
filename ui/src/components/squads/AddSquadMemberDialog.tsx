import { useEffect, useState } from "react";
import type { Agent } from "@paperclipai/shared";
import type { CompanyMember } from "@/api/access";
import type { AddSquadMemberInput, SquadMember } from "@/api/collab-types";
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
import { cn } from "@/lib/utils";

interface AddSquadMemberDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agents: readonly Agent[];
  members: readonly CompanyMember[];
  existing: readonly SquadMember[];
  onSubmit: (input: AddSquadMemberInput) => void;
  submitting: boolean;
}

/**
 * A squad is people, some of whom are AI. Humans are added the same way agents
 * are — same dialog, same list — because that is what the product means by a team.
 * Only an agent can lead: `squads.leader_agent_id` is a uuid FK and cannot hold
 * a human's bare-text id.
 */
export function AddSquadMemberDialog({
  open,
  onOpenChange,
  agents,
  members,
  existing,
  onSubmit,
  submitting,
}: AddSquadMemberDialogProps) {
  const [memberType, setMemberType] = useState<"agent" | "user">("agent");
  const [principalId, setPrincipalId] = useState("");
  const [asLeader, setAsLeader] = useState(false);

  useEffect(() => {
    if (open) {
      setMemberType("agent");
      setPrincipalId("");
      setAsLeader(false);
    }
  }, [open]);

  const takenAgentIds = new Set(existing.map((member) => member.agentId).filter(Boolean));
  const takenUserIds = new Set(existing.map((member) => member.userId).filter(Boolean));

  const availableAgents = agents.filter(
    (agent) => !takenAgentIds.has(agent.id) && agent.status !== "terminated",
  );
  const availableUsers = members
    .map((member) => ({
      id: member.user?.id ?? member.principalId,
      name: member.user?.name?.trim() || member.user?.email?.trim() || "未命名成员",
      status: member.status,
    }))
    .filter((member) => member.id && !takenUserIds.has(member.id) && member.status !== "archived");

  const submit = () => {
    if (!principalId) return;
    onSubmit(
      memberType === "agent"
        ? { memberType, agentId: principalId, role: asLeader ? "leader" : "member" }
        : { memberType, userId: principalId, role: "member" },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>加一位队员</DialogTitle>
          <DialogDescription>AI 员工和真人都能进小队 —— 一个小队就是一支混编的队伍。</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="inline-flex rounded-lg border border-border bg-muted/40 p-0.5">
            {(["agent", "user"] as const).map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={memberType === value}
                onClick={() => {
                  setMemberType(value);
                  setPrincipalId("");
                  if (value === "user") setAsLeader(false);
                }}
                className={cn(
                  "rounded-md px-3 py-1.5 text-sm transition-colors duration-150",
                  memberType === value
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {value === "agent" ? "AI 员工" : "真人"}
              </button>
            ))}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="squad-member">选一位</Label>
            <Select value={principalId} onValueChange={setPrincipalId}>
              <SelectTrigger id="squad-member">
                <SelectValue placeholder={memberType === "agent" ? "选一位 AI 员工" : "选一位同事"} />
              </SelectTrigger>
              <SelectContent>
                {(memberType === "agent" ? availableAgents : availableUsers).map((candidate) => (
                  <SelectItem key={candidate.id} value={candidate.id}>
                    {candidate.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {(memberType === "agent" ? availableAgents : availableUsers).length === 0 && (
              <p className="text-xs text-muted-foreground">这一类的人都已经在队里了。</p>
            )}
          </div>

          {memberType === "agent" && (
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={asLeader}
                onChange={(event) => setAsLeader(event.target.checked)}
                className="mt-0.5 size-4 rounded border-border accent-primary"
              />
              <span>
                让 TA 当队长
                <span className="block text-xs text-muted-foreground">
                  队长负责派单;原来的队长会退回普通成员。真人不能当队长。
                </span>
              </span>
            </label>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={submit} disabled={submitting || !principalId}>
            {submitting ? "加入中…" : "加入小队"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

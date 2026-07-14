import { useState } from "react";
import type {
  CompanySkillListItem,
  CreateAgentTemplate,
  EmployeeMarketCategory,
} from "@paperclipai/shared";
import { MARKET_CATEGORY_LABELS } from "@/lib/employee-market";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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

type Effort = "low" | "medium" | "high";

const CATEGORY_VALUES: EmployeeMarketCategory[] = ["content", "operations", "compliance"];

interface CustomEmployeeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  skills: readonly CompanySkillListItem[];
  onSubmit: (input: CreateAgentTemplate) => void;
  submitting: boolean;
}

/**
 * 自定义一位员工:人格、模型、思考强度、方法包 —— 存成模板,市场里就多一位可招的人。
 * 模型与思考强度落在 `adapterConfig`,和员工配置页改的是同一处。
 */
export function CustomEmployeeDialog({
  open,
  onOpenChange,
  skills,
  onSubmit,
  submitting,
}: CustomEmployeeDialogProps) {
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState<EmployeeMarketCategory>("content");
  const [instructions, setInstructions] = useState("");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState<Effort>("medium");
  const [desiredSkills, setDesiredSkills] = useState<string[]>([]);

  const handleOpenChange = (next: boolean) => {
    if (next) {
      setName("");
      setRole("");
      setDescription("");
      setCategory("content");
      setInstructions("");
      setModel("");
      setEffort("medium");
      setDesiredSkills([]);
    }
    onOpenChange(next);
  };

  const toggleSkill = (key: string, checked: boolean) => {
    setDesiredSkills((current) =>
      checked ? [...current, key] : current.filter((entry) => entry !== key),
    );
  };

  // The server requires a name, a role and non-empty instructions: an employee
  // with no instructions is a shell, and the DB has a CHECK that says so.
  const ready = name.trim() && role.trim() && instructions.trim();

  const submit = () => {
    if (!ready) return;
    const adapterConfig: Record<string, unknown> = { effort };
    if (model.trim()) adapterConfig.model = model.trim();

    onSubmit({
      name: name.trim(),
      role: role.trim(),
      description: description.trim() || null,
      category,
      instructions: instructions.trim(),
      adapterConfig,
      desiredSkills,
      visibility: "company",
    });
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>自定义一位 AI 员工</DialogTitle>
          <DialogDescription>
            写清楚 TA 是谁、怎么干活。存成模板后就出现在市场里,随时可以再招一个。
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[60vh] space-y-4 overflow-y-auto pr-1">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="employee-name">名字</Label>
              <Input
                id="employee-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="小镜"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="employee-role">职责</Label>
              <Input
                id="employee-role"
                value={role}
                onChange={(event) => setRole(event.target.value)}
                placeholder="文案编导"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="employee-description">一句话介绍</Label>
            <Input
              id="employee-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="把判决书写成三十秒能听懂的话。"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="employee-category">分类</Label>
            <Select
              value={category}
              onValueChange={(value) => setCategory(value as EmployeeMarketCategory)}
            >
              <SelectTrigger id="employee-category">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CATEGORY_VALUES.map((value) => (
                  <SelectItem key={value} value={value}>
                    {MARKET_CATEGORY_LABELS[value]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="employee-instructions">指令(人格)</Label>
            <Textarea
              id="employee-instructions"
              value={instructions}
              onChange={(event) => setInstructions(event.target.value)}
              rows={8}
              placeholder={
                "你是一位法律内容的文案编导……\n\n工作原则:\n- 结论前置,别写震惊体\n- 法条标注生效版本与条款号"
              }
            />
            <p className="text-xs text-muted-foreground">
              这段会成为 TA 的指令 bundle,招进来之后还能在员工配置页改。
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="employee-model">模型</Label>
              <Input
                id="employee-model"
                value={model}
                onChange={(event) => setModel(event.target.value)}
                placeholder="留空则用适配器默认"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="employee-effort">思考强度</Label>
              <Select value={effort} onValueChange={(value) => setEffort(value as Effort)}>
                <SelectTrigger id="employee-effort">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="low">低 —— 快,适合流水活</SelectItem>
                  <SelectItem value="medium">中 —— 默认</SelectItem>
                  <SelectItem value="high">高 —— 慢,适合难题</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium text-foreground">方法包</legend>
            {skills.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                公司里还没有方法包。先去「Skills」装一个,再回来给 TA 配上。
              </p>
            ) : (
              <div className="grid max-h-48 gap-1 overflow-y-auto rounded-lg border border-border p-2 sm:grid-cols-2">
                {skills.map((skill) => (
                  <label
                    key={skill.id}
                    className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-muted"
                  >
                    <Checkbox
                      checked={desiredSkills.includes(skill.key)}
                      onCheckedChange={(value) => toggleSkill(skill.key, value === true)}
                    />
                    <span className="truncate">{skill.name}</span>
                  </label>
                ))}
              </div>
            )}
          </fieldset>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)}>
            取消
          </Button>
          <Button onClick={submit} disabled={submitting || !ready}>
            {submitting ? "保存中…" : "存为模板"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

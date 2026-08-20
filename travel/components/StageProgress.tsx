"use client";

import { WORKSPACE_STAGES } from "../state/machine.ts";
import type { AgentState } from "../types.ts";

const steps = ["需求解析", "用户画像", "资料搜集", "行程规划", "行程校验"];

export function StageProgress({ state }: { state: AgentState }) {
  const flow = WORKSPACE_STAGES[state].flow;
  return <ol className="react-stage-progress" aria-label="智能体工作流">
    {steps.map((label, index) => <li className={index < flow ? "done" : index === flow ? "active" : ""} key={label}>
      <i>{index < flow || state === "READY" || state === "EXECUTING" ? "✓" : index + 1}</i><span>{label}</span>
    </li>)}
  </ol>;
}


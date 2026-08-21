"use client";

import { WORKSPACE_STAGES } from "../state/machine.ts";
import type { AgentState } from "../types.ts";

const steps = ["理解需求", "联网取证", "生成方案", "校验完成"];

export function StageProgress({ state }: { state: AgentState }) {
  const flow = WORKSPACE_STAGES[state].flow;
  return <ol className="react-stage-progress" aria-label="智能体工作流">
    {steps.map((label, index) => {
      const completed = flow >= steps.length || index < flow;
      return <li className={completed ? "done" : index === flow ? "active" : ""} key={label}>
        <i>{completed ? "✓" : index + 1}</i><span>{label}</span>
      </li>;
    })}
    <li className="mobile-stage-copy"><strong>{flow < 0 ? "规划已暂停" : `${Math.min(flow + 1, steps.length)} / ${steps.length}`}</strong><span>{flow >= steps.length ? "规划完成" : flow < 0 ? "请检查错误提示" : steps[flow]}</span></li>
  </ol>;
}

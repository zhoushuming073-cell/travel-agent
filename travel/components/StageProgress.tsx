"use client";

import { WORKSPACE_STAGES } from "../state/machine.ts";
import type { AgentState } from "../types.ts";
import { Icon } from "./Icon.tsx";

const steps = ["理解需求", "联网取证", "生成方案", "校验完成"];

interface Props {
  state: AgentState;
  selectedStep?: number;
  onSelect?: (step: number) => void;
}

export function StageProgress({ state, selectedStep, onSelect }: Props) {
  const flow = WORKSPACE_STAGES[state].flow;
  return <ol className="react-stage-progress" aria-label="智能体工作流">
    {steps.map((label, index) => {
      const completed = flow >= steps.length || index < flow;
      const selected = selectedStep === index || selectedStep === undefined && index === flow;
      const available = Boolean(onSelect) && completed;
      return <li className={`${completed ? "done " : ""}${selected ? "active selected" : ""}`.trim()} key={label}>
        <button type="button" disabled={!available} aria-current={selected ? "step" : undefined} onClick={() => onSelect?.(index)} title={available ? `回看：${label}` : undefined}>
          <i>{completed ? <Icon name="check"/> : index + 1}</i><span>{label}</span>{available ? <small>可回看</small> : null}
        </button>
      </li>;
    })}
  </ol>;
}

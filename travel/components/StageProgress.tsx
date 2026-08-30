"use client";

import { WORKSPACE_STAGES } from "../state/machine.ts";
import type { AgentState } from "../types.ts";
import { MOTION } from "../lib/animationCatalog.ts";
import { Icon } from "./Icon.tsx";
import { LottieMotion } from "./LottieMotion.tsx";

const steps = ["理解需求", "信息搜集", "智能规划", "方案呈现"];

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
      const available = Boolean(onSelect) && (completed || selected);
      return <li className={`${completed ? "done " : ""}${selected ? "active selected" : ""}`.trim()} key={label}>
        <button type="button" disabled={!available} aria-current={selected ? "step" : undefined} onClick={() => onSelect?.(index)} title={available ? `回看：${label}` : undefined}>
          <i>{completed ? <LottieMotion src={MOTION.success} className="step-success-motion" label={`${label}已完成`} loop={false} fallback={<Icon name="check"/>}/> : index + 1}</i><span>{label}</span><small>{completed ? "已完成" : selected ? "进行中" : "等待"}</small>
        </button>
      </li>;
    })}
  </ol>;
}

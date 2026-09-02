import type { CostNature, CostRange } from "../../../worker/domain/types.ts";
import type { UiPlan } from "../../types.ts";

const natureLabels: Record<CostNature, string> = {
  verified: "真实价格",
  referenced: "参考价格",
  estimated: "行程估算",
  unknown: "尚未核实",
};

function money(value: number | null | undefined): string {
  if (value === null || value === undefined) return "暂未核实";
  return `¥${Math.round(value).toLocaleString("zh-CN")}`;
}

function moneyRange(value: CostRange | null | undefined): string {
  if (!value) return "暂未核实";
  if (value.min === value.max) return money(value.expected);
  return `${money(value.min)}–${money(value.max)}`;
}

export function BudgetPanel({ plan }: { plan: UiPlan }) {
  const cost = plan.budgetBreakdown;
  if (!cost || !Array.isArray(cost.categories) || !Array.isArray(cost.daily)) return null;
  const mostExpensiveDay = [...cost.daily].filter((day) => day.amount).sort((left, right) => Number(right.amount?.expected || 0) - Number(left.amount?.expected || 0))[0]?.day;
  return <section className="trip-budget-panel" aria-labelledby="trip-budget-title">
    <header><div><span className="section-kicker">旅行花销预测 V1</span><h2 id="trip-budget-title">{cost.totalIsPartial ? "当前可估花销" : "预计总花销"} {moneyRange(cost.total)}</h2><p>{cost.note}</p></div><span className={`budget-status status-${cost.budgetStatus}`}>{cost.budgetStatusLabel}</span></header>
    <div className="budget-summary-grid">
      <span><small>中位估计</small><strong>{money(cost.total?.expected)}</strong></span>
      <span><small>你的预算</small><strong>{money(cost.userBudget)}</strong></span>
      <span><small>预计余量</small><strong>{cost.expectedRemaining === null ? "暂无法判断" : `${cost.expectedRemaining >= 0 ? "+" : "−"}${money(Math.abs(cost.expectedRemaining))}`}</strong></span>
      <span><small>预算可信度</small><strong>{cost.confidenceLabel}</strong><em>{cost.evidenceCoverage}% 费用项目依据覆盖</em></span>
    </div>
    <div className="budget-category-list">{cost.categories.map((category) => <article key={category.id}><span><b>{category.label}</b><small>{natureLabels[category.nature]}{category.unknownCount ? ` · ${category.unknownCount} 项未知` : ""}</small></span><strong>{moneyRange(category.amount)}</strong></article>)}</div>
    <details className="budget-method"><summary>展开查看怎么算的、数据来源与每日费用</summary><div className="budget-method-body">
      <section><h3>逐项依据</h3>{cost.categories.flatMap((category) => category.lines).map((item) => <article key={item.id}><div><b>{item.label}</b><span className={`cost-nature nature-${item.nature}`}>{natureLabels[item.nature]}</span></div><strong>{moneyRange(item.amount)}</strong><p>{item.basis}</p>{item.sourceUrl ? <a href={item.sourceUrl} target="_blank" rel="noreferrer">{item.sourceName}</a> : <small>{item.sourceName}</small>}</article>)}</section>
      <section><h3>每日可估费用</h3><div className="daily-cost-list">{cost.daily.map((day) => <span className={day.day === mostExpensiveDay ? "highest" : ""} key={day.day}><b>Day {day.day}</b><strong>{moneyRange(day.amount)}</strong><small>{day.day === mostExpensiveDay ? "当前最贵的一天 · " : ""}不含住宿和总缓冲</small></span>)}</div></section>
      <footer><p><b>计算范围：</b>{cost.scopeNote}</p><p><b>动态缓冲：</b>{cost.bufferReason}</p>{cost.assumptions.length ? <p><b>关键假设：</b>{cost.assumptions.join("；")}</p> : null}<p><b>不包含：</b>{cost.exclusions.join("、")}</p></footer>
    </div></details>
  </section>;
}

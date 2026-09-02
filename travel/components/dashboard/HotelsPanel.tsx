"use client";

import type { UiPlan } from "../../types.ts";

export function HotelsPanel({ plan }: { plan: UiPlan }) {
  const hotels = plan.hotelPlan?.candidates ?? [];
  return <section className="ready-hotel-card"><header><b>住宿候选</b><span>仅明确为每晚/每间的来源参考价进入费用区间；成交价、房态与税费仍需下单复核</span></header>{hotels.length ? hotels.slice(0, 6).map((hotel) => <article key={`${hotel.name}-${hotel.address}`}><div><strong>{hotel.name ?? "酒店候选"}</strong><span>{hotel.address ?? hotel.source ?? "地址暂未核验"}</span>{hotel.sourceUrl ? <a href={hotel.sourceUrl} target="_blank" rel="noreferrer">查看数据来源</a> : <small>来源链接暂未提供</small>}</div><b>{hotel.price ? `${/每晚|每间/.test(hotel.priceType || "") ? "每晚每间参考" : "参考金额"} ¥${hotel.price}` : "指定日期价格暂未取得"}<small>{hotel.priceVerifiedForDates ? "指定日期价格已核验" : hotel.price ? hotel.priceType ?? "计价单位未确认，不直接乘晚数" : "不以估算价格代替"}</small></b></article>) : <p className="empty-evidence">酒店查询没有返回可靠候选或指定日期价格，住宿费用保持 Unknown，不生成某家酒店的假价格。</p>}</section>;
}

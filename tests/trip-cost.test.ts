import assert from "node:assert/strict";
import test from "node:test";
import { estimateTripCost, parseTicketCostValue } from "../worker/domain/trip-cost.ts";
import type { ItineraryDay, TravelProfile } from "../worker/domain/types.ts";

const baseProfile: TravelProfile = {
  city: "北京", startDate: "2026-10-10", days: 1, nights: 0, partySize: 1, adults: 1, children: 0, seniors: 0,
  budget: 3000, preferences: ["历史"], requiredAttractions: [], transport: "公共交通优先", mealPreference: "适中",
};

function day(overrides: Partial<ItineraryDay> = {}): ItineraryDay {
  return {
    day: 1, date: "2026-10-10",
    items: [{ id: "museum", name: "城市博物馆", startTime: "09:00", endTime: "11:00" }],
    blocks: [
      { type: "attraction", item: { id: "museum", name: "城市博物馆" }, startTime: "09:00", endTime: "11:00" },
      { type: "rest", mealType: "lunch", startTime: "12:00", endTime: "13:00" },
      { type: "leg", from: "城市博物馆", to: "城市公园", startTime: "13:00", endTime: "13:30", distanceM: 8000, mode: "公交 / 地铁", source: "高德公交路线" },
    ],
    ...overrides,
  };
}

function research(value: unknown = { free: true, adultPrice: 0 }, status = "verified") {
  return {
    facts: [{ targetId: "museum", targetName: "城市博物馆", factType: "ticket_policy", status, value, supportingEvidenceIds: ["ticket-source"] }],
    evidence: [{ id: "ticket-source", title: "官方票务说明", publisher: "景区官网", url: "https://example.com/tickets", sourceTier: "tier_1_official" }],
  };
}

function estimate(profile: TravelProfile = baseProfile, daysPlan = [day()], hotelPlan: Record<string, unknown> = {}, researchInput: ReturnType<typeof research> | null = research()) {
  return estimateTripCost({ profile, plan: { id: "hot", city: profile.city, daysPlan, hotelPlan }, research: researchInput });
}

test("one-person one-day plan aggregates actual meals and legs without lodging", () => {
  const result = estimate();
  assert.deepEqual(result.categories.find((item) => item.id === "lodging")?.amount, { min: 0, expected: 0, max: 0 });
  assert.ok(Number(result.categories.find((item) => item.id === "meals")?.amount?.expected) > 0);
  assert.ok(Number(result.categories.find((item) => item.id === "localTransport")?.amount?.expected) > 0);
  assert.equal(result.categories.find((item) => item.id === "tickets")?.amount?.expected, 0);
});

test("hotel reference price is multiplied by nights and estimated room count", () => {
  const profile = { ...baseProfile, days: 3, nights: 2, partySize: 2, adults: 2 };
  const result = estimate(profile, [day(), day({ day: 2, date: "2026-10-11" }), day({ day: 3, date: "2026-10-12" })], {
    candidates: [{ name: "来源酒店", price: 500, priceType: "每晚每间参考价", source: "酒店 Provider", priceVerifiedForDates: false }],
  });
  const lodging = result.categories.find((item) => item.id === "lodging");
  assert.equal(lodging?.nature, "referenced");
  assert.equal(lodging?.amount?.min, 1000);
  assert.equal(lodging?.amount?.expected, 1120);
  assert.match(lodging?.lines[0].basis || "", /2 晚|每晚每间/);
});

test("family lodging estimates two rooms and does not duplicate lodging into daily totals", () => {
  const profile = { ...baseProfile, days: 3, nights: 2, partySize: 4, adults: 2, children: 1, seniors: 1 };
  const days = [day(), day({ day: 2, date: "2026-10-11" }), day({ day: 3, date: "2026-10-12" })];
  const result = estimate(profile, days, { candidates: [{ name: "家庭酒店", price: 500, priceType: "每晚每间参考价", source: "酒店 Provider" }] });
  assert.equal(result.categories.find((item) => item.id === "lodging")?.amount?.min, 2000);
  const dailyExpected = result.daily.reduce((sum, item) => sum + Number(item.amount?.expected || 0), 0);
  assert.ok(dailyExpected < Number(result.subtotal?.expected), "daily totals must exclude lodging instead of counting it again");
  assert.ok(result.assumptions.some((item) => item.includes("2 间房")));
});

test("missing hotel price remains unknown and lowers confidence", () => {
  const result = estimate({ ...baseProfile, days: 2, nights: 1 }, [day(), day({ day: 2, date: "2026-10-11" })], { candidates: [{ name: "无价酒店" }] });
  const lodging = result.categories.find((item) => item.id === "lodging");
  assert.equal(lodging?.nature, "unknown");
  assert.equal(lodging?.amount, null);
  assert.equal(result.totalIsPartial, true);
  assert.notEqual(result.confidenceLabel, "较高");
});

test("hotel amount with an unknown pricing unit is not multiplied as nightly room price", () => {
  const result = estimate({ ...baseProfile, days: 2, nights: 1 }, [day(), day({ day: 2, date: "2026-10-11" })], { candidates: [{ name: "套餐酒店", price: 888, priceType: "套餐参考价", source: "酒店 MCP" }] });
  const lodging = result.categories.find((item) => item.id === "lodging");
  assert.equal(lodging?.amount, null);
  assert.match(lodging?.lines[0].basis || "", /未确认是每晚\/每间/);
});

test("ticket parser supports free, adult, child and senior prices", () => {
  assert.deepEqual(parseTicketCostValue("景区免费开放，无需门票"), { free: true, adultPrice: 0 });
  assert.deepEqual(parseTicketCostValue("成人票 60 元，儿童票 30 元，老人票 20 元"), { free: false, adultPrice: 60, childPrice: 30, seniorPrice: 20 });
});

test("an attraction included in a pass is not charged twice", () => {
  const result = estimate(baseProfile, [day()], {}, research({ includedInPass: true }));
  const ticket = result.categories.find((item) => item.id === "tickets")?.lines[0];
  assert.equal(ticket?.amount?.expected, 0);
  assert.match(ticket?.basis || "", /不重复计费/);
});

test("charged tickets use party composition and explicit concessions only", () => {
  const profile = { ...baseProfile, partySize: 4, adults: 2, children: 1, seniors: 1 };
  const result = estimate(profile, [day()], {}, research({ adultPrice: 60, childPrice: 30, seniorPrice: 20 }));
  assert.equal(result.categories.find((item) => item.id === "tickets")?.amount?.expected, 170);
});

test("unknown child and senior concessions become a range instead of guessed discounts", () => {
  const profile = { ...baseProfile, partySize: 4, adults: 2, children: 1, seniors: 1 };
  const result = estimate(profile, [day()], {}, research({ adultPrice: 60 }));
  const tickets = result.categories.find((item) => item.id === "tickets")?.amount;
  assert.equal(tickets?.min, 120);
  assert.equal(tickets?.expected, 240);
  assert.equal(tickets?.max, 240);
});

test("public transit multiplies by people while one taxi is shared", () => {
  const busDay = day({ blocks: [{ type: "leg", from: "A", to: "B", distanceM: 10000, mode: "公交 / 地铁", source: "路线" }], items: [] });
  const taxiDay = day({ blocks: [{ type: "leg", from: "A", to: "B", distanceM: 10000, mode: "出租车", source: "路线" }], items: [] });
  const oneBus = estimate({ ...baseProfile, partySize: 1, adults: 1 }, [busDay], {}, null);
  const fourBus = estimate({ ...baseProfile, partySize: 4, adults: 4 }, [busDay], {}, null);
  const oneTaxi = estimate({ ...baseProfile, partySize: 1, adults: 1 }, [taxiDay], {}, null);
  const fourTaxi = estimate({ ...baseProfile, partySize: 4, adults: 4 }, [taxiDay], {}, null);
  assert.equal(Number(fourBus.categories.find((item) => item.id === "localTransport")?.amount?.expected), Number(oneBus.categories.find((item) => item.id === "localTransport")?.amount?.expected) * 4);
  assert.equal(fourTaxi.categories.find((item) => item.id === "localTransport")?.amount?.expected, oneTaxi.categories.find((item) => item.id === "localTransport")?.amount?.expected);
});

test("provider fare overrides distance estimate with the correct sharing rule", () => {
  const busDay = day({ blocks: [{ type: "leg", from: "A", to: "B", distanceM: 30000, mode: "公交 / 地铁", fare: 6, source: "高德地图官方公交/地铁" }], items: [] });
  const taxiDay = day({ blocks: [{ type: "leg", from: "A", to: "B", distanceM: 30000, mode: "出租车", fare: 80, source: "出租车计价 Provider" }], items: [] });
  const profile = { ...baseProfile, partySize: 4, adults: 4 };
  const bus = estimate(profile, [busDay], {}, null).categories.find((item) => item.id === "localTransport");
  const taxi = estimate(profile, [taxiDay], {}, null).categories.find((item) => item.id === "localTransport");
  assert.equal(bus?.amount?.expected, 20);
  assert.equal(bus?.nature, "verified");
  assert.equal(taxi?.amount?.expected, 80);
  assert.equal(taxi?.nature, "referenced");
});

test("a zero public-transit fare is treated as missing provider data, not verified free travel", () => {
  const busDay = day({ blocks: [{ type: "leg", from: "A", to: "B", distanceM: 30000, mode: "公交 / 地铁", fare: 0, source: "高德地图官方公交/地铁" }], items: [] });
  const result = estimate({ ...baseProfile, partySize: 2, adults: 2 }, [busDay], {}, null);
  const transport = result.categories.find((item) => item.id === "localTransport");
  assert.ok(Number(transport?.amount?.expected) > 0);
  assert.equal(transport?.nature, "estimated");
  assert.match(transport?.lines[0].basis || "", /未返回真实票价/);
});

test("unidentified other costs stay unknown and material unknowns suppress a misleading remaining budget", () => {
  const result = estimate(baseProfile, [day()], {}, null);
  const other = result.categories.find((item) => item.id === "other");
  assert.equal(other?.nature, "unknown");
  assert.equal(other?.amount, null);
  assert.equal(result.totalIsPartial, true);
  assert.equal(result.expectedRemaining, null);
});

test("intercity legs are separate and stay unknown without a fare provider", () => {
  const intercityDay = day({ blocks: [{ type: "leg", from: "北京", to: "天津", distanceM: 120000, mode: "城际高铁", source: "行程路段" }], items: [] });
  const result = estimate(baseProfile, [intercityDay], {}, null);
  assert.equal(result.categories.find((item) => item.id === "intercityTransport")?.nature, "unknown");
  assert.equal(result.categories.find((item) => item.id === "localTransport")?.amount?.expected, 0);
});

test("budget status covers comfortable, tight and over-budget plans", () => {
  const comfortable = estimate({ ...baseProfile, budget: 5000 });
  assert.equal(comfortable.budgetStatus, "comfortable");

  const tight = estimate({ ...baseProfile, days: 2, nights: 1, partySize: 2, adults: 2, budget: 1300 }, [day(), day({ day: 2, date: "2026-10-11" })], { candidates: [{ name: "酒店", price: 700, priceVerifiedForDates: true }] });
  assert.equal(tight.budgetStatus, "tight");

  const over = estimate({ ...baseProfile, days: 2, nights: 1, partySize: 2, adults: 2, budget: 300 }, [day(), day({ day: 2, date: "2026-10-11" })], { candidates: [{ name: "酒店", price: 700, priceVerifiedForDates: true }] });
  assert.equal(over.budgetStatus, "over_budget");
  assert.ok(Number(over.expectedRemaining) < 0);
});

test("many unknown prices cannot produce high confidence", () => {
  const unknownDay = day({ items: [{ id: "a", name: "景点A" }, { id: "b", name: "景点B" }, { id: "c", name: "景点C" }] });
  const result = estimate({ ...baseProfile, days: 2, nights: 1 }, [unknownDay, day({ day: 2, date: "2026-10-11" })], {}, null);
  assert.equal(result.totalIsPartial, true);
  assert.equal(result.confidenceLabel, "较低");
  assert.equal(result.budgetStatus, "unknown");
});

test("three different itineraries naturally produce different estimates", () => {
  const freeResearch = research();
  const hot = estimate(baseProfile, [day()], {}, freeResearch);
  const niche = estimate(baseProfile, [day({ blocks: [{ type: "rest", mealType: "lunch" }, { type: "leg", from: "A", to: "B", distanceM: 2000, mode: "步行" }] })], {}, freeResearch);
  const relax = estimate(baseProfile, [day({ blocks: [{ type: "rest", mealType: "lunch" }, { type: "rest", mealType: "dinner" }, { type: "leg", from: "A", to: "B", distanceM: 25000, mode: "出租车" }] })], {}, freeResearch);
  assert.equal(new Set([hot.total?.expected, niche.total?.expected, relax.total?.expected]).size, 3);
});

test("dynamic buffer increases when estimates replace verified values", () => {
  const verifiedHotel = estimate({ ...baseProfile, days: 2, nights: 1 }, [day(), day({ day: 2, date: "2026-10-11" })], { candidates: [{ name: "酒店", price: 500, priceVerifiedForDates: true }] });
  const referencedHotel = estimate({ ...baseProfile, days: 2, nights: 1 }, [day(), day({ day: 2, date: "2026-10-11" })], { candidates: [{ name: "酒店", price: 500, priceType: "每晚每间参考价", priceVerifiedForDates: false }] });
  assert.ok(Number(referencedHotel.bufferAmount?.expected) > Number(verifiedHotel.bufferAmount?.expected));
  assert.match(referencedHotel.bufferReason, /动态缓冲|估算|参考价/);
});

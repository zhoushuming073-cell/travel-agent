import assert from "node:assert/strict";
import test from "node:test";

import { fallbackPoiCategory, isExcludedCandidatePoi, selectBestAmapDistrict, uniqueSpots } from "../worker/travel-api.ts";

test("candidate dedupe keeps unrelated POIs and removes only aliases or nearby sub-sites", () => {
  const spots = uniqueSpots([
    { id: "bund", name: "外滩", lat: 31.2401, lng: 121.4906 },
    { id: "museum", name: "上海自然博物馆", lat: 31.2368, lng: 121.4613 },
    { id: "bund-platform", name: "外滩-观景平台", lat: 31.24011, lng: 121.49061 },
  ]);
  assert.equal(spots.length, 2);
  assert.deepEqual(new Set(spots.map((spot) => spot.name)), new Set(["外滩", "上海自然博物馆"]));
  assert.ok(spots.every((spot) => !spot.aliases.includes("1")));
});

test("city resolution prefers the prefecture-level city over a same-name district", () => {
  const selected = selectBestAmapDistrict("西安", [
    { name: "西安区", level: "district", center: "125.149488,42.927252" },
    { name: "西安市", level: "city", center: "108.9398,34.3416" },
  ]);
  assert.equal(selected?.name, "西安市");
});

test("candidate filtering excludes schools and unfinished attractions", () => {
  assert.equal(isExcludedCandidatePoi("和宁街小学校", "科教文化服务;学校;小学"), true);
  assert.equal(isExcludedCandidatePoi("富国新村公园(建设中)", "风景名胜;公园广场;公园"), true);
  assert.equal(isExcludedCandidatePoi("西安交通大学", "科教文化服务;学校;大学", true), false);
});

test("temples are categorized as history before generic scenic words", () => {
  assert.equal(fallbackPoiCategory("大兴善寺 风景名胜;寺庙道观"), "历史文化");
});

import assert from "node:assert/strict";
import test from "node:test";

import { uniqueSpots } from "../worker/travel-api.ts";

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

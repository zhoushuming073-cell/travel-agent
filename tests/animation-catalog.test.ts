import test from "node:test";
import assert from "node:assert/strict";
import { weatherMotion } from "../travel/lib/animationCatalog.ts";

test("maps WMO weather codes to distinct Lottie states", () => {
  assert.match(weatherMotion(0), /weather_sunny/);
  assert.match(weatherMotion(2), /weather_partly_cloudy/);
  assert.match(weatherMotion(48), /foggy/);
  assert.match(weatherMotion(61), /weather_partly_shower/);
  assert.match(weatherMotion(85), /weather_snow_sunny/);
  assert.match(weatherMotion(95), /weather_thunder/);
  assert.match(weatherMotion(99), /weather_storm/);
});

test("supports nightly and high-wind animation variants", () => {
  assert.match(weatherMotion(0, true), /weather_night/);
  assert.match(weatherMotion(61, true), /weather_rainy_night/);
  assert.match(weatherMotion(71, true), /weather_snow_night/);
  assert.match(weatherMotion(1, true), /weather_cloudy_night/);
  assert.match(weatherMotion(1, false, 45), /weather_windy/);
});

test("Open-Meteo query and result contract retain all 16 forecast days", async () => {
  const source = await import("node:fs/promises").then((fs) => fs.readFile(new URL("../worker/travel-api.ts", import.meta.url), "utf8"));
  assert.match(source, /forecast_days:\s*"16"/);
  assert.match(source, /const forecast16 =/);
  assert.match(source, /Open-Meteo（未来 16 天）/);
});

export const MOTION = {
  success: "/animations/success-check.json",
  search: "/animations/search.json",
  paperPlane: "/animations/paper-plane.json",
  location: "/animations/location.json",
  routePlanning: "/animations/route-planning.json",
  loadingFiles: "/animations/loading-files.json",
  liveChatbot: "/animations/live-chatbot.json",
  fire: "/animations/fire.json",
} as const;

const WEATHER_ROOT = "/animations/weather";

export function weatherMotion(code?: number, isNight = false, windSpeed?: number): string {
  if (windSpeed !== undefined && windSpeed >= 38) return `${WEATHER_ROOT}/05_weather_windy.json`;
  if (code === undefined || !Number.isFinite(code)) return isNight ? `${WEATHER_ROOT}/11_weather_cloudy_night.json` : `${WEATHER_ROOT}/02_weather_partly_cloudy.json`;
  if (code === 0) return isNight ? `${WEATHER_ROOT}/06_weather_night.json` : `${WEATHER_ROOT}/12_weather_sunny.json`;
  if (code === 1 || code === 2 || code === 3) return isNight ? `${WEATHER_ROOT}/11_weather_cloudy_night.json` : `${WEATHER_ROOT}/02_weather_partly_cloudy.json`;
  if (code === 45) return `${WEATHER_ROOT}/04_weather_mist.json`;
  if (code === 48) return `${WEATHER_ROOT}/15_foggy.json`;
  if (code >= 51 && code <= 67) return isNight ? `${WEATHER_ROOT}/14_weather_rainy_night.json` : `${WEATHER_ROOT}/09_weather_partly_shower.json`;
  if (code >= 71 && code <= 77) return isNight ? `${WEATHER_ROOT}/08_weather_snow_night.json` : `${WEATHER_ROOT}/10_weather_snow.json`;
  if (code === 80 || code === 81) return isNight ? `${WEATHER_ROOT}/14_weather_rainy_night.json` : `${WEATHER_ROOT}/09_weather_partly_shower.json`;
  if (code === 82) return `${WEATHER_ROOT}/03_weather_storm_showers_day.json`;
  if (code === 85) return isNight ? `${WEATHER_ROOT}/08_weather_snow_night.json` : `${WEATHER_ROOT}/13_weather_snow_sunny.json`;
  if (code === 86) return isNight ? `${WEATHER_ROOT}/08_weather_snow_night.json` : `${WEATHER_ROOT}/10_weather_snow.json`;
  if (code === 95) return `${WEATHER_ROOT}/07_weather_thunder.json`;
  if (code === 96 || code === 99) return `${WEATHER_ROOT}/01_weather_storm.json`;
  return isNight ? `${WEATHER_ROOT}/11_weather_cloudy_night.json` : `${WEATHER_ROOT}/02_weather_partly_cloudy.json`;
}

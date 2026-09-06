/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import { handleTravelApi } from "./travel-api";

interface Env {
  ASSETS: Fetcher;
  DB?: import("./persistence.ts").D1DatabaseLike;
  AI_API_KEY?: string;
  AI_API_BASE_URL?: string;
  AI_EXTRACT_MODEL?: string;
  AI_RESEARCH_MODEL?: string;
  AI_ENRICH_MODEL?: string;
  AI_PLANNER_MODEL?: string;
  AI_CRITIC_MODEL?: string;
  AI_REPAIR_MODEL?: string;
  AI_REPAIR_FALLBACK_MODEL?: string;
  AI_EXPLAIN_MODEL?: string;
  AI_COMPATIBLE_MODEL_FALLBACKS?: string;
  AI_SKIP_MODELS?: string;
  AI_STRICT_MODEL_ROUTING?: string;
  AI_REQUEST_MIN_INTERVAL_MS?: string;
  DEEPSEEK_API_KEY?: string;
  DEEPSEEK_MODEL?: string;
  DEEPSEEK_EXTRACT_MODEL?: string;
  DEEPSEEK_PLANNER_MODEL?: string;
  DEEPSEEK_REPAIR_MODEL?: string;
  AMAP_WEB_KEY?: string;
  UNSPLASH_ACCESS_KEY?: string;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface Fetcher {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return Response.redirect(new URL("/travel/", request.url), 302);
    }

    if (url.pathname.startsWith("/api/")) {
      const response = await handleTravelApi(request, env, url, ctx);
      if (response) return response;
    }

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }

    return handler.fetch(request, env, ctx);
  },
};

export default worker;

import { preferredSourceTiers } from "./research-policy.ts";
import type { PageAccessStatus, ResearchRequest, SearchResultCandidate, SourceTier } from "./research-types.ts";

export interface SearchProvider {
  id: string;
  capabilities: string[];
  sourceTiers: SourceTier[];
  supports(request: ResearchRequest): boolean;
  search(request: ResearchRequest): Promise<SearchResultCandidate[]>;
}

export interface PageFetchResult {
  url: string;
  status: PageAccessStatus;
  title?: string;
  publisher?: string;
  publishedAt?: string;
  text?: string;
  fetchedAt: string;
  error?: string;
}

export interface PageProvider {
  id: string;
  supports(url: string): boolean;
  fetch(url: string): Promise<PageFetchResult>;
}

export interface SearchExecution {
  request: ResearchRequest;
  results: SearchResultCandidate[];
  providersAttempted: string[];
  providerFailures: Array<{ provider: string; error: string }>;
  executedAt: string;
}

export class SearchOrchestrator {
  private readonly searchProviders: SearchProvider[];
  private readonly pageProviders: PageProvider[];

  constructor(searchProviders: SearchProvider[], pageProviders: PageProvider[] = []) {
    this.searchProviders = searchProviders;
    this.pageProviders = pageProviders;
  }

  selectProviders(request: ResearchRequest) {
    const preferred = request.preferredSourceTiers.length ? request.preferredSourceTiers : preferredSourceTiers(request.questionType);
    return this.searchProviders.filter((provider) => provider.supports(request)).sort((left, right) => {
      const rank = (provider: SearchProvider) => Math.min(...provider.sourceTiers.map((tier) => {
        const index = preferred.indexOf(tier);
        return index < 0 ? 99 : index;
      }));
      return rank(left) - rank(right);
    });
  }

  async execute(request: ResearchRequest, maxProviders = 3): Promise<SearchExecution> {
    const providers = this.selectProviders(request).slice(0, maxProviders);
    const settled = await Promise.allSettled(providers.map((provider) => provider.search(request)));
    const results: SearchResultCandidate[] = [];
    const providerFailures: Array<{ provider: string; error: string }> = [];
    settled.forEach((outcome, index) => {
      if (outcome.status === "fulfilled") results.push(...outcome.value);
      else providerFailures.push({ provider: providers[index].id, error: String(outcome.reason instanceof Error ? outcome.reason.message : outcome.reason) });
    });
    const unique = [...new Map(results.map((result) => [`${result.url || "snippet"}|${result.title}|${result.provider}`, result])).values()];
    return { request, results: unique, providersAttempted: providers.map((provider) => provider.id), providerFailures, executedAt: new Date().toISOString() };
  }

  async fetchPage(url: string): Promise<PageFetchResult> {
    const provider = this.pageProviders.find((candidate) => candidate.supports(url));
    if (!provider) return { url, status: "parse_failed", fetchedAt: new Date().toISOString(), error: "没有可用页面读取Provider" };
    return provider.fetch(url);
  }
}

export function classifySourceTier(url: string | null, provider = ""): SourceTier {
  const text = `${url || ""} ${provider}`.toLowerCase();
  if (/\.gov\.cn|政府|官方|地铁|公交|景区官网|文旅/.test(text)) return "tier_1_official";
  if (/amap|ctrip|trip\.com|携程|同程|飞猪|mafengwo|wikipedia|openstreetmap/.test(text)) return "tier_2_professional";
  if (/news|日报|晚报|新华社|中新网|澎湃|媒体/.test(text)) return "tier_3_news";
  if (/xiaohongshu|小红书|dianping|大众点评|bilibili|douyin|抖音|weibo|微博|reddit|游记|论坛/.test(text)) return "tier_4_ugc";
  return "unknown";
}

export function detectPageAccessStatus(status: number, text: string, contentType = ""): PageAccessStatus {
  const lower = text.toLowerCase();
  if (status === 401 || status === 403) return /captcha|验证码/.test(lower) ? "captcha" : "blocked_auth";
  if (status === 404 || status === 410) return "deleted";
  if (status === 402 || /paywall|订阅后阅读|付费阅读/.test(lower)) return "paywalled";
  if (/robots\.txt|blocked by robots|禁止抓取/.test(lower)) return "blocked_robots";
  if (/captcha|验证码|安全验证/.test(lower)) return "captcha";
  if (status >= 500 || status <= 0) return "network_failed";
  if (!/html|text|json|xml/.test(contentType.toLowerCase()) && text.length < 80) return "parse_failed";
  return status >= 200 && status < 300 ? "page_fetched" : "parse_failed";
}

export function sanitizeUntrustedPage(html: string, maxLength = 24_000) {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|canvas|iframe)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/ignore (?:all|any|the) previous instructions|忽略(?:之前|以上|所有)指令/gi, "[已移除不可信指令]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

"use client";

import { useEffect, useState } from "react";
import { Icon } from "./Icon.tsx";

interface Props { name: string; officialName?: string; poiId?: string; city: string; lat?: number; lng?: number; className?: string }

export function SpotImage({ name, officialName, poiId, city, lat, lng, className = "" }: Props) {
  const requestKey = `${city}|${name}|${officialName ?? ""}|${poiId ?? ""}|${lat ?? ""}|${lng ?? ""}`;
  const [image, setImage] = useState<{ key: string; url: string | null; state: "loading" | "ready" | "empty" | "failed" }>({ key: requestKey, url: null, state: "loading" });
  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({ name, city });
    if (officialName) params.set("officialName", officialName);
    if (poiId) params.set("poiId", poiId);
    if (typeof lat === "number") params.set("lat", String(lat));
    if (typeof lng === "number") params.set("lng", String(lng));
    fetch(`/api/image?${params}`, { signal: controller.signal })
      .then((response) => response.ok ? response.json() : null)
      .then((data: unknown) => {
        if (data && typeof data === "object") {
          const record = data as Record<string, unknown>;
          if (record.found === true && typeof record.url === "string") setImage({ key: requestKey, url: record.url, state: "ready" });
          else setImage({ key: requestKey, url: null, state: "empty" });
        } else setImage({ key: requestKey, url: null, state: "empty" });
      })
      .catch((caught) => { if (!(caught instanceof DOMException && caught.name === "AbortError")) setImage({ key: requestKey, url: null, state: "failed" }); });
    return () => controller.abort();
  }, [city, lat, lng, name, officialName, poiId, requestKey]);
  const current = image.key === requestKey ? image : { key: requestKey, url: null, state: "loading" as const };
  if (current.state === "loading") return <div className={`spot-image-loading ${className}`} aria-label={`${name} 图片加载中`}><i></i></div>;
  if (!current.url) return <div className={`spot-image-placeholder ${className}`} aria-label={`${name} 暂无可验证图片`}><Icon name="mapPin"/><small>{name}</small></div>;
  return <img className={className} src={current.url} alt={name} loading="lazy" referrerPolicy="no-referrer" onError={() => setImage({ key: requestKey, url: null, state: "failed" })}/>;
}

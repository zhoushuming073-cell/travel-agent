"use client";

import { useEffect, useState } from "react";

interface Props { name: string; city: string; lat?: number; lng?: number; className?: string }

export function SpotImage({ name, city, lat, lng, className = "" }: Props) {
  const requestKey = `${city}|${name}|${lat ?? ""}|${lng ?? ""}`;
  const [image, setImage] = useState<{ key: string; url: string | null; failed: boolean }>({ key: "", url: null, failed: false });
  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({ name, city });
    if (typeof lat === "number") params.set("lat", String(lat));
    if (typeof lng === "number") params.set("lng", String(lng));
    fetch(`/api/image?${params}`, { signal: controller.signal })
      .then((response) => response.ok ? response.json() : null)
      .then((data: unknown) => {
        if (data && typeof data === "object") {
          const record = data as Record<string, unknown>;
          if (record.found === true && typeof record.url === "string") setImage({ key: requestKey, url: record.url, failed: false });
        }
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [city, lat, lng, name, requestKey]);
  const url = image.key === requestKey && !image.failed ? image.url : null;
  if (!url) return <div className={`spot-image-placeholder ${className}`} aria-label={`${name} 暂无可验证图片`}><span>⌖</span><small>{name}</small></div>;
  return <img className={className} src={url} alt={name} loading="lazy" referrerPolicy="no-referrer" onError={() => setImage({ key: requestKey, url, failed: true })}/>;
}

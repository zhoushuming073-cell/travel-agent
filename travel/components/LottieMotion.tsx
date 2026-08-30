"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { AnimationItem } from "lottie-web";

type LottieRuntime = typeof import("lottie-web/build/player/lottie_light");
type FallbackMode = "loading-and-error" | "error-only";

let runtimePromise: Promise<LottieRuntime> | null = null;

export function preloadLottieRuntime(): Promise<LottieRuntime> {
  runtimePromise ??= import("lottie-web/build/player/lottie_light");
  return runtimePromise;
}

if (typeof window !== "undefined") void preloadLottieRuntime();

interface Props {
  src: string;
  className?: string;
  label?: string;
  loop?: boolean;
  fallback?: ReactNode;
  fallbackMode?: FallbackMode;
}

export function LottieMotion({ src, className = "", label, loop = true, fallback, fallbackMode = "loading-and-error" }: Props) {
  const containerRef = useRef<HTMLSpanElement>(null);
  const [readySrc, setReadySrc] = useState<string | null>(null);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const ready = readySrc === src;
  const failed = failedSrc === src;

  useEffect(() => {
    let animation: AnimationItem | null = null;
    let disposed = false;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    void preloadLottieRuntime().then(({ default: lottie }) => {
      if (disposed || !containerRef.current) return;
      animation = lottie.loadAnimation({
        container: containerRef.current,
        renderer: "svg",
        loop: reducedMotion ? false : loop,
        autoplay: !reducedMotion,
        path: src,
        rendererSettings: { preserveAspectRatio: "xMidYMid meet" },
      });
      animation.addEventListener("DOMLoaded", () => {
        if (disposed) return;
        setFailedSrc(null);
        setReadySrc(src);
        if (reducedMotion) animation?.goToAndStop(0, true);
      });
      animation.addEventListener("data_failed", () => {
        if (disposed) return;
        setReadySrc(null);
        setFailedSrc(src);
      });
    }).catch(() => {
      if (disposed) return;
      setReadySrc(null);
      setFailedSrc(src);
    });

    return () => {
      disposed = true;
      animation?.destroy();
    };
  }, [loop, src]);

  const showFallback = Boolean(fallback) && (failed || !ready && fallbackMode === "loading-and-error");

  return <span className={`lottie-motion ${ready ? "is-ready" : failed ? "is-error" : "is-loading"} ${className}`.trim()} role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
    {showFallback ? <span className="lottie-fallback">{fallback}</span> : null}
    <span ref={containerRef} className="lottie-canvas"/>
  </span>;
}

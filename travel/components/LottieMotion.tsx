"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { AnimationItem } from "lottie-web";

interface Props {
  src: string;
  className?: string;
  label?: string;
  loop?: boolean;
  fallback?: ReactNode;
}

export function LottieMotion({ src, className = "", label, loop = true, fallback }: Props) {
  const containerRef = useRef<HTMLSpanElement>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let animation: AnimationItem | null = null;
    let disposed = false;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    void import("lottie-web/build/player/lottie_light").then(({ default: lottie }) => {
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
        setReady(true);
        if (reducedMotion) animation?.goToAndStop(0, true);
      });
    }).catch(() => undefined);

    return () => {
      disposed = true;
      animation?.destroy();
    };
  }, [loop, src]);

  return <span className={`lottie-motion ${ready ? "is-ready" : ""} ${className}`.trim()} role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
    {!ready && fallback ? <span className="lottie-fallback">{fallback}</span> : null}
    <span ref={containerRef} className="lottie-canvas"/>
  </span>;
}

"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  TRAVEL_THEME_IDS,
  TRAVEL_THEMES,
  type TravelThemeId,
} from "@/app/travel/[[...tripId]]/styles/themes/travel-theme-registry.ts";
import { Icon } from "./Icon.tsx";

const DEFAULT_THEME: TravelThemeId = "arctic-blue";
const STORAGE_KEY = "travel-ui-theme";

function isTravelThemeId(value: string | null | undefined): value is TravelThemeId {
  return Boolean(value && (TRAVEL_THEME_IDS as readonly string[]).includes(value));
}

function currentTheme(): TravelThemeId {
  if (typeof document === "undefined") return DEFAULT_THEME;
  return isTravelThemeId(document.documentElement.dataset.travelTheme)
    ? document.documentElement.dataset.travelTheme
    : DEFAULT_THEME;
}

function applyTheme(theme: TravelThemeId) {
  document.documentElement.dataset.travelTheme = theme;
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Theme selection still works when browser storage is unavailable.
  }
  window.dispatchEvent(new Event("travel-theme-change"));
}

function subscribeToTheme(callback: () => void) {
  const handleStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) callback();
  };
  window.addEventListener("travel-theme-change", callback);
  window.addEventListener("storage", handleStorage);
  return () => {
    window.removeEventListener("travel-theme-change", callback);
    window.removeEventListener("storage", handleStorage);
  };
}

export function ThemePicker() {
  const [open, setOpen] = useState(false);
  const theme = useSyncExternalStore(subscribeToTheme, currentTheme, () => DEFAULT_THEME);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", closeOnEscape);
    document.addEventListener("pointerdown", closeOnOutsideClick);
    return () => {
      document.removeEventListener("keydown", closeOnEscape);
      document.removeEventListener("pointerdown", closeOnOutsideClick);
    };
  }, [open]);

  const selectTheme = (nextTheme: TravelThemeId) => {
    applyTheme(nextTheme);
    setOpen(false);
  };

  const activeTheme = TRAVEL_THEMES.find((item) => item.id === theme) ?? TRAVEL_THEMES[0];

  return <div className="travel-theme-picker" ref={rootRef}>
    <button
      className="theme-picker-trigger"
      type="button"
      aria-label={`打开设置，当前主题为${activeTheme.nameZh}`}
      aria-haspopup="dialog"
      aria-expanded={open}
      title={`设置 · ${activeTheme.nameZh}`}
      onClick={() => setOpen((value) => !value)}
    >
      <Icon name="settings"/>
      <span className="visually-hidden">设置</span>
    </button>
    {open ? <div className="theme-picker-popover" role="dialog" aria-label="设置">
      <header>
        <div><strong>设置</strong><small>集中管理旅行助手的界面与偏好</small></div>
        <button className="theme-picker-close" type="button" aria-label="关闭设置" onClick={() => setOpen(false)}><Icon name="close"/></button>
      </header>
      <section className="settings-section" aria-labelledby="appearance-settings-title" data-settings-section="appearance">
        <div className="theme-picker-section-head"><b id="appearance-settings-title">界面主题</b><small>仅改变颜色，不影响行程与布局</small></div>
        <div className="theme-picker-grid">
          {TRAVEL_THEMES.map((item) => <button
            className={`theme-option${item.id === theme ? " active" : ""}`}
            type="button"
            key={item.id}
            aria-pressed={item.id === theme}
            onClick={() => selectTheme(item.id)}
            style={{
              "--theme-option-canvas": item.preview.canvas,
              "--theme-option-sidebar": item.preview.sidebar,
              "--theme-option-brand": item.preview.brand,
              "--theme-option-accent": item.preview.accent,
            } as React.CSSProperties}
          >
            <span className="theme-option-preview" aria-hidden="true"><i/><i/><i/></span>
            <span><b>{item.nameZh}</b><small>{item.name}</small></span>
            {item.id === theme ? <Icon name="check"/> : null}
          </button>)}
        </div>
      </section>
      <footer className="settings-extension-note"><Icon name="plus"/><span>后续设置会按功能分区加入这里</span></footer>
    </div> : null}
  </div>;
}

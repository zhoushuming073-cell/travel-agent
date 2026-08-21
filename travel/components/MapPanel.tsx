"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import type { UiPlan } from "../types.ts";
import { Icon } from "./Icon.tsx";

interface Props {
  plan: UiPlan;
  selectedDay: number | null;
  selectedSpotId: string | null;
  onSelectSpot: (spotId: string, day: number) => void;
}

const TILE = 256;

function world(lat: number, lng: number, zoom: number): [number, number] {
  const scale = TILE * 2 ** zoom;
  const sin = Math.sin(lat * Math.PI / 180);
  return [(lng + 180) / 360 * scale, (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * scale];
}

function formatDistance(meters?: number): string { return !meters ? "暂未核验" : meters >= 1000 ? `${(meters / 1000).toFixed(1)} km` : `${Math.round(meters)} m`; }
function formatDuration(seconds?: number): string { if (!seconds) return "暂未核验"; const minutes = Math.round(seconds / 60); return minutes >= 60 ? `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分` : `${minutes} 分钟`; }

export function MapPanel({ plan, selectedDay, selectedSpotId, onSelectSpot }: Props) {
  const viewRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  const [zoom, setZoom] = useState(12);
  const [size, setSize] = useState({ width: 680, height: 310 });
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const day = plan.daysPlan.find((item) => item.day === selectedDay) ?? plan.daysPlan[0];
  const spots = useMemo(() => day?.items.filter((spot) => Number.isFinite(spot.lat) && Number.isFinite(spot.lng)) ?? [], [day]);

  useEffect(() => {
    const node = viewRef.current;
    if (!node) return;
    const update = () => setSize({ width: Math.max(280, node.clientWidth), height: Math.max(260, node.clientHeight) });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  if (!spots.length) return <section className="react-map-panel map-unavailable"><div><Icon name="mapPin"/><strong>地图暂不可用</strong><p>当前方案缺少可核验坐标，因此不显示任何城市底图。</p></div><div className="route-summary"><span>道路里程 <b>暂未核验</b></span><span>交通耗时 <b>暂未核验</b></span><span>路线状态 <b>无可用路线数据</b></span></div></section>;

  const center = { lat: spots.reduce((sum, spot) => sum + (spot.lat ?? 0), 0) / spots.length, lng: spots.reduce((sum, spot) => sum + (spot.lng ?? 0), 0) / spots.length };
  const { width, height } = size;
  const baseCenter = world(center.lat, center.lng, zoom);
  const centerWorld: [number, number] = [baseCenter[0] - pan.x, baseCenter[1] - pan.y];
  const startTileX = Math.floor((centerWorld[0] - width / 2) / TILE);
  const startTileY = Math.floor((centerWorld[1] - height / 2) / TILE);
  const endTileX = Math.ceil((centerWorld[0] + width / 2) / TILE);
  const endTileY = Math.ceil((centerWorld[1] + height / 2) / TILE);
  const tiles = [];
  for (let x = startTileX; x <= endTileX; x += 1) for (let y = startTileY; y <= endTileY; y += 1) {
    const count = 2 ** zoom;
    const wrappedX = (x % count + count) % count;
    if (y >= 0 && y < count) tiles.push({ x, y, url: `https://tile.openstreetmap.org/${zoom}/${wrappedX}/${y}.png` });
  }
  const point = (lat: number, lng: number) => {
    const value = world(lat, lng, zoom);
    return { x: value[0] - centerWorld[0] + width / 2, y: value[1] - centerWorld[1] + height / 2 };
  };
  const routeCoordinates: [number, number][] = day?.route?.geometry?.coordinates ?? spots.map((spot) => [spot.lng ?? 0, spot.lat ?? 0]);
  const routePoints = routeCoordinates.map(([lng, lat]) => point(lat, lng)).map((value) => `${value.x},${value.y}`).join(" ");
  const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest("button")) return;
    dragRef.current = { x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const moveDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    setPan({ x: drag.panX + event.clientX - drag.x, y: drag.panY + event.clientY - drag.y });
  };
  const stopDrag = () => { dragRef.current = null; };
  const hasRoute = Boolean(day?.route?.distance && day?.route?.duration);

  return <section className="react-map-panel">
    <div ref={viewRef} className="map-view react-map-view" style={{ "--map-width": `${width}px`, "--map-height": `${height}px` } as CSSProperties} onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={stopDrag} onPointerCancel={stopDrag}>
      <div className="map-preview-label">可拖动的路线预览</div>
      <div className="tile-layer">{tiles.map((tile) => <img key={`${tile.x}-${tile.y}`} src={tile.url} alt="" draggable={false} style={{ left: tile.x * TILE - centerWorld[0] + width / 2, top: tile.y * TILE - centerWorld[1] + height / 2 }}/>)}</div>
      <svg className="map-overlay" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none"><polyline points={routePoints} fill="none" stroke="#178df7" strokeWidth="4" strokeDasharray="7 5" strokeLinecap="round" strokeLinejoin="round"/></svg>
      {spots.map((spot, index) => { const position = point(spot.lat ?? 0, spot.lng ?? 0); return <button className={`react-map-marker${spot.id === selectedSpotId ? " active" : ""}`} type="button" key={spot.id} style={{ left: position.x, top: position.y }} onClick={() => onSelectSpot(spot.id, day.day)}><i>{index + 1}</i><span>{spot.name}</span></button>; })}
      <div className="map-zoom"><button type="button" aria-label="放大地图" onClick={() => { setZoom(Math.min(16, zoom + 1)); setPan({ x: 0, y: 0 }); }}><Icon name="plus"/></button><button type="button" aria-label="缩小地图" onClick={() => { setZoom(Math.max(5, zoom - 1)); setPan({ x: 0, y: 0 }); }}>−</button><button type="button" aria-label="重新定位路线" onClick={() => setPan({ x: 0, y: 0 })}><Icon name="mapPin"/></button></div>
      <div className="map-attribution">© OpenStreetMap contributors</div>
    </div>
    <div className="route-summary"><span>道路里程 <b>{formatDistance(day?.route?.distance)}</b></span><span>交通耗时 <b>{formatDuration(day?.route?.duration)}</b></span><span>路线状态 <b>{hasRoute ? day?.route?.quality === "routed" ? "已核验道路路线" : "透明估算" : "无可用路线数据"}</b></span></div>
  </section>;
}

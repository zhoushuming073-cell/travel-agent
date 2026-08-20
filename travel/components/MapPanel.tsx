"use client";

import { useMemo, useState } from "react";
import type { UiPlan } from "../types.ts";

interface Props {
  plan: UiPlan;
  selectedDay: number;
  selectedSpotId: string | null;
  onSelectSpot: (spotId: string, day: number) => void;
}

const TILE = 256;

function world(lat: number, lng: number, zoom: number): [number, number] {
  const scale = TILE * 2 ** zoom;
  const sin = Math.sin(lat * Math.PI / 180);
  return [(lng + 180) / 360 * scale, (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * scale];
}

function formatDistance(meters = 0): string { return meters >= 1000 ? `${(meters / 1000).toFixed(1)} km` : `${Math.round(meters)} m`; }
function formatDuration(seconds = 0): string { const minutes = Math.round(seconds / 60); return minutes >= 60 ? `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分` : `${minutes} 分钟`; }

export function MapPanel({ plan, selectedDay, selectedSpotId, onSelectSpot }: Props) {
  const [zoom, setZoom] = useState(12);
  const day = plan.daysPlan.find((item) => item.day === selectedDay) ?? plan.daysPlan[0];
  const spots = useMemo(() => day?.items.filter((spot) => Number.isFinite(spot.lat) && Number.isFinite(spot.lng)) ?? [], [day]);
  const center = useMemo(() => {
    if (!spots.length) return { lat: 30.2741, lng: 120.1551 };
    return { lat: spots.reduce((sum, spot) => sum + (spot.lat ?? 0), 0) / spots.length, lng: spots.reduce((sum, spot) => sum + (spot.lng ?? 0), 0) / spots.length };
  }, [spots]);
  const width = 680;
  const height = 310;
  const centerWorld = world(center.lat, center.lng, zoom);
  const startTileX = Math.floor((centerWorld[0] - width / 2) / TILE);
  const startTileY = Math.floor((centerWorld[1] - height / 2) / TILE);
  const tiles = [];
  for (let x = startTileX; x <= startTileX + 3; x += 1) for (let y = startTileY; y <= startTileY + 2; y += 1) {
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
  return <section className="react-map-panel">
    <div className="map-view react-map-view" style={{ "--map-width": `${width}px`, "--map-height": `${height}px` } as React.CSSProperties}>
      <div className="tile-layer">{tiles.map((tile) => <img key={`${tile.x}-${tile.y}`} src={tile.url} alt="" draggable={false} style={{ left: tile.x * TILE - centerWorld[0] + width / 2, top: tile.y * TILE - centerWorld[1] + height / 2 }}/>)}</div>
      <svg className="map-overlay" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none"><polyline points={routePoints} fill="none" stroke="#178df7" strokeWidth="4" strokeDasharray="7 5" strokeLinecap="round" strokeLinejoin="round"/></svg>
      {spots.map((spot, index) => { const position = point(spot.lat ?? 0, spot.lng ?? 0); return <button className={`react-map-marker${spot.id === selectedSpotId ? " active" : ""}`} type="button" key={spot.id} style={{ left: position.x, top: position.y }} onClick={() => onSelectSpot(spot.id, day.day)}><i>{index + 1}</i><span>{spot.name}</span></button>; })}
      {!spots.length && <div className="map-message">当前方案没有可绘制的坐标，不伪造路线</div>}
      <div className="map-zoom"><button type="button" onClick={() => setZoom(Math.min(16, zoom + 1))}>＋</button><button type="button" onClick={() => setZoom(Math.max(5, zoom - 1))}>−</button></div>
      <div className="map-attribution">© OpenStreetMap contributors</div>
    </div>
    <div className="route-summary"><span>道路里程 <b>{formatDistance(day?.route?.distance ?? 0)}</b></span><span>交通耗时 <b>{formatDuration(day?.route?.duration ?? 0)}</b></span><span>路线状态 <b>{day?.route?.quality === "routed" ? "Verified" : "Estimated"}</b></span></div>
  </section>;
}

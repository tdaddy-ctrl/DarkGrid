'use client';

// 3D tactical map: real San Francisco buildings (OpenStreetMap footprints + heights) extruded
// with deck.gl, the road graph, vehicles colored by state, the ambulance corridor and the
// blackout zone. HUD (brackets, compass, camera readout, scanlines) is plain HTML on top.
// deck.gl is loaded inside useEffect, so nothing WebGL runs during server rendering.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Deck, Layer, MapViewState } from '@deck.gl/core';
import type { LatLng, RoadGraph, SimSnapshot } from '@/types/sim';
import { OUTAGE_RADIUS_M } from '@/lib/config';

type Building = [height: number, ring: number[]];   // ring = flat [lng, lat, lng, lat, ...]

// Google Photorealistic 3D Tiles (Map Tiles API). Without a key, or if the tiles fail, the map
// falls back to OpenStreetMap footprints extruded to their real heights.
const GOOGLE_KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
const GOOGLE_TILES_URL = 'https://tile.googleapis.com/v1/3dtiles/root.json';
const NIGHT_TINT: [number, number, number, number] = [6, 11, 19, 150];   // grades the daytime photo city to night
// On a slow network the photo city can stay blank or blurry. If it hasn't reached building-level
// tiles by then, switch to the OSM blocks (instant, offline). The presenter can switch back.
const PHOTO_TIMEOUT_MS = 15000;
const PHOTO_MIN_DEPTH = 15;
type Rgba = [number, number, number, number];
type Pt = [number, number] | [number, number, number];
// Drawn over the buildings (tactical x-ray): the hazard, corridor and traffic must never hide behind towers.
const ON_TOP = { depthCompare: 'always' as const };

const STATE_RGB: Record<string, Rgba> = {
  DRIVING: [52, 211, 153, 235], REQUESTING_HELP: [255, 42, 84, 255], QUEUED_BEHIND: [251, 146, 60, 245],
  STAGED: [56, 189, 248, 245], ARRIVED: [148, 163, 184, 200],
};
const LEGEND: [string, string][] = [
  ['Driving', '#34d399'], ['Needs help', '#ff2a54'], ['Queued', '#fb923c'], ['Staged', '#38bdf8'],
];
// Home view: from the SoMa blackout looking north-northeast at the downtown skyline
// (Salesforce Tower), so the hazard sits in the lower middle and the towers fill the top.
const HOME = { longitude: -122.4030, latitude: 37.7776, zoom: 13.75, pitch: 60, bearing: 15 };
// Downtown map: from Market & 6th looking northeast over Union Square to the FiDi towers and the bay.
const HOME_DOWNTOWN = { longitude: -122.4078, latitude: 37.7838, zoom: 14.35, pitch: 58, bearing: 38 };
const SWAY_DEG = 10;              // idle camera sways ±10° instead of spinning away from the skyline
const SWAY_PERIOD_S = 40;
const IDLE_BEFORE_ORBIT_MS = 5000;
const TRAIL_POINTS = 5;           // ~1 s of positions at 4 updates/s
const UPDATE_MS = 250;            // the page sends a new snapshot 4x/s; cars glide between them
const STREAK_M = 14;              // a moving car draws as a light streak this long, pointing where it drives

type Car = { id: number; from: [number, number]; to: [number, number]; heading: number; state: string; moving: boolean };
const HAZARD_LABEL_ALT_M = 220;

export default function TacticalMap3D({ snapshot, graph, fallback, hazardCenter, hazardLabel = 'Substation fire' }: {
  snapshot: SimSnapshot; graph: RoadGraph; fallback: ReactNode; hazardCenter?: LatLng; hazardLabel?: string;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLDivElement>(null);
  const leaderRef = useRef<SVGLineElement>(null);
  const snapRef = useRef(snapshot);
  const hazardRef = useRef<LatLng | undefined>(hazardCenter);
  useEffect(() => { hazardRef.current = hazardCenter; }, [hazardCenter]);
  const [failed, setFailed] = useState(false);
  const [source, setSource] = useState<'google' | 'osm'>(GOOGLE_KEY ? 'google' : 'osm');
  const [credits, setCredits] = useState('');
  const switchRef = useRef<((to: 'google' | 'osm') => void) | null>(null);
  const trailsRef = useRef<{ map: Map<number, Pt[]>; data: { path: Pt[]; state: string }[] }>({ map: new Map(), data: [] });
  const carsRef = useRef<{ list: Car[]; at: number }>({ list: [], at: 0 });
  const [hud, setHud] = useState({ pitch: HOME.pitch, bearing: HOME.bearing, lat: HOME.latitude, lng: HOME.longitude, zoom: HOME.zoom });

  useEffect(() => {
    snapRef.current = snapshot;
    // Short light trails: each vehicle keeps its last few positions; staged cars drop theirs.
    const trails = trailsRef.current;
    const seen = new Set<number>();
    const data: { path: Pt[]; state: string }[] = [];
    for (const v of snapshot.vehicles) {
      seen.add(v.id);
      if (v.state === 'STAGED') { trails.map.delete(v.id); continue; }
      const path = trails.map.get(v.id) ?? [];
      const last = path[path.length - 1];
      if (!last || last[0] !== v.pos.lng || last[1] !== v.pos.lat) path.push([v.pos.lng, v.pos.lat, 2]);
      if (path.length > TRAIL_POINTS) path.shift();
      trails.map.set(v.id, path);
      if (path.length > 1) data.push({ path, state: v.state });
    }
    for (const id of trails.map.keys()) if (!seen.has(id)) trails.map.delete(id);
    trails.data = data;

    // Each car glides from where it was drawn last to its new position over the next update.
    const prev = new Map(carsRef.current.list.map((c) => [c.id, c]));
    const f = Math.min(1, (performance.now() - carsRef.current.at) / UPDATE_MS);
    carsRef.current = {
      at: performance.now(),
      list: snapshot.vehicles.filter((v) => v.state !== 'STAGED').map((v) => {
        const p = prev.get(v.id);
        const drawn: [number, number] = p ? [p.from[0] + (p.to[0] - p.from[0]) * f, p.from[1] + (p.to[1] - p.from[1]) * f] : [v.pos.lng, v.pos.lat];
        const to: [number, number] = [v.pos.lng, v.pos.lat];
        const jump = Math.abs(to[0] - drawn[0]) + Math.abs(to[1] - drawn[1]) > 0.01;   // a teleport (new trip) doesn't glide
        return { id: v.id, from: jump ? to : drawn, to, heading: v.headingDeg, state: v.state, moving: v.state === 'DRIVING' };
      }),
    };
  }, [snapshot]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let deck: Deck | null = null;
    let raf = 0;
    let cancelled = false;

    (async () => {
      try {
        const core = await import('@deck.gl/core');
        const L = await import('@deck.gl/layers');
        const geo = GOOGLE_KEY ? await import('@deck.gl/geo-layers').catch(() => null) : null;
        let photo = !!geo;
        if (!photo) setSource('osm');
        const res = await fetch('/data/sf_buildings.json');
        const buildings: Building[] = res.ok ? await res.json() : [];
        if (cancelled) return;

        const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
        const roads = graph.edges.map((e) => {
          const a = nodes.get(e.from)!, b = nodes.get(e.to)!;
          return [[a.lng, a.lat], [b.lng, b.lat]] as Pt[];
        });
        // Faint ground grid every ~250 m around the road network.
        const lats = graph.nodes.map((n) => n.lat), lngs = graph.nodes.map((n) => n.lng);
        const box = { s: Math.min(...lats) - 0.012, n: Math.max(...lats) + 0.02, w: Math.min(...lngs) - 0.012, e: Math.max(...lngs) + 0.012 };
        const grid: Pt[][] = [];
        for (let la = box.s; la <= box.n; la += 0.00226) grid.push([[box.w, la], [box.e, la]]);
        for (let lo = box.w; lo <= box.e; lo += 0.00285) grid.push([[lo, box.s], [lo, box.n]]);

        const lighting = new core.LightingEffect({
          // Neutral key light from the camera side (south) so facades facing us are lit and side
          // faces fall into shadow; a cool rim from behind separates towers from the dark ground.
          ambient: new core.AmbientLight({ color: [205, 212, 222], intensity: 0.45 }),
          key: new core.DirectionalLight({ color: [255, 248, 236], intensity: 1.6, direction: [0.5, 1, -1.6] }),
          rim: new core.DirectionalLight({ color: [80, 140, 190], intensity: 0.7, direction: [-0.4, -1, -0.6] }),
        });

        const osmLayers = (): Layer[] => [
          new L.PathLayer({
            id: 'grid', data: grid, getPath: (d: Pt[]) => d, getColor: [56, 189, 248, 14],
            getWidth: 1, widthUnits: 'pixels',
          }),
          new L.PathLayer({
            id: 'road-glow', data: roads, getPath: (d: Pt[]) => d, getColor: [56, 189, 248, 22],
            getWidth: 7, widthUnits: 'pixels', capRounded: true,
          }),
          new L.PathLayer({
            id: 'roads', data: roads, getPath: (d: Pt[]) => d, getColor: [70, 96, 122, 200],
            getWidth: 1.4, widthUnits: 'pixels',
          }),
          new L.PolygonLayer<Building>({
            id: 'buildings', data: buildings, positionFormat: 'XY',
            getPolygon: (b) => b[1], getElevation: (b) => b[0],
            extruded: true, wireframe: true, filled: true, stroked: false, elevationScale: 1.15,
            // Graphite towers, a shade lighter the taller they are, so the skyline reads above the blocks.
            getFillColor: (b) => (b[0] > 120 ? [58, 65, 76, 250] : b[0] > 40 ? [44, 50, 59, 248] : [32, 37, 44, 245]),
            getLineColor: (b) => (b[0] > 120 ? [160, 200, 230, 80] : [120, 140, 160, 34]),
            material: { ambient: 0.45, diffuse: 0.75, shininess: 40, specularColor: [90, 100, 112] },
          }),
        ];

        let lastCredits = '';
        let tileErrors = 0;
        let maxDepth = 0;
        let photoSince = performance.now();
        let autoFallback = true;   // off once the presenter picks a mode by hand
        const fallBackToOsm = () => {
          if (!photo) return;
          photo = false;
          staticLayers = osmLayers();
          setSource('osm');
        };
        switchRef.current = (to) => {
          autoFallback = false;
          if (to === 'osm') { fallBackToOsm(); return; }
          if (!geo || photo) return;
          photo = true; tileErrors = 0; photoSince = performance.now();
          staticLayers = photoLayers();
          setSource('google');
        };
        const tint = [[box.w - 0.05, box.s - 0.05], [box.e + 0.05, box.s - 0.05], [box.e + 0.05, box.n + 0.05], [box.w - 0.05, box.n + 0.05]] as Pt[];
        const photoLayers = (): Layer[] => [
          new geo!.Tile3DLayer({
            id: 'google-3d',
            data: GOOGLE_TILES_URL,
            loadOptions: {
              fetch: { headers: { 'X-GOOG-API-KEY': GOOGLE_KEY! } },
              // The default 32 MB cache evicts building-level tiles as soon as they load, so the
              // city stays blurry; give it room and fetch more tiles in parallel.
              tileset: { maximumMemoryUsage: 1024, memoryCacheOverflow: 256, maximumScreenSpaceError: 6, maxRequests: 48 },
            },
            onTilesetLoad: (tileset) => {
              // Google's terms: show the data providers for the tiles on screen.
              tileset.options.onTraversalComplete = (selected) => {
                const names = new Set<string>();
                for (const tile of selected) {
                  const copyright = (tile.content as { gltf?: { asset?: { copyright?: string } } } | undefined)?.gltf?.asset?.copyright;
                  copyright?.split(';').forEach((c) => { if (c.trim()) names.add(c.trim()); });
                }
                const text = [...names].join('; ');
                if (text !== lastCredits) { lastCredits = text; setCredits(text); }
                return selected;
              };
            },
            onTileLoad: (tile) => { maxDepth = Math.max(maxDepth, tile.depth); },
            onTileError: () => { if (autoFallback && ++tileErrors > 5) fallBackToOsm(); },
          }),
          new L.SolidPolygonLayer({
            id: 'night-tint', data: [tint], getPolygon: (d: Pt[]) => d, getFillColor: NIGHT_TINT, parameters: ON_TOP,
          }),
          new L.PathLayer({
            id: 'grid', data: grid, getPath: (d: Pt[]) => d, getColor: [56, 189, 248, 12], parameters: ON_TOP,
            getWidth: 1, widthUnits: 'pixels',
          }),
          new L.PathLayer({
            id: 'roads', data: roads, getPath: (d: Pt[]) => d, getColor: [56, 189, 248, 55], parameters: ON_TOP,
            getWidth: 1, widthUnits: 'pixels',
          }),
        ];
        let staticLayers: Layer[] = photo ? photoLayers() : osmLayers();

        // The home view is framed for the real San Francisco map; other maps (the test grid) center on themselves.
        const sf = Math.abs(graph.center.lat - 37.77) < 0.02 && Math.abs(graph.center.lng + 122.408) < 0.02;
        const downtown = Math.abs(graph.center.lat - 37.788) < 0.01 && Math.abs(graph.center.lng + 122.406) < 0.01;
        let view: MapViewState = downtown ? { ...HOME_DOWNTOWN, maxPitch: 70 } : sf ? { ...HOME, maxPitch: 70 } : { longitude: graph.center.lng, latitude: graph.center.lat, zoom: 14.2, pitch: 50, bearing: 15, maxPitch: 70 };
        let swayBase = view.bearing ?? 0;
        let swayT = 0;
        let lastTouch = 0;
        let interacting = false;

        deck = new core.Deck({
          parent: host,
          width: '100%', height: '100%',
          viewState: view,
          controller: { inertia: 400, dragRotate: true, touchRotate: true },
          effects: [lighting],
          onViewStateChange: ({ viewState }) => { view = viewState as MapViewState; lastTouch = performance.now(); },
          onInteractionStateChange: (s) => { interacting = !!(s.isDragging || s.isPanning || s.isRotating || s.isZooming); if (interacting) lastTouch = performance.now(); },
          onError: () => { if (photo) fallBackToOsm(); else setFailed(true); },
        });

        // Cars: moving ones are short light streaks along their heading (bright head, soft glow);
        // stopped ones are dots, and cars asking for help pulse red.
        const mPerDegLat = 110540;
        const mPerDegLng = 111320 * Math.cos((graph.center.lat * Math.PI) / 180);
        const carLayers = (layers: typeof L, now: number): Layer[] => {
          const { list, at } = carsRef.current;
          const f = Math.min(1, (now - at) / UPDATE_MS);
          const cars = list.map((c) => {
            const lng = c.from[0] + (c.to[0] - c.from[0]) * f, lat = c.from[1] + (c.to[1] - c.from[1]) * f;
            const h = (c.heading * Math.PI) / 180;
            const tail: Pt = [lng - (Math.sin(h) * STREAK_M) / mPerDegLng, lat - (Math.cos(h) * STREAK_M) / mPerDegLat, 2];
            return { ...c, head: [lng, lat, 2] as Pt, tail };
          });
          const moving = cars.filter((c) => c.moving), stopped = cars.filter((c) => !c.moving);
          const help = stopped.filter((c) => c.state === 'REQUESTING_HELP');
          const pulse = 0.5 + 0.5 * Math.sin(now / 300);
          return [
            new layers.LineLayer({
              id: 'car-streak-glow', parameters: ON_TOP, data: moving, getSourcePosition: (c: typeof moving[number]) => c.tail,
              getTargetPosition: (c: typeof moving[number]) => c.head, getWidth: 6, widthUnits: 'pixels',
              getColor: (c: typeof moving[number]) => { const k = STATE_RGB[c.state]; return [k[0], k[1], k[2], 45]; },
            }),
            new layers.LineLayer({
              id: 'car-streak', parameters: ON_TOP, data: moving, getSourcePosition: (c: typeof moving[number]) => c.tail,
              getTargetPosition: (c: typeof moving[number]) => c.head, getWidth: 2, widthUnits: 'pixels',
              getColor: (c: typeof moving[number]) => STATE_RGB[c.state],
            }),
            new layers.ScatterplotLayer({
              id: 'car-heads', parameters: ON_TOP, data: moving, getPosition: (c: typeof moving[number]) => c.head,
              getRadius: 1.6, radiusUnits: 'pixels', getFillColor: [235, 255, 245, 255],
            }),
            new layers.ScatterplotLayer({
              id: 'car-stopped', parameters: ON_TOP, data: stopped, getPosition: (c: typeof stopped[number]) => c.head,
              getRadius: 2.2, radiusUnits: 'pixels', getFillColor: (c: typeof stopped[number]) => STATE_RGB[c.state],
            }),
            new layers.ScatterplotLayer({
              id: 'car-help-pulse', parameters: ON_TOP, data: help, getPosition: (c: typeof help[number]) => c.head,
              getRadius: 4 + 5 * pulse, radiusUnits: 'pixels', stroked: true, filled: false, lineWidthUnits: 'pixels',
              getLineWidth: 1.2, getLineColor: [255, 42, 84, Math.round(200 * (1 - pulse))],
              updateTriggers: { getRadius: Math.round(now / 40), getLineColor: Math.round(now / 40) },
            }),
          ];
        };

        let last = performance.now();
        let lastHud = 0;
        const frame = (now: number) => {
          raf = requestAnimationFrame(frame);   // schedule first: one bad frame must not stop the loop
          if (photo && autoFallback && maxDepth < PHOTO_MIN_DEPTH && now - photoSince > PHOTO_TIMEOUT_MS) fallBackToOsm();
          const dt = (now - last) / 1000; last = now;
          if (!interacting && now - lastTouch > IDLE_BEFORE_ORBIT_MS) {
            swayT += dt;
            view = { ...view, bearing: swayBase + SWAY_DEG * Math.sin((2 * Math.PI * swayT) / SWAY_PERIOD_S) };
          } else {
            swayBase = view.bearing ?? 0;   // after the user moves the camera, sway around where they left it
            swayT = 0;
          }
          const snap = snapRef.current;
          const hz = hazardRef.current ?? graph.center;
          const center: [number, number] = [hz.lng, hz.lat];
          const outage = snap.darkNodes.length > 0;
          const pulse = (now / 1000) % 2.4 / 2.4;
          const dyn: Layer[] = [];
          if (outage) {
            dyn.push(
              new L.ScatterplotLayer({
                id: 'hazard-glow', parameters: ON_TOP, data: [0.35, 0.65, 1], getPosition: () => center,
                getRadius: (f: number) => OUTAGE_RADIUS_M * f, getFillColor: (f: number) => [255, 42, 84, Math.round(40 * (1.2 - f))],
                stroked: false, filled: true, radiusUnits: 'meters',
              }),
              new L.ScatterplotLayer({
                id: 'hazard-rings', parameters: ON_TOP, data: [0, 1 / 3, 2 / 3], getPosition: () => center,
                getRadius: (o: number) => OUTAGE_RADIUS_M * (0.15 + 0.85 * ((pulse + o) % 1)),
                getLineColor: (o: number) => [255, 42, 84, Math.round(200 * (1 - ((pulse + o) % 1)))],
                stroked: true, filled: false, lineWidthUnits: 'pixels', getLineWidth: 2, radiusUnits: 'meters',
                updateTriggers: { getRadius: pulse, getLineColor: pulse },
              }),
              new L.ScatterplotLayer({
                id: 'hazard-edge', parameters: ON_TOP, data: [0], getPosition: () => center, getRadius: OUTAGE_RADIUS_M,
                getLineColor: [255, 42, 84, 150], stroked: true, filled: false, lineWidthUnits: 'pixels', getLineWidth: 1.2, radiusUnits: 'meters',
              }),
              new L.ScatterplotLayer({
                id: 'dark-nodes', parameters: ON_TOP, data: snap.darkNodes, getPosition: (p: { lat: number; lng: number }) => [p.lng, p.lat, 1],
                getRadius: 2.6, radiusUnits: 'pixels', getFillColor: [255, 90, 115, 255],
                opacity: 0.45 + 0.4 * Math.abs(Math.sin(now / 420)),
              }),
            );
          }
          if (snap.corridor.length > 1) {
            const path = snap.corridor.map((p) => [p.lng, p.lat, 3] as Pt);
            dyn.push(
              new L.PathLayer({ id: 'corridor-glow', parameters: ON_TOP, data: [path], getPath: (d: Pt[]) => d, getColor: [255, 184, 0, 55], getWidth: 12, widthUnits: 'pixels', capRounded: true, jointRounded: true }),
              new L.PathLayer({ id: 'corridor', parameters: ON_TOP, data: [path], getPath: (d: Pt[]) => d, getColor: [255, 200, 60, 255], getWidth: 3, widthUnits: 'pixels', capRounded: true, jointRounded: true }),
            );
          }
          dyn.push(
            new L.ScatterplotLayer({
              id: 'lots', data: snap.lots, getPosition: (l: SimSnapshot['lots'][number]) => [l.pos.lng, l.pos.lat, 2],
              getRadius: 7, radiusUnits: 'pixels', stroked: true, filled: true, lineWidthUnits: 'pixels', getLineWidth: 1.5,
              getFillColor: [56, 189, 248, 40], getLineColor: [56, 189, 248, 220],
            }),
            new L.TextLayer({
              id: 'lot-labels', data: snap.lots, getPosition: (l: SimSnapshot['lots'][number]) => [l.pos.lng, l.pos.lat, 2],
              getText: (l: SimSnapshot['lots'][number]) => `${l.used}/${l.cap}`, getSize: 11, getColor: [125, 211, 252, 255],
              getPixelOffset: [0, -16], fontFamily: 'JetBrains Mono, monospace', fontWeight: 600, billboard: true,
            }),
            new L.PathLayer({
              id: 'trails', parameters: ON_TOP, data: trailsRef.current.data, getPath: (d: { path: Pt[] }) => d.path,
              getColor: (d: { state: string }) => { const c = STATE_RGB[d.state]; return [c[0], c[1], c[2], 45]; },
              getWidth: 2, widthUnits: 'pixels', capRounded: true, jointRounded: true,
            }),
            ...carLayers(L, now),
          );
          const amb = snap.ambulance;
          if (amb) {
            dyn.push(
              new L.ScatterplotLayer({
                id: 'amb-halo', parameters: ON_TOP, data: [amb], getPosition: (a: typeof amb) => [a.pos.lng, a.pos.lat, 4],
                getRadius: 12 + 6 * Math.abs(Math.sin(now / 260)), radiusUnits: 'pixels', getFillColor: [255, 184, 0, 70],
                updateTriggers: { getRadius: Math.round(now / 50) },
              }),
              new L.ScatterplotLayer({
                id: 'amb', parameters: ON_TOP, data: [amb], getPosition: (a: typeof amb) => [a.pos.lng, a.pos.lat, 5],
                getRadius: 5, radiusUnits: 'pixels', getFillColor: [255, 255, 255, 255], stroked: true,
                getLineColor: [255, 184, 0, 255], lineWidthUnits: 'pixels', getLineWidth: 2,
              }),
            );
          }
          deck!.setProps({ viewState: view, layers: [...staticLayers, ...dyn] });

          // Floating label over the blackout, with a dashed leader line down to the ground.
          // getViewports() asserts until deck.gl has finished initializing its first frame.
          let vp: ReturnType<Deck['getViewports']>[number] | undefined;
          try { vp = deck!.getViewports()[0]; } catch { vp = undefined; }
          const label = labelRef.current, leader = leaderRef.current;
          if (vp && label && leader) {
            if (outage) {
              const [gx, gy] = vp.project([center[0], center[1], 0]);
              const [lx, ly] = vp.project([center[0], center[1], HAZARD_LABEL_ALT_M]);
              label.style.display = 'flex';
              label.style.transform = `translate(${lx}px, ${ly}px) translate(-50%, -100%)`;
              leader.setAttribute('x1', String(lx)); leader.setAttribute('y1', String(ly));
              leader.setAttribute('x2', String(gx)); leader.setAttribute('y2', String(gy));
              leader.style.display = '';
            } else {
              label.style.display = 'none';
              leader.style.display = 'none';
            }
          }
          if (now - lastHud > 200) {
            lastHud = now;
            setHud({ pitch: view.pitch ?? 0, bearing: (((view.bearing ?? 0) % 360) + 360) % 360, lat: view.latitude, lng: view.longitude, zoom: view.zoom });
          }
        };
        raf = requestAnimationFrame(frame);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();

    return () => { cancelled = true; switchRef.current = null; cancelAnimationFrame(raf); deck?.finalize(); };
  }, [graph]);

  if (failed) return <>{fallback}</>;

  const outage = snapshot.darkNodes.length > 0;
  return (
    <div className="relative h-full min-h-0 overflow-hidden bg-[#070a0f]">
      <div ref={hostRef} className="absolute inset-0" />

      {/* depth: distance haze toward the horizon (top of the frame is farthest away) */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 [background:linear-gradient(180deg,rgba(9,14,22,0.8)_0%,rgba(9,14,22,0.4)_12%,rgba(9,14,22,0.08)_30%,transparent_45%)]" />
      <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-1/3 [background:radial-gradient(ellipse_at_50%_0%,rgba(56,189,248,0.10),transparent_70%)]" />

      {/* screen treatment: scanlines + vignette + faint crosshair */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 [background:repeating-linear-gradient(0deg,rgba(255,255,255,0.025)_0px,rgba(255,255,255,0.025)_1px,transparent_1px,transparent_3px)]" />
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 [background:radial-gradient(ellipse_at_center,transparent_55%,rgba(0,0,0,0.65)_100%)]" />
      <svg aria-hidden="true" className="pointer-events-none absolute inset-0 h-full w-full">
        <line ref={leaderRef} stroke="rgba(255,90,115,0.8)" strokeWidth="1" strokeDasharray="3 4" style={{ display: 'none' }} />
      </svg>
      <div aria-hidden="true" className="pointer-events-none absolute left-1/2 top-1/2 size-6 -translate-x-1/2 -translate-y-1/2 opacity-30">
        <span className="absolute left-1/2 top-0 h-full w-px bg-dg-cyan" /><span className="absolute left-0 top-1/2 h-px w-full bg-dg-cyan" />
      </div>

      {/* floating hazard label (positioned every frame) */}
      <div ref={labelRef} className="pointer-events-none absolute left-0 top-0 hidden items-center gap-2 rounded-full border border-[#ff2a54]/50 bg-[#2a0b12]/70 px-3 py-1.5 font-mono text-xs font-semibold text-[#ffd0d8] shadow-[0_0_30px_-6px_rgba(255,42,84,.9)] backdrop-blur" style={{ display: 'none' }}>
        <svg aria-hidden="true" viewBox="0 0 16 16" className="size-3.5 text-[#ff5a73]" fill="currentColor"><path d="M8 1c1 2.5 4 4 4 8a4 4 0 0 1-8 0c0-1.6.8-2.8 1.6-3.6C6 7 6.5 8 7.3 8.3 7 6 7.5 3.4 8 1z" /></svg>
        {hazardLabel}
      </div>

      <ScaleRuler lat={hud.lat} zoom={hud.zoom} />

      {/* city source: Google photoreal (needs a good network) or OSM blocks (instant, offline) */}
      <div role="group" aria-label="City model" className="absolute left-7 top-[4.25rem] flex rounded-md border border-dg-line bg-black/55 p-0.5 backdrop-blur">
        {([['google', 'Photo'], ['osm', 'Blocks']] as const).map(([value, label]) => (
          <button key={value} type="button" aria-pressed={source === value}
            disabled={value === 'google' && !GOOGLE_KEY}
            onClick={() => switchRef.current?.(value)}
            className={`min-h-7 rounded px-2 font-mono text-[10px] font-semibold uppercase tracking-[0.14em] transition-colors disabled:opacity-40 ${
              source === value ? 'bg-dg-cyan/20 text-dg-cyan' : 'text-dg-label hover:text-slate-100'}`}>
            {label}
          </button>
        ))}
      </div>

      {/* corner brackets */}
      {['left-3 top-3 border-l border-t', 'right-3 top-3 border-r border-t', 'bottom-3 right-3 border-b border-r', 'bottom-3 left-3 border-b border-l'].map((c) => (
        <span key={c} aria-hidden="true" className={`pointer-events-none absolute size-5 border-dg-cyan/50 ${c}`} />
      ))}

      {/* compass */}
      <div aria-label={`Heading ${Math.round(hud.bearing)} degrees`} role="img" className="pointer-events-none absolute right-6 top-6 grid size-20 place-items-center rounded-full border border-dg-line bg-black/30 backdrop-blur-sm">
        <div className="relative size-full" style={{ transform: `rotate(${-hud.bearing}deg)` }}>
          {(['N', 'E', 'S', 'W'] as const).map((d, i) => (
            <span key={d} className={`absolute font-mono text-[9px] font-semibold ${d === 'N' ? 'text-dg-red' : 'text-dg-label'}`}
              style={{ left: '50%', top: '50%', transform: `rotate(${i * 90}deg) translateY(-31px) rotate(${-i * 90}deg) translate(-50%, -50%)` }}>{d}</span>
          ))}
          <span className="absolute left-1/2 top-1/2 h-6 w-px -translate-x-1/2 -translate-y-full bg-dg-red" />
        </div>
        <span className="absolute size-1.5 rounded-full bg-dg-cyan" />
      </div>

      {/* legend */}
      <ul className="absolute bottom-4 left-4 flex flex-wrap gap-x-3 gap-y-1 rounded-lg border border-dg-line bg-black/55 px-3 py-1.5 backdrop-blur">
        {LEGEND.map(([label, color]) => (
          <li key={label} className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-dg-label">
            <span aria-hidden="true" className="size-2 rounded-full" style={{ background: color, boxShadow: `0 0 8px ${color}` }} />{label}
          </li>
        ))}
        <li className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-dg-label">
          <span aria-hidden="true" className="h-0.5 w-3 rounded bg-dg-amber" />Corridor
        </li>
      </ul>

      {/* camera readout */}
      <dl className="absolute bottom-4 right-4 grid grid-cols-[auto_auto] gap-x-3 rounded-lg border border-dg-line bg-black/55 px-3 py-2 font-mono text-[10px] tabular-nums text-dg-label backdrop-blur">
        <dt>PITCH</dt><dd className="text-right text-slate-200">{hud.pitch.toFixed(0)}°</dd>
        <dt>YAW</dt><dd className="text-right text-slate-200">{hud.bearing.toFixed(1)}°</dd>
        <dt>ZOOM</dt><dd className="text-right text-slate-200">{hud.zoom.toFixed(2)}</dd>
        <dt>LAT/LON</dt><dd className="text-right text-slate-200">{hud.lat.toFixed(4)}, {hud.lng.toFixed(4)}</dd>
      </dl>

      {!outage && (
        <p className="pointer-events-none absolute left-1/2 top-4 -translate-x-1/2 font-mono text-[10px] uppercase tracking-[0.2em] text-dg-label">Drag to rotate · scroll to zoom</p>
      )}
      <p className="pointer-events-none absolute bottom-1 left-1/2 max-w-[70%] -translate-x-1/2 truncate text-center font-mono text-[9px] text-slate-500">
        {source === 'google'
          ? <>Google{credits ? ` · ${credits}` : ''} · roads © OpenStreetMap contributors</>
          : 'Buildings & roads © OpenStreetMap contributors'}
      </p>
    </div>
  );
}

// Scale bar for the map center: deck.gl's web-mercator tiles are 512 px at zoom 0.
function ScaleRuler({ lat, zoom }: { lat: number; zoom: number }) {
  const mPerPx = (40075016.686 * Math.cos((lat * Math.PI) / 180)) / (512 * 2 ** zoom);
  const meters = [100, 200, 250, 500, 1000, 2000].find((m) => m / mPerPx >= 90) ?? 2000;
  const px = meters / mPerPx;
  const label = (m: number) => (m >= 1000 ? `${m / 1000} km` : `${m} m`);
  return (
    <div aria-label={`Scale: ${Math.round(px)} pixels is ${label(meters)} at the map center`} role="img"
      className="pointer-events-none absolute left-7 top-7 font-mono text-[9px] tabular-nums text-dg-label">
      <div className="relative h-2" style={{ width: px }}>
        <span className="absolute inset-x-0 bottom-0 h-px bg-dg-label/70" />
        {Array.from({ length: 11 }, (_, i) => (
          <span key={i} className={`absolute bottom-0 w-px bg-dg-label/70 ${i % 5 === 0 ? 'h-2' : 'h-1'}`} style={{ left: `${i * 10}%` }} />
        ))}
      </div>
      <div className="mt-0.5 flex justify-between" style={{ width: px }}>
        <span>0</span><span>{label(meters / 2)}</span><span>{label(meters)}</span>
      </div>
    </div>
  );
}

'use client';

// 3D tactical map: real San Francisco buildings (OpenStreetMap footprints + heights) extruded
// with deck.gl, the road graph, vehicles colored by state, the ambulance corridor and the
// blackout zone. HUD (brackets, compass, camera readout, scanlines) is plain HTML on top.
// deck.gl is loaded inside useEffect, so nothing WebGL runs during server rendering.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Ambulance as AmbulanceIcon, ChevronLeft, ChevronRight, Cross, Crosshair, House, Info, Layers3, TriangleAlert } from 'lucide-react';
import type { Deck, Layer, MapViewState } from '@deck.gl/core';
import type { Ambulance, LatLng, RoadGraph, SimSnapshot, RoadMotion } from '@/types/sim';
import { OUTAGE_RADIUS_M } from '@/lib/config';
import { civilianPos, createTraffic, updateTraffic } from './civilianTraffic';

type Building = [height: number, ring: number[]];   // ring = flat [lng, lat, lng, lat, ...]

// Google Photorealistic 3D Tiles (Map Tiles API). Without a key, or if the tiles fail, the map
// falls back to OpenStreetMap footprints extruded to their real heights.
const GOOGLE_KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
const GOOGLE_TILES_URL = 'https://tile.googleapis.com/v1/3dtiles/root.json';
// If no photo tile has loaded by then (blocked key, no network), switch to the OSM blocks
// (instant, offline). A slow but working network keeps the photo city; it sharpens as tiles arrive.
const PHOTO_TIMEOUT_MS = 60000;
type Rgba = [number, number, number, number];
type Pt = [number, number] | [number, number, number];
// Ground overlays respect the city's depth buffer. Buildings occlude routes and
// traffic naturally; overlays never write depth or create x-ray views.
const SURFACE_DEPTH = { depthCompare: 'less-equal' as const, depthWriteEnabled: false };
// Additive light: streetlights and the ambulance's flashers brighten what is under them.
const GLOW = { ...SURFACE_DEPTH, blend: true, blendColorOperation: 'add' as const, blendColorSrcFactor: 'src-alpha' as const, blendColorDstFactor: 'one' as const,
  blendAlphaOperation: 'add' as const, blendAlphaSrcFactor: 'one' as const, blendAlphaDstFactor: 'one-minus-src-alpha' as const };

const STATE_RGB: Record<string, Rgba> = {
  DRIVING: [52, 211, 153, 235], REQUESTING_HELP: [255, 42, 84, 255], QUEUED_BEHIND: [251, 146, 60, 245],
  STAGED: [56, 189, 248, 245], ARRIVED: [148, 163, 184, 200], YIELDING: [250, 204, 21, 255], YIELDED: [45, 212, 191, 245],
};
const LEGEND: [string, string][] = [
  ['Driving', '#34d399'], ['Needs help', '#ff2a54'], ['Queued', '#fb923c'], ['Staged', '#38bdf8'], ['Civilian cars', '#9ca3af'],
];
// Everyday car colors for civilian traffic (the Waymos are all white).
const CIVILIAN_PAINT: Rgba[] = [[24, 26, 30, 255], [70, 74, 82, 255], [130, 134, 140, 255], [120, 18, 22, 255], [22, 38, 70, 255], [190, 190, 196, 255]];
// Home view: from the SoMa blackout looking north-northeast at the downtown skyline
// (Salesforce Tower), so the hazard sits in the lower middle and the towers fill the top.
const HOME = { longitude: -122.4030, latitude: 37.7776, zoom: 13.75, pitch: 60, bearing: 15 };
// Downtown map: from Market & 6th looking northeast over Union Square to the FiDi towers and the bay.
const HOME_DOWNTOWN = { longitude: -122.4024, latitude: 37.7904, zoom: 15.1, pitch: 64, bearing: 24 };
const PRESENT_DOWNTOWN = { longitude: -122.3988, latitude: 37.7915, zoom: 15.35, pitch: 66, bearing: -18 };
const SWAY_DEG = 10;              // idle camera sways ±10° instead of spinning away from the skyline
const SWAY_PERIOD_S = 40;
const IDLE_BEFORE_ORBIT_MS = 5000;
const ROTATE_STEP_DEG = 45;       // one press of the on-map rotate buttons
const TRAIL_POINTS = 5;           // ~1 s of positions at 4 updates/s
// Vehicles are 3D models built by scripts/build-car-models.mjs at real size (meters). Far out they would be
// a pixel or two, so a model never draws smaller than CAR_MIN_PX pixels per meter (about 4 px for a car).
const WAYMO_GLB = '/models/waymo.glb';
const AMBULANCE_GLB = '/models/ambulance.glb';
const CAR_MIN_PX = 1.7;
// MapView looks at the ambulance; pitch places the eye above and behind that target.
const CHASE_ZOOM = 18;
const CHASE_PITCH = 55;
const CAR_LIFT_M = 0.5;           // models sit this far above the sampled ground so small height errors never bury them
// Models face +X (east) at yaw 0; yaw turns them to the compass heading (clockwise from north).
const orient = (headingDeg: number): [number, number, number] => [0, 90 - headingDeg, 0];
// Painted parts take the scene lights like the buildings; lamps and beacons ignore lighting so they glow.
const PAINT = { ambient: 0.5, diffuse: 0.75, shininess: 64, specularColor: [190, 195, 205] as [number, number, number] };
const GLASS = { ambient: 0.3, diffuse: 0.4, shininess: 128, specularColor: [230, 235, 245] as [number, number, number] };

// Google's photoreal city uses WGS84 ellipsoid heights; the street heights in sf_ground.json
// (scripts/fetch-ground.mjs) are above sea level. Measured against the tiles at downtown intersections
// (picked street surface minus sea-level height, lower quartile), the difference is about:
const PHOTO_GROUND_OFFSET_M = -31.0;

// Height of the ground (m above sea level) anywhere on the map, from the nearest intersections (inverse distance).
function groundSampler(points: [number, number, number][]): (lng: number, lat: number) => number {
  const CELL = 0.002;
  const key = (cx: number, cy: number) => cx * 1_000_003 + cy;   // numeric keys: this runs thousands of times a frame
  const grid = new Map<number, [number, number, number][]>();
  for (const p of points) {
    const k = key(Math.floor(p[0] / CELL), Math.floor(p[1] / CELL));
    (grid.get(k) ?? grid.set(k, []).get(k)!).push(p);
  }
  return (lng, lat) => {
    const cx = Math.floor(lng / CELL), cy = Math.floor(lat / CELL);
    let w = 0, z = 0;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      for (const p of grid.get(key(cx + dx, cy + dy)) ?? []) {
        const d2 = ((p[0] - lng) * 0.79) ** 2 + (p[1] - lat) ** 2 + 1e-10;
        const k = 1 / d2;
        w += k; z += k * p[2];
      }
    }
    return w ? z / w : 0;
  };
}

type CarPart = {
  name: string; color: Rgba; glow: boolean;
  mesh: { attributes: { positions: { value: Float32Array; size: 3 }; normals: { value: Float32Array; size: 3 } }; indices: { value: Uint16Array | Uint32Array; size: 1 } };
};
// Reads one of our GLBs (a single mesh, one primitive per material, plain float accessors) into one mesh per
// material, turned from glTF's Y-up (x forward, y up, z right) to deck's Z-up (x forward, y left, z up).
async function loadCarParts(url: string): Promise<CarPart[]> {
  const buf = await (await fetch(url)).arrayBuffer();
  const jsonLen = new DataView(buf).getUint32(12, true);
  type Gltf = {
    accessors: { bufferView: number; componentType: number; count: number; type: string }[];
    bufferViews: { byteOffset: number }[];
    materials: { name: string; emissiveFactor?: number[]; pbrMetallicRoughness: { baseColorFactor: number[] } }[];
    meshes: { primitives: { attributes: { POSITION: number; NORMAL: number }; indices: number; material: number }[] }[];
  };
  const gltf = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 20, jsonLen))) as Gltf;
  const bin = 20 + jsonLen + 8;
  const read = (i: number) => {
    const a = gltf.accessors[i], start = bin + gltf.bufferViews[a.bufferView].byteOffset;
    const n = a.count * (a.type === 'VEC3' ? 3 : 1);
    if (a.componentType === 5126) return new Float32Array(buf.slice(start, start + n * 4));
    return a.componentType === 5125 ? new Uint32Array(buf.slice(start, start + n * 4)) : new Uint16Array(buf.slice(start, start + n * 2));
  };
  const zUp = (v: Float32Array) => {
    const out = new Float32Array(v.length);
    for (let i = 0; i < v.length; i += 3) { out[i] = v[i]; out[i + 1] = -v[i + 2]; out[i + 2] = v[i + 1]; }
    return out;
  };
  const srgb = (c: number) => Math.round(255 * Math.min(1, c) ** (1 / 2.2));
  return gltf.meshes[0].primitives.map((p) => {
    const m = gltf.materials[p.material], c = m.pbrMetallicRoughness.baseColorFactor;
    return {
      name: m.name, glow: !!m.emissiveFactor, color: [srgb(c[0]), srgb(c[1]), srgb(c[2]), 255],
      mesh: {
        attributes: { positions: { value: zUp(read(p.attributes.POSITION) as Float32Array), size: 3 }, normals: { value: zUp(read(p.attributes.NORMAL) as Float32Array), size: 3 } },
        indices: { value: read(p.indices) as Uint16Array | Uint32Array, size: 1 },
      },
    };
  });
}

type XY = [number, number];
type Mover = { id: number; pos: LatLng; headingDeg: number; state: string; road?: RoadMotion };
type Glide = { from: XY; to: XY; path: XY[]; lengths: number[]; road?: RoadMotion; at: number; heading: number; aim: number; state: string };
export type Motion = { t: number; vehicles: Mover[]; ambulance: Ambulance | null };

function pushMotion(cars: Glider, amb: Glider, m: Motion, now: number) {
  cars.push(m.vehicles.filter((v) => v.state !== 'STAGED'), now);   // staged cars are shown as lot counts
  amb.push(m.ambulance ? [{ id: 0, pos: m.ambulance.pos, headingDeg: m.ambulance.headingDeg, state: m.ambulance.status, road: m.ambulance.road }] : [], now);
}

const xyDistance = (a: XY, b: XY) => Math.hypot((b[0] - a[0]) * 111320 * Math.cos(a[1] * Math.PI / 180), (b[1] - a[1]) * 110540);

function pathLengths(path: XY[]): number[] {
  const lengths = [0];
  for (let i = 1; i < path.length; i++) lengths.push(lengths[i - 1] + xyDistance(path[i - 1], path[i]));
  return lengths;
}

function projectedDistance(path: XY[], point: XY, lengths: number[]): number {
  let best = Infinity, distance = 0;
  const sx = 111320 * Math.cos(point[1] * Math.PI / 180);
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i];
    const dx = (b[0] - a[0]) * sx, dy = (b[1] - a[1]) * 110540;
    const px = (point[0] - a[0]) * sx, py = (point[1] - a[1]) * 110540;
    const t = Math.max(0, Math.min(1, (px * dx + py * dy) / (dx * dx + dy * dy || 1)));
    const deviation = (px - t * dx) ** 2 + (py - t * dy) ** 2;
    if (deviation < best) { best = deviation; distance = lengths[i - 1] + (lengths[i] - lengths[i - 1]) * t; }
  }
  return distance;
}

function pathSlice(path: XY[], from: XY, to: XY): XY[] | null {
  const lengths = pathLengths(path);
  const start = projectedDistance(path, from, lengths), end = projectedDistance(path, to, lengths);
  if (end < start - 0.1) return null;
  return [from, ...path.filter((_, i) => lengths[i] > start + 0.01 && lengths[i] < end - 0.01), to];
}

/** Reconstruct only contiguous streets. Missing samples snap rather than crossing a block. */
export function streetInterpolationPath(previous: RoadMotion | undefined, next: RoadMotion | undefined, from: XY, to: XY): XY[] {
  const shape = (road: RoadMotion): XY[] => road.shape.map(p => [p.lng, p.lat]);
  if (previous && next) {
    if (previous.laneId === next.laneId) return pathSlice(shape(next), from, to) ?? [to];
    if (previous.to === next.from) {
      const before = shape(previous), after = shape(next);
      const tail = pathSlice(before, from, before[before.length - 1]);
      const head = pathSlice(after, after[0], to);
      if (tail && head) return [...tail, ...head.slice(1)];
    }
    return [to];
  }
  return xyDistance(from, to) <= 8 ? [from, to] : [to];
}

// Positions arrive in samples (every sim step when live, 4x/s in replay). Each car glides from where
// it is drawn to its newest position over one sample interval, and turns smoothly toward the way it
// is actually moving instead of snapping to the next lane's direction.
export class Glider {
  items = new Map<number, Glide>();
  private at = 0;
  private interval = 250;
  push(list: Mover[], now: number) {
    if (this.at) this.interval += (Math.min(400, Math.max(30, now - this.at)) - this.interval) * 0.3;
    this.at = now;
    const seen = new Set<number>();
    for (const v of list) {
      seen.add(v.id);
      const g = this.items.get(v.id);
      const to: [number, number] = [v.pos.lng, v.pos.lat];
      const drawn = g ? this.where(g, now) : to;
      const dx = (to[0] - drawn[0]) * 111320 * Math.cos((to[1] * Math.PI) / 180), dy = (to[1] - drawn[1]) * 110540;
      let path: XY[] = [to];
      if (g) {
        const remaining = pathSlice(g.path, drawn, g.to) ?? [g.to];
        const extension = streetInterpolationPath(g.road, v.road, g.to, to);
        path = extension.length > 1 ? [...remaining, ...extension.slice(1)] : extension;
      }
      const jump = path.length < 2 || Math.hypot(dx, dy) > 800;
      if (jump) path = [to];
      const aim = v.road ? v.headingDeg : !jump && Math.hypot(dx, dy) > 0.3 ? (Math.atan2(dx, dy) * 180) / Math.PI : g?.aim ?? v.headingDeg;
      this.items.set(v.id, { from: path[0], to, path, lengths: pathLengths(path), road: v.road, at: now, heading: g && !jump ? g.heading : aim, aim, state: v.state });
    }
    for (const id of this.items.keys()) if (!seen.has(id)) this.items.delete(id);
  }
  where(g: Glide, now: number): [number, number] {
    const f = Math.min(1, (now - g.at) / this.interval);
    const distance = f * g.lengths[g.lengths.length - 1];
    for (let i = 1; i < g.path.length; i++) {
      if (g.lengths[i] < distance) continue;
      const k = (distance - g.lengths[i - 1]) / (g.lengths[i] - g.lengths[i - 1] || 1);
      return [g.path[i - 1][0] + (g.path[i][0] - g.path[i - 1][0]) * k, g.path[i - 1][1] + (g.path[i][1] - g.path[i - 1][1]) * k];
    }
    return g.to;
  }
  turn(dt: number) {
    const k = 1 - Math.exp(-dt * 9);
    for (const g of this.items.values()) g.heading += ((((g.aim - g.heading) % 360) + 540) % 360 - 180) * k;
  }
}
const HAZARD_LABEL_ALT_M = 220;

export default function TacticalMap3D({ snapshot, graph, fallback, hazardCenter, hazardLabel = 'Substation fire', motion, follow = false, onFollowChange, presenting = false, active = true }: {
  snapshot: SimSnapshot; graph: RoadGraph; fallback: ReactNode; hazardCenter?: LatLng; hazardLabel?: string;
  motion?: () => Motion | null;              // live positions, read every frame (null while replaying)
  follow?: boolean;                          // chase camera behind the ambulance
  presenting?: boolean;
  active?: boolean;
  onFollowChange?: (on: boolean) => void;    // the user turned follow on or off (button, drag, camera button)
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLDivElement>(null);
  const leaderRef = useRef<SVGLineElement>(null);
  const hospitalLabelRef = useRef<HTMLDivElement>(null);
  const ambulanceLabelRef = useRef<HTMLDivElement>(null);
  const hospitalLeaderRef = useRef<SVGLineElement>(null);
  const ambulanceLeaderRef = useRef<SVGLineElement>(null);
  const presentingRef = useRef(presenting);
  useEffect(() => { presentingRef.current = presenting; }, [presenting]);
  const snapRef = useRef(snapshot);
  const hazardRef = useRef<LatLng | undefined>(hazardCenter);
  useEffect(() => { hazardRef.current = hazardCenter; }, [hazardCenter]);
  const followRef = useRef(follow);
  const dragButtonRef = useRef<number | null>(null);
  const onFollowRef = useRef(onFollowChange);
  useEffect(() => { followRef.current = follow; onFollowRef.current = onFollowChange; }, [follow, onFollowChange]);
  const motionRef = useRef(motion);
  useEffect(() => { motionRef.current = motion; }, [motion]);
  const [failed, setFailed] = useState(false);
  const [source, setSource] = useState<'google' | 'osm'>(GOOGLE_KEY ? 'google' : 'osm');
  const [credits, setCredits] = useState('');
  const switchRef = useRef<((to: 'google' | 'osm') => void) | null>(null);
  const cameraRef = useRef<((cmd: 'left' | 'right' | 'home' | 'in' | 'out' | 'incident') => void) | null>(null);
  const trailsRef = useRef<{ map: Map<number, Pt[]>; data: { path: Pt[]; state: string }[] }>({ map: new Map(), data: [] });
  const carsRef = useRef(new Glider());
  const ambRef = useRef(new Glider());
  const activeRef = useRef(active);
  useEffect(() => { activeRef.current = active; }, [active]);
  const streamRef = useRef({ mode: snapshot.mode, t: snapshot.t });

  useEffect(() => {
    const previous = streamRef.current;
    if (previous.mode !== snapshot.mode || snapshot.t < previous.t) {
      carsRef.current.items.clear(); ambRef.current.items.clear();
      trailsRef.current = { map: new Map(), data: [] };
      pushMotion(carsRef.current, ambRef.current, snapshot, performance.now());
    }
    streamRef.current = { mode: snapshot.mode, t: snapshot.t };
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

    // Replay (no live positions): glide between the 4x/s snapshots instead.
    if (!motionRef.current?.()) pushMotion(carsRef.current, ambRef.current, snapshot, performance.now());
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
        const mesh = await import('@deck.gl/mesh-layers');
        const [waymoParts, ambulanceParts] = await Promise.all([loadCarParts(WAYMO_GLB), loadCarParts(AMBULANCE_GLB)])
          .catch((): [CarPart[], CarPart[]] => [[], []]);
        const geo = GOOGLE_KEY ? await import('@deck.gl/geo-layers').catch(() => null) : null;
        let photo = !!geo;
        setSource(photo ? 'google' : 'osm');
        const res = await fetch('/data/sf_buildings.json');
        const buildings: Building[] = res.ok ? await res.json() : [];
        const groundRes = await fetch('/data/sf_ground.json').catch(() => null);
        const seaLevel = groundSampler(groundRes?.ok ? await groundRes.json() : []);
        // Ground height to draw at: the real street surface in the photo city, flat 0 for the OSM blocks.
        const gz = (lng: number, lat: number) => (photo ? seaLevel(lng, lat) + PHOTO_GROUND_OFFSET_M : 0);
        if (cancelled) return;

        const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
        const roads = graph.edges.map((e) => {
          const a = nodes.get(e.from)!, b = nodes.get(e.to)!;
          return (e.geometry ?? [a, b]).map(p => [p.lng, p.lat] as Pt);
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
        let tilesLoaded = 0;
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
          if (!geo) return;
          if (photo) { setSource('google'); return; }
          photo = true; tileErrors = 0; photoSince = performance.now();
          staticLayers = photoLayers();
          setSource('google');
        };
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
            onTileLoad: () => { tilesLoaded++; },
            onTileError: () => { if (autoFallback && ++tileErrors > 5) fallBackToOsm(); },
          }),
          new L.PathLayer({
            id: 'grid', data: grid, getPath: (d: Pt[]) => d, getColor: [56, 189, 248, 12], parameters: SURFACE_DEPTH,
            getWidth: 1, widthUnits: 'pixels',
          }),
          new L.PathLayer({
            id: 'roads', data: roads, getPath: (d: Pt[]) => d.map(([x, y]) => [x, y, gz(x, y) + 0.5] as Pt), getColor: [56, 189, 248, 55], parameters: SURFACE_DEPTH,
            getWidth: 1, widthUnits: 'pixels',
          }),
        ];
        let staticLayers: Layer[] = photo ? photoLayers() : osmLayers();

        // The home view is framed for the real San Francisco map; other maps (the test grid) center on themselves.
        const sf = Math.abs(graph.center.lat - 37.77) < 0.02 && Math.abs(graph.center.lng + 122.408) < 0.02;
        const downtown = Math.abs(graph.center.lat - 37.788) < 0.01 && Math.abs(graph.center.lng + 122.406) < 0.01;
        const home: MapViewState = downtown ? { ...HOME_DOWNTOWN, maxPitch: 70 } : sf ? { ...HOME, maxPitch: 70 } : { longitude: graph.center.lng, latitude: graph.center.lat, zoom: 14.2, pitch: 50, bearing: 15, maxPitch: 70 };
        const presentationHome: MapViewState = downtown ? { ...PRESENT_DOWNTOWN, maxPitch: 70 } : { ...home, zoom: home.zoom + 0.5, pitch: 64 };
        let wasPresenting = presentingRef.current;
        let view: MapViewState = wasPresenting ? presentationHome : home;
        let swayBase = view.bearing ?? 0;
        let swayT = 0;
        let lastTouch = 0;
        let interacting = false;
        let preserveView = false;
        let chasing = false;
        let alignHeading = true;
        let settleZoom = true;
        let settlePitch = true;
        // On-map buttons ease the camera toward a target instead of jumping.
        let target: MapViewState | null = null;
        let incidentCamera = 0;
        cameraRef.current = (cmd) => {
          if (followRef.current) {
            if (cmd === 'left' || cmd === 'right') alignHeading = false;
            if (cmd === 'in' || cmd === 'out') settleZoom = false;
          }
          if ((cmd === 'home' || cmd === 'incident') && followRef.current) {
            followRef.current = false;
            onFollowRef.current?.(false);
          }
          const from = target ?? view;
          const incidents = (snapRef.current.incidents ?? []).filter(i => i.status !== 'CLEARED');
          const incident = cmd === 'incident' && incidents.length ? incidents[incidentCamera++ % incidents.length] : null;
          const next = incident ? { ...from, longitude: incident.pos.lng, latitude: incident.pos.lat,
            zoom: 18.1, pitch: 52, bearing: incident.headingDeg + 20 }
            : cmd === 'home' ? home : cmd === 'in' || cmd === 'out'
            ? { ...from, zoom: Math.max(0, Math.min(20, from.zoom + (cmd === 'in' ? 0.5 : -0.5))) }
            : { ...from, bearing: (from.bearing ?? 0) + (cmd === 'left' ? -ROTATE_STEP_DEG : ROTATE_STEP_DEG) };
          if (followRef.current) { view = next; target = null; }
          else target = next;
          lastTouch = performance.now();
        };

        deck = new core.Deck({
          parent: host,
          width: '100%', height: '100%',
          viewState: view,
          // Left drag pans; right drag rotates and tilts. No inertia competes with tracking.
          controller: { inertia: false, dragMode: 'pan', dragRotate: true, touchRotate: true },
          effects: [lighting],
          onViewStateChange: ({ viewState, interactionState }) => {
            if (followRef.current) {
              if (interactionState.isRotating) {
                alignHeading = false;
                settlePitch = false;
              }
              if (interactionState.isZooming) settleZoom = false;
            }
            view = viewState as MapViewState; target = null; lastTouch = performance.now();
            if (followRef.current && interactionState.isDragging && dragButtonRef.current === 0) {
              followRef.current = false;
              onFollowRef.current?.(false);
            }
          },
          onInteractionStateChange: (s) => { interacting = !!(s.isDragging || s.isPanning || s.isRotating || s.isZooming); if (interacting) lastTouch = performance.now(); },
          onError: () => { if (photo) fallBackToOsm(); else setFailed(true); },
        });

        // Cars: white Waymo models gliding between updates (headlights and taillights glow). A car that is
        // queued or waiting for help gets a colored ring on the ground; help requests also pulse red.
        // One SimpleMeshLayer per material of a model, all sharing positions and headings.
        const modelLayers = <T,>(id: string, parts: CarPart[], data: T[], pos: (d: T) => Pt, heading: (d: T) => number, scale: number, now: number,
          paint?: (d: T) => Rgba): Layer[] => {
          const strobe = Math.floor(now / 250) % 2 === 0;
          return parts.map((p) => {
            const color: Rgba = p.name === 'beaconR' ? (strobe ? p.color : [70, 8, 8, 255]) : p.name === 'beaconW' ? (strobe ? [60, 60, 60, 255] : p.color) : p.color;
            return new mesh.SimpleMeshLayer({
              id: `${id}-${p.name}`, data, mesh: p.mesh, getPosition: pos, getOrientation: (d: T) => orient(heading(d)),
              getColor: paint && p.name === 'paint' ? paint : color, sizeScale: scale, material: p.glow ? false : p.name === 'glass' ? GLASS : PAINT,
              updateTriggers: { getColor: strobe },
            });
          });
        };
        // Real size up close; far out, scaled up so a car stays a few pixels long.
        const carScale = () => Math.max(1, CAR_MIN_PX / ((512 * 2 ** view.zoom) / (40075016.686 * Math.cos((view.latitude * Math.PI) / 180))));

        const carLayers = (layers: typeof L, now: number): Layer[] => {
          const glider = carsRef.current;
          const cars = [...glider.items.values()].map((g) => {
            const [lng, lat] = glider.where(g, now);
            return { heading: g.heading, state: g.state, head: [lng, lat, gz(lng, lat) + CAR_LIFT_M] as Pt };
          });
          const flagged = cars.filter((c) => c.state !== 'DRIVING');
          const help = flagged.filter((c) => c.state === 'REQUESTING_HELP');
          const pulse = 0.5 + 0.5 * Math.sin(now / 300);
          return [
            new layers.ScatterplotLayer({
              id: 'car-rings', parameters: SURFACE_DEPTH, data: flagged, getPosition: (c: typeof flagged[number]) => c.head,
              getRadius: 5, radiusUnits: 'pixels', stroked: true, filled: true, lineWidthUnits: 'pixels', getLineWidth: 1.5,
              getFillColor: (c: typeof flagged[number]) => { const k = STATE_RGB[c.state]; return [k[0], k[1], k[2], 50]; },
              getLineColor: (c: typeof flagged[number]) => STATE_RGB[c.state],
            }),
            ...modelLayers('car', waymoParts, cars, (c) => c.head, (c) => c.heading, carScale(), now),
            new layers.ScatterplotLayer({
              id: 'car-help-pulse', parameters: SURFACE_DEPTH, data: help, getPosition: (c: typeof help[number]) => c.head,
              getRadius: 6 + 6 * pulse, radiusUnits: 'pixels', stroked: true, filled: false, lineWidthUnits: 'pixels',
              getLineWidth: 1.2, getLineColor: [255, 42, 84, Math.round(200 * (1 - pulse))],
              updateTriggers: { getRadius: Math.round(now / 40), getLineColor: Math.round(now / 40) },
            }),
          ];
        };

        // Civilian traffic (visual only, see civilianTraffic.ts): same body as the Waymo, no sensors.
        const traffic = createTraffic(graph);
        const civilianParts = waymoParts.filter((p) => p.name !== 'sensor');
        const nodeIdAt = new Map(graph.nodes.map((n) => [`${n.lat},${n.lng}`, n.id]));
        let darkIds = new Set<number>();
        let trafficSimT = -1;
        const mPerLng = 111320 * Math.cos((graph.center.lat * Math.PI) / 180);

        // Streetlights at every lit intersection; the ones inside the blackout go out.
        let lightsPhoto = photo;
        let streetLights: Pt[] = [];
        let lightSignature = '';


        let last = performance.now();
        let lastMotionT = -1;
        const frame = (now: number) => {
          raf = requestAnimationFrame(frame);   // schedule first: one bad frame must not stop the loop
          if (!activeRef.current) { last = now; lastMotionT = -1; trafficSimT = -1; return; }
          if (photo && autoFallback && tilesLoaded === 0 && now - photoSince > PHOTO_TIMEOUT_MS) fallBackToOsm();
          const dt = (now - last) / 1000; last = now;
          const isPresenting = presentingRef.current;
          if (isPresenting !== wasPresenting) {
            wasPresenting = isPresenting;
            if (!followRef.current) target = isPresenting ? presentationHome : home;
          }
          const live = motionRef.current?.();
          if (live && live.t !== lastMotionT) { lastMotionT = live.t; pushMotion(carsRef.current, ambRef.current, live, now); }
          carsRef.current.turn(dt);
          ambRef.current.turn(dt);
          const ambGlide = ambRef.current.items.get(0);
          const ambNow = snapRef.current.ambulance && ambGlide
            ? { ...snapRef.current.ambulance, pos: (([lng, lat]) => ({ lng, lat }))(ambRef.current.where(ambGlide, now)), headingDeg: ambGlide.heading }
            : snapRef.current.ambulance;
          const chase = followRef.current && ambNow?.status !== 'WAITING' ? ambNow : null;
          if (chase) {
            if (!chasing) {
              alignHeading = true;
              settleZoom = true;
              settlePitch = true;
              chasing = true;
            }
            // One frame-rate-independent animation, with shortest-path heading interpolation.
            const k = 1 - Math.exp(-Math.min(dt, 0.1) * 4);
            const perspectiveK = 1 - Math.exp(-Math.min(dt, 0.1) * 2.5);
            const headingDelta = (((chase.headingDeg - (view.bearing ?? 0)) % 360) + 540) % 360 - 180;
            const ground = gz(chase.pos.lng, chase.pos.lat) + CAR_LIFT_M;
            view = { ...view,
              bearing: alignHeading ? (view.bearing ?? 0) + headingDelta * k : view.bearing,
              zoom: settleZoom ? view.zoom + (CHASE_ZOOM - view.zoom) * perspectiveK : view.zoom,
              pitch: settlePitch ? (view.pitch ?? 0) + (CHASE_PITCH - (view.pitch ?? 0)) * perspectiveK : view.pitch,
              latitude: view.latitude + (chase.pos.lat - view.latitude) * k, longitude: view.longitude + (chase.pos.lng - view.longitude) * k,
              position: [0, 0, (view.position?.[2] ?? 0) + (ground - (view.position?.[2] ?? 0)) * k] };
            target = null; lastTouch = now;
            preserveView = true;
            swayBase = view.bearing ?? 0; swayT = 0;
          } else if (target) {
            const k = Math.min(1, dt * 6), t = target;
            const ease = (a: number | undefined, b: number | undefined) => (a ?? 0) + ((b ?? 0) - (a ?? 0)) * k;
            view = { ...view, longitude: ease(view.longitude, t.longitude), latitude: ease(view.latitude, t.latitude),
              zoom: ease(view.zoom, t.zoom), pitch: ease(view.pitch, t.pitch), bearing: ease(view.bearing, t.bearing) };
            if (Math.abs((view.bearing ?? 0) - (t.bearing ?? 0)) < 0.1 && Math.abs(view.zoom - t.zoom) < 0.001) { view = { ...t }; target = null; }
            lastTouch = now;
            swayBase = view.bearing ?? 0; swayT = 0;
          } else if (!isPresenting && !preserveView && !interacting && now - lastTouch > IDLE_BEFORE_ORBIT_MS) {
            swayT += dt;
            view = { ...view, bearing: swayBase + SWAY_DEG * Math.sin((2 * Math.PI * swayT) / SWAY_PERIOD_S) };
          } else {
            swayBase = view.bearing ?? 0;   // after the user moves the camera, sway around where they left it
            swayT = 0;
          }
          if (!chase) chasing = false;
          const snap = snapRef.current;
          const hz = snap.outage?.center ?? hazardRef.current ?? graph.center;
          const outageRadius = snap.outage?.radiusM ?? OUTAGE_RADIUS_M;
          const center: [number, number, number] = [hz.lng, hz.lat, gz(hz.lng, hz.lat)];
          const outage = snap.darkNodes.length > 0;
          const pulse = (now / 1000) % 2.4 / 2.4;
          // The red wash reads well from above but floods a street-level close-up: fade it when zoomed in.
          const hazardFade = Math.round(Math.min(1, Math.max(0.15, (17.5 - view.zoom) / 2)) * 20) / 20;
          const dyn: Layer[] = [];
          const signature = `${snap.darkNodes.length}:${hz.lng}:${hz.lat}:${photo}`;
          if (signature !== lightSignature || photo !== lightsPhoto) {
            lightSignature = signature;
            lightsPhoto = photo;
            darkIds = new Set(snap.darkNodes.map((p) => nodeIdAt.get(`${p.lat},${p.lng}`) ?? -1));
            streetLights = graph.nodes.filter((n) => !darkIds.has(n.id)).map((n) => [n.lng, n.lat, gz(n.lng, n.lat) + 3] as Pt);
          }
          // Civilian cars advance with sim time (frozen while paused or replaying).
          const simDt = live ? (trafficSimT < 0 ? 0 : Math.max(0, live.t - trafficSimT)) : 0;
          if (live) trafficSimT = live.t;
          updateTraffic(traffic, simDt, dt, ambNow, darkIds, snap.corridor,
            new Set((snap.incidents ?? []).filter(i => i.status !== 'CLEARED').map(i => i.edgeId)));
          // Positions once per frame; every part layer of the model reads the same array.
          const civilians = traffic.cars.map((c) => {
            const p = civilianPos(traffic, c);
            return { at: [p.lng, p.lat, gz(p.lng, p.lat) + CAR_LIFT_M] as Pt, heading: c.heading, paint: c.paint };
          });
          dyn.push(new L.ScatterplotLayer({
            id: 'street-lights', parameters: GLOW, data: streetLights, getPosition: (p: Pt) => p,
            getRadius: 2.5, radiusUnits: 'pixels', getFillColor: [255, 186, 110, photo ? 150 : 110],
          }));
          if (outage) {
            // Power is out: the whole zone drops into shadow, buildings included.
            dyn.push(new L.ScatterplotLayer({
              id: 'blackout-shade', visible: !isPresenting, parameters: SURFACE_DEPTH, data: [0], getPosition: () => center,
              getRadius: outageRadius, radiusUnits: 'meters', getFillColor: [2, 4, 10, photo ? 120 : 90],
            }));
            dyn.push(
              new L.ScatterplotLayer({
                id: 'hazard-glow', visible: !isPresenting, parameters: SURFACE_DEPTH, data: [0.35, 0.65, 1], getPosition: () => center,
                getRadius: (f: number) => outageRadius * f, getFillColor: (f: number) => [255, 42, 84, Math.round(40 * (1.2 - f) * hazardFade)],
                stroked: false, filled: true, radiusUnits: 'meters', updateTriggers: { getFillColor: hazardFade },
              }),
              new L.ScatterplotLayer({
                id: 'hazard-rings', visible: !isPresenting, parameters: SURFACE_DEPTH, data: [0, 1 / 3, 2 / 3], getPosition: () => center,
                getRadius: (o: number) => outageRadius * (0.15 + 0.85 * ((pulse + o) % 1)),
                getLineColor: (o: number) => [255, 42, 84, Math.round(200 * (1 - ((pulse + o) % 1)))],
                stroked: true, filled: false, lineWidthUnits: 'pixels', getLineWidth: 2, radiusUnits: 'meters',
                updateTriggers: { getRadius: pulse, getLineColor: pulse },
              }),
              new L.ScatterplotLayer({
                id: 'hazard-edge', parameters: SURFACE_DEPTH, data: [0], getPosition: () => center, getRadius: outageRadius,
                getLineColor: isPresenting ? [185, 204, 216, 170] : [255, 42, 84, 150], stroked: true, filled: false, lineWidthUnits: 'pixels', getLineWidth: 1.2, radiusUnits: 'meters',
              }),
              new L.ScatterplotLayer({
                id: 'dark-nodes', visible: !isPresenting, parameters: SURFACE_DEPTH, data: snap.darkNodes, getPosition: (p: { lat: number; lng: number }) => [p.lng, p.lat, gz(p.lng, p.lat) + 1],
                getRadius: 2.6, radiusUnits: 'pixels', getFillColor: [255, 90, 115, 255],
                opacity: 0.45 + 0.4 * Math.abs(Math.sin(now / 420)),
              }),
            );
          }
          if (snap.corridor.length > 1) {
            const path = snap.corridor.map((p) => [p.lng, p.lat, gz(p.lng, p.lat) + 1.5] as Pt);
            dyn.push(
              new L.PathLayer({ id: 'corridor-glow', parameters: GLOW, data: [path], getPath: (d: Pt[]) => d, getColor: [255, 170, 48, 95], getWidth: 10, widthUnits: 'pixels', capRounded: true, jointRounded: true }),
              new L.PathLayer({ id: 'corridor', parameters: SURFACE_DEPTH, data: [path], getPath: (d: Pt[]) => d, getColor: [255, 208, 109, 255], getWidth: 3.5, widthUnits: 'pixels', capRounded: true, jointRounded: true }),
            );
          }
          const segments = snap.corridorStatus?.segments ?? [];
          const rescue = ambNow?.mission;
          if (rescue) dyn.push(
            new L.ScatterplotLayer({ id: 'rescue-pickup', parameters: SURFACE_DEPTH, data: [rescue.pickup],
              getPosition: (p: LatLng) => [p.lng, p.lat, gz(p.lng, p.lat) + 1], getRadius: 7, radiusUnits: 'meters', radiusMinPixels: 6,
              getFillColor: [255, 190, 60, 140], stroked: true, getLineColor: [255, 220, 140, 255], getLineWidth: 2, lineWidthUnits: 'pixels' }),
            new L.TextLayer({ id: 'rescue-pickup-label', parameters: SURFACE_DEPTH, data: [rescue.pickup],
              getPosition: (p: LatLng) => [p.lng, p.lat, gz(p.lng, p.lat) + 4],
              getText: () => rescue.phase === 'TO_PICKUP' ? 'RESCUE PICKUP' : rescue.phase === 'PICKING_UP' ? 'LOADING PATIENT' : 'PATIENT PICKED UP',
              getSize: 11, getColor: [255, 220, 140, 255], getPixelOffset: [0, -20], billboard: true,
              background: true, getBackgroundColor: [22, 29, 36, 235], backgroundPadding: [7, 5], fontFamily: 'sans-serif' }),
          );
          if (segments.length) dyn.push(new L.PathLayer({
            id: 'corridor-verification', parameters: SURFACE_DEPTH, data: segments,
            getPath: (s: typeof segments[number]) => (s.shape ?? [s.from, s.to]).map(p => [p.lng, p.lat, gz(p.lng, p.lat) + 1.8] as Pt),
            getColor: (s: typeof segments[number]) => s.state === 'CLEAR' ? [45, 212, 191, 255] : s.state === 'CLEARING' ? [255, 190, 60, 255] : [255, 95, 110, 255],
            getWidth: 4, widthUnits: 'pixels', capRounded: true,
          }));
          const crashes = (snap.incidents ?? []).filter(i => i.status !== 'CLEARED');
          if (crashes.length) {
            const wrecks = crashes.flatMap(i => [-1, 1].map(side => ({
              pos: { lng: i.pos.lng + side * 3 / mPerLng, lat: i.pos.lat + side * 2 / 110540 }, heading: i.headingDeg + side * 35,
            })));
            dyn.push(
              ...modelLayers('collision-wrecks', civilianParts, wrecks, w => [w.pos.lng, w.pos.lat, gz(w.pos.lng, w.pos.lat) + CAR_LIFT_M], w => w.heading, carScale(), now, () => [140, 42, 45, 255]),
              new L.ScatterplotLayer({ id: 'collision-marker', parameters: SURFACE_DEPTH, data: crashes,
                getPosition: (i: typeof crashes[number]) => [i.pos.lng, i.pos.lat, gz(i.pos.lng, i.pos.lat) + 1],
                getRadius: 14, radiusUnits: 'meters', radiusMinPixels: 9, stroked: true, filled: true,
                getFillColor: [255, 66, 80, 65], getLineColor: [255, 110, 120, 255], getLineWidth: 2, lineWidthUnits: 'pixels' }),
              new L.TextLayer({ id: 'collision-label', parameters: SURFACE_DEPTH, data: crashes,
                getPosition: (i: typeof crashes[number]) => [i.pos.lng, i.pos.lat, gz(i.pos.lng, i.pos.lat) + 7],
                getText: (i: typeof crashes[number]) => i.status === 'RESPONDING' ? 'COLLISION · RECOVERY ON SCENE' : 'COLLISION · ROAD CLOSED',
                getSize: 11, getColor: [255, 204, 207, 255], getPixelOffset: [0, -23], billboard: true,
                background: true, getBackgroundColor: [35, 16, 24, 235], backgroundPadding: [8, 5], fontFamily: 'sans-serif', fontWeight: 600 }),
            );
          }
          dyn.push(
            new L.ScatterplotLayer({
              id: 'lots', visible: !isPresenting, data: snap.lots, getPosition: (l: SimSnapshot['lots'][number]) => [l.pos.lng, l.pos.lat, gz(l.pos.lng, l.pos.lat) + 2],
              getRadius: 7, radiusUnits: 'pixels', stroked: true, filled: true, lineWidthUnits: 'pixels', getLineWidth: 1.5,
              getFillColor: [56, 189, 248, 40], getLineColor: [56, 189, 248, 220],
            }),
            new L.TextLayer({
              id: 'lot-labels', visible: !isPresenting, data: snap.lots, getPosition: (l: SimSnapshot['lots'][number]) => [l.pos.lng, l.pos.lat, gz(l.pos.lng, l.pos.lat) + 2],
              getText: (l: SimSnapshot['lots'][number]) => `${l.used}/${l.cap}`, getSize: 11, getColor: [125, 211, 252, 255],
              getPixelOffset: [0, -16], fontFamily: 'JetBrains Mono, monospace', fontWeight: 600, billboard: true,
            }),
            new L.PathLayer({
              id: 'trails', visible: !isPresenting, parameters: SURFACE_DEPTH, data: trailsRef.current.data, getPath: (d: { path: Pt[] }) => d.path.map(([x, y]) => [x, y, gz(x, y) + 1] as Pt),
              getColor: (d: { state: string }) => { const c = STATE_RGB[d.state]; return [c[0], c[1], c[2], 45]; },
              getWidth: 2, widthUnits: 'pixels', capRounded: true, jointRounded: true,
            }),
            ...carLayers(L, now),
            ...modelLayers('civ', civilianParts, civilians, (c) => c.at, (c) => c.heading, carScale(), now, (c) => CIVILIAN_PAINT[c.paint]),
          );
          const amb = ambNow;
          if (amb) {
            const flash = Math.floor(now / 250) % 2 === 0;   // red / white light bar washing over the street
            const ground: Pt = [amb.pos.lng, amb.pos.lat, gz(amb.pos.lng, amb.pos.lat) + 1];
            dyn.push(
              new L.ScatterplotLayer({
                id: 'amb-flash', parameters: GLOW, data: [0, 1], getPosition: () => ground,
                getRadius: (k: number) => (k ? 7 : 18), radiusUnits: 'meters', radiusMinPixels: 8, radiusMaxPixels: 90,
                getFillColor: (k: number) => (flash ? [255, 30, 50, k ? 70 : 32] : [190, 215, 255, k ? 55 : 24]),
                updateTriggers: { getFillColor: flash },
              }),
              ...modelLayers('amb', ambulanceParts, [amb], (a) => [a.pos.lng, a.pos.lat, gz(a.pos.lng, a.pos.lat) + CAR_LIFT_M], (a) => a.headingDeg, view.zoom >= 17 ? 1 : Math.min(2, carScale()), now),
            );
          }
          deck!.setProps({ viewState: view, layers: [...staticLayers, ...dyn] });

          // Floating label over the blackout, with a dashed leader line down to the ground.
          // getViewports() asserts until deck.gl has finished initializing its first frame.
          let vp: ReturnType<Deck['getViewports']>[number] | undefined;
          try { vp = deck!.getViewports()[0]; } catch { vp = undefined; }
          const pin = (element: HTMLDivElement | null, line: SVGLineElement | null, p: Pt, lift: number) => {
            if (!element || !line || !vp || !isPresenting) { if (element) element.style.display = 'none'; if (line) line.style.display = 'none'; return; }
            const [x, y] = vp.project(p);
            const visible = Number.isFinite(x) && Number.isFinite(y) && x > 12 && x < host.clientWidth - 12 && y > 15 && y < host.clientHeight - 75;
            element.style.display = visible ? 'flex' : 'none'; line.style.display = visible ? '' : 'none';
            if (!visible) return;
            element.style.transform = `translate(${x}px, ${y - lift}px) translate(-50%, -100%)`;
            line.setAttribute('x1', String(x)); line.setAttribute('x2', String(x));
            line.setAttribute('y1', String(y - lift)); line.setAttribute('y2', String(y));
          };
          const hospital = graph.pois.hospital;
          pin(hospitalLabelRef.current, hospitalLeaderRef.current, [hospital.lng, hospital.lat, gz(hospital.lng, hospital.lat) + 2], 35);
          const nearHospital = ambNow && Math.hypot((ambNow.pos.lng - hospital.lng) * mPerLng, (ambNow.pos.lat - hospital.lat) * 110540) < 150;
          pin(ambulanceLabelRef.current, ambulanceLeaderRef.current, ambNow ? [ambNow.pos.lng, ambNow.pos.lat, gz(ambNow.pos.lng, ambNow.pos.lat) + 3] : [0, 0, 0], nearHospital ? -85 : 35);
          const label = labelRef.current, leader = leaderRef.current;
          if (vp && label && leader) {
            if (outage) {
              const [gx, gy] = vp.project(center);
              const [lx, ly] = vp.project([center[0], center[1], center[2] + HAZARD_LABEL_ALT_M]);
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
        };
        raf = requestAnimationFrame(frame);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();

    return () => { cancelled = true; switchRef.current = null; cameraRef.current = null; cancelAnimationFrame(raf); deck?.finalize(); };
  }, [graph]);

  if (failed) return <>{fallback}</>;

  return (
    <div className={`tactical-city ${presenting ? 'is-presenting' : ''}`}>
      <div ref={hostRef} className="map-canvas-host absolute inset-0" style={{ filter: 'none' }}
        onPointerDownCapture={event => { dragButtonRef.current = event.button; }}
        onContextMenu={event => event.preventDefault()} />
      <div aria-hidden="true" className="city-atmosphere" style={{ display: 'none' }} />
      <svg aria-hidden="true" className="pointer-events-none absolute inset-0 h-full w-full">
        <line ref={hospitalLeaderRef} stroke="#f8d699" strokeWidth="1.2" style={{ display: 'none' }} />
        <line ref={ambulanceLeaderRef} stroke="#f8d699" strokeWidth="1.2" style={{ display: 'none' }} />
        <line ref={leaderRef} stroke="rgba(255,196,120,.7)" strokeWidth="1" strokeDasharray="3 4" style={{ display: 'none' }} />
      </svg>
      <div ref={labelRef} className="hazard-map-label" style={{ display: 'none' }}><span />{hazardLabel}</div>

      <div ref={hospitalLabelRef} className="mission-map-pin hospital-pin" style={{ display: 'none' }}><Cross /><strong>{Math.abs(graph.center.lat - 37.788) < 0.01 ? 'Chinese Hospital' : 'Hospital'}</strong></div>
      <div ref={ambulanceLabelRef} className="mission-map-pin ambulance-pin" style={{ display: 'none' }}><AmbulanceIcon /><div><strong>Ambulance</strong><span>{snapshot.ambulance?.status === 'WAITING' ? 'Awaiting dispatch' : snapshot.ambulance?.status === 'ARRIVED' ? 'Patient delivered' : snapshot.ambulance?.mission?.phase === 'PICKING_UP' ? 'Loading patient' : snapshot.ambulance?.status === 'STUCK' ? 'Stopped in traffic' : snapshot.ambulance?.mission?.phase === 'TO_PICKUP' ? 'Responding to pickup' : 'En route to hospital'}</span></div></div>
      <div role="group" aria-label="City model" className="city-model-toggle">
        <Layers3 />{([['google', 'Photo'], ['osm', 'Blocks']] as const).map(([value, label]) => (
          <button key={value} type="button" aria-pressed={source === value} disabled={value === 'google' && !GOOGLE_KEY}
            title={value === 'google' && !GOOGLE_KEY ? 'A Google Maps API key is required for Photo mode' : `${label} city model`}
            onClick={() => switchRef.current?.(value)}>{label}</button>
        ))}
      </div>
      <div role="group" aria-label="Camera" className="map-camera-controls">
        {(snapshot.incidents ?? []).some(i => i.status !== 'CLEARED') && <button type="button" aria-label="View collision" title="Cycle through active collisions" onClick={() => cameraRef.current?.('incident')}><TriangleAlert /></button>}
        {([['left', 'Rotate left', ChevronLeft], ['home', 'Reset view', House], ['right', 'Rotate right', ChevronRight]] as const).map(([cmd, label, Icon]) => (
          <button key={cmd} type="button" aria-label={label} title={label} onClick={() => cameraRef.current?.(cmd)}><Icon /></button>
        ))}
        {(['in', 'out'] as const).map(cmd => (
          <button key={cmd} type="button" aria-label={cmd === 'in' ? 'Zoom in' : 'Zoom out'}
            onClick={() => cameraRef.current?.(cmd)}>{cmd === 'in' ? '+' : '−'}</button>
        ))}
      </div>
      <button type="button" className="map-follow-button" aria-pressed={follow} disabled={!snapshot.ambulance} onClick={() => onFollowChange?.(!follow)}>
        <Crosshair />{follow ? snapshot.ambulance?.status === 'WAITING' ? 'Follow when dispatched' : 'Following ambulance' : 'Follow ambulance'}
      </button>
      <details className="map-legend"><summary><Info />Map key</summary><ul>{LEGEND.map(([label, color]) => <li key={label}><span style={{ background: color }} />{label}</li>)}<li><span style={{ background: '#f7b84d' }} />Ambulance corridor</li></ul><p>Civilian traffic is visual only.</p><p>Left drag to pan · Right drag to rotate</p></details>
      <p className="map-attribution">{source === 'google' ? <>Google{credits ? ` · ${credits}` : ''} · roads © OpenStreetMap contributors</> : 'Buildings & roads © OpenStreetMap contributors'}</p>
    </div>
  );
}

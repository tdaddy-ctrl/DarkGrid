// Builds the two vehicle models used on the 3D map (public/models/*.glb) from real dimensions:
//   waymo.glb      Jaguar I-PACE robotaxi (4.68 x 2.01 x 1.57 m) with the roof lidar dome and fender sensors
//   ambulance.glb  Type III box ambulance (6.7 x 2.4 x 2.9 m) with light bar, stripe and corner lights
// Model space: +X forward, +Y up, +Z to the right (right-handed), meters, origin on the ground under the car's center.
// Run: node scripts/build-car-models.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const earcut = createRequire(import.meta.url)('earcut');

// ---------- materials (PBR metallic-roughness; emissive parts glow at night) ----------
const MATERIALS = {
  paint:    { baseColorFactor: [0.93, 0.94, 0.96, 1], metallicFactor: 0.35, roughnessFactor: 0.3 },
  glass:    { baseColorFactor: [0.03, 0.05, 0.08, 1], metallicFactor: 0.9, roughnessFactor: 0.12 },
  trim:     { baseColorFactor: [0.05, 0.05, 0.06, 1], metallicFactor: 0.2, roughnessFactor: 0.55 },
  tire:     { baseColorFactor: [0.03, 0.03, 0.03, 1], metallicFactor: 0.0, roughnessFactor: 0.9 },
  rim:      { baseColorFactor: [0.55, 0.57, 0.6, 1], metallicFactor: 0.9, roughnessFactor: 0.3 },
  sensor:   { baseColorFactor: [0.08, 0.09, 0.1, 1], metallicFactor: 0.6, roughnessFactor: 0.25 },
  head:     { baseColorFactor: [1, 1, 1, 1], emissiveFactor: [1, 0.97, 0.9], metallicFactor: 0, roughnessFactor: 0.5 },
  tail:     { baseColorFactor: [0.8, 0.05, 0.05, 1], emissiveFactor: [1, 0.05, 0.05], metallicFactor: 0, roughnessFactor: 0.5 },
  red:      { baseColorFactor: [0.75, 0.04, 0.06, 1], metallicFactor: 0.2, roughnessFactor: 0.4 },
  beaconR:  { baseColorFactor: [1, 0.1, 0.1, 1], emissiveFactor: [1, 0.08, 0.08], metallicFactor: 0, roughnessFactor: 0.4 },
  beaconW:  { baseColorFactor: [1, 1, 1, 1], emissiveFactor: [1, 1, 1], metallicFactor: 0, roughnessFactor: 0.4 },
};

// ---------- geometry helpers ----------
function newModel() { return new Map(); }   // material name -> { pos: [], nrm: [], idx: [] }
function part(model, mat) {
  if (!model.has(mat)) model.set(mat, { pos: [], nrm: [], idx: [] });
  return model.get(mat);
}
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (v) => { const l = Math.hypot(...v) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };

// Flat-shaded triangle; `want` (optional) is a direction the normal must face.
function tri(p, a, b, c, want) {
  let n = norm(cross(sub(b, a), sub(c, a)));
  if (want && n[0] * want[0] + n[1] * want[1] + n[2] * want[2] < 0) { [b, c] = [c, b]; n = n.map((x) => -x); }
  const base = p.pos.length / 3;
  for (const v of [a, b, c]) { p.pos.push(...v); p.nrm.push(...n); }
  p.idx.push(base, base + 1, base + 2);
}

// Chaikin corner cutting: rounds a closed 2D profile.
function smooth(pts, iterations = 2) {
  let out = pts;
  for (let k = 0; k < iterations; k++) {
    const next = [];
    for (let i = 0; i < out.length; i++) {
      const a = out[i], b = out[(i + 1) % out.length];
      next.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25], [a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
    }
    out = next;
  }
  return out;
}
const area = (pts) => pts.reduce((s, p, i) => { const q = pts[(i + 1) % pts.length]; return s + p[0] * q[1] - q[0] * p[1]; }, 0) / 2;

// Side profile (x, y) swept across the width with rounded side edges (radius r), smooth normals on the sweep.
// `taper` pulls the profile toward its base line at the sides (tumblehome on a cabin); `ry` is how far (m)
// the top and bottom edges pull in at the sides; `round` = corner-rounding passes on the profile.
function sweep(model, mat, profile, width, r, { taper = 0, zOffset = 0, ry = r * 0.35, round = 2 } = {}) {
  let prof = smooth(profile, round);
  if (area(prof) < 0) prof = prof.reverse();
  const xs = prof.map((p) => p[0]), ys = prof.map((p) => p[1]);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2, hx = (Math.max(...xs) - Math.min(...xs)) / 2;
  const cy = (Math.min(...ys) + Math.max(...ys)) / 2, hy = (Math.max(...ys) - Math.min(...ys)) / 2;
  const baseY = Math.min(...ys);
  const ANG = [90, 65, 40, 15, 0];
  const stations = [
    ...ANG.map((a) => ({ phi: a, side: -1 })),
    ...ANG.slice().reverse().map((a) => ({ phi: a, side: 1 })),
  ].map(({ phi, side }) => {
    const t = (phi * Math.PI) / 180;
    const inset = r * (1 - Math.cos(t));
    const z = side * (width / 2 - r + r * Math.sin(t)) + zOffset;
    const f = (taper * phi) / 90;
    return prof.map(([x, y]) => {
      const yy = baseY + (y - baseY) * (1 - f);
      return [cx + (x - cx) * (1 - inset / hx), cy + (yy - cy) * (1 - (inset * ry) / r / hy), z];
    });
  });
  const p = part(model, mat);
  const n = prof.length, base = p.pos.length / 3;
  const acc = stations.flat().map(() => [0, 0, 0]);
  const at = (s, i) => s * n + (i % n);
  for (let s = 0; s < stations.length - 1; s++) {
    for (let i = 0; i < n; i++) {
      const A = at(s, i), B = at(s, i + 1), C = at(s + 1, i + 1), D = at(s + 1, i);
      for (const [u, v, w] of [[A, B, C], [A, C, D]]) {
        const P = stations.flat();
        const fn = cross(sub(P[v], P[u]), sub(P[w], P[u]));
        for (const k of [u, v, w]) { acc[k][0] += fn[0]; acc[k][1] += fn[1]; acc[k][2] += fn[2]; }
        p.idx.push(base + u, base + v, base + w);
      }
    }
  }
  stations.flat().forEach((v, k) => { p.pos.push(...v); p.nrm.push(...norm(acc[k])); });
  // flat end caps
  for (const [s, want] of [[0, [0, 0, -1]], [stations.length - 1, [0, 0, 1]]]) {
    const ring = stations[s];
    const t = earcut(ring.flatMap((q) => [q[0], q[1]]));
    for (let k = 0; k < t.length; k += 3) tri(p, ring[t[k]], ring[t[k + 1]], ring[t[k + 2]], want);
  }
}

function box(model, mat, [x0, y0, z0], [x1, y1, z1]) {
  const p = part(model, mat);
  const v = (x, y, z) => [x ? x1 : x0, y ? y1 : y0, z ? z1 : z0];
  const faces = [
    [[1, 0, 0], v(1, 0, 0), v(1, 1, 0), v(1, 1, 1), v(1, 0, 1)], [[-1, 0, 0], v(0, 0, 0), v(0, 0, 1), v(0, 1, 1), v(0, 1, 0)],
    [[0, 1, 0], v(0, 1, 0), v(0, 1, 1), v(1, 1, 1), v(1, 1, 0)], [[0, -1, 0], v(0, 0, 0), v(1, 0, 0), v(1, 0, 1), v(0, 0, 1)],
    [[0, 0, 1], v(0, 0, 1), v(1, 0, 1), v(1, 1, 1), v(0, 1, 1)], [[0, 0, -1], v(0, 0, 0), v(0, 1, 0), v(1, 1, 0), v(1, 0, 0)],
  ];
  for (const [n, a, b, c, d] of faces) { tri(p, a, b, c, n); tri(p, a, c, d, n); }
}

// Cylinder along Z (wheels) or Y (sensors); r0 at the start, r1 at the end (a frustum when they differ).
function cylinder(model, mat, center, axis, length, r0, r1 = r0, seg = 20) {
  const p = part(model, mat);
  const pt = (t, a, r) => {
    const c = Math.cos(a) * r, s = Math.sin(a) * r, h = (t - 0.5) * length;
    return axis === 'z' ? [center[0] + c, center[1] + s, center[2] + h] : [center[0] + c, center[1] + h, center[2] + s];
  };
  const out = (a) => (axis === 'z' ? [Math.cos(a), Math.sin(a), 0] : [Math.cos(a), 0, Math.sin(a)]);
  for (let i = 0; i < seg; i++) {
    const a = (i / seg) * 2 * Math.PI, b = ((i + 1) / seg) * 2 * Math.PI, m = (a + b) / 2;
    tri(p, pt(0, a, r0), pt(0, b, r0), pt(1, b, r1), out(m));
    tri(p, pt(0, a, r0), pt(1, b, r1), pt(1, a, r1), out(m));
    const end = axis === 'z' ? [0, 0, 1] : [0, 1, 0];
    tri(p, pt(1, a, r1), pt(1, b, r1), axis === 'z' ? [center[0], center[1], center[2] + length / 2] : [center[0], center[1] + length / 2, center[2]], end);
    tri(p, pt(0, a, r0), pt(0, b, r0), axis === 'z' ? [center[0], center[1], center[2] - length / 2] : [center[0], center[1] - length / 2, center[2]], end.map((x) => -x));
  }
}

function wheel(model, x, z, r, w) {
  cylinder(model, 'tire', [x, r, z], 'z', w, r, r, 24);
  cylinder(model, 'rim', [x, r, z + Math.sign(z) * (w / 2 + 0.005)], 'z', 0.02, r * 0.62, r * 0.62, 24);
}

// ---------- Waymo (Jaguar I-PACE) ----------
function waymo() {
  const m = newModel();
  // lower body, side view (x forward, y up): crossover stance, high beltline, short overhangs
  sweep(m, 'paint', [
    [-2.28, 0.32], [2.26, 0.32], [2.34, 0.44], [2.34, 0.62], [2.24, 0.80], [1.60, 0.90], [0.90, 1.00],
    [-1.75, 1.06], [-2.22, 1.03], [-2.34, 0.86], [-2.34, 0.50],
  ], 1.98, 0.14);
  // cabin: dark glass greenhouse with tumblehome (narrower at the roof)
  sweep(m, 'glass', [
    [0.95, 0.98], [0.05, 1.47], [-1.25, 1.55], [-1.80, 1.38], [-2.15, 1.04], [-1.60, 1.02],
  ], 1.70, 0.12, { taper: 0.18 });
  // black sills
  for (const z of [-1, 1]) box(m, 'trim', [-1.85, 0.30, z * 0.94 - 0.04], [1.85, 0.44, z * 0.94 + 0.04]);
  for (const x of [1.48, -1.48]) for (const z of [0.86, -0.86]) wheel(m, x, z, 0.37, 0.26);
  // roof lidar dome on its base, perimeter sensors at the front fenders and rear corners
  cylinder(m, 'sensor', [-0.55, 1.60, 0], 'y', 0.10, 0.30, 0.27, 28);
  cylinder(m, 'sensor', [-0.55, 1.77, 0], 'y', 0.24, 0.19, 0.16, 28);
  cylinder(m, 'glass', [-0.55, 1.92, 0], 'y', 0.06, 0.16, 0.10, 28);
  for (const z of [-1, 1]) {
    box(m, 'sensor', [1.50, 0.92, z * 0.90 - 0.07], [1.72, 1.06, z * 0.90 + 0.07]);
    box(m, 'sensor', [-2.34, 0.74, z * 0.80 - 0.06], [-2.22, 0.86, z * 0.80 + 0.06]);
    box(m, 'head', [2.27, 0.68, z * 0.70 - 0.22], [2.35, 0.74, z * 0.70 + 0.22]);
  }
  box(m, 'tail', [-2.37, 0.92, -0.82], [-2.31, 0.97, 0.82]);
  return m;
}

// ---------- Ambulance (Type III: cutaway cab + box module) ----------
function ambulance() {
  const m = newModel();
  // cab lower body
  sweep(m, 'paint', [
    [1.55, 0.45], [3.30, 0.45], [3.36, 0.65], [3.32, 1.10], [2.70, 1.28], [1.55, 1.30],
  ], 2.10, 0.12, { round: 1 });
  // cab glass (windshield + side windows)
  sweep(m, 'glass', [[2.72, 1.26], [2.12, 2.04], [1.58, 2.08], [1.58, 1.26]], 1.96, 0.08, { taper: 0.08, round: 1 });
  // box module: square with small bevels
  sweep(m, 'paint', [[-3.35, 0.55], [1.60, 0.55], [1.60, 2.82], [1.52, 2.90], [-3.27, 2.90], [-3.35, 2.82]], 2.40, 0.06, { round: 0, ry: 0.06 });
  // red stripe and rear doors outline
  for (const z of [-1, 1]) box(m, 'red', [-3.30, 1.10, z * 1.20 - 0.012], [1.56, 1.32, z * 1.20 + 0.012]);
  box(m, 'red', [-3.37, 1.10, -1.12], [-3.34, 1.32, 1.12]);
  box(m, 'trim', [-3.38, 0.60, -0.02], [-3.345, 2.6, 0.02]);
  box(m, 'trim', [-1.0, 0.48, -1.18], [1.5, 0.58, 1.18]);
  // light bar on the cab roof, corner beacons on the box
  box(m, 'beaconR', [1.62, 2.06, -0.85], [1.86, 2.18, -0.06]);
  box(m, 'beaconW', [1.62, 2.06, -0.06], [1.86, 2.18, 0.06]);
  box(m, 'beaconR', [1.62, 2.06, 0.06], [1.86, 2.18, 0.85]);
  for (const x of [1.42, -3.22]) for (const z of [-1, 1]) box(m, 'beaconR', [x - 0.07, 2.90, z * 1.04 - 0.09], [x + 0.07, 2.99, z * 1.04 + 0.09]);
  for (const z of [-1, 1]) {
    box(m, 'head', [3.33, 0.82, z * 0.72 - 0.16], [3.37, 0.95, z * 0.72 + 0.16]);
    box(m, 'tail', [-3.39, 0.70, z * 1.05 - 0.07], [-3.36, 1.00, z * 1.05 + 0.07]);
  }
  wheel(m, 2.55, 0.92, 0.40, 0.26);
  wheel(m, 2.55, -0.92, 0.40, 0.26);
  for (const z of [0.86, 1.08, -0.86, -1.08]) wheel(m, -1.75, z, 0.40, 0.2);
  return m;
}

// ---------- GLB writer ----------
function glb(model) {
  const json = { asset: { version: '2.0', generator: 'DARK GRID build-car-models' }, scene: 0, scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }], meshes: [{ primitives: [] }], materials: [], accessors: [], bufferViews: [], buffers: [] };
  const chunks = [];
  let offset = 0;
  const view = (typed, target) => {
    const buf = Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength);
    const pad = (4 - (buf.length % 4)) % 4;
    json.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: buf.length, target });
    chunks.push(buf, Buffer.alloc(pad));
    offset += buf.length + pad;
    return json.bufferViews.length - 1;
  };
  for (const [mat, p] of model) {
    const def = MATERIALS[mat];
    json.materials.push({ name: mat, pbrMetallicRoughness: { baseColorFactor: def.baseColorFactor, metallicFactor: def.metallicFactor, roughnessFactor: def.roughnessFactor },
      ...(def.emissiveFactor ? { emissiveFactor: def.emissiveFactor } : {}) });
    const pos = new Float32Array(p.pos), nrm = new Float32Array(p.nrm);
    const idx = p.pos.length / 3 > 65535 ? new Uint32Array(p.idx) : new Uint16Array(p.idx);
    const min = [0, 1, 2].map((k) => Math.min(...p.pos.filter((_, i) => i % 3 === k)));
    const max = [0, 1, 2].map((k) => Math.max(...p.pos.filter((_, i) => i % 3 === k)));
    json.accessors.push({ bufferView: view(pos, 34962), componentType: 5126, count: pos.length / 3, type: 'VEC3', min, max });
    json.accessors.push({ bufferView: view(nrm, 34962), componentType: 5126, count: nrm.length / 3, type: 'VEC3' });
    json.accessors.push({ bufferView: view(idx, 34963), componentType: idx instanceof Uint32Array ? 5125 : 5123, count: idx.length, type: 'SCALAR' });
    const a = json.accessors.length;
    json.meshes[0].primitives.push({ attributes: { POSITION: a - 3, NORMAL: a - 2 }, indices: a - 1, material: json.materials.length - 1 });
  }
  const bin = Buffer.concat(chunks);
  json.buffers.push({ byteLength: bin.length });
  let text = Buffer.from(JSON.stringify(json));
  text = Buffer.concat([text, Buffer.alloc((4 - (text.length % 4)) % 4, 0x20)]);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + 8 + text.length + 8 + bin.length, 8);
  const ch = (len, type) => { const b = Buffer.alloc(8); b.writeUInt32LE(len, 0); b.writeUInt32LE(type, 4); return b; };
  return Buffer.concat([header, ch(text.length, 0x4e4f534a), text, ch(bin.length, 0x004e4942), bin]);
}

mkdirSync('public/models', { recursive: true });
for (const [name, build] of [['waymo', waymo], ['ambulance', ambulance]]) {
  const model = build();
  const tris = [...model.values()].reduce((s, p) => s + p.idx.length / 3, 0);
  const out = glb(model);
  writeFileSync(`public/models/${name}.glb`, out);
  console.log(`public/models/${name}.glb  ${tris} triangles  ${(out.length / 1024).toFixed(0)} KB`);
}

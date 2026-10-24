// Ground height (meters above sea level, USGS NED 10 m) at every intersection of both San Francisco
// road maps, so vehicles and overlays can sit on the street in Google's photorealistic city.
// Writes public/data/sf_ground.json as [[lng, lat, meters], ...].
// Uses the free OpenTopoData API (100 points per request, 1 request per second).
// Run: node scripts/fetch-ground.mjs
import { readFileSync, writeFileSync } from 'node:fs';

const points = new Map();
for (const file of ['downtown_roads', 'soma_roads']) {
  const graph = JSON.parse(readFileSync(`public/data/${file}.json`, 'utf8'));
  for (const n of graph.nodes) points.set(`${n.lat.toFixed(5)},${n.lng.toFixed(5)}`, [n.lng, n.lat]);
}
const list = [...points.values()];
const out = [];
for (let i = 0; i < list.length; i += 100) {
  const batch = list.slice(i, i + 100);
  const query = batch.map(([lng, lat]) => `${lat.toFixed(6)},${lng.toFixed(6)}`).join('|');
  const res = await fetch(`https://api.opentopodata.org/v1/ned10m?locations=${query}`);
  if (!res.ok) throw new Error(`OpenTopoData HTTP ${res.status}`);
  const body = await res.json();
  body.results.forEach((r, k) => out.push([batch[k][0], batch[k][1], Math.round((r.elevation ?? 0) * 10) / 10]));
  process.stdout.write(`\r${out.length}/${list.length}`);
  await new Promise((r) => setTimeout(r, 1100));
}
writeFileSync('public/data/sf_ground.json', JSON.stringify(out));
const zs = out.map((p) => p[2]);
console.log(`\npublic/data/sf_ground.json  ${out.length} points  ${Math.min(...zs)}..${Math.max(...zs)} m`);

/*
 * Gera public/land-dots.json — grade de pontos [lat, lng] sobre os continentes,
 * usada pelo globo do Command Center. Rodar uma vez: node scripts/gen-land-dots.js
 */
const fs = require('fs');
const path = require('path');

const SOURCE = 'https://raw.githubusercontent.com/johan/world.geo.json/master/countries.geo.json';

function pointInRing(lat, lng, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function pointInPolygon(lat, lng, coords) {
  if (!pointInRing(lat, lng, coords[0])) return false;
  for (let k = 1; k < coords.length; k++) {
    if (pointInRing(lat, lng, coords[k])) return false; // buraco
  }
  return true;
}

async function main() {
  console.log('Baixando GeoJSON de países…');
  const res = await fetch(SOURCE);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const geo = await res.json();

  // pré-filtra por bounding box para acelerar
  const polys = [];
  for (const f of geo.features) {
    const g = f.geometry;
    if (!g) continue;
    const list = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
    for (const coords of list) {
      let minLat = 90, maxLat = -90, minLng = 180, maxLng = -180;
      for (const [lng, lat] of coords[0]) {
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
        if (lng < minLng) minLng = lng;
        if (lng > maxLng) maxLng = lng;
      }
      polys.push({ coords, minLat, maxLat, minLng, maxLng });
    }
  }
  console.log(`${polys.length} polígonos.`);

  const STEP = 1.8;
  const dots = [];
  for (let lat = -58; lat <= 74; lat += STEP) {
    const lngStep = STEP / Math.max(0.3, Math.cos((lat * Math.PI) / 180));
    for (let lng = -180; lng < 180; lng += lngStep) {
      for (const p of polys) {
        if (lat < p.minLat || lat > p.maxLat || lng < p.minLng || lng > p.maxLng) continue;
        if (pointInPolygon(lat, lng, p.coords)) {
          dots.push([Math.round(lat * 10) / 10, Math.round(lng * 10) / 10]);
          break;
        }
      }
    }
  }
  const out = path.join(__dirname, '..', 'public', 'land-dots.json');
  fs.writeFileSync(out, JSON.stringify(dots));
  console.log(`${dots.length} pontos → ${out} (${(fs.statSync(out).size / 1024).toFixed(0)} KB)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

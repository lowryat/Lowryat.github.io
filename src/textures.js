// Procedural PBR-ish texture factory. Everything is generated on canvas at load
// time so the game ships with zero binary assets.
import * as THREE from 'three';

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

// Mulberry32 — deterministic so the world looks identical every boot.
function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Value-noise heightfield with fbm octaves, rendered into a Float32Array.
function fbmField(size, seed, octaves = 5, persistence = 0.5) {
  const rand = rng(seed);
  const out = new Float32Array(size * size);
  let amp = 1, freq = 4, total = 0;
  for (let o = 0; o < octaves; o++) {
    const grid = freq;                       // wrap indices → seamless tiling
    const g = new Float32Array(grid * grid);
    for (let i = 0; i < g.length; i++) g[i] = rand();
    const G = (x, y) => g[(y % grid) * grid + (x % grid)];
    for (let y = 0; y < size; y++) {
      const gy = (y / size) * freq;
      const y0 = Math.floor(gy), fy = gy - y0;
      const sy = fy * fy * (3 - 2 * fy);
      for (let x = 0; x < size; x++) {
        const gx = (x / size) * freq;
        const x0 = Math.floor(gx), fx = gx - x0;
        const sx = fx * fx * (3 - 2 * fx);
        const i00 = G(x0, y0), i10 = G(x0 + 1, y0);
        const i01 = G(x0, y0 + 1), i11 = G(x0 + 1, y0 + 1);
        const v = (i00 * (1 - sx) + i10 * sx) * (1 - sy) + (i01 * (1 - sx) + i11 * sx) * sy;
        out[y * size + x] += v * amp;
      }
    }
    total += amp; amp *= persistence; freq *= 2;
  }
  for (let i = 0; i < out.length; i++) out[i] /= total;
  return out;
}

// Sobel a height canvas into a tangent-space normal map.
function normalFromHeight(heightCanvas, strength = 2.0) {
  const w = heightCanvas.width, h = heightCanvas.height;
  const src = heightCanvas.getContext('2d').getImageData(0, 0, w, h).data;
  const out = canvas(w, h);
  const ctx = out.getContext('2d');
  const img = ctx.createImageData(w, h);
  const d = img.data;
  const H = (x, y) => src[(((y + h) % h) * w + ((x + w) % w)) * 4] / 255;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (H(x - 1, y) - H(x + 1, y)) * strength;
      const dy = (H(x, y - 1) - H(x, y + 1)) * strength;
      const len = Math.sqrt(dx * dx + dy * dy + 1);
      const i = (y * w + x) * 4;
      d[i] = ((dx / len) * 0.5 + 0.5) * 255;
      d[i + 1] = ((dy / len) * 0.5 + 0.5) * 255;
      d[i + 2] = ((1 / len) * 0.5 + 0.5) * 255;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return out;
}

function fieldToCanvas(field, size, lo = 0, hi = 255) {
  const c = canvas(size, size);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  for (let i = 0; i < field.length; i++) {
    const v = lo + field[i] * (hi - lo);
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

function tex(c, repeat = 1, srgb = true) {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.anisotropy = 8;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function speckle(ctx, size, rand, count, rMin, rMax, alphaMin, alphaMax, hue) {
  for (let i = 0; i < count; i++) {
    const r = rMin + rand() * (rMax - rMin);
    const a = alphaMin + rand() * (alphaMax - alphaMin);
    const v = Math.floor(rand() * 60);
    ctx.fillStyle = hue
      ? `rgba(${hue[0] + v},${hue[1] + v},${hue[2] + v},${a})`
      : `rgba(${v},${v},${v},${a})`;
    ctx.beginPath();
    ctx.arc(rand() * size, rand() * size, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

// ---------------------------------------------------------------- asphalt
export function makeAsphalt() {
  const S = 512;
  const c = canvas(S, S), ctx = c.getContext('2d');
  const rand = rng(101);
  const field = fbmField(S, 7, 5);
  const img = ctx.createImageData(S, S);
  for (let i = 0; i < field.length; i++) {
    const v = 34 + field[i] * 30 + (rand() - 0.5) * 14;
    img.data[i * 4] = v; img.data[i * 4 + 1] = v; img.data[i * 4 + 2] = v + 2;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  speckle(ctx, S, rand, 2600, 0.4, 1.4, 0.05, 0.22, [120, 118, 112]);   // aggregate
  speckle(ctx, S, rand, 900, 0.4, 1.1, 0.06, 0.18, [10, 10, 12]);       // tar spots
  // cracks
  ctx.strokeStyle = 'rgba(12,12,14,0.5)'; ctx.lineWidth = 1;
  for (let i = 0; i < 10; i++) {
    ctx.beginPath();
    let x = rand() * S, y = rand() * S;
    ctx.moveTo(x, y);
    for (let s = 0; s < 24; s++) { x += (rand() - 0.5) * 26; y += (rand() - 0.5) * 26; ctx.lineTo(x, y); }
    ctx.stroke();
  }
  const hc = fieldToCanvas(field, S, 40, 215);
  const hctx = hc.getContext('2d');
  speckle(hctx, S, rng(55), 2600, 0.4, 1.4, 0.15, 0.5, [255, 255, 255]);
  return { map: tex(c, 1), normalMap: tex(normalFromHeight(hc, 2.2), 1, false) };
}

// ---------------------------------------------------------------- desert ground
export function makeGround() {
  const S = 1024;
  const c = canvas(S, S), ctx = c.getContext('2d');
  const rand = rng(42);
  const field = fbmField(S, 13, 6);
  const img = ctx.createImageData(S, S);
  for (let i = 0; i < field.length; i++) {
    const f = field[i];
    // sun-bleached scrub-desert: pale ochre sand, low contrast
    const r = 156 + f * 36, g = 132 + f * 30, b = 100 + f * 24;
    img.data[i * 4] = r; img.data[i * 4 + 1] = g; img.data[i * 4 + 2] = b;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  speckle(ctx, S, rand, 5200, 0.5, 2.0, 0.04, 0.13, [96, 80, 58]);    // pebbles/shadow
  speckle(ctx, S, rand, 2600, 0.5, 1.5, 0.04, 0.12, [215, 196, 160]); // light grit
  // dry scrub patches
  for (let i = 0; i < 200; i++) {
    const x = rand() * S, y = rand() * S, r = 3 + rand() * 8;
    ctx.fillStyle = `rgba(${104 + rand() * 30},${96 + rand() * 26},${58 + rand() * 14},${0.07 + rand() * 0.1})`;
    ctx.beginPath(); ctx.ellipse(x, y, r, r * 0.55, rand() * Math.PI, 0, Math.PI * 2); ctx.fill();
  }
  const hc = fieldToCanvas(field, S, 70, 190);
  return { map: tex(c, 150), normalMap: tex(normalFromHeight(hc, 1.9), 150, false) };
}

// ---------------------------------------------------------------- concrete
export function makeConcrete(seed = 500, base = [128, 124, 116]) {
  const S = 512;
  const c = canvas(S, S), ctx = c.getContext('2d');
  const rand = rng(seed);
  const field = fbmField(S, seed, 5);
  const img = ctx.createImageData(S, S);
  for (let i = 0; i < field.length; i++) {
    const f = 0.7 + field[i] * 0.55;
    img.data[i * 4] = base[0] * f; img.data[i * 4 + 1] = base[1] * f; img.data[i * 4 + 2] = base[2] * f;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  speckle(ctx, S, rand, 1800, 0.4, 1.5, 0.04, 0.14, null);
  // water stains bleeding downward
  for (let i = 0; i < 26; i++) {
    const x = rand() * S, y = rand() * S * 0.5, w = 4 + rand() * 22, h = 40 + rand() * 140;
    const g = ctx.createLinearGradient(0, y, 0, y + h);
    g.addColorStop(0, 'rgba(40,38,32,0.22)'); g.addColorStop(1, 'rgba(40,38,32,0)');
    ctx.fillStyle = g; ctx.fillRect(x, y, w, h);
  }
  // form-board seams
  ctx.strokeStyle = 'rgba(30,30,28,0.25)'; ctx.lineWidth = 2;
  for (let y = 64; y < S; y += 128) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(S, y); ctx.stroke(); }
  const hc = fieldToCanvas(field, S, 90, 190);
  return { map: tex(c, 2), normalMap: tex(normalFromHeight(hc, 1.6), 2, false) };
}

// ---------------------------------------------------------------- corrugated metal
export function makeMetal(seed = 900) {
  const S = 512;
  const c = canvas(S, S), ctx = c.getContext('2d');
  const rand = rng(seed);
  for (let x = 0; x < S; x++) {
    const wave = Math.sin((x / S) * Math.PI * 24);
    const v = 96 + wave * 34 + (rand() - 0.5) * 8;
    ctx.fillStyle = `rgb(${v * 0.92},${v * 0.94},${v})`;
    ctx.fillRect(x, 0, 1, S);
  }
  // rust blooms
  for (let i = 0; i < 60; i++) {
    const x = rand() * S, y = rand() * S, r = 3 + rand() * 26;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(${120 + rand() * 40},${58 + rand() * 20},22,${0.25 + rand() * 0.3})`);
    g.addColorStop(1, 'rgba(110,50,20,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  }
  const hc = canvas(S, S), hctx = hc.getContext('2d');
  for (let x = 0; x < S; x++) {
    const v = 128 + Math.sin((x / S) * Math.PI * 24) * 90;
    hctx.fillStyle = `rgb(${v},${v},${v})`; hctx.fillRect(x, 0, 1, S);
  }
  return { map: tex(c, 1), normalMap: tex(normalFromHeight(hc, 3.0), 1, false) };
}

// ---------------------------------------------------------------- crate wood
export function makeWood(seed = 313) {
  const S = 256;
  const c = canvas(S, S), ctx = c.getContext('2d');
  const rand = rng(seed);
  for (let y = 0; y < S; y++) {
    const grain = Math.sin(y * 0.9 + Math.sin(y * 0.13) * 3) * 10;
    const v = 108 + grain + (rand() - 0.5) * 16;
    ctx.fillStyle = `rgb(${v},${v * 0.72},${v * 0.46})`;
    ctx.fillRect(0, y, S, 1);
  }
  ctx.strokeStyle = 'rgba(50,32,16,0.5)'; ctx.lineWidth = 3;
  for (let y = 0; y <= S; y += 64) { ctx.beginPath(); ctx.moveTo(0, y + 1); ctx.lineTo(S, y + 1); ctx.stroke(); }
  speckle(ctx, S, rand, 300, 0.3, 1.2, 0.06, 0.2, [60, 40, 20]);
  return { map: tex(c, 1) };
}

// ---------------------------------------------------------------- camo fabric (enemy uniform)
export function makeCamo(seed = 77, palette = [[74, 71, 55], [96, 90, 66], [55, 54, 44], [110, 100, 74]]) {
  const S = 256;
  const c = canvas(S, S), ctx = c.getContext('2d');
  const rand = rng(seed);
  ctx.fillStyle = `rgb(${palette[0].join(',')})`;
  ctx.fillRect(0, 0, S, S);
  for (let i = 0; i < 220; i++) {
    const p = palette[1 + Math.floor(rand() * (palette.length - 1))];
    ctx.fillStyle = `rgb(${p.join(',')})`;
    ctx.beginPath();
    const x = rand() * S, y = rand() * S;
    ctx.moveTo(x, y);
    let px = x, py = y;
    for (let s = 0; s < 6; s++) { px += (rand() - 0.5) * 40; py += (rand() - 0.5) * 40; ctx.lineTo(px, py); }
    ctx.closePath(); ctx.fill();
  }
  speckle(ctx, S, rand, 900, 0.3, 1.0, 0.04, 0.1, null);
  return { map: tex(c, 1) };
}

// ---------------------------------------------------------------- building facade with windows
export function makeFacade(seed, floors, cols, lit = 0.25) {
  const S = 512;
  const c = canvas(S, S), ctx = c.getContext('2d');
  const rand = rng(seed);
  const field = fbmField(S, seed + 3, 4);
  const img = ctx.createImageData(S, S);
  for (let i = 0; i < field.length; i++) {
    const f = 0.75 + field[i] * 0.4;
    img.data[i * 4] = 118 * f; img.data[i * 4 + 1] = 112 * f; img.data[i * 4 + 2] = 102 * f;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const e = canvas(S, S), ectx = e.getContext('2d');
  ectx.fillStyle = '#000'; ectx.fillRect(0, 0, S, S);
  const fh = S / floors, cw = S / cols;
  for (let f = 0; f < floors; f++) {
    for (let col = 0; col < cols; col++) {
      const x = col * cw + cw * 0.2, y = f * fh + fh * 0.22, w = cw * 0.6, h = fh * 0.52;
      ctx.fillStyle = 'rgba(18,22,28,0.96)';
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = 'rgba(60,60,58,0.9)'; ctx.lineWidth = 3;
      ctx.strokeRect(x, y, w, h);
      // glass reflection streak
      ctx.fillStyle = 'rgba(140,160,180,0.16)';
      ctx.beginPath(); ctx.moveTo(x, y + h); ctx.lineTo(x + w * 0.5, y); ctx.lineTo(x + w * 0.8, y); ctx.lineTo(x + w * 0.28, y + h); ctx.fill();
      if (rand() < lit) {
        ectx.fillStyle = `rgba(255,${170 + rand() * 50},90,1)`;
        ectx.fillRect(x, y, w, h);
      }
    }
  }
  return { map: tex(c, 1), emissiveMap: tex(e, 1) };
}

// ---------------------------------------------------------------- hazard stripes
export function makeHazard() {
  const S = 128;
  const c = canvas(S, S), ctx = c.getContext('2d');
  ctx.fillStyle = '#c7a428'; ctx.fillRect(0, 0, S, S);
  ctx.fillStyle = '#1c1c1e';
  for (let i = -S; i < S * 2; i += 32) {
    ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i + 16, 0); ctx.lineTo(i - S + 16, S); ctx.lineTo(i - S, S); ctx.fill();
  }
  speckle(ctx, S, rng(4), 260, 0.4, 1.6, 0.08, 0.3, null);
  return { map: tex(c, 1) };
}

// ---------------------------------------------------------------- tire tread
export function makeTire() {
  const S = 128;
  const c = canvas(S, S), ctx = c.getContext('2d');
  ctx.fillStyle = '#161617'; ctx.fillRect(0, 0, S, S);
  ctx.fillStyle = '#0b0b0c';
  for (let y = 0; y < S; y += 16) ctx.fillRect(0, y, S, 7);
  ctx.fillStyle = '#1f1f21';
  for (let x = 0; x < S; x += 32) ctx.fillRect(x, 0, 4, S);
  const hc = canvas(S, S), hctx = hc.getContext('2d');
  hctx.fillStyle = '#888'; hctx.fillRect(0, 0, S, S);
  hctx.fillStyle = '#222';
  for (let y = 0; y < S; y += 16) hctx.fillRect(0, y, S, 7);
  return { map: tex(c, 3), normalMap: tex(normalFromHeight(hc, 2.5), 3, false) };
}

// ---------------------------------------------------------------- bullet-hole decal sprite
export function makeBulletHole() {
  const S = 64;
  const c = canvas(S, S), ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(S / 2, S / 2, 1, S / 2, S / 2, S / 2);
  g.addColorStop(0, 'rgba(8,8,8,0.95)');
  g.addColorStop(0.3, 'rgba(20,18,16,0.8)');
  g.addColorStop(0.7, 'rgba(30,28,24,0.25)');
  g.addColorStop(1, 'rgba(30,28,24,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, S, S);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// ---------------------------------------------------------------- soft round particle
export function makeSoftParticle(inner = 'rgba(255,255,255,1)', outer = 'rgba(255,255,255,0)') {
  const S = 64;
  const c = canvas(S, S), ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0, inner); g.addColorStop(1, outer);
  ctx.fillStyle = g; ctx.fillRect(0, 0, S, S);
  return new THREE.CanvasTexture(c);
}

// ---------------------------------------------------------------- muzzle flash sprite
export function makeMuzzleFlash() {
  const S = 128;
  const c = canvas(S, S), ctx = c.getContext('2d');
  ctx.translate(S / 2, S / 2);
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, S / 2);
  g.addColorStop(0, 'rgba(255,250,220,1)');
  g.addColorStop(0.25, 'rgba(255,200,90,0.9)');
  g.addColorStop(0.6, 'rgba(255,120,30,0.35)');
  g.addColorStop(1, 'rgba(255,90,20,0)');
  ctx.fillStyle = g;
  for (let i = 0; i < 7; i++) {
    ctx.rotate((Math.PI * 2) / 7);
    ctx.beginPath();
    ctx.ellipse(0, -S * 0.22, S * 0.09, S * 0.3, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.beginPath(); ctx.arc(0, 0, S * 0.18, 0, Math.PI * 2); ctx.fill();
  return new THREE.CanvasTexture(c);
}

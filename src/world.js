// World: golden-hour desert blacksite. Terrain, sky, road circuit, compound,
// scatter props, lighting and the shared collision lists.
import * as THREE from 'three';
import {
  makeAsphalt, makeGround, makeConcrete, makeMetal, makeWood,
  makeFacade, makeHazard, makeSoftParticle, makeCompoundDecal,
} from './textures.js';

export const SUN_DIR = new THREE.Vector3(-0.55, 0.28, -0.79).normalize();
const SUN_COLOR = new THREE.Color(1.0, 0.72, 0.42);

// ------------------------------------------------------------------ sky
function buildSky(scene) {
  const geo = new THREE.SphereGeometry(3000, 48, 24);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      sunDir: { value: SUN_DIR.clone() },
      time: { value: 0 },
    },
    vertexShader: /* glsl */`
      varying vec3 vDir;
      void main(){
        vDir = normalize(position);
        vec4 p = modelViewMatrix * vec4(position,1.0);
        gl_Position = (projectionMatrix * p).xyww; // pin to far plane
      }`,
    fragmentShader: /* glsl */`
      varying vec3 vDir;
      uniform vec3 sunDir;
      uniform float time;
      float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }
      float noise(vec2 p){
        vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
        return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),
                   mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);
      }
      float fbm(vec2 p){
        float v=0.0,a=0.5;
        for(int i=0;i<5;i++){ v+=a*noise(p); p*=2.03; a*=0.5; }
        return v;
      }
      void main(){
        vec3 d = normalize(vDir);
        float h = clamp(d.y, -0.12, 1.0);
        // golden hour gradient
        vec3 zen = vec3(0.16, 0.26, 0.44);
        vec3 mid = vec3(0.62, 0.48, 0.42);
        vec3 hor = vec3(1.00, 0.62, 0.30);
        vec3 col = mix(hor, mid, smoothstep(0.0, 0.14, h));
        col = mix(col, zen, smoothstep(0.10, 0.62, h));
        // warm glow around the sun
        float sunAmt = max(dot(d, sunDir), 0.0);
        col += vec3(1.0, 0.55, 0.22) * pow(sunAmt, 6.0) * 0.55;
        col += vec3(1.0, 0.70, 0.35) * pow(sunAmt, 32.0) * 0.9;
        // sun disc
        col += vec3(1.0, 0.86, 0.6) * smoothstep(0.9993, 0.9997, sunAmt) * 22.0;
        // slow high cirrus, lit warm from below
        vec2 cuv = d.xz / (0.12 + d.y) * 0.7;
        float cl = fbm(cuv * 1.6 + vec2(time*0.004, 0.0));
        cl = smoothstep(0.52, 0.85, cl) * smoothstep(0.02, 0.16, d.y) * smoothstep(0.7, 0.25, d.y);
        vec3 cloudCol = mix(vec3(1.0,0.62,0.40), vec3(0.92,0.86,0.86), smoothstep(0.0,0.5,d.y));
        col = mix(col, cloudCol, cl * 0.55);
        // below-horizon haze
        col = mix(vec3(0.55,0.40,0.30), col, smoothstep(-0.12, 0.005, d.y));
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  const sky = new THREE.Mesh(geo, mat);
  sky.frustumCulled = false;
  sky.renderOrder = -10;
  scene.add(sky);
  return mat;
}

// Environment map for PBR reflections — tiny equirect of the same sky mood.
function buildEnvMap(renderer, scene) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 128;
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, 128);
  g.addColorStop(0.0, '#2a4370');
  g.addColorStop(0.42, '#9d7a6a');
  g.addColorStop(0.5, '#ffa04e');
  g.addColorStop(0.56, '#8a6a4c');
  g.addColorStop(1.0, '#4a3826');
  ctx.fillStyle = g; ctx.fillRect(0, 0, 256, 128);
  // sun blob
  const sg = ctx.createRadialGradient(48, 58, 1, 48, 58, 26);
  sg.addColorStop(0, 'rgba(255,240,210,1)');
  sg.addColorStop(0.4, 'rgba(255,180,90,0.7)');
  sg.addColorStop(1, 'rgba(255,150,60,0)');
  ctx.fillStyle = sg; ctx.fillRect(0, 0, 256, 128);
  const t = new THREE.CanvasTexture(c);
  t.mapping = THREE.EquirectangularReflectionMapping;
  t.colorSpace = THREE.SRGBColorSpace;
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromEquirectangular(t).texture;
  pmrem.dispose(); t.dispose();
  scene.environment = env;
  scene.environmentIntensity = 0.55;
}

// ------------------------------------------------------------------ road
export function buildRoadCurve() {
  // hand-tuned closed circuit around the compound
  const pts = [
    [178, 0], [120, 120], [30, 168], [-80, 172], [-168, 110],
    [-196, 10], [-150, -95], [-60, -150], [-95, -215], [-20, -262],
    [80, -235], [140, -160], [110, -80], [170, -60],
  ].map(([x, z]) => new THREE.Vector3(x, 0, z));
  return new THREE.CatmullRomCurve3(pts, true, 'centripetal', 0.6);
}

function ribbonAlong(curve, width, segments, y, uvScaleV) {
  const pos = [], uv = [], idx = [];
  const up = new THREE.Vector3(0, 1, 0);
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const p = curve.getPointAt(t);
    const tan = curve.getTangentAt(t);
    const side = new THREE.Vector3().crossVectors(tan, up).normalize();
    pos.push(p.x - side.x * width / 2, y, p.z - side.z * width / 2);
    pos.push(p.x + side.x * width / 2, y, p.z + side.z * width / 2);
    uv.push(0, t * uvScaleV, 1, t * uvScaleV);
    if (i < segments) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// narrow painted stripe offset from centreline; dashed via segment skipping
function stripeAlong(curve, offset, width, segments, dashed, y) {
  const pos = [], idx = [];
  const up = new THREE.Vector3(0, 1, 0);
  let vi = 0;
  for (let i = 0; i < segments; i++) {
    if (dashed && (i % 6) > 2) continue;
    for (let k = 0; k <= 1; k++) {
      const t = (i + k) / segments;
      const p = curve.getPointAt(t % 1);
      const tan = curve.getTangentAt(t % 1);
      const side = new THREE.Vector3().crossVectors(tan, up).normalize();
      pos.push(p.x + side.x * (offset - width / 2), y, p.z + side.z * (offset - width / 2));
      pos.push(p.x + side.x * (offset + width / 2), y, p.z + side.z * (offset + width / 2));
    }
    idx.push(vi, vi + 1, vi + 2, vi + 1, vi + 3, vi + 2);
    vi += 4;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// ------------------------------------------------------------------ props
function addCollider(list, mesh, pad = 0) {
  mesh.updateWorldMatrix(true, false);
  const box = new THREE.Box3().setFromObject(mesh);
  if (pad) box.expandByScalar(pad);
  list.push(box);
}

function crate(mats, s = 1.4) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(s, s, s), mats.wood);
  m.castShadow = m.receiveShadow = true;
  return m;
}

function barrel(mats) {
  const g = new THREE.CylinderGeometry(0.42, 0.42, 1.1, 14);
  const m = new THREE.Mesh(g, mats.barrel);
  m.castShadow = m.receiveShadow = true;
  return m;
}

function jerseyBarrier(mats) {
  const shape = new THREE.Shape();
  shape.moveTo(-0.5, 0); shape.lineTo(0.5, 0); shape.lineTo(0.28, 0.35);
  shape.lineTo(0.16, 1.0); shape.lineTo(-0.16, 1.0); shape.lineTo(-0.28, 0.35);
  shape.closePath();
  const g = new THREE.ExtrudeGeometry(shape, { depth: 3.2, bevelEnabled: false });
  g.rotateY(Math.PI / 2);
  g.translate(1.6, 0, 0);
  const m = new THREE.Mesh(g, mats.concrete);
  m.castShadow = m.receiveShadow = true;
  return m;
}

function sandbagWall(mats, len = 4) {
  const grp = new THREE.Group();
  const bag = new THREE.SphereGeometry(0.34, 8, 6);
  bag.scale(1.35, 0.62, 0.9);
  for (let row = 0; row < 3; row++) {
    const n = Math.floor(len / 0.8);
    for (let i = 0; i < n; i++) {
      const b = new THREE.Mesh(bag, mats.sandbag);
      b.position.set(i * 0.8 - len / 2 + (row % 2) * 0.4, 0.2 + row * 0.38, 0);
      b.rotation.y = (i * 0.7 + row) % 0.4 - 0.2;
      b.castShadow = b.receiveShadow = true;
      grp.add(b);
    }
  }
  return grp;
}

function watchtower(mats) {
  const grp = new THREE.Group();
  const legG = new THREE.BoxGeometry(0.22, 7, 0.22);
  for (const [x, z] of [[-1.4, -1.4], [1.4, -1.4], [-1.4, 1.4], [1.4, 1.4]]) {
    const leg = new THREE.Mesh(legG, mats.darkMetal);
    leg.position.set(x, 3.5, z);
    leg.castShadow = true;
    grp.add(leg);
  }
  // cross braces
  const braceG = new THREE.BoxGeometry(0.1, 4.2, 0.1);
  for (let s = 0; s < 4; s++) {
    const br = new THREE.Mesh(braceG, mats.darkMetal);
    br.position.y = 3.2;
    br.rotation.z = 0.6 * (s % 2 ? 1 : -1);
    br.rotation.y = (Math.PI / 2) * s;
    const off = 1.42;
    br.position.x = s === 0 ? 0 : s === 2 ? 0 : (s === 1 ? off : -off);
    br.position.z = s === 0 ? -off : s === 2 ? off : 0;
    grp.add(br);
  }
  const cab = new THREE.Mesh(new THREE.BoxGeometry(3.6, 2.1, 3.6), mats.plywood);
  cab.position.y = 8.0; cab.castShadow = cab.receiveShadow = true;
  grp.add(cab);
  const roof = new THREE.Mesh(new THREE.BoxGeometry(4.2, 0.18, 4.2), mats.darkMetal);
  roof.position.y = 9.25; roof.castShadow = true;
  grp.add(roof);
  const rail = new THREE.Mesh(new THREE.BoxGeometry(3.9, 0.55, 3.9), mats.darkMetal);
  rail.position.y = 7.0;
  grp.add(rail);
  return grp;
}

function commsMast(mats) {
  const grp = new THREE.Group();
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.16, 18, 8), mats.darkMetal);
  mast.position.y = 9; mast.castShadow = true;
  grp.add(mast);
  for (let i = 0; i < 3; i++) {
    const dish = new THREE.Mesh(new THREE.SphereGeometry(0.55, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), mats.metal);
    dish.rotation.x = Math.PI / 2 + 0.4;
    dish.rotation.y = i * 2.1;
    dish.position.set(Math.sin(i * 2.1) * 0.5, 13 + i * 1.6, Math.cos(i * 2.1) * 0.5);
    grp.add(dish);
  }
  const beacon = new THREE.Mesh(
    new THREE.SphereGeometry(0.14, 8, 8),
    new THREE.MeshBasicMaterial({ color: 0xff2020 })
  );
  beacon.position.y = 18.1;
  grp.add(beacon);
  grp.userData.beacon = beacon;
  return grp;
}

function floodlight(mats) {
  const grp = new THREE.Group();
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.14, 7.5, 8), mats.darkMetal);
  pole.position.y = 3.75; pole.castShadow = true;
  grp.add(pole);
  const head = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.4, 0.5), mats.darkMetal);
  head.position.y = 7.4;
  grp.add(head);
  const lamp = new THREE.Mesh(
    new THREE.PlaneGeometry(1.1, 0.26),
    new THREE.MeshBasicMaterial({ color: 0xffd9a0 })
  );
  lamp.position.set(0, 7.4, 0.26);
  grp.add(lamp);
  return grp;
}

function rock(mats, seed) {
  const g = new THREE.IcosahedronGeometry(1, 1);
  const p = g.attributes.position;
  const rnd = (i) => (Math.sin(seed * 12.9898 + i * 78.233) * 43758.5453) % 1;
  for (let i = 0; i < p.count; i++) {
    const f = 0.75 + Math.abs(rnd(i)) * 0.5;
    p.setXYZ(i, p.getX(i) * f, p.getY(i) * f * 0.7, p.getZ(i) * f);
  }
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, mats.rock);
  m.castShadow = m.receiveShadow = true;
  return m;
}

function bush(mats) {
  const grp = new THREE.Group();
  for (let i = 0; i < 3; i++) {
    const pl = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 1.1), mats.bush);
    pl.rotation.y = (Math.PI / 3) * i;
    pl.position.y = 0.5;
    grp.add(pl);
  }
  return grp;
}

function bushTexture() {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 96;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, 128, 96);
  for (let i = 0; i < 240; i++) {
    const x = 64 + (Math.random() - 0.5) * 110;
    const y = 96 - Math.random() * 78;
    ctx.strokeStyle = `rgba(${92 + Math.random() * 40},${78 + Math.random() * 30},${40 + Math.random() * 16},${0.5 + Math.random() * 0.5})`;
    ctx.lineWidth = 1 + Math.random();
    ctx.beginPath();
    ctx.moveTo(64, 96);
    ctx.quadraticCurveTo((64 + x) / 2 + (Math.random() - 0.5) * 20, (96 + y) / 2, x, y);
    ctx.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// distant mountain ridge ring
function buildMountains(scene) {
  const mat = new THREE.MeshBasicMaterial({ color: 0x8d6e55, fog: true });
  const matFar = new THREE.MeshBasicMaterial({ color: 0xb28d6e, fog: true });
  const mk = (radius, height, seed, m) => {
    const seg = 280;
    const pos = [], idx = [];
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      const n1 = Math.sin(a * 3 + seed) + Math.sin(a * 7.3 + seed * 2) * 0.5 + Math.sin(a * 13.7 + seed * 3) * 0.3;
      const n2 = Math.sin(a * 22 + seed * 4) * 0.25 + Math.sin(a * 41 + seed * 5) * 0.12;
      const h = height * (0.45 + 0.55 * Math.abs(n1 + n2));
      const x = Math.cos(a) * radius, z = Math.sin(a) * radius;
      pos.push(x, -8, z);
      pos.push(x, h, z);
      if (i < seg) {
        const b = i * 2;
        idx.push(b, b + 2, b + 1, b + 1, b + 2, b + 3);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    const mesh = new THREE.Mesh(g, m);
    scene.add(mesh);
  };
  mk(950, 130, 1.7, mat);
  mk(1600, 260, 4.2, matFar);
}

// ------------------------------------------------------------------ main build
export function buildWorld(scene, renderer) {
  const colliders = [];       // Box3 list for movement blocking
  const shootables = [];      // meshes for bullet raycasts

  // fog & lights -----------------------------------------------------------
  scene.fog = new THREE.FogExp2(0xdcaf82, 0.0013);
  const sun = new THREE.DirectionalLight(SUN_COLOR, 3.4);
  sun.position.copy(SUN_DIR).multiplyScalar(400);
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  sun.shadow.camera.near = 50;
  sun.shadow.camera.far = 900;
  const S = 160;
  sun.shadow.camera.left = -S; sun.shadow.camera.right = S;
  sun.shadow.camera.top = S; sun.shadow.camera.bottom = -S;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.03;
  scene.add(sun, sun.target);

  const hemi = new THREE.HemisphereLight(0x8fa3c7, 0x8a6a48, 0.75);
  scene.add(hemi);

  const skyMat = buildSky(scene);
  buildEnvMap(renderer, scene);
  buildMountains(scene);

  // materials --------------------------------------------------------------
  const groundTex = makeGround();
  const asphaltTex = makeAsphalt();
  const concTex = makeConcrete();
  const concDarkTex = makeConcrete(760, [96, 92, 86]);
  const metalTex = makeMetal();
  const woodTex = makeWood();
  const hazardTex = makeHazard();

  const mats = {
    ground: new THREE.MeshStandardMaterial({
      map: groundTex.map, normalMap: groundTex.normalMap,
      normalScale: new THREE.Vector2(2.0, 2.0), roughness: 0.96, metalness: 0,
    }),
    asphalt: new THREE.MeshStandardMaterial({
      map: asphaltTex.map, normalMap: asphaltTex.normalMap, roughness: 0.88, metalness: 0.05,
    }),
    concrete: new THREE.MeshStandardMaterial({
      map: concTex.map, normalMap: concTex.normalMap, roughness: 0.92, metalness: 0,
    }),
    concreteDark: new THREE.MeshStandardMaterial({
      map: concDarkTex.map, normalMap: concDarkTex.normalMap, roughness: 0.90, metalness: 0.08,
    }),
    metal: new THREE.MeshStandardMaterial({
      map: metalTex.map, normalMap: metalTex.normalMap, roughness: 0.55, metalness: 0.65,
    }),
    darkMetal: new THREE.MeshStandardMaterial({ color: 0x2e3033, roughness: 0.6, metalness: 0.7 }),
    wood: new THREE.MeshStandardMaterial({ map: woodTex.map, roughness: 0.85 }),
    plywood: new THREE.MeshStandardMaterial({ map: woodTex.map, color: 0xb0a486, roughness: 0.9 }),
    barrel: new THREE.MeshStandardMaterial({
      map: metalTex.map, color: 0x7a8850, roughness: 0.5, metalness: 0.5,
    }),
    hazard: new THREE.MeshStandardMaterial({ map: hazardTex.map, roughness: 0.8 }),
    sandbag: new THREE.MeshStandardMaterial({ color: 0x9a8a66, roughness: 1 }),
    rock: new THREE.MeshStandardMaterial({ color: 0x8a7761, roughness: 1 }),
    bush: new THREE.MeshBasicMaterial({
      map: bushTexture(), transparent: true, alphaTest: 0.15, side: THREE.DoubleSide,
      color: 0xcfa87a, fog: true,
    }),
    line: new THREE.MeshStandardMaterial({
      color: 0xd8d4c8, roughness: 0.85,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    }),
    lineYellow: new THREE.MeshStandardMaterial({
      color: 0xc7a428, roughness: 0.85,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    }),
  };

  // terrain with elevation ------------------------------------------------
  const terrainGeo = new THREE.PlaneGeometry(4000, 4000, 32, 32);
  const terrainPos = terrainGeo.attributes.position;
  const elevNoise = (function() {
    const N = (x, y) => Math.sin(x * 12.9898 + y * 78.233) * 43758.5453 % 1;
    return (x, z) => {
      let v = 0, a = 1, f = 0.004;
      for (let i = 0; i < 4; i++) {
        const xi = Math.floor(x * f), zi = Math.floor(z * f);
        const xf = (x * f) - xi, zf = (z * f) - zi;
        const sx = xf * xf * (3 - 2 * xf), sz = zf * zf * (3 - 2 * zf);
        const n00 = N(xi, zi), n10 = N(xi + 1, zi), n01 = N(xi, zi + 1), n11 = N(xi + 1, zi + 1);
        const ny = (n00 * (1 - sx) + n10 * sx) * (1 - sz) + (n01 * (1 - sx) + n11 * sx) * sz;
        v += a * (ny - 0.5) * 2; a *= 0.5; f *= 2;
      }
      return Math.max(-8, Math.min(8, v * 8));
    };
  })();
  for (let i = 0; i < terrainPos.count; i++) {
    const x = terrainPos.getX(i), z = terrainPos.getZ(i);
    const elev = elevNoise(x, z);
    terrainPos.setY(i, elev);
  }
  terrainPos.needsUpdate = true;
  terrainGeo.computeVertexNormals();
  const ground = new THREE.Mesh(terrainGeo, mats.ground);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);
  shootables.push(ground);

  // road -------------------------------------------------------------------
  const curve = buildRoadCurve();
  const SEGS = 640;
  const road = new THREE.Mesh(ribbonAlong(curve, 11, SEGS, 0.03, 160), mats.asphalt);
  road.receiveShadow = true;
  scene.add(road);
  shootables.push(road);
  const shoulder = new THREE.Mesh(ribbonAlong(curve, 13.5, SEGS, 0.015, 160), mats.concreteDark);
  shoulder.receiveShadow = true;
  scene.add(shoulder);
  // road ditches for terrain integration
  const ditch = new THREE.Mesh(ribbonAlong(curve, 15.8, SEGS, -0.3, 160), mats.ground);
  ditch.receiveShadow = true;
  scene.add(ditch);
  scene.add(new THREE.Mesh(stripeAlong(curve, 0, 0.18, 420, true, 0.05), mats.lineYellow));
  scene.add(new THREE.Mesh(stripeAlong(curve, -4.9, 0.16, SEGS, false, 0.05), mats.line));
  scene.add(new THREE.Mesh(stripeAlong(curve, 4.9, 0.16, SEGS, false, 0.05), mats.line));

  // sampled road points for keep-clear tests
  const roadPts = [];
  for (let i = 0; i < 240; i++) roadPts.push(curve.getPointAt(i / 240));
  const distToRoad = (x, z) => {
    let d = Infinity;
    for (const p of roadPts) {
      const dx = p.x - x, dz = p.z - z;
      const dd = dx * dx + dz * dz;
      if (dd < d) d = dd;
    }
    return Math.sqrt(d);
  };

  // compound ---------------------------------------------------------------
  const solid = (mesh, pad = 0) => {
    scene.add(mesh);
    addCollider(colliders, mesh, pad);
    mesh.traverse((o) => { if (o.isMesh) shootables.push(o); });
    return mesh;
  };

  // main HQ block with wear details
  {
    const f = makeFacade(11, 3, 6, 0.35);
    const m = new THREE.MeshStandardMaterial({
      map: f.map, emissiveMap: f.emissiveMap, emissive: 0xffb060, emissiveIntensity: 1.4, roughness: 0.88, metalness: 0.05,
    });
    const hq = new THREE.Mesh(new THREE.BoxGeometry(26, 12, 16), [m, m, mats.concrete, mats.concrete, m, m]);
    hq.position.set(-6, 6, -18);
    hq.castShadow = hq.receiveShadow = true;
    solid(hq);
    // damage streak decals: bullet impact marks on facade
    for (let i = 0; i < 3; i++) {
      const streak = new THREE.Mesh(new THREE.BoxGeometry(0.35, 1.8, 0.02),
        new THREE.MeshStandardMaterial({ color: 0x3a3a38, roughness: 0.8, metalness: 0.1 }));
      streak.position.set(-10 + i * 8, 6 + Math.random() * 3, 8.05);
      streak.receiveShadow = true;
      scene.add(streak);
    }
    const lip = new THREE.Mesh(new THREE.BoxGeometry(27, 0.7, 17), mats.concreteDark);
    lip.position.set(-6, 12.3, -18); lip.castShadow = true;
    scene.add(lip);
    // rooftop AC boxes
    for (let i = 0; i < 3; i++) {
      const ac = new THREE.Mesh(new THREE.BoxGeometry(2.2, 1.2, 2.2), mats.metal);
      ac.position.set(-14 + i * 8, 13.2, -18 + (i % 2 ? 3 : -3));
      ac.castShadow = true;
      scene.add(ac);
    }
  }

  // barracks
  {
    const f = makeFacade(29, 2, 5, 0.2);
    const m = new THREE.MeshStandardMaterial({
      map: f.map, emissiveMap: f.emissiveMap, emissive: 0xffb060, emissiveIntensity: 1.2, roughness: 0.92,
    });
    const b = new THREE.Mesh(new THREE.BoxGeometry(18, 7, 10), [m, m, mats.concreteDark, mats.concreteDark, m, m]);
    b.position.set(34, 3.5, 8);
    b.rotation.y = -0.35;
    b.castShadow = b.receiveShadow = true;
    solid(b);
  }

  // hangar / garage — this is where the car lives
  {
    const grp = new THREE.Group();
    const wallL = new THREE.Mesh(new THREE.BoxGeometry(0.4, 6, 14), mats.metal);
    wallL.position.set(-6, 3, 0);
    const wallR = wallL.clone(); wallR.position.x = 6;
    const back = new THREE.Mesh(new THREE.BoxGeometry(12.4, 6, 0.4), mats.metal);
    back.position.set(0, 3, -7);
    const roof = new THREE.Mesh(new THREE.BoxGeometry(13.6, 0.4, 15.4), mats.darkMetal);
    roof.position.set(0, 6.2, 0);
    const floor = new THREE.Mesh(new THREE.BoxGeometry(13.6, 0.08, 15.4), mats.concreteDark);
    floor.position.y = 0.04;
    floor.receiveShadow = true;
    for (const w of [wallL, wallR, back, roof]) { w.castShadow = w.receiveShadow = true; }
    grp.add(wallL, wallR, back, roof, floor);
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(13.6, 0.5, 0.1), mats.hazard);
    stripe.position.set(0, 5.8, 7.6);
    grp.add(stripe);
    grp.position.set(-38, 0, 26);
    grp.rotation.y = 0.9;
    scene.add(grp);
    grp.updateWorldMatrix(true, true);
    for (const w of [wallL, wallR, back]) { addCollider(colliders, w); shootables.push(w); }
  }

  // watchtowers
  for (const [x, z, r] of [[52, -42, 0.4], [-58, -52, -0.7], [18, 60, 2.6]]) {
    const t = watchtower(mats);
    t.position.set(x, 0, z);
    t.rotation.y = r;
    solid(t, -0.6);
  }

  solid(commsMast(mats)).position.set(-24, 0, -34);

  for (const [x, z, r] of [[14, -6, 0.3], [-30, 6, 1.8], [40, -18, 2.4], [-8, 34, 0.9], [58, 22, -0.5]]) {
    const fl = floodlight(mats);
    fl.position.set(x, 0, z); fl.rotation.y = r;
    scene.add(fl);
  }

  // crates & cover clusters (expanded compound density)
  const crateSpots = [
    [8, 4, 0.2], [9.6, 4.8, 0.9], [8.7, 5.9, 0.4, 1.4], [-16, 14, 0.7], [-14.4, 15.2, 1.2],
    [24, -14, 0.1], [25.6, -13.2, 0.8], [24.8, -13.6, 0.5, 1.4], [-2, 22, 1.1], [46, 4, 0.5],
    [-44, -12, 0.9], [-45.6, -11, 1.5], [12, -28, 0.35], [13.4, -27, 1.0],
    // additional cluster east of HQ
    [-4, -8, 0.3], [-2.6, -9.4, 1.1], [-5.2, -9, 0.6, 1.2],
    // north ammo storage
    [18, 28, 0.4], [20.2, 29.6, 0.9], [19.4, 30.8, 0.5, 1.3],
    // south-west crates
    [-34, -22, 0.1], [-32.6, -23.4, 0.8], [-35.2, -23, 0.5, 1.1],
  ];
  // decal textures for tactical labeling
  const decalAmmo = makeCompoundDecal('ammo');
  const decalHazard = makeCompoundDecal('hazard');
  const decalFuel = makeCompoundDecal('fuel');

  for (const [x, z, r, y] of crateSpots) {
    const c = crate(mats, 1.2 + Math.random() * 0.4);
    c.position.set(x, (y || 0) + 0.7, z);
    c.rotation.y = r;
    solid(c);
    // occasional decal on crate faces
    if (Math.random() < 0.35) {
      const decalType = Math.random() < 0.6 ? decalAmmo : Math.random() < 0.5 ? decalHazard : decalFuel;
      const decal = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 0.6),
        new THREE.MeshStandardMaterial({ map: decalType, transparent: true, alphaTest: 0.1, roughness: 0.7 }));
      decal.position.z = 0.72;
      c.add(decal);
    }
  }
  // barrels expanded
  for (const [x, z] of [
    [6, 8], [26, -10], [-18, 18], [44, 8], [-40, -16], [16, -24], [-4, 26],
    // new barrel clusters
    [-12, 6, 0.2], [-10.4, 7.8, 0.9], [32, -8, 0.4], [34.2, -6.8, 1.1],
    [-22, -16, 0.3], [-20.6, -14.4, 0.8],
  ]) {
    const b = barrel(mats);
    b.position.set(x, elevNoise(x, z) + 0.55, z);
    solid(b);
  }
  // fuel cans and small boxes (with shadows for depth)
  for (const [x, z, s] of [
    [10, 12, 0.7], [12.4, 11.2, 0.65], [-8, -6, 0.6], [-6.4, -7.6, 0.7],
    [28, 16, 0.65], [30.2, 14.6, 0.7], [-28, 8, 0.6], [-26.4, 6.8, 0.65],
  ]) {
    const box = new THREE.Mesh(new THREE.BoxGeometry(s * 0.6, s * 0.8, s * 0.5), mats.metal);
    box.position.set(x, elevNoise(x, z) + s * 0.4, z);
    box.castShadow = box.receiveShadow = true;
    scene.add(box);
    addCollider(colliders, box);
    shootables.push(box);
  }
  // additional scattered fuel drums & containers near garage
  for (const [x, z, r] of [[-34, 20, 0.2], [-32, 22.4, 0.7], [-36.2, 21.6, 0.3]]) {
    const container = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.35, 0.9, 10), mats.barrel);
    container.position.set(x, elevNoise(x, z) + 0.45, z);
    container.rotation.y = r;
    container.castShadow = container.receiveShadow = true;
    scene.add(container);
    addCollider(colliders, container);
    shootables.push(container);
  }

  // jersey barriers guarding the compound road edge
  for (const [x, z, r] of [
    [0, 44, 0.1], [8, 46, 0.25], [-52, 22, 1.3], [-56, 12, 1.45], [60, -8, -1.2],
    [30, -36, -0.4], [20, -40, -0.3], [-20, -44, 0.2],
  ]) {
    const j = jerseyBarrier(mats);
    j.position.set(x, 0, z);
    j.rotation.y = r;
    solid(j);
  }

  // sandbag positions (visual cover, low collider)
  for (const [x, z, r] of [[4, -12, 0.4], [-24, -8, 1.9], [36, 16, 0.8], [-10, 42, 0.1]]) {
    const s = sandbagWall(mats);
    s.position.set(x, 0, z);
    s.rotation.y = r;
    solid(s);
  }

  // scatter: rocks & bushes outside the road (expanded density)
  const rand = ((s) => () => (s = (s * 16807) % 2147483647) / 2147483647)(9977);
  for (let i = 0; i < 420; i++) {
    const a = rand() * Math.PI * 2;
    const r = 40 + rand() * 380;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    if (distToRoad(x, z) < 12) continue;
    if (rand() < 0.55) {
      const rk = rock(mats, i);
      const s = 0.3 + rand() * 3.2;
      rk.scale.setScalar(s);
      rk.position.set(x, elevNoise(x, z) + 0.2 * s, z);
      rk.rotation.y = rand() * 6;
      scene.add(rk);
      if (s > 1.2) { addCollider(colliders, rk); shootables.push(rk); }
    } else {
      const b = bush(mats);
      b.position.set(x, elevNoise(x, z), z);
      b.rotation.y = rand() * 6;
      b.scale.setScalar(0.6 + rand() * 1.2);
      scene.add(b);
    }
  }

  // power line run along the outside of the circuit
  {
    const poleMat = mats.darkMetal;
    const wireMat = new THREE.LineBasicMaterial({ color: 0x1a1a1c });
    let prevTop = null;
    for (let i = 0; i < 14; i++) {
      const t = i / 14;
      const p = curve.getPointAt(t);
      const tan = curve.getTangentAt(t);
      const side = new THREE.Vector3().crossVectors(tan, new THREE.Vector3(0, 1, 0)).normalize();
      const px = p.x + side.x * 20, pz = p.z + side.z * 20;
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.17, 9, 6), poleMat);
      pole.position.set(px, 4.5, pz);
      pole.castShadow = true;
      scene.add(pole);
      const arm = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.12, 0.12), poleMat);
      arm.position.set(px, 8.6, pz);
      arm.lookAt(px + tan.x, 8.6, pz + tan.z);
      arm.rotateY(Math.PI / 2);
      scene.add(arm);
      const top = new THREE.Vector3(px, 8.75, pz);
      if (prevTop) {
        const pts = [];
        for (let s = 0; s <= 10; s++) {
          const q = prevTop.clone().lerp(top, s / 10);
          q.y -= Math.sin((s / 10) * Math.PI) * 1.1; // catenary sag
          pts.push(q);
        }
        scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), wireMat));
      }
      prevTop = top;
    }
  }

  // drifting dust motes with wind variation --------------------------------
  const dustCount = 320;
  const dustGeo = new THREE.BufferGeometry();
  const dp = new Float32Array(dustCount * 3);
  for (let i = 0; i < dustCount; i++) {
    dp[i * 3] = (Math.random() - 0.5) * 240;
    dp[i * 3 + 1] = 0.3 + Math.random() * 7;
    dp[i * 3 + 2] = (Math.random() - 0.5) * 240;
  }
  dustGeo.setAttribute('position', new THREE.BufferAttribute(dp, 3));
  const dust = new THREE.Points(dustGeo, new THREE.PointsMaterial({
    map: makeSoftParticle('rgba(255,225,190,0.5)', 'rgba(255,225,190,0)'),
    size: 0.35, transparent: true, opacity: 0.5, depthWrite: false,
    blending: THREE.AdditiveBlending, sizeAttenuation: true,
  }));
  scene.add(dust);
  // pre-compute wind noise function
  dust.userData.windNoise = (t) => {
    const n1 = Math.sin(t * 0.3) * 0.6 + Math.sin(t * 0.13 + 7.3) * 0.25;
    const n2 = Math.sin(t * 0.07 + 4.2) * 0.4;
    return { x: (n1 + n2) * 2.5, z: Math.sin(t * 0.2) * 1.8 };
  };

  // ------------------------------------------------------------------ api
  let time = 0;
  const beacons = [];
  scene.traverse((o) => { if (o.userData && o.userData.beacon) beacons.push(o.userData.beacon); });

  return {
    curve,
    colliders,
    shootables,
    distToRoad,
    groundHeight: () => 0,
    sun,
    update(dt, focus) {
      time += dt;
      skyMat.uniforms.time.value = time;
      // shadow frustum follows the player/car
      sun.position.set(focus.x + SUN_DIR.x * 400, SUN_DIR.y * 400, focus.z + SUN_DIR.z * 400);
      sun.target.position.set(focus.x, 0, focus.z);
      // dust drifts on the wind and wraps around the focus point
      const wind = dust.userData.windNoise(time);
      const pos = dust.geometry.attributes.position;
      for (let i = 0; i < dustCount; i++) {
        let x = pos.getX(i) + (wind.x + 2.1) * dt;
        let y = pos.getY(i);
        let z = pos.getZ(i) + (wind.z + 0.7) * dt;
        if (x - focus.x > 120) x -= 240;
        if (x - focus.x < -120) x += 240;
        if (z - focus.z > 120) z -= 240;
        if (z - focus.z < -120) z += 240;
        pos.setXYZ(i, x, y, z);
      }
      pos.needsUpdate = true;
      for (const b of beacons) b.material.color.setHex((time % 1.6) < 0.8 ? 0xff2020 : 0x551010);
    },
  };
}

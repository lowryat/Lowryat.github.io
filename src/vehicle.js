// "Stuttgart Turbo S" — a rear-engined German flat-six coupe, lofted
// procedurally: sectioned hull, clearcoat paint, glass canopy, full-width
// light bar. Physics is an arcade-sim hybrid: engine curve + gears, grip
// circle, handbrake drift, visual suspension pitch/roll.
import * as THREE from 'three';
import { makeTire } from './textures.js';

const DEG = Math.PI / 180;

// ---------------------------------------------------------------- body loft
// Cross sections along the car; +Z is the nose. All units in metres.
const LEN = 4.5, HALF = LEN / 2;

function roofY(t) {
  // t: 0 rear → 1 front. Classic 911 silhouette.
  const rearDeck = 0.98, roof = 1.335, hood = 0.86, noseTip = 0.62;
  if (t < 0.10) return rearDeck - (0.10 - t) * 2.4;          // tail cut
  if (t < 0.42) {                                            // fastback rise
    const k = (t - 0.10) / 0.32;
    return rearDeck + (roof - rearDeck) * Math.sin(k * Math.PI / 2) ** 1.15;
  }
  if (t < 0.60) return roof;                                 // roof
  if (t < 0.80) {                                            // windshield down to hood
    const k = (t - 0.60) / 0.20;
    return roof + (hood - roof) * (k * k * (3 - 2 * k));
  }
  const k = (t - 0.80) / 0.20;                               // hood → nose
  return hood + (noseTip - hood) * k * k;
}

function beltY(t) {
  return 0.72 + 0.06 * Math.sin(t * Math.PI) - 0.05 * (1 - t);
}

function halfW(t) {
  // fender bulges: rear axle ~t=0.17, front axle ~t=0.83
  const base = 0.86;
  const rear = 0.115 * Math.exp(-(((t - 0.16) / 0.16) ** 2));
  const front = 0.065 * Math.exp(-(((t - 0.82) / 0.14) ** 2));
  const taper = 1 - 0.28 * Math.max(0, (t - 0.86) / 0.14) ** 1.5   // nose taper
              - 0.10 * Math.max(0, (0.06 - t) / 0.06);             // tail tuck
  return (base + rear + front) * taper;
}

function greenhouse(t) {
  // 0 → no cabin at this station, 1 → full glass band
  if (t < 0.12 || t > 0.78) return 0;
  return Math.min(1, Math.min((t - 0.12) / 0.05, (0.78 - t) / 0.05));
}

function buildBodyGeometry() {
  const SEC = 56, PTS = 26;  // stations, points per half-section
  const positions = [], uvs = [];
  const sectionPts = [];
  for (let i = 0; i <= SEC; i++) {
    const t = i / SEC;
    const z = -HALF + t * LEN;
    const ry = roofY(t), by = beltY(t), hw = halfW(t), gh = greenhouse(t);
    const ghw = hw * (0.74 + 0.26 * (1 - gh));   // greenhouse tucks inward
    const bottom = 0.14, sill = 0.30;
    const pts = [];
    for (let j = 0; j < PTS; j++) {
      const u = j / (PTS - 1);
      let x, y;
      if (u < 0.14) {                        // floor → sill
        const k = u / 0.14;
        x = hw * (0.62 + 0.38 * Math.sin(k * Math.PI / 2));
        y = bottom + (sill - bottom) * k;
      } else if (u < 0.55) {                 // body side up to shoulder
        const k = (u - 0.14) / 0.41;
        const bulge = Math.sin(k * Math.PI) * 0.035;
        x = hw + bulge * hw;
        y = sill + (by - sill) * k;
      } else if (u < 0.68) {                 // shoulder roll-in
        const k = (u - 0.55) / 0.13;
        const a = k * Math.PI / 2;
        x = hw + (ghw - hw) * (1 - Math.cos(a));
        y = by + 0.05 * Math.sin(a) * (ry - by);
      } else {                               // greenhouse → roof centre
        const k = (u - 0.68) / 0.32;
        const a = k * Math.PI / 2;
        x = ghw * Math.cos(a);
        y = by + (ry - by) * (0.05 + 0.95 * Math.sin(a));
      }
      pts.push([x, y]);
    }
    sectionPts.push({ z, pts, t, by, gh });
  }

  // emit mirrored grid: for each station, right side then left side reversed
  const ring = [];
  for (const s of sectionPts) {
    const r = [];
    for (let j = 0; j < PTS; j++) r.push([s.pts[j][0], s.pts[j][1], s.z]);
    for (let j = PTS - 2; j >= 0; j--) r.push([-s.pts[j][0], s.pts[j][1], s.z]);
    ring.push(r);
  }
  const W = ring[0].length;
  const index = [], glassIndex = [];
  for (let i = 0; i < ring.length; i++) {
    for (const p of ring[i]) { positions.push(p[0], p[1], p[2]); uvs.push(0, 0); }
  }
  const s0 = sectionPts;
  for (let i = 0; i < ring.length - 1; i++) {
    for (let j = 0; j < W - 1; j++) {
      const a = i * W + j, b = a + W;
      // glass zone: cabin stations, above belt, on the greenhouse slope
      const jj = j < PTS ? j : (2 * PTS - 2 - j);
      const u = jj / (PTS - 1);
      const onGlassBand = u > 0.57 && u < 0.97;
      const cabin = Math.min(s0[i].gh, s0[i + 1].gh) > 0.4;
      const tMid = (s0[i].t + s0[i + 1].t) / 2;
      const windshield = tMid > 0.585 && tMid < 0.78 && u > 0.60;
      const rearGlass = tMid > 0.13 && tMid < 0.40 && u > 0.60;
      const tgt = ((cabin && onGlassBand) || windshield || rearGlass) ? glassIndex : index;
      tgt.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  // close tail & nose with fans
  const capIdx = [];
  const capCenter = (i, y) => {
    const ci = positions.length / 3;
    positions.push(0, y, ring[i][0][2]); uvs.push(0, 0);
    return ci;
  };
  {
    const c = capCenter(0, 0.55);
    for (let j = 0; j < W - 1; j++) capIdx.push(c, j, j + 1);
  }
  {
    const off = (ring.length - 1) * W;
    const c = capCenter(ring.length - 1, 0.38);
    for (let j = 0; j < W - 1; j++) capIdx.push(c, off + j + 1, off + j);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex([...index, ...capIdx, ...glassIndex]);
  geo.addGroup(0, index.length + capIdx.length, 0);
  geo.addGroup(index.length + capIdx.length, glassIndex.length, 1);
  geo.computeVertexNormals();
  return geo;
}

function buildWheel(tireTex) {
  const grp = new THREE.Group();
  const R = 0.345, W = 0.30;
  const tire = new THREE.Mesh(
    new THREE.CylinderGeometry(R, R, W, 28),
    new THREE.MeshStandardMaterial({ map: tireTex.map, normalMap: tireTex.normalMap, roughness: 0.92, color: 0x99999b })
  );
  tire.rotation.z = Math.PI / 2;
  tire.castShadow = true;
  grp.add(tire);
  const rimMat = new THREE.MeshStandardMaterial({ color: 0x30353b, metalness: 0.9, roughness: 0.32 });
  const rim = new THREE.Mesh(new THREE.CylinderGeometry(R * 0.62, R * 0.62, W * 1.02, 20), rimMat);
  rim.rotation.z = Math.PI / 2;
  grp.add(rim);
  // twin five-spoke
  const spokeG = new THREE.BoxGeometry(W * 1.04, R * 1.18, 0.045);
  for (let i = 0; i < 5; i++) {
    const s = new THREE.Mesh(spokeG, rimMat);
    s.rotation.x = (i / 5) * Math.PI * 2;
    s.rotation.z = Math.PI / 2;
    grp.add(s);
  }
  const hub = new THREE.Mesh(
    new THREE.CylinderGeometry(0.07, 0.07, W * 1.1, 12),
    new THREE.MeshStandardMaterial({ color: 0xc8c8cc, metalness: 1, roughness: 0.25 })
  );
  hub.rotation.z = Math.PI / 2;
  grp.add(hub);
  // brake disc + caliper (doesn't spin — sits behind)
  const stat = new THREE.Group();
  const disc = new THREE.Mesh(
    new THREE.CylinderGeometry(R * 0.55, R * 0.55, 0.03, 24),
    new THREE.MeshStandardMaterial({ color: 0x777a7e, metalness: 0.95, roughness: 0.45 })
  );
  disc.rotation.z = Math.PI / 2;
  stat.add(disc);
  const cal = new THREE.Mesh(
    new THREE.BoxGeometry(0.05, 0.13, 0.2),
    new THREE.MeshStandardMaterial({ color: 0xc9a22c, metalness: 0.4, roughness: 0.4 })
  );
  cal.position.set(0, R * 0.42, R * 0.28);
  stat.add(cal);
  return { grp, stat };
}

export function buildCarMesh() {
  const car = new THREE.Group();
  const paint = new THREE.MeshPhysicalMaterial({
    color: 0x8c1717,            // guards red, slightly deepened
    metalness: 0.58, roughness: 0.35,
    clearcoat: 1.0, clearcoatRoughness: 0.04,
    envMapIntensity: 1.65,
  });
  const glass = new THREE.MeshPhysicalMaterial({
    color: 0x10161c, metalness: 0.2, roughness: 0.08,
    clearcoat: 1, clearcoatRoughness: 0.03, envMapIntensity: 1.6,
  });
  const black = new THREE.MeshStandardMaterial({ color: 0x141618, roughness: 0.55, metalness: 0.3 });
  const chrome = new THREE.MeshStandardMaterial({ color: 0xdadde2, metalness: 1, roughness: 0.15 });

  const body = new THREE.Mesh(buildBodyGeometry(), [paint, glass]);
  body.castShadow = true;
  body.receiveShadow = true;
  car.add(body);

  // wheel wells (dark discs so the arches read as openings)
  const wellG = new THREE.CylinderGeometry(0.43, 0.43, 0.34, 20);
  const wellMat = new THREE.MeshBasicMaterial({ color: 0x060607 });
  const axles = { rearZ: -HALF + 0.16 * LEN, frontZ: -HALF + 0.82 * LEN };
  for (const [x, z] of [[0.80, axles.rearZ], [-0.80, axles.rearZ], [0.80, axles.frontZ], [-0.80, axles.frontZ]]) {
    const w = new THREE.Mesh(wellG, wellMat);
    w.rotation.z = Math.PI / 2;
    w.position.set(x, 0.36, z);
    car.add(w);
  }

  // wheels
  const tireTex = makeTire();
  const wheels = [];
  const wheelInfo = [
    { x: 0.84, z: axles.frontZ, steer: true }, { x: -0.84, z: axles.frontZ, steer: true },
    { x: 0.86, z: axles.rearZ, steer: false }, { x: -0.86, z: axles.rearZ, steer: false },
  ];
  for (const wi of wheelInfo) {
    const { grp, stat } = buildWheel(tireTex);
    const pivot = new THREE.Group();
    pivot.position.set(wi.x, 0.345, wi.z);
    pivot.add(grp); pivot.add(stat);
    car.add(pivot);
    wheels.push({ pivot, spin: grp, steer: wi.steer });
  }

  // ---- face: headlights (upright ovals on the fender tops)
  const lightGlassMat = new THREE.MeshPhysicalMaterial({
    color: 0xf5f7fa, emissive: 0xfff2dd, emissiveIntensity: 0.25,
    metalness: 0.1, roughness: 0.12, clearcoat: 1,
  });
  for (const sx of [1, -1]) {
    const h = new THREE.Mesh(new THREE.SphereGeometry(0.135, 18, 14), lightGlassMat);
    h.scale.set(0.95, 1.05, 0.62);
    h.position.set(sx * 0.60, 0.685, HALF - 0.20);
    h.rotation.x = -0.35;
    car.add(h);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.135, 0.014, 8, 24), chrome);
    ring.position.copy(h.position);
    ring.rotation.x = -0.35;
    car.add(ring);
  }
  // front intake + splitter
  const intake = new THREE.Mesh(new THREE.BoxGeometry(1.18, 0.16, 0.1), black);
  intake.position.set(0, 0.34, HALF - 0.045);
  car.add(intake);
  const splitter = new THREE.Mesh(new THREE.BoxGeometry(1.62, 0.05, 0.30), black);
  splitter.position.set(0, 0.135, HALF - 0.18);
  car.add(splitter);

  // ---- tail: full-width light bar
  const bar = new THREE.Mesh(
    new THREE.BoxGeometry(1.46, 0.075, 0.05),
    new THREE.MeshStandardMaterial({
      color: 0x30060a, emissive: 0xff1622, emissiveIntensity: 2.4, roughness: 0.3,
    })
  );
  bar.position.set(0, 0.865, -HALF + 0.035);
  bar.rotation.x = 0.18;
  car.add(bar);
  const barTrim = new THREE.Mesh(new THREE.BoxGeometry(1.56, 0.13, 0.045), black);
  barTrim.position.set(0, 0.862, -HALF + 0.055);
  barTrim.rotation.x = 0.18;
  car.add(barTrim);
  // ducktail spoiler
  const duck = new THREE.Mesh(new THREE.BoxGeometry(1.32, 0.045, 0.34), paint);
  duck.position.set(0, 0.985, -HALF + 0.30);
  duck.rotation.x = -0.22;
  duck.castShadow = true;
  car.add(duck);
  // diffuser + exhausts
  const diff = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.18, 0.16), black);
  diff.position.set(0, 0.24, -HALF + 0.06);
  car.add(diff);
  for (const sx of [0.28, -0.28]) {
    const ex = new THREE.Mesh(new THREE.CylinderGeometry(0.048, 0.052, 0.16, 12), chrome);
    ex.rotation.x = Math.PI / 2;
    ex.position.set(sx, 0.26, -HALF - 0.01);
    car.add(ex);
  }
  // plate
  const plateC = document.createElement('canvas');
  plateC.width = 128; plateC.height = 28;
  const pc = plateC.getContext('2d');
  pc.fillStyle = '#e8e6df'; pc.fillRect(0, 0, 128, 28);
  pc.fillStyle = '#16161a'; pc.font = 'bold 19px monospace'; pc.textAlign = 'center';
  pc.fillText('S·RL 911', 64, 21);
  const plateT = new THREE.CanvasTexture(plateC);
  plateT.colorSpace = THREE.SRGBColorSpace;
  const plate = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.11),
    new THREE.MeshStandardMaterial({ map: plateT, roughness: 0.6 }));
  plate.position.set(0, 0.52, -HALF - 0.002);
  plate.rotation.y = Math.PI;
  car.add(plate);

  // mirrors
  for (const sx of [1, -1]) {
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.03, 0.03), black);
    arm.position.set(sx * 0.92, 0.95, 0.62);
    car.add(arm);
    const mir = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.10, 0.16), paint);
    mir.position.set(sx * 1.00, 0.97, 0.60);
    car.add(mir);
  }
  // door handles + side skirts
  for (const sx of [1, -1]) {
    const hdl = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.03, 0.22), chrome);
    hdl.position.set(sx * halfW(0.5) * 1.0, 0.78, 0.25);
    car.add(hdl);
    const skirt = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.09, 2.1), black);
    skirt.position.set(sx * 0.80, 0.16, 0.05);
    car.add(skirt);
  }
  car.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  return { car, wheels, paint };
}

// ---------------------------------------------------------------- physics
export class Vehicle {
  constructor(scene, colliders) {
    const { car, wheels } = buildCarMesh();
    this.mesh = car;
    this.wheels = wheels;
    this.scene = scene;
    this.colliders = colliders;
    scene.add(car);

    this.pos = new THREE.Vector3(-26, 0, 40);   // parked on the apron, in the sun
    this.yaw = 2.1;
    this.vLon = 0;    // m/s along heading
    this.vLat = 0;    // m/s sideways (drift)
    this.yawRate = 0;
    this.steer = 0;
    this.gear = 1;
    this.rpm = 900;
    this.throttle = 0; this.brake = 0; this.handbrake = false;
    this.wheelSpin = 0;
    this.occupied = false;
    this.slip = 0;

    // skid marks
    this.skidMat = new THREE.MeshBasicMaterial({
      color: 0x0c0c0d, transparent: true, opacity: 0.5, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -4,
    });
    this.skids = [];
    this.skidTimer = 0;

    this.GEARS = [3.6, 2.4, 1.7, 1.3, 1.05, 0.88];
    this.FINAL = 3.4;
    this.WHEEL_R = 0.345;
    this._sync();
  }

  get speedKmh() { return Math.abs(this.vLon) * 3.6; }

  setInput(throttle, brake, steerTarget, handbrake) {
    this.throttle = throttle; this.brake = brake; this.handbrake = handbrake;
    const maxSteer = 0.62 / (1 + this.speedKmh / 75);
    const target = steerTarget * maxSteer;
    this.steer += (target - this.steer) * 0.14;
  }

  engineForce() {
    // flat-six-ish torque plateau
    const rpmN = this.rpm / 7200;
    const torque = 480 * (0.55 + 0.65 * Math.sin(Math.min(rpmN, 1) * Math.PI * 0.82));
    return (torque * this.GEARS[this.gear - 1] * this.FINAL / this.WHEEL_R) * this.throttle / 1450;
  }

  update(dt) {
    dt = Math.min(dt, 0.033);
    const grip = this.handbrake ? 2.2 : 7.5;

    // rpm follows wheel speed through the gearbox
    const wheelRpm = Math.abs(this.vLon) / (2 * Math.PI * this.WHEEL_R) * 60;
    this.rpm = Math.max(900, wheelRpm * this.GEARS[this.gear - 1] * this.FINAL);
    if (this.rpm > 7000 && this.gear < 6) { this.gear++; }
    if (this.rpm < 2400 && this.gear > 1) { this.gear--; }
    this.rpm = Math.min(this.rpm, 7400);

    // longitudinal
    let a = this.engineForce() * (this.occupied ? 1 : 0);
    const drag = 0.00042 * this.vLon * Math.abs(this.vLon) * 3.6 * 3.6 + 0.35 * Math.sign(this.vLon);
    a -= drag * 0.09;
    if (this.brake > 0) {
      const dir = Math.sign(this.vLon || 1);
      if (this.vLon * dir > 0.5 || dir > 0) a -= dir * this.brake * 11;
      if (Math.abs(this.vLon) < 0.6 && this.brake > 0) {
        // reverse
        a -= this.brake * 4.5;
      }
    }
    if (this.handbrake) a -= Math.sign(this.vLon) * 6;
    this.vLon += a * dt;
    if (Math.abs(this.vLon) < 0.05 && this.throttle === 0) this.vLon = 0;
    this.vLon = THREE.MathUtils.clamp(this.vLon, -12, 86);

    // steering → yaw; blend kinematic and inertial
    const L = 2.55;
    const targetYawRate = (this.vLon / L) * Math.tan(this.steer);
    const yawResponse = this.handbrake ? 2.2 : 5.5;
    this.yawRate += (targetYawRate - this.yawRate) * Math.min(1, yawResponse * dt);
    this.yaw += this.yawRate * dt;

    // lateral slip: yawing faster than the tyres track creates sideways vel
    this.vLat += (this.yawRate * this.vLon * 0.24 - this.vLat * grip) * dt * 4.5;
    this.slip = Math.abs(this.vLat);

    // integrate position in heading space
    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    this.pos.x += (sin * this.vLon + cos * this.vLat) * dt;
    this.pos.z += (cos * this.vLon - sin * this.vLat) * dt;

    this._collide();
    this._sync(dt);
    this._skids(dt);
  }

  _collide() {
    const r = 1.35;
    for (const box of this.colliders) {
      const cx = THREE.MathUtils.clamp(this.pos.x, box.min.x, box.max.x);
      const cz = THREE.MathUtils.clamp(this.pos.z, box.min.z, box.max.z);
      if (box.min.y > 2.2) continue;
      const dx = this.pos.x - cx, dz = this.pos.z - cz;
      const d2 = dx * dx + dz * dz;
      if (d2 < r * r) {
        const d = Math.sqrt(d2) || 0.001;
        const push = (r - d);
        this.pos.x += (dx / d) * push;
        this.pos.z += (dz / d) * push;
        this.vLon *= 0.55;   // crunch
        this.vLat *= 0.4;
        this.crashSpeed = Math.abs(this.vLon);
      }
    }
    const lim = 1900;
    this.pos.x = THREE.MathUtils.clamp(this.pos.x, -lim, lim);
    this.pos.z = THREE.MathUtils.clamp(this.pos.z, -lim, lim);
  }

  _sync(dt = 0.016) {
    const m = this.mesh;
    m.position.set(this.pos.x, 0, this.pos.z);
    // body attitude from dynamics
    const pitch = THREE.MathUtils.clamp(-this.throttle * 0.018 + this.brake * 0.03 * Math.sign(this.vLon), -0.05, 0.05);
    const roll = THREE.MathUtils.clamp(this.yawRate * this.vLon * 0.0045, -0.07, 0.07);
    m.rotation.set(0, this.yaw, 0);
    m.rotateX(pitch);
    m.rotateZ(roll);

    this.wheelSpin += (this.vLon / this.WHEEL_R) * dt;
    for (const w of this.wheels) {
      if (w.steer) w.pivot.rotation.y = this.steer;
      w.spin.rotation.x = this.wheelSpin;
    }
  }

  _skids(dt) {
    this.skidTimer -= dt;
    if (this.slip > 2.0 && Math.abs(this.vLon) > 4 && this.skidTimer <= 0) {
      this.skidTimer = 0.03;
      const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
      for (const sx of [0.86, -0.86]) {
        const rx = this.pos.x - sin * 1.4 + cos * sx;
        const rz = this.pos.z - cos * 1.4 - sin * sx;
        const q = new THREE.Mesh(new THREE.PlaneGeometry(0.3, 0.8), this.skidMat);
        q.rotation.x = -Math.PI / 2;
        q.rotation.z = -this.yaw;
        q.position.set(rx, 0.06, rz);
        this.scene.add(q);
        this.skids.push({ mesh: q, life: 9 });
      }
      if (this.skids.length > 400) {
        const old = this.skids.splice(0, 2);
        for (const o of old) this.scene.remove(o.mesh);
      }
    }
    for (let i = this.skids.length - 1; i >= 0; i--) {
      const s = this.skids[i];
      s.life -= dt;
      if (s.life < 2) s.mesh.material = this.skidMat;
      if (s.life <= 0) { this.scene.remove(s.mesh); this.skids.splice(i, 1); }
    }
  }
}

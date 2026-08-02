// MK-77 "Phantom" — procedural AR-pattern viewmodel with ADS, recoil,
// tracers, muzzle flash, decals and impact particles.
import * as THREE from 'three';
import { makeMuzzleFlash, makeBulletHole, makeSoftParticle } from './textures.js';

function gunMaterials() {
  return {
    receiver: new THREE.MeshStandardMaterial({ color: 0x3a3f46, roughness: 0.42, metalness: 0.8 }),
    polymer: new THREE.MeshStandardMaterial({ color: 0x43474d, roughness: 0.75, metalness: 0.15 }),
    barrel: new THREE.MeshStandardMaterial({ color: 0x2c3036, roughness: 0.3, metalness: 0.9 }),
    tan: new THREE.MeshStandardMaterial({ color: 0x96835f, roughness: 0.65, metalness: 0.2 }),
    glassRed: new THREE.MeshBasicMaterial({ color: 0xff3326 }),
  };
}

// The viewmodel lives on layer 1 with its own studio-style lighting so it
// always reads crisp regardless of world light, the way AAA shooters do it.
export const VM_LAYER = 1;

// Build a convincing low-poly AR: receiver, rail, handguard w/ M-LOK slots,
// barrel, muzzle device, stock, grip, mag, red-dot sight.
export function buildRifle() {
  const g = new THREE.Group();
  const m = gunMaterials();
  const add = (geo, mat, x, y, z, rx = 0, ry = 0, rz = 0) => {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, y, z);
    mesh.rotation.set(rx, ry, rz);
    g.add(mesh);
    return mesh;
  };
  // -Z is muzzle direction (matches camera forward)
  add(new THREE.BoxGeometry(0.062, 0.075, 0.30), m.receiver, 0, 0, -0.02);        // upper
  add(new THREE.BoxGeometry(0.058, 0.07, 0.16), m.receiver, 0, -0.055, 0.02);     // lower
  add(new THREE.BoxGeometry(0.055, 0.022, 0.46), m.receiver, 0, 0.048, -0.16);    // top rail
  // rail teeth
  for (let i = 0; i < 12; i++) {
    add(new THREE.BoxGeometry(0.057, 0.008, 0.012), m.barrel, 0, 0.062, -0.34 + i * 0.028);
  }
  const hg = add(new THREE.BoxGeometry(0.056, 0.06, 0.30), m.polymer, 0, 0.005, -0.30); // handguard
  // M-LOK slots
  for (let i = 0; i < 4; i++) {
    add(new THREE.BoxGeometry(0.058, 0.014, 0.05), m.barrel, 0, -0.012, -0.21 - i * 0.062);
  }
  add(new THREE.CylinderGeometry(0.014, 0.014, 0.20, 10), m.barrel, 0, 0.005, -0.55, Math.PI / 2); // barrel
  const muzzle = add(new THREE.CylinderGeometry(0.021, 0.023, 0.07, 10), m.barrel, 0, 0.005, -0.645, Math.PI / 2);
  // stock
  add(new THREE.BoxGeometry(0.045, 0.05, 0.17), m.polymer, 0, 0.005, 0.20);
  add(new THREE.BoxGeometry(0.05, 0.11, 0.05), m.polymer, 0, -0.02, 0.29, -0.1);
  // grip
  add(new THREE.BoxGeometry(0.042, 0.11, 0.05), m.polymer, 0, -0.115, 0.075, 0.35);
  // magazine (slight curve via two segments)
  add(new THREE.BoxGeometry(0.048, 0.11, 0.07), m.tan, 0, -0.135, -0.045, 0.12);
  add(new THREE.BoxGeometry(0.048, 0.09, 0.068), m.tan, 0, -0.215, -0.065, 0.3);
  // trigger guard
  add(new THREE.BoxGeometry(0.036, 0.008, 0.09), m.receiver, 0, -0.095, 0.02);
  // charging handle + ejection port
  add(new THREE.BoxGeometry(0.07, 0.018, 0.03), m.barrel, 0, 0.03, 0.10);
  add(new THREE.BoxGeometry(0.004, 0.03, 0.09), m.barrel, 0.033, 0.005, -0.03);
  // red dot sight
  add(new THREE.BoxGeometry(0.045, 0.035, 0.075), m.receiver, 0, 0.085, -0.10);
  const tube = add(new THREE.CylinderGeometry(0.026, 0.03, 0.06, 14), m.polymer, 0, 0.125, -0.10, Math.PI / 2);
  const lens = add(new THREE.CircleGeometry(0.023, 14),
    new THREE.MeshPhysicalMaterial({ color: 0x0a1216, roughness: 0.05, metalness: 0.4, clearcoat: 1, transparent: true, opacity: 0.85 }),
    0, 0.125, -0.128);
  const dot = add(new THREE.CircleGeometry(0.0035, 8), m.glassRed, 0, 0.125, -0.127);
  dot.renderOrder = 5;
  // front sling loop / details
  add(new THREE.BoxGeometry(0.01, 0.02, 0.02), m.barrel, 0.03, -0.03, -0.42);
  g.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.frustumCulled = false; } });
  return { group: g, muzzle, dotSight: dot, tube };
}

const HIP_POS = new THREE.Vector3(0.155, -0.145, -0.34);
const ADS_POS = new THREE.Vector3(0, -0.0905, -0.26);
const HIP_ROT = new THREE.Euler(0, 0.02, 0.015);

export class WeaponSystem {
  constructor(camera, scene, audio) {
    this.camera = camera;
    this.scene = scene;
    this.audio = audio;

    const { group, muzzle } = buildRifle();
    this.rifle = group;
    this.rifle.scale.setScalar(0.72);
    this.muzzleRef = muzzle;
    this.rig = new THREE.Group();       // sway/bob layer
    this.kick = new THREE.Group();      // recoil layer
    this.kick.add(this.rifle);
    this.rig.add(this.kick);
    this.rig.position.copy(HIP_POS);
    this.rig.rotation.copy(HIP_ROT);
    camera.add(this.rig);

    // dedicated viewmodel lighting rig (layer 1 only)
    camera.layers.enable(VM_LAYER);
    this.rifle.traverse((o) => { if (o.isMesh) o.layers.set(VM_LAYER); });
    const vmKey = new THREE.DirectionalLight(0xffdcb2, 2.2);
    vmKey.position.set(0.7, 0.9, 0.4);
    vmKey.target.position.set(0, -0.2, -0.5);
    vmKey.layers.set(VM_LAYER);
    camera.add(vmKey, vmKey.target);
    const vmFill = new THREE.HemisphereLight(0xbdc8e0, 0x5a4a3a, 1.1);
    vmFill.layers.set(VM_LAYER);
    camera.add(vmFill);
    const vmRim = new THREE.DirectionalLight(0xffb070, 1.1);
    vmRim.position.set(-0.8, 0.3, 0.6);
    vmRim.target.position.set(0.1, -0.15, -0.5);
    vmRim.layers.set(VM_LAYER);
    camera.add(vmRim, vmRim.target);

    // arm hint (sleeve + glove suggestion under the stock)
    const sleeve = new THREE.Mesh(
      new THREE.CylinderGeometry(0.045, 0.06, 0.3, 10),
      new THREE.MeshStandardMaterial({ color: 0x4a4636, roughness: 0.9 })
    );
    sleeve.rotation.x = 1.1; sleeve.rotation.z = 0.45;
    sleeve.position.set(0.045, -0.20, 0.13);
    sleeve.frustumCulled = false;
    sleeve.layers.set(VM_LAYER);
    this.rifle.add(sleeve);

    // muzzle flash
    const flashTex = makeMuzzleFlash();
    this.flash = new THREE.Sprite(new THREE.SpriteMaterial({
      map: flashTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0,
    }));
    this.flash.scale.setScalar(0.34);
    this.flash.position.set(0, 0.005, -0.70);
    this.rifle.add(this.flash);
    this.flashLight = new THREE.PointLight(0xffa050, 0, 9, 2);
    this.flashLight.layers.enable(VM_LAYER);
    scene.add(this.flashLight);

    // state
    this.ads = 0;                 // 0 hip → 1 sights
    this.adsHeld = false;
    this.magSize = 30;
    this.ammo = 30;
    this.reserve = 150;
    this.reloading = 0;
    this.fireTimer = 0;
    this.RPM = 780;
    this.recoilPitch = 0; this.recoilYaw = 0;
    this.kickBack = 0;
    this.spread = 0;
    this.bobT = 0;
    this.flashTTL = 0;

    // tracers
    this.tracers = [];
    this.tracerMat = new THREE.MeshBasicMaterial({
      color: 0xffc878, blending: THREE.AdditiveBlending, transparent: true, opacity: 0.9, depthWrite: false,
    });
    this.tracerGeo = new THREE.CylinderGeometry(0.012, 0.012, 1, 5);
    this.tracerGeo.rotateX(Math.PI / 2);
    this.tracerGeo.translate(0, 0, -0.5);

    // decals + particles
    this.decalTex = makeBulletHole();
    this.decals = [];
    this.sparkTex = makeSoftParticle('rgba(255,210,130,1)', 'rgba(255,120,30,0)');
    this.dustTex = makeSoftParticle('rgba(190,160,120,0.8)', 'rgba(190,160,120,0)');
    this.particles = [];

    this.raycaster = new THREE.Raycaster();
  }

  get isAiming() { return this.ads > 0.55; }

  tryReload() {
    if (this.reloading > 0 || this.ammo === this.magSize || this.reserve <= 0) return;
    this.reloading = 2.1;
    this.audio.reload();
  }

  // returns hit info or null; targets = enemy hit-meshes; world = shootables
  fire(targets, world, onHit) {
    if (this.reloading > 0 || this.fireTimer > 0) return false;
    if (this.ammo <= 0) { this.audio.dryFire(); this.fireTimer = 0.18; return false; }
    this.ammo--;
    this.fireTimer = 60 / this.RPM;
    this.audio.gunshot();

    // recoil
    const adsF = 1 - this.ads * 0.45;
    this.recoilPitch += (0.011 + Math.random() * 0.006) * adsF;
    this.recoilYaw += (Math.random() - 0.5) * 0.006 * adsF;
    this.kickBack = Math.min(this.kickBack + 0.035, 0.09);
    this.spread = Math.min(this.spread + 0.011, 0.05);
    this.flashTTL = 0.045;
    this.flash.material.rotation = Math.random() * Math.PI * 2;

    // hitscan from camera with spread
    const spreadNow = (this.isAiming ? 0.15 : 1) * this.spread;
    const dir = new THREE.Vector3(0, 0, -1)
      .applyQuaternion(this.camera.getWorldQuaternion(new THREE.Quaternion()));
    dir.x += (Math.random() - 0.5) * spreadNow;
    dir.y += (Math.random() - 0.5) * spreadNow;
    dir.normalize();
    const origin = this.camera.getWorldPosition(new THREE.Vector3());
    this.raycaster.set(origin, dir);
    this.raycaster.far = 400;

    let hitPoint = origin.clone().addScaledVector(dir, 400);
    let hitNormal = null, hitEnemy = null, hitObject = null;

    const enemyHits = this.raycaster.intersectObjects(targets, true);
    const worldHits = this.raycaster.intersectObjects(world, false);
    const eh = enemyHits[0], wh = worldHits[0];
    if (eh && (!wh || eh.distance < wh.distance)) {
      hitPoint = eh.point;
      hitEnemy = eh.object;
    } else if (wh) {
      hitPoint = wh.point;
      hitNormal = wh.face ? wh.face.normal.clone().transformDirection(wh.object.matrixWorld) : null;
      hitObject = wh.object;
    }

    // tracer from muzzle
    const mzl = new THREE.Vector3();
    this.muzzleRef.getWorldPosition(mzl);
    this._spawnTracer(mzl, hitPoint);

    if (hitEnemy) {
      onHit(hitEnemy, hitPoint, dir);
      this._impact(hitPoint, dir.clone().negate(), true);
    } else if (hitNormal) {
      this._impact(hitPoint, hitNormal, false);
      this._decal(hitPoint, hitNormal, hitObject);
    }
    return true;
  }

  _spawnTracer(from, to) {
    const len = from.distanceTo(to);
    const mesh = new THREE.Mesh(this.tracerGeo, this.tracerMat);
    mesh.position.copy(from);
    mesh.lookAt(to);
    mesh.scale.z = Math.min(6, len);
    this.scene.add(mesh);
    this.tracers.push({ mesh, from: from.clone(), to: to.clone(), t: 0, len });
  }

  _decal(point, normal, obj) {
    if (!obj || obj.geometry?.type === 'PlaneGeometry' && normal.y > 0.9) {
      // ground hit: lay flat
    }
    const d = new THREE.Mesh(
      new THREE.PlaneGeometry(0.14, 0.14),
      new THREE.MeshBasicMaterial({
        map: this.decalTex, transparent: true, depthWrite: false,
        polygonOffset: true, polygonOffsetFactor: -4,
      })
    );
    d.position.copy(point).addScaledVector(normal, 0.012);
    d.lookAt(point.clone().add(normal));
    d.rotation.z = Math.random() * Math.PI * 2;
    this.scene.add(d);
    this.decals.push(d);
    if (this.decals.length > 60) this.scene.remove(this.decals.shift());
  }

  _impact(point, normal, flesh) {
    const n = flesh ? 6 : 9;
    for (let i = 0; i < n; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({
        map: flesh ? this.sparkTex : (Math.random() < 0.5 ? this.sparkTex : this.dustTex),
        color: flesh ? 0xa01818 : 0xffffff,
        blending: flesh ? THREE.NormalBlending : THREE.AdditiveBlending,
        transparent: true, depthWrite: false,
      }));
      s.position.copy(point);
      s.scale.setScalar(flesh ? 0.10 : 0.07 + Math.random() * 0.1);
      const vel = normal.clone().multiplyScalar(2 + Math.random() * 3);
      vel.x += (Math.random() - 0.5) * 3;
      vel.y += Math.random() * 2.5;
      vel.z += (Math.random() - 0.5) * 3;
      this.scene.add(s);
      this.particles.push({ s, vel, life: 0.35 + Math.random() * 0.25 });
    }
    this.audio.impact(flesh);
  }

  update(dt, moveSpeed, grounded) {
    // timers
    this.fireTimer -= dt;
    if (this.reloading > 0) {
      this.reloading -= dt;
      if (this.reloading <= 0) {
        const need = this.magSize - this.ammo;
        const take = Math.min(need, this.reserve);
        this.ammo += take; this.reserve -= take;
      }
    }
    this.flashTTL -= dt;
    this.flash.material.opacity = this.flashTTL > 0 ? 0.95 : 0;
    if (this.flashTTL > 0) {
      const p = new THREE.Vector3();
      this.flash.getWorldPosition(p);
      this.flashLight.position.copy(p);
      this.flashLight.intensity = 26;
    } else this.flashLight.intensity = 0;

    // ADS blend
    const target = this.adsHeld && this.reloading <= 0 ? 1 : 0;
    this.ads += (target - this.ads) * Math.min(1, dt * 11);
    this.rig.position.lerpVectors(HIP_POS, ADS_POS, this.ads);

    // spread decay
    this.spread = Math.max(0.006, this.spread - dt * 0.05);

    // recoil recovery
    this.recoilPitch *= Math.exp(-9 * dt);
    this.recoilYaw *= Math.exp(-9 * dt);
    this.kickBack *= Math.exp(-11 * dt);

    // bob & sway
    this.bobT += dt * (4 + moveSpeed * 1.15);
    const bobAmp = grounded ? Math.min(moveSpeed / 6, 1) * (1 - this.ads * 0.82) : 0;
    const bx = Math.sin(this.bobT) * 0.008 * bobAmp;
    const by = Math.abs(Math.cos(this.bobT)) * 0.007 * bobAmp;
    let reloadDip = 0, reloadRoll = 0;
    if (this.reloading > 0) {
      const k = Math.sin(Math.min(1, (2.1 - this.reloading) / 2.1) * Math.PI);
      reloadDip = k * 0.09;
      reloadRoll = k * 0.5;
    }
    this.kick.position.set(bx, by - reloadDip, this.kickBack);
    this.kick.rotation.set(this.recoilPitch * 1.6, this.recoilYaw, reloadRoll * 0.4 + this.recoilYaw * 2);
    this.rig.rotation.set(
      HIP_ROT.x * (1 - this.ads),
      HIP_ROT.y * (1 - this.ads),
      HIP_ROT.z * (1 - this.ads)
    );

    // tracers fly
    for (let i = this.tracers.length - 1; i >= 0; i--) {
      const t = this.tracers[i];
      t.t += dt * 320 / Math.max(t.len, 1);
      if (t.t >= 1) { this.scene.remove(t.mesh); this.tracers.splice(i, 1); continue; }
      t.mesh.position.lerpVectors(t.from, t.to, t.t);
    }
    // particles
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life -= dt;
      if (p.life <= 0) { this.scene.remove(p.s); this.particles.splice(i, 1); continue; }
      p.vel.y -= 9.8 * dt;
      p.s.position.addScaledVector(p.vel, dt);
      p.s.material.opacity = Math.min(1, p.life * 3);
    }
  }

  // camera pitch/yaw offsets the player controller should apply this frame
  consumeRecoil(dt) {
    return { pitch: this.recoilPitch * dt * 30, yaw: this.recoilYaw * dt * 30 };
  }
}

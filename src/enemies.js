// Hostile garrison: procedurally-built soldiers with a walk cycle, burst-fire
// combat AI, hit reactions and deaths.
import * as THREE from 'three';
import { makeCamo } from './textures.js';

function buildSoldier(camoMat, gearMat, skinMat) {
  const g = new THREE.Group();
  const parts = {};
  const mk = (geo, mat, x, y, z) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    g.add(m);
    return m;
  };
  // torso + plate carrier
  parts.torso = mk(new THREE.BoxGeometry(0.44, 0.56, 0.26), camoMat, 0, 1.24, 0);
  const vest = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.42, 0.3), gearMat);
  vest.position.y = 0.02; vest.castShadow = true;
  parts.torso.add(vest);
  // mag pouches
  for (let i = 0; i < 3; i++) {
    const p = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.12, 0.05), gearMat);
    p.position.set(-0.13 + i * 0.13, -0.08, 0.17);
    parts.torso.add(p);
  }
  // head + helmet
  parts.head = mk(new THREE.BoxGeometry(0.2, 0.22, 0.22), skinMat, 0, 1.68, 0);
  const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.148, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.55), gearMat);
  helmet.position.y = 0.05; helmet.scale.set(1, 0.9, 1.1); helmet.castShadow = true;
  parts.head.add(helmet);
  const goggles = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.05, 0.04),
    new THREE.MeshStandardMaterial({ color: 0x101214, roughness: 0.3 }));
  goggles.position.set(0, 0.02, 0.11);
  parts.head.add(goggles);
  // limbs (pivot at top)
  const limb = (w, l, mat) => {
    const pivot = new THREE.Group();
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, l, w), mat);
    m.position.y = -l / 2;
    m.castShadow = true;
    pivot.add(m);
    return pivot;
  };
  parts.armL = limb(0.13, 0.62, camoMat); parts.armL.position.set(-0.30, 1.46, 0); g.add(parts.armL);
  parts.armR = limb(0.13, 0.62, camoMat); parts.armR.position.set(0.30, 1.46, 0); g.add(parts.armR);
  parts.legL = limb(0.16, 0.94, camoMat); parts.legL.position.set(-0.13, 0.96, 0); g.add(parts.legL);
  parts.legR = limb(0.16, 0.94, camoMat); parts.legR.position.set(0.13, 0.96, 0); g.add(parts.legR);
  // rifle held across
  const rifle = new THREE.Group();
  const recv = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.07, 0.5),
    new THREE.MeshStandardMaterial({ color: 0x1c1e21, roughness: 0.5, metalness: 0.7 }));
  rifle.add(recv);
  const brl = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.3, 8),
    new THREE.MeshStandardMaterial({ color: 0x131518, metalness: 0.8, roughness: 0.4 }));
  brl.rotation.x = Math.PI / 2; brl.position.z = -0.36;
  rifle.add(brl);
  const mag = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.12, 0.06),
    new THREE.MeshStandardMaterial({ color: 0x2a2c22, roughness: 0.6 }));
  mag.position.set(0, -0.09, -0.04);
  rifle.add(mag);
  rifle.position.set(0.06, 1.34, 0.26);
  rifle.rotation.y = -0.12;
  g.add(rifle);
  parts.rifle = rifle;
  parts.muzzle = new THREE.Object3D();
  parts.muzzle.position.set(0, 0, -0.5);
  rifle.add(parts.muzzle);
  return { group: g, parts };
}

export class EnemyManager {
  constructor(scene, world, audio, fx) {
    this.scene = scene;
    this.world = world;
    this.audio = audio;
    this.fx = fx;               // { tracer(from,to), flash(pos), playerHit(dmg,fromPos) }
    this.enemies = [];
    this.killCount = 0;
    this.total = 0;

    // shared materials
    this.camo = new THREE.MeshStandardMaterial({ map: makeCamo().map, roughness: 0.95 });
    this.gear = new THREE.MeshStandardMaterial({ color: 0x3c3a30, roughness: 0.9 });
    this.skin = new THREE.MeshStandardMaterial({ color: 0x8a6a52, roughness: 0.85 });
    this.raycaster = new THREE.Raycaster();
  }

  spawn(x, z, patrolRadius = 12) {
    const { group, parts } = buildSoldier(this.camo, this.gear, this.skin);
    group.position.set(x, 0, z);
    this.scene.add(group);
    const e = {
      group, parts,
      hp: 100,
      state: 'patrol',
      home: new THREE.Vector3(x, 0, z),
      patrolRadius,
      target: new THREE.Vector3(x, 0, z),
      walkT: Math.random() * 10,
      speed: 0,
      fireTimer: 1 + Math.random() * 2,
      burstLeft: 0,
      strafeDir: Math.random() < 0.5 ? 1 : -1,
      strafeTimer: 2 + Math.random() * 2,
      hitFlash: 0,
      dead: false,
      deathT: 0,
      alertT: 0,
    };
    // register hittable meshes → owner lookup
    group.traverse((o) => { if (o.isMesh) o.userData.enemy = e; });
    e.headMesh = parts.head;
    this.enemies.push(e);
    this.total++;
    return e;
  }

  damage(mesh, amount, point) {
    const e = mesh.userData.enemy;
    if (!e || e.dead) return { killed: false, headshot: false };
    let headshot = false;
    let obj = mesh;
    while (obj) { if (obj === e.parts.head) { headshot = true; break; } obj = obj.parent; }
    e.hp -= headshot ? amount * 2.6 : amount;
    e.hitFlash = 0.12;
    if (e.state === 'patrol') { e.state = 'combat'; e.alertT = 0; }
    // alert nearby squadmates
    for (const o of this.enemies) {
      if (!o.dead && o.group.position.distanceTo(e.group.position) < 30) o.state = 'combat';
    }
    if (e.hp <= 0) {
      e.dead = true;
      e.deathT = 0;
      this.killCount++;
      this.audio.enemyDeath();
      return { killed: true, headshot };
    }
    return { killed: false, headshot };
  }

  get hitMeshes() {
    const out = [];
    for (const e of this.enemies) if (!e.dead) out.push(e.group);
    return out;
  }

  aliveCount() { return this.enemies.filter((e) => !e.dead).length; }

  update(dt, playerPos, playerInVehicle, occluders) {
    for (const e of this.enemies) {
      if (e.dead) {
        // fall over, sink slightly, then keep the body around
        e.deathT += dt;
        const k = Math.min(1, e.deathT * 2.2);
        e.group.rotation.x = -k * Math.PI / 2 * 0.96;
        e.group.position.y = -0.12 * k;
        continue;
      }
      e.hitFlash = Math.max(0, e.hitFlash - dt);
      const emis = e.hitFlash > 0 ? 0.55 : 0;
      this.camo.emissive ??= new THREE.Color();
      // per-enemy flash would need per-mesh materials; use scale pulse instead
      e.group.scale.setScalar(1 + e.hitFlash * 0.35);

      const toPlayer = playerPos.clone().sub(e.group.position);
      toPlayer.y = 0;
      const dist = toPlayer.length();

      // vehicle runs enemies over
      if (playerInVehicle && dist < 2.2 && playerInVehicle.speedKmh > 25) {
        this.damage(e.parts.torso, 500, e.group.position);
        continue;
      }

      if (e.state === 'patrol') {
        if (dist < 42) { e.state = 'combat'; this.audio.alert(); }
        // amble between points near home
        const toT = e.target.clone().sub(e.group.position); toT.y = 0;
        if (toT.length() < 1.2) {
          const a = Math.random() * Math.PI * 2;
          e.target.set(
            e.home.x + Math.cos(a) * e.patrolRadius,
            0,
            e.home.z + Math.sin(a) * e.patrolRadius
          );
        } else {
          toT.normalize();
          e.group.position.addScaledVector(toT, dt * 1.5);
          e.speed = 1.5;
          e.group.rotation.y = Math.atan2(toT.x, toT.z);
        }
      } else { // combat
        e.alertT += dt;
        const dir = toPlayer.clone().normalize();
        e.group.rotation.y = Math.atan2(dir.x, dir.z);
        // hold ~18m, strafe
        e.strafeTimer -= dt;
        if (e.strafeTimer < 0) { e.strafeDir *= -1; e.strafeTimer = 1.5 + Math.random() * 2.5; }
        const strafe = new THREE.Vector3(-dir.z, 0, dir.x).multiplyScalar(e.strafeDir);
        const move = new THREE.Vector3();
        if (dist > 24) move.add(dir);
        else if (dist < 12) move.addScaledVector(dir, -1);
        move.addScaledVector(strafe, 0.7);
        if (move.lengthSq() > 0) {
          move.normalize();
          const step = move.multiplyScalar(dt * 3.1);
          const np = e.group.position.clone().add(step);
          let blocked = false;
          for (const box of this.world.colliders) {
            if (np.x > box.min.x - 0.4 && np.x < box.max.x + 0.4 &&
                np.z > box.min.z - 0.4 && np.z < box.max.z + 0.4 && box.min.y < 1.5) { blocked = true; break; }
          }
          if (!blocked) e.group.position.copy(np);
          e.speed = 3.1;
        } else e.speed = 0;

        // fire bursts with LOS check
        e.fireTimer -= dt;
        if (e.fireTimer <= 0 && dist < 70 && e.alertT > 0.55) {
          if (e.burstLeft <= 0) e.burstLeft = 3 + Math.floor(Math.random() * 3);
          const mzl = new THREE.Vector3();
          e.parts.muzzle.getWorldPosition(mzl);
          const aim = playerPos.clone();
          aim.y += playerInVehicle ? 0.4 : -0.15;
          // line of sight
          const ldir = aim.clone().sub(mzl).normalize();
          this.raycaster.set(mzl, ldir);
          this.raycaster.far = dist;
          const blockers = this.raycaster.intersectObjects(occluders, false);
          const clear = !blockers.length || blockers[0].distance > dist - 1.5;
          if (clear) {
            // accuracy falls with range & player speed
            const err = 0.35 + dist * 0.028;
            aim.x += (Math.random() - 0.5) * err;
            aim.y += (Math.random() - 0.5) * err * 0.7;
            aim.z += (Math.random() - 0.5) * err;
            this.fx.tracer(mzl, aim);
            this.fx.flash(mzl);
            this.audio.enemyShot(dist);
            const hitChance = Math.max(0.06, 0.34 - dist * 0.003 - (playerInVehicle ? 0.14 : 0));
            if (Math.random() < hitChance) {
              this.fx.playerHit(playerInVehicle ? 4 : 8 + Math.random() * 6, e.group.position);
            }
          }
          e.burstLeft--;
          e.fireTimer = e.burstLeft > 0 ? 0.11 : 0.9 + Math.random() * 1.6;
        }
      }

      // walk cycle
      e.walkT += dt * (2 + e.speed * 2.4);
      const sw = Math.sin(e.walkT) * Math.min(e.speed / 3, 1) * 0.55;
      e.parts.legL.rotation.x = sw;
      e.parts.legR.rotation.x = -sw;
      e.parts.armL.rotation.x = -sw * 0.5 - 0.45;
      e.parts.armR.rotation.x = sw * 0.5 - 0.55;
      // bob
      e.group.position.y = Math.abs(Math.sin(e.walkT)) * 0.04 * Math.min(e.speed / 3, 1);
    }
  }
}

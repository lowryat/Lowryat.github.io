// BLACKSITE: REDLINE — bootstrap, game loop, player controller, state machine.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { buildWorld } from './world.js';
import { WeaponSystem } from './weapons.js';
import { EnemyManager } from './enemies.js';
import { Vehicle } from './vehicle.js';
import { AudioSystem } from './audio.js';
import { makeMuzzleFlash } from './textures.js';

const $ = (id) => document.getElementById(id);
const isTouch = ('ontouchstart' in window) || navigator.maxTouchPoints > 0;

// ---------------------------------------------------------------- renderer
const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
$('app').appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(74, innerWidth / innerHeight, 0.05, 6000);

// post chain: HDR render → bloom → grade (vignette/grain/contrast) → tonemap
const rt = new THREE.WebGLRenderTarget(innerWidth, innerHeight, {
  samples: 4, type: THREE.HalfFloatType,
});
const composer = new EffectComposer(renderer, rt);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.50, 0.65, 0.75);
composer.addPass(bloom);
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    time: { value: 0 },
    hurt: { value: 0 },
  },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse; uniform float time; uniform float hurt;
    varying vec2 vUv;
    float hash(vec2 p){ return fract(sin(dot(p,vec2(12.9898,78.233)))*43758.5453); }
    void main(){
      vec2 uv = vUv;
      vec3 c = texture2D(tDiffuse, uv).rgb;
      // gentle warm-in-highlights / cool-in-shadows grade
      float l = dot(c, vec3(0.299,0.587,0.114));
      c += (vec3(0.045,0.012,-0.03) * smoothstep(0.35,0.95,l));
      c += (vec3(-0.012,0.0,0.028) * (1.0-smoothstep(0.05,0.5,l)));
      // filmic contrast + slight saturation
      c = mix(vec3(l), c, 1.12);
      c = (c - 0.5) * 1.045 + 0.5;
      // vignette
      float d = distance(uv, vec2(0.5));
      c *= 1.0 - smoothstep(0.42, 0.92, d) * 0.42;
      // hurt tint
      c = mix(c, vec3(0.45,0.03,0.02), hurt * smoothstep(0.25, 0.85, d));
      // film grain
      c += (hash(uv * vec2(1920.0,1080.0) + fract(time)) - 0.5) * 0.028;
      gl_FragColor = vec4(c, 1.0);
    }`,
};
const gradePass = new ShaderPass(GradeShader);
composer.addPass(gradePass);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.25;
composer.addPass(new OutputPass());

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  composer.setSize(innerWidth, innerHeight);
});

// ---------------------------------------------------------------- world & actors
const audio = new AudioSystem();
const world = buildWorld(scene, renderer);
const vehicle = new Vehicle(scene, world.colliders);

// player rig: yaw object → pitch object → camera
const yawObj = new THREE.Object3D();
const pitchObj = new THREE.Object3D();
yawObj.add(pitchObj);
pitchObj.add(camera);
scene.add(yawObj);
const EYE = 1.68;
yawObj.position.set(24, 0, 52);
yawObj.rotation.y = 2.6;

const weapons = new WeaponSystem(camera, scene, audio);

// enemy fx bridge
const enemyFlashTex = makeMuzzleFlash();
const enemyFx = {
  tracer(from, to) { weapons._spawnTracer(from, to); },
  flash(pos) {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({
      map: enemyFlashTex, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false,
    }));
    s.position.copy(pos);
    s.scale.setScalar(0.5);
    scene.add(s);
    setTimeout(() => scene.remove(s), 55);
  },
  playerHit(dmg) { damagePlayer(dmg); },
};
const enemies = new EnemyManager(scene, world, audio, enemyFx);

// garrison placement
const enemySpawns = [
  [10, -10], [-20, 10], [30, 2], [-40, -20], [16, 30], [-6, -30],
  [48, -20], [-30, 34], [4, 14], [58, 10], [-52, 6], [24, -32],
];
for (const [x, z] of enemySpawns) enemies.spawn(x, z);

// ---------------------------------------------------------------- state
const S = { BOOT: 0, MENU: 1, FOOT: 2, DRIVE: 3, DEAD: 4 };
let state = S.BOOT;
let health = 100;
let lastDamageAt = -99;
let hurtLevel = 0;
let velY = 0;
let grounded = true;
const keys = {};
let mouseDown = false;
let time = 0;
let locked = false;
let debugNoLock = false;

// ---------------------------------------------------------------- input
addEventListener('keydown', (e) => {
  keys[e.code] = true;
  if (e.code === 'KeyR' && state === S.FOOT) weapons.tryReload();
  if (e.code === 'KeyF') tryToggleVehicle();
  if (e.code === 'Space' && state === S.DEAD) respawn();
  if (e.code === 'Space' && state === S.FOOT) e.preventDefault();
});
addEventListener('keyup', (e) => { keys[e.code] = false; });
addEventListener('mousedown', (e) => {
  if (e.button === 0) mouseDown = true;
  if (e.button === 2) weapons.adsHeld = true;
});
addEventListener('mouseup', (e) => {
  if (e.button === 0) mouseDown = false;
  if (e.button === 2) weapons.adsHeld = false;
});
addEventListener('contextmenu', (e) => e.preventDefault());

document.addEventListener('pointerlockchange', () => {
  locked = document.pointerLockElement === renderer.domElement;
  if (!locked && (state === S.FOOT || state === S.DRIVE) && !debugNoLock && !isTouch) showMenu(true);
});
addEventListener('mousemove', (e) => {
  if (!locked || state === S.DEAD) return;
  const sens = 0.0021 * (1 - weapons.ads * 0.55);
  yawObj.rotation.y -= e.movementX * sens;
  pitchObj.rotation.x -= e.movementY * sens;
  pitchObj.rotation.x = THREE.MathUtils.clamp(pitchObj.rotation.x, -1.45, 1.45);
});

// ---------------------------------------------------------------- touch controls (iPhone/mobile)
const touchAxis = { x: 0, y: 0 };   // left joystick, -1..1 each axis
let touchLookDX = 0, touchLookDY = 0; // accumulated right-side drag, consumed once per frame

if (isTouch) {
  const joyBase = $('tJoyBase'), joyStick = $('tJoyStick');
  const JOY_R = 60;
  let joyPointerId = null, joyCenter = { x: 0, y: 0 };
  const joyReset = () => { touchAxis.x = 0; touchAxis.y = 0; joyStick.style.transform = 'translate(0,0)'; };
  const joyUpdate = (e) => {
    let dx = e.clientX - joyCenter.x, dy = e.clientY - joyCenter.y;
    const d = Math.hypot(dx, dy);
    if (d > JOY_R) { dx = (dx / d) * JOY_R; dy = (dy / d) * JOY_R; }
    touchAxis.x = dx / JOY_R; touchAxis.y = dy / JOY_R;
    joyStick.style.transform = `translate(${dx}px, ${dy}px)`;
  };
  joyBase.addEventListener('pointerdown', (e) => {
    joyPointerId = e.pointerId;
    const r = joyBase.getBoundingClientRect();
    joyCenter = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    try { joyBase.setPointerCapture(e.pointerId); } catch { /* no active pointer session */ }
    joyUpdate(e);
  });
  joyBase.addEventListener('pointermove', (e) => { if (e.pointerId === joyPointerId) joyUpdate(e); });
  const joyEnd = (e) => { if (e.pointerId === joyPointerId) { joyPointerId = null; joyReset(); } };
  joyBase.addEventListener('pointerup', joyEnd);
  joyBase.addEventListener('pointercancel', joyEnd);

  const lookZone = $('tLook');
  let lookPointerId = null, lastLookX = 0, lastLookY = 0;
  lookZone.addEventListener('pointerdown', (e) => {
    lookPointerId = e.pointerId;
    lastLookX = e.clientX; lastLookY = e.clientY;
    try { lookZone.setPointerCapture(e.pointerId); } catch { /* no active pointer session */ }
  });
  lookZone.addEventListener('pointermove', (e) => {
    if (e.pointerId !== lookPointerId) return;
    touchLookDX += e.clientX - lastLookX;
    touchLookDY += e.clientY - lastLookY;
    lastLookX = e.clientX; lastLookY = e.clientY;
  });
  const lookEnd = (e) => { if (e.pointerId === lookPointerId) lookPointerId = null; };
  lookZone.addEventListener('pointerup', lookEnd);
  lookZone.addEventListener('pointercancel', lookEnd);

  const bindHold = (el, onDown, onUp) => {
    el.addEventListener('pointerdown', (e) => { e.preventDefault(); onDown(); el.classList.add('active'); });
    const up = () => { onUp && onUp(); el.classList.remove('active'); };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };
  bindHold($('tFire'), () => { mouseDown = true; }, () => { mouseDown = false; });
  bindHold($('tADS'), () => { weapons.adsHeld = true; }, () => { weapons.adsHeld = false; });
  bindHold($('tJump'), () => { keys['Space'] = true; }, () => { keys['Space'] = false; });
  bindHold($('tHandbrake'), () => { keys['Space'] = true; }, () => { keys['Space'] = false; });
  $('tReload').addEventListener('pointerdown', (e) => { e.preventDefault(); if (state === S.FOOT) weapons.tryReload(); });
  $('tInteract').addEventListener('pointerdown', (e) => { e.preventDefault(); tryToggleVehicle(); });
  $('tCam').addEventListener('pointerdown', (e) => { e.preventDefault(); camMode = 1 - camMode; });
  $('death').addEventListener('pointerdown', () => { if (state === S.DEAD) respawn(); });

  // swap menu control hints for touch instructions
  const ctrls = document.querySelector('#menu .ctrls');
  if (ctrls) {
    ctrls.innerHTML =
      '<div><b>LEFT STICK</b> Move / Steer &nbsp;·&nbsp; <b>DRAG RIGHT</b> Look</div>' +
      '<div><b>FIRE</b> Shoot &nbsp;·&nbsp; <b>ADS</b> Aim &nbsp;·&nbsp; <b>JUMP</b> Jump &nbsp;·&nbsp; <b>RLD</b> Reload</div>' +
      '<div>Tap <b>ENTER VEHICLE</b> near the car &nbsp;·&nbsp; <b>E-BRK</b> Drift &nbsp;·&nbsp; <b>CAM</b> Toggle view</div>';
  }
  $('deathHint').textContent = 'Viper 2-1 is down — tap to redeploy';
}

function updateTouchVisibility() {
  if (!isTouch) return;
  $('touch').classList.toggle('on', state === S.FOOT || state === S.DRIVE);
  $('tFire').classList.toggle('hidden', state !== S.FOOT);
  $('tADS').classList.toggle('hidden', state !== S.FOOT);
  $('tJump').classList.toggle('hidden', state !== S.FOOT);
  $('tReload').classList.toggle('hidden', state !== S.FOOT);
  $('tHandbrake').classList.toggle('hidden', state !== S.DRIVE);
  $('tCam').classList.toggle('hidden', state !== S.DRIVE);
  const nearCar = state === S.FOOT
    ? yawObj.position.distanceTo(vehicle.pos) < 3.6
    : state === S.DRIVE && Math.abs(vehicle.vLon) < 3;
  $('tInteract').classList.toggle('hidden', !nearCar);
  $('tInteract').textContent = state === S.DRIVE ? 'EXIT VEHICLE' : 'ENTER VEHICLE';
}

// ---------------------------------------------------------------- HUD helpers
const hud = {
  ammoCur: $('ammoCur'), ammoRes: $('ammoRes'), health: document.querySelector('#healthbar i'),
  cross: $('cross'), hitmark: $('hitmark'), dmg: $('dmg'), objCount: $('objCount'),
  interact: $('interact'), drive: $('drive'), speed: $('speed'), gear: $('gear'),
  rpm: document.querySelector('#rpmbar i'), compass: $('compass'), killfeed: $('killfeed'),
  bigmsg: $('bigmsg'), reloadhint: $('reloadhint'), fps: $('fps'),
};
// build compass strip
{
  const marks = [];
  const cards = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' };
  for (let rep = 0; rep < 3; rep++) {
    for (let a = 0; a < 360; a += 15) {
      marks.push(cards[a] ? `<span class="card">${cards[a]}</span>` : `<span>${a}</span>`);
    }
  }
  hud.compass.innerHTML = marks.join('');
}
let hitmarkTTL = 0;

function killfeedAdd(text) {
  const div = document.createElement('div');
  div.innerHTML = text;
  hud.killfeed.prepend(div);
  while (hud.killfeed.children.length > 5) hud.killfeed.lastChild.remove();
  setTimeout(() => div.remove(), 5000);
}

function bigMessage(text, ms = 2600) {
  hud.bigmsg.textContent = text;
  hud.bigmsg.style.opacity = 1;
  clearTimeout(bigMessage._t);
  bigMessage._t = setTimeout(() => { hud.bigmsg.style.opacity = 0; }, ms);
}

function damagePlayer(dmg) {
  if (state === S.DEAD || state === S.BOOT || state === S.MENU) return;
  health -= dmg;
  lastDamageAt = time;
  hurtLevel = Math.min(1, hurtLevel + dmg / 45);
  audio.playerHurt();
  if (health <= 0) {
    health = 0;
    state = S.DEAD;
    $('death').classList.add('on');
    if (!debugNoLock) document.exitPointerLock();
  }
}

function respawn() {
  $('death').classList.remove('on');
  health = 100; hurtLevel = 0;
  yawObj.position.set(24, 0, 52);
  yawObj.rotation.y = 2.6;
  pitchObj.rotation.x = 0;
  weapons.ammo = 30; weapons.reserve = 150;
  state = S.FOOT;
  if (!debugNoLock && !isTouch) renderer.domElement.requestPointerLock();
}

// ---------------------------------------------------------------- vehicle enter/exit
let camMode = 0; // 0 chase, 1 hood
addEventListener('keydown', (e) => { if (e.code === 'KeyC' && state === S.DRIVE) camMode = 1 - camMode; });

function tryToggleVehicle() {
  if (state === S.FOOT) {
    const d = yawObj.position.distanceTo(vehicle.pos);
    if (d < 3.6) {
      state = S.DRIVE;
      vehicle.occupied = true;
      weapons.rig.visible = false;
      hud.drive.classList.remove('hidden');
      hud.cross.style.display = 'none';
      audio.carDoor();
      audio.startEngine();
    }
  } else if (state === S.DRIVE && Math.abs(vehicle.vLon) < 3) {
    state = S.FOOT;
    vehicle.occupied = false;
    weapons.rig.visible = true;
    hud.drive.classList.add('hidden');
    hud.cross.style.display = '';
    audio.carDoor();
    audio.setEngine(900, 0, false);
    // step out on the left
    const side = new THREE.Vector3(Math.cos(vehicle.yaw), 0, -Math.sin(vehicle.yaw));
    yawObj.position.copy(vehicle.pos).addScaledVector(side, 2.2);
    yawObj.position.y = 0;
    yawObj.rotation.y = vehicle.yaw;
    pitchObj.rotation.x = 0;
  }
}

// ---------------------------------------------------------------- player movement
const moveVec = new THREE.Vector3();
function updateFoot(dt) {
  const touchMag = Math.hypot(touchAxis.x, touchAxis.y);
  const sprint = (keys['ShiftLeft'] || touchMag > 0.85) && !weapons.isAiming;
  const speed = sprint ? 7.2 : 4.4;
  moveVec.set(
    (keys['KeyD'] ? 1 : 0) - (keys['KeyA'] ? 1 : 0) + touchAxis.x,
    0,
    (keys['KeyS'] ? 1 : 0) - (keys['KeyW'] ? 1 : 0) + touchAxis.y
  );
  const moving = moveVec.lengthSq() > 0;
  if (moving) moveVec.normalize().applyAxisAngle(new THREE.Vector3(0, 1, 0), yawObj.rotation.y);
  const p = yawObj.position;
  const step = moveVec.multiplyScalar(speed * dt);
  // resolve x and z separately for wall sliding
  const R = 0.42;
  const tryMove = (dx, dz) => {
    const nx = p.x + dx, nz = p.z + dz;
    for (const box of world.colliders) {
      if (box.min.y > p.y + 1.6 || box.max.y < p.y + 0.2) continue;
      if (nx > box.min.x - R && nx < box.max.x + R && nz > box.min.z - R && nz < box.max.z + R) return false;
    }
    p.x = nx; p.z = nz;
    return true;
  };
  if (!tryMove(step.x, step.z)) { tryMove(step.x, 0) || tryMove(0, step.z); }

  // gravity & jump
  if (grounded && keys['Space']) { velY = 4.6; grounded = false; }
  velY -= 13 * dt;
  p.y += velY * dt;
  if (p.y <= 0) { p.y = 0; velY = 0; grounded = true; }

  // footsteps
  if (moving && grounded) {
    updateFoot._stepT = (updateFoot._stepT || 0) + dt * (sprint ? 2.6 : 1.8);
    if (updateFoot._stepT > 1) { updateFoot._stepT = 0; audio.footstep(); }
  }

  // head position + subtle breathing/bob
  const bobY = moving && grounded ? Math.abs(Math.sin(time * (sprint ? 11 : 8))) * 0.045 : 0;
  camera.position.set(0, 0, 0);
  pitchObj.position.y = EYE + bobY + Math.sin(time * 1.7) * 0.006;

  // shooting
  if (mouseDown && (locked || isTouch)) {
    weapons.fire(enemies.hitMeshes, world.shootables, (mesh, point) => {
      const res = enemies.damage(mesh, 34, point);
      hitmarkTTL = 0.22;
      hud.hitmark.classList.toggle('kill', res.killed);
      if (res.killed) {
        audio.killConfirm();
        killfeedAdd(`<b>VIPER 2-1</b> ${res.headshot ? '⌖ headshot' : '☠'} Hostile`);
        hud.objCount.textContent = `${enemies.killCount} / ${enemies.total}`;
        if (enemies.aliveCount() === 0) bigMessage('AREA SECURE — RIDGE CLEARED', 4200);
      } else audio.hitmarker();
    });
  }

  const rec = weapons.consumeRecoil(dt);
  pitchObj.rotation.x = THREE.MathUtils.clamp(pitchObj.rotation.x + rec.pitch, -1.45, 1.45);
  yawObj.rotation.y += rec.yaw;

  // ADS FOV
  const targetFov = 74 - weapons.ads * 24;
  camera.fov += (targetFov - camera.fov) * Math.min(1, dt * 12);
  camera.updateProjectionMatrix();

  // interact prompt
  const nearCar = yawObj.position.distanceTo(vehicle.pos) < 3.6;
  hud.interact.classList.toggle('hidden', !nearCar);

  weapons.update(dt, moving ? speed : 0, grounded);
}

// ---------------------------------------------------------------- driving
const camPos = new THREE.Vector3();
const camLook = new THREE.Vector3();
let debugDrive = null;
function updateDrive(dt) {
  const throttle = debugDrive ? debugDrive.throttle : Math.min(1, Math.max(keys['KeyW'] ? 1 : 0, -touchAxis.y));
  const brake = debugDrive ? (debugDrive.brake || 0) : Math.min(1, Math.max(keys['KeyS'] ? 1 : 0, touchAxis.y));
  const steer = debugDrive ? (debugDrive.steer || 0)
    : Math.max(-1, Math.min(1, (keys['KeyA'] ? 1 : 0) - (keys['KeyD'] ? 1 : 0) - touchAxis.x));
  vehicle.setInput(throttle, brake, steer, !!keys['Space']);
  vehicle.update(dt);
  if (vehicle.crashSpeed) { audio.crash(vehicle.crashSpeed); vehicle.crashSpeed = 0; }

  audio.setEngine(vehicle.rpm, throttle, true);
  audio.skid(vehicle.slip > 2 && Math.abs(vehicle.vLon) > 4 ? vehicle.slip * 0.05 : 0);

  // chase camera
  const back = camMode === 0 ? 6.4 : 0.4;
  const up = camMode === 0 ? 2.35 : 1.12;
  const sin = Math.sin(vehicle.yaw), cos = Math.cos(vehicle.yaw);
  camPos.set(
    vehicle.pos.x - sin * back,
    up + Math.abs(vehicle.vLon) * 0.004,
    vehicle.pos.z - cos * back
  );
  const stiff = camMode === 0 ? 5.5 : 30;
  camera.parent.getWorldPosition(camLook); // reuse
  yawObj.position.lerp(camPos, Math.min(1, dt * stiff));
  yawObj.position.y = camPos.y; // no lag vertically
  camLook.set(vehicle.pos.x + sin * 6, 1.0, vehicle.pos.z + cos * 6);
  // aim the rig at the lookahead point
  const m = new THREE.Matrix4().lookAt(yawObj.position, camLook, new THREE.Vector3(0, 1, 0));
  const q = new THREE.Quaternion().setFromRotationMatrix(m);
  yawObj.quaternion.slerp(q, Math.min(1, dt * (camMode === 0 ? 6 : 20)));
  pitchObj.rotation.x = 0;
  pitchObj.position.y = 0;

  // speed FOV
  const targetFov = 72 + Math.min(vehicle.speedKmh * 0.14, 24);
  camera.fov += (targetFov - camera.fov) * Math.min(1, dt * 5);
  camera.updateProjectionMatrix();

  // HUD
  hud.speed.innerHTML = `${Math.round(vehicle.speedKmh)}<small> KM/H</small>`;
  hud.gear.textContent = vehicle.vLon < -0.5 ? 'GEAR R' : `GEAR ${vehicle.gear}`;
  hud.rpm.style.width = `${(vehicle.rpm / 7400) * 100}%`;
  hud.rpm.style.background = vehicle.rpm > 6600 ? 'var(--hud-red)' : 'var(--hud-amber)';
  hud.interact.classList.toggle('hidden', !(Math.abs(vehicle.vLon) < 3));
}

// ---------------------------------------------------------------- HUD frame update
function updateHUD(dt) {
  hud.ammoCur.textContent = weapons.ammo;
  hud.ammoRes.textContent = weapons.reserve;
  hud.reloadhint.style.opacity = (weapons.ammo === 0 && weapons.reloading <= 0) ? 1 : 0;
  hud.health.style.width = `${health}%`;
  hud.health.style.background = health < 35 ? 'var(--hud-red)' : 'var(--hud-white)';
  hud.cross.classList.toggle('ads', weapons.isAiming);
  hitmarkTTL -= dt;
  hud.hitmark.style.opacity = hitmarkTTL > 0 ? 1 : 0;
  hurtLevel = Math.max(0, hurtLevel - dt * 0.8);
  const lowHp = health < 40 ? (0.5 - health / 100) * (0.7 + 0.3 * Math.sin(time * 6)) : 0;
  hud.dmg.style.opacity = Math.min(1, hurtLevel + lowHp);
  gradePass.uniforms.hurt.value = Math.min(0.7, hurtLevel * 0.7 + lowHp * 0.5);
  // health regen
  if (health > 0 && health < 100 && time - lastDamageAt > 4.2) {
    health = Math.min(100, health + dt * 22);
  }
  // compass: heading from camera yaw
  const heading = ((-yawObj.rotation.y) * 180 / Math.PI % 360 + 360) % 360;
  const stripW = 24 * 60; // one 360° band
  hud.compass.style.left = `${170 - (heading / 15) * 60 - stripW}px`;
}

// ---------------------------------------------------------------- boot / menu
function showMenu(fromPause = false) {
  state = S.MENU;
  $('menu').classList.remove('hidden');
  $('menu').classList.remove('fade');
  $('hud').classList.remove('on');
}

function startGame(freeDrive = false) {
  audio.ensure();
  $('menu').classList.add('fade');
  $('hud').classList.add('on');
  state = S.FOOT;
  if (!debugNoLock && !isTouch) renderer.domElement.requestPointerLock();
  if (freeDrive) {
    yawObj.position.set(vehicle.pos.x + 2.5, 0, vehicle.pos.z);
    setTimeout(() => tryToggleVehicle(), 50);
  } else {
    bigMessage('ELIMINATE THE GARRISON — 12 HOSTILES', 3800);
  }
}

$('btnPlay').addEventListener('click', () => startGame(false));
$('btnFree').addEventListener('click', () => startGame(true));

// fake boot sequence
{
  let p = 0;
  const iv = setInterval(() => {
    p += 8 + Math.random() * 18;
    $('bootbar').style.width = `${Math.min(100, p)}%`;
    if (p >= 100) {
      clearInterval(iv);
      $('boot').classList.add('fade');
      showMenu();
      // menu camera slowly orbits the car
      state = S.MENU;
    }
  }, 90);
}

// ---------------------------------------------------------------- loop
let last = performance.now();
let fpsAcc = 0, fpsN = 0, fpsT = 0;
const focus = new THREE.Vector3();

function menuCamera(dt) {
  // slow cinematic orbit around the hangar car
  const t = time * 0.12;
  const r = 8.5;
  yawObj.position.set(
    vehicle.pos.x + Math.sin(t) * r,
    2.1 + Math.sin(time * 0.3) * 0.3,
    vehicle.pos.z + Math.cos(t) * r
  );
  const m = new THREE.Matrix4().lookAt(
    yawObj.position,
    new THREE.Vector3(vehicle.pos.x, 0.8, vehicle.pos.z),
    new THREE.Vector3(0, 1, 0)
  );
  yawObj.quaternion.setFromRotationMatrix(m);
  pitchObj.rotation.x = 0;
  pitchObj.position.y = 0;
}

function frame() {
  requestAnimationFrame(frame);
  const now = performance.now();
  let dt = Math.min((now - last) / 1000, 0.05);
  last = now;
  time += dt;

  weapons.rig.visible = state === S.FOOT;

  if (isTouch && (touchLookDX || touchLookDY) && (state === S.FOOT || state === S.DRIVE)) {
    const sens = 0.0032 * (1 - weapons.ads * 0.55);
    yawObj.rotation.y -= touchLookDX * sens;
    pitchObj.rotation.x -= touchLookDY * sens;
    pitchObj.rotation.x = THREE.MathUtils.clamp(pitchObj.rotation.x, -1.45, 1.45);
    touchLookDX = 0; touchLookDY = 0;
  }

  if (state === S.MENU || state === S.BOOT) menuCamera(dt);
  else if (state === S.FOOT) updateFoot(dt);
  else if (state === S.DRIVE) updateDrive(dt);
  updateTouchVisibility();

  if (state === S.FOOT || state === S.DRIVE || state === S.DEAD) {
    focus.copy(state === S.DRIVE ? vehicle.pos : yawObj.position);
    enemies.update(dt, state === S.DRIVE
      ? vehicle.pos.clone().setY(1)
      : yawObj.position.clone().setY(EYE), state === S.DRIVE ? vehicle : null, world.shootables);
    updateHUD(dt);
  } else {
    focus.copy(vehicle.pos);
  }
  if (state !== S.DRIVE) vehicle.update(dt * 0); // keep pose synced when parked
  world.update(dt, focus);
  gradePass.uniforms.time.value = time;

  composer.render();

  fpsAcc += dt; fpsN++; fpsT += dt;
  if (fpsT > 0.5) {
    hud.fps.textContent = `${Math.round(fpsN / fpsAcc)} FPS`;
    fpsAcc = 0; fpsN = 0; fpsT = 0;
  }
}
frame();

// ---------------------------------------------------------------- debug hooks (screenshot rig)
window.__game = {
  scene, camera, yawObj, pitchObj, vehicle, weapons, enemies, world,
  start(noLock = true) {
    debugNoLock = noLock;
    startGame(false);
  },
  startDrive() {
    debugNoLock = true;
    startGame(true);
  },
  setPose(x, y, z, yaw, pitch) {
    yawObj.position.set(x, y, z);
    yawObj.rotation.set(0, yaw, 0);
    yawObj.quaternion.setFromEuler(yawObj.rotation);
    pitchObj.rotation.x = pitch;
  },
  // place camera at (cx,cy,cz) looking at (tx,ty,tz) — accounts for -Z forward
  lookFrom(cx, cy, cz, tx, ty, tz) {
    yawObj.position.set(cx, 0, cz);
    pitchObj.position.y = cy;
    const dx = tx - cx, dy = ty - cy, dz = tz - cz;
    const yaw = Math.atan2(-dx, -dz);
    yawObj.rotation.set(0, yaw, 0);
    yawObj.quaternion.setFromEuler(yawObj.rotation);
    pitchObj.rotation.x = Math.atan2(dy, Math.hypot(dx, dz));
  },
  driveInput(input) { debugDrive = input; },
  setCar(x, z, yaw) {
    vehicle.pos.set(x, 0, z);
    vehicle.yaw = yaw;
    vehicle._sync();
  },
  setState(s) { state = S[s]; },
  ads(v) { weapons.adsHeld = v; },
  fire() {
    weapons.fireTimer = 0;
    weapons.fire(enemies.hitMeshes, world.shootables, () => {});
  },
  hud(on) { $('hud').classList.toggle('on', on); },
  hideMenus() {
    $('menu').classList.add('fade');
    $('boot').classList.add('fade');
  },
};

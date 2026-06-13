import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js';

const socket = io();

const dom = {
  scene: document.getElementById('scene'),
  overlay: document.getElementById('overlay'),
  overlayMsg: document.getElementById('overlay-msg'),
  panel: document.querySelector('.panel'),
  hudTurn: document.getElementById('hud-turn'),
  hudRoom: document.getElementById('hud-room'),
  windArrow: document.getElementById('wind-arrow'),
  windMag: document.getElementById('wind-mag'),
  teams: document.getElementById('teams'),
  log: document.getElementById('log'),
  weapons: document.getElementById('weapons'),
  angle: document.getElementById('angle'),
  power: document.getElementById('power'),
  angleVal: document.getElementById('angle-val'),
  powerVal: document.getElementById('power-val'),
  fireBtn: document.getElementById('fire-btn'),
  fuelFill: document.getElementById('fuel-fill'),
  driveLeft: document.getElementById('drive-left'),
  driveRight: document.getElementById('drive-right'),
};

const state = {
  youId: null,
  mode: null,
  world: null,
  heightmap: null,
  tanks: [],
  wind: 0,
  activePlayerId: null,
  pickups: [],
  weaponDefs: null,
  currentWeapon: 'standard',
  gameOver: false,
  moveRange: 44,
};

let selectedMode = '1v1';
let anim = null;
let pending = null;

const TERRAIN_DEPTH = 30;
const BASE_Y = -70;        // bottom of the terrain slab (fills the lower screen)
const STEP_RATE = 90;      // trajectory steps per second
const BOOM_TIME = 0.5;     // explosion seconds
const VIEW_WIDTH = 250;    // ortho world units across at zoom 1
const TURRET_Y = 4.4;
const MOVE_SPEED = 22;     // world units / second while driving
const POWER_PER_UNIT = 1.4;

// Mirror of the server projectile integrator, used for the live aim preview.
const PHYS = { GRAVITY: 0.06, POWER_SCALE: 0.05, WIND_SCALE: 0.0008 };
const BARREL_LEN = 5;

let focusX = 120;
let camX = 120;
let targetZoom = 1;
let shake = 0;

// driving prediction (active local player)
let driveDir = 0;
let localTargetX = 0;
let localFuel = 0;
let lastMoveEmit = 0;

const WEAPON_FX = {
  standard: { proj: 0xffb030, boom: 0xff8a2a },
  sniper:   { proj: 0x9fe8ff, boom: 0xbfefff },
  big_bomb: { proj: 0xff5a2a, boom: 0xff6a2a },
  triple:   { proj: 0xffd24a, boom: 0xffd24a },
  cluster:  { proj: 0xff5ad2, boom: 0xff7ad2 },
  roller:   { proj: 0x8aff6a, boom: 0x9aff7a },
};

// --- renderer / scene ---
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.domElement.style.touchAction = 'none';
dom.scene.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = makeSky();
scene.fog = new THREE.Fog(0xbcd4ee, 320, 640);

const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 1400);
const CAM_OFFSET = new THREE.Vector3(0, 60, 240);
const CAM_TARGET_Y = 26;

const hemi = new THREE.HemisphereLight(0xdcecff, 0x52623f, 0.85);
scene.add(hemi);

const sun = new THREE.DirectionalLight(0xfff2d8, 1.15);
sun.position.set(150, 230, 180);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -160;
sun.shadow.camera.right = 160;
sun.shadow.camera.top = 150;
sun.shadow.camera.bottom = -60;
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 700;
sun.shadow.bias = -0.0004;
scene.add(sun);
scene.add(sun.target);

const clock = new THREE.Clock();

// backdrop (sky furniture that tracks the camera so the view is always full)
const backdrop = new THREE.Group();
const clouds = [];
scene.add(backdrop);
buildBackdrop();

let terrainMesh = null;
const tankMeshes = new Map();
const pickupMeshes = new Map();

// --- real tank model (CC0, loaded once then cloned + team-tinted per tank) ---
let tankProto = null;
let protoAlignY = 0;
let protoScale = 1;
const TARGET_LEN = 15;
new GLTFLoader().load('models/tank.glb', (gltf) => {
  const m = gltf.scene;
  const box = new THREE.Box3().setFromObject(m);
  const size = new THREE.Vector3();
  box.getSize(size);
  protoAlignY = size.z > size.x ? Math.PI / 2 : 0;       // lay the hull length along X (side profile)
  const lengthX = protoAlignY ? size.z : size.x;
  protoScale = TARGET_LEN / (lengthX || 1);
  tankProto = m;
  // rebuild any tanks that were created with the procedural placeholder
  for (const tank of state.tanks) {
    const ref = tankMeshes.get(tank.id);
    if (ref && ref.kind === 'proc') {
      scene.remove(ref.group);
      tankMeshes.delete(tank.id);
      buildTank(tank);
    }
  }
}, undefined, (err) => console.warn('Tank model failed to load — using procedural tanks.', err));

// projectile
const projMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, emissive: 0xffb030, emissiveIntensity: 1.4, roughness: 0.4 });
const projectileMesh = new THREE.Mesh(new THREE.SphereGeometry(1.7, 16, 16), projMat);
projectileMesh.castShadow = true;
projectileMesh.visible = false;
const projLight = new THREE.PointLight(0xffaa33, 0, 70);
projectileMesh.add(projLight);
scene.add(projectileMesh);

const trail = new THREE.Line(
  new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
  new THREE.LineBasicMaterial({ color: 0xffcc66, transparent: true, opacity: 0.65 })
);
trail.visible = false;
scene.add(trail);
let trailPoints = [];

// explosions pool
const boomGeo = new THREE.SphereGeometry(1, 16, 16);
const explosions = [];

const aimArrow = new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3(), 30, 0xffffff, 7, 5);
aimArrow.visible = false;
scene.add(aimArrow);

// dotted trajectory preview while aiming
const PREVIEW_DOTS = 40;
const previewGeo = new THREE.BufferGeometry();
previewGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(PREVIEW_DOTS * 3), 3));
const previewDots = new THREE.Points(previewGeo, new THREE.PointsMaterial({ color: 0xffffff, size: 2.4, transparent: true, opacity: 0.85, sizeAttenuation: false }));
previewDots.frustumCulled = false;
previewDots.visible = false;
scene.add(previewDots);

// dust puffs kicked up while driving
const dustTex = makeRadialTexture('rgba(180,160,130,0.8)', 'rgba(180,160,130,0)');
const dustPool = [];

function spawnDust(x, y) {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: dustTex, transparent: true, opacity: 0.7, depthWrite: false }));
  s.position.set(x + (Math.random() - 0.5) * 4, y + 1.5, 1);
  s.scale.setScalar(3 + Math.random() * 3);
  scene.add(s);
  dustPool.push({ s, t: 0, dur: 0.6 + Math.random() * 0.3, vy: 6 + Math.random() * 4 });
}
function updateDust(dt) {
  for (let i = dustPool.length - 1; i >= 0; i--) {
    const d = dustPool[i];
    d.t += dt;
    const k = d.t / d.dur;
    d.s.position.y += d.vy * dt;
    d.s.scale.setScalar((3 + k * 5));
    d.s.material.opacity = 0.7 * (1 - k);
    if (d.t >= d.dur) { scene.remove(d.s); d.s.material.dispose(); dustPool.splice(i, 1); }
  }
}
let dustTimer = 0;

resizeCamera();
window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  resizeCamera();
});
renderer.domElement.addEventListener('wheel', (e) => {
  e.preventDefault();
  targetZoom = Math.max(0.7, Math.min(3.5, targetZoom * (1 - e.deltaY * 0.0012)));
}, { passive: false });

function makeSky() {
  const c = document.createElement('canvas');
  c.width = 2;
  c.height = 256;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, '#4f93dd');
  grad.addColorStop(0.45, '#86b6e6');
  grad.addColorStop(0.8, '#bcd4ee');
  grad.addColorStop(1, '#dfeaf4');
  g.fillStyle = grad;
  g.fillRect(0, 0, 2, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function resizeCamera() {
  const aspect = window.innerWidth / window.innerHeight;
  const halfW = VIEW_WIDTH / 2;
  camera.left = -halfW;
  camera.right = halfW;
  camera.top = halfW / aspect;
  camera.bottom = -halfW / aspect;
  camera.updateProjectionMatrix();
}

// --- backdrop (sun, clouds, parallax hills) ---
function buildBackdrop() {
  // sun glow
  const sunSprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: makeRadialTexture('rgba(255,247,214,0.95)', 'rgba(255,240,180,0)'),
    transparent: true, depthTest: false, depthWrite: false,
  }));
  sunSprite.scale.set(120, 120, 1);
  sunSprite.position.set(-150, 120, -260);
  backdrop.add(sunSprite);

  // two layers of rolling hills behind the playfield
  backdrop.add(makeHillLayer('#7fa9cf', 0.55, -300, 70, 44));
  backdrop.add(makeHillLayer('#8fbf86', 0.85, -200, 48, 30));

  // drifting clouds
  const cloudTex = makeCloudTexture();
  for (let i = 0; i < 6; i++) {
    const cl = new THREE.Sprite(new THREE.SpriteMaterial({ map: cloudTex, transparent: true, opacity: 0.8, depthTest: false, depthWrite: false }));
    const s = 60 + Math.random() * 70;
    cl.scale.set(s, s * 0.5, 1);
    cl.position.set(-360 + Math.random() * 720, 70 + Math.random() * 80, -250 - Math.random() * 60);
    cl.userData.drift = 4 + Math.random() * 6;
    backdrop.add(cl);
    clouds.push(cl);
  }
}

function makeRadialTexture(inner, outer) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, inner);
  grad.addColorStop(1, outer);
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

function makeCloudTexture() {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = 'rgba(255,255,255,0.92)';
  for (const [x, y, r] of [[90, 78, 42], [140, 70, 50], [185, 80, 38], [120, 90, 46]]) {
    g.beginPath();
    g.ellipse(x, y, r, r * 0.7, 0, 0, Math.PI * 2);
    g.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeHillLayer(color, opacity, z, height, baseY) {
  const c = document.createElement('canvas');
  c.width = 1024; c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = color;
  g.beginPath();
  g.moveTo(0, 256);
  const seed = Math.random() * 10;
  for (let x = 0; x <= 1024; x += 8) {
    const u = x / 1024;
    const y = 150 - (Math.sin(u * Math.PI * 6 + seed) * 36 + Math.sin(u * Math.PI * 13 + seed) * 18 + 36);
    g.lineTo(x, y);
  }
  g.lineTo(1024, 256);
  g.closePath();
  g.fill();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const plane = new THREE.Mesh(
    new THREE.PlaneGeometry(900, height),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity, depthWrite: false, fog: true })
  );
  plane.position.set(0, baseY, z);
  return plane;
}

// --- terrain (2.5D ribbon) ---
function topColor(h, target) {
  const t = Math.max(0, Math.min(1, (h - 6) / 44));
  target.copy(new THREE.Color(0x4e9a4e)).lerp(new THREE.Color(0x7cba5e), t);
}

function buildTerrain() {
  const cols = state.world.cols;
  const geo = new THREE.BufferGeometry();
  const positions = new Float32Array(cols * 3 * 3);
  const colors = new Float32Array(cols * 3 * 3);
  const dirt = new THREE.Color(0x6b4e33);
  const dirtDeep = new THREE.Color(0x4a3522);
  for (let i = 0; i < cols; i++) {
    const h = state.heightmap[i];
    setVert(positions, i, i, h, TERRAIN_DEPTH / 2);              // topFront
    setVert(positions, cols + i, i, h, -TERRAIN_DEPTH / 2);      // topBack
    setVert(positions, 2 * cols + i, i, BASE_Y, TERRAIN_DEPTH / 2); // botFront
    setColor(colors, cols + i, dirt);
    setColor(colors, 2 * cols + i, dirtDeep);
  }
  const idx = [];
  for (let i = 0; i < cols - 1; i++) {
    const tf = i, tf1 = i + 1, tb = cols + i, tb1 = cols + i + 1, bf = 2 * cols + i, bf1 = 2 * cols + i + 1;
    idx.push(tf, tb, tf1, tf1, tb, tb1);   // top
    idx.push(tf, tf1, bf, tf1, bf1, bf);   // front
  }
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.setIndex(idx);
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.96, metalness: 0 });
  terrainMesh = new THREE.Mesh(geo, mat);
  terrainMesh.receiveShadow = true;
  scene.add(terrainMesh);
  refreshTerrain();
}

function setVert(arr, vi, x, y, z) { arr[vi * 3] = x; arr[vi * 3 + 1] = y; arr[vi * 3 + 2] = z; }
function setColor(arr, vi, c) { arr[vi * 3] = c.r; arr[vi * 3 + 1] = c.g; arr[vi * 3 + 2] = c.b; }

function refreshTerrain() {
  const cols = state.world.cols;
  const pos = terrainMesh.geometry.attributes.position;
  const col = terrainMesh.geometry.attributes.color;
  const c = new THREE.Color();
  for (let i = 0; i < cols; i++) {
    const h = state.heightmap[i];
    pos.array[i * 3 + 1] = h;
    pos.array[(cols + i) * 3 + 1] = h;
    topColor(h, c);
    setColor(col.array, i, c);
  }
  pos.needsUpdate = true;
  col.needsUpdate = true;
  terrainMesh.geometry.computeVertexNormals();
}

function heightAtClient(x) {
  let i = Math.round(x);
  if (i < 0) i = 0; else if (i > state.world.cols - 1) i = state.world.cols - 1;
  return state.heightmap[i];
}

// --- tanks ---
function mat(color, rough, metal) {
  return new THREE.MeshStandardMaterial({ color, roughness: rough ?? 0.6, metalness: metal ?? 0.15 });
}

function makeFlash(x, y) {
  const flash = new THREE.Sprite(new THREE.SpriteMaterial({
    map: makeRadialTexture('rgba(255,240,180,1)', 'rgba(255,140,40,0)'),
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  flash.scale.set(0.1, 0.1, 1);
  flash.position.set(x, y || 0, 0);
  flash.visible = false;
  return flash;
}

function makeHpGroup(teamColor, atY) {
  const hpGroup = new THREE.Group();
  hpGroup.position.y = atY;
  const hpBg = new THREE.Mesh(new THREE.PlaneGeometry(13, 1.6), new THREE.MeshBasicMaterial({ color: 0x101319, transparent: true, opacity: 0.85, depthTest: false }));
  hpBg.renderOrder = 5;
  hpGroup.add(hpBg);
  const hpFill = new THREE.Mesh(new THREE.PlaneGeometry(12, 1).translate(6, 0, 0), new THREE.MeshBasicMaterial({ color: new THREE.Color(teamColor), depthTest: false }));
  hpFill.position.set(-6, 0, 0.1);
  hpFill.renderOrder = 6;
  hpGroup.add(hpFill);
  return { hpGroup, hpFill };
}

// which way the tank should face (yaw): aimers turn toward their shot, others face the enemy
function facingFor(tank) {
  if (tank.id === state.youId && isMyTurn()) {
    return Number(dom.angle.value) >= 90 ? Math.PI : 0;
  }
  return tank.team === 0 ? 0 : Math.PI;
}

function buildTank(tank) {
  if (tankProto) buildModelTank(tank);
  else buildProceduralTank(tank);
}

function buildModelTank(tank) {
  const group = new THREE.Group();
  const modelGroup = new THREE.Group();
  const inner = skeletonClone(tankProto);
  inner.rotation.y = protoAlignY;
  inner.scale.setScalar(protoScale);
  inner.updateWorldMatrix(true, true);
  const box = new THREE.Box3().setFromObject(inner);
  const c = new THREE.Vector3();
  box.getCenter(c);
  inner.position.x -= c.x;
  inner.position.z -= c.z;
  inner.position.y -= box.min.y;

  const team = new THREE.Color(tank.color);
  inner.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = true;
    o.receiveShadow = true;
    o.frustumCulled = false;
    const tint = (m) => {
      const mm = m.clone();
      const n = (m.name || '').toLowerCase();
      if (n.includes('main') && !n.includes('dark') && !n.includes('detail')) {
        mm.color = team.clone();
        if (n.includes('light')) mm.color.multiplyScalar(1.3);
        mm.metalness = 0.3;
        mm.roughness = 0.55;
      }
      return mm;
    };
    o.material = Array.isArray(o.material) ? o.material.map(tint) : tint(o.material);
  });
  modelGroup.add(inner);
  group.add(modelGroup);

  const flash = makeFlash(TARGET_LEN * 0.55, 5);
  modelGroup.add(flash);

  const { hpGroup, hpFill } = makeHpGroup(tank.color, 14);
  group.add(hpGroup);

  group.position.set(tank.x, tank.y, 0);
  modelGroup.rotation.y = facingFor(tank);
  scene.add(group);
  tankMeshes.set(tank.id, { kind: 'model', group, modelGroup, barrelPivot: null, flash, hpFill, hpGroup, targetX: tank.x, targetY: tank.y, flashT: 0 });
  updateHpBar(tank);
}

function buildProceduralTank(tank) {
  const group = new THREE.Group();
  const team = new THREE.Color(tank.color);
  const dark = team.clone().multiplyScalar(0.7);
  const trackMat = mat(0x23272e, 0.95, 0.1);

  // lower hull
  const lower = new THREE.Mesh(new THREE.BoxGeometry(11, 2.2, 8), mat(dark, 0.55, 0.25));
  lower.position.y = 2.4;
  lower.castShadow = lower.receiveShadow = true;
  group.add(lower);

  // upper hull (narrower, slightly inset) + sloped glacis
  const upper = new THREE.Mesh(new THREE.BoxGeometry(8.5, 2.4, 6.4), mat(team, 0.5, 0.25));
  upper.position.y = 4.4;
  upper.castShadow = true;
  group.add(upper);

  const glacis = new THREE.Mesh(new THREE.BoxGeometry(3.2, 2.6, 6.2), mat(team, 0.5, 0.25));
  glacis.position.set(5, 3.7, 0);
  glacis.rotation.z = -0.6;
  glacis.castShadow = true;
  group.add(glacis);

  // tracks + road wheels
  for (const sz of [-1, 1]) {
    const track = new THREE.Mesh(new THREE.BoxGeometry(12, 2.6, 1.9), trackMat);
    track.position.set(0, 1.5, sz * 3.6);
    track.castShadow = track.receiveShadow = true;
    group.add(track);
    const fender = new THREE.Mesh(new THREE.BoxGeometry(12.4, 0.5, 2.4), mat(dark, 0.6, 0.2));
    fender.position.set(0, 3, sz * 3.6);
    group.add(fender);
    for (let wx = -4.2; wx <= 4.2; wx += 2.1) {
      const wheel = new THREE.Mesh(new THREE.CylinderGeometry(1.25, 1.25, 1.4, 12), trackMat);
      wheel.rotation.x = Math.PI / 2;
      wheel.position.set(wx, 1.4, sz * 3.6);
      group.add(wheel);
    }
  }

  // turret + mantlet + cupola
  const turret = new THREE.Mesh(new THREE.SphereGeometry(3.1, 20, 14, 0, Math.PI * 2, 0, Math.PI / 2), mat(team, 0.45, 0.35));
  turret.scale.set(1.1, 0.85, 1);
  turret.position.y = 5.6;
  turret.castShadow = true;
  group.add(turret);

  const cupola = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1.2, 12), mat(dark, 0.5, 0.3));
  cupola.position.set(-1, 7.4, 0);
  cupola.castShadow = true;
  group.add(cupola);

  // antenna
  const antenna = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 7, 6), mat(0x111111, 0.7, 0.3));
  antenna.position.set(-2.4, 9.5, 1.6);
  group.add(antenna);

  // barrel on a pivot at the turret centre
  const barrelPivot = new THREE.Group();
  barrelPivot.position.set(0, 5.8, 0);
  const mantlet = new THREE.Mesh(new THREE.BoxGeometry(2.2, 2.2, 2.6), mat(dark, 0.45, 0.4));
  mantlet.position.x = 2;
  barrelPivot.add(mantlet);
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.6, 7, 14), mat(0x20262d, 0.35, 0.7));
  barrel.rotation.z = -Math.PI / 2;
  barrel.position.x = 5.5;
  barrel.castShadow = true;
  barrelPivot.add(barrel);
  const muzzle = new THREE.Mesh(new THREE.CylinderGeometry(0.85, 0.85, 1.2, 14), mat(0x15191f, 0.4, 0.6));
  muzzle.rotation.z = -Math.PI / 2;
  muzzle.position.x = 8.8;
  barrelPivot.add(muzzle);

  // muzzle flash (hidden until firing)
  const flash = new THREE.Sprite(new THREE.SpriteMaterial({
    map: makeRadialTexture('rgba(255,240,180,1)', 'rgba(255,140,40,0)'),
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  flash.scale.set(0.1, 0.1, 1);
  flash.position.x = 9.8;
  flash.visible = false;
  barrelPivot.add(flash);
  group.add(barrelPivot);

  // floating HP bar
  const hpGroup = new THREE.Group();
  hpGroup.position.y = 12;
  const hpBg = new THREE.Mesh(new THREE.PlaneGeometry(13, 1.6), new THREE.MeshBasicMaterial({ color: 0x101319, transparent: true, opacity: 0.85, depthTest: false }));
  hpBg.renderOrder = 5;
  hpGroup.add(hpBg);
  const fillGeo = new THREE.PlaneGeometry(12, 1).translate(6, 0, 0); // pivot at left edge
  const hpFill = new THREE.Mesh(fillGeo, new THREE.MeshBasicMaterial({ color: team, depthTest: false }));
  hpFill.position.set(-6, 0, 0.1);
  hpFill.renderOrder = 6;
  hpGroup.add(hpFill);
  group.add(hpGroup);

  group.position.set(tank.x, tank.y, 0);
  scene.add(group);
  tankMeshes.set(tank.id, { kind: 'proc', group, modelGroup: null, barrelPivot, flash, hpFill, hpGroup, targetX: tank.x, targetY: tank.y, flashT: 0 });
  updateHpBar(tank);
}

function updateHpBar(tank) {
  const ref = tankMeshes.get(tank.id);
  if (!ref) return;
  const f = Math.max(0, tank.hp) / 100;
  ref.hpFill.scale.x = f <= 0.001 ? 0.001 : f;
  const c = new THREE.Color().setHSL(0.33 * f, 0.85, 0.5);
  ref.hpFill.material.color.copy(c);
  ref.hpGroup.visible = tank.alive;
}

function barrelAngleFor(tank) {
  if (tank.id === state.youId) return Number(dom.angle.value);
  return tank.team === 0 ? 50 : 130;
}

function syncTanks() {
  for (const tank of state.tanks) {
    if (!tankMeshes.has(tank.id)) buildTank(tank);
    const ref = tankMeshes.get(tank.id);
    ref.group.visible = tank.alive;
    ref.targetX = tank.x;
    ref.targetY = tank.y;
    updateHpBar(tank);
  }
}

// --- pickups ---
function syncPickups() {
  const seen = new Set();
  for (const pk of state.pickups) {
    seen.add(pk.id);
    if (pickupMeshes.has(pk.id)) continue;
    const fx = WEAPON_FX[pk.weapon] || WEAPON_FX.standard;
    const grp = new THREE.Group();
    const crate = new THREE.Mesh(
      new THREE.BoxGeometry(5, 5, 5),
      new THREE.MeshStandardMaterial({ color: fx.proj, emissive: fx.boom, emissiveIntensity: 0.55, roughness: 0.45, metalness: 0.4 })
    );
    crate.castShadow = true;
    grp.add(crate);
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({
      map: makeRadialTexture('rgba(255,255,255,0.6)', 'rgba(255,255,255,0)'),
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    halo.scale.set(12, 12, 1);
    grp.add(halo);
    grp.position.set(pk.x, pk.y + 5, 0);
    grp.userData.baseY = pk.y + 5;
    scene.add(grp);
    pickupMeshes.set(pk.id, grp);
  }
  for (const [id, mesh] of pickupMeshes) {
    if (!seen.has(id)) {
      scene.remove(mesh);
      pickupMeshes.delete(id);
    }
  }
}

// --- HUD ---
function pushLog(text) {
  const line = document.createElement('div');
  line.className = 'log-line';
  line.textContent = text;
  dom.log.prepend(line);
  while (dom.log.children.length > 4) dom.log.removeChild(dom.log.lastChild);
  setTimeout(() => line.remove(), 5000);
}

function myTank() {
  return state.tanks.find((t) => t.id === state.youId);
}
function activeTank() {
  return state.tanks.find((t) => t.id === state.activePlayerId);
}

function refreshHud() {
  if (state.gameOver) {
    dom.hudTurn.textContent = 'Match over';
  } else if (state.activePlayerId === state.youId) {
    dom.hudTurn.textContent = 'Your turn — drive & fire';
  } else {
    const t = activeTank();
    dom.hudTurn.textContent = `${t ? t.name : 'Opponent'}'s turn`;
  }
  dom.windMag.textContent = Math.abs(state.wind);
  dom.windArrow.textContent = state.wind === 0 ? '•' : '➤';
  dom.windArrow.style.transform = `rotate(${state.wind < 0 ? 180 : 0}deg)`;
}

function refreshFuel() {
  const t = activeTank();
  const f = t ? Math.max(0, Math.min(1, t.fuel / state.moveRange)) : 0;
  dom.fuelFill.style.width = `${f * 100}%`;
  dom.fuelFill.style.background = f > 0.4 ? '#39d353' : f > 0.15 ? '#e3b341' : '#f85149';
}

function buildTeams() {
  dom.teams.innerHTML = '';
  for (const tank of state.tanks) {
    const row = document.createElement('div');
    row.className = 'hp-row';
    row.dataset.id = tank.id;
    const name = document.createElement('span');
    name.className = 'hp-name';
    name.style.color = tank.color;
    name.textContent = tank.id === state.youId ? `${tank.name} (you)` : tank.name;
    const bar = document.createElement('div');
    bar.className = 'hp-bar';
    const fill = document.createElement('div');
    fill.className = 'hp-fill';
    fill.style.background = tank.color;
    bar.appendChild(fill);
    row.appendChild(name);
    row.appendChild(bar);
    dom.teams.appendChild(row);
  }
  refreshTeams();
}

function refreshTeams() {
  for (const row of dom.teams.children) {
    const tank = state.tanks.find((t) => t.id === row.dataset.id);
    if (!tank) continue;
    row.querySelector('.hp-fill').style.width = `${tank.hp}%`;
    row.classList.toggle('dead', !tank.alive);
    row.classList.toggle('active', tank.id === state.activePlayerId && !state.gameOver);
  }
}

function buildWeapons() {
  const me = myTank();
  dom.weapons.innerHTML = '';
  if (!me) return;
  const owned = Object.keys(me.weapons).filter((w) => me.weapons[w] !== 0);
  if (!owned.includes(state.currentWeapon)) state.currentWeapon = 'standard';
  for (const w of owned) {
    const def = state.weaponDefs[w];
    const ammo = me.weapons[w];
    const fx = WEAPON_FX[w] || WEAPON_FX.standard;
    const btn = document.createElement('button');
    btn.className = 'weapon-btn' + (w === state.currentWeapon ? ' selected' : '');
    btn.innerHTML = `<span class="wb-dot" style="background:#${fx.proj.toString(16).padStart(6, '0')}"></span>${def.name} <b>${ammo < 0 ? '∞' : `x${ammo}`}</b>`;
    btn.addEventListener('click', () => { state.currentWeapon = w; buildWeapons(); });
    dom.weapons.appendChild(btn);
  }
}

function isMyTurn() {
  return !state.gameOver && !anim && state.activePlayerId === state.youId;
}
function updateControls() {
  const mine = isMyTurn();
  dom.fireBtn.disabled = !mine;
  const t = myTank();
  const canDrive = mine && t && t.fuel > 0.2;
  dom.driveLeft.disabled = !canDrive;
  dom.driveRight.disabled = !canDrive;
  if (!mine) driveDir = 0;
}

function resetDrivePrediction() {
  const me = myTank();
  if (!me) return;
  localTargetX = me.x;
  localFuel = me.fuel;
}

// --- input: aiming via sliders ---
dom.angle.addEventListener('input', () => { dom.angleVal.textContent = dom.angle.value; });
dom.power.addEventListener('input', () => { dom.powerVal.textContent = dom.power.value; });

dom.fireBtn.addEventListener('click', fire);
function fire() {
  if (!isMyTurn()) return;
  dom.fireBtn.disabled = true;
  driveDir = 0;
  socket.emit('moveTo', { x: localTargetX }); // commit final position before firing
  socket.emit('fire', {
    angle: Number(dom.angle.value),
    power: Number(dom.power.value),
    weapon: state.currentWeapon,
  });
}

// --- input: driving ---
function bindHold(btn, dir) {
  const down = (e) => { e.preventDefault(); if (isMyTurn()) driveDir = dir; };
  const up = (e) => { e.preventDefault(); if (driveDir === dir) driveDir = 0; };
  btn.addEventListener('pointerdown', down);
  btn.addEventListener('pointerup', up);
  btn.addEventListener('pointerleave', up);
  btn.addEventListener('pointercancel', up);
}
bindHold(dom.driveLeft, -1);
bindHold(dom.driveRight, 1);

window.addEventListener('keydown', (e) => {
  if (document.activeElement && document.activeElement.tagName === 'INPUT') return;
  if (e.code === 'ArrowLeft' || e.code === 'KeyA') { if (isMyTurn()) driveDir = -1; }
  else if (e.code === 'ArrowRight' || e.code === 'KeyD') { if (isMyTurn()) driveDir = 1; }
  else if (e.code === 'Space') { e.preventDefault(); fire(); }
});
window.addEventListener('keyup', (e) => {
  if ((e.code === 'ArrowLeft' || e.code === 'KeyA') && driveDir === -1) driveDir = 0;
  if ((e.code === 'ArrowRight' || e.code === 'KeyD') && driveDir === 1) driveDir = 0;
});

let needCommit = false;
function updateDriving(dt) {
  if (!isMyTurn()) return;
  const me = myTank();
  if (!me) return;
  if (driveDir === 0 || localFuel <= 0.05) {
    if (needCommit) { needCommit = false; socket.emit('moveTo', { x: localTargetX }); }
    return;
  }
  needCommit = true;
  let nx = localTargetX + driveDir * MOVE_SPEED * dt;
  nx = Math.max(0, Math.min(state.world.cols - 1, nx));
  let moved = Math.abs(nx - localTargetX);
  if (moved > localFuel) { nx = localTargetX + Math.sign(nx - localTargetX) * localFuel; moved = localFuel; }
  // block against other tanks (optimistic; server enforces authoritatively)
  for (const o of state.tanks) {
    if (o.id === me.id || !o.alive) continue;
    if (driveDir > 0 && o.x > localTargetX && o.x - 11 < nx) nx = Math.min(nx, o.x - 11);
    if (driveDir < 0 && o.x < localTargetX && o.x + 11 > nx) nx = Math.max(nx, o.x + 11);
  }
  localFuel = Math.max(0, localFuel - Math.abs(nx - localTargetX));
  localTargetX = nx;
  me.x = nx;
  me.y = heightAtClient(nx);
  me.fuel = localFuel;
  const ref = tankMeshes.get(me.id);
  if (ref) { ref.targetX = nx; ref.targetY = me.y; }
  focusX = nx;
  refreshFuel();
  updateControls();

  // kick up dust behind the treads so movement is unmistakably felt
  dustTimer -= dt;
  if (dustTimer <= 0) { spawnDust(nx - driveDir * 6, me.y); dustTimer = 0.06; }

  const now = performance.now();
  if (now - lastMoveEmit > 55) {
    lastMoveEmit = now;
    socket.emit('moveTo', { x: nx });
  }
}

// --- input: drag-to-aim on the battlefield ---
const raycaster = new THREE.Raycaster();
const aimPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
const ndc = new THREE.Vector2();
let aiming = false;

function screenToWorld(clientX, clientY, out) {
  const rect = renderer.domElement.getBoundingClientRect();
  ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
  ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(ndc, camera);
  return raycaster.ray.intersectPlane(aimPlane, out);
}

const _aimPt = new THREE.Vector3();
function applyAimFromPoint(clientX, clientY) {
  const me = myTank();
  if (!me) return;
  if (!screenToWorld(clientX, clientY, _aimPt)) return;
  const dx = _aimPt.x - me.x;
  const dy = _aimPt.y - (me.y + TURRET_Y);
  let ang = Math.atan2(dy, dx) * 180 / Math.PI;
  ang = Math.max(0, Math.min(180, ang));
  const dist = Math.hypot(dx, dy);
  const pow = Math.max(5, Math.min(100, Math.round(dist * POWER_PER_UNIT)));
  dom.angle.value = Math.round(ang);
  dom.power.value = pow;
  dom.angleVal.textContent = dom.angle.value;
  dom.powerVal.textContent = dom.power.value;
}

renderer.domElement.addEventListener('pointerdown', (e) => {
  if (!isMyTurn()) return;
  aiming = true;
  renderer.domElement.setPointerCapture(e.pointerId);
  applyAimFromPoint(e.clientX, e.clientY);
});
renderer.domElement.addEventListener('pointermove', (e) => {
  if (aiming) applyAimFromPoint(e.clientX, e.clientY);
});
const endAim = (e) => {
  if (!aiming) return;
  aiming = false;
  try { renderer.domElement.releasePointerCapture(e.pointerId); } catch (_) {}
};
renderer.domElement.addEventListener('pointerup', endAim);
renderer.domElement.addEventListener('pointercancel', endAim);

// --- lobby ---
for (const btn of document.querySelectorAll('.mode-btn')) {
  btn.addEventListener('click', () => {
    selectedMode = btn.dataset.mode;
    for (const b of document.querySelectorAll('.mode-btn')) b.classList.toggle('selected', b === btn);
  });
}
document.getElementById('create-btn').addEventListener('click', () => socket.emit('createRoom', { mode: selectedMode }));
document.getElementById('join-btn').addEventListener('click', () => {
  const code = document.getElementById('join-code').value.trim().toUpperCase();
  if (code.length === 4) {
    socket.emit('joinRoom', { code });
  } else {
    dom.overlayMsg.textContent = 'Enter a 4-character room code.';
  }
});

// --- socket events ---
socket.on('roomCreated', ({ code, mode, capacity }) => {
  dom.overlayMsg.textContent = `Room ${code} (${mode}) — waiting… 1/${capacity}`;
});
socket.on('lobbyUpdate', ({ count, capacity }) => {
  dom.overlayMsg.textContent = `Waiting for players… ${count}/${capacity}`;
});
socket.on('errorMsg', ({ message }) => {
  if (state.world && dom.overlay.classList.contains('hidden')) {
    pushLog(message);
  } else {
    dom.overlayMsg.textContent = message;
  }
  updateControls();
});

socket.on('gameStart', (data) => {
  state.youId = data.youId;
  state.mode = data.mode;
  state.world = data.world;
  state.heightmap = data.heightmap;
  state.tanks = data.tanks;
  state.wind = data.wind;
  state.activePlayerId = data.activePlayerId;
  state.pickups = data.pickups;
  state.weaponDefs = data.weapons;
  state.moveRange = data.moveRange || 44;
  state.gameOver = false;

  buildTerrain();
  syncTanks();
  syncPickups();
  buildTeams();
  buildWeapons();

  const me = myTank();
  dom.angle.value = me && me.team === 1 ? 135 : 45;
  dom.angleVal.textContent = dom.angle.value;
  dom.power.value = 60;
  dom.powerVal.textContent = '60';
  focusX = me ? me.x : (state.world.cols - 1) / 2;
  resetDrivePrediction();

  dom.hudRoom.textContent = `Room ${data.code} · ${data.mode}`;
  dom.overlay.classList.add('hidden');
  refreshHud();
  refreshFuel();
  updateControls();
});

socket.on('tankMoved', ({ id, x, y, fuel, collected, pickups }) => {
  const t = state.tanks.find((s) => s.id === id);
  if (t) { t.x = x; t.y = y; t.fuel = fuel; }
  state.pickups = pickups;
  syncPickups();

  if (id === state.youId) {
    // reconcile local prediction; snap only if the server clamped us hard
    if (Math.abs(x - localTargetX) > 3) localTargetX = x;
    localFuel = fuel;
  } else {
    const ref = tankMeshes.get(id);
    if (ref) { ref.targetX = x; ref.targetY = y; }
  }
  for (const c of collected) {
    const ct = state.tanks.find((s) => s.id === c.tankId);
    pushLog(`${ct ? ct.name : '?'} grabbed ${state.weaponDefs[c.weapon].name}!`);
  }
  if (collected.length) buildWeapons();
  refreshFuel();
  updateControls();
});

socket.on('shotResolved', (data) => {
  pending = data;
  anim = { projectiles: data.projectiles, pi: 0, prog: 0, phase: 'fly', boom: 0 };
  trailPoints = [];
  driveDir = 0;
  dom.fireBtn.disabled = true;
  updateControls();
  // muzzle flash on the shooter
  const ref = tankMeshes.get(data.shooterId);
  if (ref) ref.flashT = 0.12;
});

socket.on('opponentLeft', ({ message }) => {
  state.gameOver = true;
  showOverlay(message, true);
  updateControls();
});

function applyPending() {
  state.heightmap = pending.heightmap;
  state.tanks = pending.tanks;
  refreshTerrain();
  syncTanks();

  for (const d of pending.damages) {
    const t = state.tanks.find((x) => x.id === d.id);
    pushLog(`${t ? t.name : '?'} took ${d.amount}${d.dead ? ' — destroyed!' : ''}`);
  }
  for (const c of pending.collected) {
    const t = state.tanks.find((x) => x.id === c.tankId);
    pushLog(`${t ? t.name : '?'} grabbed ${state.weaponDefs[c.weapon].name}!`);
  }

  const next = pending.next;
  if (next.type === 'gameOver') {
    state.gameOver = true;
    const me = myTank();
    const won = me && next.winnerTeam === me.team;
    showOverlay(won ? 'Your team wins!' : next.winnerTeam === null ? 'Draw.' : 'Your team lost.', true);
  } else {
    state.activePlayerId = next.activePlayerId;
    state.wind = next.wind;
    state.pickups = next.pickups;
    syncPickups();
  }
  pending = null;
  resetDrivePrediction();
  buildWeapons();
  refreshHud();
  refreshTeams();
  refreshFuel();
  updateControls();
}

function showOverlay(message, withReplay) {
  dom.panel.innerHTML = `<h1>${message}</h1>`;
  if (withReplay) {
    const btn = document.createElement('button');
    btn.id = 'create-btn';
    btn.textContent = 'Play Again';
    btn.addEventListener('click', () => location.reload());
    dom.panel.appendChild(btn);
  }
  dom.overlay.classList.remove('hidden');
}

// --- explosions ---
function spawnExplosion(x, y, radius, color, big) {
  const mesh = new THREE.Mesh(boomGeo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.92, depthWrite: false }));
  mesh.position.set(x, y, 0);
  mesh.scale.setScalar(radius * 0.4);
  scene.add(mesh);
  let light = null;
  if (big) {
    light = new THREE.PointLight(color, 6, radius * 7);
    light.position.set(x, y + 5, 14);
    scene.add(light);
  }
  explosions.push({ mesh, light, t: 0, dur: BOOM_TIME, radius });
  shake = Math.min(9, shake + radius * 0.18);
}

function updateExplosions(dt) {
  for (let i = explosions.length - 1; i >= 0; i--) {
    const ex = explosions[i];
    ex.t += dt;
    const k = Math.min(1, ex.t / ex.dur);
    ex.mesh.scale.setScalar(Math.max(0.5, ex.radius * 1.3 * k));
    ex.mesh.material.opacity = 0.92 * (1 - k);
    if (ex.light) ex.light.intensity = 6 * (1 - k);
    if (ex.t >= ex.dur) {
      scene.remove(ex.mesh);
      ex.mesh.material.dispose();
      if (ex.light) scene.remove(ex.light);
      explosions.splice(i, 1);
    }
  }
}

function detonate(proj) {
  const fx = WEAPON_FX[proj.kind] || WEAPON_FX.standard;
  spawnExplosion(proj.impact.x, proj.impact.y, proj.blastRadius, fx.boom, true);
  if (proj.subImpacts) {
    for (const si of proj.subImpacts) {
      spawnExplosion(si.x, si.y, si.radius, fx.boom, false);
    }
  }
}

// --- aim arrow ---
const _v = new THREE.Vector3();
function updateAim() {
  if (!isMyTurn()) { aimArrow.visible = false; return; }
  const me = myTank();
  if (!me) { aimArrow.visible = false; return; }
  const rad = (Number(dom.angle.value) * Math.PI) / 180;
  aimArrow.position.set(me.x, me.y + TURRET_Y, 0);
  aimArrow.setDirection(_v.set(Math.cos(rad), Math.sin(rad), 0));
  aimArrow.setLength(Number(dom.power.value) * 0.55, 7, 5);
  const fx = WEAPON_FX[state.currentWeapon] || WEAPON_FX.standard;
  aimArrow.setColor(fx.proj);
  aimArrow.visible = true;
}

// --- live trajectory preview (mirrors the server integrator) ---
function updatePreview() {
  if (!isMyTurn()) { previewDots.visible = false; return; }
  const me = myTank();
  if (!me) { previewDots.visible = false; return; }
  const ang = (Number(dom.angle.value) * Math.PI) / 180;
  const wdef = state.weaponDefs ? state.weaponDefs[state.currentWeapon] : null;
  const speed = Number(dom.power.value) * PHYS.POWER_SCALE * (wdef ? wdef.powerMult : 1);
  let x = me.x + Math.cos(ang) * BARREL_LEN;
  let y = me.y + TURRET_Y + Math.sin(ang) * BARREL_LEN;
  let vx = Math.cos(ang) * speed, vy = Math.sin(ang) * speed;
  const ax = state.wind * PHYS.WIND_SCALE;
  const cols = state.world.cols;
  const arr = previewGeo.attributes.position.array;
  const STRIDE = 5;
  let n = 0;
  for (let i = 0; i < PREVIEW_DOTS * STRIDE && n < PREVIEW_DOTS; i++) {
    vx += ax; vy -= PHYS.GRAVITY; x += vx; y += vy;
    let stop = false;
    if (x < -50 || x > cols + 50) break;
    if (x >= 0 && x <= cols - 1 && y <= heightAtClient(x)) stop = true;
    if (i % STRIDE === 0 || stop) {
      arr[n * 3] = x; arr[n * 3 + 1] = y; arr[n * 3 + 2] = 0; n++;
    }
    if (stop) break;
  }
  previewGeo.setDrawRange(0, n);
  previewGeo.attributes.position.needsUpdate = true;
  const fx = WEAPON_FX[state.currentWeapon] || WEAPON_FX.standard;
  previewDots.material.color.setHex(fx.proj);
  previewDots.visible = n > 1;
}

// --- animation ---
function stepAnim(dt) {
  if (!anim) return;
  const proj = anim.projectiles[anim.pi];
  const pts = proj.trajectory;
  const fx = WEAPON_FX[proj.kind] || WEAPON_FX.standard;
  if (anim.phase === 'fly') {
    anim.prog += dt * STEP_RATE;
    const i = Math.floor(anim.prog);
    if (i >= pts.length - 1) {
      projectileMesh.visible = false;
      projLight.intensity = 0;
      trail.visible = false;
      detonate(proj);
      anim.phase = 'boom';
      anim.boom = 0;
      return;
    }
    const frac = anim.prog - i;
    const a = pts[i], b = pts[i + 1];
    const px = a.x + (b.x - a.x) * frac;
    const py = a.y + (b.y - a.y) * frac;
    projMat.emissive.setHex(fx.proj);
    projLight.color.setHex(fx.proj);
    projectileMesh.position.set(px, py, 0);
    projectileMesh.visible = true;
    projLight.intensity = 1.6;
    focusX = px;
    trail.material.color.setHex(fx.proj);
    trailPoints.push(new THREE.Vector3(px, py, 0));
    if (trailPoints.length > 26) trailPoints.shift();
    if (trailPoints.length > 1) {
      trail.geometry.setFromPoints(trailPoints);
      trail.visible = true;
    }
  } else {
    anim.boom += dt;
    if (anim.boom >= BOOM_TIME) {
      anim.pi += 1;
      if (anim.pi >= anim.projectiles.length) {
        anim = null;
        applyPending();
      } else {
        anim.phase = 'fly';
        anim.prog = 0;
        trailPoints = [];
      }
    }
  }
}

function updateCamera(dt) {
  if (!anim) {
    const active = activeTank();
    if (active && !(isMyTurn() && driveDir !== 0)) focusX = active.x;
  }
  const ease = 1 - Math.exp(-4 * dt);
  if (Math.abs(camera.zoom - targetZoom) > 0.001) {
    camera.zoom += (targetZoom - camera.zoom) * ease;
    camera.updateProjectionMatrix();
  }
  const cols = state.world ? state.world.cols : 240;
  const halfW = VIEW_WIDTH / 2 / targetZoom;
  let target;
  if (halfW * 2 >= cols) {
    target = (cols - 1) / 2;
  } else {
    target = Math.max(halfW, Math.min(cols - 1 - halfW, focusX));
  }
  camX += (target - camX) * ease;

  shake *= Math.exp(-6 * dt);
  const sx = shake > 0.05 ? (Math.random() - 0.5) * shake : 0;
  const sy = shake > 0.05 ? (Math.random() - 0.5) * shake : 0;

  camera.position.set(camX + CAM_OFFSET.x + sx, CAM_OFFSET.y + CAM_TARGET_Y + sy, CAM_OFFSET.z);
  camera.lookAt(camX, CAM_TARGET_Y, 0);
  backdrop.position.x = camX;
}

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(0.05, clock.getDelta());

  updateDriving(dt);
  stepAnim(dt);
  updateExplosions(dt);

  for (const tank of state.tanks) {
    const ref = tankMeshes.get(tank.id);
    if (!ref) continue;
    const k = 1 - Math.exp(-14 * dt);
    ref.group.position.x += (ref.targetX - ref.group.position.x) * k;
    ref.group.position.y += (ref.targetY - ref.group.position.y) * k;
    if (ref.barrelPivot) {
      ref.barrelPivot.rotation.z = (barrelAngleFor(tank) * Math.PI) / 180;
    }
    if (ref.modelGroup) {
      // smoothly turn the hull to face the aim/enemy direction
      const target = facingFor(tank);
      ref.modelGroup.rotation.y += (target - ref.modelGroup.rotation.y) * (1 - Math.exp(-9 * dt));
    }
    // muzzle flash decay
    if (ref.flashT > 0) {
      ref.flashT -= dt;
      ref.flash.visible = true;
      const s = 6 * Math.max(0, ref.flashT / 0.12);
      ref.flash.scale.set(s + 0.1, s + 0.1, 1);
    } else if (ref.flash.visible) {
      ref.flash.visible = false;
    }
  }
  for (const grp of pickupMeshes.values()) {
    grp.rotation.y += dt * 1.6;
    grp.position.y = grp.userData.baseY + Math.sin(clock.elapsedTime * 2 + grp.position.x) * 0.8;
  }
  for (const cl of clouds) {
    cl.position.x += cl.userData.drift * dt;
    if (cl.position.x > 380) cl.position.x = -380;
  }

  updateDust(dt);
  updateAim();
  updatePreview();
  updateCamera(dt);
  renderer.render(scene, camera);
}
animate();

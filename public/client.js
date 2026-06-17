import * as THREE from 'three';
import { KITS, SKINS, TANK_COLORS, WEAPON_FX, defaultProfile, normalizeProfile } from './data.js';
import * as FB from './firebase-config.js';

const socket = io();

// ======================================================================
//  DOM
// ======================================================================
const dom = {
  scene: document.getElementById('scene'),
  overlay: document.getElementById('overlay'),
  hudTurn: document.getElementById('hud-turn'),
  hudBiome: document.getElementById('hud-biome'),
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

function $(id) { return document.getElementById(id); }
function showScreen(id) {
  dom.overlay.classList.remove('hidden');
  document.body.classList.add('in-menu');   // hide the in-game HUD behind the menus
  for (const s of document.querySelectorAll('.screen')) s.classList.toggle('active', s.id === id);
  // The flanking-tank 3D backdrop runs behind every menu screen except loading.
  if (typeof startMenuStage === 'function' && id !== 'screen-loading') startMenuStage();
}
function hideOverlay() {
  dom.overlay.classList.add('hidden');
  document.body.classList.remove('in-menu');
  if (typeof stopMenuStage === 'function') stopMenuStage();
}

// ======================================================================
//  Game state
// ======================================================================
const state = {
  youId: null,
  mode: null,
  world: null,
  heightmap: null,
  tanks: [],
  props: [],
  wind: 0,
  activePlayerId: null,
  pickups: [],
  hazards: [],
  weaponDefs: null,
  currentWeapon: 'standard',
  gameOver: false,
  moveRange: 60,
  maxHp: 100,
  biome: null,
};

let selectedMode = '1v1';
let anim = null;
let pending = null;

const TERRAIN_DEPTH = 30;
const BASE_Y = -70;
const STEP_RATE = 90;
const BOOM_TIME = 0.5;
const VIEW_WIDTH = 290;
const TURRET_Y = 4.4;
const MOVE_SPEED = 26;
const POWER_PER_UNIT = 1.4;

const PHYS = { GRAVITY: 0.06, POWER_SCALE: 0.05, WIND_SCALE: 0.0008 };
const BARREL_LEN = 5;

let focusX = 120;
let camX = 120;
let targetZoom = 1;
let shake = 0;

let driveDir = 0;
let localTargetX = 0;
let localFuel = 0;
let lastMoveEmit = 0;

// ======================================================================
//  Renderer / scene
// ======================================================================
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.domElement.style.touchAction = 'none';
dom.scene.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = makeSky(['#4f93dd', '#86b6e6', '#bcd4ee', '#dfeaf4']);
scene.fog = new THREE.Fog(0xbcd4ee, 360, 760);

const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 1600);
const CAM_OFFSET = new THREE.Vector3(0, 60, 240);
const CAM_TARGET_Y = 26;

const hemi = new THREE.HemisphereLight(0xdcecff, 0x52623f, 0.9);
scene.add(hemi);

const sun = new THREE.DirectionalLight(0xfff2d8, 1.25);
sun.position.set(150, 240, 200);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -260;
sun.shadow.camera.right = 260;
sun.shadow.camera.top = 170;
sun.shadow.camera.bottom = -80;
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 800;
sun.shadow.bias = -0.0004;
scene.add(sun);
scene.add(sun.target);

const fillLight = new THREE.DirectionalLight(0xa9c8ff, 0.25);
fillLight.position.set(-160, 120, 120);
scene.add(fillLight);

const clock = new THREE.Clock();

const backdrop = new THREE.Group();
const clouds = [];
scene.add(backdrop);

let terrainMesh = null;
let waterMesh = null;
const tankMeshes = new Map();
const pickupMeshes = new Map();
const propMeshes = new Map();
const hazardMeshes = new Map();   // napalm fire zones, keyed by hazard id

// ---- post-processing (bloom) — optional, fails gracefully ----
let composer = null;
(async () => {
  try {
    const [{ EffectComposer }, { RenderPass }, { UnrealBloomPass }] = await Promise.all([
      import('three/addons/postprocessing/EffectComposer.js'),
      import('three/addons/postprocessing/RenderPass.js'),
      import('three/addons/postprocessing/UnrealBloomPass.js'),
    ]);
    composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    const bloom = new UnrealBloomPass(
      new THREE.Vector2(window.innerWidth, window.innerHeight), 0.65, 0.5, 0.85
    );
    composer.addPass(bloom);
    composer.setSize(window.innerWidth, window.innerHeight);
  } catch (err) {
    console.warn('[gfx] bloom disabled.', err);
    composer = null;
  }
})();

// ======================================================================
//  Tank model
// ======================================================================
// The bundled models/tank.glb is corrupt (its body/track meshes are ~200x the
// scale of the turret and scattered hundreds of units apart), so it can't be
// used — tanks are built procedurally instead (see buildProceduralTank). This
// no-op keeps the boot sequence intact and avoids a slow CDN fetch of a model
// we don't use.
function preloadModel(onProgress) {
  if (onProgress) onProgress(1);
  return Promise.resolve('procedural');
}

// ======================================================================
//  Projectile / trail / explosions / preview (mostly unchanged)
// ======================================================================
const projMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, emissive: 0xffb030, emissiveIntensity: 1.6, roughness: 0.4 });
const projectileMesh = new THREE.Mesh(new THREE.SphereGeometry(1.7, 16, 16), projMat);
projectileMesh.castShadow = true;
projectileMesh.visible = false;
const projLight = new THREE.PointLight(0xffaa33, 0, 80);
projectileMesh.add(projLight);
scene.add(projectileMesh);

const trail = new THREE.Line(
  new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
  new THREE.LineBasicMaterial({ color: 0xffcc66, transparent: true, opacity: 0.65 })
);
trail.visible = false;
scene.add(trail);
let trailPoints = [];

const boomGeo = new THREE.SphereGeometry(1, 16, 16);
const explosions = [];

const aimArrow = new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3(), 30, 0xffffff, 7, 5);
aimArrow.visible = false;
scene.add(aimArrow);

// REMOVED: aiming guideline (predicted-trajectory dots). The player can no
// longer see where the current shot will land — aiming is skill-based again.
// (The old `previewDots`/`PREVIEW_DOTS`/`previewGeo` objects and updatePreview()
//  below have been removed.)

// FIX: per-player shot trails (was a single shared `prevTrailGroup` that got
// wiped on every shot, so one player's trail vanished the instant another fired).
// Now each shooter owns a THREE.Group keyed by their id, so trails are fully
// independent: firing only ever touches the shooter's own group, and ALL groups
// stay in the scene until the round is reset. Built from the server-sent
// trajectory + shooterId in `shotResolved`, so every client renders the same
// trails (multiplayer-consistent) with no extra networking.
const playerTrails = new Map();      // shooterId -> { group, lines: [] }
const MAX_TRAILS_PER_PLAYER = 5;     // FIX: cap per-player history to bound memory on long matches

// Build one faded line from a projectile's trajectory. Brightness ramps origin →
// impact so it reads as a fading "comet" tail.
function buildTrailLine(trajectory, base) {
  const pts = trajectory;
  if (!pts || pts.length < 2) return null;
  // down-sample long trajectories so each line stays cheap (~60 verts max)
  const stride = Math.max(1, Math.floor(pts.length / 60));
  const sampled = [];
  for (let i = 0; i < pts.length; i += stride) sampled.push(pts[i]);
  if (sampled[sampled.length - 1] !== pts[pts.length - 1]) sampled.push(pts[pts.length - 1]);
  const positions = [];
  const colors = [];
  const n = sampled.length;
  for (let i = 0; i < n; i++) {
    positions.push(sampled[i].x, sampled[i].y, 0);
    const a = 0.15 + (i / (n - 1)) * 0.85;
    colors.push(base.r * a, base.g * a, base.b * a);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  const line = new THREE.Line(geo, new THREE.LineBasicMaterial({
    vertexColors: true, transparent: true, opacity: 0.6, depthWrite: false,
  }));
  line.renderOrder = 2;
  return line;
}

// FIX: append a just-resolved shot to ITS shooter's own trail only — never clears
// or overwrites any other player's trail.
function addShotTrail(shooterId, projectiles) {
  let entry = playerTrails.get(shooterId);
  if (!entry) {
    entry = { group: new THREE.Group(), lines: [] };
    scene.add(entry.group);
    playerTrails.set(shooterId, entry);
  }
  // tint by the shooter's tank colour so you can tell whose trail is whose
  const shooter = state.tanks.find((t) => t.id === shooterId);
  const base = new THREE.Color(shooter ? shooter.color : '#ffcc66');
  // dim this player's older shots so their newest shot reads strongest
  for (const old of entry.lines) old.material.opacity *= 0.55;
  for (const proj of projectiles) {
    const line = buildTrailLine(proj.trajectory, base);
    if (!line) continue;
    entry.group.add(line);
    entry.lines.push(line);
  }
  // FIX: cap this player's history (drop oldest) to prevent unbounded growth
  while (entry.lines.length > MAX_TRAILS_PER_PLAYER) {
    const old = entry.lines.shift();
    entry.group.remove(old);
    old.geometry.dispose();
    old.material.dispose();
  }
}

// FIX: clear EVERY player's trail — called only on a new round/match, never per shot.
function clearAllTrails() {
  for (const { group } of playerTrails.values()) {
    scene.remove(group);
    group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
  }
  playerTrails.clear();
}

const dustTex = makeRadialTexture('rgba(180,160,130,0.8)', 'rgba(180,160,130,0)');
const dustPool = [];
const floaters = []; // floating damage / heal text

function spawnDust(x, y) {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: dustTex, transparent: true, opacity: 0.7, depthWrite: false }));
  s.position.set(x + (Math.random() - 0.5) * 4, y + 1.5, 2);
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
    d.s.scale.setScalar(3 + k * 5);
    d.s.material.opacity = 0.7 * (1 - k);
    if (d.t >= d.dur) { scene.remove(d.s); d.s.material.dispose(); dustPool.splice(i, 1); }
  }
}
let dustTimer = 0;

function makeTextSprite(text, color) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 96;
  const g = c.getContext('2d');
  g.font = 'bold 56px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineWidth = 8;
  g.strokeStyle = 'rgba(0,0,0,0.8)';
  g.strokeText(text, 128, 48);
  g.fillStyle = color;
  g.fillText(text, 128, 48);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false }));
  spr.scale.set(16, 6, 1);
  return spr;
}
function spawnFloater(x, y, text, color) {
  const spr = makeTextSprite(text, color);
  spr.position.set(x, y, 6);
  scene.add(spr);
  floaters.push({ spr, t: 0, dur: 1.3 });
}
function updateFloaters(dt) {
  for (let i = floaters.length - 1; i >= 0; i--) {
    const f = floaters[i];
    f.t += dt;
    const k = f.t / f.dur;
    f.spr.position.y += dt * 9;
    f.spr.material.opacity = 1 - k * k;
    if (f.t >= f.dur) {
      scene.remove(f.spr);
      f.spr.material.map.dispose();
      f.spr.material.dispose();
      floaters.splice(i, 1);
    }
  }
}

resizeCamera();
window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  if (composer) composer.setSize(window.innerWidth, window.innerHeight);
  resizeCamera();
});
renderer.domElement.addEventListener('wheel', (e) => {
  e.preventDefault();
  targetZoom = Math.max(0.6, Math.min(3.5, targetZoom * (1 - e.deltaY * 0.0012)));
}, { passive: false });

// ======================================================================
//  Sky / backdrop / textures
// ======================================================================
function makeSky(colors) {
  const c = document.createElement('canvas');
  c.width = 2; c.height = 256;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, colors[0]);
  grad.addColorStop(0.45, colors[1]);
  grad.addColorStop(0.8, colors[2]);
  grad.addColorStop(1, colors[3]);
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

function clearGroup(g) {
  for (let i = g.children.length - 1; i >= 0; i--) {
    const o = g.children[i];
    g.remove(o);
    if (o.material) { if (o.material.map) o.material.map.dispose(); o.material.dispose(); }
    if (o.geometry) o.geometry.dispose();
  }
}

function buildBackdrop(biome) {
  clearGroup(backdrop);
  clouds.length = 0;

  const sunSprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: makeRadialTexture('rgba(255,247,214,0.95)', 'rgba(255,240,180,0)'),
    transparent: true, depthTest: false, depthWrite: false,
  }));
  sunSprite.scale.set(130, 130, 1);
  sunSprite.position.set(-170, 130, -280);
  backdrop.add(sunSprite);

  const far = biome ? biome.high : '#7fa9cf';
  const near = biome ? biome.low : '#8fbf86';
  backdrop.add(makeHillLayer(shade(far, 0.78), 0.55, -320, 80, 48));
  backdrop.add(makeHillLayer(shade(near, 0.9), 0.85, -210, 52, 32));

  const cloudCount = biome && (biome.id === 'desert' || biome.id === 'wasteland') ? 3 : 6;
  const cloudTex = makeCloudTexture();
  for (let i = 0; i < cloudCount; i++) {
    const cl = new THREE.Sprite(new THREE.SpriteMaterial({ map: cloudTex, transparent: true, opacity: 0.8, depthTest: false, depthWrite: false }));
    const s = 60 + Math.random() * 70;
    cl.scale.set(s, s * 0.5, 1);
    cl.position.set(-380 + Math.random() * 760, 80 + Math.random() * 80, -260 - Math.random() * 60);
    cl.userData.drift = 4 + Math.random() * 6;
    backdrop.add(cl);
    clouds.push(cl);
  }
}

function shade(hex, mul) {
  const c = new THREE.Color(hex).multiplyScalar(mul);
  return '#' + c.getHexString();
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
    new THREE.PlaneGeometry(1100, height),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity, depthWrite: false, fog: true })
  );
  plane.position.set(0, baseY, z);
  return plane;
}

// ======================================================================
//  Terrain (biome-coloured 2.5D ribbon) + water
// ======================================================================
const _low = new THREE.Color(), _high = new THREE.Color(), _snow = new THREE.Color(0xffffff);
function topColor(h, out) {
  const b = state.biome;
  _low.set(b.low); _high.set(b.high);
  const t = Math.max(0, Math.min(1, (h - 8) / 56));
  out.copy(_low).lerp(_high, t);
  if (b.snowline) {
    const s = Math.max(0, Math.min(1, (h - b.snowline) / 16));
    out.lerp(_snow, s);
  }
}

// Render the heightmap at a higher resolution than the gameplay columns: the
// surface is sampled with a Catmull-Rom spline between columns so hills and
// craters look high-poly and smooth. Gameplay still uses the raw 1-unit columns
// (blast radii etc. are tuned in column units) — this is purely visual.
const TSUB = 3;
function smoothHeightAt(hm, fx) {
  const cols = hm.length;
  const i = Math.floor(fx);
  const t = fx - i;
  const p0 = hm[Math.max(0, i - 1)];
  const p1 = hm[Math.min(cols - 1, i)];
  const p2 = hm[Math.min(cols - 1, i + 1)];
  const p3 = hm[Math.min(cols - 1, i + 2)];
  const t2 = t * t, t3 = t2 * t;
  return 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

function buildTerrain() {
  if (terrainMesh) { scene.remove(terrainMesh); terrainMesh.geometry.dispose(); terrainMesh.material.dispose(); terrainMesh = null; }
  const cols = state.world.cols;
  const rcols = (cols - 1) * TSUB + 1;
  const geo = new THREE.BufferGeometry();
  const positions = new Float32Array(rcols * 3 * 3);
  const colors = new Float32Array(rcols * 3 * 3);
  const dirt = new THREE.Color(state.biome.dirt);
  const dirtDeep = new THREE.Color(state.biome.dirtDeep);
  for (let j = 0; j < rcols; j++) {
    const fx = j / TSUB;
    const h = smoothHeightAt(state.heightmap, fx);
    setVert(positions, j, fx, h, TERRAIN_DEPTH / 2);
    setVert(positions, rcols + j, fx, h, -TERRAIN_DEPTH / 2);
    setVert(positions, 2 * rcols + j, fx, BASE_Y, TERRAIN_DEPTH / 2);
    setColor(colors, rcols + j, dirt);
    setColor(colors, 2 * rcols + j, dirtDeep);
  }
  const idx = [];
  for (let j = 0; j < rcols - 1; j++) {
    const tf = j, tf1 = j + 1, tb = rcols + j, tb1 = rcols + j + 1, bf = 2 * rcols + j, bf1 = 2 * rcols + j + 1;
    idx.push(tf, tb, tf1, tf1, tb, tb1);
    idx.push(tf, tf1, bf, tf1, bf1, bf);
  }
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.setIndex(idx);
  const matl = new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.97, metalness: 0, flatShading: false });
  terrainMesh = new THREE.Mesh(geo, matl);
  terrainMesh.userData.rcols = rcols;
  terrainMesh.receiveShadow = true;
  scene.add(terrainMesh);
  refreshTerrain();
  buildWater();
}

function buildWater() {
  if (waterMesh) { scene.remove(waterMesh); waterMesh.geometry.dispose(); waterMesh.material.dispose(); waterMesh = null; }
  if (state.biome.water == null) return;
  const cols = state.world.cols;
  const geo = new THREE.PlaneGeometry(cols + 20, TERRAIN_DEPTH + 4);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshStandardMaterial({
    color: 0x2f86c4, transparent: true, opacity: 0.78, roughness: 0.25, metalness: 0.3,
  });
  waterMesh = new THREE.Mesh(geo, mat);
  waterMesh.position.set((cols - 1) / 2, state.biome.water, 0);
  waterMesh.renderOrder = 1;
  scene.add(waterMesh);
}

function setVert(arr, vi, x, y, z) { arr[vi * 3] = x; arr[vi * 3 + 1] = y; arr[vi * 3 + 2] = z; }
function setColor(arr, vi, c) { arr[vi * 3] = c.r; arr[vi * 3 + 1] = c.g; arr[vi * 3 + 2] = c.b; }

function refreshTerrain() {
  const rcols = terrainMesh.userData.rcols;
  const pos = terrainMesh.geometry.attributes.position;
  const col = terrainMesh.geometry.attributes.color;
  const c = new THREE.Color();
  for (let j = 0; j < rcols; j++) {
    const h = smoothHeightAt(state.heightmap, j / TSUB);
    pos.array[j * 3 + 1] = h;
    pos.array[(rcols + j) * 3 + 1] = h;
    topColor(h, c);
    setColor(col.array, j, c);
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

// ======================================================================
//  Tanks
// ======================================================================
function mat(color, rough, metal) {
  return new THREE.MeshStandardMaterial({ color, roughness: rough ?? 0.6, metalness: metal ?? 0.15 });
}

const SKIN_STYLE = {
  default: { metal: 0.3, rough: 0.55, base: null },
  desert:  { metal: 0.2, rough: 0.7,  base: 0xc9a45a },
  forest:  { metal: 0.2, rough: 0.7,  base: 0x4e7a3a },
  arctic:  { metal: 0.3, rough: 0.55, base: 0xdfe9f2 },
  carbon:  { metal: 0.75, rough: 0.35, base: 0x2b2f36 },
  gold:    { metal: 0.9, rough: 0.22, base: 0xffcf4a, emissive: 0x3a2a00 },
};

function tankBaseColor(tank) {
  const style = SKIN_STYLE[tank.skin] || SKIN_STYLE.default;
  return style.base != null ? new THREE.Color(style.base) : new THREE.Color(tank.color);
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

function makeHpGroup(barColor, atY) {
  const hpGroup = new THREE.Group();
  hpGroup.position.y = atY;
  const hpBg = new THREE.Mesh(new THREE.PlaneGeometry(13, 1.6), new THREE.MeshBasicMaterial({ color: 0x101319, transparent: true, opacity: 0.85, depthTest: false }));
  hpBg.renderOrder = 5;
  hpGroup.add(hpBg);
  const hpFill = new THREE.Mesh(new THREE.PlaneGeometry(12, 1).translate(6, 0, 0), new THREE.MeshBasicMaterial({ color: new THREE.Color(barColor), depthTest: false }));
  hpFill.position.set(-6, 0, 0.1);
  hpFill.renderOrder = 6;
  hpGroup.add(hpFill);
  return { hpGroup, hpFill };
}

// small team flag so sides are readable regardless of skin / colour
function makeTeamFlag(teamColor, atY) {
  const g = new THREE.Group();
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 5, 6), mat(0x222222, 0.7, 0.3));
  pole.position.y = atY + 2.5;
  g.add(pole);
  const flag = new THREE.Mesh(new THREE.PlaneGeometry(3, 1.8), new THREE.MeshBasicMaterial({ color: teamColor, side: THREE.DoubleSide }));
  flag.position.set(1.6, atY + 4, 0);
  g.add(flag);
  return g;
}

function facingFor(tank) {
  if (tank.id === state.youId && isMyTurn()) {
    return Number(dom.angle.value) >= 90 ? Math.PI : 0;
  }
  return tank.team === 0 ? 0 : Math.PI;
}

function buildTank(tank) {
  // NOTE: the bundled models/tank.glb is corrupt — its body/track meshes are
  // ~200x the scale of the turret and flung hundreds of units apart, so once the
  // model is normalised the tank renders as an invisible/garbled mess. Tanks are
  // therefore always built procedurally; the procedural tank looks good and fully
  // supports colour + skin customisation.
  buildProceduralTank(tank);
}

// Builds the visual tank (hull, turret, tracks, barrel) for a given colour/skin
// WITHOUT the HP bar / flag / scene registration, so it can be reused for both
// the in-game tank and the customize-screen preview.
function createTankVisual(opts) {
  const group = new THREE.Group();
  const style = SKIN_STYLE[opts.skin] || SKIN_STYLE.default;
  const team = style.base != null ? new THREE.Color(style.base) : new THREE.Color(opts.color || '#4ad9ff');
  const dark = team.clone().multiplyScalar(0.7);
  const trackMat = mat(0x23272e, 0.95, 0.1);

  const lower = new THREE.Mesh(new THREE.BoxGeometry(11, 2.2, 8), mat(dark, style.rough, style.metal));
  lower.position.y = 2.4;
  lower.castShadow = lower.receiveShadow = true;
  group.add(lower);

  const upper = new THREE.Mesh(new THREE.BoxGeometry(8.5, 2.4, 6.4), mat(team, style.rough, style.metal));
  upper.position.y = 4.4;
  upper.castShadow = true;
  group.add(upper);

  const glacis = new THREE.Mesh(new THREE.BoxGeometry(3.2, 2.6, 6.2), mat(team, style.rough, style.metal));
  glacis.position.set(5, 3.7, 0);
  glacis.rotation.z = -0.6;
  glacis.castShadow = true;
  group.add(glacis);

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

  // drive sprocket + idler at each end of the tracks (chunkier than road wheels)
  for (const sz of [-1, 1]) {
    for (const ex of [-5.3, 5.3]) {
      const sprocket = new THREE.Mesh(new THREE.CylinderGeometry(1.75, 1.75, 1.6, 10), trackMat);
      sprocket.rotation.x = Math.PI / 2;
      sprocket.position.set(ex, 1.7, sz * 3.6);
      sprocket.castShadow = true;
      group.add(sprocket);
      const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.7, 1.8, 8), mat(dark, 0.5, 0.4));
      hub.rotation.x = Math.PI / 2;
      hub.position.set(ex, 1.7, sz * 3.6);
      group.add(hub);
    }
  }

  // rear stowage basket + turret bustle (team colour)
  const basket = new THREE.Mesh(new THREE.BoxGeometry(2.2, 1.8, 5.6), mat(dark, 0.7, 0.2));
  basket.position.set(-5.4, 4.1, 0);
  basket.castShadow = true;
  group.add(basket);

  const turret = new THREE.Mesh(new THREE.SphereGeometry(3.1, 20, 14, 0, Math.PI * 2, 0, Math.PI / 2), mat(team, style.rough * 0.9, style.metal + 0.05));
  turret.scale.set(1.1, 0.85, 1);
  turret.position.y = 5.6;
  turret.castShadow = true;
  group.add(turret);

  const bustle = new THREE.Mesh(new THREE.BoxGeometry(3, 1.7, 4.4), mat(team, style.rough, style.metal));
  bustle.position.set(-2.7, 5.7, 0);
  bustle.castShadow = true;
  group.add(bustle);

  const cupola = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1.2, 12), mat(dark, 0.5, 0.3));
  cupola.position.set(-1, 7.4, 0);
  cupola.castShadow = true;
  group.add(cupola);

  // commander's machine-gun on the cupola
  const mg = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 2.6, 6), mat(0x15191f, 0.4, 0.5));
  mg.rotation.z = -Math.PI / 2;
  mg.position.set(0.6, 8, 0);
  group.add(mg);

  // smoke-grenade launcher banks on the turret cheeks
  for (const zz of [-1.7, 1.7]) {
    const bank = new THREE.Mesh(new THREE.BoxGeometry(1.3, 1, 1.4), mat(dark, 0.5, 0.4));
    bank.position.set(1.7, 5.9, zz);
    group.add(bank);
  }

  // headlights on the glacis
  for (const zz of [-2.1, 2.1]) {
    const lamp = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.4, 10), mat(0xfff3c0, 0.3, 0.2));
    lamp.material.emissive = new THREE.Color(0xfff0b0);
    lamp.material.emissiveIntensity = 0.6;
    lamp.rotation.z = Math.PI / 2;
    lamp.position.set(5.7, 3.4, zz);
    group.add(lamp);
  }

  // exhaust pipes down the left rear
  for (const zz of [2.2, 3.1]) {
    const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 2.2, 8), mat(0x2a2a2a, 0.7, 0.4));
    pipe.rotation.x = Math.PI / 2;
    pipe.position.set(-3.4, 3.3, -zz);
    group.add(pipe);
  }

  // whip antenna with a red tip
  const antenna = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 7, 5), mat(0x111111, 0.6, 0.3));
  antenna.position.set(-1.6, 9.2, -1.6);
  group.add(antenna);
  const antTip = new THREE.Mesh(new THREE.SphereGeometry(0.26, 8, 8), mat(0xff4444, 0.4, 0.2));
  antTip.position.set(-1.6, 12.7, -1.6);
  group.add(antTip);

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
  // fume extractor bulge midway along the gun
  const fume = new THREE.Mesh(new THREE.CylinderGeometry(0.82, 0.82, 1.4, 12), mat(0x20262d, 0.35, 0.6));
  fume.rotation.z = -Math.PI / 2;
  fume.position.x = 4.4;
  barrelPivot.add(fume);
  const muzzle = new THREE.Mesh(new THREE.CylinderGeometry(0.85, 0.85, 1.2, 14), mat(0x15191f, 0.4, 0.6));
  muzzle.rotation.z = -Math.PI / 2;
  muzzle.position.x = 8.8;
  barrelPivot.add(muzzle);

  if (style.emissive) {
    for (const m of [upper, glacis, turret, bustle]) { m.material.emissive = new THREE.Color(style.emissive); m.material.emissiveIntensity = 0.5; }
  }

  group.add(barrelPivot);
  return { group, barrelPivot };
}

function buildProceduralTank(tank) {
  const { group, barrelPivot } = createTankVisual({ color: tank.color, skin: tank.skin });

  const flash = makeFlash(9.8, 0);
  barrelPivot.add(flash);

  const { hpGroup, hpFill } = makeHpGroup(tank.color, 12);
  group.add(hpGroup);
  group.add(makeTeamFlag(tank.teamColor || tank.color, 9));

  group.position.set(tank.x, tank.y, 0);
  scene.add(group);
  tankMeshes.set(tank.id, { kind: 'proc', group, modelGroup: null, barrelPivot, flash, hpFill, hpGroup, targetX: tank.x, targetY: tank.y, flashT: 0 });
  updateHpBar(tank);
}

function updateHpBar(tank) {
  const ref = tankMeshes.get(tank.id);
  if (!ref) return;
  const f = Math.max(0, tank.hp) / (tank.maxHp || 100);
  ref.hpFill.scale.x = f <= 0.001 ? 0.001 : f;
  ref.hpFill.material.color.copy(new THREE.Color().setHSL(0.33 * f, 0.85, 0.5));
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

// ======================================================================
//  Destructible props
// ======================================================================
function buildPropMesh(prop) {
  const g = new THREE.Group();
  const t = prop.type;
  if (t === 'barrel') {
    const body = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 2.2, 5, 14), mat(0xb5462e, 0.5, 0.5));
    body.position.y = 2.5; body.castShadow = body.receiveShadow = true; g.add(body);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(2.25, 0.18, 8, 18), mat(0x2a2a2a, 0.6, 0.5));
    ring.rotation.x = Math.PI / 2; ring.position.y = 2.5; g.add(ring);
  } else if (t === 'crate') {
    const box = new THREE.Mesh(new THREE.BoxGeometry(4.5, 4.5, 4.5), mat(0xb98a4b, 0.85, 0.05));
    box.position.y = 2.3; box.castShadow = box.receiveShadow = true; g.add(box);
    const edge = new THREE.Mesh(new THREE.BoxGeometry(4.7, 0.5, 4.7), mat(0x8a6536, 0.85, 0.05));
    edge.position.y = 2.3; g.add(edge);
  } else if (t === 'rock') {
    const r = new THREE.Mesh(new THREE.DodecahedronGeometry(3.4, 0), mat(0x808890, 0.95, 0.05));
    r.position.y = 2.6; r.rotation.set(Math.random(), Math.random(), Math.random());
    r.castShadow = r.receiveShadow = true; g.add(r);
  } else if (t === 'tree') {
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.9, 5, 8), mat(0x6b4a2a, 0.9, 0));
    trunk.position.y = 2.5; trunk.castShadow = true; g.add(trunk);
    const leaves = new THREE.Mesh(new THREE.SphereGeometry(3.4, 12, 10), mat(0x3f8f3a, 0.9, 0));
    leaves.position.y = 6.5; leaves.scale.y = 1.1; leaves.castShadow = true; g.add(leaves);
  } else if (t === 'pine') {
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.8, 4, 8), mat(0x6b4a2a, 0.9, 0));
    trunk.position.y = 2; trunk.castShadow = true; g.add(trunk);
    for (let k = 0; k < 3; k++) {
      const cone = new THREE.Mesh(new THREE.ConeGeometry(3 - k * 0.7, 3, 10), mat(0x2f7d4f, 0.9, 0));
      cone.position.y = 4.2 + k * 2; cone.castShadow = true; g.add(cone);
    }
  } else if (t === 'cactus') {
    const body = new THREE.Mesh(new THREE.CylinderGeometry(1, 1.1, 5.5, 10), mat(0x3f8a4a, 0.85, 0));
    body.position.y = 2.8; body.castShadow = true; g.add(body);
    const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.55, 2.4, 8), mat(0x3f8a4a, 0.85, 0));
    arm.position.set(1.3, 3.6, 0); arm.rotation.z = -0.5; g.add(arm);
  } else if (t === 'palm') {
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.8, 7, 8), mat(0x8a6a3a, 0.9, 0));
    trunk.position.y = 3.5; trunk.rotation.z = 0.12; trunk.castShadow = true; g.add(trunk);
    for (let k = 0; k < 5; k++) {
      const frond = new THREE.Mesh(new THREE.ConeGeometry(0.8, 4.5, 6), mat(0x46a05a, 0.85, 0));
      frond.position.set(0, 7, 0);
      frond.rotation.z = Math.PI / 2 - 0.6;
      frond.rotation.y = (k / 5) * Math.PI * 2;
      g.add(frond);
    }
  } else if (t === 'boulder') {
    const stoneMat = mat(0x8b8f96, 0.96, 0.04);
    const main = new THREE.Mesh(new THREE.DodecahedronGeometry(5, 0), stoneMat);
    main.position.y = 4.2; main.rotation.set(Math.random(), Math.random(), Math.random());
    main.castShadow = main.receiveShadow = true; g.add(main);
    const chip = new THREE.Mesh(new THREE.DodecahedronGeometry(2.4, 0), stoneMat);
    chip.position.set(3.4, 2, 1.2); chip.rotation.set(Math.random(), Math.random(), 0);
    chip.castShadow = true; g.add(chip);
  } else if (t === 'arch') {
    const stoneMat = mat(0x9a8d72, 0.92, 0.05);
    for (const sx of [-3.6, 3.6]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(2.6, 9, 3.2), stoneMat);
      leg.position.set(sx, 4.5, 0); leg.castShadow = leg.receiveShadow = true; g.add(leg);
    }
    const span = new THREE.Mesh(new THREE.BoxGeometry(11, 2.6, 3.2), stoneMat);
    span.position.y = 10; span.castShadow = true; g.add(span);
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(3.4, 3.4, 3.2, 14, 1, false, 0, Math.PI), stoneMat);
    cap.rotation.z = Math.PI / 2; cap.rotation.y = Math.PI / 2; cap.position.y = 10; g.add(cap);
  } else if (t === 'ruin') {
    const wallMat = mat(0xb8a98c, 0.9, 0.05);
    const base = new THREE.Mesh(new THREE.BoxGeometry(11, 6, 3), wallMat);
    base.position.y = 3; base.castShadow = base.receiveShadow = true; g.add(base);
    // broken merlons along the top
    for (let k = -1; k <= 1; k++) {
      if (k === 0) continue;
      const m = new THREE.Mesh(new THREE.BoxGeometry(2.6, 3 + Math.random() * 2, 3), wallMat);
      m.position.set(k * 3.6, 6.5, 0); m.castShadow = true; g.add(m);
    }
    const crack = new THREE.Mesh(new THREE.BoxGeometry(0.6, 4, 3.2), mat(0x7a6e58, 0.95, 0));
    crack.position.set(1.5, 3.5, 0.1); g.add(crack);
  } else {
    const box = new THREE.Mesh(new THREE.BoxGeometry(3, 3, 3), mat(0x888888, 0.9, 0.1));
    box.position.y = 1.6; box.castShadow = true; g.add(box);
  }
  g.position.set(prop.x, prop.y, 0);
  g.rotation.y = Math.random() * 0.4 - 0.2;
  return g;
}

function syncProps() {
  const seen = new Set();
  for (const p of state.props) {
    seen.add(p.id);
    if (propMeshes.has(p.id)) continue;
    const mesh = buildPropMesh(p);
    scene.add(mesh);
    propMeshes.set(p.id, mesh);
  }
  for (const [id, mesh] of propMeshes) {
    if (!seen.has(id)) {
      // a removed prop = destroyed: pop some debris
      spawnExplosion(mesh.position.x, mesh.position.y + 2, 12, 0xffae5a, false);
      scene.remove(mesh);
      disposeGroup(mesh);
      propMeshes.delete(id);
    }
  }
}

function disposeGroup(g) {
  g.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) { if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose()); else o.material.dispose(); }
  });
}

// ======================================================================
//  Pickups
// ======================================================================
function makeHalo(inner, scale) {
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({
    map: makeRadialTexture(inner, inner.replace(/[\d.]+\)$/, '0)')),
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  halo.scale.set(scale, scale, 1);
  return halo;
}

function roundRectPath(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

// Flat, cartoonish 2D crate art (bold outline, top highlight, chunky shadow).
// Drawn on a canvas and shown as a billboard sprite so crates always read 2D.
function makeCrateTexture(kind, tintHex) {
  const c = document.createElement('canvas');
  c.width = c.height = 160;
  const g = c.getContext('2d');
  const X = 22, Y = 22, W = 116, H = 116, R = 18;
  const ink = '#2a3142';

  let base = '#c98a4b', light = '#e6b675', strap = '#8a5a2c';
  if (kind === 'health') { base = '#ffffff'; light = '#ffffff'; strap = '#e23b3b'; }
  else if (kind === 'bonus') { base = '#ffd24a'; light = '#fff0b0'; strap = '#cf7a17'; }
  else if (kind === 'weapon') {
    const tint = '#' + (tintHex >>> 0).toString(16).padStart(6, '0');
    strap = tint; base = '#c98a4b'; light = '#e6b675';
  }

  // drop shadow
  g.fillStyle = 'rgba(42,49,66,0.28)';
  roundRectPath(g, X + 5, Y + 9, W, H, R); g.fill();

  // body
  const grad = g.createLinearGradient(0, Y, 0, Y + H);
  grad.addColorStop(0, light); grad.addColorStop(1, base);
  g.fillStyle = grad;
  roundRectPath(g, X, Y, W, H, R); g.fill();
  g.lineWidth = 9; g.strokeStyle = ink; g.lineJoin = 'round';
  roundRectPath(g, X, Y, W, H, R); g.stroke();

  // top glossy highlight
  g.fillStyle = 'rgba(255,255,255,0.45)';
  roundRectPath(g, X + 14, Y + 12, W - 28, 20, 10); g.fill();

  const cx = X + W / 2, cy = Y + H / 2;
  g.lineWidth = 8; g.lineCap = 'round';
  if (kind === 'health') {
    g.fillStyle = '#e23b3b';
    g.fillRect(cx - 11, cy - 32, 22, 64);
    g.fillRect(cx - 32, cy - 11, 64, 22);
  } else if (kind === 'bonus') {
    // a chunky star
    g.fillStyle = '#fff6cf'; g.strokeStyle = ink; g.lineWidth = 6; g.lineJoin = 'round';
    g.beginPath();
    for (let i = 0; i < 10; i++) {
      const ang = -Math.PI / 2 + (i * Math.PI) / 5;
      const rr = i % 2 === 0 ? 34 : 15;
      const px = cx + Math.cos(ang) * rr, py = cy + Math.sin(ang) * rr;
      i === 0 ? g.moveTo(px, py) : g.lineTo(px, py);
    }
    g.closePath(); g.fill(); g.stroke();
  } else {
    // weapon crate: diagonal straps in the weapon tint + a colour dot
    g.strokeStyle = strap; g.lineWidth = 12;
    g.beginPath(); g.moveTo(X + 8, Y + 8); g.lineTo(X + W - 8, Y + H - 8); g.stroke();
    g.beginPath(); g.moveTo(X + W - 8, Y + 8); g.lineTo(X + 8, Y + H - 8); g.stroke();
    g.beginPath(); g.arc(cx, cy, 17, 0, Math.PI * 2);
    g.fillStyle = strap; g.fill();
    g.lineWidth = 6; g.strokeStyle = ink; g.stroke();
    g.fillStyle = 'rgba(255,255,255,0.85)';
    g.beginPath(); g.arc(cx - 5, cy - 5, 5, 0, Math.PI * 2); g.fill();
  }

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function syncPickups() {
  const seen = new Set();
  for (const pk of state.pickups) {
    seen.add(pk.id);
    if (pickupMeshes.has(pk.id)) continue;
    const grp = new THREE.Group();
    let spinRate = 0;
    let halo = 'rgba(255,255,255,0.55)';
    if (pk.type === 'health') halo = 'rgba(255,90,90,0.6)';
    else if (pk.type === 'bonus') { halo = 'rgba(255,216,90,0.75)'; spinRate = 2.6; }

    grp.add(makeHalo(halo, 13));

    const tint = (WEAPON_FX[pk.weapon] || WEAPON_FX.standard).proj;
    const crate = new THREE.Sprite(new THREE.SpriteMaterial({
      map: makeCrateTexture(pk.type || 'weapon', tint),
      transparent: true, depthWrite: false,
    }));
    crate.scale.set(8, 8, 1);
    grp.add(crate);
    grp.userData.crate = crate;

    grp.position.set(pk.x, pk.y + 5.5, 1);
    grp.userData.baseY = pk.y + 5.5;
    grp.userData.spinRate = spinRate;
    scene.add(grp);
    pickupMeshes.set(pk.id, grp);
  }
  for (const [id, mesh] of pickupMeshes) {
    if (!seen.has(id)) {
      // pickup sprites use unique canvas/radial textures, so dispose their maps too
      mesh.traverse((o) => { if (o.material && o.material.map) o.material.map.dispose(); });
      scene.remove(mesh); disposeGroup(mesh); pickupMeshes.delete(id);
    }
  }
}

// ======================================================================
//  Napalm fire zones (lingering hazards)
// ======================================================================
const fireTex = makeRadialTexture('rgba(255,210,90,0.95)', 'rgba(255,70,20,0)');
function syncHazards() {
  const seen = new Set();
  for (const hz of (state.hazards || [])) {
    seen.add(hz.id);
    if (hazardMeshes.has(hz.id)) continue;
    const grp = new THREE.Group();
    const flames = [];
    const n = Math.max(3, Math.round(hz.span / 7));
    for (let k = 0; k < n; k++) {
      const fx = hz.x - hz.span / 2 + (k / (n - 1)) * hz.span;
      const spr = new THREE.Sprite(new THREE.SpriteMaterial({
        map: fireTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, color: 0xff7a2a,
      }));
      spr.position.set(fx, heightAtClient(fx) + 3, 3);
      spr.userData = { phase: Math.random() * 6.28, baseX: fx };
      grp.add(spr);
      flames.push(spr);
    }
    const light = new THREE.PointLight(0xff6a2a, 2.2, hz.span * 1.5);
    light.position.set(hz.x, heightAtClient(hz.x) + 6, 8);
    grp.add(light);
    grp.userData = { flames };
    scene.add(grp);
    hazardMeshes.set(hz.id, grp);
  }
  for (const [id, grp] of hazardMeshes) {
    if (!seen.has(id)) { scene.remove(grp); disposeGroup(grp); hazardMeshes.delete(id); }
  }
}
function updateHazards(dt) {
  for (const grp of hazardMeshes.values()) {
    for (const spr of grp.userData.flames) {
      spr.userData.phase += dt * 8;
      const ph = spr.userData.phase;
      const s = 7 + Math.sin(ph) * 2.2;
      spr.scale.set(s, s * 1.35, 1);
      spr.material.opacity = 0.55 + Math.sin(ph * 1.3) * 0.3;
      spr.position.y = heightAtClient(spr.userData.baseX) + 3 + Math.sin(ph) * 0.6;
    }
  }
}

// ======================================================================
//  HUD
// ======================================================================
function pushLog(text) {
  const line = document.createElement('div');
  line.className = 'log-line';
  line.textContent = text;
  dom.log.prepend(line);
  while (dom.log.children.length > 4) dom.log.removeChild(dom.log.lastChild);
  setTimeout(() => line.remove(), 5000);
}

let toastTimer = null;
function showToast(text) {
  const el = $('toast');
  if (!el) { pushLog(text); return; }
  el.textContent = text;
  el.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

// Slot-machine "case opening": the reel of weapon cards spins and decelerates
// onto the weapon you just unlocked from the crate.
let crateSpinning = false;
function openCrateSpinner(wonWeapon) {
  const overlay = $('crate-open'), reel = $('co-reel'), win = $('co-window'), result = $('co-result');
  if (crateSpinning || !overlay || !reel || !win || !state.weaponDefs || !state.weaponDefs[wonWeapon]) return;
  crateSpinning = true;
  result.textContent = '';

  const ids = Object.keys(state.weaponDefs);
  const STEP = 108;            // 96px card + 6px margin each side
  const COUNT = 44, LAND = 38; // land near the end so the reel still looks full
  reel.innerHTML = '';
  for (let i = 0; i < COUNT; i++) {
    const id = i === LAND ? wonWeapon : ids[Math.floor(Math.random() * ids.length)];
    const def = state.weaponDefs[id] || { name: id };
    const hex = ((WEAPON_FX[id] || WEAPON_FX.standard).proj).toString(16).padStart(6, '0');
    const card = document.createElement('div');
    card.className = 'co-card';
    card.innerHTML = `<span class="cc-dot" style="background:#${hex};color:#${hex}"></span><span class="cc-name">${def.name}</span>`;
    reel.appendChild(card);
  }

  overlay.classList.remove('hidden');
  reel.style.transition = 'none';
  reel.style.transform = 'translateX(0px)';
  void reel.offsetWidth; // reflow so the next transform animates from 0

  const center = win.clientWidth / 2;
  const cardCenter = LAND * STEP + STEP / 2;
  const jitter = (Math.random() * 2 - 1) * 26;     // randomise where on the card it stops
  const target = center - cardCenter + jitter;
  requestAnimationFrame(() => {
    reel.style.transition = 'transform 3.4s cubic-bezier(0.12, 0.7, 0.12, 1)';
    reel.style.transform = `translateX(${target}px)`;
  });

  const def = state.weaponDefs[wonWeapon] || { name: wonWeapon };
  setTimeout(() => { result.innerHTML = `You unlocked <b>${def.name}</b>!`; }, 3450);
  setTimeout(() => { overlay.classList.add('hidden'); crateSpinning = false; }, 5200);
}

function myTank() { return state.tanks.find((t) => t.id === state.youId); }
function activeTank() { return state.tanks.find((t) => t.id === state.activePlayerId); }

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
  if (state.biome) dom.hudBiome.textContent = state.biome.name;
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
    row.querySelector('.hp-fill').style.width = `${Math.max(0, tank.hp) / (tank.maxHp || 100) * 100}%`;
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
    if (!def) continue;
    const ammo = me.weapons[w];
    const fx = WEAPON_FX[w] || WEAPON_FX.standard;
    const btn = document.createElement('button');
    btn.className = 'weapon-btn' + (w === state.currentWeapon ? ' selected' : '');
    btn.innerHTML = `<span class="wb-dot" style="background:#${fx.proj.toString(16).padStart(6, '0')}"></span>${def.name} <b>${ammo < 0 ? '∞' : `x${ammo}`}</b>`;
    btn.addEventListener('click', () => { state.currentWeapon = w; buildWeapons(); });
    dom.weapons.appendChild(btn);
  }
}

function isMyTurn() { return !state.gameOver && !anim && state.activePlayerId === state.youId; }

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

// ======================================================================
//  Aiming / driving input
// ======================================================================
dom.angle.addEventListener('input', () => { dom.angleVal.textContent = dom.angle.value; });
dom.power.addEventListener('input', () => { dom.powerVal.textContent = dom.power.value; });

dom.fireBtn.addEventListener('click', fire);
function fire() {
  if (!isMyTurn()) return;
  dom.fireBtn.disabled = true;
  driveDir = 0;
  socket.emit('moveTo', { x: localTargetX });
  socket.emit('fire', {
    angle: Number(dom.angle.value),
    power: Number(dom.power.value),
    weapon: state.currentWeapon,
  });
}

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

  dustTimer -= dt;
  if (dustTimer <= 0) { spawnDust(nx - driveDir * 6, me.y); dustTimer = 0.06; }

  const now = performance.now();
  if (now - lastMoveEmit > 55) { lastMoveEmit = now; socket.emit('moveTo', { x: nx }); }
}

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
renderer.domElement.addEventListener('pointermove', (e) => { if (aiming) applyAimFromPoint(e.clientX, e.clientY); });
const endAim = (e) => {
  if (!aiming) return;
  aiming = false;
  try { renderer.domElement.releasePointerCapture(e.pointerId); } catch (_) {}
};
renderer.domElement.addEventListener('pointerup', endAim);
renderer.domElement.addEventListener('pointercancel', endAim);

// ======================================================================
//  Socket / game flow
// ======================================================================
function cleanupGame() {
  for (const [, ref] of tankMeshes) { scene.remove(ref.group); disposeGroup(ref.group); }
  tankMeshes.clear();
  for (const [, m] of pickupMeshes) { m.traverse((o) => { if (o.material && o.material.map) o.material.map.dispose(); }); scene.remove(m); disposeGroup(m); }
  pickupMeshes.clear();
  for (const [, m] of propMeshes) { scene.remove(m); disposeGroup(m); }
  propMeshes.clear();
  for (const [, m] of hazardMeshes) { scene.remove(m); disposeGroup(m); }
  hazardMeshes.clear();
  for (const z of zaps) { scene.remove(z.line); z.line.geometry.dispose(); z.line.material.dispose(); }
  zaps.length = 0;
  for (const ex of explosions) { scene.remove(ex.mesh); ex.mesh.material.dispose(); if (ex.light) scene.remove(ex.light); }
  explosions.length = 0;
  for (const f of floaters) { scene.remove(f.spr); f.spr.material.map.dispose(); f.spr.material.dispose(); }
  floaters.length = 0;
  anim = null; pending = null; trailPoints = [];
  projectileMesh.visible = false; projLight.intensity = 0; trail.visible = false;
  clearAllTrails(); // FIX: clear EVERY player's trail — only here, at the start of a new round/match
}

socket.on('roomCreated', ({ code, mode, capacity }) => {
  $('wait-code').textContent = code;
  $('wait-msg').textContent = `Share the code. Waiting for players… 1/${capacity}`;
  showScreen('screen-wait');
});
socket.on('lobbyUpdate', ({ count, capacity }) => {
  $('wait-msg').textContent = `Waiting for players… ${count}/${capacity}`;
});
socket.on('queueUpdate', ({ count, capacity }) => {
  $('queue-status').textContent = `Searching… ${count}/${capacity} ready`;
});
socket.on('errorMsg', ({ message }) => {
  if (state.world && dom.overlay.classList.contains('hidden')) {
    pushLog(message);
  } else {
    $('menu-msg').textContent = message;
  }
  updateControls();
});

socket.on('gameStart', (data) => {
  cleanupGame();
  state.youId = data.youId;
  state.mode = data.mode;
  state.world = data.world;
  state.heightmap = data.heightmap;
  state.tanks = data.tanks;
  state.props = data.props || [];
  state.wind = data.wind;
  state.activePlayerId = data.activePlayerId;
  state.pickups = data.pickups;
  state.hazards = data.hazards || [];
  state.weaponDefs = data.weapons;
  state.moveRange = data.moveRange || 60;
  state.maxHp = data.maxHp || 100;
  state.biome = data.biome;
  state.gameOver = false;

  // biome-driven visuals
  scene.background = makeSky(state.biome.sky);
  scene.fog.color = new THREE.Color(state.biome.fog);
  buildBackdrop(state.biome);

  buildTerrain();
  syncProps();
  syncHazards();
  syncTanks();
  buildTeams();
  buildWeapons();

  const me = myTank();
  dom.angle.value = me && me.team === 1 ? 135 : 45;
  dom.angleVal.textContent = dom.angle.value;
  dom.power.value = 60;
  dom.powerVal.textContent = '60';
  focusX = me ? me.x : (state.world.cols - 1) / 2;
  camX = focusX;
  resetDrivePrediction();

  dom.hudRoom.textContent = `Room ${data.code} · ${data.mode}`;
  hideOverlay();
  refreshHud();
  refreshFuel();
  updateControls();
});

// Log + floaters for a collected crate; also applies a health crate's HP so the
// bar updates immediately (weapon/bonus ammo is reflected by the server state).
function applyCollected(collected) {
  let healed = false;
  for (const c of collected) {
    const ct = state.tanks.find((s) => s.id === c.tankId);
    if (c.type === 'health') {
      if (ct && typeof c.hp === 'number') { ct.hp = c.hp; updateHpBar(ct); healed = true; }
      if (ct) spawnFloater(ct.x, ct.y + 20, `+${c.heal} HP`, '#5dff8a');
      pushLog(`${ct ? ct.name : '?'} grabbed a Health Crate (+${c.heal} HP)!`);
    } else if (c.type === 'bonus') {
      if (ct) spawnFloater(ct.x, ct.y + 20, `+${c.coins} ◎`, '#ffd24a');
      pushLog(`${ct ? ct.name : '?'} cracked a Bonus Crate (+${c.coins} ◎)!`);
    } else {
      const def = state.weaponDefs[c.weapon];
      pushLog(`${ct ? ct.name : '?'} grabbed ${def ? def.name : 'ammo'}!`);
    }
  }
  if (healed) refreshTeams();
}

socket.on('tankMoved', ({ id, x, y, fuel, collected, pickups }) => {
  const t = state.tanks.find((s) => s.id === id);
  if (t) { t.x = x; t.y = y; t.fuel = fuel; }
  state.pickups = pickups;
  syncPickups();

  if (id === state.youId) {
    if (Math.abs(x - localTargetX) > 3) localTargetX = x;
    localFuel = fuel;
  } else {
    const ref = tankMeshes.get(id);
    if (ref) { ref.targetX = x; ref.targetY = y; }
  }
  applyCollected(collected);
  if (collected.length) buildWeapons();
  refreshFuel();
  updateControls();
});

socket.on('shotResolved', (data) => {
  pending = data;
  // FIX: keep data.shooterId on the anim so the finished shot is attributed to the
  // correct player's trail (was anonymous before).
  anim = { projectiles: data.projectiles, pi: 0, prog: 0, phase: 'fly', boom: 0, shooterId: data.shooterId };
  trailPoints = [];
  // FIX: do NOT clear trails here — a player firing must not erase anyone's trail,
  // not even their own (older shots are dimmed/capped in addShotTrail instead).
  driveDir = 0;
  dom.fireBtn.disabled = true;
  updateControls();
  const ref = tankMeshes.get(data.shooterId);
  if (ref) ref.flashT = 0.12;
});

socket.on('opponentLeft', ({ message }) => {
  state.gameOver = true;
  updateControls();
  showResult('Match ended', message, null);
});

function applyPending() {
  state.heightmap = pending.heightmap;
  state.tanks = pending.tanks;
  state.props = pending.props || [];
  state.hazards = pending.hazards || [];
  refreshTerrain();
  if (waterMesh) waterMesh.position.x = (state.world.cols - 1) / 2;
  syncTanks();
  syncProps();
  syncHazards();

  for (const d of pending.damages) {
    const t = state.tanks.find((x) => x.id === d.id);
    pushLog(`${t ? t.name : '?'} took ${d.amount}${d.dead ? ' — destroyed!' : ''}`);
    if (t) spawnFloater(t.x, t.y + 16, `-${d.amount}`, '#ff6a5a');
  }
  for (const h of (pending.heals || [])) {
    const t = state.tanks.find((x) => x.id === h.id);
    if (t) { spawnFloater(t.x, t.y + 20, `+${h.amount} HP`, '#5dff8a'); pushLog(`${t.name} recovered ${h.amount} HP!`); }
  }
  applyCollected(pending.collected);

  const next = pending.next;
  if (next && next.terrainReform) {
    showToast('⚠ The battlefield is settling — the ground levels out!');
  }
  if (next.type === 'gameOver') {
    state.gameOver = true;
    const me = myTank();
    const won = me && next.winnerTeam === me.team;
    const reward = next.rewards ? next.rewards[state.youId] : null;
    grantReward(reward, won, next.winnerTeam);
    showResult(
      won ? 'Victory!' : next.winnerTeam === null ? 'Draw' : 'Defeat',
      won ? 'Your team wins the battle.' : next.winnerTeam === null ? 'Both sides fell.' : 'Your team was destroyed.',
      reward
    );
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

// ======================================================================
//  Explosions / animation / camera (renderer loop)
// ======================================================================
function spawnExplosion(x, y, radius, color, big) {
  const mesh = new THREE.Mesh(boomGeo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.92, depthWrite: false }));
  mesh.position.set(x, y, 0);
  mesh.scale.setScalar(radius * 0.4);
  scene.add(mesh);
  let light = null;
  if (big) {
    light = new THREE.PointLight(color, 7, radius * 7);
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
    if (ex.light) ex.light.intensity = 7 * (1 - k);
    if (ex.t >= ex.dur) {
      scene.remove(ex.mesh);
      ex.mesh.material.dispose();
      if (ex.light) scene.remove(ex.light);
      explosions.splice(i, 1);
    }
  }
}

// ---- elemental shot effects (lightning bolts + black-hole swirl) ----
const zaps = [];
const vortexTex = makeRadialTexture('rgba(150,90,240,0)', 'rgba(120,60,210,0.85)');
function makeZap(ax, ay, bx, by, color) {
  const segs = 11;
  const pts = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const jitter = i > 0 && i < segs ? (Math.random() - 0.5) : 0;
    pts.push(new THREE.Vector3(ax + (bx - ax) * t + jitter * 6, ay + (by - ay) * t + jitter * 5, 4));
  }
  const geo = new THREE.BufferGeometry().setFromPoints(pts);
  const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 1, depthTest: false }));
  line.renderOrder = 4;
  scene.add(line);
  zaps.push({ line, t: 0, dur: 0.4 });
}
function spawnLightning(impact, chainImpact) {
  makeZap(impact.x, impact.y + 130, impact.x, impact.y, 0xeaf6ff);
  if (chainImpact) makeZap(impact.x, impact.y + 2, chainImpact.x, chainImpact.y + 2, 0x9fe8ff);
}
function updateZaps(dt) {
  for (let i = zaps.length - 1; i >= 0; i--) {
    const z = zaps[i];
    z.t += dt;
    z.line.material.opacity = Math.max(0, 1 - z.t / z.dur);
    if (z.t >= z.dur) { scene.remove(z.line); z.line.geometry.dispose(); z.line.material.dispose(); zaps.splice(i, 1); }
  }
}
function spawnVortex(impact, radius) {
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: vortexTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
  spr.position.set(impact.x, impact.y + 5, 5);
  spr.scale.set(radius * 3, radius * 3, 1);
  scene.add(spr);
  explosions.push({ mesh: spr, light: null, t: 0, dur: 0.65, radius });
}

function detonate(proj) {
  const fx = WEAPON_FX[proj.kind] || WEAPON_FX.standard;
  if (proj.kind === 'earthmover') {
    // building a wall, not blowing a hole: throw up dirt instead of a fireball
    for (let k = 0; k < 9; k++) spawnDust(proj.impact.x + (Math.random() - 0.5) * proj.blastRadius * 2.2, proj.impact.y);
    spawnExplosion(proj.impact.x, proj.impact.y, proj.blastRadius, fx.boom, false);
    shake = Math.min(9, shake + 3);
    return;
  }
  spawnExplosion(proj.impact.x, proj.impact.y, proj.blastRadius, fx.boom, true);
  if (proj.subImpacts) {
    for (const si of proj.subImpacts) spawnExplosion(si.x, si.y, si.radius, fx.boom, false);
  }
  if (proj.kind === 'lightning') spawnLightning(proj.impact, proj.chainImpact);
  if (proj.kind === 'blackhole') spawnVortex(proj.impact, proj.blastRadius);
  if (proj.kind === 'napalm') {
    for (let k = 0; k < 5; k++) spawnDust(proj.impact.x + (Math.random() - 0.5) * proj.blastRadius, proj.impact.y);
  }
}

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

// REMOVED: updatePreview() — drew the predicted trajectory of the shot currently
// being aimed (the "guideline"). Deleted so aiming gives no landing hint. The
// post-shot reference is now provided by the per-player trails (addShotTrail).

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
    projLight.intensity = 1.8;
    focusX = px;
    trail.material.color.setHex(fx.proj);
    trailPoints.push(new THREE.Vector3(px, py, 0));
    if (trailPoints.length > 28) trailPoints.shift();
    if (trailPoints.length > 1) { trail.geometry.setFromPoints(trailPoints); trail.visible = true; }
  } else {
    anim.boom += dt;
    if (anim.boom >= BOOM_TIME) {
      anim.pi += 1;
      if (anim.pi >= anim.projectiles.length) {
        addShotTrail(anim.shooterId, anim.projectiles); // FIX: append to this shooter's own trail (per-player, persists)
        anim = null;
        applyPending();
      }
      else { anim.phase = 'fly'; anim.prog = 0; trailPoints = []; }
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
  if (halfW * 2 >= cols) target = (cols - 1) / 2;
  else target = Math.max(halfW, Math.min(cols - 1 - halfW, focusX));
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
  updateFloaters(dt);

  for (const tank of state.tanks) {
    const ref = tankMeshes.get(tank.id);
    if (!ref) continue;
    const k = 1 - Math.exp(-14 * dt);
    ref.group.position.x += (ref.targetX - ref.group.position.x) * k;
    ref.group.position.y += (ref.targetY - ref.group.position.y) * k;
    if (ref.barrelPivot) ref.barrelPivot.rotation.z = (barrelAngleFor(tank) * Math.PI) / 180;
    if (ref.modelGroup) {
      const target = facingFor(tank);
      ref.modelGroup.rotation.y += (target - ref.modelGroup.rotation.y) * (1 - Math.exp(-9 * dt));
    }
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
    grp.position.y = grp.userData.baseY + Math.sin(clock.elapsedTime * 2 + grp.position.x) * 0.8;
    const crate = grp.userData.crate;
    if (crate) {
      if (grp.userData.spinRate) crate.material.rotation += dt * grp.userData.spinRate;        // bonus: continuous 2D spin
      else crate.material.rotation = Math.sin(clock.elapsedTime * 2.4 + grp.position.x) * 0.12; // others: gentle wobble
    }
  }
  if (waterMesh) waterMesh.material.opacity = 0.74 + Math.sin(clock.elapsedTime * 1.5) * 0.05;
  for (const cl of clouds) {
    cl.position.x += cl.userData.drift * dt;
    if (cl.position.x > 400) cl.position.x = -400;
  }

  updateDust(dt);
  updateHazards(dt);
  updateZaps(dt);
  updateAim();
  // REMOVED: updatePreview() call — aiming guideline disabled. (The aim arrow in
  // updateAim() is kept: it shows direction/power but not the parabola/landing.)
  updateCamera(dt);

  if (composer) composer.render();
  else renderer.render(scene, camera);
}
animate();

// ======================================================================
//  Profile + menu + shop + customize + auth
// ======================================================================
let profile = defaultProfile();
let authUser = null;
let guestMode = false;
let saveTimer = null;

function profilePayload() {
  return { name: profile.name, kit: profile.selectedKit, color: profile.color, skin: profile.selectedSkin };
}
function syncProfileToServer() { socket.emit('setProfile', profilePayload()); }

function saveProfile() {
  profile = normalizeProfile(profile);
  if (authUser) {
    FB.localSave(authUser.uid, profile);
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => FB.remoteSave(authUser.uid, profile), 400);
  } else {
    FB.localSave('guest', profile);
  }
  syncProfileToServer();
  if (stage) rebuildStageTanks();   // keep the left menu tank in sync with the player
}

async function loadProfileFor(user) {
  let p = null;
  if (user) {
    p = await FB.remoteLoad(user.uid);
    if (!p) p = FB.localLoad(user.uid);
    if (!p) { p = defaultProfile(); p.name = user.displayName || (user.email ? user.email.split('@')[0] : 'Player'); }
  } else {
    p = FB.localLoad('guest') || defaultProfile();
  }
  profile = normalizeProfile(p);
  if (user && !profile.name) profile.name = user.displayName || 'Player';
  // persist (creates the doc on first login) + tell the server who we are
  if (user) { FB.localSave(user.uid, profile); FB.remoteSave(user.uid, profile); }
  else FB.localSave('guest', profile);
  syncProfileToServer();
}

function enterMenu() {
  refreshMenu();
  showScreen('screen-menu');
}

function refreshMenu() {
  $('menu-name').textContent = profile.name;
  $('menu-coins').textContent = profile.coins;
  $('menu-kit-name').textContent = (KITS[profile.selectedKit] || KITS.standard).name;
  $('menu-msg').textContent = '';
}

function grantReward(reward, won, winnerTeam) {
  if (won) profile.stats.wins += 1;
  else if (winnerTeam !== null) profile.stats.losses += 1;
  if (reward) {
    profile.coins += reward.coins || 0;
    profile.stats.kills += reward.kills || 0;
  }
  saveProfile();
}

function showResult(title, detail, reward) {
  $('result-title').textContent = title;
  $('result-detail').textContent = detail;
  const box = $('result-reward');
  if (reward) {
    box.innerHTML = `<span class="big">+${reward.coins} ◎</span>` +
      `${reward.kills ? `${reward.kills} kill${reward.kills > 1 ? 's' : ''} · ` : ''}` +
      `${reward.propsDestroyed ? `${reward.propsDestroyed} destroyed` : ''}`;
  } else {
    box.innerHTML = '';
  }
  showScreen('screen-result');
}

// ---- menu controls ----
for (const btn of document.querySelectorAll('#menu-modes .mode-btn')) {
  btn.addEventListener('click', () => {
    selectedMode = btn.dataset.mode;
    for (const b of document.querySelectorAll('#menu-modes .mode-btn')) b.classList.toggle('selected', b === btn);
  });
}
$('btn-quick').addEventListener('click', () => {
  socket.emit('quickMatch', { mode: selectedMode, profile: profilePayload() });
  $('queue-status').textContent = 'Searching for an opponent…';
  showScreen('screen-queue');
});
$('btn-bot').addEventListener('click', () => {
  socket.emit('botMatch', { mode: selectedMode, profile: profilePayload() });
  $('menu-msg').textContent = 'Deploying practice match…';
});
$('btn-cancel-queue').addEventListener('click', () => {
  socket.emit('cancelQuickMatch');
  enterMenu();
});
$('btn-create').addEventListener('click', () => {
  socket.emit('createRoom', { mode: selectedMode, profile: profilePayload() });
});
$('btn-join').addEventListener('click', () => {
  const code = $('join-code').value.trim().toUpperCase();
  if (code.length === 4) socket.emit('joinRoom', { code, profile: profilePayload() });
  else $('menu-msg').textContent = 'Enter a 4-character room code.';
});
$('btn-wait-cancel').addEventListener('click', () => location.reload());
$('btn-again').addEventListener('click', () => { state.world = null; enterMenu(); });
$('btn-shop').addEventListener('click', () => { buildShop(); showScreen('screen-shop'); });
$('btn-customize').addEventListener('click', () => { showScreen('screen-customize'); buildCustomize(); });
$('btn-shop-back').addEventListener('click', enterMenu);
$('btn-cust-back').addEventListener('click', enterMenu);
$('btn-signout').addEventListener('click', async () => {
  if (authUser) await FB.signOutUser();
  guestMode = false;
  authUser = null;
  showAuth();
});

// ---- shop ----
function buildShop() {
  $('shop-coins').textContent = profile.coins;
  const kitWrap = $('shop-kits');
  kitWrap.innerHTML = '';
  for (const id of Object.keys(KITS)) {
    const kit = KITS[id];
    const owned = profile.ownedKits.includes(id);
    const card = document.createElement('div');
    card.className = 'card' + (kit.special ? ' special' : '') + (profile.selectedKit === id ? ' selected' : '');
    let action;
    if (profile.selectedKit === id) action = `<button class="cbtn equipped" disabled>Equipped</button>`;
    else if (owned) action = `<button class="cbtn" data-equip-kit="${id}">Equip</button>`;
    else action = `<button class="cbtn buy" data-buy-kit="${id}" ${profile.coins < kit.price ? 'disabled' : ''}>Buy ◎${kit.price}</button>`;
    card.innerHTML =
      `<div class="ct">${kit.name}${kit.special ? '<span class="tag">SPECIAL</span>' : ''}</div>` +
      `<div class="cd">${kit.desc}</div>` +
      `<div class="cl">${kit.loadout}</div>` + action;
    kitWrap.appendChild(card);
  }
  const skinWrap = $('shop-skins');
  skinWrap.innerHTML = '';
  for (const id of Object.keys(SKINS)) {
    const skin = SKINS[id];
    const owned = profile.ownedSkins.includes(id);
    const card = document.createElement('div');
    card.className = 'card skin' + (skin.special ? ' special' : '') + (profile.selectedSkin === id ? ' selected' : '');
    let action;
    if (profile.selectedSkin === id) action = `<button class="cbtn equipped" disabled>Equipped</button>`;
    else if (owned) action = `<button class="cbtn" data-equip-skin="${id}">Equip</button>`;
    else action = `<button class="cbtn buy" data-buy-skin="${id}" ${profile.coins < skin.price ? 'disabled' : ''}>◎${skin.price}</button>`;
    card.innerHTML = `<div class="sw" style="background:${skin.swatch}"></div><div class="ct">${skin.name}</div>${action}`;
    skinWrap.appendChild(card);
  }
  wireShopButtons();
}

function wireShopButtons() {
  for (const b of document.querySelectorAll('[data-buy-kit]')) b.addEventListener('click', () => buyKit(b.dataset.buyKit));
  for (const b of document.querySelectorAll('[data-equip-kit]')) b.addEventListener('click', () => { profile.selectedKit = b.dataset.equipKit; saveProfile(); buildShop(); });
  for (const b of document.querySelectorAll('[data-buy-skin]')) b.addEventListener('click', () => buySkin(b.dataset.buySkin));
  for (const b of document.querySelectorAll('[data-equip-skin]')) b.addEventListener('click', () => { profile.selectedSkin = b.dataset.equipSkin; saveProfile(); buildShop(); });
}

function buyKit(id) {
  const kit = KITS[id];
  if (!kit || profile.ownedKits.includes(id) || profile.coins < kit.price) return;
  profile.coins -= kit.price;
  profile.ownedKits.push(id);
  profile.selectedKit = id;
  saveProfile();
  buildShop();
  refreshMenu();
}
function buySkin(id) {
  const skin = SKINS[id];
  if (!skin || profile.ownedSkins.includes(id) || profile.coins < skin.price) return;
  profile.coins -= skin.price;
  profile.ownedSkins.push(id);
  profile.selectedSkin = id;
  saveProfile();
  buildShop();
}

// ---- customize: live 3D tank preview ----
let pv = null; // { renderer, scene, camera, tank, raf, dragging, lastX, yaw }
function initTankPreview() {
  const host = $('cust-preview');
  if (!host || pv) return;
  const w = host.clientWidth || 320;
  const h = host.clientHeight || 180;
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(w, h);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  host.appendChild(renderer.domElement);

  const pscene = new THREE.Scene();
  pscene.add(new THREE.HemisphereLight(0xffffff, 0x4a5a3a, 1.15));
  const key = new THREE.DirectionalLight(0xfff2d8, 1.5); key.position.set(18, 26, 20); pscene.add(key);
  const rim = new THREE.DirectionalLight(0x9fd0ff, 0.6); rim.position.set(-16, 10, -14); pscene.add(rim);

  const camera = new THREE.PerspectiveCamera(32, w / h, 0.5, 400);
  camera.position.set(24, 15, 27);
  camera.lookAt(0, 4, 0);

  pv = { renderer, scene: pscene, camera, tank: null, raf: null, dragging: false, lastX: 0, yaw: 0.6 };

  // drag to spin
  host.addEventListener('pointerdown', (e) => { pv.dragging = true; pv.lastX = e.clientX; host.setPointerCapture(e.pointerId); });
  host.addEventListener('pointermove', (e) => { if (pv && pv.dragging) { pv.yaw += (e.clientX - pv.lastX) * 0.01; pv.lastX = e.clientX; } });
  host.addEventListener('pointerup', (e) => { if (pv) pv.dragging = false; });
  window.addEventListener('resize', resizeTankPreview);
}
function resizeTankPreview() {
  if (!pv) return;
  const host = $('cust-preview'); if (!host) return;
  const w = host.clientWidth || 320, h = host.clientHeight || 180;
  pv.renderer.setSize(w, h);
  pv.camera.aspect = w / h; pv.camera.updateProjectionMatrix();
}
function updateTankPreview() {
  initTankPreview();
  if (!pv) return;
  if (pv.tank) {
    pv.scene.remove(pv.tank);
    pv.tank.traverse((o) => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); } });
    pv.tank = null;
  }
  const { group } = createTankVisual({ color: profile.color, skin: profile.selectedSkin });
  // centre the tank in view (the model spans x:-6..10, so shift left a touch)
  group.position.set(-2, 0, 0);
  const holder = new THREE.Group();
  holder.add(group);
  pv.tank = holder;
  pv.scene.add(holder);
  if (!pv.raf) {
    const loop = () => {
      if (!pv) return;
      if (!$('screen-customize').classList.contains('active')) { pv.raf = null; return; } // stop when hidden
      pv.raf = requestAnimationFrame(loop);
      if (!pv.dragging) pv.yaw += 0.008;
      if (pv.tank) pv.tank.rotation.y = pv.yaw;
      pv.renderer.render(pv.scene, pv.camera);
    };
    loop();
  }
}

// ---- customize ----
function buildCustomize() {
  $('cust-coins').textContent = profile.coins;
  const kitWrap = $('cust-kits');
  kitWrap.innerHTML = '';
  for (const id of profile.ownedKits) {
    const kit = KITS[id]; if (!kit) continue;
    const card = document.createElement('div');
    card.className = 'card' + (kit.special ? ' special' : '') + (profile.selectedKit === id ? ' selected' : '');
    card.innerHTML = `<div class="ct">${kit.name}</div><div class="cl">${kit.loadout}</div>` +
      (profile.selectedKit === id ? `<button class="cbtn equipped" disabled>Equipped</button>` : `<button class="cbtn" data-equip-kit="${id}">Equip</button>`);
    kitWrap.appendChild(card);
  }
  const skinWrap = $('cust-skins');
  skinWrap.innerHTML = '';
  for (const id of profile.ownedSkins) {
    const skin = SKINS[id]; if (!skin) continue;
    const card = document.createElement('div');
    card.className = 'card skin' + (profile.selectedSkin === id ? ' selected' : '');
    card.innerHTML = `<div class="sw" style="background:${skin.swatch}"></div><div class="ct">${skin.name}</div>` +
      (profile.selectedSkin === id ? `<button class="cbtn equipped" disabled>Equipped</button>` : `<button class="cbtn" data-equip-skin="${id}">Equip</button>`);
    skinWrap.appendChild(card);
  }
  const colWrap = $('cust-colors');
  colWrap.innerHTML = '';
  for (const col of TANK_COLORS) {
    const sw = document.createElement('div');
    sw.className = 'swatch' + (profile.color.toLowerCase() === col.toLowerCase() ? ' selected' : '');
    sw.style.background = col;
    sw.addEventListener('click', () => { profile.color = col; saveProfile(); buildCustomize(); });
    colWrap.appendChild(sw);
  }
  for (const b of document.querySelectorAll('#cust-kits [data-equip-kit]')) b.addEventListener('click', () => { profile.selectedKit = b.dataset.equipKit; saveProfile(); buildCustomize(); refreshMenu(); });
  for (const b of document.querySelectorAll('#cust-skins [data-equip-skin]')) b.addEventListener('click', () => { profile.selectedSkin = b.dataset.equipSkin; saveProfile(); buildCustomize(); });

  updateTankPreview();
}

// ---- auth ----
let authMode = 'signin';
function showAuth() {
  $('auth-error').textContent = '';
  setAuthMode('signin');
  showScreen('screen-auth');
}
function setAuthMode(m) {
  authMode = m;
  $('auth-name').classList.toggle('hidden', m !== 'signup');
  $('auth-submit').textContent = m === 'signup' ? 'Create Account' : 'Sign In';
  $('auth-title').textContent = m === 'signup' ? 'Create an account to save your progress.' : 'Sign in to save coins, kits & stats.';
  $('auth-toggle').textContent = m === 'signup' ? 'Have an account? Sign in' : 'New here? Create an account';
}
$('auth-toggle').addEventListener('click', () => setAuthMode(authMode === 'signin' ? 'signup' : 'signin'));
$('auth-guest').addEventListener('click', async () => {
  guestMode = true; authUser = null;
  await loadProfileFor(null);
  enterMenu();
});
$('auth-google').addEventListener('click', async () => {
  $('auth-error').textContent = '';
  try { await FB.signInGoogle(); } // success handled by watchAuth
  catch (err) { $('auth-error').textContent = FB.friendlyAuthError(err); }
});
$('auth-submit').addEventListener('click', async () => {
  $('auth-error').textContent = '';
  const email = $('auth-email').value.trim();
  const pass = $('auth-password').value;
  const name = $('auth-name').value.trim();
  if (!email || !pass) { $('auth-error').textContent = 'Enter your email and password.'; return; }
  try {
    if (authMode === 'signup') await FB.signUpEmail(email, pass, name || email.split('@')[0]);
    else await FB.signInEmail(email, pass);
  } catch (err) {
    $('auth-error').textContent = FB.friendlyAuthError(err);
  }
});

// ======================================================================
//  Menu stage — two large 3D tanks flanking the menu/login panels
// ======================================================================
let stage = null;
function initMenuStage() {
  const host = $('menu-bg');
  if (!host || stage) return;
  const r = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  r.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  r.setSize(window.innerWidth, window.innerHeight);
  r.outputColorSpace = THREE.SRGBColorSpace;
  host.appendChild(r.domElement);

  const sc = new THREE.Scene();
  sc.background = makeSky(['#bfe8ff', '#d6f0ff', '#eaf7e8', '#f6fbef']);
  sc.fog = new THREE.Fog(0xdaf0ff, 140, 520);
  sc.add(new THREE.HemisphereLight(0xffffff, 0x88aa66, 1.15));
  const sun2 = new THREE.DirectionalLight(0xfff4d6, 1.6); sun2.position.set(40, 70, 60); sc.add(sun2);

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(900, 500),
    new THREE.MeshStandardMaterial({ color: 0x7bc86c, roughness: 1, metalness: 0 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -7;
  sc.add(ground);

  // a few cartoon hills + clouds for depth
  const hillMat = new THREE.MeshStandardMaterial({ color: 0x8fd07f, roughness: 1 });
  for (let k = 0; k < 5; k++) {
    const hill = new THREE.Mesh(new THREE.SphereGeometry(28 + Math.random() * 26, 16, 12), hillMat);
    hill.position.set(-160 + k * 80 + (Math.random() - 0.5) * 30, -34, -120 - Math.random() * 40);
    hill.scale.y = 0.6;
    sc.add(hill);
  }

  const cam = new THREE.PerspectiveCamera(40, window.innerWidth / window.innerHeight, 0.5, 1200);
  cam.position.set(0, 18, 74);
  cam.lookAt(0, 7, 0);

  stage = { renderer: r, scene: sc, camera: cam, left: null, right: null, raf: null, t: 0 };
  window.addEventListener('resize', resizeMenuStage);
  rebuildStageTanks();
}
function resizeMenuStage() {
  if (!stage) return;
  stage.renderer.setSize(window.innerWidth, window.innerHeight);
  stage.camera.aspect = window.innerWidth / window.innerHeight;
  stage.camera.updateProjectionMatrix();
}
function rebuildStageTanks() {
  if (!stage) return;
  for (const key of ['left', 'right']) {
    if (stage[key]) { stage.scene.remove(stage[key]); disposeGroup(stage[key]); stage[key] = null; }
  }
  const L = new THREE.Group();
  const lv = createTankVisual({ color: profile.color, skin: profile.selectedSkin });
  lv.group.scale.setScalar(2.5);
  lv.barrelPivot.rotation.z = 0.5;
  L.add(lv.group);
  L.position.set(-39, -2, 6);
  stage.scene.add(L); stage.left = L;

  const R = new THREE.Group();
  const rv = createTankVisual({ color: '#ff7a4a', skin: 'default' });
  rv.group.scale.setScalar(2.5);
  rv.barrelPivot.rotation.z = 0.5;
  R.add(rv.group);
  R.position.set(39, -2, 6);
  R.rotation.y = Math.PI;
  stage.scene.add(R); stage.right = R;
}
function startMenuStage() {
  initMenuStage();
  const host = $('menu-bg');
  if (host) host.classList.remove('hidden');
  if (stage && !stage.raf) {
    let last = performance.now();
    const loop = () => {
      if (!stage) return;
      stage.raf = requestAnimationFrame(loop);
      const now = performance.now();
      const dt = Math.min(0.05, (now - last) / 1000); last = now;
      stage.t += dt;
      if (stage.left) {
        stage.left.rotation.y = 0.5 + Math.sin(stage.t * 0.5) * 0.22;
        stage.left.position.y = -2 + Math.sin(stage.t * 1.3) * 0.5;
      }
      if (stage.right) {
        stage.right.rotation.y = Math.PI - 0.5 + Math.sin(stage.t * 0.5 + 1) * 0.22;
        stage.right.position.y = -2 + Math.sin(stage.t * 1.3 + 1) * 0.5;
      }
      stage.renderer.render(stage.scene, stage.camera);
    };
    loop();
  }
}
function stopMenuStage() {
  if (stage && stage.raf) { cancelAnimationFrame(stage.raf); stage.raf = null; }
  const host = $('menu-bg');
  if (host) host.classList.add('hidden');
}

// ======================================================================
//  Boot sequence
// ======================================================================
function setLoad(pct, msg) {
  $('load-fill').style.width = `${Math.round(pct)}%`;
  if (msg) $('load-msg').textContent = msg;
}

async function boot() {
  showScreen('screen-loading');
  setLoad(8, 'Connecting…');
  await FB.firebaseReady;            // resolves regardless of success
  setLoad(40, 'Preparing battlefield…');
  await preloadModel((p) => setLoad(40 + p * 50, 'Preparing battlefield…'));
  setLoad(100, 'Ready');

  if (FB.isReady()) {
    FB.watchAuth(async (user) => {
      authUser = user;
      if (user) {
        guestMode = false;
        await loadProfileFor(user);
        enterMenu();
      } else if (!guestMode) {
        showAuth();
      }
    });
  } else {
    // Firebase unavailable: go straight to the auth screen; only Guest will work.
    showAuth();
  }
}
boot();
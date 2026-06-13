import * as THREE from 'three';

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
};

let selectedMode = '1v1';
let anim = null;
let pending = null;

const TERRAIN_DEPTH = 26;
const STEP_RATE = 80;     // trajectory steps per second
const BOOM_TIME = 0.5;    // explosion seconds
const VIEW_WIDTH = 270;   // ortho world units across at zoom 1

let focusX = 120;
let camX = 120;
let targetZoom = 1;

// --- renderer / scene ---
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
dom.scene.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = makeSky();
scene.fog = new THREE.Fog(0xa9c6e8, 360, 620);

const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 1200);
const CAM_OFFSET = new THREE.Vector3(0, 60, 220);
const CAM_TARGET_Y = 34;

const hemi = new THREE.HemisphereLight(0xcfe2ff, 0x4a5a3a, 0.75);
scene.add(hemi);

const sun = new THREE.DirectionalLight(0xfff2d8, 1.05);
sun.position.set(140, 220, 170);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
sun.shadow.camera.left = -150;
sun.shadow.camera.right = 150;
sun.shadow.camera.top = 140;
sun.shadow.camera.bottom = -40;
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 600;
sun.shadow.bias = -0.0004;
scene.add(sun);
scene.add(sun.target);

const clock = new THREE.Clock();

let terrainMesh = null;
const tankMeshes = new Map();
const pickupMeshes = new Map();

const projectileMesh = new THREE.Mesh(
  new THREE.SphereGeometry(1.5, 16, 16),
  new THREE.MeshStandardMaterial({ color: 0x222222, emissive: 0xffb030, emissiveIntensity: 1.2 })
);
projectileMesh.castShadow = true;
projectileMesh.visible = false;
const projLight = new THREE.PointLight(0xffaa33, 0, 60);
projectileMesh.add(projLight);
scene.add(projectileMesh);

const trail = new THREE.Line(
  new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
  new THREE.LineBasicMaterial({ color: 0xffcc66, transparent: true, opacity: 0.6 })
);
trail.visible = false;
scene.add(trail);
let trailPoints = [];

const explosionMesh = new THREE.Mesh(
  new THREE.SphereGeometry(1, 18, 18),
  new THREE.MeshBasicMaterial({ color: 0xff8a2a, transparent: true, opacity: 0.85 })
);
explosionMesh.visible = false;
scene.add(explosionMesh);
const flashLight = new THREE.PointLight(0xffa040, 0, 120);
scene.add(flashLight);

const aimArrow = new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3(), 30, 0xffffff, 6, 4);
aimArrow.visible = false;
scene.add(aimArrow);

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
  grad.addColorStop(0, '#6ea8e6');
  grad.addColorStop(0.55, '#a9c6e8');
  grad.addColorStop(1, '#d8e4f0');
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

// --- terrain (2.5D ribbon) ---
function topColor(h, target) {
  const t = Math.max(0, Math.min(1, (h - 6) / 40));
  target.copy(new THREE.Color(0x4e9a4e)).lerp(new THREE.Color(0x6fae5a), t);
}

function buildTerrain() {
  const cols = state.world.cols;
  const geo = new THREE.BufferGeometry();
  const positions = new Float32Array(cols * 3 * 3);
  const colors = new Float32Array(cols * 3 * 3);
  const dirt = new THREE.Color(0x6b4e33);
  for (let i = 0; i < cols; i++) {
    const h = state.heightmap[i];
    setVert(positions, i, i, h, TERRAIN_DEPTH / 2);              // topFront
    setVert(positions, cols + i, i, h, -TERRAIN_DEPTH / 2);      // topBack
    setVert(positions, 2 * cols + i, i, 0, TERRAIN_DEPTH / 2);   // botFront
    setColor(colors, cols + i, dirt);
    setColor(colors, 2 * cols + i, dirt);
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
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.95, metalness: 0 });
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

// --- tanks ---
function buildTank(tank) {
  const group = new THREE.Group();
  const team = new THREE.Color(tank.color);

  const hull = new THREE.Mesh(
    new THREE.BoxGeometry(9, 3, 7),
    new THREE.MeshStandardMaterial({ color: team, roughness: 0.6, metalness: 0.2 })
  );
  hull.position.y = 2.6;
  hull.castShadow = true;
  hull.receiveShadow = true;
  group.add(hull);

  for (const sz of [-1, 1]) {
    const tread = new THREE.Mesh(
      new THREE.BoxGeometry(10, 2, 1.8),
      new THREE.MeshStandardMaterial({ color: 0x2a2f36, roughness: 0.9 })
    );
    tread.position.set(0, 1, sz * 3);
    tread.castShadow = true;
    group.add(tread);
  }

  const turret = new THREE.Mesh(
    new THREE.SphereGeometry(2.6, 18, 14),
    new THREE.MeshStandardMaterial({ color: team.clone().multiplyScalar(0.78), roughness: 0.5, metalness: 0.3 })
  );
  turret.position.y = 4.4;
  turret.castShadow = true;
  group.add(turret);

  const barrelPivot = new THREE.Group();
  barrelPivot.position.y = 4.4;
  const barrel = new THREE.Mesh(
    new THREE.CylinderGeometry(0.55, 0.55, 6, 12),
    new THREE.MeshStandardMaterial({ color: 0x1c2128, roughness: 0.4, metalness: 0.6 })
  );
  barrel.rotation.z = -Math.PI / 2;
  barrel.position.x = 3;
  barrel.castShadow = true;
  barrelPivot.add(barrel);
  group.add(barrelPivot);

  group.position.set(tank.x, tank.y, 0);
  scene.add(group);
  tankMeshes.set(tank.id, { group, barrelPivot, targetY: tank.y });
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
    ref.group.position.x = tank.x;
    ref.targetY = tank.y;
  }
}

// --- pickups ---
function syncPickups() {
  const seen = new Set();
  for (const pk of state.pickups) {
    seen.add(pk.id);
    if (pickupMeshes.has(pk.id)) continue;
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(4.5, 4.5, 4.5),
      new THREE.MeshStandardMaterial({ color: 0xffd24a, emissive: 0x5a4300, emissiveIntensity: 0.5, roughness: 0.5, metalness: 0.3 })
    );
    mesh.castShadow = true;
    mesh.position.set(pk.x, pk.y + 4, 0);
    scene.add(mesh);
    pickupMeshes.set(pk.id, mesh);
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

function refreshHud() {
  if (state.gameOver) {
    dom.hudTurn.textContent = 'Match over';
  } else if (state.activePlayerId === state.youId) {
    dom.hudTurn.textContent = 'Your turn';
  } else {
    const t = state.tanks.find((x) => x.id === state.activePlayerId);
    dom.hudTurn.textContent = `${t ? t.name : 'Opponent'}'s turn`;
  }
  dom.windMag.textContent = Math.abs(state.wind);
  dom.windArrow.textContent = state.wind === 0 ? '•' : '➤';
  dom.windArrow.style.transform = `rotate(${state.wind < 0 ? 180 : 0}deg)`;
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
  const me = state.tanks.find((t) => t.id === state.youId);
  dom.weapons.innerHTML = '';
  if (!me) return;
  const owned = Object.keys(me.weapons).filter((w) => me.weapons[w] !== 0);
  if (!owned.includes(state.currentWeapon)) state.currentWeapon = 'standard';
  for (const w of owned) {
    const def = state.weaponDefs[w];
    const ammo = me.weapons[w];
    const btn = document.createElement('button');
    btn.className = 'weapon-btn' + (w === state.currentWeapon ? ' selected' : '');
    btn.textContent = `${def.name} ${ammo < 0 ? '∞' : `x${ammo}`}`;
    btn.addEventListener('click', () => { state.currentWeapon = w; buildWeapons(); });
    dom.weapons.appendChild(btn);
  }
}

function isMyTurn() {
  return !state.gameOver && !anim && state.activePlayerId === state.youId;
}
function updateControls() {
  dom.fireBtn.disabled = !isMyTurn();
}

// --- input ---
dom.angle.addEventListener('input', () => { dom.angleVal.textContent = dom.angle.value; });
dom.power.addEventListener('input', () => { dom.powerVal.textContent = dom.power.value; });

dom.fireBtn.addEventListener('click', () => {
  if (!isMyTurn()) return;
  dom.fireBtn.disabled = true;
  socket.emit('fire', {
    angle: Number(dom.angle.value),
    power: Number(dom.power.value),
    weapon: state.currentWeapon,
  });
});

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
  state.gameOver = false;

  buildTerrain();
  syncTanks();
  syncPickups();
  buildTeams();
  buildWeapons();

  const me = state.tanks.find((t) => t.id === state.youId);
  dom.angle.value = me && me.team === 1 ? 135 : 45;
  dom.angleVal.textContent = dom.angle.value;
  focusX = (state.world.cols - 1) / 2;

  dom.hudRoom.textContent = `Room ${data.code} · ${data.mode}`;
  dom.overlay.classList.add('hidden');
  refreshHud();
  updateControls();
});

socket.on('shotResolved', (data) => {
  pending = data;
  anim = { projectiles: data.projectiles, pi: 0, prog: 0, phase: 'fly', boom: 0 };
  trailPoints = [];
  dom.fireBtn.disabled = true;
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
    const me = state.tanks.find((t) => t.id === state.youId);
    const won = me && next.winnerTeam === me.team;
    showOverlay(won ? 'Your team wins!' : next.winnerTeam === null ? 'Draw.' : 'Your team lost.', true);
  } else {
    state.activePlayerId = next.activePlayerId;
    state.wind = next.wind;
    state.pickups = next.pickups;
    syncPickups();
  }
  pending = null;
  buildWeapons();
  refreshHud();
  refreshTeams();
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

// --- explosion ---
function startExplosion(impact) {
  explosionMesh.position.set(impact.x, impact.y, 0);
  explosionMesh.scale.setScalar(1);
  explosionMesh.material.opacity = 0.85;
  explosionMesh.visible = true;
  flashLight.position.set(impact.x, impact.y + 6, 12);
  flashLight.intensity = 6;
}
function updateExplosion(k, radius) {
  explosionMesh.scale.setScalar(Math.max(1, radius * 1.25 * k));
  explosionMesh.material.opacity = 0.85 * (1 - k);
  flashLight.intensity = 6 * (1 - k);
}
function endExplosion() {
  explosionMesh.visible = false;
  flashLight.intensity = 0;
}

// --- aim arrow ---
const _v = new THREE.Vector3();
function updateAim() {
  if (!isMyTurn()) { aimArrow.visible = false; return; }
  const me = state.tanks.find((t) => t.id === state.youId);
  if (!me) return;
  const rad = (Number(dom.angle.value) * Math.PI) / 180;
  aimArrow.position.set(me.x, me.y + 4.4, 0);
  aimArrow.setDirection(_v.set(Math.cos(rad), Math.sin(rad), 0));
  aimArrow.setLength(Number(dom.power.value) * 0.55, 6, 4);
  aimArrow.visible = true;
}

// --- animation ---
function stepAnim(dt) {
  if (!anim) return;
  const proj = anim.projectiles[anim.pi];
  const pts = proj.trajectory;
  if (anim.phase === 'fly') {
    anim.prog += dt * STEP_RATE;
    const i = Math.floor(anim.prog);
    if (i >= pts.length - 1) {
      projectileMesh.visible = false;
      projLight.intensity = 0;
      trail.visible = false;
      startExplosion(proj.impact);
      anim.phase = 'boom';
      anim.boom = 0;
      return;
    }
    const frac = anim.prog - i;
    const a = pts[i], b = pts[i + 1];
    const px = a.x + (b.x - a.x) * frac;
    const py = a.y + (b.y - a.y) * frac;
    projectileMesh.position.set(px, py, 0);
    projectileMesh.visible = true;
    projLight.intensity = 1.5;
    focusX = px;
    trailPoints.push(new THREE.Vector3(px, py, 0));
    if (trailPoints.length > 24) trailPoints.shift();
    if (trailPoints.length > 1) {
      trail.geometry.setFromPoints(trailPoints);
      trail.visible = true;
    }
  } else {
    anim.boom += dt;
    updateExplosion(Math.min(1, anim.boom / BOOM_TIME), proj.blastRadius);
    if (anim.boom >= BOOM_TIME) {
      endExplosion();
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
    const active = state.tanks.find((t) => t.id === state.activePlayerId);
    if (active) focusX = active.x;
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
  camera.position.set(camX + CAM_OFFSET.x, CAM_OFFSET.y + CAM_TARGET_Y, CAM_OFFSET.z);
  camera.lookAt(camX, CAM_TARGET_Y, 0);
}

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(0.05, clock.getDelta());

  stepAnim(dt);

  for (const tank of state.tanks) {
    const ref = tankMeshes.get(tank.id);
    if (!ref) continue;
    ref.group.position.y += (ref.targetY - ref.group.position.y) * (1 - Math.exp(-10 * dt));
    ref.barrelPivot.rotation.z = (barrelAngleFor(tank) * Math.PI) / 180;
  }
  for (const mesh of pickupMeshes.values()) {
    mesh.rotation.y += dt * 1.6;
  }
  updateAim();
  updateCamera(dt);
  renderer.render(scene, camera);
}
animate();

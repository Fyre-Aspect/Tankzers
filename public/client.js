import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

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
  azimuth: document.getElementById('azimuth'),
  elevation: document.getElementById('elevation'),
  power: document.getElementById('power'),
  azimuthVal: document.getElementById('azimuth-val'),
  elevationVal: document.getElementById('elevation-val'),
  powerVal: document.getElementById('power-val'),
  fireBtn: document.getElementById('fire-btn'),
};

const state = {
  youId: null,
  mode: null,
  world: null,
  heightmap: null,
  tanks: [],
  wind: { x: 0, z: 0 },
  activePlayerId: null,
  pickups: [],
  weaponDefs: null,
  currentWeapon: 'standard',
  gameOver: false,
};

let selectedMode = '1v1';
let anim = null;
let pending = null;

const POWER_SCALE = 0.04;
const SHOT_SPEED = 3;
const BOOM_FRAMES = 18;

// --- Three.js setup ---
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
dom.scene.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0a0e27);
scene.fog = new THREE.Fog(0x0a0e27, 200, 600);

const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 2000);
camera.position.set(-40, 150, 320);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI * 0.49;

scene.add(new THREE.AmbientLight(0xffffff, 0.6));
const sun = new THREE.DirectionalLight(0xffffff, 0.9);
sun.position.set(120, 220, 80);
scene.add(sun);

let terrainMesh = null;
const tankMeshes = new Map();
const pickupMeshes = new Map();

const projectileMesh = new THREE.Mesh(
  new THREE.SphereGeometry(1.6, 12, 12),
  new THREE.MeshStandardMaterial({ color: 0xffd24a, emissive: 0x553300 })
);
projectileMesh.visible = false;
scene.add(projectileMesh);

const explosionMesh = new THREE.Mesh(
  new THREE.SphereGeometry(1, 16, 16),
  new THREE.MeshBasicMaterial({ color: 0xff7a2a, transparent: true, opacity: 0.7 })
);
explosionMesh.visible = false;
scene.add(explosionMesh);

const aimLine = new THREE.Line(
  new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
  new THREE.LineBasicMaterial({ color: 0xffffff })
);
aimLine.visible = false;
scene.add(aimLine);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// --- terrain ---
function heightColor(h, target) {
  const t = Math.max(0, Math.min(1, (h - 2) / 36));
  const low = new THREE.Color(0x3a7a3a);
  const high = new THREE.Color(0x8a6a40);
  target.copy(low).lerp(high, t);
}

function buildTerrain() {
  const { grid, cell } = state.world;
  const geo = new THREE.BufferGeometry();
  const positions = new Float32Array(grid * grid * 3);
  const colors = new Float32Array(grid * grid * 3);
  const indices = [];
  for (let i = 0; i < grid; i++) {
    for (let j = 0; j < grid; j++) {
      const idx = i * grid + j;
      positions[idx * 3] = i * cell;
      positions[idx * 3 + 1] = state.heightmap[idx];
      positions[idx * 3 + 2] = j * cell;
    }
  }
  for (let i = 0; i < grid - 1; i++) {
    for (let j = 0; j < grid - 1; j++) {
      const a = i * grid + j;
      const b = (i + 1) * grid + j;
      const c = i * grid + (j + 1);
      const d = (i + 1) * grid + (j + 1);
      indices.push(a, b, d, a, d, c);
    }
  }
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.setIndex(indices);
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 1, metalness: 0 });
  terrainMesh = new THREE.Mesh(geo, mat);
  scene.add(terrainMesh);
  refreshTerrain();
}

function refreshTerrain() {
  const { grid } = state.world;
  const pos = terrainMesh.geometry.attributes.position;
  const col = terrainMesh.geometry.attributes.color;
  const c = new THREE.Color();
  for (let idx = 0; idx < grid * grid; idx++) {
    const h = state.heightmap[idx];
    pos.array[idx * 3 + 1] = h;
    heightColor(h, c);
    col.array[idx * 3] = c.r;
    col.array[idx * 3 + 1] = c.g;
    col.array[idx * 3 + 2] = c.b;
  }
  pos.needsUpdate = true;
  col.needsUpdate = true;
  terrainMesh.geometry.computeVertexNormals();
}

// --- tanks ---
function buildTank(tank) {
  const group = new THREE.Group();
  const teamColor = new THREE.Color(tank.color);

  const body = new THREE.Mesh(
    new THREE.BoxGeometry(7, 3, 9),
    new THREE.MeshStandardMaterial({ color: teamColor })
  );
  body.position.y = 1.5;
  group.add(body);

  const turret = new THREE.Mesh(
    new THREE.SphereGeometry(2.6, 16, 12),
    new THREE.MeshStandardMaterial({ color: teamColor.clone().multiplyScalar(0.8) })
  );
  turret.position.y = 3.2;
  group.add(turret);

  const barrelPivot = new THREE.Group();
  barrelPivot.position.y = 3.2;
  const barrel = new THREE.Mesh(
    new THREE.CylinderGeometry(0.5, 0.5, 5, 10),
    new THREE.MeshStandardMaterial({ color: 0x222831 })
  );
  barrel.rotation.z = -Math.PI / 2;
  barrel.position.x = 2.5;
  barrelPivot.add(barrel);
  group.add(barrelPivot);

  scene.add(group);
  tankMeshes.set(tank.id, { group, barrelPivot, targetY: tank.y });
  group.position.set(tank.x, tank.y, tank.z);
}

function orientBarrel(tank) {
  const ref = tankMeshes.get(tank.id);
  if (!ref) return;
  let az, el;
  if (tank.id === state.youId) {
    az = Number(dom.azimuth.value);
    el = Number(dom.elevation.value);
  } else {
    az = tank.team === 0 ? 0 : 180;
    el = 35;
  }
  const dir = dirFromAngles(az, el);
  ref.barrelPivot.quaternion.setFromUnitVectors(
    new THREE.Vector3(1, 0, 0),
    new THREE.Vector3(dir.x, dir.y, dir.z).normalize()
  );
}

function dirFromAngles(azDeg, elDeg) {
  const az = (azDeg * Math.PI) / 180;
  const el = (elDeg * Math.PI) / 180;
  const ch = Math.cos(el);
  return { x: ch * Math.cos(az), y: Math.sin(el), z: ch * Math.sin(az) };
}

function syncTanks() {
  for (const tank of state.tanks) {
    let ref = tankMeshes.get(tank.id);
    if (!ref) {
      buildTank(tank);
      ref = tankMeshes.get(tank.id);
    }
    ref.group.visible = tank.alive;
    ref.targetY = tank.y;
    ref.group.position.x = tank.x;
    ref.group.position.z = tank.z;
  }
}

// --- pickups ---
function syncPickups() {
  const seen = new Set();
  for (const pk of state.pickups) {
    seen.add(pk.id);
    if (pickupMeshes.has(pk.id)) continue;
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(4, 4, 4),
      new THREE.MeshStandardMaterial({ color: 0xffd24a, emissive: 0x4a3a00 })
    );
    mesh.position.set(pk.x, pk.y + 3, pk.z);
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

// --- explosion ---
function startExplosion(impact) {
  explosionMesh.position.set(impact.x, impact.y, impact.z);
  explosionMesh.scale.setScalar(1);
  explosionMesh.material.opacity = 0.7;
  explosionMesh.visible = true;
}
function updateExplosion(t, radius) {
  const k = t / BOOM_FRAMES;
  explosionMesh.scale.setScalar(Math.max(1, radius * 1.3 * k));
  explosionMesh.material.opacity = 0.7 * (1 - k);
}
function endExplosion() {
  explosionMesh.visible = false;
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
  const mag = Math.round(Math.hypot(state.wind.x, state.wind.z));
  dom.windMag.textContent = mag;
  const ang = (Math.atan2(state.wind.z, state.wind.x) * 180) / Math.PI;
  dom.windArrow.style.transform = `rotate(${ang}deg)`;
  dom.windArrow.textContent = mag === 0 ? '•' : '➤';
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
    btn.addEventListener('click', () => {
      state.currentWeapon = w;
      buildWeapons();
    });
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
for (const key of ['azimuth', 'elevation', 'power']) {
  dom[key].addEventListener('input', () => {
    dom[`${key}Val`].textContent = dom[key].value;
  });
}

dom.fireBtn.addEventListener('click', () => {
  if (!isMyTurn()) return;
  dom.fireBtn.disabled = true;
  socket.emit('fire', {
    azimuth: Number(dom.azimuth.value),
    elevation: Number(dom.elevation.value),
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

document.getElementById('create-btn').addEventListener('click', () => {
  socket.emit('createRoom', { mode: selectedMode });
});
document.getElementById('join-btn').addEventListener('click', () => {
  const code = document.getElementById('join-code').value.trim().toUpperCase();
  if (code.length === 4) socket.emit('joinRoom', { code });
});

// --- socket events ---
socket.on('roomCreated', ({ code, mode, capacity }) => {
  dom.overlayMsg.textContent = `Room ${code} (${mode}) — waiting for players… 1/${capacity}`;
});
socket.on('lobbyUpdate', ({ count, capacity }) => {
  dom.overlayMsg.textContent = `Waiting for players… ${count}/${capacity}`;
});
socket.on('errorMsg', ({ message }) => {
  dom.overlayMsg.textContent = message;
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
  dom.azimuth.value = me && me.team === 1 ? 180 : 0;
  dom.azimuthVal.textContent = dom.azimuth.value;

  const center = new THREE.Vector3(state.world.size / 2, 10, state.world.size / 2);
  controls.target.copy(center);
  if (me) camera.position.set(me.x - (me.team === 0 ? 60 : -60), 140, me.z + 200);

  dom.hudRoom.textContent = `Room ${data.code} · ${data.mode}`;
  dom.overlay.classList.add('hidden');
  refreshHud();
  updateControls();
});

socket.on('shotResolved', (data) => {
  anim = { projectiles: data.projectiles, pi: 0, t: 0, phase: 'fly' };
  pending = data;
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
  refreshTeams();

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
    const won = me && me.alive && next.winnerTeam === me.team;
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

// --- aim indicator ---
function updateAim() {
  if (!isMyTurn()) {
    aimLine.visible = false;
    return;
  }
  const me = state.tanks.find((t) => t.id === state.youId);
  if (!me) return;
  const dir = dirFromAngles(Number(dom.azimuth.value), Number(dom.elevation.value));
  const power = Number(dom.power.value);
  const start = new THREE.Vector3(me.x, me.y + 3.2, me.z);
  const end = start.clone().add(new THREE.Vector3(dir.x, dir.y, dir.z).multiplyScalar(power * 0.6));
  aimLine.geometry.setFromPoints([start, end]);
  aimLine.geometry.attributes.position.needsUpdate = true;
  aimLine.visible = true;
}

// --- animation loop ---
function stepAnim() {
  if (!anim) return;
  const proj = anim.projectiles[anim.pi];
  if (anim.phase === 'fly') {
    anim.t += SHOT_SPEED;
    const pts = proj.trajectory;
    const idx = Math.min(Math.floor(anim.t), pts.length - 1);
    projectileMesh.visible = true;
    projectileMesh.position.set(pts[idx].x, pts[idx].y, pts[idx].z);
    if (idx >= pts.length - 1) {
      projectileMesh.visible = false;
      startExplosion(proj.impact);
      anim.phase = 'boom';
      anim.t = 0;
    }
  } else {
    anim.t += 1;
    updateExplosion(anim.t, proj.blastRadius);
    if (anim.t >= BOOM_FRAMES) {
      endExplosion();
      anim.pi += 1;
      if (anim.pi >= anim.projectiles.length) {
        anim = null;
        applyPending();
      } else {
        anim.phase = 'fly';
        anim.t = 0;
      }
    }
  }
}

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  stepAnim();

  for (const tank of state.tanks) {
    const ref = tankMeshes.get(tank.id);
    if (!ref) continue;
    ref.group.position.y += (ref.targetY - ref.group.position.y) * 0.2;
    orientBarrel(tank);
  }
  for (const mesh of pickupMeshes.values()) {
    mesh.rotation.y += 0.03;
  }
  updateAim();
  renderer.render(scene, camera);
}
animate();

const socket = io();
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');

const overlay = document.getElementById('overlay');
const overlayMsg = document.getElementById('overlay-msg');
const angleInput = document.getElementById('angle');
const powerInput = document.getElementById('power');
const angleVal = document.getElementById('angle-val');
const powerVal = document.getElementById('power-val');
const fireBtn = document.getElementById('fire-btn');

const state = {
  youId: null,
  worldWidth: 1200,
  worldHeight: 600,
  terrain: null,
  tanks: [],
  wind: 0,
  activePlayerId: null,
  gameOver: false,
  winnerId: null,
};

let shot = null;        // { points, i }
let explosion = null;   // { x, y, t, radius }
let pending = null;     // shotResolved payload waiting to be applied
let banner = null;

function isMyTurn() {
  return !state.gameOver && !shot && !pending && state.activePlayerId === state.youId;
}

function updateControls() {
  fireBtn.disabled = !isMyTurn();
}

angleInput.addEventListener('input', () => { angleVal.textContent = angleInput.value; });
powerInput.addEventListener('input', () => { powerVal.textContent = powerInput.value; });

fireBtn.addEventListener('click', () => {
  if (!isMyTurn()) return;
  fireBtn.disabled = true;
  socket.emit('fire', { angle: Number(angleInput.value), power: Number(powerInput.value) });
});

document.getElementById('create-btn').addEventListener('click', () => socket.emit('createRoom'));
document.getElementById('join-btn').addEventListener('click', () => {
  const code = document.getElementById('join-code').value.trim().toUpperCase();
  if (code.length === 4) socket.emit('joinRoom', { code });
});

socket.on('roomCreated', ({ code }) => {
  overlayMsg.textContent = `Room ${code} — waiting for opponent…`;
});

socket.on('errorMsg', ({ message }) => {
  overlayMsg.textContent = message;
  updateControls();
});

socket.on('gameStart', (data) => {
  state.youId = data.youId;
  state.worldWidth = data.worldWidth;
  state.worldHeight = data.worldHeight;
  state.terrain = data.terrain;
  state.tanks = data.tanks;
  state.wind = data.wind;
  state.activePlayerId = data.activePlayerId;
  state.gameOver = false;
  document.getElementById('hud-room').textContent = `Room ${data.code}`;
  overlay.classList.add('hidden');
  refreshHud();
  updateControls();
});

socket.on('shotResolved', (data) => {
  pending = data;
  shot = { points: data.trajectory, i: 0 };
  fireBtn.disabled = true;
});

socket.on('opponentLeft', ({ message }) => {
  state.gameOver = true;
  banner = message;
  updateControls();
});

function applyPending() {
  state.terrain = pending.terrain;
  state.tanks = pending.tanks;
  const next = pending.next;
  if (next.type === 'gameOver') {
    state.gameOver = true;
    state.winnerId = next.winnerId;
    banner = next.winnerId === state.youId ? 'You win!' :
             next.winnerId === null ? 'Draw.' : 'You lose.';
  } else {
    state.activePlayerId = next.activePlayerId;
    state.wind = next.wind;
  }
  pending = null;
  refreshHud();
  updateControls();
}

function refreshHud() {
  const me = state.tanks.find((t) => t.id === state.youId);
  const opp = state.tanks.find((t) => t.id !== state.youId);
  document.getElementById('me-hp').style.width = `${me ? me.hp : 0}%`;
  document.getElementById('opp-hp').style.width = `${opp ? opp.hp : 0}%`;

  const windDir = state.wind > 0 ? '▶' : state.wind < 0 ? '◀' : '•';
  document.getElementById('hud-wind').textContent =
    `Wind: ${windDir} ${Math.abs(state.wind)}`;

  if (state.gameOver) {
    document.getElementById('hud-turn').textContent = 'Match over';
  } else {
    document.getElementById('hud-turn').textContent =
      state.activePlayerId === state.youId ? 'Your turn' : "Opponent's turn";
  }
}

function drawTerrain() {
  const t = state.terrain;
  ctx.beginPath();
  ctx.moveTo(0, t[0]);
  for (let x = 1; x < t.length; x++) ctx.lineTo(x, t[x]);
  ctx.lineTo(canvas.width, canvas.height);
  ctx.lineTo(0, canvas.height);
  ctx.closePath();
  const grad = ctx.createLinearGradient(0, 0, 0, canvas.height);
  grad.addColorStop(0, '#3a5f3a');
  grad.addColorStop(1, '#1d2e1d');
  ctx.fillStyle = grad;
  ctx.fill();
}

function drawTank(tank) {
  if (!tank.alive) return;
  const { x, y, color } = tank;
  ctx.fillStyle = color;
  ctx.fillRect(x - 15, y - 12, 30, 12);
  ctx.beginPath();
  ctx.arc(x, y - 12, 9, Math.PI, 0);
  ctx.fill();

  let aimRad;
  if (tank.id === state.youId) {
    aimRad = (Number(angleInput.value) * Math.PI) / 180;
  } else {
    aimRad = (135 * Math.PI) / 180;
  }
  ctx.strokeStyle = '#ddd';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(x, y - 12);
  ctx.lineTo(x + Math.cos(aimRad) * 24, y - 12 - Math.sin(aimRad) * 24);
  ctx.stroke();
}

function drawProjectile() {
  if (!shot) return;
  const pts = shot.points;
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  const start = Math.max(0, shot.i - 60);
  ctx.moveTo(pts[start].x, pts[start].y);
  for (let k = start; k <= shot.i && k < pts.length; k++) ctx.lineTo(pts[k].x, pts[k].y);
  ctx.stroke();

  const p = pts[Math.min(shot.i, pts.length - 1)];
  ctx.fillStyle = '#ffd24a';
  ctx.beginPath();
  ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
  ctx.fill();
}

function drawExplosion() {
  if (!explosion) return;
  const alpha = 1 - explosion.t / 18;
  ctx.fillStyle = `rgba(255,${120 + explosion.t * 6},40,${alpha})`;
  ctx.beginPath();
  ctx.arc(explosion.x, explosion.y, explosion.radius * (explosion.t / 18), 0, Math.PI * 2);
  ctx.fill();
}

function drawBanner() {
  if (!banner) return;
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fillRect(0, canvas.height / 2 - 50, canvas.width, 100);
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 48px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(banner, canvas.width / 2, canvas.height / 2 + 16);
  ctx.textAlign = 'left';
}

const SHOT_SPEED = 5;

function tick() {
  if (shot) {
    shot.i += SHOT_SPEED;
    if (shot.i >= shot.points.length - 1) {
      const imp = pending.impact;
      explosion = { x: imp.x, y: imp.y, t: 0, radius: pending.craterRadius * 1.3 };
      shot = null;
    }
  } else if (explosion) {
    explosion.t += 1;
    if (explosion.t === 1 && pending) applyPending();
    if (explosion.t >= 18) explosion = null;
  }
}

function render() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (state.terrain) {
    drawTerrain();
    for (const tank of state.tanks) drawTank(tank);
    drawProjectile();
    drawExplosion();
    drawBanner();
  }
  tick();
  requestAnimationFrame(render);
}

render();

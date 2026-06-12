const GRAVITY = 0.35;
const POWER_SCALE = 0.32;
const WIND_SCALE = 0.015;
const TANK_RADIUS = 16;
const BARREL_LENGTH = 24;
const CRATER_RADIUS = 46;
const BLAST_RADIUS = 60;
const MAX_DAMAGE = 55;
const MAX_STEPS = 4000;

function clamp(v, lo, hi){
    return Math.max(lo, Math.min(hi, v));
}

function carveCrater(terrain, cx, cy, radius, worldHeight) {
    const from = Math.floor(cx - radius);
    const to = Math.ceil(cx + radius);
    for (let x = from; x <= to; x++) {
        if (x < 0 || x >= terrain.length) continue;
        const dx = x - cx;
        const dy = Math.sqrt(radius * radius - dx * dx);
        const h = cy + dy;
        terrain[x] = Math.max(terrain[x], Math.floor(h));
    }
    if (inside <= 0) continue;
    const createrBottom = cy + Math.sqrt(inside);
    if (craterBottom > terrain[x]){terrain[x] = Math.min(craterBottom, worldHeight);}

}

function applyDamage(tanks, ix, iy) {
  const damages = [];
  for (const tank of tanks) {
    if (!tank.alive) continue;
    const dist = Math.hypot(tank.x - ix, tank.y - iy);
    if (dist > BLAST_RADIUS) continue;
    const dmg = Math.round(MAX_DAMAGE * (1 - dist / BLAST_RADIUS));
    if (dmg <= 0) continue;
    tank.hp -= dmg;
    if (tank.hp <= 0) {
      tank.hp = 0;
      tank.alive = false;
    }
    damages.push({ id: tank.id, amount: dmg, hp: tank.hp, dead: !tank.alive });
  }
  return damages;
}


function settleTanks(terrain, tanks) {
    for(const tank of tanks){
        if (!tank.alive) continue;
        const col = clamp(Math.round(tank.x), 0, terrain.length - 1);
        tank.y = terrain[col];
    }
}

function simulateShot(game, shooter, angle, power) {
  const { terrain, tanks, wind } = game;
  const worldWidth = terrain.length;
  const worldHeight = game.constructor === Object ? 600 : game.terrain.length && require('./game').WORLD_HEIGHT;

  const H = require('./game').WORLD_HEIGHT;

  const a = clamp(angle, 0, 180);
  const p = clamp(power, 0, 100);
  const rad = (a * Math.PI) / 180;

  const pivotX = shooter.x;
  const pivotY = shooter.y - TURRET_HEIGHT;
  let x = pivotX + Math.cos(rad) * BARREL_LENGTH;
  let y = pivotY - Math.sin(rad) * BARREL_LENGTH;

  let vx = Math.cos(rad) * p * POWER_SCALE;
  let vy = -Math.sin(rad) * p * POWER_SCALE;
  const windAccel = wind * WIND_SCALE;

  const trajectory = [{ x, y }];
  let impactX = null;
  let impactY = null;

  for (let step = 0; step < MAX_STEPS; step++) {
    vx += windAccel;
    vy += GRAVITY;
    x += vx;
    y += vy;
    trajectory.push({ x, y });

    let hit = false;

    for (const tank of tanks) {
      if (!tank.alive || tank.id === shooter.id) continue;
      if (Math.hypot(tank.x - x, tank.y - y) <= TANK_RADIUS) {
        hit = true;
        break;
      }
    }

    if (!hit && x >= 0 && x < worldWidth) {
      const col = Math.floor(x);
      if (y >= terrain[col]) hit = true;
    }

    if (hit) {
      impactX = x;
      impactY = y;
      break;
    }

    if (y > H + 200) {
      impactX = x;
      impactY = y;
      break;
    }
  }

  if (impactX === null) {
    impactX = x;
    impactY = y;
  }

  const onMap = impactX >= 0 && impactX < worldWidth;
  if (onMap) {
    carveCrater(terrain, impactX, impactY, CRATER_RADIUS, H);
  }
  const damages = onMap ? applyDamage(tanks, impactX, impactY) : [];
  settleTanks(terrain, tanks);

  return {
    trajectory,
    impact: { x: impactX, y: impactY },
    craterRadius: CRATER_RADIUS,
    blastRadius: BLAST_RADIUS,
    terrain,
    tanks,
    damages,
    onMap,
  };
}


module.exports = {simulateShot};

//FINALLY DONE AFJHUIEAJFIEAJFIEAJF
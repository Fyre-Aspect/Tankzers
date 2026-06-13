const GRAVITY = 0.06;
const POWER_SCALE = 0.05;
const WIND_SCALE = 0.0008;
const TANK_RADIUS = 5;
const TANK_CENTER_Y = 3;
const MAX_STEPS = 6000;
const MIN_HEIGHT = 0;
const BOUNDS_MARGIN = 200;

function clampX(world, x) {
  if (x < 0) return 0;
  if (x > world.cols - 1) return world.cols - 1;
  return x;
}

function heightAt(world, hm, x) {
  let i = Math.round(x);
  if (i < 0) i = 0; else if (i > world.cols - 1) i = world.cols - 1;
  return hm[i];
}

function simulateProjectile(world, hm, tanks, shooterId, origin, velocity, wind) {
  const { cols } = world;
  let x = origin.x, y = origin.y;
  let vx = velocity.x, vy = velocity.y;
  const ax = wind * WIND_SCALE;

  const trajectory = [{ x, y }];
  let impact = null;
  let hitTankId = null;

  for (let step = 0; step < MAX_STEPS; step++) {
    vx += ax;
    vy -= GRAVITY;
    x += vx;
    y += vy;
    trajectory.push({ x, y });

    for (const t of tanks) {
      if (!t.alive || t.id === shooterId) continue;
      const dx = t.x - x;
      const dy = t.y + TANK_CENTER_Y - y;
      if (dx * dx + dy * dy <= TANK_RADIUS * TANK_RADIUS) {
        hitTankId = t.id;
        impact = { x, y };
        break;
      }
    }
    if (impact) break;

    if (x >= 0 && x <= cols - 1) {
      const h = heightAt(world, hm, x);
      if (y <= h) {
        impact = { x, y: h };
        break;
      }
    }

    if (y < MIN_HEIGHT - 60) {
      impact = { x, y };
      break;
    }

    // Projectile has escaped the playfield horizontally and won't return.
    if (x < -BOUNDS_MARGIN || x > cols - 1 + BOUNDS_MARGIN) {
      impact = { x, y };
      break;
    }
  }

  if (!impact) impact = { x, y };
  return { trajectory, impact, hitTankId };
}

// A roller settles by following the terrain downhill from its impact point.
// Returns the resting point plus the ground path travelled (for animation).
function rollAlongTerrain(world, hm, impact, maxDist) {
  const STEP = 0.8;
  let x = clampX(world, impact.x);
  let travelled = 0;
  const path = [];
  let guard = 0;
  while (travelled < maxDist && guard++ < 4000) {
    const hHere = heightAt(world, hm, x);
    const hL = heightAt(world, hm, x - STEP);
    const hR = heightAt(world, hm, x + STEP);
    // Roll toward the lower neighbour; stop on a flat spot or in a basin.
    if (Math.abs(hL - hR) < 0.04) break;
    const dir = hL < hR ? -1 : 1;
    const ahead = heightAt(world, hm, x + dir * STEP);
    if (ahead > hHere + 0.08) break; // would have to climb — settle here
    const nx = clampX(world, x + dir * STEP);
    if (nx === x) break; // hit a wall
    x = nx;
    travelled += STEP;
    path.push({ x, y: heightAt(world, hm, x) });
  }
  return { x, y: heightAt(world, hm, x), path };
}

function carveCrater(world, hm, impact, radius) {
  const i0 = Math.max(0, Math.floor(impact.x - radius));
  const i1 = Math.min(world.cols - 1, Math.ceil(impact.x + radius));
  for (let i = i0; i <= i1; i++) {
    const dx = i - impact.x;
    const inside = radius * radius - dx * dx;
    if (inside <= 0) continue;
    const craterFloor = impact.y - Math.sqrt(inside);
    if (hm[i] > craterFloor) {
      hm[i] = Math.max(MIN_HEIGHT, craterFloor);
    }
  }
}

function applyDamage(tanks, impact, radius, maxDamage) {
  const damages = [];
  for (const t of tanks) {
    if (!t.alive) continue;
    const dx = t.x - impact.x;
    const dy = t.y + TANK_CENTER_Y - impact.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d > radius) continue;
    const dmg = Math.round(maxDamage * (1 - d / radius));
    if (dmg <= 0) continue;
    t.hp -= dmg;
    if (t.hp <= 0) {
      t.hp = 0;
      t.alive = false;
    }
    damages.push({ id: t.id, amount: dmg, hp: t.hp, dead: !t.alive });
  }
  return damages;
}

function settleTanks(world, hm, tanks) {
  for (const t of tanks) {
    if (!t.alive) continue;
    t.y = heightAt(world, hm, t.x);
  }
}

module.exports = {
  POWER_SCALE,
  TANK_CENTER_Y,
  clampX,
  heightAt,
  simulateProjectile,
  rollAlongTerrain,
  carveCrater,
  applyDamage,
  settleTanks,
};

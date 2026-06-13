const GRAVITY = 0.05;
const POWER_SCALE = 0.04;
const WIND_SCALE = 0.0006;
const TANK_RADIUS = 4;
const TANK_CENTER_Y = 2;
const MAX_STEPS = 6000;
const MIN_HEIGHT = 0;

function heightAt(world, hm, x, z) {
  const { grid, cell } = world;
  let i = Math.round(x / cell);
  let j = Math.round(z / cell);
  if (i < 0) i = 0; else if (i > grid - 1) i = grid - 1;
  if (j < 0) j = 0; else if (j > grid - 1) j = grid - 1;
  return hm[i * grid + j];
}

function simulateProjectile(world, hm, tanks, shooterId, origin, velocity, wind) {
  const { size } = world;
  let x = origin.x, y = origin.y, z = origin.z;
  let vx = velocity.x, vy = velocity.y, vz = velocity.z;
  const ax = wind.x * WIND_SCALE;
  const az = wind.z * WIND_SCALE;

  const trajectory = [{ x, y, z }];
  let impact = null;
  let hitTankId = null;

  for (let step = 0; step < MAX_STEPS; step++) {
    vx += ax;
    vz += az;
    vy -= GRAVITY;
    x += vx;
    y += vy;
    z += vz;
    trajectory.push({ x, y, z });

    for (const t of tanks) {
      if (!t.alive || t.id === shooterId) continue;
      const dx = t.x - x;
      const dy = t.y + TANK_CENTER_Y - y;
      const dz = t.z - z;
      if (dx * dx + dy * dy + dz * dz <= TANK_RADIUS * TANK_RADIUS) {
        hitTankId = t.id;
        impact = { x, y, z };
        break;
      }
    }
    if (impact) break;

    if (x >= 0 && x <= size && z >= 0 && z <= size) {
      const h = heightAt(world, hm, x, z);
      if (y <= h) {
        impact = { x, y: h, z };
        break;
      }
    }

    if (y < MIN_HEIGHT - 60) {
      impact = { x, y, z };
      break;
    }
  }

  if (!impact) impact = { x, y, z };
  return { trajectory, impact, hitTankId };
}

function carveCrater(world, hm, impact, radius) {
  const { grid, cell } = world;
  const ci = impact.x / cell;
  const cj = impact.z / cell;
  const cellRad = radius / cell;
  const i0 = Math.max(0, Math.floor(ci - cellRad));
  const i1 = Math.min(grid - 1, Math.ceil(ci + cellRad));
  const j0 = Math.max(0, Math.floor(cj - cellRad));
  const j1 = Math.min(grid - 1, Math.ceil(cj + cellRad));

  for (let i = i0; i <= i1; i++) {
    for (let j = j0; j <= j1; j++) {
      const wx = i * cell;
      const wz = j * cell;
      const d2 = (wx - impact.x) ** 2 + (wz - impact.z) ** 2;
      if (d2 > radius * radius) continue;
      const craterFloor = impact.y - Math.sqrt(radius * radius - d2);
      const idx = i * grid + j;
      if (hm[idx] > craterFloor) {
        hm[idx] = Math.max(MIN_HEIGHT, craterFloor);
      }
    }
  }
}

function applyDamage(tanks, impact, radius, maxDamage) {
  const damages = [];
  for (const t of tanks) {
    if (!t.alive) continue;
    const dx = t.x - impact.x;
    const dy = t.y + TANK_CENTER_Y - impact.y;
    const dz = t.z - impact.z;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
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
    t.y = heightAt(world, hm, t.x, t.z);
  }
}

module.exports = {
  POWER_SCALE,
  TANK_CENTER_Y,
  heightAt,
  simulateProjectile,
  carveCrater,
  applyDamage,
  settleTanks,
};

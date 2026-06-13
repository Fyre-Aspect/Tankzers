const physics = require('./physics');

const GRID = 64;
const CELL = 4;
const SIZE = (GRID - 1) * CELL;
const WORLD = { grid: GRID, cell: CELL, size: SIZE };

const TURRET_HEIGHT = 3;
const BARREL_LENGTH = 4;

const WEAPONS = {
  standard: { id: 'standard', name: 'Standard', blastRadius: 16, damage: 34, projectiles: 1, spread: 0, powerMult: 1 },
  big_bomb: { id: 'big_bomb', name: 'Big Bomb', blastRadius: 30, damage: 62, projectiles: 1, spread: 0, powerMult: 0.95 },
  triple: { id: 'triple', name: 'Triple Shot', blastRadius: 12, damage: 22, projectiles: 3, spread: 8, powerMult: 1 },
};

const PICKUP_WEAPONS = ['big_bomb', 'triple'];
const PICKUP_AMMO = 2;
const PICKUP_RADIUS = 9;
const MAX_PICKUPS = 3;
const PICKUP_CHANCE = 0.6;

const TEAM_COLORS = ['#4ad9ff', '#ff7a4a'];

function randomWind() {
  return {
    x: Math.round((Math.random() * 2 - 1) * 10),
    z: Math.round((Math.random() * 2 - 1) * 10),
  };
}

function generateHeightmap() {
  const hm = new Array(GRID * GRID);
  const p1 = Math.random() * Math.PI * 2;
  const p2 = Math.random() * Math.PI * 2;
  const p3 = Math.random() * Math.PI * 2;
  for (let i = 0; i < GRID; i++) {
    for (let j = 0; j < GRID; j++) {
      const u = i / (GRID - 1);
      const v = j / (GRID - 1);
      let h =
        18 +
        Math.sin(u * Math.PI * 2 + p1) * 8 +
        Math.sin(v * Math.PI * 3 + p2) * 6 +
        Math.sin((u + v) * Math.PI * 2 + p3) * 5 +
        Math.sin(u * Math.PI * 6) * Math.cos(v * Math.PI * 5) * 3;
      hm[i * GRID + j] = h < 2 ? 2 : h;
    }
  }
  return hm;
}

function spawnLayout(mode) {
  if (mode === '1v1') {
    return [
      { team: 0, fx: 0.18, fz: 0.5 },
      { team: 1, fx: 0.82, fz: 0.5 },
    ];
  }
  return [
    { team: 0, fx: 0.15, fz: 0.28 },
    { team: 1, fx: 0.85, fz: 0.28 },
    { team: 0, fx: 0.15, fz: 0.72 },
    { team: 1, fx: 0.85, fz: 0.72 },
  ];
}

function dirFromAngles(azDeg, elDeg) {
  const az = (azDeg * Math.PI) / 180;
  const el = (elDeg * Math.PI) / 180;
  const ch = Math.cos(el);
  return { x: ch * Math.cos(az), y: Math.sin(el), z: ch * Math.sin(az) };
}

class Game {
  constructor(playerIds, mode) {
    this.mode = mode;
    this.world = WORLD;
    this.heightmap = generateHeightmap();
    this.wind = randomWind();
    this.players = [...playerIds];
    this.pickups = [];
    this.pickupSeq = 0;

    const layout = spawnLayout(mode);
    this.tanks = playerIds.map((id, i) => {
      const s = layout[i];
      const x = s.fx * SIZE;
      const z = s.fz * SIZE;
      return {
        id,
        team: s.team,
        name: `P${i + 1}`,
        x,
        z,
        y: physics.heightAt(WORLD, this.heightmap, x, z),
        hp: 100,
        alive: true,
        color: TEAM_COLORS[s.team],
        weapons: { standard: -1, big_bomb: 0, triple: 0 },
      };
    });

    this.turnIndex = 0;
  }

  get activePlayerId() {
    return this.players[this.turnIndex];
  }

  tankOf(id) {
    return this.tanks.find((t) => t.id === id);
  }

  aliveTanks() {
    return this.tanks.filter((t) => t.alive);
  }

  aliveTeams() {
    return new Set(this.aliveTanks().map((t) => t.team));
  }

  state() {
    return {
      mode: this.mode,
      world: this.world,
      heightmap: this.heightmap,
      tanks: this.tanks,
      wind: this.wind,
      activePlayerId: this.activePlayerId,
      pickups: this.pickups,
      weapons: WEAPONS,
    };
  }

  fire(shooterId, azimuth, elevation, power, weaponId) {
    if (shooterId !== this.activePlayerId) {
      throw new Error('Not your turn.');
    }
    const shooter = this.tankOf(shooterId);
    if (!shooter || !shooter.alive) {
      throw new Error('Shooter is not in play.');
    }
    const weapon = WEAPONS[weaponId];
    if (!weapon) {
      throw new Error('Unknown weapon.');
    }
    const ammo = shooter.weapons[weaponId];
    if (ammo === 0) {
      throw new Error('No ammo for that weapon.');
    }

    const projectiles = [];
    const damages = [];
    const collected = [];
    const speed = power * physics.POWER_SCALE * weapon.powerMult;

    for (let k = 0; k < weapon.projectiles; k++) {
      const offset = (k - (weapon.projectiles - 1) / 2) * weapon.spread;
      const dir = dirFromAngles(azimuth + offset, elevation);
      const origin = {
        x: shooter.x + dir.x * BARREL_LENGTH,
        y: shooter.y + TURRET_HEIGHT + dir.y * BARREL_LENGTH,
        z: shooter.z + dir.z * BARREL_LENGTH,
      };
      const velocity = { x: dir.x * speed, y: dir.y * speed, z: dir.z * speed };

      const shot = physics.simulateProjectile(
        this.world,
        this.heightmap,
        this.tanks,
        shooterId,
        origin,
        velocity,
        this.wind
      );
      physics.carveCrater(this.world, this.heightmap, shot.impact, weapon.blastRadius);
      const hits = physics.applyDamage(this.tanks, shot.impact, weapon.blastRadius, weapon.damage);
      for (const h of hits) damages.push(h);
      this.collectPickups(shot.impact, shooter, collected);

      projectiles.push({
        trajectory: shot.trajectory,
        impact: shot.impact,
        blastRadius: weapon.blastRadius,
      });
    }

    physics.settleTanks(this.world, this.heightmap, this.tanks);

    if (ammo > 0) {
      shooter.weapons[weaponId] = ammo - 1;
    }

    return { projectiles, damages, collected, weaponId };
  }

  collectPickups(impact, shooter, collected) {
    for (let n = this.pickups.length - 1; n >= 0; n--) {
      const pk = this.pickups[n];
      const dx = pk.x - impact.x;
      const dz = pk.z - impact.z;
      if (dx * dx + dz * dz <= PICKUP_RADIUS * PICKUP_RADIUS) {
        shooter.weapons[pk.weapon] += PICKUP_AMMO;
        collected.push({ tankId: shooter.id, weapon: pk.weapon, ammo: shooter.weapons[pk.weapon] });
        this.pickups.splice(n, 1);
      }
    }
  }

  advanceTurn() {
    do {
      this.turnIndex = (this.turnIndex + 1) % this.players.length;
    } while (!this.tankOf(this.activePlayerId).alive);
    this.wind = randomWind();
    this.maybeSpawnPickup();
  }

  maybeSpawnPickup() {
    if (this.pickups.length >= MAX_PICKUPS) return;
    if (Math.random() > PICKUP_CHANCE) return;
    const x = (0.15 + Math.random() * 0.7) * SIZE;
    const z = (0.1 + Math.random() * 0.8) * SIZE;
    const weapon = PICKUP_WEAPONS[Math.floor(Math.random() * PICKUP_WEAPONS.length)];
    this.pickups.push({
      id: ++this.pickupSeq,
      x,
      z,
      y: physics.heightAt(this.world, this.heightmap, x, z),
      weapon,
    });
  }
}

function capacityFor(mode) {
  return mode === '2v2' ? 4 : 2;
}

module.exports = { Game, WEAPONS, capacityFor };

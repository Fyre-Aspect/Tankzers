const physics = require('./physics');

const COLS = 240;
const WORLD = { cols: COLS, width: COLS };

const TURRET_HEIGHT = 5;
const BARREL_LENGTH = 5;

const WEAPONS = {
  standard: { id: 'standard', name: 'Standard', blastRadius: 16, damage: 34, projectiles: 1, spread: 0, powerMult: 1 },
  big_bomb: { id: 'big_bomb', name: 'Big Bomb', blastRadius: 28, damage: 62, projectiles: 1, spread: 0, powerMult: 0.95 },
  triple: { id: 'triple', name: 'Triple Shot', blastRadius: 11, damage: 22, projectiles: 3, spread: 6, powerMult: 1 },
};

const PICKUP_WEAPONS = ['big_bomb', 'triple'];
const PICKUP_AMMO = 2;
const PICKUP_RADIUS = 9;
const MAX_PICKUPS = 3;
const PICKUP_CHANCE = 0.6;

const TEAM_COLORS = ['#4ad9ff', '#ff7a4a'];

function randomWind() {
  return Math.round((Math.random() * 2 - 1) * 10);
}

function generateTerrain() {
  const hm = new Array(COLS);
  const p1 = Math.random() * Math.PI * 2;
  const p2 = Math.random() * Math.PI * 2;
  const base = 38;
  for (let i = 0; i < COLS; i++) {
    const u = i / (COLS - 1);
    let h =
      base +
      Math.sin(u * Math.PI * 2 + p1) * 16 +
      Math.sin(u * Math.PI * 5 + p2) * 7 +
      Math.sin(u * Math.PI * 9) * 3;
    hm[i] = h < 6 ? 6 : h;
  }
  return hm;
}

function spawnLayout(mode) {
  if (mode === '1v1') {
    return [
      { team: 0, fx: 0.15 },
      { team: 1, fx: 0.85 },
    ];
  }
  return [
    { team: 0, fx: 0.10 },
    { team: 1, fx: 0.76 },
    { team: 0, fx: 0.24 },
    { team: 1, fx: 0.90 },
  ];
}

class Game {
  constructor(playerIds, mode) {
    this.mode = mode;
    this.world = WORLD;
    this.heightmap = generateTerrain();
    this.wind = randomWind();
    this.players = [...playerIds];
    this.pickups = [];
    this.pickupSeq = 0;

    const layout = spawnLayout(mode);
    this.tanks = playerIds.map((id, i) => {
      const s = layout[i];
      const x = s.fx * (COLS - 1);
      return {
        id,
        team: s.team,
        name: `P${i + 1}`,
        x,
        y: physics.heightAt(WORLD, this.heightmap, x),
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

  fire(shooterId, angle, power, weaponId) {
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
    if (!Number.isFinite(angle) || !Number.isFinite(power)) {
      throw new Error('Invalid shot parameters.');
    }
    angle = Math.max(0, Math.min(180, angle));
    power = Math.max(5, Math.min(100, power));
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
      const rad = ((angle + offset) * Math.PI) / 180;
      const dir = { x: Math.cos(rad), y: Math.sin(rad) };
      const origin = {
        x: shooter.x + dir.x * BARREL_LENGTH,
        y: shooter.y + TURRET_HEIGHT + dir.y * BARREL_LENGTH,
      };
      const velocity = { x: dir.x * speed, y: dir.y * speed };

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
      const dy = pk.y - impact.y;
      if (dx * dx + dy * dy <= PICKUP_RADIUS * PICKUP_RADIUS) {
        shooter.weapons[pk.weapon] += PICKUP_AMMO;
        collected.push({ tankId: shooter.id, weapon: pk.weapon, ammo: shooter.weapons[pk.weapon] });
        this.pickups.splice(n, 1);
      }
    }
  }

  advanceTurn() {
    for (let i = 0; i < this.players.length; i++) {
      this.turnIndex = (this.turnIndex + 1) % this.players.length;
      const tank = this.tankOf(this.activePlayerId);
      if (tank && tank.alive) break;
    }
    this.wind = randomWind();
    this.maybeSpawnPickup();
  }

  maybeSpawnPickup() {
    if (this.pickups.length >= MAX_PICKUPS) return;
    if (Math.random() > PICKUP_CHANCE) return;
    const x = (0.15 + Math.random() * 0.7) * (COLS - 1);
    this.pickups.push({
      id: ++this.pickupSeq,
      x,
      y: physics.heightAt(this.world, this.heightmap, x),
      weapon: PICKUP_WEAPONS[Math.floor(Math.random() * PICKUP_WEAPONS.length)],
    });
  }
}

function capacityFor(mode) {
  return mode === '2v2' ? 4 : 2;
}

module.exports = { Game, WEAPONS, capacityFor };
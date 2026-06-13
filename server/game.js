const physics = require('./physics');

const COLS = 240;
const WORLD = { cols: COLS, width: COLS };

const TURRET_HEIGHT = 5;
const BARREL_LENGTH = 5;

// How far a tank can drive per turn (~2 seconds of driving on the client).
const MOVE_RANGE = 44;
const TANK_GAP = 11;

const WEAPONS = {
  standard: { id: 'standard', name: 'Standard', blastRadius: 16, damage: 34, projectiles: 1, spread: 0, powerMult: 1 },
  sniper:   { id: 'sniper',   name: 'Sniper',   blastRadius: 9,  damage: 50, projectiles: 1, spread: 0, powerMult: 1.55 },
  big_bomb: { id: 'big_bomb', name: 'Big Bomb', blastRadius: 30, damage: 62, projectiles: 1, spread: 0, powerMult: 0.95 },
  triple:   { id: 'triple',   name: 'Triple',   blastRadius: 11, damage: 22, projectiles: 3, spread: 5, powerMult: 1 },
  cluster:  { id: 'cluster',  name: 'Cluster',  blastRadius: 9,  damage: 16, projectiles: 1, spread: 0, powerMult: 1,
              cluster: { count: 5, span: 34, radius: 12, damage: 26 } },
  roller:   { id: 'roller',   name: 'Roller',   blastRadius: 18, damage: 42, projectiles: 1, spread: 0, powerMult: 1,
              roller: { maxDist: 48 } },
};

const PICKUP_WEAPONS = ['big_bomb', 'triple', 'cluster', 'roller', 'sniper'];
const PICKUP_AMMO = 2;
const PICKUP_RADIUS = 9;
const MAX_PICKUPS = 4;
const PICKUP_CHANCE = 0.7;

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
        fuel: 0,
        color: TEAM_COLORS[s.team],
        weapons: { standard: -1, sniper: 0, big_bomb: 0, triple: 0, cluster: 0, roller: 0 },
      };
    });

    this.turnIndex = 0;
    const first = this.tankOf(this.activePlayerId);
    if (first) first.fuel = MOVE_RANGE;
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
      moveRange: MOVE_RANGE,
    };
  }

  // --- driving ----------------------------------------------------------
  moveTo(playerId, targetX) {
    if (playerId !== this.activePlayerId) {
      throw new Error('Not your turn.');
    }
    const t = this.tankOf(playerId);
    if (!t || !t.alive) throw new Error('Tank is not in play.');
    if (!Number.isFinite(targetX)) throw new Error('Invalid move.');

    let nx = physics.clampX(this.world, targetX);
    const dir = Math.sign(nx - t.x);
    if (dir !== 0) {
      // Limit travel to the remaining fuel for this turn.
      if (Math.abs(nx - t.x) > t.fuel) nx = t.x + dir * t.fuel;
      // Don't drive through other living tanks.
      for (const o of this.tanks) {
        if (o === t || !o.alive) continue;
        if (dir > 0 && o.x > t.x && o.x - TANK_GAP < nx) nx = Math.min(nx, o.x - TANK_GAP);
        if (dir < 0 && o.x < t.x && o.x + TANK_GAP > nx) nx = Math.max(nx, o.x + TANK_GAP);
      }
      nx = physics.clampX(this.world, nx);
      const moved = Math.abs(nx - t.x);
      t.fuel = Math.max(0, t.fuel - moved);
      t.x = nx;
      t.y = physics.heightAt(this.world, this.heightmap, nx);
    }

    const collected = [];
    this.collectPickupsNear(t.x, t, collected);
    return { id: t.id, x: t.x, y: t.y, fuel: t.fuel, collected, pickups: this.pickups };
  }

  // --- firing -----------------------------------------------------------
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
    const rawDamages = [];
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
        this.world, this.heightmap, this.tanks, shooterId, origin, velocity, this.wind
      );

      let trajectory = shot.trajectory;
      let impact = shot.impact;
      let subImpacts = null;

      if (weapon.roller) {
        const roll = physics.rollAlongTerrain(this.world, this.heightmap, impact, weapon.roller.maxDist);
        if (roll.path.length) trajectory = trajectory.concat(roll.path);
        impact = { x: roll.x, y: roll.y };
        physics.carveCrater(this.world, this.heightmap, impact, weapon.blastRadius);
        for (const h of physics.applyDamage(this.tanks, impact, weapon.blastRadius, weapon.damage)) rawDamages.push(h);
      } else if (weapon.cluster) {
        subImpacts = this.clusterImpacts(impact, weapon.cluster);
        for (const si of subImpacts) {
          physics.carveCrater(this.world, this.heightmap, si, si.radius);
          for (const h of physics.applyDamage(this.tanks, si, si.radius, weapon.cluster.damage)) rawDamages.push(h);
        }
      } else {
        physics.carveCrater(this.world, this.heightmap, impact, weapon.blastRadius);
        for (const h of physics.applyDamage(this.tanks, impact, weapon.blastRadius, weapon.damage)) rawDamages.push(h);
      }

      this.collectPickupsNear(impact.x, shooter, collected);

      projectiles.push({
        trajectory,
        impact,
        blastRadius: weapon.blastRadius,
        kind: weaponId,
        subImpacts,
      });
    }

    physics.settleTanks(this.world, this.heightmap, this.tanks);

    if (ammo > 0) {
      shooter.weapons[weaponId] = ammo - 1;
    }

    return { projectiles, damages: mergeDamages(rawDamages), collected, weaponId };
  }

  clusterImpacts(impact, cfg) {
    const out = [];
    for (let i = 0; i < cfg.count; i++) {
      const t = cfg.count === 1 ? 0 : i / (cfg.count - 1) - 0.5;
      const x = physics.clampX(this.world, impact.x + t * cfg.span);
      out.push({ x, y: physics.heightAt(this.world, this.heightmap, x), radius: cfg.radius });
    }
    return out;
  }

  collectPickupsNear(x, tank, collected) {
    for (let n = this.pickups.length - 1; n >= 0; n--) {
      const pk = this.pickups[n];
      if (Math.abs(pk.x - x) <= PICKUP_RADIUS) {
        tank.weapons[pk.weapon] += PICKUP_AMMO;
        collected.push({ tankId: tank.id, weapon: pk.weapon, ammo: tank.weapons[pk.weapon] });
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
    const next = this.tankOf(this.activePlayerId);
    if (next) next.fuel = MOVE_RANGE;
    this.wind = randomWind();
    this.maybeSpawnPickup();
  }

  maybeSpawnPickup() {
    if (this.pickups.length >= MAX_PICKUPS) return;
    if (Math.random() > PICKUP_CHANCE) return;
    const x = (0.12 + Math.random() * 0.76) * (COLS - 1);
    this.pickups.push({
      id: ++this.pickupSeq,
      x,
      y: physics.heightAt(this.world, this.heightmap, x),
      weapon: PICKUP_WEAPONS[Math.floor(Math.random() * PICKUP_WEAPONS.length)],
    });
  }
}

function mergeDamages(raw) {
  const byId = new Map();
  for (const d of raw) {
    const cur = byId.get(d.id);
    if (cur) {
      cur.amount += d.amount;
      cur.hp = d.hp;
      cur.dead = cur.dead || d.dead;
    } else {
      byId.set(d.id, { ...d });
    }
  }
  return [...byId.values()];
}

function capacityFor(mode) {
  return mode === '2v2' ? 4 : 2;
}

module.exports = { Game, WEAPONS, capacityFor };

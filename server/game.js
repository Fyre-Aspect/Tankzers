const physics = require('./physics');

// --- world size (much larger than before) ------------------------------
const COLS = 520;
const WORLD = { cols: COLS, width: COLS };

const TURRET_HEIGHT = 5;
const BARREL_LENGTH = 5;

// How far a tank can drive per turn.
const MOVE_RANGE = 60;
const TANK_GAP = 11;
const MAX_HP = 100;

// HP / coin economy --------------------------------------------------------
const PROP_HEAL = 10;        // HP restored to the shooter per prop destroyed
const PROP_COINS = 12;       // coins earned per prop destroyed
const LIFESTEAL = 0.25;      // fraction of enemy damage returned as HP
const KILL_COINS = 60;
const WIN_COINS = 120;
const LOSS_COINS = 30;

const WEAPONS = {
  standard: { id: 'standard', name: 'Standard', blastRadius: 16, damage: 34, projectiles: 1, spread: 0, powerMult: 1 },
  sniper:   { id: 'sniper',   name: 'Sniper',   blastRadius: 9,  damage: 50, projectiles: 1, spread: 0, powerMult: 1.55 },
  big_bomb: { id: 'big_bomb', name: 'Big Bomb', blastRadius: 30, damage: 62, projectiles: 1, spread: 0, powerMult: 0.95 },
  triple:   { id: 'triple',   name: 'Triple',   blastRadius: 11, damage: 22, projectiles: 3, spread: 5, powerMult: 1 },
  cluster:  { id: 'cluster',  name: 'Cluster',  blastRadius: 9,  damage: 16, projectiles: 1, spread: 0, powerMult: 1,
              cluster: { count: 5, span: 34, radius: 12, damage: 26 } },
  roller:   { id: 'roller',   name: 'Roller',   blastRadius: 18, damage: 42, projectiles: 1, spread: 0, powerMult: 1,
              roller: { maxDist: 48 } },

  // --- chaos / elemental shots ------------------------------------------
  napalm:    { id: 'napalm',    name: 'Napalm',    blastRadius: 12, damage: 20, projectiles: 1, spread: 0, powerMult: 1,
               napalm: { span: 26, turns: 2, dmgPerTurn: 14 } },
  mortar:    { id: 'mortar',    name: 'Mortar Barrage', blastRadius: 9, damage: 14, projectiles: 1, spread: 0, powerMult: 1,
               mortar: { count: 6, span: 64, radius: 11, damage: 20 } },
  earthmover:{ id: 'earthmover',name: 'Earthmover',blastRadius: 7,  damage: 8,  projectiles: 1, spread: 0, powerMult: 1,
               earth: { radius: 16, height: 34 } },
  lightning: { id: 'lightning', name: 'Lightning', blastRadius: 11, damage: 40, projectiles: 1, spread: 0, powerMult: 1,
               chain: { range: 72, radius: 9, damage: 26 } },
  blackhole: { id: 'blackhole', name: 'Black Hole',blastRadius: 22, damage: 30, projectiles: 1, spread: 0, powerMult: 1,
               pull: { range: 90, strength: 26 } },
};

// Starting loadouts (kits). The server is authoritative: clients may *request*
// a kit, but the actual ammo a tank starts with is read from here.
const KITS = {
  standard:   { id: 'standard',   name: 'Recruit',    price: 0,    desc: 'Unlimited standard shells. Reliable and free.',                      weapons: { standard: -1 } },
  marksman:   { id: 'marksman',   name: 'Marksman',   price: 300,  desc: 'Long-range sniper rounds for precise hits.',                          weapons: { standard: -1, sniper: 4 } },
  demolition: { id: 'demolition', name: 'Demolisher', price: 450,  desc: 'Heavy big-bombs that reshape the battlefield.',                       weapons: { standard: -1, big_bomb: 3 } },
  trooper:    { id: 'trooper',    name: 'Trooper',    price: 400,  desc: 'Triple-shot spread for area suppression.',                            weapons: { standard: -1, triple: 3 } },
  saboteur:   { id: 'saboteur',   name: 'Saboteur',   price: 500,  desc: 'Cluster munitions that scatter on impact.',                           weapons: { standard: -1, cluster: 3 } },
  vanguard:   { id: 'vanguard',   name: 'Vanguard',   price: 650,  desc: 'Rolling charges that chase enemies into cover.',                      weapons: { standard: -1, roller: 3 } },
  pyro:       { id: 'pyro',       name: 'Pyro',       price: 700,  desc: 'Napalm rounds that leave a lingering blaze.',                         weapons: { standard: -1, napalm: 3 } },
  artillery:  { id: 'artillery',  name: 'Artillery',  price: 750,  desc: 'Mortar barrage rains shells across a wide span.',                     weapons: { standard: -1, mortar: 3 } },
  engineer:   { id: 'engineer',   name: 'Engineer',   price: 600,  desc: 'Earthmover charges raise dirt walls for cover.',                      weapons: { standard: -1, earthmover: 4 } },
  stormcaller:{ id: 'stormcaller',name: 'Stormcaller',price: 850,  desc: 'Lightning that forks to a second nearby enemy.',                      weapons: { standard: -1, lightning: 3 } },
  juggernaut: { id: 'juggernaut', name: 'Juggernaut', price: 1200, special: true, desc: 'A bit of everything heavy. For the well-funded.',      weapons: { standard: -1, big_bomb: 2, roller: 2, cluster: 2 } },
  warlord:    { id: 'warlord',    name: 'Warlord',    price: 1900, special: true, desc: 'Elite arsenal: snipers, triples and big-bombs.',       weapons: { standard: -1, sniper: 3, triple: 3, big_bomb: 2 } },
  voidlord:   { id: 'voidlord',   name: 'Voidlord',   price: 2200, special: true, desc: 'Black holes that drag tanks into the blast.',           weapons: { standard: -1, blackhole: 2, lightning: 2 } },
};

// Cosmetic skins. Purely visual; the server stores + relays the chosen id.
const SKINS = {
  default: { id: 'default', name: 'Standard',     price: 0 },
  desert:  { id: 'desert',  name: 'Desert Camo',  price: 200 },
  forest:  { id: 'forest',  name: 'Forest Camo',  price: 200 },
  arctic:  { id: 'arctic',  name: 'Arctic',       price: 250 },
  carbon:  { id: 'carbon',  name: 'Carbon',       price: 450 },
  gold:    { id: 'gold',    name: 'Gold Plated',  price: 1500, special: true },
};

const PICKUP_WEAPONS = ['big_bomb', 'triple', 'cluster', 'roller', 'sniper', 'napalm', 'mortar', 'earthmover', 'lightning', 'blackhole'];
const PICKUP_AMMO = 2;
const PICKUP_RADIUS = 9;
const MAX_PICKUPS = 5;
const PICKUP_CHANCE = 0.75;

// Crate flavours. A weapon crate grants ammo; a health crate heals; a bonus
// crate (the spinning one) pays coins + a random special weapon top-up.
const PICKUP_TYPE_WEIGHTS = [
  { type: 'weapon', w: 0.6 },
  { type: 'health', w: 0.28 },
  { type: 'bonus', w: 0.12 },
];
const HEALTH_PICKUP_HP = 35;
const BONUS_PICKUP_COINS = 80;
const BONUS_PICKUP_AMMO = 2;

// How many full rounds (one turn per player) pass before the terrain "settles".
const REFORM_ROUNDS = 3;

function pickPickupType() {
  let r = Math.random();
  for (const e of PICKUP_TYPE_WEIGHTS) {
    r -= e.w;
    if (r <= 0) return e.type;
  }
  return 'weapon';
}

const TEAM_COLORS = ['#4ad9ff', '#ff7a4a'];

// --- biomes --------------------------------------------------------------
// Each biome supplies a height generator plus a palette + decoration set the
// client uses to colour the world. `water` (when set) is a sea level.
const BIOMES = {
  hills: {
    id: 'hills', name: 'Verdant Hills',
    sky: ['#4f93dd', '#86b6e6', '#bcd4ee', '#dfeaf4'], fog: '#bcd4ee',
    low: '#4e9a4e', high: '#84c768', rock: '#7a6a4d', dirt: '#6b4e33', dirtDeep: '#4a3522',
    water: null, props: ['tree', 'rock', 'barrel', 'crate', 'boulder'], density: 1.0,
  },
  desert: {
    id: 'desert', name: 'Dune Sea',
    sky: ['#e7a14b', '#f3c77a', '#f6e3b0', '#fbf0d2'], fog: '#ecd8a6',
    low: '#caa45a', high: '#e8d199', rock: '#b08a4e', dirt: '#a8753c', dirtDeep: '#7c5326',
    water: null, props: ['cactus', 'rock', 'barrel', 'arch'], density: 0.7,
  },
  mountains: {
    id: 'mountains', name: 'Frostpeak Range',
    sky: ['#5a7fb0', '#8aa6c8', '#c2d2e4', '#eef4fa'], fog: '#d2dde8',
    low: '#6c7a86', high: '#ffffff', rock: '#5c6770', dirt: '#55606a', dirtDeep: '#3a424a',
    water: null, props: ['pine', 'rock', 'boulder'], density: 0.8, snowline: 64,
  },
  islands: {
    id: 'islands', name: 'Coral Archipelago',
    sky: ['#2f8fd0', '#6fb6e0', '#aedcf0', '#dff2fb'], fog: '#bfe2f2',
    low: '#d8c48a', high: '#5fb35a', rock: '#8a7a55', dirt: '#c2a86a', dirtDeep: '#8f7642',
    water: 20, props: ['palm', 'rock', 'barrel', 'arch'], density: 0.8,
  },
  valley: {
    id: 'valley', name: 'Riftgreen Valley',
    sky: ['#5b86c4', '#8fb0d8', '#c4d6ea', '#e6eef6'], fog: '#c4d6ea',
    low: '#46913f', high: '#7fbf63', rock: '#6e6048', dirt: '#5e4a30', dirtDeep: '#3f3220',
    water: null, props: ['tree', 'rock', 'crate', 'barrel', 'ruin', 'boulder'], density: 1.0,
  },
  wasteland: {
    id: 'wasteland', name: 'Scorched Wastes',
    sky: ['#7a4b3a', '#a9705a', '#c79a82', '#e0c4ad'], fog: '#c39880',
    low: '#6e4a36', high: '#9a6a44', rock: '#5a4636', dirt: '#4e3826', dirtDeep: '#33241a',
    water: null, props: ['rock', 'barrel', 'crate', 'ruin', 'arch', 'boulder'], density: 0.9,
  },
};

const BIOME_IDS = Object.keys(BIOMES);

function randf(a, b) { return a + Math.random() * (b - a); }
function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

// Layered-sine pseudo-noise — cheap, deterministic per phase, smooth enough.
function makeNoise() {
  const ph = [randf(0, 6.28), randf(0, 6.28), randf(0, 6.28), randf(0, 6.28)];
  return (u) =>
    Math.sin(u * Math.PI * 2 + ph[0]) * 0.5 +
    Math.sin(u * Math.PI * 5 + ph[1]) * 0.28 +
    Math.sin(u * Math.PI * 9 + ph[2]) * 0.14 +
    Math.sin(u * Math.PI * 17 + ph[3]) * 0.08;
}

function genHills() {
  const n = makeNoise();
  const hm = new Array(COLS);
  for (let i = 0; i < COLS; i++) {
    const u = i / (COLS - 1);
    hm[i] = 40 + n(u) * 22;
  }
  return hm;
}

function genDesert() {
  const n = makeNoise();
  const hm = new Array(COLS);
  const ph = randf(0, 6.28);
  for (let i = 0; i < COLS; i++) {
    const u = i / (COLS - 1);
    // big smooth dunes with a touch of sharp crest asymmetry
    const dune = Math.sin(u * Math.PI * 7 + ph);
    hm[i] = 34 + Math.abs(dune) * 18 + n(u) * 6;
  }
  return hm;
}

function genMountains() {
  const n = makeNoise();
  const hm = new Array(COLS);
  const ph = randf(0, 6.28);
  for (let i = 0; i < COLS; i++) {
    const u = i / (COLS - 1);
    // ridged noise → sharp alpine peaks
    const ridge = 1 - Math.abs(Math.sin(u * Math.PI * 6 + ph));
    hm[i] = 36 + ridge * ridge * 52 + (n(u) + 1) * 6;
  }
  return hm;
}

function genValley() {
  const n = makeNoise();
  const hm = new Array(COLS);
  for (let i = 0; i < COLS; i++) {
    const u = i / (COLS - 1);
    const edge = Math.pow(Math.abs(u - 0.5) * 2, 1.7); // 1 at edges, 0 in centre
    hm[i] = 22 + edge * 50 + n(u) * 8;
  }
  return hm;
}

function genPlateau() {
  const n = makeNoise();
  const hm = new Array(COLS);
  const ph = randf(0, 6.28);
  for (let i = 0; i < COLS; i++) {
    const u = i / (COLS - 1);
    const field = Math.sin(u * Math.PI * 4 + ph) * 0.5 + 0.5;
    // quantise into stepped mesas with steep transitions
    const level = Math.round(field * 3) / 3;
    hm[i] = 30 + level * 44 + n(u) * 4;
  }
  return hm;
}

function genIslands(water) {
  const hm = new Array(COLS).fill(8);
  const n = makeNoise();
  const count = 4 + Math.floor(Math.random() * 3);
  const peaks = [];
  for (let k = 0; k < count; k++) {
    peaks.push({ c: randf(0.08, 0.92), w: randf(0.05, 0.13), h: randf(water + 14, water + 40) });
  }
  for (let i = 0; i < COLS; i++) {
    const u = i / (COLS - 1);
    let h = 8;
    for (const p of peaks) {
      const d = (u - p.c) / p.w;
      h += p.h * Math.exp(-d * d);
    }
    hm[i] = h + (n(u) + 1) * 2.5;
  }
  return hm;
}

// Bake larger map structure into the heightmap: a few flat-topped mesas with
// steep shoulders plus the odd linear ramp. These become real, drivable,
// shootable terrain (not just decoration) so maps read as more built-up.
function addStructures(hm, water) {
  const n = hm.length;
  const floor = water != null ? water + 4 : 6;
  const mesas = 1 + Math.floor(Math.random() * 3);
  for (let m = 0; m < mesas; m++) {
    const c = Math.floor(randf(0.12, 0.88) * n);
    const half = Math.floor(randf(10, 26));
    const top = hm[c] + randf(14, 30);
    for (let i = c - half; i <= c + half; i++) {
      if (i < 0 || i >= n) continue;
      const edge = Math.abs(i - c) / half;             // 0 centre … 1 edge
      const shoulder = edge > 0.78 ? Math.max(0, 1 - (edge - 0.78) / 0.22) : 1;
      hm[i] = Math.max(hm[i], hm[i] * (1 - shoulder) + top * shoulder);
    }
  }
  const ramps = Math.floor(Math.random() * 2);
  for (let r = 0; r < ramps; r++) {
    const start = Math.floor(randf(0.1, 0.7) * n);
    const len = Math.floor(randf(24, 50));
    const rise = randf(12, 26) * (Math.random() < 0.5 ? 1 : -1);
    for (let k = 0; k <= len; k++) {
      const i = start + k;
      if (i < 0 || i >= n) continue;
      hm[i] = Math.max(floor, hm[i] + (k / len) * rise);
    }
  }
}

function generateWorld() {
  const id = BIOME_IDS[Math.floor(Math.random() * BIOME_IDS.length)];
  const biome = BIOMES[id];
  let hm;
  switch (id) {
    case 'desert':    hm = genDesert(); break;
    case 'mountains': hm = genMountains(); break;
    case 'valley':    hm = genValley(); break;
    case 'wasteland': hm = genPlateau(); break;
    case 'islands':   hm = genIslands(biome.water); break;
    default:          hm = genHills(); break;
  }
  if (id !== 'islands') addStructures(hm, biome.water);
  // clamp into the renderable band
  for (let i = 0; i < COLS; i++) hm[i] = clamp(hm[i], 6, 92);
  return { biomeId: id, biome, heightmap: hm };
}

function flattenPad(hm, cx, half, forced) {
  const c = Math.round(clamp(cx, 0, COLS - 1));
  const target = forced != null ? forced : hm[c];
  const i0 = Math.max(0, c - half);
  const i1 = Math.min(COLS - 1, c + half);
  for (let i = i0; i <= i1; i++) {
    const t = 1 - Math.abs(i - c) / (half + 1); // feathered edges
    hm[i] = hm[i] * (1 - t) + target * t;
  }
}

function spawnLayout(mode) {
  if (mode === '1v1') {
    return [
      { team: 0, fx: 0.12 },
      { team: 1, fx: 0.88 },
    ];
  }
  return [
    { team: 0, fx: 0.08 },
    { team: 1, fx: 0.74 },
    { team: 0, fx: 0.26 },
    { team: 1, fx: 0.92 },
  ];
}

// destructible prop archetypes
const PROP_DEFS = {
  barrel: { r: 3.0, hp: 26 },
  crate:  { r: 3.0, hp: 34 },
  tree:   { r: 4.0, hp: 22 },
  pine:   { r: 4.0, hp: 22 },
  rock:   { r: 3.6, hp: 60 },
  cactus: { r: 2.6, hp: 18 },
  palm:   { r: 4.0, hp: 22 },
  // larger structural cover pieces
  boulder: { r: 4.8, hp: 95 },
  arch:    { r: 5.4, hp: 80 },
  ruin:    { r: 4.4, hp: 70 },
};

function randomWind() {
  return Math.round((Math.random() * 2 - 1) * 10);
}

class Game {
  // players: array of { id, name, kit, color, skin }
  constructor(players, mode) {
    this.mode = mode;
    this.world = WORLD;

    const w = generateWorld();
    this.biomeId = w.biomeId;
    this.biome = w.biome;
    this.heightmap = w.heightmap;
    this.water = w.biome.water;

    this.wind = randomWind();
    this.players = players.map((p) => p.id);
    this.pickups = [];
    this.pickupSeq = 0;
    this.propSeq = 0;
    this.rewards = {};
    this.hazards = [];        // lingering napalm fire zones
    this.hazardSeq = 0;
    this.turnsTaken = 0;      // total turns advanced (drives terrain reform)

    const layout = spawnLayout(mode);
    const padHeight = this.water != null ? this.water + 12 : null;

    // First place + flatten spawn pads so nobody starts on a cliff / underwater.
    const spawnX = players.map((_, i) => layout[i].fx * (COLS - 1));
    for (const sx of spawnX) flattenPad(this.heightmap, sx, 10, padHeight);

    this.tanks = players.map((p, i) => {
      const s = layout[i];
      const x = spawnX[i];
      const kit = KITS[p.kit] || KITS.standard;
      this.rewards[p.id] = { coins: 0, kills: 0, propsDestroyed: 0 };
      return {
        id: p.id,
        team: s.team,
        name: (p.name || `P${i + 1}`).slice(0, 14),
        x,
        y: physics.heightAt(WORLD, this.heightmap, x),
        hp: MAX_HP,
        maxHp: MAX_HP,
        alive: true,
        fuel: 0,
        color: sanitizeColor(p.color) || TEAM_COLORS[s.team],
        teamColor: TEAM_COLORS[s.team],
        skin: SKINS[p.skin] ? p.skin : 'default',
        kit: kit.id,
        weapons: { ...kit.weapons },
      };
    });

    this.props = this.generateProps(spawnX);

    this.turnIndex = 0;
    const first = this.tankOf(this.activePlayerId);
    if (first) first.fuel = MOVE_RANGE;
  }

  generateProps(spawnX) {
    const out = [];
    const types = this.biome.props;
    const target = Math.round((COLS / 26) * (this.biome.density || 1));
    let guard = 0;
    while (out.length < target && guard++ < target * 8) {
      const x = randf(8, COLS - 8);
      const y = physics.heightAt(this.world, this.heightmap, x);
      if (this.water != null && y < this.water + 2) continue;       // not in the sea
      if (spawnX.some((sx) => Math.abs(sx - x) < 16)) continue;      // clear of spawns
      if (out.some((p) => Math.abs(p.x - x) < 8)) continue;          // not stacked
      const type = types[Math.floor(Math.random() * types.length)];
      const def = PROP_DEFS[type];
      out.push({ id: ++this.propSeq, type, x, y, r: def.r, hp: def.hp, maxHp: def.hp, alive: true });
    }
    return out;
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
      props: this.props,
      wind: this.wind,
      activePlayerId: this.activePlayerId,
      pickups: this.pickups,
      hazards: this.hazards,
      weapons: WEAPONS,
      kits: KITS,
      skins: SKINS,
      moveRange: MOVE_RANGE,
      maxHp: MAX_HP,
      biome: {
        id: this.biomeId,
        name: this.biome.name,
        sky: this.biome.sky,
        fog: this.biome.fog,
        low: this.biome.low,
        high: this.biome.high,
        rock: this.biome.rock,
        dirt: this.biome.dirt,
        dirtDeep: this.biome.dirtDeep,
        snowline: this.biome.snowline || null,
        water: this.water,
      },
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
      if (Math.abs(nx - t.x) > t.fuel) nx = t.x + dir * t.fuel;
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
    if (ammo === 0 || ammo === undefined) {
      throw new Error('No ammo for that weapon.');
    }

    const projectiles = [];
    const rawDamages = [];
    const collected = [];
    let propsDestroyed = 0;
    const speed = power * physics.POWER_SCALE * weapon.powerMult;

    const blastProps = (impact, radius, damage) => {
      const killed = physics.applyDamageToProps(this.props, impact, radius, damage);
      propsDestroyed += killed.length;
    };

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
        this.world, this.heightmap, this.tanks, this.props, shooterId, origin, velocity, this.wind
      );

      let trajectory = shot.trajectory;
      let impact = shot.impact;
      let subImpacts = null;
      let chainImpact = null;   // lightning fork target (for the client bolt)
      let pulledTanks = null;   // black-hole displacements (for the client swirl)

      if (weapon.roller) {
        const roll = physics.rollAlongTerrain(this.world, this.heightmap, impact, weapon.roller.maxDist);
        if (roll.path.length) trajectory = trajectory.concat(roll.path);
        impact = { x: roll.x, y: roll.y };
        physics.carveCrater(this.world, this.heightmap, impact, weapon.blastRadius);
        blastProps(impact, weapon.blastRadius, weapon.damage);
        for (const h of physics.applyDamage(this.tanks, impact, weapon.blastRadius, weapon.damage)) rawDamages.push(h);
      } else if (weapon.cluster || weapon.mortar) {
        const cfg = weapon.cluster || weapon.mortar;
        subImpacts = this.clusterImpacts(impact, cfg);
        for (const si of subImpacts) {
          physics.carveCrater(this.world, this.heightmap, si, si.radius);
          blastProps(si, si.radius, cfg.damage);
          for (const h of physics.applyDamage(this.tanks, si, si.radius, cfg.damage)) rawDamages.push(h);
        }
      } else if (weapon.napalm) {
        physics.carveCrater(this.world, this.heightmap, impact, weapon.blastRadius);
        blastProps(impact, weapon.blastRadius, weapon.damage);
        for (const h of physics.applyDamage(this.tanks, impact, weapon.blastRadius, weapon.damage)) rawDamages.push(h);
        this.spawnHazard(impact, weapon.napalm, shooterId);
      } else if (weapon.earth) {
        // builds a wall instead of a crater; only a light shove of damage
        physics.raiseMound(this.world, this.heightmap, impact, weapon.earth.radius, weapon.earth.height);
        blastProps(impact, weapon.blastRadius, weapon.damage);
        for (const h of physics.applyDamage(this.tanks, impact, weapon.blastRadius, weapon.damage)) rawDamages.push(h);
      } else if (weapon.chain) {
        // lightning: strike the impact, then arc to the nearest other enemy
        physics.carveCrater(this.world, this.heightmap, impact, weapon.blastRadius);
        blastProps(impact, weapon.blastRadius, weapon.damage);
        for (const h of physics.applyDamage(this.tanks, impact, weapon.blastRadius, weapon.damage)) rawDamages.push(h);
        const target = this.nearestEnemyTo(impact, shooter.team, weapon.chain.range);
        if (target) {
          const ground = { x: target.x, y: target.y };
          const centre = { x: target.x, y: target.y + physics.TANK_CENTER_Y };
          physics.carveCrater(this.world, this.heightmap, ground, weapon.chain.radius);
          blastProps(ground, weapon.chain.radius, weapon.chain.damage);
          for (const h of physics.applyDamage(this.tanks, centre, weapon.chain.radius, weapon.chain.damage)) rawDamages.push(h);
          chainImpact = ground;
        }
      } else if (weapon.pull) {
        // black hole: drag tanks in, then detonate hard at the centre
        const moved = physics.pullTanks(this.world, this.heightmap, this.tanks, impact, weapon.pull.range, weapon.pull.strength);
        pulledTanks = moved.map((t) => ({ id: t.id, x: t.x, y: t.y }));
        physics.carveCrater(this.world, this.heightmap, impact, weapon.blastRadius);
        blastProps(impact, weapon.blastRadius, weapon.damage);
        for (const h of physics.applyDamage(this.tanks, impact, weapon.blastRadius, weapon.damage)) rawDamages.push(h);
      } else {
        physics.carveCrater(this.world, this.heightmap, impact, weapon.blastRadius);
        blastProps(impact, weapon.blastRadius, weapon.damage);
        for (const h of physics.applyDamage(this.tanks, impact, weapon.blastRadius, weapon.damage)) rawDamages.push(h);
      }

      this.collectPickupsNear(impact.x, shooter, collected);

      projectiles.push({
        trajectory,
        impact,
        blastRadius: weapon.blastRadius,
        kind: weaponId,
        subImpacts,
        chainImpact,
        pulledTanks,
      });
    }

    physics.settleTanks(this.world, this.heightmap, this.tanks);
    physics.settleProps(this.world, this.heightmap, this.props);

    if (ammo > 0) {
      shooter.weapons[weaponId] = ammo - 1;
    }

    const damages = mergeDamages(rawDamages);

    // --- HP gain & rewards ------------------------------------------------
    const heals = [];
    let healTotal = 0;

    // 1) destroying scenery heals + pays the shooter
    if (propsDestroyed > 0 && shooter.alive) {
      healTotal += propsDestroyed * PROP_HEAL;
      this.rewards[shooterId].coins += propsDestroyed * PROP_COINS;
      this.rewards[shooterId].propsDestroyed += propsDestroyed;
    }

    // 2) lifesteal from damage dealt to *enemies*
    let enemyDamage = 0;
    for (const d of damages) {
      const victim = this.tankOf(d.id);
      if (victim && victim.team !== shooter.team) {
        enemyDamage += d.amount;
        if (d.dead) {
          this.rewards[shooterId].coins += KILL_COINS;
          this.rewards[shooterId].kills += 1;
        }
      }
    }
    if (enemyDamage > 0 && shooter.alive) healTotal += Math.round(enemyDamage * LIFESTEAL);

    if (healTotal > 0 && shooter.alive) {
      const before = shooter.hp;
      shooter.hp = Math.min(shooter.maxHp, shooter.hp + healTotal);
      const gained = shooter.hp - before;
      if (gained > 0) heals.push({ id: shooterId, amount: gained });
    }

    const destroyedPropIds = this.props.filter((p) => !p.alive).map((p) => p.id);
    // prune dead props so the array stays small; the client removes by id
    this.props = this.props.filter((p) => p.alive);

    return {
      projectiles,
      damages,
      collected,
      heals,
      destroyedProps: destroyedPropIds,
      weaponId,
    };
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
      if (Math.abs(pk.x - x) > PICKUP_RADIUS) continue;
      if (pk.type === 'health') {
        const before = tank.hp;
        tank.hp = Math.min(tank.maxHp, tank.hp + HEALTH_PICKUP_HP);
        collected.push({ tankId: tank.id, type: 'health', heal: tank.hp - before, hp: tank.hp });
      } else if (pk.type === 'bonus') {
        if (this.rewards[tank.id]) this.rewards[tank.id].coins += BONUS_PICKUP_COINS;
        const wid = PICKUP_WEAPONS[Math.floor(Math.random() * PICKUP_WEAPONS.length)];
        if (tank.weapons[wid] === undefined) tank.weapons[wid] = 0;
        if (tank.weapons[wid] >= 0) tank.weapons[wid] += BONUS_PICKUP_AMMO;
        collected.push({ tankId: tank.id, type: 'bonus', coins: BONUS_PICKUP_COINS, weapon: wid, ammo: tank.weapons[wid] });
      } else {
        if (tank.weapons[pk.weapon] === undefined) tank.weapons[pk.weapon] = 0;
        if (tank.weapons[pk.weapon] >= 0) tank.weapons[pk.weapon] += PICKUP_AMMO;
        collected.push({ tankId: tank.id, type: 'weapon', weapon: pk.weapon, ammo: tank.weapons[pk.weapon] });
      }
      this.pickups.splice(n, 1);
    }
  }

  // nearest living enemy to a point (used by Lightning's chain), skipping the
  // tank that already absorbed the primary strike.
  nearestEnemyTo(point, team, range) {
    let best = null;
    let bestD = Infinity;
    for (const t of this.tanks) {
      if (!t.alive || t.team === team) continue;
      const dx = t.x - point.x;
      const dy = (t.y + physics.TANK_CENTER_Y) - point.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d <= 8) continue;          // that's the primary target
      if (d <= range && d < bestD) { bestD = d; best = t; }
    }
    return best;
  }

  spawnHazard(impact, cfg, ownerId) {
    this.hazards.push({
      id: ++this.hazardSeq,
      x: impact.x,
      span: cfg.span,
      turnsLeft: cfg.turns,
      dmgPerTurn: cfg.dmgPerTurn,
      ownerId,
    });
  }

  // Apply one tick of every active fire zone to the tanks standing in it, then
  // age the zones out. Returns merged damage records for the broadcast.
  tickHazards() {
    const out = [];
    for (let n = this.hazards.length - 1; n >= 0; n--) {
      const hz = this.hazards[n];
      for (const t of this.tanks) {
        if (!t.alive) continue;
        if (Math.abs(t.x - hz.x) <= hz.span / 2) {
          t.hp -= hz.dmgPerTurn;
          if (t.hp <= 0) { t.hp = 0; t.alive = false; }
          out.push({ id: t.id, amount: hz.dmgPerTurn, hp: t.hp, dead: !t.alive });
        }
      }
      hz.turnsLeft -= 1;
      if (hz.turnsLeft <= 0) this.hazards.splice(n, 1);
    }
    return mergeDamages(out);
  }

  // Every few rounds the battlefield "settles": smooth it out and pull heights a
  // little toward the average so the map gradually becomes more level.
  levelTerrain() {
    const hm = this.heightmap;
    const n = hm.length;
    let mean = 0;
    for (let i = 0; i < n; i++) mean += hm[i];
    mean /= n;
    for (let pass = 0; pass < 2; pass++) {
      const src = hm.slice();
      for (let i = 0; i < n; i++) {
        const a = src[Math.max(0, i - 1)];
        const b = src[i];
        const c = src[Math.min(n - 1, i + 1)];
        hm[i] = (a + b + c) / 3;
      }
    }
    for (let i = 0; i < n; i++) hm[i] = clamp(hm[i] + (mean - hm[i]) * 0.18, 6, 92);
    for (const t of this.tanks) { if (t.alive) flattenPad(hm, t.x, 6); }
    physics.settleTanks(this.world, hm, this.tanks);
    physics.settleProps(this.world, hm, this.props);
  }

  // Returns { hazardDamages, terrainReform } so the caller can fold the burn
  // ticks into the broadcast and flag a settle for the client.
  advanceTurn() {
    const hazardDamages = this.tickHazards();
    for (let i = 0; i < this.players.length; i++) {
      this.turnIndex = (this.turnIndex + 1) % this.players.length;
      const tank = this.tankOf(this.activePlayerId);
      if (tank && tank.alive) break;
    }
    const next = this.tankOf(this.activePlayerId);
    if (next) next.fuel = MOVE_RANGE;
    this.wind = randomWind();

    this.turnsTaken += 1;
    let terrainReform = false;
    if (this.turnsTaken % (this.players.length * REFORM_ROUNDS) === 0) {
      this.levelTerrain();
      terrainReform = true;
    }

    this.maybeSpawnPickup();
    return { hazardDamages, terrainReform };
  }

  maybeSpawnPickup() {
    if (this.pickups.length >= MAX_PICKUPS) return;
    if (Math.random() > PICKUP_CHANCE) return;
    let x, y, guard = 0;
    do {
      x = (0.1 + Math.random() * 0.8) * (COLS - 1);
      y = physics.heightAt(this.world, this.heightmap, x);
    } while (this.water != null && y < this.water + 2 && guard++ < 12);
    const type = pickPickupType();
    const pk = { id: ++this.pickupSeq, x, y, type };
    if (type === 'weapon') {
      pk.weapon = PICKUP_WEAPONS[Math.floor(Math.random() * PICKUP_WEAPONS.length)];
    }
    this.pickups.push(pk);
  }

  // Final per-player payouts once the match ends.
  finalRewards(winnerTeam) {
    const out = {};
    for (const t of this.tanks) {
      const r = this.rewards[t.id] || { coins: 0, kills: 0, propsDestroyed: 0 };
      const won = winnerTeam != null && t.team === winnerTeam;
      const total = r.coins + (won ? WIN_COINS : LOSS_COINS);
      out[t.id] = { coins: total, kills: r.kills, propsDestroyed: r.propsDestroyed, won };
    }
    return out;
  }
}

function sanitizeColor(c) {
  if (typeof c !== 'string') return null;
  return /^#[0-9a-fA-F]{6}$/.test(c) ? c : null;
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

// Validate / normalise a client-supplied profile before it touches the game.
function sanitizeProfile(p) {
  p = p || {};
  return {
    name: typeof p.name === 'string' && p.name.trim() ? p.name.trim().slice(0, 14) : 'Player',
    kit: KITS[p.kit] ? p.kit : 'standard',
    color: sanitizeColor(p.color),
    skin: SKINS[p.skin] ? p.skin : 'default',
  };
}

module.exports = { Game, WEAPONS, KITS, SKINS, capacityFor, sanitizeProfile }
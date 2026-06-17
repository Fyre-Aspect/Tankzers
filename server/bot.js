// Server-side AI opponents for "Practice vs Bots" matches.
//
// A bot is just a player with a synthetic id. On its turn the server asks this
// module what to do: optionally drive toward a worthwhile crate, then pick a
// weapon + (angle, power) by searching real trajectories through the physics
// simulation — the same simulation that resolves the shot — so what the bot
// aims at is what actually happens.

const physics = require('./physics');
const { WEAPONS, shotKinematics } = require('./game');

const BOT_NAMES = ['Ironclad', 'Vulkan', 'Havoc', 'Bandit', 'Rampart', 'Bishop', 'Crusher', 'Talon', 'Diesel', 'Maverick', 'Goliath', 'Cobra'];
const BOT_KITS = ['standard', 'marksman', 'demolition', 'trooper', 'saboteur', 'vanguard'];
const BOT_SKINS = ['default', 'desert', 'forest', 'arctic', 'carbon'];

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

// Build N distinct bot profiles to fill the empty slots of a match.
function makeBotProfiles(count) {
  const names = BOT_NAMES.slice();
  const out = [];
  for (let i = 0; i < count; i++) {
    const ni = Math.floor(Math.random() * names.length);
    const name = names.splice(ni, 1)[0] || `Bot ${i + 1}`;
    out.push({ name, kit: pick(BOT_KITS), color: null, skin: pick(BOT_SKINS) });
  }
  return out;
}

// Weapons the bot currently has ammo for (standard is unlimited, so always there).
function availableWeapons(bot) {
  const out = [];
  for (const wid of Object.keys(bot.weapons)) {
    if (!WEAPONS[wid]) continue;
    if (bot.weapons[wid] === 0) continue;   // spent
    out.push(wid);
  }
  if (!out.includes('standard')) out.push('standard');
  return out;
}

function dist(ax, ay, bx, by) { const dx = ax - bx, dy = ay - by; return Math.sqrt(dx * dx + dy * dy); }

// Predict where a shot lands, using the exact muzzle math the game uses to fire.
function predictImpact(game, bot, angle, power, weapon) {
  const { origin, velocity } = shotKinematics(bot, angle, weapon, power);
  const shot = physics.simulateProjectile(
    game.world, game.heightmap, game.tanks, game.props, bot.id, origin, velocity, game.wind
  );
  return shot.impact;
}

// Decide whether to drive somewhere this turn. Bots only reposition to grab a
// crate that's actually worth the fuel (health when hurt, ammo/bonus otherwise).
// Returns a target x, or null to stay put. Movement itself is handled by the
// game's authoritative moveTo (fuel, collisions and pickups all enforced there).
function chooseMove(game, bot) {
  if (!game.pickups || !game.pickups.length) return null;
  let bestX = null;
  let bestScore = 10; // a minimum bar so bots don't waste a move on a trivial gain
  for (const pk of game.pickups) {
    const reach = Math.abs(pk.x - bot.x);
    if (reach > bot.fuel) continue;
    let value;
    if (pk.type === 'health') value = bot.maxHp - bot.hp; // only valuable while wounded
    else if (pk.type === 'bonus') value = 30;
    else value = 20;
    const score = value - reach * 0.25;
    if (score > bestScore) { bestScore = score; bestX = pk.x; }
  }
  return bestX;
}

// Pick a weapon + firing solution. `aimError` (degrees) blurs the result so bots
// are competent but beatable; pass 0 for a dead-eye shot.
function planShot(game, bot, opts = {}) {
  const aimError = opts.aimError != null ? opts.aimError : 0;
  const enemies = game.tanks.filter((t) => t.alive && t.team !== bot.team);

  if (!enemies.length) {
    // No legal target (shouldn't happen during a live turn) — lob away from a wall.
    return { angle: bot.x < game.world.cols / 2 ? 60 : 120, power: 60, weapon: 'standard' };
  }

  // Prefer a close, wounded enemy — presses advantage and lands finishing blows.
  let target = enemies[0];
  let targetScore = Infinity;
  for (const e of enemies) {
    const s = Math.abs(e.x - bot.x) + e.hp * 1.5;
    if (s < targetScore) { targetScore = s; target = e; }
  }
  const tx = target.x;
  const ty = target.y + physics.TANK_CENTER_Y;

  const weapons = availableWeapons(bot);
  const toRight = target.x >= bot.x;
  const aLo = toRight ? 8 : 95;
  const aHi = toRight ? 85 : 172;

  let best = null;
  const consider = (angle, power, wid) => {
    if (angle < 1 || angle > 179 || power < 5 || power > 100) return;
    const weapon = WEAPONS[wid];
    const impact = predictImpact(game, bot, angle, power, weapon);
    const d = dist(impact.x, impact.y, tx, ty);
    // A near-miss inside the blast still hurts; a heavier shell breaks ties.
    const score = Math.max(0, d - weapon.blastRadius * 0.5) - weapon.damage * 0.04;
    if (!best || score < best.score) best = { angle, power, weapon: wid, score, d };
  };

  // Coarse sweep across every available weapon, then refine around the winner.
  for (const wid of weapons) {
    for (let a = aLo; a <= aHi; a += 5) {
      for (let p = 28; p <= 100; p += 8) consider(a, p, wid);
    }
  }
  if (best) {
    const wid = best.weapon;
    for (let a = best.angle - 5; a <= best.angle + 5; a += 1.5) {
      for (let p = best.power - 8; p <= best.power + 8; p += 2) consider(a, p, wid);
    }
  }

  let angle = best.angle + (Math.random() * 2 - 1) * aimError;
  let power = best.power + (Math.random() * 2 - 1) * aimError * 0.8;
  angle = Math.max(1, Math.min(179, angle));
  power = Math.max(5, Math.min(100, power));
  return { angle, power, weapon: best.weapon };
}

module.exports = { makeBotProfiles, chooseMove, planShot };

// Shared catalog data for the menu, shop and game renderer.
// The SERVER is authoritative for kit loadouts (server/game.js KITS) — this
// mirror exists so the shop/menu can render prices and descriptions before a
// match starts. Keep prices/ids in sync with the server.

export const KITS = {
  standard:   { id: 'standard',   name: 'Recruit',    price: 0,    desc: 'Unlimited standard shells. Reliable and free.',         loadout: 'Standard ∞' },
  marksman:   { id: 'marksman',   name: 'Marksman',   price: 300,  desc: 'Long-range sniper rounds for precise hits.',            loadout: 'Standard ∞ · Sniper ×4' },
  demolition: { id: 'demolition', name: 'Demolisher', price: 450,  desc: 'Heavy big-bombs that reshape the battlefield.',         loadout: 'Standard ∞ · Big Bomb ×3' },
  trooper:    { id: 'trooper',    name: 'Trooper',    price: 400,  desc: 'Triple-shot spread for area suppression.',              loadout: 'Standard ∞ · Triple ×3' },
  saboteur:   { id: 'saboteur',   name: 'Saboteur',   price: 500,  desc: 'Cluster munitions that scatter on impact.',             loadout: 'Standard ∞ · Cluster ×3' },
  vanguard:   { id: 'vanguard',   name: 'Vanguard',   price: 650,  desc: 'Rolling charges that chase enemies into cover.',        loadout: 'Standard ∞ · Roller ×3' },
  juggernaut: { id: 'juggernaut', name: 'Juggernaut', price: 1200, special: true, desc: 'A bit of everything heavy.',            loadout: 'Big Bomb ×2 · Roller ×2 · Cluster ×2' },
  warlord:    { id: 'warlord',    name: 'Warlord',    price: 1900, special: true, desc: 'Elite arsenal of snipers and bombs.',   loadout: 'Sniper ×3 · Triple ×3 · Big Bomb ×2' },
};

export const SKINS = {
  default: { id: 'default', name: 'Standard',     price: 0,    swatch: '#9fb0c4' },
  desert:  { id: 'desert',  name: 'Desert Camo',  price: 200,  swatch: '#c9a45a' },
  forest:  { id: 'forest',  name: 'Forest Camo',  price: 200,  swatch: '#4e7a3a' },
  arctic:  { id: 'arctic',  name: 'Arctic',       price: 250,  swatch: '#dfe9f2' },
  carbon:  { id: 'carbon',  name: 'Carbon',       price: 450,  swatch: '#2b2f36' },
  gold:    { id: 'gold',    name: 'Gold Plated',  price: 1500, special: true, swatch: '#ffcf4a' },
};

// Free colour choices for tank customisation.
export const TANK_COLORS = [
  '#4ad9ff', '#ff7a4a', '#ffd24a', '#8aff6a', '#ff5ad2',
  '#b48aff', '#ff5a5a', '#5affc8', '#ffffff', '#5a7dff',
];

// Per-weapon projectile / explosion tints (renderer).
export const WEAPON_FX = {
  standard: { proj: 0xffb030, boom: 0xff8a2a },
  sniper:   { proj: 0x9fe8ff, boom: 0xbfefff },
  big_bomb: { proj: 0xff5a2a, boom: 0xff6a2a },
  triple:   { proj: 0xffd24a, boom: 0xffd24a },
  cluster:  { proj: 0xff5ad2, boom: 0xff7ad2 },
  roller:   { proj: 0x8aff6a, boom: 0x9aff7a },
};

export function defaultProfile() {
  return {
    name: 'Player',
    coins: 250,
    ownedKits: ['standard'],
    ownedSkins: ['default'],
    selectedKit: 'standard',
    selectedSkin: 'default',
    color: '#4ad9ff',
    stats: { wins: 0, losses: 0, kills: 0 },
  };
}

// Merge a stored profile onto the defaults so missing fields never crash the UI.
export function normalizeProfile(p) {
  const d = defaultProfile();
  if (!p || typeof p !== 'object') return d;
  const out = {
    name: typeof p.name === 'string' && p.name.trim() ? p.name.slice(0, 14) : d.name,
    coins: Number.isFinite(p.coins) ? Math.max(0, Math.floor(p.coins)) : d.coins,
    ownedKits: Array.isArray(p.ownedKits) ? p.ownedKits.filter((k) => KITS[k]) : d.ownedKits,
    ownedSkins: Array.isArray(p.ownedSkins) ? p.ownedSkins.filter((s) => SKINS[s]) : d.ownedSkins,
    selectedKit: KITS[p.selectedKit] ? p.selectedKit : d.selectedKit,
    selectedSkin: SKINS[p.selectedSkin] ? p.selectedSkin : d.selectedSkin,
    color: /^#[0-9a-fA-F]{6}$/.test(p.color) ? p.color : d.color,
    stats: {
      wins: p.stats && Number.isFinite(p.stats.wins) ? p.stats.wins : 0,
      losses: p.stats && Number.isFinite(p.stats.losses) ? p.stats.losses : 0,
      kills: p.stats && Number.isFinite(p.stats.kills) ? p.stats.kills : 0,
    },
  };
  if (!out.ownedKits.includes('standard')) out.ownedKits.unshift('standard');
  if (!out.ownedSkins.includes('default')) out.ownedSkins.unshift('default');
  if (!out.ownedKits.includes(out.selectedKit)) out.selectedKit = 'standard';
  if (!out.ownedSkins.includes(out.selectedSkin)) out.selectedSkin = 'default';
  return out;
}

const physics = require('./physics')
const WORLD_WIDTH = 1200;
const WORLD_HEIGHT = 800;

function generateTerrain() {
    const terrain = new Array(WORLD_WIDTH);
    const base = WORLD_HEIGHT * 0.65;
    const phase = Math.random() * Math.PI * 2;
    for (let x = 0; x < WORLD_WIDTH; x++) {
        const h = base + math.sin(x * 0.01 + phase) * 50 + Math.random() * 20;
        terrain[x] = Math.floor(h);
    }
    return terrain;
}

function randomWind(){
    return Math.round((Math.random() - 0.5) * 20);
}

class Game {
  constructor(playerIds) {
    this.terrain = generateTerrain();
    this.wind = randomWind();
    this.players = [...playerIds];

    const colors = ['#4ad9ff', '#ff7a4a'];
    const xs = [Math.round(WORLD_WIDTH * 0.18), Math.round(WORLD_WIDTH * 0.82)];
    this.tanks = playerIds.map((id, i) => ({
      id,
      x: xs[i],
      y: this.terrain[xs[i]],
      hp: 100,
      alive: true,
      color: colors[i],
    }));

    this.turnIndex = 0;
  }get activePlayerId() {
    return this.players[this.turnIndex];
  }
aliveTanks() {
    return this.tanks.filter((t) => t.alive);
  }

  state() {
    return {
      terrain: this.terrain,
      tanks: this.tanks,
      wind: this.wind,
      activePlayerId: this.activePlayerId,
      worldWidth: WORLD_WIDTH,
      worldHeight: WORLD_HEIGHT,
    };
  }
fire(shooterId, angle, power) {
    if (shooterId !== this.activePlayerId) {
      throw new Error('Not your turn.');
    }
    const shooter = this.tanks.find((t) => t.id === shooterId);
    if (!shooter || !shooter.alive) {
      throw new Error('Shooter is not in play.');
    }
    return physics.simulateShot(this, shooter, angle, power);
  }

  advanceTurn() {
    do {
      this.turnIndex = (this.turnIndex + 1) % this.players.length;
    } while (!this.tanks.find((t) => t.id === this.activePlayerId).alive);
    this.wind = randomWind();
  }
}

module.exports = {Game, WORLD_WIDTH, WORLD_HEIGHT};
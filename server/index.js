const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { Game, capacityFor, sanitizeProfile } = require('./game');
const bot = require('./bot');

const app = express();
app.get('/favicon.ico', (req, res) => res.status(204).end());
app.use(express.static(path.join(__dirname, '..', 'public')));

const server = http.createServer(app);
const io = new Server(server);

const rooms = new Map();
// Quick-match queues, one per mode. Entries: { id, profile }.
const queues = { '1v1': [], '2v2': [] };

function makeRoomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) {
      code += alphabet[Math.floor(Math.random() * alphabet.length)];
    }
  } while (rooms.has(code));
  return code;
}

function profileFor(socket) {
  return socket.data.profile || sanitizeProfile({});
}

function startGame(room, code) {
  const players = room.players.map((id) => ({ id, ...room.profiles.get(id) }));
  room.game = new Game(players, room.mode);
  for (const id of room.players) {
    io.to(id).emit('gameStart', { youId: id, code, ...room.game.state() });
  }
}

// --- bot match pacing ----------------------------------------------------
const BOT_MOVE_DELAY = 750;   // pause before a bot does anything
const BOT_FIRE_DELAY = 650;   // pause between a bot driving and firing
const BOT_AIM_ERROR = 4.5;    // degrees of aim slop so bots stay beatable

// Resolve a shot's aftermath, broadcast it to the room and return `next`.
// Shared by human fire events and bot turns so both resolve identically.
function resolveShot(code, room, shooterId, result) {
  const game = room.game;
  let damages = result.damages;
  let next;
  if (game.aliveTeams().size <= 1) {
    const teams = game.aliveTeams();
    const winnerTeam = teams.size === 1 ? [...teams][0] : null;
    next = { type: 'gameOver', winnerTeam, rewards: game.finalRewards(winnerTeam) };
  } else {
    // advanceTurn may apply lingering napalm damage and settle the terrain.
    const adv = game.advanceTurn();
    if (adv.hazardDamages && adv.hazardDamages.length) damages = damages.concat(adv.hazardDamages);
    const after = game.aliveTeams();
    if (after.size <= 1) {
      const winnerTeam = after.size === 1 ? [...after][0] : null;
      next = { type: 'gameOver', winnerTeam, rewards: game.finalRewards(winnerTeam) };
    } else {
      next = {
        type: 'turn',
        activePlayerId: game.activePlayerId,
        wind: game.wind,
        pickups: game.pickups,
        hazards: game.hazards,
        terrainReform: adv.terrainReform,
      };
    }
  }

  io.to(code).emit('shotResolved', {
    shooterId,
    weaponId: result.weaponId,
    projectiles: result.projectiles,
    heightmap: game.heightmap,
    tanks: game.tanks,
    props: game.props,
    hazards: game.hazards,
    damages,
    heals: result.heals,
    destroyedProps: result.destroyedProps,
    collected: result.collected,
    next,
  });

  if (next.type === 'gameOver') {
    clearBotTimer(room);
    rooms.delete(code);
  }
  return next;
}

function clearBotTimer(room) {
  if (room && room.botTimer) { clearTimeout(room.botTimer); room.botTimer = null; }
}

// Queue the active bot's turn if it's a bot's go (no-op when a human is up).
function scheduleBotTurn(code) {
  const room = rooms.get(code);
  if (!room || !room.game || !room.bots || room.botTimer) return;
  if (!room.bots.has(room.game.activePlayerId)) return;
  room.botTimer = setTimeout(() => { room.botTimer = null; runBotTurn(code); }, BOT_MOVE_DELAY);
}

// First half of a bot turn: maybe drive to a worthwhile crate, then aim.
function runBotTurn(code) {
  const room = rooms.get(code);
  if (!room || !room.game || !room.bots) return;
  const game = room.game;
  const botId = game.activePlayerId;
  if (!room.bots.has(botId)) return;
  const tank = game.tankOf(botId);
  if (!tank || !tank.alive) return;

  const moveX = bot.chooseMove(game, tank);
  if (moveX != null) {
    try {
      const mr = game.moveTo(botId, moveX);
      io.to(code).emit('tankMoved', {
        id: mr.id, x: mr.x, y: mr.y, fuel: mr.fuel, collected: mr.collected, pickups: mr.pickups,
      });
    } catch (_) { /* a blocked move just leaves the bot where it is */ }
  }

  room.botTimer = setTimeout(() => { room.botTimer = null; runBotShot(code); }, BOT_FIRE_DELAY);
}

// Second half: fire the planned shot and resolve it, then hand off the next turn.
function runBotShot(code) {
  const room = rooms.get(code);
  if (!room || !room.game || !room.bots) return;
  const game = room.game;
  const botId = game.activePlayerId;
  if (!room.bots.has(botId)) return;
  const tank = game.tankOf(botId);
  if (!tank || !tank.alive) return;

  let result;
  try {
    const plan = bot.planShot(game, tank, { aimError: BOT_AIM_ERROR });
    result = game.fire(botId, plan.angle, plan.power, plan.weapon);
  } catch (_) {
    // Failsafe: a plain shell so a turn never deadlocks the match.
    try { result = game.fire(botId, tank.team === 1 ? 130 : 50, 60, 'standard'); }
    catch (__) { return; }
  }
  const next = resolveShot(code, room, botId, result);
  if (next.type !== 'gameOver') scheduleBotTurn(code);
}

function leaveQueues(socketId) {
  for (const mode of Object.keys(queues)) {
    queues[mode] = queues[mode].filter((e) => e.id !== socketId);
  }
}

function emitQueueSize(mode) {
  const need = capacityFor(mode);
  for (const e of queues[mode]) {
    io.to(e.id).emit('queueUpdate', { count: queues[mode].length, capacity: need });
  }
}

io.on('connection', (socket) => {
  // The client sends its profile (name / kit / color / skin) on connect and
  // whenever it changes. Everything else reads from socket.data.profile.
  socket.on('setProfile', (p) => {
    socket.data.profile = sanitizeProfile(p);
  });

  socket.on('createRoom', ({ mode, profile }) => {
    if (profile) socket.data.profile = sanitizeProfile(profile);
    if (socket.data.room && rooms.has(socket.data.room)) {
      socket.emit('errorMsg', { message: 'You are already in a room.' });
      return;
    }
    if (mode !== '1v1' && mode !== '2v2') {
      socket.emit('errorMsg', { message: 'Invalid mode.' });
      return;
    }
    leaveQueues(socket.id);
    const code = makeRoomCode();
    const room = { mode, players: [socket.id], profiles: new Map(), game: null };
    room.profiles.set(socket.id, profileFor(socket));
    rooms.set(code, room);
    socket.data.room = code;
    socket.join(code);
    socket.emit('roomCreated', { code, mode, capacity: capacityFor(mode) });
  });

  socket.on('joinRoom', ({ code, profile }) => {
    if (profile) socket.data.profile = sanitizeProfile(profile);
    if (socket.data.room && rooms.has(socket.data.room)) {
      socket.emit('errorMsg', { message: 'You are already in a room.' });
      return;
    }
    const room = code && rooms.get(String(code).toUpperCase());
    if (!room) {
      socket.emit('errorMsg', { message: 'No room with that code.' });
      return;
    }
    if (room.game || room.players.length >= capacityFor(room.mode)) {
      socket.emit('errorMsg', { message: 'Room is full.' });
      return;
    }
    leaveQueues(socket.id);
    const realCode = String(code).toUpperCase();
    room.players.push(socket.id);
    room.profiles.set(socket.id, profileFor(socket));
    socket.data.room = realCode;
    socket.join(realCode);
    io.to(realCode).emit('lobbyUpdate', {
      count: room.players.length,
      capacity: capacityFor(room.mode),
    });
    if (room.players.length === capacityFor(room.mode)) {
      startGame(room, realCode);
    }
  });

  // --- quick match: auto-pair queued players -----------------------------
  socket.on('quickMatch', ({ mode, profile }) => {
    if (profile) socket.data.profile = sanitizeProfile(profile);
    if (socket.data.room && rooms.has(socket.data.room)) {
      socket.emit('errorMsg', { message: 'You are already in a room.' });
      return;
    }
    if (mode !== '1v1' && mode !== '2v2') mode = '1v1';
    leaveQueues(socket.id);
    queues[mode].push({ id: socket.id, profile: profileFor(socket) });

    const need = capacityFor(mode);
    if (queues[mode].length >= need) {
      const group = queues[mode].splice(0, need);
      const code = makeRoomCode();
      const room = { mode, players: [], profiles: new Map(), game: null };
      for (const e of group) {
        const sock = io.sockets.sockets.get(e.id);
        if (!sock) continue;
        room.players.push(e.id);
        room.profiles.set(e.id, e.profile);
        sock.data.room = code;
        sock.join(code);
      }
      // A queued player may have vanished between splice and start.
      if (room.players.length === need) {
        rooms.set(code, room);
        startGame(room, code);
      } else {
        for (const id of room.players) {
          const sock = io.sockets.sockets.get(id);
          if (sock) { sock.data.room = null; queues[mode].push({ id, profile: room.profiles.get(id) }); }
        }
      }
    }
    emitQueueSize(mode);
  });

  socket.on('cancelQuickMatch', () => {
    leaveQueues(socket.id);
    socket.emit('queueCancelled', {});
  });

  // --- practice vs bots: start instantly, AI fills the remaining slots -----
  socket.on('botMatch', ({ mode, profile }) => {
    if (profile) socket.data.profile = sanitizeProfile(profile);
    if (socket.data.room && rooms.has(socket.data.room)) {
      socket.emit('errorMsg', { message: 'You are already in a room.' });
      return;
    }
    if (mode !== '1v1' && mode !== '2v2') mode = '1v1';
    leaveQueues(socket.id);

    const code = makeRoomCode();
    const room = { mode, players: [socket.id], profiles: new Map(), game: null, bots: new Set(), botTimer: null };
    room.profiles.set(socket.id, profileFor(socket));

    const fills = capacityFor(mode) - 1; // every slot but the player's
    bot.makeBotProfiles(fills).forEach((bp, i) => {
      const id = `bot#${code}#${i}`;
      room.players.push(id);
      room.profiles.set(id, bp);
      room.bots.add(id);
    });

    rooms.set(code, room);
    socket.data.room = code;
    socket.join(code);
    startGame(room, code);
    scheduleBotTurn(code); // harmless when the human moves first (they do)
  });

  socket.on('moveTo', ({ x }) => {
    const code = socket.data.room;
    const room = code && rooms.get(code);
    if (!room || !room.game) return;
    let result;
    try {
      result = room.game.moveTo(socket.id, Number(x));
    } catch (err) {
      socket.emit('errorMsg', { message: err.message });
      return;
    }
    io.to(code).emit('tankMoved', {
      id: result.id,
      x: result.x,
      y: result.y,
      fuel: result.fuel,
      collected: result.collected,
      pickups: result.pickups,
    });
  });

  socket.on('fire', ({ angle, power, weapon }) => {
    const code = socket.data.room;
    const room = code && rooms.get(code);
    if (!room || !room.game) {
      socket.emit('errorMsg', { message: 'No active game.' });
      return;
    }
    let result;
    try {
      result = room.game.fire(socket.id, Number(angle), Number(power), weapon);
    } catch (err) {
      socket.emit('errorMsg', { message: err.message });
      return;
    }

    const next = resolveShot(code, room, socket.id, result);
    if (next.type !== 'gameOver') scheduleBotTurn(code);
  });

  socket.on('disconnect', () => {
    leaveQueues(socket.id);
    const code = socket.data.room;
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;

    if (!room.game) {
      // Still in the lobby: drop just this player, keep the room open for others.
      room.players = room.players.filter((id) => id !== socket.id);
      room.profiles.delete(socket.id);
      if (room.players.length === 0) {
        rooms.delete(code);
      } else {
        io.to(code).emit('lobbyUpdate', {
          count: room.players.length,
          capacity: capacityFor(room.mode),
        });
      }
      return;
    }

    // Mid-match: the remaining players can't continue, so end it.
    clearBotTimer(room);
    socket.to(code).emit('opponentLeft', { message: 'A player disconnected. Match ended.' });
    rooms.delete(code);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Tankzers running on http://localhost:${PORT}`);
});
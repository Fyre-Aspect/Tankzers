const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { Game, capacityFor, sanitizeProfile } = require('./game');

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

    const aliveTeams = room.game.aliveTeams();
    let next;
    if (aliveTeams.size <= 1) {
      const winnerTeam = aliveTeams.size === 1 ? [...aliveTeams][0] : null;
      next = { type: 'gameOver', winnerTeam, rewards: room.game.finalRewards(winnerTeam) };
    } else {
      room.game.advanceTurn();
      next = {
        type: 'turn',
        activePlayerId: room.game.activePlayerId,
        wind: room.game.wind,
        pickups: room.game.pickups,
      };
    }

    io.to(code).emit('shotResolved', {
      shooterId: socket.id,
      weaponId: result.weaponId,
      projectiles: result.projectiles,
      heightmap: room.game.heightmap,
      tanks: room.game.tanks,
      props: room.game.props,
      damages: result.damages,
      heals: result.heals,
      destroyedProps: result.destroyedProps,
      collected: result.collected,
      next,
    });

    if (next.type === 'gameOver') {
      rooms.delete(code);
    }
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
    socket.to(code).emit('opponentLeft', { message: 'A player disconnected. Match ended.' });
    rooms.delete(code);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Tankzers running on http://localhost:${PORT}`);
});
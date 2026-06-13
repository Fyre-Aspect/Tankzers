const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { Game, capacityFor } = require('./game');

const app = express();
app.get('/favicon.ico', (req, res) => res.status(204).end());
app.use(express.static(path.join(__dirname, '..', 'public')));

const server = http.createServer(app);
const io = new Server(server);

const rooms = new Map();

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

function startGame(room, code) {
  room.game = new Game(room.players, room.mode);
  for (const id of room.players) {
    io.to(id).emit('gameStart', { youId: id, code, ...room.game.state() });
  }
}

io.on('connection', (socket) => {
  socket.on('createRoom', ({ mode }) => {
    if (socket.data.room && rooms.has(socket.data.room)) {
      socket.emit('errorMsg', { message: 'You are already in a room.' });
      return;
    }
    if (mode !== '1v1' && mode !== '2v2') {
      socket.emit('errorMsg', { message: 'Invalid mode.' });
      return;
    }
    const code = makeRoomCode();
    rooms.set(code, { mode, players: [socket.id], game: null });
    socket.data.room = code;
    socket.join(code);
    socket.emit('roomCreated', { code, mode, capacity: capacityFor(mode) });
  });

  socket.on('joinRoom', ({ code }) => {
    if (socket.data.room && rooms.has(socket.data.room)) {
      socket.emit('errorMsg', { message: 'You are already in a room.' });
      return;
    }
    const room = rooms.get(code);
    if (!room) {
      socket.emit('errorMsg', { message: 'No room with that code.' });
      return;
    }
    if (room.game || room.players.length >= capacityFor(room.mode)) {
      socket.emit('errorMsg', { message: 'Room is full.' });
      return;
    }
    room.players.push(socket.id);
    socket.data.room = code;
    socket.join(code);
    io.to(code).emit('lobbyUpdate', {
      count: room.players.length,
      capacity: capacityFor(room.mode),
    });
    if (room.players.length === capacityFor(room.mode)) {
      startGame(room, code);
    }
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
      next = { type: 'gameOver', winnerTeam: aliveTeams.size === 1 ? [...aliveTeams][0] : null };
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
      damages: result.damages,
      collected: result.collected,
      next,
    });

    if (next.type === 'gameOver') {
      rooms.delete(code);
    }
  });

  socket.on('disconnect', () => {
    const code = socket.data.room;
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;

    if (!room.game) {
      // Still in the lobby: drop just this player, keep the room open for others.
      room.players = room.players.filter((id) => id !== socket.id);
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

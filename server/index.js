const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { Game } = require('./game');

const app = express();
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
  room.game = new Game(room.players);
  for (const id of room.players) {
    io.to(id).emit('gameStart', { youId: id, code, ...room.game.state() });
  }
}

io.on('connection', (socket) => {
  socket.on('createRoom', () => {
    const code = makeRoomCode();
    rooms.set(code, { players: [socket.id], game: null });
    socket.data.room = code;
    socket.join(code);
    socket.emit('roomCreated', { code });
  });

  socket.on('joinRoom', ({ code }) => {
    const room = rooms.get(code);
    if (!room) {
      socket.emit('errorMsg', { message: 'No room with that code.' });
      return;
    }
    if (room.players.length >= 2) {
      socket.emit('errorMsg', { message: 'Room is full.' });
      return;
    }
    room.players.push(socket.id);
    socket.data.room = code;
    socket.join(code);
    startGame(room, code);
  });

  socket.on('fire', ({ angle, power }) => {
    const code = socket.data.room;
    const room = code && rooms.get(code);
    if (!room || !room.game) {
      socket.emit('errorMsg', { message: 'No active game.' });
      return;
    }
    let result;
    try {
      result = room.game.fire(socket.id, Number(angle), Number(power));
    } catch (err) {
      socket.emit('errorMsg', { message: err.message });
      return;
    }

    const alive = room.game.aliveTanks();
    let next;
    if (alive.length <= 1) {
      next = { type: 'gameOver', winnerId: alive.length === 1 ? alive[0].id : null };
    } else {
      room.game.advanceTurn();
      next = { type: 'turn', activePlayerId: room.game.activePlayerId, wind: room.game.wind };
    }

    io.to(code).emit('shotResolved', {
      shooterId: socket.id,
      trajectory: result.trajectory,
      impact: result.impact,
      craterRadius: result.craterRadius,
      terrain: result.terrain,
      tanks: result.tanks,
      damages: result.damages,
      next,
    });
  });

  socket.on('disconnect', () => {
    const code = socket.data.room;
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;
    socket.to(code).emit('opponentLeft', { message: 'Opponent disconnected. Match ended.' });
    rooms.delete(code);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Tankzers running on http://localhost:${PORT}`);
});

const crypto = require('crypto');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { locations } = require('./gameData');

const app = express();

let CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:5173';
if (CLIENT_URL.endsWith('/')) CLIENT_URL = CLIENT_URL.slice(0, -1);

const corsOptions = {
  origin(origin, callback) {
    if (!origin) return callback(null, true);

    if (
      origin.endsWith('.vercel.app') ||
      origin.includes('localhost') ||
      origin.includes('127.0.0.1') ||
      origin.startsWith('http://192.168.') ||
      origin.startsWith('http://10.') ||
      (CLIENT_URL && origin === CLIENT_URL)
    ) {
      return callback(null, true);
    }

    console.log('Blocked by CORS:', origin);
    return callback(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST'],
  credentials: true,
};

app.use(cors(corsOptions));
app.get('/', (_req, res) => {
  res.json({ status: 'ok', game: 'spyfall', locations: locations.length });
});

const server = http.createServer(app);
const io = new Server(server, { cors: corsOptions });

const rooms = new Map();
const GAME_LENGTHS = new Set([3, 5, 8, 10]);
const MIN_PLAYERS = 3;
const MAX_PLAYERS = 12;
const RECONNECT_GRACE_MS = 2 * 60 * 1000;

function normalizeRoomId(roomId) {
  return String(roomId || '').trim().toUpperCase();
}

function normalizeName(name) {
  return String(name || '').trim().replace(/\s+/g, ' ').slice(0, 24);
}

function generateRoomId() {
  let roomId;
  do {
    roomId = Math.random().toString(36).slice(2, 8).toUpperCase();
  } while (rooms.has(roomId));
  return roomId;
}

function generateSessionToken() {
  return crypto.randomBytes(18).toString('hex');
}

function emitError(socket, message) {
  socket.emit('game_error', message);
}

function clearRoomTimer(room) {
  if (room.timer) {
    clearTimeout(room.timer);
    room.timer = null;
  }
}

function getPublicPlayerList(players) {
  return players.map((player) => ({
    id: player.id,
    name: player.name,
    isHost: player.isHost,
    connected: player.connected,
  }));
}

function getConnectedPlayers(room) {
  return room.players.filter((player) => player.connected);
}

function ensureHost(room) {
  const connectedHost = room.players.find((player) => player.isHost && player.connected);
  if (connectedHost) return connectedHost;

  const nextHost = room.players.find((player) => player.connected);
  if (!nextHost) return null;

  room.players.forEach((player) => {
    player.isHost = player === nextHost;
  });
  return nextHost;
}

function buildGameState(room, player) {
  if (room.status === 'waiting') return null;

  const isSpy = player.id === room.spyId;
  const isFinished = room.status === 'finished';
  const totalSeconds = room.gameLength * 60;
  const elapsedSeconds = room.startTime ? (Date.now() - room.startTime) / 1000 : 0;
  const remainingTime = room.status === 'playing'
    ? Math.max(0, Math.floor(totalSeconds - elapsedSeconds))
    : 0;

  return {
    status: room.status,
    location: isFinished || !isSpy ? room.location?.name : '???',
    role: player.role,
    isSpy,
    startTime: room.startTime,
    gameLength: totalSeconds,
    remainingTime,
    allLocations: locations.map((location) => location.name),
    result: room.result || null,
    hasVoted: Boolean(room.votes[player.id]),
  };
}

function emitRoomJoined(socket, room, player) {
  socket.emit('room_joined', {
    roomId: room.id,
    players: getPublicPlayerList(room.players),
    isHost: player.isHost,
    gameLength: room.gameLength,
    isPublic: room.isPublic,
    sessionToken: player.sessionToken,
    gameState: buildGameState(room, player),
  });
}

function finishGame(room, winner, reason) {
  if (room.status === 'finished') return;

  clearRoomTimer(room);
  room.status = 'finished';
  const spy = room.players.find((player) => player.id === room.spyId);
  room.result = {
    winner,
    reason,
    location: room.location?.name || '',
    spyName: spy?.name || 'Unknown',
  };
  io.to(room.id).emit('game_over', room.result);
}

function maybeResolveVoting(room) {
  if (room.status !== 'voting') return;

  const connectedPlayers = getConnectedPlayers(room);
  if (connectedPlayers.length === 0) return;

  const activeIds = new Set(connectedPlayers.map((player) => player.id));
  const validVotes = Object.entries(room.votes).filter(
    ([voterId, suspectId]) => activeIds.has(voterId) && activeIds.has(suspectId),
  );

  if (validVotes.length < connectedPlayers.length) return;

  const voteCounts = {};
  validVotes.forEach(([, suspectId]) => {
    voteCounts[suspectId] = (voteCounts[suspectId] || 0) + 1;
  });

  const maxVotes = Math.max(...Object.values(voteCounts));
  const leaders = Object.entries(voteCounts)
    .filter(([, count]) => count === maxVotes)
    .map(([id]) => id);

  if (leaders.length !== 1) {
    finishGame(room, 'spy', `ผลโหวตเสมอ Spy รอด! สถานที่คือ ${room.location.name}`);
    return;
  }

  if (leaders[0] === room.spyId) {
    room.status = 'guessing';
    io.to(room.id).emit('spy_guess_phase');
    return;
  }

  const suspect = room.players.find((player) => player.id === leaders[0]);
  finishGame(
    room,
    'spy',
    `โหวตผิดคน (${suspect?.name || 'Unknown'}) — Spy ชนะ! สถานที่คือ ${room.location.name}`,
  );
}

function removePlayer(room, player) {
  if (player.disconnectTimeout) {
    clearTimeout(player.disconnectTimeout);
    delete player.disconnectTimeout;
  }

  const index = room.players.indexOf(player);
  if (index !== -1) room.players.splice(index, 1);

  delete room.votes[player.id];
  for (const [voterId, suspectId] of Object.entries(room.votes)) {
    if (suspectId === player.id) delete room.votes[voterId];
  }

  ensureHost(room);
}

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('create_room', ({ playerName, isPublic } = {}) => {
    const name = normalizeName(playerName);
    if (!name) return emitError(socket, 'กรุณาใส่ชื่อ');

    const roomId = generateRoomId();
    const player = {
      id: socket.id,
      name,
      isHost: true,
      connected: true,
      sessionToken: generateSessionToken(),
    };

    const room = {
      id: roomId,
      players: [player],
      status: 'waiting',
      gameLength: 5,
      location: null,
      startTime: null,
      votes: {},
      spyId: null,
      timer: null,
      isPublic: typeof isPublic === 'boolean' ? isPublic : false,
      result: null,
    };

    rooms.set(roomId, room);
    socket.join(roomId);
    emitRoomJoined(socket, room, player);
    console.log(`Room ${roomId} created by ${name}`);
  });

  socket.on('join_room', ({ roomId, playerName, sessionToken } = {}) => {
    const normalizedRoomId = normalizeRoomId(roomId);
    const name = normalizeName(playerName);
    const room = rooms.get(normalizedRoomId);

    if (!name) return emitError(socket, 'กรุณาใส่ชื่อ');
    if (!room) return emitError(socket, 'ไม่พบห้องนี้');

    const existingPlayer = room.players.find(
      (player) => player.name.toLocaleLowerCase() === name.toLocaleLowerCase(),
    );

    if (existingPlayer) {
      const tokenMatches = Boolean(sessionToken) && sessionToken === existingPlayer.sessionToken;
      if (existingPlayer.connected && !tokenMatches) {
        return emitError(socket, 'ชื่อนี้มีคนใช้แล้วในห้องนี้');
      }
      if (sessionToken && !tokenMatches) {
        return emitError(socket, 'เซสชันเดิมไม่ถูกต้อง กรุณาใช้ชื่ออื่นหรือรอให้ผู้เล่นเดิมออกจากห้อง');
      }

      const oldId = existingPlayer.id;
      if (oldId !== socket.id) {
        const oldSocket = io.sockets.sockets.get(oldId);
        if (oldSocket) oldSocket.leave(normalizedRoomId);

        if (room.spyId === oldId) room.spyId = socket.id;

        if (room.votes[oldId]) {
          room.votes[socket.id] = room.votes[oldId];
          delete room.votes[oldId];
        }
        for (const [voterId, suspectId] of Object.entries(room.votes)) {
          if (suspectId === oldId) room.votes[voterId] = socket.id;
        }
      }

      existingPlayer.id = socket.id;
      existingPlayer.name = name;
      existingPlayer.connected = true;
      if (existingPlayer.disconnectTimeout) {
        clearTimeout(existingPlayer.disconnectTimeout);
        delete existingPlayer.disconnectTimeout;
      }

      ensureHost(room);
      socket.join(normalizedRoomId);
      emitRoomJoined(socket, room, existingPlayer);
      io.to(normalizedRoomId).emit('player_update', getPublicPlayerList(room.players));
      return;
    }

    if (room.status !== 'waiting') return emitError(socket, 'เกมเริ่มไปแล้ว');
    if (room.players.length >= MAX_PLAYERS) return emitError(socket, `ห้องเต็มแล้ว (สูงสุด ${MAX_PLAYERS} คน)`);

    const player = {
      id: socket.id,
      name,
      isHost: false,
      connected: true,
      sessionToken: generateSessionToken(),
    };

    room.players.push(player);
    ensureHost(room);
    socket.join(normalizedRoomId);

    io.to(normalizedRoomId).emit('player_update', getPublicPlayerList(room.players));
    emitRoomJoined(socket, room, player);
    console.log(`${name} joined room ${normalizedRoomId}`);
  });

  socket.on('update_game_settings', ({ roomId, gameLength, isPublic } = {}) => {
    const room = rooms.get(normalizeRoomId(roomId));
    if (!room || room.status !== 'waiting') return;

    const player = room.players.find((item) => item.id === socket.id);
    if (!player?.isHost) return emitError(socket, 'เฉพาะหัวหน้าห้องเท่านั้นที่แก้การตั้งค่าได้');

    if (gameLength !== undefined) {
      const normalizedLength = Number(gameLength);
      if (!GAME_LENGTHS.has(normalizedLength)) return emitError(socket, 'เวลาเล่นไม่ถูกต้อง');
      room.gameLength = normalizedLength;
    }
    if (typeof isPublic === 'boolean') room.isPublic = isPublic;

    io.to(room.id).emit('game_settings_updated', {
      gameLength: room.gameLength,
      isPublic: room.isPublic,
    });
  });

  socket.on('start_game', (roomId) => {
    const room = rooms.get(normalizeRoomId(roomId));
    if (!room) return emitError(socket, 'ไม่พบห้องนี้');
    if (room.status !== 'waiting') return emitError(socket, 'เกมกำลังดำเนินอยู่');

    const host = room.players.find((player) => player.id === socket.id);
    if (!host?.isHost) return emitError(socket, 'เฉพาะหัวหน้าห้องเท่านั้นที่เริ่มเกมได้');

    const connectedPlayers = getConnectedPlayers(room);
    if (connectedPlayers.length < MIN_PLAYERS) {
      return emitError(socket, `ต้องมีผู้เล่นอย่างน้อย ${MIN_PLAYERS} คน`);
    }

    room.players
      .filter((player) => !player.connected)
      .forEach((player) => {
        if (player.disconnectTimeout) clearTimeout(player.disconnectTimeout);
      });
    room.players = connectedPlayers;

    const location = locations[Math.floor(Math.random() * locations.length)];
    room.location = location;
    room.status = 'playing';
    room.startTime = Date.now();
    room.votes = {};
    room.result = null;

    const spyIndex = Math.floor(Math.random() * room.players.length);
    room.spyId = room.players[spyIndex].id;

    const roles = [...location.roles];
    for (let i = roles.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [roles[i], roles[j]] = [roles[j], roles[i]];
    }

    room.players.forEach((player, index) => {
      const isSpy = index === spyIndex;
      player.role = isSpy ? 'Spy' : roles[index % roles.length];

      io.to(player.id).emit('game_started', {
        location: isSpy ? '???' : location.name,
        role: player.role,
        isSpy,
        gameLength: room.gameLength * 60,
        allLocations: locations.map((item) => item.name),
        startTime: room.startTime,
      });
    });

    clearRoomTimer(room);
    room.timer = setTimeout(() => {
      if (room.status !== 'playing') return;
      room.status = 'voting';
      room.votes = {};
      io.to(room.id).emit('start_voting');
    }, room.gameLength * 60 * 1000);

    console.log(`Game started in room ${room.id} (${location.name})`);
  });

  socket.on('vote_player', ({ roomId, suspectId } = {}) => {
    const room = rooms.get(normalizeRoomId(roomId));
    if (!room || room.status !== 'voting') return emitError(socket, 'ยังไม่อยู่ในช่วงโหวต');

    const voter = room.players.find((player) => player.id === socket.id && player.connected);
    const suspect = room.players.find((player) => player.id === suspectId && player.connected);
    if (!voter || !suspect) return emitError(socket, 'ผู้เล่นที่เลือกไม่อยู่ในห้องแล้ว');
    if (voter.id === suspect.id) return emitError(socket, 'ไม่สามารถโหวตตัวเองได้');

    room.votes[voter.id] = suspect.id;
    socket.emit('vote_recorded');
    maybeResolveVoting(room);
  });

  socket.on('spy_guess_location', ({ roomId, locationName } = {}) => {
    const room = rooms.get(normalizeRoomId(roomId));
    if (!room || !room.location) return emitError(socket, 'ไม่พบเกมนี้');
    if (socket.id !== room.spyId) return emitError(socket, 'เฉพาะ Spy เท่านั้นที่ทายสถานที่ได้');
    if (!['playing', 'guessing'].includes(room.status)) return emitError(socket, 'ตอนนี้ยังทายสถานที่ไม่ได้');

    if (room.status === 'playing') {
      const remainingTime = room.gameLength * 60 * 1000 - (Date.now() - room.startTime);
      if (remainingTime > 61000) return emitError(socket, 'Spy ทายได้ในช่วง 1 นาทีสุดท้ายเท่านั้น');
    }

    const selectedLocation = locations.find((location) => location.name === locationName);
    if (!selectedLocation) return emitError(socket, 'สถานที่ที่เลือกไม่ถูกต้อง');

    if (selectedLocation.name === room.location.name) {
      finishGame(room, 'spy', `Spy ทายถูก! สถานที่คือ ${room.location.name}`);
    } else {
      finishGame(room, 'citizens', `Spy ทายผิด (${selectedLocation.name}) — สถานที่จริงคือ ${room.location.name}`);
    }
  });

  socket.on('reset_game', (roomId) => {
    const room = rooms.get(normalizeRoomId(roomId));
    if (!room) return;

    const player = room.players.find((item) => item.id === socket.id);
    if (!player?.isHost) return emitError(socket, 'เฉพาะหัวหน้าห้องเท่านั้นที่เริ่มรอบใหม่ได้');
    if (room.status !== 'finished') return emitError(socket, 'ยังไม่สามารถเริ่มรอบใหม่ได้');

    clearRoomTimer(room);
    room.status = 'waiting';
    room.location = null;
    room.startTime = null;
    room.votes = {};
    room.spyId = null;
    room.result = null;
    room.players.forEach((item) => delete item.role);

    io.to(room.id).emit('room_reset');
    io.to(room.id).emit('player_update', getPublicPlayerList(room.players));
  });

  socket.on('leave_room', (roomId) => {
    const normalizedRoomId = normalizeRoomId(roomId);
    const room = rooms.get(normalizedRoomId);
    if (!room) return;

    const player = room.players.find((item) => item.id === socket.id);
    if (!player) return;

    const wasSpy = room.spyId === player.id;
    socket.leave(normalizedRoomId);
    removePlayer(room, player);

    if (room.players.length === 0) {
      clearRoomTimer(room);
      rooms.delete(normalizedRoomId);
      return;
    }

    if (wasSpy && ['playing', 'voting', 'guessing'].includes(room.status)) {
      finishGame(room, 'citizens', `Spy ออกจากห้อง — ชาวบ้านชนะ! สถานที่คือ ${room.location.name}`);
      return;
    }

    io.to(normalizedRoomId).emit('player_update', getPublicPlayerList(room.players));
    maybeResolveVoting(room);
  });

  socket.on('get_public_rooms', () => {
    const publicRooms = [];
    rooms.forEach((room) => {
      if (!room.isPublic || room.status !== 'waiting') return;

      ensureHost(room);
      const connectedPlayers = getConnectedPlayers(room);
      if (connectedPlayers.length === 0) return;

      const host = connectedPlayers.find((player) => player.isHost);
      publicRooms.push({
        roomId: room.id,
        hostName: host?.name || 'Unknown',
        playerCount: connectedPlayers.length,
        status: room.status,
      });
    });

    socket.emit('public_rooms_list', publicRooms);
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);

    rooms.forEach((room, roomId) => {
      const player = room.players.find((item) => item.id === socket.id);
      if (!player) return;

      player.connected = false;
      ensureHost(room);
      io.to(roomId).emit('player_update', getPublicPlayerList(room.players));
      maybeResolveVoting(room);

      player.disconnectTimeout = setTimeout(() => {
        const currentPlayer = room.players.find((item) => item === player);
        if (!currentPlayer || currentPlayer.connected) return;

        const wasSpy = room.spyId === currentPlayer.id;
        removePlayer(room, currentPlayer);

        if (room.players.length === 0) {
          clearRoomTimer(room);
          rooms.delete(roomId);
          return;
        }

        if (wasSpy && room.status === 'guessing') {
          finishGame(room, 'citizens', `Spy ไม่กลับเข้าห้อง — ชาวบ้านชนะ! สถานที่คือ ${room.location.name}`);
          return;
        }

        io.to(roomId).emit('player_update', getPublicPlayerList(room.players));
        maybeResolveVoting(room);
      }, RECONNECT_GRACE_MS);
    });
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT} with ${locations.length} locations`);
});

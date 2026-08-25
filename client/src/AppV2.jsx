import { useEffect, useMemo, useRef, useState } from 'react';
import io from 'socket.io-client';
import { AnimatePresence, motion } from 'framer-motion';
import { Button } from './components/Button';
import { Input } from './components/Input';
import { Card } from './components/Card';
import { Timer } from './components/Timer';

const isLocalNetwork = window.location.hostname === 'localhost'
  || window.location.hostname === '127.0.0.1'
  || window.location.hostname.startsWith('192.168.')
  || window.location.hostname.startsWith('10.');

const API_URL = import.meta.env.VITE_API_URL || (isLocalNetwork
  ? `http://${window.location.hostname}:3001`
  : 'https://spyfall-server-xan1.onrender.com');

const socket = io(API_URL);

const STORAGE = {
  roomId: 'spyfall_roomId',
  playerName: 'spyfall_playerName',
  sessionToken: 'spyfall_sessionToken',
};

function AppV2() {
  const [view, setView] = useState('home');
  const [playerName, setPlayerName] = useState('');
  const [roomId, setRoomId] = useState('');
  const [sessionToken, setSessionToken] = useState('');
  const [players, setPlayers] = useState([]);
  const [isHost, setIsHost] = useState(false);
  const [isPublic, setIsPublic] = useState(false);
  const [publicRooms, setPublicRooms] = useState([]);
  const [gameLength, setGameLength] = useState(5);
  const [gameData, setGameData] = useState(null);
  const [remainingTime, setRemainingTime] = useState(null);
  const [winner, setWinner] = useState(null);
  const [winReason, setWinReason] = useState('');
  const [spyName, setSpyName] = useState('');
  const [hasVoted, setHasVoted] = useState(false);
  const [isSpyGuessing, setIsSpyGuessing] = useState(false);
  const [locationQuery, setLocationQuery] = useState('');
  const [error, setError] = useState('');
  const [isConnected, setIsConnected] = useState(socket.connected);

  const sessionRef = useRef({ playerName: '', roomId: '', sessionToken: '' });

  useEffect(() => {
    sessionRef.current = { playerName, roomId, sessionToken };
  }, [playerName, roomId, sessionToken]);

  useEffect(() => {
    const savedRoomId = localStorage.getItem(STORAGE.roomId) || '';
    const savedPlayerName = localStorage.getItem(STORAGE.playerName) || '';
    const savedSessionToken = localStorage.getItem(STORAGE.sessionToken) || '';

    if (savedRoomId && savedPlayerName) {
      setRoomId(savedRoomId);
      setPlayerName(savedPlayerName);
      setSessionToken(savedSessionToken);
      sessionRef.current = {
        roomId: savedRoomId,
        playerName: savedPlayerName,
        sessionToken: savedSessionToken,
      };

      if (socket.connected) {
        socket.emit('join_room', {
          roomId: savedRoomId,
          playerName: savedPlayerName,
          sessionToken: savedSessionToken,
        });
      }
    }
  }, []);

  useEffect(() => {
    if (roomId && playerName) {
      localStorage.setItem(STORAGE.roomId, roomId);
      localStorage.setItem(STORAGE.playerName, playerName);
      if (sessionToken) localStorage.setItem(STORAGE.sessionToken, sessionToken);
    }
  }, [roomId, playerName, sessionToken]);

  useEffect(() => {
    const onConnect = () => {
      setIsConnected(true);
      setError('');

      const saved = sessionRef.current;
      if (saved.roomId && saved.playerName) {
        socket.emit('join_room', {
          roomId: saved.roomId,
          playerName: saved.playerName,
          sessionToken: saved.sessionToken,
        });
      }
    };

    const onDisconnect = () => {
      setIsConnected(false);
      setError('การเชื่อมต่อหลุด กำลังเชื่อมต่อใหม่...');
    };

    const onRoomJoined = (data) => {
      setRoomId(data.roomId);
      setPlayers(data.players || []);
      setIsHost(Boolean(data.isHost));
      setGameLength(data.gameLength || 5);
      setIsPublic(Boolean(data.isPublic));
      setSessionToken(data.sessionToken || '');
      if (data.sessionToken) localStorage.setItem(STORAGE.sessionToken, data.sessionToken);

      setError('');
      setIsSpyGuessing(false);
      setLocationQuery('');

      if (!data.gameState) {
        setView('lobby');
        setGameData(null);
        setRemainingTime(null);
        setWinner(null);
        setWinReason('');
        setSpyName('');
        setHasVoted(false);
        return;
      }

      const state = data.gameState;
      const currentRemainingTime = state.remainingTime ?? state.gameLength ?? 0;
      setGameData({
        location: state.location,
        role: state.role,
        isSpy: state.isSpy,
        allLocations: state.allLocations || [],
        gameLength: currentRemainingTime,
      });
      setRemainingTime(currentRemainingTime);
      setHasVoted(Boolean(state.hasVoted));

      if (state.result) {
        setWinner(state.result.winner);
        setWinReason(state.result.reason);
        setSpyName(state.result.spyName || '');
      } else {
        setWinner(null);
        setWinReason('');
        setSpyName('');
      }

      setView(state.status === 'playing' ? 'game' : state.status);
    };

    const onPlayerUpdate = (updatedPlayers) => {
      setPlayers(updatedPlayers || []);
      const me = (updatedPlayers || []).find((player) => player.id === socket.id);
      if (me) setIsHost(Boolean(me.isHost));
    };

    const onSettingsUpdated = (data) => {
      if (data.gameLength) setGameLength(data.gameLength);
      if (typeof data.isPublic === 'boolean') setIsPublic(data.isPublic);
    };

    const onGameStarted = (data) => {
      setGameData(data);
      setRemainingTime(data.gameLength);
      setWinner(null);
      setWinReason('');
      setSpyName('');
      setHasVoted(false);
      setIsSpyGuessing(false);
      setLocationQuery('');
      setView('game');
    };

    const onStartVoting = () => {
      setHasVoted(false);
      setView('voting');
    };

    const onSpyGuessPhase = () => {
      setLocationQuery('');
      setView('guessing');
    };

    const onVoteRecorded = () => setHasVoted(true);

    const onGameOver = ({ winner: nextWinner, reason, location, spyName: nextSpyName }) => {
      setWinner(nextWinner);
      setWinReason(reason || '');
      setSpyName(nextSpyName || '');
      if (location) {
        setGameData((previous) => previous ? { ...previous, location } : previous);
      }
      setView('finished');
    };

    const onRoomReset = () => {
      setView('lobby');
      setGameData(null);
      setRemainingTime(null);
      setWinner(null);
      setWinReason('');
      setSpyName('');
      setHasVoted(false);
      setIsSpyGuessing(false);
      setLocationQuery('');
      setError('');
    };

    const onPublicRooms = (rooms) => setPublicRooms(rooms || []);
    const onGameError = (message) => setError(message);

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('connect_error', (err) => setError(`เชื่อมต่อเซิร์ฟเวอร์ไม่ได้: ${err.message}`));
    socket.on('room_joined', onRoomJoined);
    socket.on('player_update', onPlayerUpdate);
    socket.on('game_settings_updated', onSettingsUpdated);
    socket.on('game_started', onGameStarted);
    socket.on('start_voting', onStartVoting);
    socket.on('spy_guess_phase', onSpyGuessPhase);
    socket.on('vote_recorded', onVoteRecorded);
    socket.on('game_over', onGameOver);
    socket.on('room_reset', onRoomReset);
    socket.on('public_rooms_list', onPublicRooms);
    socket.on('game_error', onGameError);

    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('connect_error');
      socket.off('room_joined', onRoomJoined);
      socket.off('player_update', onPlayerUpdate);
      socket.off('game_settings_updated', onSettingsUpdated);
      socket.off('game_started', onGameStarted);
      socket.off('start_voting', onStartVoting);
      socket.off('spy_guess_phase', onSpyGuessPhase);
      socket.off('vote_recorded', onVoteRecorded);
      socket.off('game_over', onGameOver);
      socket.off('room_reset', onRoomReset);
      socket.off('public_rooms_list', onPublicRooms);
      socket.off('game_error', onGameError);
    };
  }, []);

  const filteredLocations = useMemo(() => {
    const allLocations = gameData?.allLocations || [];
    const query = locationQuery.trim().toLocaleLowerCase();
    if (!query) return allLocations;
    return allLocations.filter((location) => location.toLocaleLowerCase().includes(query));
  }, [gameData?.allLocations, locationQuery]);

  const connectedPlayers = players.filter((player) => player.connected);
  const currentPlayer = players.find((player) => player.id === socket.id);

  const clearStoredSession = () => {
    localStorage.removeItem(STORAGE.roomId);
    localStorage.removeItem(STORAGE.playerName);
    localStorage.removeItem(STORAGE.sessionToken);
  };

  const createRoom = (publicRoom) => {
    const name = playerName.trim();
    if (!name) return setError('กรุณาใส่ชื่อ');
    setError('');
    socket.emit('create_room', { playerName: name, isPublic: publicRoom });
  };

  const joinRoom = (targetRoomId = roomId) => {
    const name = playerName.trim();
    const target = String(targetRoomId || '').trim().toUpperCase();
    if (!name || !target) return setError('กรุณาใส่ชื่อและรหัสห้อง');

    setError('');
    socket.emit('join_room', {
      roomId: target,
      playerName: name,
      sessionToken: sessionRef.current.roomId === target ? sessionToken : '',
    });
  };

  const fetchPublicRooms = () => {
    setError('');
    socket.emit('get_public_rooms');
    setView('server_list');
  };

  const leaveGame = () => {
    if (roomId) socket.emit('leave_room', roomId);
    clearStoredSession();
    sessionRef.current = { roomId: '', playerName: '', sessionToken: '' };
    setRoomId('');
    setSessionToken('');
    setPlayers([]);
    setIsHost(false);
    setGameData(null);
    setRemainingTime(null);
    setWinner(null);
    setWinReason('');
    setSpyName('');
    setHasVoted(false);
    setError('');
    setView('home');
  };

  const startGame = () => {
    setError('');
    socket.emit('start_game', roomId);
  };

  const updateGameLength = (length) => {
    if (!isHost) return;
    socket.emit('update_game_settings', { roomId, gameLength: length });
  };

  const togglePrivacy = (publicStatus) => {
    if (!isHost) return;
    socket.emit('update_game_settings', { roomId, isPublic: publicStatus });
  };

  const votePlayer = (suspectId) => {
    if (hasVoted) return;
    setError('');
    socket.emit('vote_player', { roomId, suspectId });
  };

  const guessLocation = (locationName) => {
    setError('');
    socket.emit('spy_guess_location', { roomId, locationName });
  };

  const resetGame = () => {
    setError('');
    socket.emit('reset_game', roomId);
  };

  return (
    <div className="min-h-screen bg-slate-900 text-slate-50 flex items-center justify-center p-4">
      <div className="max-w-lg w-full">
        <AnimatePresence mode="wait">
          {view === 'home' && (
            <motion.div
              key="home"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="space-y-6"
            >
              <div className="text-center mb-8">
                <h1 className="text-5xl font-black text-transparent bg-clip-text bg-gradient-to-r from-rose-500 to-orange-500 mb-2">SPYFALL</h1>
                <p className="text-slate-400">จับผิดสายลับ หรือเนียนให้รอด</p>
                <p className="text-xs text-slate-600 mt-2">v2.0 • 88 สถานที่ • Reconnect & Host Transfer</p>
                {!isConnected && (
                  <div className="text-xs text-rose-500 animate-pulse mt-2">กำลังเชื่อมต่อเซิร์ฟเวอร์...</div>
                )}
              </div>

              <Card className="space-y-4">
                <Input
                  placeholder="ชื่อของคุณ"
                  value={playerName}
                  onChange={(event) => setPlayerName(event.target.value)}
                />

                <div className="grid grid-cols-2 gap-2">
                  <Button onClick={() => createRoom(false)} className="w-full">สร้างส่วนตัว</Button>
                  <Button onClick={() => createRoom(true)} variant="secondary" className="w-full">สร้างสาธารณะ</Button>
                </div>

                <div className="relative my-4">
                  <div className="absolute inset-0 flex items-center"><div className="w-full border-t border-slate-700" /></div>
                  <div className="relative flex justify-center text-sm"><span className="px-2 bg-slate-800 text-slate-500">หรือเข้าร่วม</span></div>
                </div>

                <div className="flex gap-2">
                  <Input
                    placeholder="รหัสห้อง"
                    value={roomId}
                    onChange={(event) => setRoomId(event.target.value.toUpperCase())}
                    className="text-center tracking-widest uppercase font-mono"
                  />
                  <Button onClick={() => joinRoom()} variant="secondary">เข้าร่วม</Button>
                </div>

                <Button onClick={fetchPublicRooms} variant="outline" className="w-full">🔍 ค้นหาห้องสาธารณะ</Button>
                {error && <p className="text-rose-500 text-center text-sm">{error}</p>}
              </Card>
            </motion.div>
          )}

          {view === 'server_list' && (
            <motion.div key="server-list" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} className="space-y-6">
              <div className="text-center">
                <h2 className="text-3xl font-bold">ห้องสาธารณะ</h2>
                <p className="text-slate-400">เลือกห้องที่ยังไม่เริ่มเกม</p>
              </div>

              <Card className="space-y-4">
                <Input placeholder="ชื่อของคุณ" value={playerName} onChange={(event) => setPlayerName(event.target.value)} />

                <div className="flex gap-2">
                  <Button onClick={() => socket.emit('get_public_rooms')} variant="secondary" className="w-full">↻ รีเฟรช</Button>
                </div>

                <div className="max-h-[50vh] overflow-y-auto space-y-3 pr-1">
                  {publicRooms.length === 0 ? (
                    <div className="text-center py-8 text-slate-500">ยังไม่มีห้องสาธารณะ</div>
                  ) : publicRooms.map((room) => (
                    <div key={room.roomId} className="bg-slate-800 p-4 rounded-lg border border-slate-700 flex justify-between items-center gap-4">
                      <div>
                        <div className="font-bold text-lg text-rose-500 tracking-widest">{room.roomId}</div>
                        <div className="text-sm text-slate-400">Host: {room.hostName}</div>
                        <div className="text-xs text-slate-500">{room.playerCount}/12 คน</div>
                      </div>
                      <Button onClick={() => joinRoom(room.roomId)} className="py-2 px-4">เข้าร่วม</Button>
                    </div>
                  ))}
                </div>

                {error && <p className="text-rose-500 text-center text-sm">{error}</p>}
              </Card>

              <Button onClick={() => setView('home')} variant="secondary" className="w-full">กลับหน้าหลัก</Button>
            </motion.div>
          )}

          {view === 'lobby' && (
            <motion.div key="lobby" initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 1.04 }} className="space-y-6">
              <div className="text-center">
                <p className="text-slate-400 mb-2">รหัสห้อง</p>
                <div className="text-4xl font-mono font-bold text-rose-500 tracking-widest bg-slate-800/50 py-2 rounded-xl border border-slate-700/50">{roomId}</div>
              </div>

              <Card>
                <h3 className="text-xl font-bold mb-4 flex items-center justify-between">
                  <span>ผู้เล่น ({connectedPlayers.length}/{players.length})</span>
                  {isHost && <span className="text-xs bg-rose-500/20 text-rose-400 px-2 py-1 rounded">คุณเป็น Host</span>}
                </h3>
                <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
                  {players.map((player) => (
                    <div key={player.id} className={`flex items-center gap-3 p-3 rounded-lg border ${player.connected ? 'bg-slate-700/30 border-slate-700/50' : 'bg-slate-800/30 border-slate-800/50 opacity-50'}`}>
                      <div className="w-8 h-8 rounded-full bg-gradient-to-br from-rose-500 to-orange-500 flex items-center justify-center font-bold text-sm">{player.name?.[0]?.toUpperCase() || '?'}</div>
                      <span className="font-medium">{player.name}</span>
                      {player.id === socket.id && <span className="text-xs text-slate-500">(คุณ)</span>}
                      {!player.connected && <span className="text-xs text-rose-500">หลุด</span>}
                      {player.isHost && <span className="ml-auto text-xs text-amber-400">Host</span>}
                    </div>
                  ))}
                </div>
              </Card>

              <Card>
                <h3 className="text-sm font-bold text-slate-400 mb-3 uppercase tracking-wider">ตั้งค่าห้อง</h3>
                <div className="mb-4">
                  <div className="text-xs text-slate-500 mb-2">สถานะห้อง</div>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => togglePrivacy(false)}
                      disabled={!isHost}
                      className={`py-2 rounded-lg border text-sm font-bold ${!isPublic ? 'bg-rose-500/20 border-rose-500 text-rose-400' : 'bg-slate-800 border-slate-700 text-slate-500'} disabled:opacity-50`}
                    >🔒 Private</button>
                    <button
                      type="button"
                      onClick={() => togglePrivacy(true)}
                      disabled={!isHost}
                      className={`py-2 rounded-lg border text-sm font-bold ${isPublic ? 'bg-emerald-500/20 border-emerald-500 text-emerald-400' : 'bg-slate-800 border-slate-700 text-slate-500'} disabled:opacity-50`}
                    >🌍 Public</button>
                  </div>
                </div>

                <div className="text-xs text-slate-500 mb-2">เวลาเล่น (นาที)</div>
                <div className="flex gap-2 justify-center">
                  {[3, 5, 8, 10].map((time) => (
                    <button
                      key={time}
                      type="button"
                      onClick={() => updateGameLength(time)}
                      disabled={!isHost}
                      className={`w-12 h-12 rounded-lg font-bold transition-all ${gameLength === time ? 'bg-rose-500 text-white scale-105' : 'bg-slate-800 text-slate-400'} disabled:opacity-50`}
                    >{time}</button>
                  ))}
                </div>
              </Card>

              {error && <p className="text-rose-500 text-center text-sm">{error}</p>}

              {isHost ? (
                <>
                  <Button onClick={startGame} disabled={connectedPlayers.length < 3} className="w-full py-4 text-lg">เริ่มเกม</Button>
                  {connectedPlayers.length < 3 && <p className="text-xs text-slate-500 text-center">ต้องมีผู้เล่นอย่างน้อย 3 คน</p>}
                </>
              ) : (
                <div className="text-center text-slate-400 animate-pulse">รอ Host เริ่มเกม...</div>
              )}

              <Button onClick={leaveGame} variant="outline" className="w-full">ออกจากห้อง</Button>
            </motion.div>
          )}

          {view === 'game' && gameData && (
            <motion.div key="game" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-6">
              <div className="text-center">
                <Timer initialTime={gameData.gameLength} onTick={setRemainingTime} />
              </div>

              {!isSpyGuessing ? (
                <>
                  <Card className="text-center py-8 relative overflow-hidden">
                    <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-rose-500 via-orange-500 to-rose-500" />
                    <h2 className="text-slate-400 text-sm uppercase tracking-wider mb-2">บทบาทของคุณ</h2>
                    <div className="text-3xl font-bold mb-6">{gameData.role}</div>
                    <div className="w-full h-px bg-slate-700/50 my-6" />
                    <h2 className="text-slate-400 text-sm uppercase tracking-wider mb-2">สถานที่</h2>
                    <div className={`text-4xl font-black ${gameData.isSpy ? 'text-rose-500' : 'text-emerald-400'}`}>{gameData.location}</div>

                    {gameData.isSpy && (
                      <div className="mt-6">
                        <p className="text-sm text-slate-400 mb-4">เนียนให้รอด แล้วทายสถานที่ใน 1 นาทีสุดท้าย</p>
                        <Button
                          onClick={() => setIsSpyGuessing(true)}
                          disabled={(remainingTime ?? gameData.gameLength) > 60}
                          className="w-full"
                        >
                          {(remainingTime ?? gameData.gameLength) > 60
                            ? `ทายได้ในอีก ${Math.floor(((remainingTime ?? gameData.gameLength) - 60) / 60)}:${String(((remainingTime ?? gameData.gameLength) - 60) % 60).padStart(2, '0')}`
                            : '🕵️ ทายสถานที่'}
                        </Button>
                      </div>
                    )}
                  </Card>

                  <Card>
                    <div className="flex items-center justify-between mb-3">
                      <h3 className="text-sm font-bold text-slate-400 uppercase tracking-wider">สถานที่ทั้งหมด</h3>
                      <span className="text-xs text-slate-600">{gameData.allLocations?.length || 0} แห่ง</span>
                    </div>
                    <div className="grid grid-cols-2 gap-2 text-sm max-h-64 overflow-y-auto pr-1">
                      {(gameData.allLocations || []).map((location) => (
                        <div key={location} className={`p-2 rounded border ${gameData.location === location && !gameData.isSpy ? 'bg-emerald-500/10 border-emerald-500/50 text-emerald-400' : 'bg-slate-800 border-slate-700 text-slate-300'}`}>{location}</div>
                      ))}
                    </div>
                  </Card>
                </>
              ) : (
                <LocationPicker
                  query={locationQuery}
                  setQuery={setLocationQuery}
                  locations={filteredLocations}
                  total={gameData.allLocations?.length || 0}
                  onPick={guessLocation}
                  onCancel={() => { setIsSpyGuessing(false); setLocationQuery(''); }}
                />
              )}

              {error && <p className="text-rose-500 text-center text-sm">{error}</p>}
              <Button onClick={leaveGame} variant="outline" className="w-full">ออกจากเกม</Button>
            </motion.div>
          )}

          {view === 'voting' && (
            <motion.div key="voting" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-6">
              <div className="text-center">
                <h2 className="text-3xl font-bold text-rose-500 mb-2">หมดเวลา!</h2>
                <p className="text-slate-400">โหวตหาคนที่เป็น Spy</p>
              </div>

              <Card>
                {!hasVoted ? (
                  <div className="space-y-2">
                    {players.map((player) => {
                      const isSelf = player.id === socket.id;
                      return (
                        <button
                          key={player.id}
                          type="button"
                          onClick={() => votePlayer(player.id)}
                          disabled={!player.connected || isSelf}
                          className={`w-full flex items-center gap-3 p-4 rounded-lg border transition-all ${player.connected && !isSelf ? 'bg-slate-700/30 hover:bg-rose-500/20 hover:border-rose-500 border-slate-700/50' : 'bg-slate-800/30 border-slate-800/50 opacity-50 cursor-not-allowed'}`}
                        >
                          <div className="w-10 h-10 rounded-full bg-slate-600 flex items-center justify-center font-bold">{player.name?.[0]?.toUpperCase() || '?'}</div>
                          <span className="font-medium text-lg">{player.name}</span>
                          {isSelf && <span className="text-xs text-slate-500">(คุณ)</span>}
                          {!player.connected && <span className="text-xs text-rose-500">(หลุด)</span>}
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <div className="text-center py-8">
                    <div className="text-4xl mb-4">🗳️</div>
                    <h3 className="text-xl font-bold mb-2">โหวตเรียบร้อย</h3>
                    <p className="text-slate-400 animate-pulse">รอผลโหวตจากคนอื่น...</p>
                  </div>
                )}
              </Card>

              {error && <p className="text-rose-500 text-center text-sm">{error}</p>}
            </motion.div>
          )}

          {view === 'guessing' && gameData && (
            <motion.div key="guessing" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-6">
              <div className="text-center">
                <h2 className="text-3xl font-bold text-orange-500 mb-2">Spy ถูกจับได้!</h2>
                <p className="text-slate-400">Spy มีโอกาสทายสถานที่ครั้งสุดท้าย</p>
              </div>

              {gameData.isSpy ? (
                <LocationPicker
                  query={locationQuery}
                  setQuery={setLocationQuery}
                  locations={filteredLocations}
                  total={gameData.allLocations?.length || 0}
                  onPick={guessLocation}
                />
              ) : (
                <Card className="text-center py-12">
                  <div className="text-4xl mb-4">🕵️</div>
                  <p className="text-slate-400 animate-pulse">รอ Spy ทายสถานที่...</p>
                </Card>
              )}

              {error && <p className="text-rose-500 text-center text-sm">{error}</p>}
            </motion.div>
          )}

          {view === 'finished' && (
            <motion.div key="finished" initial={{ opacity: 0, scale: 0.94 }} animate={{ opacity: 1, scale: 1 }} className="space-y-6 text-center">
              <div className="py-6">
                <div className="text-6xl mb-4">{winner === 'spy' ? '🕵️' : '👥'}</div>
                <h1 className={`text-4xl font-black mb-2 ${winner === 'spy' ? 'text-rose-500' : 'text-emerald-500'}`}>
                  {winner === 'spy' ? 'SPY ชนะ!' : 'ชาวบ้านชนะ!'}
                </h1>
                <p className="text-lg text-slate-300">{winReason}</p>
              </div>

              <Card className="bg-slate-800/50">
                <p className="text-slate-400 mb-1">สถานที่จริง</p>
                <p className="text-2xl font-bold text-white">{gameData?.location || '-'}</p>
                {spyName && <p className="text-sm text-slate-400 mt-3">Spy คือ <span className="font-bold text-rose-400">{spyName}</span></p>}
              </Card>

              {isHost ? (
                <Button onClick={resetGame} className="w-full py-4 text-lg bg-emerald-500 hover:bg-emerald-600">เล่นอีกครั้ง</Button>
              ) : (
                <div className="text-slate-400 animate-pulse">รอ Host เริ่มรอบใหม่...</div>
              )}

              {error && <p className="text-rose-500 text-center text-sm">{error}</p>}
              <Button onClick={leaveGame} variant="outline" className="w-full">ออกจากห้อง</Button>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

function LocationPicker({ query, setQuery, locations, total, onPick, onCancel }) {
  return (
    <Card>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-xl font-bold text-rose-500">เลือกสถานที่</h3>
        <span className="text-xs text-slate-500">{locations.length}/{total}</span>
      </div>
      <Input placeholder="ค้นหาสถานที่..." value={query} onChange={(event) => setQuery(event.target.value)} />
      <div className="grid grid-cols-2 gap-2 mt-4 max-h-[50vh] overflow-y-auto pr-1">
        {locations.map((location) => (
          <button
            key={location}
            type="button"
            onClick={() => onPick(location)}
            className="p-3 rounded bg-slate-800 hover:bg-rose-500/20 hover:border-rose-500 border border-slate-700 transition-colors text-left"
          >{location}</button>
        ))}
      </div>
      {locations.length === 0 && <p className="text-center text-slate-500 py-6">ไม่พบสถานที่</p>}
      {onCancel && <Button onClick={onCancel} variant="secondary" className="w-full mt-4">ยกเลิก</Button>}
    </Card>
  );
}

export default AppV2;

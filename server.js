// 騳团大乱斗 - 联机服务器
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.static('.'));

app.get('/', (req, res) => {
  res.sendFile(__dirname + '/fight-game.html');
});

let gameState = {
  players: {},
  projectiles: [],
  rankings: [],
  items: []
};

const COLORS = ['#e94560', '#4ecca3', '#f9d342', '#6c63ff', '#ff6b6b', '#48dbfb', '#ff9ff3', '#feca57', '#1dd1a1', '#5f27cd', '#ff6348', '#2ed573'];
const GRID_SIZE = 10;
const AUTO_ATTACK_INTERVAL = 3000;
const INVINCIBLE_TIME = 10000;
const ITEM_SPAWN_INTERVAL = 10000;

const ITEM_TYPES = {
  POWER_ATTACK: { id: 'power_attack', name: '强力攻击', emoji: '💪', type: 'buff', duration: 18000 },
  FAST_ATTACK: { id: 'fast_attack', name: '极速攻击', emoji: '⚡', type: 'buff', duration: 10000 },
  SHIELD: { id: 'shield', name: '无敌护盾', emoji: '🛡️', type: 'buff', duration: 10000 },
  DISABLE_ATTACK: { id: 'disable_attack', name: '攻击禁锢', emoji: '🔒', type: 'debuff', duration: 20000 },
  DAMAGE: { id: 'damage', name: '伤害陷阱', emoji: '💀', type: 'debuff', duration: 0 },
  REVERSE: { id: 'reverse', name: '方向颠倒', emoji: '🔄', type: 'debuff', duration: 5000 }
};

let colorIndex = 0;

function getRandomSpawn(allPlayers) {
  const occupied = new Set();
  Object.values(allPlayers).forEach(p => {
    occupied.add(`${p.x},${p.y}`);
  });
  gameState.items.forEach(item => {
    occupied.add(`${item.x},${item.y}`);
  });
  for (let i = 0; i < 100; i++) {
    const x = Math.floor(Math.random() * GRID_SIZE);
    const y = Math.floor(Math.random() * GRID_SIZE);
    if (!occupied.has(`${x},${y}`)) {
      return { x, y };
    }
  }
  return {
    x: Math.floor(Math.random() * GRID_SIZE),
    y: Math.floor(Math.random() * GRID_SIZE)
  };
}

function allocColor() {
  const c = COLORS[colorIndex % COLORS.length];
  colorIndex++;
  return c;
}

function spawnRandomItem() {
  const itemTypes = Object.values(ITEM_TYPES);
  const randomType = itemTypes[Math.floor(Math.random() * itemTypes.length)];
  const pos = getRandomSpawn(gameState.players);
  
  const item = {
    id: Date.now() + Math.random(),
    x: pos.x,
    y: pos.y,
    ...randomType,
    spawnTime: Date.now()
  };
  
  gameState.items.push(item);
  io.emit('itemSpawned', { item });
  console.log(`道具刷新: ${item.name} 在 (${item.x}, ${item.y})`);
}

function applyItemEffect(player, item) {
  const now = Date.now();
  
  switch(item.id) {
    case 'power_attack':
      player.powerAttackUntil = now + item.duration;
      break;
    case 'fast_attack':
      player.fastAttackUntil = now + item.duration;
      break;
    case 'shield':
      player.invincibleUntil = now + item.duration;
      break;
    case 'disable_attack':
      player.disableAttackUntil = now + item.duration;
      break;
    case 'damage':
      player.hp = Math.max(0, player.hp - 1);
      io.emit('playerHit', { playerId: player.id, hp: player.hp, attackerId: null });
      if (player.hp <= 0) {
        player.deaths++;
        const spawn = getRandomSpawn(gameState.players);
        player.x = spawn.x;
        player.y = spawn.y;
        player.hp = 3;
        player.invincibleUntil = now + INVINCIBLE_TIME;
        io.emit('playerRespawned', {
          playerId: player.id,
          x: player.x,
          y: player.y,
          hp: player.hp,
          invincibleUntil: player.invincibleUntil
        });
        updateRankings();
      }
      break;
    case 'reverse':
      player.reverseUntil = now + item.duration;
      break;
  }
  
  io.emit('itemCollected', { playerId: player.id, itemId: item.id, item: item });
  io.emit('playerEffectUpdate', {
    playerId: player.id,
    effects: {
      powerAttackUntil: player.powerAttackUntil,
      fastAttackUntil: player.fastAttackUntil,
      invincibleUntil: player.invincibleUntil,
      disableAttackUntil: player.disableAttackUntil,
      reverseUntil: player.reverseUntil
    }
  });
}

io.on('connection', (socket) => {
  console.log('玩家连接:', socket.id);

  socket.on('join', (data) => {
    const { name, weaponEmoji } = data;
    const spawn = getRandomSpawn(gameState.players);

    const player = {
      id: socket.id,
      name: name,
      x: spawn.x,
      y: spawn.y,
      color: allocColor(),
      weaponEmoji: weaponEmoji || '🔪',
      hp: 3,
      ready: true,
      invincibleUntil: Date.now() + INVINCIBLE_TIME,
      kills: 0,
      deaths: 0,
      lastAttack: 0,
      powerAttackUntil: 0,
      fastAttackUntil: 0,
      disableAttackUntil: 0,
      reverseUntil: 0
    };

    gameState.players[socket.id] = player;
    socket.emit('joined', {
      playerId: socket.id,
      player: player,
      allPlayers: gameState.players,
      items: gameState.items
    });

    io.emit('playerJoined', { player });
    updateRankings();

    console.log(`${name} 加入了游戏，当前玩家: ${Object.keys(gameState.players).length}`);
  });

  socket.on('move', (data) => {
    const player = gameState.players[socket.id];
    if (!player || player.hp <= 0) return;

    let { dx, dy } = data;
    
    if (Date.now() < player.reverseUntil) {
      dx = -dx;
      dy = -dy;
    }

    const nx = player.x + dx;
    const ny = player.y + dy;

    if (nx < 0 || nx >= GRID_SIZE || ny < 0 || ny >= GRID_SIZE) return;

    const occupied = Object.values(gameState.players)
      .find(p => p.id !== socket.id && p.hp > 0 && p.x === nx && p.y === ny);
    if (occupied) return;

    player.x = nx;
    player.y = ny;
    io.emit('playerMoved', { id: socket.id, x: nx, y: ny });

    const itemIndex = gameState.items.findIndex(item => item.x === nx && item.y === ny);
    if (itemIndex !== -1) {
      const item = gameState.items[itemIndex];
      applyItemEffect(player, item);
      gameState.items.splice(itemIndex, 1);
    }
  });

  socket.on('attack', () => {
    doAutoAttack(socket.id);
  });

  socket.on('disconnect', () => {
    const player = gameState.players[socket.id];
    if (player) {
      delete gameState.players[socket.id];
      io.emit('playerLeft', { id: socket.id });
      updateRankings();
      console.log(`玩家离开: ${player.name}`);
    }
  });
});

function doAutoAttack(playerId) {
  const player = gameState.players[playerId];
  if (!player || player.hp <= 0) return;
  if (Date.now() < player.invincibleUntil) return;
  if (Date.now() < player.disableAttackUntil) return;

  player.lastAttack = Date.now();

  const dirs = [{x:1,y:0}, {x:-1,y:0}, {x:0,y:1}, {x:0,y:-1}];
  const isPowerAttack = Date.now() < player.powerAttackUntil;
  
  dirs.forEach(dir => {
    gameState.projectiles.push({
      id: Date.now() + Math.random(),
      x: player.x,
      y: player.y,
      dx: dir.x,
      dy: dir.y,
      color: player.color,
      owner: playerId,
      isPowerAttack: isPowerAttack,
      weaponEmoji: player.weaponEmoji
    });
  });

  io.emit('attack', { playerId: playerId, projectiles: gameState.projectiles });
}

setInterval(() => {
  Object.keys(gameState.players).forEach(pid => {
    const player = gameState.players[pid];
    const attackInterval = Date.now() < player.fastAttackUntil ? 500 : AUTO_ATTACK_INTERVAL;
    if (Date.now() - player.lastAttack >= attackInterval) {
      doAutoAttack(pid);
    }
  });
}, 1000);

setInterval(() => {
  if (Object.keys(gameState.players).length > 0 && gameState.items.length < 3) {
    spawnRandomItem();
  }
}, ITEM_SPAWN_INTERVAL);

setInterval(() => {
  const toRemove = [];
  gameState.projectiles.forEach((proj, idx) => {
    proj.x += proj.dx;
    proj.y += proj.dy;

    if (proj.x < 0 || proj.x >= GRID_SIZE || proj.y < 0 || proj.y >= GRID_SIZE) {
      toRemove.push(idx);
      return;
    }

    Object.values(gameState.players).forEach(p => {
      if (p.id !== proj.owner && p.hp > 0) {
        if (Date.now() < p.invincibleUntil) return;

        if (Math.round(p.x) === Math.round(proj.x) && Math.round(p.y) === Math.round(proj.y)) {
          if (proj.isPowerAttack) {
            p.hp = 0;
          } else {
            p.hp--;
          }
          toRemove.push(idx);

          const attacker = gameState.players[proj.owner];
          if (attacker && p.hp <= 0) {
            attacker.kills++;
            p.deaths++;
          }

          io.emit('playerHit', {
            playerId: p.id,
            hp: p.hp,
            attackerId: proj.owner,
            isPowerAttack: proj.isPowerAttack
          });

          if (p.hp <= 0) {
            const spawn = getRandomSpawn(gameState.players);
            p.x = spawn.x;
            p.y = spawn.y;
            p.hp = 3;
            p.invincibleUntil = Date.now() + INVINCIBLE_TIME;

            io.emit('playerRespawned', {
              playerId: p.id,
              x: p.x,
              y: p.y,
              hp: p.hp,
              invincibleUntil: p.invincibleUntil
            });

            updateRankings();
          }
        }
      }
    });
  });

  toRemove.sort((a,b) => b-a).forEach(i => gameState.projectiles.splice(i, 1));

  io.emit('projectilesUpdate', { projectiles: gameState.projectiles });

  const playerStates = {};
  Object.values(gameState.players).forEach(p => {
    playerStates[p.id] = { 
      lastAttack: p.lastAttack, 
      invincibleUntil: p.invincibleUntil,
      powerAttackUntil: p.powerAttackUntil,
      fastAttackUntil: p.fastAttackUntil,
      disableAttackUntil: p.disableAttackUntil,
      reverseUntil: p.reverseUntil
    };
  });
  io.emit('playerStatesUpdate', { states: playerStates });

  io.emit('rankingsUpdate', { rankings: getRankings() });

}, 100);

function getRankings() {
  return Object.values(gameState.players)
    .sort((a, b) => b.kills - a.kills)
    .map(p => ({
      name: p.name,
      kills: p.kills,
      deaths: p.deaths,
      color: p.color
    }));
}

function updateRankings() {
  io.emit('rankingsUpdate', { rankings: getRankings() });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`騳团大乱斗 服务器运行在端口 ${PORT}`);
});
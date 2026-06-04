// 騳团专用PK格斗器 - 联机服务器
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

// 静态文件服务
app.use(express.static('.'));

app.get('/', (req, res) => {
  res.sendFile(__dirname + '/fight-game.html');
});

// 游戏状态
let gameState = {
  players: {},     // socket.id -> player data
  projectiles: [],
  rankings: []    // 击杀排行（含死亡数）
};

// 玩家颜色池（支持更多颜色）
const COLORS = ['#e94560', '#4ecca3', '#f9d342', '#6c63ff', '#ff6b6b', '#48dbfb', '#ff9ff3', '#feca57', '#1dd1a1', '#5f27cd', '#ff6348', '#2ed573'];
const WEAPONS = ['🔪', '🔫', '⚔️', '🦾', '🗡️', '🏹', '💣', '⚡'];
const GRID_SIZE = 10;
const AUTO_ATTACK_INTERVAL = 5000; // 每5秒自动攻击
const INVINCIBLE_TIME = 10000;      // 10秒无敌

// 随机生成不冲突的出生点
function getRandomSpawn(allPlayers) {
  const occupied = new Set();
  Object.values(allPlayers).forEach(p => {
    occupied.add(`${p.x},${p.y}`);
  });

  // 最多尝试100次找空位
  for (let i = 0; i < 100; i++) {
    const x = Math.floor(Math.random() * GRID_SIZE);
    const y = Math.floor(Math.random() * GRID_SIZE);
    if (!occupied.has(`${x},${y}`)) {
      return { x, y };
    }
  }
  // 兜底：返回随机位置
  return {
    x: Math.floor(Math.random() * GRID_SIZE),
    y: Math.floor(Math.random() * GRID_SIZE)
  };
}

// 分配颜色和武器
let colorIndex = 0;
let weaponIndex = 0;
function allocColor() {
  const c = COLORS[colorIndex % COLORS.length];
  colorIndex++;
  return c;
}
function allocWeapon() {
  const w = WEAPONS[weaponIndex % WEAPONS.length];
  weaponIndex++;
  return w;
}

io.on('connection', (socket) => {
  console.log('玩家连接:', socket.id);

  // 玩家进入（无人数限制）
  socket.on('join', (data) => {
    const { name } = data;
    const spawn = getRandomSpawn(gameState.players);

    const player = {
      id: socket.id,
      name: name,
      x: spawn.x,
      y: spawn.y,
      color: allocColor(),
      weapon: allocWeapon(),
      hp: 3,
      ready: true,
      invincibleUntil: Date.now() + INVINCIBLE_TIME,
      kills: 0,
      deaths: 0,
      lastAttack: 0
    };

    gameState.players[socket.id] = player;
    socket.emit('joined', {
      playerId: socket.id,
      player: player,
      allPlayers: gameState.players
    });

    // 广播给所有人
    io.emit('playerJoined', { player });

    // 更新排行榜
    updateRankings();

    console.log(`${name} 加入了游戏，当前玩家: ${Object.keys(gameState.players).length}`);
  });

  // 移动
  socket.on('move', (data) => {
    const player = gameState.players[socket.id];
    if (!player || player.hp <= 0 || Date.now() < player.invincibleUntil) return;

    const { dx, dy } = data;
    const nx = player.x + dx;
    const ny = player.y + dy;

    // 边界检查
    if (nx < 0 || nx >= GRID_SIZE || ny < 0 || ny >= GRID_SIZE) return;

    // 检查碰撞（活人不能重叠）
    const occupied = Object.values(gameState.players)
      .find(p => p.id !== socket.id && p.hp > 0 && p.x === nx && p.y === ny);
    if (occupied) return;

    player.x = nx;
    player.y = ny;

    io.emit('playerMoved', { id: socket.id, x: nx, y: ny });
  });

  // 攻击
  socket.on('attack', () => {
    doAutoAttack(socket.id);
  });

  // 断开连接
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

// 执行攻击
function doAutoAttack(playerId) {
  const player = gameState.players[playerId];
  if (!player || player.hp <= 0) return;
  if (Date.now() < player.invincibleUntil) return; // 无敌时不能攻击

  player.lastAttack = Date.now();

  // 四向发射
  const dirs = [{x:1,y:0}, {x:-1,y:0}, {x:0,y:1}, {x:0,y:-1}];
  dirs.forEach(dir => {
    gameState.projectiles.push({
      id: Date.now() + Math.random(),
      x: player.x,
      y: player.y,
      dx: dir.x,
      dy: dir.y,
      color: player.color,
      owner: playerId
    });
  });

  io.emit('attack', { playerId: socket.id, projectiles: gameState.projectiles });
}

// 服务器自动攻击定时器（每5秒全体玩家自动攻击）
setInterval(() => {
  Object.keys(gameState.players).forEach(pid => {
    doAutoAttack(pid);
  });
}, AUTO_ATTACK_INTERVAL);

// 游戏循环 - 更新弹道
setInterval(() => {
  const toRemove = [];
  gameState.projectiles.forEach((proj, idx) => {
    proj.x += proj.dx;
    proj.y += proj.dy;

    // 出界
    if (proj.x < 0 || proj.x >= GRID_SIZE || proj.y < 0 || proj.y >= GRID_SIZE) {
      toRemove.push(idx);
      return;
    }

    // 检测命中
    Object.values(gameState.players).forEach(p => {
      if (p.id !== proj.owner && p.hp > 0) {
        if (Date.now() < p.invincibleUntil) return;

        if (Math.round(p.x) === Math.round(proj.x) && Math.round(p.y) === Math.round(proj.y)) {
          p.hp--;
          toRemove.push(idx);

          // 击杀统计
          const attacker = gameState.players[proj.owner];
          if (attacker && p.hp <= 0) {
            attacker.kills++;
            p.deaths++;
          }

          io.emit('playerHit', {
            playerId: p.id,
            hp: p.hp,
            attackerId: proj.owner
          });

          // 玩家死亡 - 原地复活（保持统计连贯）
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

  // 移除已出界/命中的弹道
  toRemove.sort((a,b) => b-a).forEach(i => gameState.projectiles.splice(i, 1));

  // 同步弹道
  io.emit('projectilesUpdate', { projectiles: gameState.projectiles });

  // 同步玩家状态（无敌/CD）
  const playerStates = {};
  Object.values(gameState.players).forEach(p => {
    playerStates[p.id] = { lastAttack: p.lastAttack, invincibleUntil: p.invincibleUntil };
  });
  io.emit('playerStatesUpdate', { states: playerStates });

  // 同步排行榜
  io.emit('rankingsUpdate', { rankings: getRankings() });

}, 100);

// 获取排行榜（按击杀数排序，同时显示死亡数）
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
  console.log(`騳团专用PK格斗器 服务器运行在端口 ${PORT}`);
});
// 格子格斗 - 联机服务器
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
  waitingQueue: [], // 等待中的玩家
  projectiles: [],
  gameStarted: false,
  rankings: [] // 击杀排行
};

// 玩家颜色
const COLORS = ['#e94560', '#4ecca3', '#f9d342', '#6c63ff'];
const WEAPONS = ['🔪', '🔫', '⚔️', '🦾'];
const SPAWN_POSITIONS = [
  { x: 1, y: 1 },
  { x: 8, y: 1 },
  { x: 1, y: 8 },
  { x: 8, y: 8 }
];
const ATTACK_CD = 5000;
const INVINCIBLE_TIME = 10000; // 10秒无敌

io.on('connection', (socket) => {
  console.log('玩家连接:', socket.id);
  
  // 玩家进入
  socket.on('join', (data) => {
    const { name } = data;
    
    // 检查是否已满
    const activePlayers = Object.values(gameState.players).filter(p => p.hp > 0);
    
    if (activePlayers.length >= 4) {
      // 加入等待队列
      gameState.waitingQueue.push({
        id: socket.id,
        name: name,
        joinTime: Date.now()
      });
      socket.emit('waiting', { position: gameState.waitingQueue.length });
      return;
    }
    
    // 分配位置
    const usedPositions = Object.values(gameState.players)
      .filter(p => p.hp > 0)
      .map(p => p.positionIndex);
    
    let positionIndex = 0;
    for (let i = 0; i < 4; i++) {
      if (!usedPositions.includes(i)) {
        positionIndex = i;
        break;
      }
    }
    
    const spawn = SPAWN_POSITIONS[positionIndex];
    const player = {
      id: socket.id,
      name: name,
      x: spawn.x,
      y: spawn.y,
      color: COLORS[positionIndex],
      weapon: WEAPONS[positionIndex],
      hp: 3,
      positionIndex: positionIndex,
      ready: true,
      invincibleUntil: Date.now() + INVINCIBLE_TIME, // 10秒无敌
      kills: 0,
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
    if (nx < 0 || nx >= 10 || ny < 0 || ny >= 10) return;
    
    // 检查碰撞
    const occupied = Object.values(gameState.players)
      .find(p => p.id !== socket.id && p.hp > 0 && p.x === nx && p.y === ny);
    if (occupied) return;
    
    player.x = nx;
    player.y = ny;
    
    io.emit('playerMoved', { id: socket.id, x: nx, y: ny });
  });
  
  // 攻击
  socket.on('attack', () => {
    const player = gameState.players[socket.id];
    if (!player || player.hp <= 0) return;
    if (Date.now() < player.invincibleUntil) return; // 无敌时不能攻击
    if (Date.now() - player.lastAttack < ATTACK_CD) return;
    
    player.lastAttack = Date.now();
    
    // 四向发射
    const dirs = [{x:1,y:0}, {x:-1,y:0}, {x:0,y:1}, {x:0,y:-1}];
    dirs.forEach(dir => {
      const proj = {
        id: Date.now() + Math.random(),
        x: player.x,
        y: player.y,
        dx: dir.x,
        dy: dir.y,
        color: player.color,
        owner: socket.id
      };
      gameState.projectiles.push(proj);
    });
    
    io.emit('attack', { playerId: socket.id, projectiles: gameState.projectiles });
  });
  
  // 断开连接
  socket.on('disconnect', () => {
    const player = gameState.players[socket.id];
    if (player) {
      // 从等待队列移除
      gameState.waitingQueue = gameState.waitingQueue.filter(p => p.id !== socket.id);
      
      delete gameState.players[socket.id];
      io.emit('playerLeft', { id: socket.id });
      
      // 检查等待队列
      checkWaitingQueue();
      
      console.log(`玩家离开: ${player.name}`);
    }
  });
});

// 检查等待队列
function checkWaitingQueue() {
  if (gameState.waitingQueue.length === 0) return;
  
  const activePlayers = Object.values(gameState.players).filter(p => p.hp > 0);
  if (activePlayers.length >= 4) return;
  
  // 取出第一个等待的玩家
  const waiting = gameState.waitingQueue.shift();
  
  // 分配位置
  const usedPositions = Object.values(gameState.players)
    .filter(p => p.hp > 0)
    .map(p => p.positionIndex);
  
  let positionIndex = 0;
  for (let i = 0; i < 4; i++) {
    if (!usedPositions.includes(i)) {
      positionIndex = i;
      break;
    }
  }
  
  const spawn = SPAWN_POSITIONS[positionIndex];
  const player = {
    id: waiting.id,
    name: waiting.name,
    x: spawn.x,
    y: spawn.y,
    color: COLORS[positionIndex],
    weapon: WEAPONS[positionIndex],
    hp: 3,
    positionIndex: positionIndex,
    ready: true,
    invincibleUntil: Date.now() + INVINCIBLE_TIME,
    kills: 0,
    lastAttack: 0
  };
  
  gameState.players[waiting.id] = player;
  
  // 通知该玩家
  io.to(waiting.id).emit('joined', { 
    playerId: waiting.id,
    player: player,
    allPlayers: gameState.players
  });
  
  // 广播给所有人
  io.emit('playerJoined', { player });
  
  console.log(`${waiting.name} 从等待队列加入游戏`);
}

// 游戏循环
setInterval(() => {
  // 更新弹道
  const toRemove = [];
  gameState.projectiles.forEach((proj, idx) => {
    proj.x += proj.dx;
    proj.y += proj.dy;
    
    // 出界
    if (proj.x < 0 || proj.x >= 10 || proj.y < 0 || proj.y >= 10) {
      toRemove.push(idx);
      return;
    }
    
    // 检测命中
    Object.values(gameState.players).forEach(p => {
      if (p.id !== proj.owner && p.hp > 0) {
        // 无敌检查
        if (Date.now() < p.invincibleUntil) return;
        
        if (Math.round(p.x) === Math.round(proj.x) && Math.round(p.y) === Math.round(proj.y)) {
          p.hp--;
          toRemove.push(idx);
          
          // 击杀统计
          const attacker = gameState.players[proj.owner];
          if (attacker && p.hp <= 0) {
            attacker.kills++;
          }
          
          io.emit('playerHit', { 
            playerId: p.id, 
            hp: p.hp,
            attackerId: proj.owner
          });
          
          // 玩家死亡
          if (p.hp <= 0) {
            // 更新排行榜
            updateRankings();
            
            // 延迟移除死亡玩家
            setTimeout(() => {
              if (gameState.players[p.id]) {
                delete gameState.players[p.id];
                io.emit('playerLeft', { id: p.id });
                checkWaitingQueue();
              }
            }, 100);
          }
        }
      }
    });
  });
  
  // 移除
  toRemove.sort((a,b) => b-a).forEach(i => gameState.projectiles.splice(i, 1));
  
  // 同步弹道
  if (gameState.projectiles.length > 0) {
    io.emit('projectilesUpdate', { projectiles: gameState.projectiles });
  }
  
  // 同步排行榜
  io.emit('rankingsUpdate', { rankings: getRankings() });
  
}, 100);

// 获取排行榜
function getRankings() {
  return Object.values(gameState.players)
    .filter(p => p.kills > 0)
    .sort((a, b) => b.kills - a.kills)
    .map(p => ({ name: p.name, kills: p.kills, color: p.color }));
}

function updateRankings() {
  io.emit('rankingsUpdate', { rankings: getRankings() });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`格子格斗服务器运行在端口 ${PORT}`);
});

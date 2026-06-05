// 格子格斗 - 联机服务器 (延迟优化版)
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const compression = require("compression");

const app = express();

// gzip压缩 - 减少传输大小，降低网络延迟


app.use(compression({ threshold: 0 }));
app.use(express.static("."));

app.get("/", (req, res) => {
  res.sendFile(__dirname + "/fight-game.html");
});

// ... rest will be added ...

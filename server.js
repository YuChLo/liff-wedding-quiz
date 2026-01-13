import "dotenv/config";
import express from "express";
import http from "http";
import { Server } from "socket.io";

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true } });

const PORT = Number(process.env.PORT || 3000);
const BASE_URL = process.env.BASE_URL || "";
const ADMIN_KEY = process.env.ADMIN_KEY || "change-me";
const LIFF_ID_PLAYER = process.env.LIFF_ID_PLAYER || "";
const LIFF_ID_HOST = process.env.LIFF_ID_HOST || "";

// In-memory rooms (fine for wedding)
const rooms = new Map();

const now = () => Date.now();
const normCode = (s) => (s||"").toString().trim().toUpperCase();
const safeName = (s, fb="Guest") => ((s||"").toString().trim().slice(0,20) || fb);

function makeCode(len=6){
  const chars="ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out="";
  for(let i=0;i<len;i++) out += chars[Math.floor(Math.random()*chars.length)];
  return out;
}

function defaultQuestions(){
  return [
    {text:"誰比較會賴床？",choices:["新郎","新娘","都會","都不會"],correctIndex:0},
    {text:"兩人第一次約會是？",choices:["咖啡廳","餐廳","電影院","公園"],correctIndex:1},
    {text:"求婚是在？",choices:["家裡","餐廳","戶外景點","旅館"],correctIndex:2},
    {text:"最常一起做的事？",choices:["追劇","運動","打電動","散步"],correctIndex:0},
    {text:"婚後家務分工？",choices:["輪流","新郎做","新娘做","掃地機器人"],correctIndex:0},
  ];
}

function snapshot(room){
  const players = Array.from(room.players.values())
    .map(p=>({userId:p.userId,name:p.name,score:p.score,connected:p.connected}))
    .sort((a,b)=>b.score-a.score || a.name.localeCompare(b.name));
  const q = room.questions[room.qIndex] || null;
  return {
    code: room.code,
    state: room.state,
    qIndex: room.qIndex,
    total: room.questions.length,
    question: q ? {text:q.text,choices:q.choices} : null,
    startAt: room.startAt,
    durationMs: room.durationMs,
    answersCount: room.answers.size,
    players
  };
}
function broadcast(room){ io.to("room:"+room.code).emit("room:update", snapshot(room)); }

app.use(express.static("public", { extensions:["html"] }));

app.get("/config", (req,res)=>{
  const role = (req.query.role || "player").toString();
  const liffId = (req.query.liffId || (role==="host"?LIFF_ID_HOST:LIFF_ID_PLAYER)).toString();
  res.json({ role, liffId, baseUrl: BASE_URL });
});

io.on("connection", (socket)=>{

  socket.on("host:create", (p, cb)=>{
    if (p?.adminKey !== ADMIN_KEY) return cb?.({ok:false,error:"ADMIN_KEY invalid"});
    let code = makeCode();
    while(rooms.has(code)) code = makeCode();
    const room = {
      code,
      hostSocket: socket.id,
      state:"lobby",
      qIndex:0,
      startAt:0,
      durationMs:15000,
      questions: defaultQuestions(),
      players: new Map(),
      answers: new Map()
    };
    rooms.set(code, room);
    socket.join("room:"+code);
    cb?.({ok:true, room: snapshot(room)});
    broadcast(room);
  });

  socket.on("host:join", (p, cb)=>{
    const code = normCode(p?.code);
    const room = rooms.get(code);
    if (!room) return cb?.({ok:false,error:"Room not found"});
    if (p?.adminKey !== ADMIN_KEY) return cb?.({ok:false,error:"ADMIN_KEY invalid"});
    room.hostSocket = socket.id;
    socket.join("room:"+code);
    cb?.({ok:true, room: snapshot(room)});
    broadcast(room);
  });

  socket.on("host:setQuestions", (p, cb)=>{
    const code = normCode(p?.code);
    const room = rooms.get(code);
    if (!room) return cb?.({ok:false,error:"Room not found"});
    if (p?.adminKey !== ADMIN_KEY) return cb?.({ok:false,error:"ADMIN_KEY invalid"});
    const qs = p?.questions;
    if (!Array.isArray(qs) || !qs.length) return cb?.({ok:false,error:"Invalid questions"});
    const clean = [];
    for (const q of qs){
      if (!q?.text || !Array.isArray(q?.choices) || q.choices.length!==4) continue;
      const ci = Number(q.correctIndex);
      if (![0,1,2,3].includes(ci)) continue;
      clean.push({text:String(q.text).slice(0,120),choices:q.choices.map(x=>String(x).slice(0,40)),correctIndex:ci});
    }
    if (!clean.length) return cb?.({ok:false,error:"No valid questions"});
    room.questions = clean;
    room.qIndex = 0;
    room.state = "lobby";
    room.answers.clear();
    cb?.({ok:true, room: snapshot(room)});
    broadcast(room);
  });

  socket.on("host:start", (p, cb)=>{
    const code = normCode(p?.code);
    const room = rooms.get(code);
    if (!room) return cb?.({ok:false,error:"Room not found"});
    if (p?.adminKey !== ADMIN_KEY) return cb?.({ok:false,error:"ADMIN_KEY invalid"});
    if (!room.questions[room.qIndex]) return cb?.({ok:false,error:"No question"});
    room.state="question";
    room.durationMs = Math.max(5000, Math.min(60000, Number(p?.durationMs||15000)));
    room.startAt = now();
    room.answers.clear();
    cb?.({ok:true, room: snapshot(room)});
    broadcast(room);
    setTimeout(()=>reveal(code), room.durationMs + 200);
  });

  function reveal(code){
    const room = rooms.get(code);
    if (!room || room.state!=="question") return;
    const q = room.questions[room.qIndex];
    const correct = q.correctIndex;
    for (const [uid, ans] of room.answers.entries()){
      const player = room.players.get(uid);
      if (!player) continue;
      if (ans.choiceIndex !== correct) continue;
      const elapsed = Math.max(0, ans.receivedAt - room.startAt);
      const ratio = Math.min(1, elapsed / room.durationMs);
      const points = Math.round(1000 - 800*ratio); // 1000->200
      player.score += points;
    }
    room.state="reveal";
    broadcast(room);
    io.to("room:"+room.code).emit("question:reveal", { correctIndex: correct, top10: snapshot(room).players.slice(0,10) });
  }

  socket.on("host:reveal", (p, cb)=>{
    const code = normCode(p?.code);
    const room = rooms.get(code);
    if (!room) return cb?.({ok:false,error:"Room not found"});
    if (p?.adminKey !== ADMIN_KEY) return cb?.({ok:false,error:"ADMIN_KEY invalid"});
    reveal(code);
    cb?.({ok:true, room: snapshot(room)});
  });

  socket.on("host:next", (p, cb)=>{
    const code = normCode(p?.code);
    const room = rooms.get(code);
    if (!room) return cb?.({ok:false,error:"Room not found"});
    if (p?.adminKey !== ADMIN_KEY) return cb?.({ok:false,error:"ADMIN_KEY invalid"});
    room.qIndex += 1;
    room.answers.clear();
    room.state = (room.qIndex >= room.questions.length) ? "ended" : "lobby";
    cb?.({ok:true, room: snapshot(room)});
    broadcast(room);
  });

  socket.on("player:join", (p, cb)=>{
    const code = normCode(p?.code);
    const room = rooms.get(code);
    if (!room) return cb?.({ok:false,error:"Room not found"});
    const userId = String(p?.userId||"");
    if (!userId) return cb?.({ok:false,error:"Missing userId"});
    const name = safeName(p?.name);
    // Employee ID validation (digits only, length 4~10)
    if (!/^[0-9]+$/.test(name)) {
      return cb({ ok:false, error:"工號只能輸入數字（不可英文/符號）" });
    }
    if (name.length < 4 || name.length > 10) {
      return cb({ ok:false, error:"工號長度需 4~10 碼" });
    }

    socket.join("room:"+code);

    const existing = room.players.get(userId);
    if (existing){
      existing.socketId = socket.id;
      existing.name = name;
      existing.connected = true;
    } else {
      room.players.set(userId, { userId, name, socketId: socket.id, score:0, lastQ:-1, connected:true });
    }
    cb?.({ok:true, room: snapshot(room)});
    broadcast(room);
  });

  // Display/observer join (not a player, won't appear in leaderboard)
  socket.on("display:join", ({ code }, cb) => {
    const room = rooms.get((code||"").toString().trim().toUpperCase());
    if (!room) return cb && cb({ ok:false, error:"Room not found" });
    socket.join(room.code);
    socket.emit("room:update", snapshot(room));
    cb && cb({ ok:true });
  });


  socket.on("player:answer", (p, cb)=>{
    const code = normCode(p?.code);
    const room = rooms.get(code);
    if (!room) return cb?.({ok:false,error:"Room not found"});
    if (room.state!=="question") return cb?.({ok:false,error:"Not accepting answers"});
    const userId = String(p?.userId||"");
    const choiceIndex = Number(p?.choiceIndex);
    if (![0,1,2,3].includes(choiceIndex)) return cb?.({ok:false,error:"Invalid choice"});
    const player = room.players.get(userId);
    if (!player) return cb?.({ok:false,error:"Not joined"});
    if (player.lastQ === room.qIndex) return cb?.({ok:false,error:"Already answered"});
    player.lastQ = room.qIndex;
    room.answers.set(userId, { choiceIndex, receivedAt: now() });
    cb?.({ok:true});
    io.to("room:"+room.code).emit("room:answersCount", { answersCount: room.answers.size });
  });

  socket.on("disconnect", ()=>{
    for (const room of rooms.values()){
      for (const pl of room.players.values()){
        if (pl.socketId === socket.id) pl.connected = false;
      }
      if (room.hostSocket === socket.id) room.hostSocket = null;
    }
  });
});

server.listen(PORT, ()=>console.log("Server on", PORT));

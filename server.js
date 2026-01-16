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
  const correctIndex = (room.state === "reveal" && q) ? q.correctIndex : null;
  return {
    code: room.code,
    state: room.state,
    qIndex: room.qIndex,
    total: room.questions.length,
    question: q ? {text:q.text,choices:q.choices} : null,
    correctIndex,
    startAt: room.startAt,
    durationMs: room.durationMs,
    answersCount: room.answers.size,
    players
  };
}
function broadcast(room){ io.to("room:"+room.code).emit("room:update", snapshot(room)); }

app.use(express.static("public", { extensions:["html"] }));

function buildScoreText(room, minScore, maxScore){
  const snap = snapshot(room);
  const players = snap.players.filter(p=>{
    const score = Number(p.score);
    if (Number.isNaN(score)) return false;
    if (score < minScore) return false;
    if (Number.isFinite(maxScore) && score > maxScore) return false;
    return true;
  });
  const lines = [];
  lines.push(`房間碼: ${snap.code}`);
  const rangeText = Number.isFinite(maxScore) ? `${minScore}~${maxScore}` : `>=${minScore}`;
  lines.push(`門檻: ${rangeText}`);
  lines.push(`產出時間: ${new Date().toLocaleString()}`);
  lines.push("");
  if (!players.length){
    lines.push("無符合玩家");
    return lines.join("\n");
  }
  players.forEach((p, i)=>{
    lines.push(`${i+1}. ${p.name || "Guest"} - ${p.score}`);
  });
  return lines.join("\n");
}

app.get("/config", (req,res)=>{
  const role = (req.query.role || "player").toString();
  const liffId = (req.query.liffId || (role==="host"?LIFF_ID_HOST:LIFF_ID_PLAYER)).toString();
  res.json({ role, liffId, baseUrl: BASE_URL });
});

app.get("/export/score", (req,res)=>{
  const code = normCode(req.query.code);
  const adminKey = (req.query.adminKey || "").toString();
  const minScore = Math.max(0, Number(req.query.minScore || 2000));
  const maxScore = (req.query.maxScore === undefined || req.query.maxScore === "") ? Infinity : Number(req.query.maxScore);
  if (!code) return res.status(400).send("Missing code");
  if (adminKey !== ADMIN_KEY) return res.status(403).send("ADMIN_KEY invalid");
  const room = rooms.get(code);
  if (!room) return res.status(404).send("Room not found");
  const text = buildScoreText(room, minScore, maxScore);
  const filename = Number.isFinite(maxScore)
    ? `score-${code}-${minScore}to${maxScore}.txt`
    : `score-${code}-ge${minScore}.txt`;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(text);
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
      answers: new Map(),
      revealTimer: null
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
    if (room.state !== "lobby") return cb?.({ok:false,error:"Already started"});
    room.state="question";
    room.durationMs = Math.max(5000, Math.min(60000, Number(p?.durationMs||15000)));
    room.startAt = now();
    room.answers.clear();
    if (room.revealTimer) clearTimeout(room.revealTimer);
    cb?.({ok:true, room: snapshot(room)});
    broadcast(room);
    const qIndex = room.qIndex;
    room.revealTimer = setTimeout(()=>reveal(code, qIndex), room.durationMs + 200);
  });

  function reveal(code, qIndex){
    const room = rooms.get(code);
    if (!room || room.state!=="question") return;
    if (typeof qIndex === "number" && qIndex !== room.qIndex) return;
    if (room.revealTimer) {
      clearTimeout(room.revealTimer);
      room.revealTimer = null;
    }
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
    reveal(code, room.qIndex);
    cb?.({ok:true, room: snapshot(room)});
  });

  socket.on("host:next", (p, cb)=>{
    const code = normCode(p?.code);
    const room = rooms.get(code);
    if (!room) return cb?.({ok:false,error:"Room not found"});
    if (p?.adminKey !== ADMIN_KEY) return cb?.({ok:false,error:"ADMIN_KEY invalid"});
    if (!room.questions.length) return cb?.({ok:false,error:"No question"});
    if (room.state === "ended") return cb?.({ok:false,error:"Already ended"});
    if (room.revealTimer) {
      clearTimeout(room.revealTimer);
      room.revealTimer = null;
    }
    if (room.qIndex >= room.questions.length - 1) {
      room.state = "ended";
    } else {
      room.qIndex += 1;
      room.state = "lobby";
    }
    room.answers.clear();
    cb?.({ok:true, room: snapshot(room)});
    broadcast(room);
  });

  
  socket.on("display:join", (p, cb)=>{
    const code = normCode(p?.code);
    const room = rooms.get(code);
    if(!room) return cb?.({ok:false,error:"Room not found"});
    socket.join("room:"+code);
    cb?.({ok:true, room: snapshot(room)});
  });

  socket.on("player:join", (p, cb)=>{
    const code = normCode(p?.code);
    const room = rooms.get(code);
    if (!room) return cb?.({ok:false,error:"Room not found"});
    const userId = String(p?.userId||"");
    if (!userId) return cb?.({ok:false,error:"Missing userId"});
    const name = safeName(p?.name);
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

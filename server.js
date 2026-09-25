const express=require("express");
const http=require("http");
const {Server}=require("socket.io");
const path=require("path");
const crypto=require("crypto");

const app=express();
const server=http.createServer(app);
const io=new Server(server);
app.use(express.static(path.join(__dirname,"public")));

const words=["BEACH","PIZZA","ELEPHANT","DUBAI","WEDDING","COFFEE","RAIN","AIRPORT","MOUNTAIN","CAMERA","BIRYANI","MOVIE","SCHOOL","CONCERT","CHOCOLATE","TEMPLE","CRICKET","PUPPY","SAREE","ICE CREAM"];
const rooms=new Map();

function code(){return crypto.randomBytes(3).toString("hex").toUpperCase();}
function getRoom(id){return rooms.get(id);}
function publicRoom(room){
  return {code:room.code,host:room.host,phase:room.phase,players:[...room.players.values()].map(p=>({id:p.id,name:p.name,hasVoted:p.hasVoted}))};
}

io.on("connection",socket=>{
  socket.on("createGame",(name,cb)=>{
    let c=code(); while(rooms.has(c)) c=code();
    const room={code:c,host:socket.id,phase:"lobby",word:null,imposter:null,players:new Map(),votes:new Map()};
    room.players.set(socket.id,{id:socket.id,name:(name||"Host").trim().slice(0,30),hasVoted:false});
    rooms.set(c,room); socket.join(c); socket.data.room=c;
    cb({ok:true,code:c,id:socket.id}); io.to(c).emit("roomUpdate",publicRoom(room));
  });
  socket.on("joinGame",({code,name},cb)=>{
    const room=getRoom(String(code||"").toUpperCase().trim());
    if(!room)return cb({ok:false,error:"Game not found."});
    if(room.phase!=="lobby")return cb({ok:false,error:"Game already started."});
    if(room.players.size>=30)return cb({ok:false,error:"Game is full."});
    if(!name||!name.trim())return cb({ok:false,error:"Enter your name."});
    const clean=name.trim().slice(0,30);
    if([...room.players.values()].some(p=>p.name.toLowerCase()===clean.toLowerCase()))return cb({ok:false,error:"That name is already taken."});
    room.players.set(socket.id,{id:socket.id,name:clean,hasVoted:false});
    socket.join(room.code); socket.data.room=room.code; cb({ok:true,code:room.code,id:socket.id});
    io.to(room.code).emit("roomUpdate",publicRoom(room));
  });
  socket.on("startGame",(_,cb)=>{
    const room=getRoom(socket.data.room); if(!room||room.host!==socket.id)return;
    if(room.players.size<3)return cb?.({ok:false,error:"Need at least 3 players."});
    const ids=[...room.players.keys()];
    room.imposter=ids[Math.floor(Math.random()*ids.length)];
    room.word=words[Math.floor(Math.random()*words.length)];
    room.phase="clues"; room.votes.clear(); room.players.forEach(p=>p.hasVoted=false);
    for(const [id,p] of room.players) io.to(id).emit("privateRole",{imposter:id===room.imposter,word:id===room.imposter?null:room.word});
    io.to(room.code).emit("phase","clues"); io.to(room.code).emit("roomUpdate",publicRoom(room));
    cb?.({ok:true});
  });
  socket.on("startVoting",()=>{
    const room=getRoom(socket.data.room); if(!room||room.host!==socket.id)return;
    room.phase="voting"; io.to(room.code).emit("phase","voting"); io.to(room.code).emit("roomUpdate",publicRoom(room));
  });
  socket.on("vote",(target,cb)=>{
    const room=getRoom(socket.data.room); if(!room||room.phase!=="voting")return cb?.({ok:false,error:"Voting is not open."});
    if(!room.players.has(target)||target===socket.id)return cb?.({ok:false,error:"Invalid vote."});
    if(room.votes.has(socket.id))return cb?.({ok:false,error:"You already voted."});
    room.votes.set(socket.id,target); room.players.get(socket.id).hasVoted=true;
    io.to(room.code).emit("roomUpdate",publicRoom(room));
    if(room.votes.size===room.players.size){room.phase="results";const counts={};for(const t of room.votes.values())counts[t]=(counts[t]||0)+1;const max=Math.max(...Object.values(counts));const winners=Object.keys(counts).filter(k=>counts[k]===max);io.to(room.code).emit("results",{imposter:room.imposter,word:room.word,counts,winners});}
    cb?.({ok:true});
  });
  socket.on("disconnect",()=>{
    const room=getRoom(socket.data.room); if(!room)return;
    room.players.delete(socket.id);
    if(room.host===socket.id){const next=room.players.keys().next().value;if(next){room.host=next;io.to(room.code).emit("newHost",next)}else{rooms.delete(room.code);return}}
    if(room.players.size===0)rooms.delete(room.code); else io.to(room.code).emit("roomUpdate",publicRoom(room));
  });
});
const PORT=process.env.PORT||3000;
server.listen(PORT,()=>console.log("Imposter server running on "+PORT));

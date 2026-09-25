const express=require("express");
const http=require("http");
const {Server}=require("socket.io");
const path=require("path");
const crypto=require("crypto");

const app=express(), server=http.createServer(app), io=new Server(server);
app.use(express.static(path.join(__dirname,"public")));
const rooms=new Map();

function code(){return crypto.randomBytes(3).toString("hex").toUpperCase();}
function imposterCount(n){return n<=10?1:n<=20?2:3;}
function view(r){return {code:r.code,host:r.host,phase:r.phase,players:[...r.players.values()].map(p=>({id:p.id,name:p.name,voted:p.voted}))};}
function emit(r){io.to(r.code).emit("room",view(r));}

io.on("connection",s=>{
  s.on("createGame",(name,cb)=>{
    if(!name?.trim())return cb({ok:false,error:"Enter your name."});
    let c=code();while(rooms.has(c))c=code();
    const r={code:c,host:s.id,phase:"lobby",normalWord:"",imposterWords:[],imposters:[],assignments:new Map(),players:new Map(),votes:new Map()};
    r.players.set(s.id,{id:s.id,name:name.trim().slice(0,30),voted:false});
    rooms.set(c,r);s.join(c);s.data.room=c;cb({ok:true,id:s.id,code:c});emit(r);
  });

  s.on("joinGame",({code:raw,name},cb)=>{
    const r=rooms.get(String(raw||"").toUpperCase().trim());
    if(!r)return cb({ok:false,error:"Game not found."});
    if(r.phase!=="lobby")return cb({ok:false,error:"This game has already started."});
    if(r.players.size>=35)return cb({ok:false,error:"This game is full (35 players)."});
    if(!name?.trim())return cb({ok:false,error:"Enter your name."});
    const clean=name.trim().slice(0,30);
    if([...r.players.values()].some(p=>p.name.toLowerCase()===clean.toLowerCase()))return cb({ok:false,error:"That name is already taken."});
    r.players.set(s.id,{id:s.id,name:clean,voted:false});s.join(r.code);s.data.room=r.code;cb({ok:true,id:s.id,code:r.code});emit(r);
  });

  s.on("openSetup",(_,cb)=>{
    const r=rooms.get(s.data.room);if(!r||r.host!==s.id||r.phase!=="lobby")return;
    if(r.players.size<3)return cb?.({ok:false,error:"At least 3 players are required."});
    r.phase="setup";emit(r);cb?.({ok:true,count:r.players.size,imposters:imposterCount(r.players.size)});
  });

  s.on("startGame",({normalWord,imposterWords},cb)=>{
    const r=rooms.get(s.data.room);if(!r||r.host!==s.id||r.phase!=="setup")return cb?.({ok:false,error:"Only the host can start the game."});
    const n=r.players.size,k=imposterCount(n),ids=[...r.players.keys()];
    if(n<3)return cb?.({ok:false,error:"At least 3 players are required."});
    if(!normalWord?.trim())return cb?.({ok:false,error:"Enter the normal player word."});
    const iw=(imposterWords||[]).map(x=>String(x).trim());
    if(iw.length!==k||iw.some(x=>!x))return cb?.({ok:false,error:`Enter exactly ${k} imposter word${k===1?"":"s"}.`});
    if(new Set(iw.map(x=>x.toLowerCase())).size!==k)return cb?.({ok:false,error:"Imposter words must be different."});
    r.normalWord=normalWord.trim().slice(0,80);r.imposterWords=iw.map(x=>x.slice(0,80));
    r.imposters=[];while(r.imposters.length<k){const id=ids[Math.floor(Math.random()*ids.length)];if(!r.imposters.includes(id))r.imposters.push(id);}
    r.assignments.clear();
    r.imposters.forEach((id,i)=>r.assignments.set(id,{imposter:true,word:r.imposterWords[i]}));
    ids.filter(id=>!r.imposters.includes(id)).forEach(id=>r.assignments.set(id,{imposter:false,word:r.normalWord}));
    r.phase="playing";
    for(const id of ids)io.to(id).emit("secret",r.assignments.get(id));
    emit(r);cb?.({ok:true,count:n,imposters:k});
  });

  s.on("openVoting",()=>{
    const r=rooms.get(s.data.room);if(r?.host===s.id&&r.phase==="playing"){r.phase="voting";r.votes.clear();r.players.forEach(p=>p.voted=false);emit(r);}
  });

  s.on("vote",(targets,cb)=>{
    const r=rooms.get(s.data.room);if(!r||r.phase!=="voting")return cb?.({ok:false,error:"Voting is not open."});
    if(r.votes.has(s.id))return cb?.({ok:false,error:"You already voted."});
    const arr=Array.isArray(targets)?[...new Set(targets)].filter(id=>r.players.has(id)&&id!==s.id):[];
    const k=imposterCount(r.players.size);
    if(arr.length!==k)return cb?.({ok:false,error:`Select exactly ${k} player${k===1?"":"s"}.`});
    r.votes.set(s.id,arr);r.players.get(s.id).voted=true;emit(r);
    if(r.votes.size===r.players.size){
      const counts={};for(const a of r.votes.values())for(const id of a)counts[id]=(counts[id]||0)+1;
      r.phase="results";
      io.to(r.code).emit("results",{counts,imposters:r.imposters,normalWord:r.normalWord,imposterWords:r.imposterWords,imposterCount:k,playerCount:r.players.size,players:[...r.players.values()].map(p=>({id:p.id,name:p.name}))});
      emit(r);
    }
    cb?.({ok:true});
  });

  s.on("disconnect",()=>{
    const r=rooms.get(s.data.room);if(!r)return;r.players.delete(s.id);
    if(r.players.size===0){rooms.delete(r.code);return;}
    if(r.host===s.id){r.host=r.players.keys().next().value;io.to(r.code).emit("hostChanged",r.host);}
    emit(r);
  });
});
server.listen(process.env.PORT||3000,()=>console.log("Imposter V3 running"));

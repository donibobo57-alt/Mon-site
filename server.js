import express from "express";
import cors from "cors";
import fs from "fs";
import crypto from "crypto";
import {Client,GatewayIntentBits,ActionRowBuilder,ButtonBuilder,ButtonStyle,EmbedBuilder,AttachmentBuilder,PermissionFlagsBits} from "discord.js";

// Ces valeurs se mettent dans les "variables d'environnement" de l'hébergeur, JAMAIS dans le code.
const {TOKEN,CHANNEL_ID,SITE_URL="*",PORT=3000}=process.env;

const F="data.json";
let db={users:{},reqs:{}};
try{db=JSON.parse(fs.readFileSync(F))}catch{}
const save=()=>fs.writeFileSync(F,JSON.stringify(db));
const cut=(t,n=1000)=>String(t??"").trim().slice(0,n)||"-";
const okUid=u=>/^[0-9a-f-]{36}$/.test(u);
const last={};
const slow=(k,ms)=>{const n=Date.now();if(n-(last[k]||0)<ms)return true;last[k]=n;return false};

const bot=new Client({intents:[GatewayIntentBits.Guilds,GatewayIntentBits.GuildMessages,GatewayIntentBits.MessageContent]});
const app=express();
app.use(cors({origin:SITE_URL}));
app.use(express.json({limit:"600kb"}));

// 1) Nouvelle demande -> envoyée dans ton salon admin avec boutons Accepter / Refuser
app.post("/api/request",async(q,s)=>{
 const b=q.body||{};
 if(!okUid(b.uid))return s.json({error:"Compte invalide."});
 if(slow("r"+b.uid,60000))return s.json({error:"Attends une minute avant une autre demande."});
 if(!/^data:image\/jpeg;base64,/.test(b.avatar||"")||b.avatar.length>300000)return s.json({error:"Photo invalide."});
 const id=crypto.randomUUID().slice(0,8);
 const r={id,uid:b.uid,kind:b.kind=="pret"?"pret":"perso",discord:cut(b.discord,60),title:cut(b.title,100),status:"attente",threadId:null,msgs:[],t:Date.now()};
 const e=new EmbedBuilder().setColor(0xd80f1f)
  .setTitle((r.kind=="perso"?"Bot personnalisé : ":"Bot déjà fait : ")+r.title)
  .setThumbnail("attachment://profil.jpg")
  .addFields({name:"Discord",value:r.discord},{name:"Paiement",value:cut(b.pay,60)},{name:"Texte",value:cut(b.descr)},{name:"Utilisation",value:cut(b.usage)},{name:"Commandes",value:cut(b.cmds)},{name:"Style",value:cut(b.style)});
 const row=new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId("ok_"+id).setLabel("Accepter").setStyle(ButtonStyle.Success),
  new ButtonBuilder().setCustomId("no_"+id).setLabel("Refuser").setStyle(ButtonStyle.Danger));
 try{
  const ch=await bot.channels.fetch(CHANNEL_ID);
  await ch.send({embeds:[e],components:[row],files:[new AttachmentBuilder(Buffer.from(b.avatar.split(",")[1],"base64"),{name:"profil.jpg"})]});
 }catch(err){console.error(err);return s.json({error:"Envoi à Discord impossible."})}
 db.reqs[id]=r;save();s.json({id});
});

// 2) État du compte (historique, conversations, profil)
app.get("/api/state",(q,s)=>{
 const u=q.query.uid;
 if(!okUid(u))return s.json({reqs:[],profile:{}});
 s.json({profile:db.users[u]||{},reqs:Object.values(db.reqs).filter(r=>r.uid==u).map(({id,kind,title,status,msgs,t})=>({id,kind,title,status,msgs,t}))});
});

// 3) Message du client -> posté dans le fil Discord
app.post("/api/msg",async(q,s)=>{
 const{uid,id,text}=q.body||{};
 const r=db.reqs[id];
 if(!r||r.uid!==uid||r.status!="accepte")return s.json({error:"Conversation fermée."});
 if(slow("m"+uid,1000))return s.json({error:"Doucement, trop vite."});
 const t=cut(text,500);
 r.msgs.push({from:"client",text:t,t:Date.now()});save();
 try{const th=await bot.channels.fetch(r.threadId);await th.send(`**${r.discord}** : ${t}`.replace(/@/g,"@\u200b"))}catch{}
 s.json({ok:1});
});

// 4) Profil (pseudo + couleur du site)
app.post("/api/profile",(q,s)=>{
 const{uid,pseudo,color}=q.body||{};
 if(!okUid(uid))return s.json({error:"Compte invalide."});
 db.users[uid]={pseudo:String(pseudo||"").slice(0,40),color:/^#[0-9a-f]{6}$/i.test(color)?color:"#d80f1f"};
 save();s.json({ok:1});
});

// Boutons Accepter / Refuser (réservés à ceux qui ont "Gérer les messages")
bot.on("interactionCreate",async i=>{
 if(!i.isButton())return;
 const[a,id]=i.customId.split("_");
 const r=db.reqs[id];
 if(!r||r.status!="attente")return i.reply({content:"Déjà traitée.",ephemeral:true});
 if(!i.memberPermissions.has(PermissionFlagsBits.ManageMessages))return i.reply({content:"Réservé aux admins.",ephemeral:true});
 if(a=="no"){
  r.status="refuse";r.msgs.push({from:"sys",text:"Demande refusée.",t:Date.now()});save();
  return i.update({content:"❌ Refusée par "+i.user.tag,components:[]});
 }
 const th=await i.message.startThread({name:("demande-"+r.title).slice(0,90)});
 r.status="accepte";r.threadId=th.id;
 r.msgs.push({from:"sys",text:"Demande acceptée ! Un admin te répond ici.",t:Date.now()});save();
 await th.send(`Conversation avec **${r.discord}**. Tout ce que tu écris ici s'affiche sur le site.`);
 i.update({content:"✅ Acceptée par "+i.user.tag,components:[]});
});

// Message d'un admin dans le fil -> affiché sur le site du client
bot.on("messageCreate",m=>{
 if(m.author.bot||!m.content||!m.channel.isThread())return;
 const r=Object.values(db.reqs).find(x=>x.threadId==m.channel.id);
 if(!r)return;
 r.msgs.push({from:"admin",text:m.content.slice(0,1000),t:Date.now()});save();
});

bot.login(TOKEN);
app.listen(PORT);

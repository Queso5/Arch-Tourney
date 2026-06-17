const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const os = require('os');


const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── GEMINI AVATAR GENERATION ────────────────────────────────────────────────
app.post('/generate-avatar', async (req, res) => {
  const { prompt } = req.body || {};
  if (!prompt || !prompt.trim()) {
    return res.status(400).json({ error: 'Prompt is required.' });
  }

  const fullPrompt = `${prompt.trim()}, head only portrait, front facing, cartoon game avatar, transparent background, centered face, square portrait, no body`;
  const encodedPrompt = encodeURIComponent(fullPrompt);
  const generateUrl = `https://image.pollinations.ai/prompt/${encodedPrompt}`;

  try {
    console.log(`\n[AI Avatar] Generating image with Pollinations...`);
    console.log(`[AI Avatar] Prompt: ${fullPrompt}`);
    
    const startTime = Date.now();
    
    // Set 20 second timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 20000);
    
    const response = await fetch(generateUrl, { signal: controller.signal });
    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`Pollinations API returned status: ${response.status}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const base64String = buffer.toString('base64');
    
    const durationMs = Date.now() - startTime;
    console.log(`[AI Avatar] Generation duration: ${durationMs}ms`);
    console.log(`[AI Avatar] Image extraction success. Payload size: ${base64String.length} chars.`);

    return res.json({
      mimeType: 'image/jpeg',
      data: base64String,
    });
  } catch (err) {
    console.error('[AI Avatar] Image extraction failure/error:', err?.message || err);
    if (err.name === 'AbortError') {
      return res.status(504).json({ error: 'Generation timed out. Pollinations is currently unavailable or too slow.' });
    }
    return res.status(500).json({ error: 'Failed to generate avatar. Pollinations may be unavailable.' });
  }
});


// ─── LAN IP DETECTION ────────────────────────────────────────────────────────
function getLocalIP(){
  const interfaces=os.networkInterfaces();
  for(const name of Object.keys(interfaces)){
    for(const iface of interfaces[name]){
      if(iface.family==='IPv4'&&!iface.internal) return iface.address;
    }
  }
  return '127.0.0.1';
}
const LOCAL_IP=getLocalIP();
const PORT=process.env.PORT||3002;

// ─── CONSTANTS ────────────────────────────────────────────────────────────────
const W=900, H=500, GROUND_Y=H-80;
const GRAVITY=0.38, ARROW_SPEED_MIN=6, ARROW_SPEED_MAX=18; // scales with pull force
const MAX_HP=100, MAX_STAMINA=100;
const STAMINA_REGEN=0.12, STAMINA_SHOOT_COST=15;
const RESPAWN_DELAY=90;   // ~3s after death before respawn

// ── DASH ──
const DASH_SPEED=11, DASH_DURATION=10, DASH_COOLDOWN=45, DASH_STAMINA_COST=20;
// ── SHIELD ──
const SHIELD_DURATION=90, SHIELD_COOLDOWN=150, SHIELD_STAMINA_COST=30;
// ── PERFECT CHARGE ──
const PERFECT_CHARGE_THRESHOLD=0.95, PERFECT_CHARGE_BONUS=1.2;

// ── HITBOX ZONES (relative to archer center x, y=GROUND_Y) ──
const HEAD_Y_OFFSET = -52, HEAD_R = 12;
const TORSO_Y_OFFSET = -28, TORSO_R = 16;

// ── DAMAGE TABLE ──────────────────────────────────────────────────────────────
const DAMAGE = {
  head:  100, // instant kill by default
  torso: 25,  // 4 body shots = 100hp
  limb:  10,  // grazing hit
};

// ── ARROW TYPE MULTIPLIERS & EFFECTS ─────────────────────────────────────────
const ARROW_CONFIG = {
  normal:    { dmgMult:1.0, effects:[] },
  fire:      { dmgMult:1.0, effects:['burn'],    burnDps:5,   burnDuration:4000 },
  ice:       { dmgMult:0.8, effects:['slow'],    slowDuration:3000 },
  explosive: { dmgMult:1.5, effects:['knockback','stun'], stunDuration:1500 },
  multi:     { dmgMult:0.7, effects:[] }, // 3 arrows but each weaker
};


const COLORS=['#FF3B3B','#3BFF6E','#3BB5FF','#FFD93B','#FF8C3B','#C03BFF','#FF69B4','#00FFFF'];
let rooms={};
// LAN visitors: players who haven't joined a room yet but announced themselves
let lanWaiters={}; // socketId -> {socketId, name, color}
function rand(a,b){return a+Math.random()*(b-a);}
function dist(ax,ay,bx,by){return Math.sqrt((ax-bx)**2+(ay-by)**2);}
function uid(){return Math.random().toString(36).slice(2,8);}

// ─── HURDLES ─────────────────────────────────────────────────────────────────
function makeHurdles(){
  return [
    {x:W*0.33-9,y:GROUND_Y-220,w:18,h:160,vy:2.0, minY:GROUND_Y-320,maxY:GROUND_Y-60},
    {x:W*0.50-9,y:GROUND_Y-100,w:18,h:200,vy:-2.5,minY:GROUND_Y-340,maxY:GROUND_Y-40},
    {x:W*0.67-9,y:GROUND_Y-260,w:18,h:140,vy:1.8, minY:GROUND_Y-300,maxY:GROUND_Y-50},
  ];
}
function tickHurdles(h){
  h.forEach(h=>{
    h.y+=h.vy;
    if(h.y<h.minY){h.y=h.minY;h.vy=Math.abs(h.vy);}
    if(h.y+h.h>h.maxY){h.y=h.maxY-h.h;h.vy=-Math.abs(h.vy);}
  });
}
function arrowHitsHurdle(arrow,h){
  return arrow.x>=h.x&&arrow.x<=h.x+h.w&&arrow.y>=h.y&&arrow.y<=h.y+h.h;
}

// ─── APPLES ───────────────────────────────────────────────────────────────────
function spawnApple(){
  // 1-in-8 chance for the golden power apple, 1-in-10 for wings (extra life)
  let type;
  const roll=Math.random();
  if(roll<1/8){
    type='power';
  } else if(roll<1/8+1/10){
    type='wings';
  } else {
    const types=['red','green','gold'];
    type=types[Math.floor(Math.random()*3)];
  }
  const spd=rand(1.0,2.0),ang=rand(0,Math.PI*2);
  return {id:uid(),type,x:rand(150,W-150),y:rand(80,GROUND_Y-80),
    vx:Math.cos(ang)*spd,vy:Math.sin(ang)*spd,r:10,alive:true};
}
function tickApples(apples){
  apples.forEach(a=>{
    a.x+=a.vx; a.y+=a.vy;
    if(a.x-a.r<=0){a.x=a.r;a.vx=Math.abs(a.vx);}
    if(a.x+a.r>=W){a.x=W-a.r;a.vx=-Math.abs(a.vx);}
    if(a.y-a.r<=0){a.y=a.r;a.vy=Math.abs(a.vy);}
    if(a.y+a.r>=GROUND_Y){a.y=GROUND_Y-a.r;a.vy=-Math.abs(a.vy);}
  });
}

// ─── RAGDOLL ──────────────────────────────────────────────────────────────────
function createRagdoll(){return{active:false,parts:[],timer:0};}
function triggerRagdoll(archer, force=1){
  archer.ragdoll={active:true,timer:55,parts:[
    {x:archer.x,    y:archer.y-52, vx:rand(-4,4)*force, vy:rand(-7,-2)*force, r:10},
    {x:archer.x,    y:archer.y-28, vx:rand(-2,2)*force, vy:rand(-4,-1)*force, r:7},
    {x:archer.x-14, y:archer.y-32, vx:rand(-6,-1)*force,vy:rand(-3,1)*force,  r:4},
    {x:archer.x+14, y:archer.y-32, vx:rand(1,6)*force,  vy:rand(-3,1)*force,  r:4},
    {x:archer.x-7,  y:archer.y-8,  vx:rand(-3,0)*force, vy:rand(-2,2)*force,  r:4},
    {x:archer.x+7,  y:archer.y-8,  vx:rand(0,3)*force,  vy:rand(-2,2)*force,  r:4},
  ]};
}
function tickRagdoll(r){
  if(!r.active) return;
  r.timer--;
  if(r.timer<=0){r.active=false;return;}
  r.parts.forEach(p=>{
    p.vy+=GRAVITY*0.5; p.x+=p.vx; p.y+=p.vy;
    p.vx*=0.94; p.vy*=0.94;
    if(p.y>GROUND_Y){p.y=GROUND_Y;p.vy*=-0.28;}
  });
}

// ─── ARCHER ───────────────────────────────────────────────────────────────────
function createArcher(id,name,color,side){
  return {
    id,name,color,side,
    x:side===0?80:W-80, y:GROUND_Y,
    vy:0, onGround:true,
    hp:MAX_HP, stamina:MAX_STAMINA,
    alive:true, dead:false,  // dead = permanently out of match
    respawnTimer:0,
    ragdoll:createRagdoll(),
    aimAngle:side===0?-0.35:-Math.PI+0.35,
    chargePower:0, facing:side===0?1:-1,
    isBot:false,
    botCharging:false, botChargeStart:0,
    hitFlash:0, walkTick:0,
    // Status effects
    burning:false, burnTimer:0, burnDps:0,
    slowed:false,  slowTimer:0,
    stunned:false, stunTimer:0,
    // Last arrow type (for bow draw visual)
    lastArrowType:'normal',
    // ── Dash ──
    dashing:false, dashTimer:0, dashDir:0, dashCooldown:0,
    // ── Shield ──
    shielded:false, shieldTimer:0, shieldCooldown:0,
    // ── Stats (for post-duel screen + awards) ──
    stats:{ arrowsFired:0, arrowsHit:0, headshots:0, damageDealt:0, dashesUsed:0, shieldsUsed:0 },
    // ── Power Shot buff (from golden power apple) ──
    powerShotReady:false,
    // ── Extra life (from wings apple) ──
    extraLives:0,
  };
}

// ─── STATUS EFFECT TICK ───────────────────────────────────────────────────────
function tickStatusEffects(a, duel){
  if(a.dead||!a.alive) return;

  // Burn — damage over time (ticks every 30 frames = 1s)
  if(a.burning){
    a.burnTimer--;
    if(a.burnTimer<=0){
      a.burning=false; a.burnDps=0;
    } else if(duel.tickCount%30===0){
      const burnDmg=a.burnDps||5;
      a.hp=Math.max(0,a.hp-burnDmg);
      duel.events.push({type:'burn',playerId:a.id,dmg:burnDmg,hp:a.hp});
      if(a.hp<=0) killArcher(a,duel,null,'burn');
    }
  }

  // Slow — reduces aim speed (handled in bot AI check)
  if(a.slowed){
    a.slowTimer--;
    if(a.slowTimer<=0) a.slowed=false;
  }

  // Stun — can't shoot or move
  if(a.stunned){
    a.stunTimer--;
    if(a.stunTimer<=0) a.stunned=false;
  }
}

// ─── LOCALIZED HIT DETECTION ──────────────────────────────────────────────────
// Returns 'head' | 'torso' | 'limb' | null
function getHitZone(arrow, archer){
  const ax=archer.x, ay=archer.y;

  // Head
  const headDist=dist(arrow.x,arrow.y, ax, ay+HEAD_Y_OFFSET);
  if(headDist < HEAD_R+5) return 'head';

  // Torso
  const torsoDist=dist(arrow.x,arrow.y, ax, ay+TORSO_Y_OFFSET);
  if(torsoDist < TORSO_R+5) return 'torso';

  // Limb (wider catch-all within archer bounding box)
  const limbDist=dist(arrow.x,arrow.y, ax, ay-20);
  if(limbDist < 28) return 'limb';

  return null;
}

// ─── KILL / RESPAWN ───────────────────────────────────────────────────────────
function killArcher(archer, duel, killerId, reason){
  if(!archer.alive||archer.dead) return;
  archer.alive=false;
  archer.dead=true;
  archer.hp=0;
  archer.burning=false; archer.slowed=false; archer.stunned=false;
  triggerRagdoll(archer, reason==='explosive'?2.5:1);
  duel.events.push({type:'killed',playerId:archer.id,killerId,reason,victimName:archer.name});
}

function respawnArcher(a){
  a.alive=true; a.hp=MAX_HP;
  a.y=GROUND_Y; a.vy=0; a.onGround=true;
  a.ragdoll=createRagdoll(); a.respawnTimer=0;
  a.burning=false; a.slowed=false; a.stunned=false;
  a.powerShotReady=false;
  // extraLives intentionally NOT reset on stagger-respawn — only resets between duels via createArcher
}

// ─── BOT AI ───────────────────────────────────────────────────────────────────
function tickBot(archer,enemy,arrows,duel){
  if(archer.dead||!archer.isBot||!archer.alive||archer.stunned) return;
  const dx=enemy.x-archer.x, dy=(enemy.y-35)-(archer.y-35);
  // Aim for head when possible (slight upward bias)
  archer.aimAngle=Math.atan2(dy-8,dx)+(Math.random()-0.5)*0.12;

  const incomingArrow=arrows.find(a=>a.ownerId===enemy.id&&Math.abs(a.x-archer.x)<180&&Math.abs(a.y-(archer.y-30))<80);
  if(incomingArrow&&archer.onGround&&Math.random()<0.06){archer.vy=-10;archer.onGround=false;}

  const blocked=duel.hurdles.some(h=>{
    const hMidX=h.x+h.w/2;
    const left=Math.min(archer.x,enemy.x),right=Math.max(archer.x,enemy.x);
    if(hMidX<left||hMidX>right) return false;
    const t=(hMidX-archer.x)/(enemy.x-archer.x||1);
    const aimY=(archer.y-35)+t*((enemy.y-35)-(archer.y-35));
    return aimY>=h.y&&aimY<=h.y+h.h;
  });

  const shootDelay=archer.slowed?0.012:0.022;
  if(!blocked&&archer.stamina>=STAMINA_SHOOT_COST){
    if(!archer.botCharging&&Math.random()<shootDelay){
      archer.botCharging=true; archer.botChargeStart=Date.now(); archer.chargePower=0;
    } else if(archer.botCharging){
      const elapsed=(Date.now()-archer.botChargeStart)/1000;
      archer.chargePower=Math.min(1,elapsed);
      if(archer.chargePower>rand(0.5,0.95)){
        duel.arrows.push(createArrow(archer,archer.aimAngle,archer.chargePower,'normal',duel.wind));
        archer.stamina-=STAMINA_SHOOT_COST;
        archer.botCharging=false; archer.chargePower=0;
      }
    }
  } else { archer.botCharging=false; archer.chargePower=0; }

  // Occasionally dash to dodge or reposition
  if(!archer.dashing&&archer.dashCooldown<=0&&archer.stamina>=DASH_STAMINA_COST&&Math.random()<0.01){
    const dir=incomingArrow?(incomingArrow.x>archer.x?-1:1):(Math.random()<0.5?-1:1);
    startDash(archer,dir);
  }
  // Occasionally raise shield when enemy arrow incoming
  if(incomingArrow&&!archer.shielded&&archer.shieldCooldown<=0&&archer.stamina>=SHIELD_STAMINA_COST&&Math.random()<0.08){
    startShield(archer);
  }
}

// ─── ARROW ────────────────────────────────────────────────────────────────────
// Speed scales linearly with pull power (charge): light pull = slow lob, full pull = fast shot
function getArrowSpeed(power){
  return ARROW_SPEED_MIN + (ARROW_SPEED_MAX-ARROW_SPEED_MIN)*Math.min(1,power);
}

function createArrow(archer,angle,power,arrowType,wind){
  const powerShot=archer.powerShotReady===true;
  // Power shot consumes the buff and guarantees: max speed, perfect status, guaranteed kill on hit
  const effectivePower=powerShot?1:power;
  const speed=getArrowSpeed(effectivePower);
  const isPerfect=powerShot || power>=PERFECT_CHARGE_THRESHOLD;
  const dmgMult=isPerfect?PERFECT_CHARGE_BONUS:1.0;
  archer.stats.arrowsFired++;
  if(powerShot) archer.powerShotReady=false; // consume buff
  return {
    id:uid(), ownerId:archer.id,
    x:archer.x+archer.facing*24, y:archer.y-38,
    vx:Math.cos(angle)*speed + (wind||0),
    vy:Math.sin(angle)*speed,
    alive:true, age:0, angle, power:effectivePower,
    arrowType:arrowType||'normal',
    isPerfect, dmgMult,
    wind:wind||0,
    guaranteedKill:powerShot,
  };
}

// ─── WIND ─────────────────────────────────────────────────────────────────────
function rollWind(){
  // Wind ranges -1.5 to 1.5 px/tick added to arrow vx, changes each duel
  return rand(-1.5,1.5);
}

// ─── DASH ─────────────────────────────────────────────────────────────────────
function startDash(archer, dir){
  if(archer.dashing||archer.dashCooldown>0||archer.stamina<DASH_STAMINA_COST) return false;
  archer.dashing=true; archer.dashTimer=DASH_DURATION; archer.dashDir=dir;
  archer.dashCooldown=DASH_COOLDOWN;
  archer.stamina-=DASH_STAMINA_COST;
  archer.stats.dashesUsed++;
  return true;
}
function tickDash(a){
  if(a.dashCooldown>0) a.dashCooldown--;
  if(a.dashing){
    a.x += a.dashDir*DASH_SPEED;
    a.x = Math.max(20, Math.min(W-20, a.x));
    a.dashTimer--;
    if(a.dashTimer<=0) a.dashing=false;
  }
}

// ─── SHIELD ───────────────────────────────────────────────────────────────────
function startShield(archer){
  if(archer.shielded||archer.shieldCooldown>0||archer.stamina<SHIELD_STAMINA_COST) return false;
  archer.shielded=true; archer.shieldTimer=SHIELD_DURATION;
  archer.shieldCooldown=SHIELD_COOLDOWN;
  archer.stamina-=SHIELD_STAMINA_COST;
  archer.stats.shieldsUsed++;
  return true;
}
function tickShield(a){
  if(a.shieldCooldown>0) a.shieldCooldown--;
  if(a.shielded){
    a.shieldTimer--;
    if(a.shieldTimer<=0) a.shielded=false;
  }
}

// ─── FALLING ROCKS ──────────────────────────────────────────────────────────
const ROCK_WARNING_TIME=45; // ticks of warning shadow before rock falls (1.5s)
const ROCK_FALL_SPEED=7, ROCK_RADIUS=16, ROCK_DAMAGE=18;
function maybeSpawnRock(duel){
  // ~1 rock every ~8 seconds on average (240 ticks), random chance each tick
  if(Math.random()<1/300){
    duel.rocks.push({
      id:uid(), x:rand(80,W-80), y:-30,
      warningTimer:ROCK_WARNING_TIME, falling:false, alive:true,
    });
  }
}
function tickRocks(duel, archerList, room){
  duel.rocks.forEach(rock=>{
    if(!rock.alive) return;
    if(!rock.falling){
      rock.warningTimer--;
      if(rock.warningTimer<=0){ rock.falling=true; rock.y=-20; }
      return;
    }
    rock.y+=ROCK_FALL_SPEED;
    if(rock.y>GROUND_Y+20){ rock.alive=false; return; }
    // Hit hurdle — destroyed, no damage
    duel.hurdles.forEach(h=>{
      if(rock.alive&&arrowHitsHurdle({x:rock.x,y:rock.y},h)) rock.alive=false;
    });
    if(!rock.alive) return;
    // Hit archer
    archerList.forEach(a=>{
      if(!rock.alive||!a.alive||a.dead) return;
      if(dist(rock.x,rock.y,a.x,a.y-25)<ROCK_RADIUS+22){
        rock.alive=false;
        if(a.shielded){
          a.shielded=false; a.shieldTimer=0;
          duel.events.push({type:'shieldBlock',playerId:a.id,x:a.x,y:a.y-30});
          return;
        }
        if(a.dashing) return; // dash invincibility applies to rocks too
        a.hp=Math.max(0,a.hp-ROCK_DAMAGE);
        a.hitFlash=18;
        a.vy=-5; a.onGround=false; // knockback
        duel.events.push({type:'rockHit',playerId:a.id,dmg:ROCK_DAMAGE,hp:a.hp,x:a.x,y:a.y,victimName:a.name});
        if(a.hp<=0){
          if(a.extraLives>0){
            a.extraLives--; a.hp=Math.round(MAX_HP*0.5);
            a.alive=false; a.respawnTimer=Math.round(RESPAWN_DELAY*0.6);
            triggerRagdoll(a,0.5);
            duel.events.push({type:'extraLifeUsed',playerId:a.id,x:a.x,y:a.y,hp:a.hp,victimName:a.name});
          } else {
            triggerRagdoll(a,1.2);
            a.alive=false; a.dead=true;
            duel.events.push({type:'killed',playerId:a.id,killerId:null,zone:'rock',arrowType:'rock',
              victimName:a.name,isHeadshot:false,reason:'rock'});
            const winner=archerList.find(e=>e.id!==a.id&&!e.dead);
            if(winner) endDuel(duel,room,winner.id,'rock');
          }
        } else {
          a.alive=false; a.respawnTimer=RESPAWN_DELAY;
          triggerRagdoll(a,0.6);
        }
      }
    });
  });
  duel.rocks=duel.rocks.filter(r=>r.alive);
}


function createDuel(p1,p2,roomCode,matchId){
  return {
    roomCode, matchId,
    archers:{
      [p1.id]:createArcher(p1.id,p1.name,p1.color,0),
      [p2.id]:createArcher(p2.id,p2.name,p2.color,1),
    },
    arrows:[], apples:[spawnApple(),spawnApple()],
    hurdles:makeHurdles(), rocks:[],
    wind:rollWind(),
    tickCount:0, gameLoop:null, winner:null, state:'playing', events:[],
  };
}

function tickDuel(duel,room){
  duel.tickCount++; duel.events=[];
  tickHurdles(duel.hurdles);
  if(duel.tickCount%150===0&&duel.apples.length<5) duel.apples.push(spawnApple());
  tickApples(duel.apples);
  // Falling rocks start after a short grace period (10s) so opening isn't punishing
  if(duel.tickCount>300) maybeSpawnRock(duel);

  const archerList=Object.values(duel.archers);
  tickRocks(duel,archerList,room);

  archerList.forEach(a=>{
    if(a.dead) return;
    if(!a.alive){
      if(a.respawnTimer>0){ a.respawnTimer--; tickRagdoll(a.ragdoll); }
      if(a.respawnTimer===0&&!a.alive&&a.ragdoll.timer===0) respawnArcher(a);
      return;
    }
    // Regen
    a.stamina=Math.min(MAX_STAMINA,a.stamina+STAMINA_REGEN);
    // HP regen if not burning (small passive regen)
    if(!a.burning) a.hp=Math.min(MAX_HP,a.hp+0.015);

    if(!a.onGround&&!a.stunned){a.vy+=GRAVITY;a.y+=a.vy;}
    if(a.y>=GROUND_Y){a.y=GROUND_Y;a.vy=0;a.onGround=true;}
    tickRagdoll(a.ragdoll);
    tickDash(a);
    tickShield(a);
    a.walkTick++;
    if(a.hitFlash>0) a.hitFlash--;
    tickStatusEffects(a,duel);
  });

  archerList.forEach(a=>{
    if(a.dead||!a.alive||!a.isBot) return;
    const enemy=archerList.find(e=>e.id!==a.id&&!e.dead);
    if(enemy) tickBot(a,enemy,duel.arrows,duel);
  });

  // ── ARROWS ────────────────────────────────────────────────────────────────
  duel.arrows.forEach(arrow=>{
    if(!arrow.alive) return;
    arrow.vy+=GRAVITY*0.22;
    arrow.x+=arrow.vx; arrow.y+=arrow.vy;
    arrow.angle=Math.atan2(arrow.vy,arrow.vx);
    arrow.age++;
    if(arrow.x<0||arrow.x>W||arrow.y>H+20||arrow.age>200){arrow.alive=false;return;}

    // Hit hurdle
    duel.hurdles.forEach(h=>{if(arrow.alive&&arrowHitsHurdle(arrow,h))arrow.alive=false;});

    // ── ARROW-VS-ARROW COLLISION ─────────────────────────────────────────────
    if(arrow.alive){
      duel.arrows.forEach(other=>{
        if(!other.alive||other.id===arrow.id||other.ownerId===arrow.ownerId) return;
        if(dist(arrow.x,arrow.y,other.x,other.y)<8){
          arrow.alive=false; other.alive=false;
          duel.events.push({type:'arrowClash',x:arrow.x,y:arrow.y});
        }
      });
    }
    if(!arrow.alive) return;

    // Hit apple (arrow passes through)
    if(arrow.alive){
      duel.apples.forEach(apple=>{
        if(!apple.alive) return;
        if(dist(arrow.x,arrow.y,apple.x,apple.y)<apple.r+7){
          const shooter=duel.archers[arrow.ownerId];
          if(shooter&&!shooter.dead) collectApple(apple,shooter,duel);
        }
      });
    }

    // ── HIT ARCHER — localized hitboxes ─────────────────────────────────────
    archerList.forEach(a=>{
      if(!arrow.alive||!a.alive||a.dead||a.id===arrow.ownerId) return;

      const zone=getHitZone(arrow,a);
      if(!zone) return;

      const shooter=duel.archers[arrow.ownerId];

      // ── DASH INVINCIBILITY — dashing archers are untouchable ──
      if(a.dashing){ arrow.alive=false; return; }

      // ── SHIELD BLOCK — fully blocks normal/fire/ice/multi (not explosive) ──
      if(a.shielded && arrow.arrowType!=='explosive'){
        arrow.alive=false;
        a.shielded=false; a.shieldTimer=0; // shield breaks after one block
        duel.events.push({type:'shieldBlock',playerId:a.id,x:a.x,y:a.y-30});
        return;
      }

      arrow.alive=false;
      const aType=arrow.arrowType||'normal';
      const cfg=ARROW_CONFIG[aType]||ARROW_CONFIG.normal;

      // ── DAMAGE CALCULATION ────────────────────────────────────────────────
      let baseDmg=DAMAGE[zone];
      let finalDmg=Math.round(baseDmg*cfg.dmgMult*(arrow.dmgMult||1));

      // Headshot with high power = guaranteed kill
      const isInstaKill = (zone==='head'&&arrow.power>0.6) || arrow.guaranteedKill;
      if(isInstaKill) finalDmg=MAX_HP;

      a.hp=Math.max(0,a.hp-finalDmg);
      a.hitFlash=zone==='head'?25:18;

      // ── STATS TRACKING ────────────────────────────────────────────────────
      if(shooter){
        shooter.stats.arrowsHit++;
        shooter.stats.damageDealt+=finalDmg;
        if(zone==='head') shooter.stats.headshots++;
      }

      // ── APPLY STATUS EFFECTS ──────────────────────────────────────────────
      cfg.effects.forEach(effect=>{
        if(effect==='burn'){
          a.burning=true;
          a.burnTimer=Math.round((cfg.burnDuration/1000)*30); // convert to ticks
          a.burnDps=cfg.burnDps||5;
        }
        if(effect==='slow'){
          a.slowed=true;
          a.slowTimer=Math.round((cfg.slowDuration/1000)*30);
        }
        if(effect==='stun'){
          a.stunned=true;
          a.stunTimer=Math.round((cfg.stunDuration/1000)*30);
          a.vy=-4; a.onGround=false; // knockback up
        }
        if(effect==='knockback'){
          a.vy=-6; a.onGround=false; // always knocked up
        }
      });

      // Push event with zone + damage info
      duel.events.push({
        type:'hit', playerId:a.id, shooterId:arrow.ownerId, zone, dmg:finalDmg,
        hp:a.hp, arrowType:aType, x:a.x, y:a.y,
        isHeadshot:zone==='head', isPerfect:arrow.isPerfect,
        isPowerShot:arrow.guaranteedKill||false,
        shooterName:shooter?.name, victimName:a.name,
      });

      // Death check
      if(a.hp<=0){
        if(a.extraLives>0){
          // ── EXTRA LIFE — consume it, revive at half HP, no death ──
          a.extraLives--;
          a.hp=Math.round(MAX_HP*0.5);
          a.burning=false; a.slowed=false; a.stunned=false;
          a.hitFlash=30;
          duel.events.push({type:'extraLifeUsed',playerId:a.id,x:a.x,y:a.y,hp:a.hp,
            victimName:a.name});
          // Brief stagger but stays alive/in-match
          a.alive=false; a.respawnTimer=Math.round(RESPAWN_DELAY*0.6);
          triggerRagdoll(a,0.5);
        } else {
          const force=aType==='explosive'?2.5:1;
          triggerRagdoll(a,force);
          a.alive=false;
          a.dead=true;
          a.burning=false; a.slowed=false; a.stunned=false;
          duel.events.push({type:'killed',playerId:a.id,killerId:arrow.ownerId,zone,arrowType:aType,
            killerName:shooter?.name,victimName:a.name,isHeadshot:zone==='head'});
          const winner=archerList.find(e=>e.id!==a.id&&!e.dead);
          if(winner) endDuel(duel,room,winner.id,'killed');
        }
      } else {
        // Alive but hurt — short stagger
        a.alive=false; a.respawnTimer=RESPAWN_DELAY;
        triggerRagdoll(a,0.6);
      }
    });
  });

  duel.arrows=duel.arrows.filter(a=>a.alive);
  duel.apples=duel.apples.filter(a=>a.alive);

  // Archer walks into apple
  archerList.forEach(a=>{
    if(!a.alive||a.dead) return;
    duel.apples.forEach(apple=>{
      if(!apple.alive) return;
      if(dist(apple.x,apple.y,a.x,a.y-30)<apple.r+18) collectApple(apple,a,duel);
    });
  });
  duel.apples=duel.apples.filter(a=>a.alive);

  io.to(room.code).emit('duelState',{
    matchId:duel.matchId,
    wind:duel.wind,
    archers:archerList.map(a=>({
      id:a.id,name:a.name,color:a.color,side:a.side,
      x:a.x,y:a.y,alive:a.alive,dead:a.dead,
      hp:Math.round(a.hp),maxHp:MAX_HP,
      stamina:Math.round(a.stamina),
      aimAngle:a.aimAngle,chargePower:a.chargePower,facing:a.facing,
      ragdoll:a.ragdoll.active?a.ragdoll.parts:null,
      respawnTimer:a.respawnTimer,
      hitFlash:a.hitFlash||0, walkTick:a.walkTick||0,
      arrowType:a.lastArrowType||'normal',
      burning:a.burning||false,
      slowed:a.slowed||false,
      stunned:a.stunned||false,
      dashing:a.dashing||false, dashCooldown:a.dashCooldown||0,
      shielded:a.shielded||false, shieldCooldown:a.shieldCooldown||0,
      stamina_dashReady:a.dashCooldown<=0&&a.stamina>=DASH_STAMINA_COST,
      stamina_shieldReady:a.shieldCooldown<=0&&a.stamina>=SHIELD_STAMINA_COST,
      powerShotReady:a.powerShotReady||false,
      extraLives:a.extraLives||0,
    })),
    arrows:duel.arrows.map(a=>({
      id:a.id,x:a.x,y:a.y,vx:a.vx,vy:a.vy,angle:a.angle,
      color:duel.archers[a.ownerId]?.color||'#fff',
      arrowType:a.arrowType||'normal',
      isPerfect:a.isPerfect||false,
      guaranteedKill:a.guaranteedKill||false,
    })),
    apples:duel.apples.map(a=>({id:a.id,x:a.x,y:a.y,r:a.r,type:a.type})),
    hurdles:duel.hurdles.map(h=>({x:h.x,y:h.y,w:h.w,h:h.h})),
    rocks:duel.rocks.map(r=>({id:r.id,x:r.x,y:r.y,falling:r.falling,warningTimer:r.warningTimer})),
    state:duel.state, events:duel.events,
  });
}

function collectApple(apple,archer,duel){
  apple.alive=false;
  let hpGain=0, stGain=0, powerUp=false, extraLifeGained=false;
  if(apple.type==='red')  { hpGain=30; }
  if(apple.type==='green'){ stGain=40; }
  if(apple.type==='gold') { hpGain=20; stGain=25; }
  if(apple.type==='power'){
    archer.powerShotReady=true;
    powerUp=true;
  }
  if(apple.type==='wings'){
    if(archer.extraLives<1){ // cap at 1 stockpiled extra life
      archer.extraLives++;
      extraLifeGained=true;
    } else {
      // already have one — refund as HP/stamina instead
      hpGain=15; stGain=15;
    }
  }
  // Apples also cure burn
  if(apple.type==='red'||apple.type==='gold'||apple.type==='power'||apple.type==='wings'){
    archer.burning=false; archer.burnTimer=0;
  }
  archer.hp=Math.min(MAX_HP,archer.hp+hpGain);
  archer.stamina=Math.min(MAX_STAMINA,archer.stamina+stGain);
  duel.events.push({type:'apple',x:apple.x,y:apple.y,appleType:apple.type,
    playerId:archer.id,hpGain,stGain,powerUp,extraLifeGained});
}

function endDuel(duel,room,winnerId,reason){
  if(duel.state!=='playing') return;
  duel.state='ended'; duel.winner=winnerId;
  clearInterval(duel.gameLoop);
  const statsPayload={};
  room.tourneyStats=room.tourneyStats||{};
  Object.values(duel.archers).forEach(a=>{
    const acc=a.stats.arrowsFired>0?Math.round((a.stats.arrowsHit/a.stats.arrowsFired)*100):0;
    statsPayload[a.id]={
      name:a.name, color:a.color,
      arrowsFired:a.stats.arrowsFired, arrowsHit:a.stats.arrowsHit,
      accuracy:acc, headshots:a.stats.headshots,
      damageDealt:a.stats.damageDealt,
      dashesUsed:a.stats.dashesUsed, shieldsUsed:a.stats.shieldsUsed,
    };
    // Accumulate into tournament-wide totals (skip bots for awards display, but track anyway)
    if(!room.tourneyStats[a.id]) room.tourneyStats[a.id]={name:a.name,color:a.color,isBot:a.isBot,
      arrowsFired:0,arrowsHit:0,headshots:0,damageDealt:0,wins:0,comebackWins:0};
    const ts=room.tourneyStats[a.id];
    ts.arrowsFired+=a.stats.arrowsFired; ts.arrowsHit+=a.stats.arrowsHit;
    ts.headshots+=a.stats.headshots; ts.damageDealt+=a.stats.damageDealt;
    if(a.id===winnerId){
      ts.wins++;
      // Comeback win: won while below 25% HP at some point — approximate via low HP at win moment
      if(a.hp>0 && a.hp<=25) ts.comebackWins++;
    }
  });
  io.to(room.code).emit('duelEnd',{matchId:duel.matchId,winnerId,reason,stats:statsPayload});
  setTimeout(()=>advanceTournament(room,duel.matchId,winnerId),5000);
}

// ─── BRACKET ─────────────────────────────────────────────────────────────────
function nextPow2(n){let p=1;while(p<n)p*=2;return p;}

function buildBracket(players,allowBots){
  const arr=[...players].sort(()=>Math.random()-0.5);
  const n=arr.length;
  const slots=nextPow2(n);
  const numByes=slots-n;
  if(allowBots){
    let botNum=1;
    while(arr.length<slots){
      arr.push({id:'bot_'+uid(),name:`Bot ${botNum++}`,color:COLORS[arr.length%COLORS.length],isBot:true});
    }
  }
  const seeded=[...arr];
  while(seeded.length<slots) seeded.push(null);
  const r1=[];
  for(let i=0;i<slots/2;i++){
    const p1=seeded[i*2], p2=seeded[i*2+1];
    if(p1===null&&p2===null) continue;
    const isBye=!allowBots&&(p1===null||p2===null);
    r1.push({id:`r1m${r1.length}`,p1:p1||null,p2:p2||null,winner:null,bye:isBye,byeResolved:false});
  }
  const rounds=[r1];
  let prevCount=r1.length,rNum=2;
  while(prevCount>1){
    const nextCount=Math.ceil(prevCount/2);
    const r=[];
    for(let i=0;i<nextCount;i++) r.push({id:`r${rNum}m${i}`,p1:null,p2:null,winner:null,bye:false,byeResolved:false});
    rounds.push(r); prevCount=nextCount; rNum++;
  }
  return {rounds,slots,numByes};
}

// ─── DOUBLE ELIMINATION BRACKET ──────────────────────────────────────────────
// Builds a winners bracket (same shape as buildBracket) plus a losers bracket
// and a grand final. Explicit, hand-verified linking for slots = 2, 4, 8.
function buildDoubleBracket(players,allowBots){
  const winners=buildBracket(players,allowBots);
  const slots=winners.slots;

  let losersRounds=[];
  // dropMap: array indexed by losers-round-index, each entry describes where
  // losers from winners-bracket matches feed in, and how losers-round winners advance.
  let dropMap=[];

  if(slots===2){
    // No losers bracket — single match decides everything (degenerate case)
    losersRounds=[];
  } else if(slots===4){
    // WR1: r1m0 (A vs B), r1m1 (C vs D). WR2 (Final of winners): r2m0.
    // LR1: loser(r1m0) vs loser(r1m1) -> l1m0
    // LR2 (losers final): winner(l1m0) vs loser(r2m0) -> l2m0
    losersRounds=[
      [{id:'l1m0',p1:null,p2:null,winner:null,bye:false,byeResolved:false,isLosers:true}],
      [{id:'l2m0',p1:null,p2:null,winner:null,bye:false,byeResolved:false,isLosers:true}],
    ];
    dropMap=[
      // from winners match id -> {losersRound, losersMatch, slot}
      {from:'r1m0',to:{r:0,m:0,slot:'p1'}},
      {from:'r1m1',to:{r:0,m:0,slot:'p2'}},
      {from:'r2m0',to:{r:1,m:0,slot:'p2'}}, // loser of winners final drops to LR2 p2
    ];
    // winner of l1m0 -> l2m0.p1 (handled specially in advance logic)
  } else if(slots===8){
    // WR1 (4 matches): r1m0..r1m3. WR2 (semis, 2 matches): r2m0,r2m1. WR3 (final): r3m0.
    // LR1 (2 matches): losers of WR1 paired up -> l1m0 (r1m0 vs r1m1 losers), l1m1 (r1m2 vs r1m3 losers)
    // LR2 (2 matches): survivors of LR1 vs losers of WR2 -> l2m0 (winner l1m0 vs loser r2m0), l2m1 (winner l1m1 vs loser r2m1)
    // LR3 (1 match): winners of LR2 face off -> l3m0
    // LR4 (losers final): winner l3m0 vs loser of WR3(winners final) -> l4m0
    losersRounds=[
      [{id:'l1m0',p1:null,p2:null,winner:null,bye:false,byeResolved:false,isLosers:true},
       {id:'l1m1',p1:null,p2:null,winner:null,bye:false,byeResolved:false,isLosers:true}],
      [{id:'l2m0',p1:null,p2:null,winner:null,bye:false,byeResolved:false,isLosers:true},
       {id:'l2m1',p1:null,p2:null,winner:null,bye:false,byeResolved:false,isLosers:true}],
      [{id:'l3m0',p1:null,p2:null,winner:null,bye:false,byeResolved:false,isLosers:true}],
      [{id:'l4m0',p1:null,p2:null,winner:null,bye:false,byeResolved:false,isLosers:true}],
    ];
    dropMap=[
      {from:'r1m0',to:{r:0,m:0,slot:'p1'}},
      {from:'r1m1',to:{r:0,m:0,slot:'p2'}},
      {from:'r1m2',to:{r:0,m:1,slot:'p1'}},
      {from:'r1m3',to:{r:0,m:1,slot:'p2'}},
      {from:'r2m0',to:{r:1,m:0,slot:'p2'}},
      {from:'r2m1',to:{r:1,m:1,slot:'p2'}},
      {from:'r3m0',to:{r:3,m:0,slot:'p2'}}, // loser of winners final -> losers final
    ];
    // winner l1m0 -> l2m0.p1 ; winner l1m1 -> l2m1.p1
    // winner l2m0 -> l3m0.p1 ; winner l2m1 -> l3m0.p2
    // winner l3m0 -> l4m0.p1
  }

  // Internal losers-bracket advancement: winner of one LB match feeds into the next LB round.
  let losersAdvance=[];
  if(slots===4){
    losersAdvance=[
      {from:'l1m0',to:{r:1,m:0,slot:'p1'}},
    ];
  } else if(slots===8){
    losersAdvance=[
      {from:'l1m0',to:{r:1,m:0,slot:'p1'}},
      {from:'l1m1',to:{r:1,m:1,slot:'p1'}},
      {from:'l2m0',to:{r:2,m:0,slot:'p1'}},
      {from:'l2m1',to:{r:2,m:0,slot:'p2'}},
      {from:'l3m0',to:{r:3,m:0,slot:'p1'}},
    ];
  }

  const grandFinal={id:'gf',p1:null,p2:null,winner:null,bye:false,byeResolved:false,isGrandFinal:true};
  const grandFinalReset={id:'gfr',p1:null,p2:null,winner:null,bye:false,byeResolved:false,isGrandFinal:true,isReset:true,active:false};

  return {
    type:'double',
    rounds:winners.rounds,
    losersRounds, dropMap, losersAdvance,
    grandFinal, grandFinalReset,
    slots, numByes:winners.numByes,
  };
}



function resolveByes(room){
  const {bracket}=room;
  const r1=bracket.rounds[0];
  r1.forEach((m,mi)=>{
    if(m.byeResolved||m.winner!==null||!m.bye) return;
    const winner=m.p1||m.p2; if(!winner) return;
    m.winner=winner.id; m.byeResolved=true;
    if(bracket.rounds.length>1){
      const nextMatchIdx=Math.floor(mi/2);
      const slot=mi%2===0?'p1':'p2';
      bracket.rounds[1][nextMatchIdx][slot]=winner;
    }
  });
}

function getRoomByPlayer(sid){for(const c in rooms) if(rooms[c].players[sid]) return rooms[c]; return null;}

function advanceTournament(room,matchId,winnerId){
  const bracket=room.bracket;
  if(bracket.type==='double') return advanceDoubleElim(room,matchId,winnerId);

  let matchRound=-1,matchIdx=-1;
  bracket.rounds.forEach((round,ri)=>round.forEach((m,mi)=>{
    if(m.id===matchId){matchRound=ri;matchIdx=mi;}
  }));
  if(matchRound===-1) return;
  const match=bracket.rounds[matchRound][matchIdx];
  match.winner=winnerId;
  const winPlayer=match.p1?.id===winnerId?match.p1:match.p2;
  if(matchRound<bracket.rounds.length-1){
    const nextMatchIdx=Math.floor(matchIdx/2);
    const slot=matchIdx%2===0?'p1':'p2';
    bracket.rounds[matchRound+1][nextMatchIdx][slot]=winPlayer;
  }
  io.to(room.code).emit('bracketUpdate',{bracket:serializeBracket(bracket),matchId,winnerId});
  const roundDone=bracket.rounds[matchRound].every(m=>m.winner!==null);
  if(roundDone){
    if(matchRound===bracket.rounds.length-1){
      room.state='finished';
      const awards=computeAwards(room);
      io.to(room.code).emit('tournamentFinished',{winnerId,winnerName:winPlayer?.name,winnerColor:winPlayer?.color,awards});
      return;
    }
    setTimeout(()=>startNextMatch(room),3000);
  } else setTimeout(()=>startNextMatch(room),2500);
}

// ─── DOUBLE-ELIMINATION ADVANCEMENT ──────────────────────────────────────────
function findMatchAnywhere(bracket,matchId){
  for(let ri=0;ri<bracket.rounds.length;ri++){
    for(let mi=0;mi<bracket.rounds[ri].length;mi++){
      if(bracket.rounds[ri][mi].id===matchId) return {match:bracket.rounds[ri][mi],loc:{type:'winners',r:ri,m:mi}};
    }
  }
  for(let ri=0;ri<bracket.losersRounds.length;ri++){
    for(let mi=0;mi<bracket.losersRounds[ri].length;mi++){
      if(bracket.losersRounds[ri][mi].id===matchId) return {match:bracket.losersRounds[ri][mi],loc:{type:'losers',r:ri,m:mi}};
    }
  }
  if(bracket.grandFinal.id===matchId) return {match:bracket.grandFinal,loc:{type:'gf'}};
  if(bracket.grandFinalReset.id===matchId) return {match:bracket.grandFinalReset,loc:{type:'gfr'}};
  return null;
}

function advanceDoubleElim(room,matchId,winnerId){
  const bracket=room.bracket;
  const found=findMatchAnywhere(bracket,matchId);
  if(!found) return;
  const {match,loc}=found;
  match.winner=winnerId;
  const winPlayer=match.p1?.id===winnerId?match.p1:match.p2;
  const loserPlayer=match.p1?.id===winnerId?match.p2:match.p1;

  // ── WINNERS BRACKET MATCH ──
  if(loc.type==='winners'){
    const {r,m}=loc;
    // Special case: 2-player bracket — this single match IS the tournament
    if(bracket.slots===2){
      room.state='finished';
      const awards=computeAwards(room);
      io.to(room.code).emit('bracketUpdate',{bracket:serializeBracket(bracket),matchId,winnerId});
      io.to(room.code).emit('tournamentFinished',{winnerId,winnerName:winPlayer?.name,winnerColor:winPlayer?.color,awards});
      return;
    }
    // Advance winner within winners bracket
    if(r<bracket.rounds.length-1){
      const nextMatchIdx=Math.floor(m/2);
      const slot=m%2===0?'p1':'p2';
      bracket.rounds[r+1][nextMatchIdx][slot]=winPlayer;
    } else {
      // Winners bracket final -> grand final p1
      bracket.grandFinal.p1=winPlayer;
    }
    // Drop loser into losers bracket (if applicable and loser exists/not a bye)
    if(loserPlayer&&!match.bye){
      const drop=(bracket.dropMap||[]).find(d=>d.from===match.id);
      if(drop){
        const target=bracket.losersRounds[drop.to.r][drop.to.m];
        target[drop.to.slot]=loserPlayer;
      } else if(bracket.slots===2){
        // 2-player bracket: loser of the only match goes straight to... nothing (single match decides it)
      }
    }
  }
  // ── LOSERS BRACKET MATCH ──
  else if(loc.type==='losers'){
    const {r,m}=loc;
    // Loser is eliminated entirely (no event needed beyond bracket display)
    // Advance winner within losers bracket
    const adv=(bracket.losersAdvance||[]).find(a=>a.from===match.id);
    if(adv){
      bracket.losersRounds[adv.to.r][adv.to.m][adv.to.slot]=winPlayer;
    } else {
      // Last losers-bracket match -> grand final p2 (losers bracket champion)
      bracket.grandFinal.p2=winPlayer;
    }
  }
  // ── GRAND FINAL ──
  else if(loc.type==='gf'){
    // p1 = winners-bracket champ, p2 = losers-bracket champ
    const winnersChampWon=(match.p1?.id===winnerId);
    if(winnersChampWon){
      // Winners-bracket champion wins outright — tournament over
      room.state='finished';
      const awards=computeAwards(room);
      io.to(room.code).emit('bracketUpdate',{bracket:serializeBracket(bracket),matchId,winnerId});
      io.to(room.code).emit('tournamentFinished',{winnerId,winnerName:winPlayer?.name,winnerColor:winPlayer?.color,awards});
      return;
    } else {
      // Losers-bracket champion won — bracket reset! One more match, winner-takes-all
      bracket.grandFinalReset.active=true;
      bracket.grandFinalReset.p1=match.p1; // give both a fresh shot
      bracket.grandFinalReset.p2=match.p2;
      io.to(room.code).emit('bracketUpdate',{bracket:serializeBracket(bracket),matchId,winnerId});
      setTimeout(()=>startNextMatch(room),3000);
      return;
    }
  }
  // ── GRAND FINAL RESET ──
  else if(loc.type==='gfr'){
    room.state='finished';
    const awards=computeAwards(room);
    io.to(room.code).emit('bracketUpdate',{bracket:serializeBracket(bracket),matchId,winnerId});
    io.to(room.code).emit('tournamentFinished',{winnerId,winnerName:winPlayer?.name,winnerColor:winPlayer?.color,awards});
    return;
  }

  io.to(room.code).emit('bracketUpdate',{bracket:serializeBracket(bracket),matchId,winnerId});
  setTimeout(()=>startNextMatch(room),2500);
}

// ─── TOURNAMENT AWARDS ────────────────────────────────────────────────────────
function computeAwards(room){
  const stats=Object.values(room.tourneyStats||{}).filter(s=>!s.isBot);
  if(stats.length===0) return [];
  const awards=[];
  const top=(arr,key)=>arr.slice().sort((a,b)=>b[key]-a[key])[0];

  const mostHeadshots=top(stats,'headshots');
  if(mostHeadshots&&mostHeadshots.headshots>0) awards.push({title:'🎯 Most Headshots',name:mostHeadshots.name,color:mostHeadshots.color,value:`${mostHeadshots.headshots} headshots`});

  const mostAccurate=stats.filter(s=>s.arrowsFired>=3).slice().sort((a,b)=>(b.arrowsHit/b.arrowsFired)-(a.arrowsHit/a.arrowsFired))[0];
  if(mostAccurate) awards.push({title:'🏹 Most Accurate',name:mostAccurate.name,color:mostAccurate.color,value:`${Math.round((mostAccurate.arrowsHit/mostAccurate.arrowsFired)*100)}% accuracy`});

  const mostDamage=top(stats,'damageDealt');
  if(mostDamage&&mostDamage.damageDealt>0) awards.push({title:'💥 Most Damage Dealt',name:mostDamage.name,color:mostDamage.color,value:`${mostDamage.damageDealt} dmg`});

  const comeback=top(stats,'comebackWins');
  if(comeback&&comeback.comebackWins>0) awards.push({title:'🔥 Comeback King',name:comeback.name,color:comeback.color,value:`${comeback.comebackWins} clutch win${comeback.comebackWins>1?'s':''}`});

  const trigger=top(stats,'arrowsFired');
  if(trigger&&trigger.arrowsFired>0) awards.push({title:'⚡ Trigger Happy',name:trigger.name,color:trigger.color,value:`${trigger.arrowsFired} arrows fired`});

  return awards.slice(0,4); // cap at 4 awards
}

function startNextMatch(room){
  const bracket=room.bracket;
  // Winners bracket first
  for(let ri=0;ri<bracket.rounds.length;ri++){
    for(let mi=0;mi<bracket.rounds[ri].length;mi++){
      const m=bracket.rounds[ri][mi];
      if(!m.bye&&m.winner===null&&m.p1&&m.p2){startDuel(room,m);return;}
    }
  }
  if(bracket.type!=='double') return;
  // Losers bracket
  for(let ri=0;ri<(bracket.losersRounds||[]).length;ri++){
    for(let mi=0;mi<bracket.losersRounds[ri].length;mi++){
      const m=bracket.losersRounds[ri][mi];
      if(m.winner===null&&m.p1&&m.p2){startDuel(room,m);return;}
    }
  }
  // Grand final
  const gf=bracket.grandFinal;
  if(gf.winner===null&&gf.p1&&gf.p2){startDuel(room,gf);return;}
  // Grand final reset (only if active)
  const gfr=bracket.grandFinalReset;
  if(gfr.active&&gfr.winner===null&&gfr.p1&&gfr.p2){startDuel(room,gfr);return;}
}

function startDuel(room,match){
  room.state='dueling';
  const p1=match.p1,p2=match.p2;
  const duel=createDuel(p1,p2,room.code,match.id);
  if(p1.isBot) duel.archers[p1.id].isBot=true;
  if(p2.isBot) duel.archers[p2.id].isBot=true;
  room.activeDuel=duel;
  io.to(room.code).emit('duelStart',{
    matchId:match.id,
    p1:{id:p1.id,name:p1.name,color:p1.color},
    p2:{id:p2.id,name:p2.name,color:p2.color},
    maxHp:MAX_HP,
    wind:duel.wind,
    bracket:serializeBracket(room.bracket),
  });
  setTimeout(()=>{duel.gameLoop=setInterval(()=>tickDuel(duel,room),1000/30);},3500);
}

function serializeMatch(m){
  return {
    id:m.id,bye:m.bye,
    p1:m.p1?{id:m.p1.id,name:m.p1.name,color:m.p1.color}:null,
    p2:m.p2?{id:m.p2.id,name:m.p2.name,color:m.p2.color}:null,
    winner:m.winner,
  };
}
function serializeBracket(b){
  const out={type:b.type||'single',rounds:b.rounds.map(r=>r.map(serializeMatch))};
  if(b.type==='double'){
    out.losersRounds=(b.losersRounds||[]).map(r=>r.map(serializeMatch));
    out.grandFinal=serializeMatch(b.grandFinal);
    out.grandFinalReset={...serializeMatch(b.grandFinalReset),active:b.grandFinalReset.active};
  }
  return out;
}

// ─── ROOM / PLAYER ───────────────────────────────────────────────────────────
function createRoom(code){return{code,players:{},botPlayers:{},state:'lobby',bracket:null,activeDuel:null,allowBots:false,bracketType:'single'};}
function createPlayer(id,name,color,avatar){return{id,name,color,avatar:avatar||null,ready:false,isHost:false,isBot:false};}

function startTournament(room){
  room.state='tournament';
  room.tourneyStats={};
  if(room.bracketType==='double'){
    room.bracket=buildDoubleBracket(Object.values(room.players),room.allowBots);
  } else {
    room.bracket=buildBracket(Object.values(room.players),room.allowBots);
  }
  resolveByes(room);
  io.to(room.code).emit('tournamentStart',{bracket:serializeBracket(room.bracket)});
  setTimeout(()=>startNextMatch(room),2500);
}

function lobbyData(room){
  return {
    code:room.code,allowBots:room.allowBots,bracketType:room.bracketType||'single',
    players:Object.values(room.players).map(p=>({id:p.id,name:p.name,color:p.color,avatar:p.avatar||null,ready:p.ready,isHost:p.isHost})),
  };
}

// ─── LAN DISCOVERY HELPERS ───────────────────────────────────────────────────
function broadcastLanWaiters(){
  // Send current waiter list to all host sockets
  const list=Object.values(lanWaiters);
  for(const code of Object.keys(rooms)){
    const room=rooms[code];
    if(room.state!=='lobby') continue;
    const hostEntry=Object.values(room.players).find(p=>p.isHost);
    if(!hostEntry) continue;
    const hostSocket=io.sockets.sockets.get(hostEntry.id);
    if(hostSocket) hostSocket.emit('lanWaiters',{waiters:list});
  }
}

// ─── SOCKETS ─────────────────────────────────────────────────────────────────
io.on('connection',socket=>{
  socket.on('createRoom',({name,color,avatar})=>{
    const code=Math.random().toString(36).substring(2,7).toUpperCase();
    rooms[code]=createRoom(code);
    const p=createPlayer(socket.id,name||'Archer',color||COLORS[0],avatar);
    p.isHost=true;
    rooms[code].players[socket.id]=p;
    socket.join(code);
    delete lanWaiters[socket.id];
    socket.emit('roomCreated',{code,playerId:socket.id,color:p.color,lanUrl:`http://${LOCAL_IP}:${PORT}`});
    io.to(code).emit('lobbyUpdate',lobbyData(rooms[code]));
  });

  socket.on('joinRoom',({code,name,color,avatar})=>{
    code=(code||'').toUpperCase();
    const room=rooms[code];
    if(!room) return socket.emit('joinError','Room not found');
    if(room.state!=='lobby') return socket.emit('joinError','Tournament already started');
    if(Object.keys(room.players).length>=8) return socket.emit('joinError','Room full (8 max)');
    const idx=Object.keys(room.players).length;
    const p=createPlayer(socket.id,name||`Archer ${idx+1}`,color||COLORS[idx%COLORS.length],avatar);
    room.players[socket.id]=p;
    socket.join(code);
    delete lanWaiters[socket.id];
    socket.emit('roomJoined',{code,playerId:socket.id,color:p.color});
    io.to(code).emit('lobbyUpdate',lobbyData(room));
    broadcastLanWaiters();
  });

  socket.on('setAvatar',({avatar})=>{
    const room=getRoomByPlayer(socket.id);
    if(!room||room.state!=='lobby') return;
    const p=room.players[socket.id];
    if(!p||p.ready) return;
    p.avatar=avatar;
    io.to(room.code).emit('lobbyUpdate',lobbyData(room));
  });

  socket.on('setAllowBots',({allow})=>{
    const room=getRoomByPlayer(socket.id);
    if(!room||room.state!=='lobby'||!room.players[socket.id]?.isHost) return;
    room.allowBots=!!allow;
    io.to(room.code).emit('lobbyUpdate',lobbyData(room));
  });

  socket.on('setBracketType',({bracketType})=>{
    const room=getRoomByPlayer(socket.id);
    if(!room||room.state!=='lobby'||!room.players[socket.id]?.isHost) return;
    room.bracketType=bracketType==='double'?'double':'single';
    io.to(room.code).emit('lobbyUpdate',lobbyData(room));
  });

  socket.on('setReady',()=>{
    const room=getRoomByPlayer(socket.id);
    if(!room||room.state!=='lobby') return;
    const p=room.players[socket.id];
    if(p) p.ready=true;
    io.to(room.code).emit('lobbyUpdate',lobbyData(room));
    const all=Object.values(room.players);
    if(all.length>=2&&all.every(p=>p.ready)) startTournament(room);
  });

  socket.on('forceStart',()=>{
    const room=getRoomByPlayer(socket.id);
    if(!room||room.state!=='lobby'||!room.players[socket.id]?.isHost) return;
    if(Object.keys(room.players).length<2) return socket.emit('joinError','Need at least 2 players');
    startTournament(room);
  });

  socket.on('aim',({angle})=>{
    const room=getRoomByPlayer(socket.id);
    if(!room||!room.activeDuel) return;
    const a=room.activeDuel.archers[socket.id];
    if(a&&!a.dead&&!a.stunned) a.aimAngle=angle;
  });

  socket.on('shoot',({angle,power,arrowType})=>{
    const room=getRoomByPlayer(socket.id);
    if(!room||!room.activeDuel||room.activeDuel.state!=='playing') return;
    const duel=room.activeDuel;
    const archer=duel.archers[socket.id];
    if(!archer||!archer.alive||archer.dead||archer.stunned||archer.stamina<STAMINA_SHOOT_COST) return;
    archer.stamina-=STAMINA_SHOOT_COST;
    archer.chargePower=0;
    archer.lastArrowType=arrowType||'normal';
    const aType=arrowType||'normal';
    if(aType==='multi'){
      [-0.12,0,0.12].forEach(spread=>{
        duel.arrows.push(createArrow(archer,archer.aimAngle+spread,power*0.85,'multi',duel.wind));
      });
    } else {
      duel.arrows.push(createArrow(archer,archer.aimAngle,power,aType,duel.wind));
    }
  });

  socket.on('jump',()=>{
    const room=getRoomByPlayer(socket.id);
    if(!room||!room.activeDuel) return;
    const a=room.activeDuel.archers[socket.id];
    if(a&&a.alive&&!a.dead&&!a.stunned&&a.onGround){a.vy=-10;a.onGround=false;}
  });

  socket.on('dash',({dir})=>{
    const room=getRoomByPlayer(socket.id);
    if(!room||!room.activeDuel) return;
    const a=room.activeDuel.archers[socket.id];
    if(a&&a.alive&&!a.dead&&!a.stunned) startDash(a, dir<0?-1:1);
  });

  socket.on('shield',()=>{
    const room=getRoomByPlayer(socket.id);
    if(!room||!room.activeDuel) return;
    const a=room.activeDuel.archers[socket.id];
    if(a&&a.alive&&!a.dead&&!a.stunned) startShield(a);
  });

  socket.on('emote',({emoji})=>{
    const room=getRoomByPlayer(socket.id);
    if(!room) return;
    const p=room.players[socket.id];
    io.to(room.code).emit('emote',{playerId:socket.id,name:p?.name||'Player',emoji:String(emoji).slice(0,8)});
  });

  socket.on('charge',({power})=>{
    const room=getRoomByPlayer(socket.id);
    if(!room||!room.activeDuel) return;
    const a=room.activeDuel.archers[socket.id];
    if(a&&!a.dead) a.chargePower=power;
  });

  // ── LAN DISCOVERY ──────────────────────────────────────────────────────────
  // A visitor on the home screen announces themselves so hosts can see them
  socket.on('lanAnnounce',({name,color})=>{
    if(getRoomByPlayer(socket.id)) return;
    lanWaiters[socket.id]={socketId:socket.id,name:name||'Archer',color:color||COLORS[0]};
    // Notify all host sockets about updated LAN waiters
    broadcastLanWaiters();
  });

  // Host invites a LAN waiter into their room
  socket.on('inviteLanPlayer',({targetId})=>{
    const room=getRoomByPlayer(socket.id);
    if(!room||room.state!=='lobby'||!room.players[socket.id]?.isHost) return;
    const waiter=lanWaiters[targetId];
    if(!waiter) return;
    if(Object.keys(room.players).length>=8) return;
    const targetSocket=io.sockets.sockets.get(targetId);
    if(!targetSocket) { delete lanWaiters[targetId]; broadcastLanWaiters(); return; }
    // Auto-join them
    const idx=Object.keys(room.players).length;
    const p=createPlayer(targetId,waiter.name,waiter.color||COLORS[idx%COLORS.length],null);
    room.players[targetId]=p;
    targetSocket.join(room.code);
    delete lanWaiters[targetId];
    targetSocket.emit('roomJoined',{code:room.code,playerId:targetId,color:p.color});
    io.to(room.code).emit('lobbyUpdate',lobbyData(room));
    broadcastLanWaiters();
  });

  // Host dismisses a LAN waiter (they stay on home screen, just removed from host's panel)
  socket.on('dismissLanPlayer',({targetId})=>{
    const room=getRoomByPlayer(socket.id);
    if(!room||!room.players[socket.id]?.isHost) return;
    if(lanWaiters[targetId]){
      // Tell that player they were dismissed (so they stop showing up for this host)
      const targetSocket=io.sockets.sockets.get(targetId);
      if(targetSocket) targetSocket.emit('lanDismissed',{by:room.code});
    }
    delete lanWaiters[targetId];
    broadcastLanWaiters();
  });

  socket.on('disconnect',()=>{
    delete lanWaiters[socket.id];
    broadcastLanWaiters();
    const room=getRoomByPlayer(socket.id);
    if(!room) return;
    delete room.players[socket.id];
    if(Object.keys(room.players).filter(id=>!room.players[id]?.isBot).length===0){
      if(room.activeDuel) clearInterval(room.activeDuel.gameLoop);
      delete rooms[room.code];
    } else io.to(room.code).emit('lobbyUpdate',lobbyData(room));
  });
});

server.listen(PORT,()=>{
  console.log(`🏹 ARCHER TOURNEY → http://localhost:${PORT}`);
  console.log(`📡 LAN URL → http://${LOCAL_IP}:${PORT}`);
});

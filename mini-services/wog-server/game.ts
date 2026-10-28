// Wings of Glory — игровая логика мультиплеера (без привязки к HTTP-серверу).
// Хост создаёт socket.io Server и вызывает initGame(io): index.ts — отдельный bun-сервер,
// embed.ts — встраивание в Next.js (TatNet и другие платформы «один сервис: сайт+мультиплеер»).
import type { Server as IOServer, Socket } from 'socket.io';
import { Vector3, Quaternion } from 'three';
import {
  V3, clamp, rand, FWD, AX, AY, AZ, PLANES, rollBotTier, planeStatsHuman, planeStatsBot,
  terrainHeight, BOT_NAMES, ALLY_NAMES, PAY
} from './data';
import { register, login, byToken, shop, addReward, getProfile, Profile } from './db';

const TEAM_SIZE = 5;          // 5×5
const LIVES = 3;              // жизней у каждого (счёт команды = 5×3 = 15)
const SIM_DT = 1 / 30;        // тик симуляции
const SNAP_EVERY = 2;         // снапшот каждые 2 тика (15 Гц)

let io: IOServer; // присваивается в initGame()

// ================= СУЩНОСТИ =================
type Team = 'blue' | 'red';
interface Ent {
  id: string; kind: 'human' | 'bot'; team: Team; name: string; planeId: string;
  pst: any;
  pos: Vector3; quat: Quaternion; vel: Vector3; speed: number;
  hp: number; hpMax: number; alive: boolean; lives: number; kills: number;
  nick_l?: string; sock?: Socket; lastSeen?: number; dmgBudget?: number; pay?: { money: number; xp: number };
  burst?: number; gunT?: number; attackT?: number; threatT?: number; evadeDir?: Vector3;
  orbitA?: number; orbitDir?: number; mslAmmo?: number; mslCd?: number;
  flares?: number; flareCd?: number; cobraN?: number; cobraCd?: number;
  deathT?: number; tgtId?: string | null;
}
interface Mis { id: string; team: Team; sid: string; tid: string | null; pos: Vector3; dir: Vector3; speed: number; life: number }
interface Flare { id: string; pos: Vector3; vel: Vector3; life: number }

const ents: Ent[] = [];
const missiles: Mis[] = [];
const flareEnts: Flare[] = [];
let blueLives = 15, redLives = 15;
let roundOver = false, roundOverT = 0;
let mid = 0, fid = 0, eid = 0;

const byId = (id: string | null) => (id == null ? null : ents.find(e => e.id === id) || null);
const teamAnchor = (team: Team, out: Vector3) => {
  out.set(0, 600, 0);
  let n = 0;
  for (const e of ents) if (e.team === team && e.alive) { out.add(e.pos); n++; }
  if (n) out.multiplyScalar(1 / n);
  return out;
};
const BASE: Record<Team, Vector3> = { blue: V3(0, 0, -2400), red: V3(0, 0, 2400) };
function baseSpawn(e: Ent) {
  const b = BASE[e.team];
  e.pos.set(b.x + rand(-250, 250), 0, b.z + rand(-250, 250));
  e.pos.y = Math.max(terrainHeight(e.pos.x, e.pos.z), -2) + rand(550, 750);
  const yaw = e.team === 'blue' ? Math.PI : 0; // синие смотрят на красных и наоборот
  e.quat.setFromAxisAngle(AY, yaw);
  e.speed = e.pst.maxSpd * 0.75;
  e.vel.copy(FWD).applyQuaternion(e.quat).multiplyScalar(e.speed);
}
function respawnDto(e: Ent) {
  return { id: e.id, p: [e.pos.x, e.pos.y, e.pos.z], q: [e.quat.x, e.quat.y, e.quat.z, e.quat.w], spd: e.speed, hp: e.hp, lives: e.lives };
}

// ================= РАУНД =================
function maxHumanTier(): number {
  let T = 3;
  for (const e of ents) if (e.kind === 'human' && e.pst) T = Math.max(T, e.pst.tier);
  return T;
}
function pickBotPlane(tier: number) {
  const opts = PLANES.filter(p => p.tier === tier);
  return opts[Math.floor(Math.random() * opts.length)];
}
function botName(team: Team): string {
  const used = new Set(ents.filter(e => e.team === team).map(e => e.name));
  const pool = team === 'red' ? BOT_NAMES : ALLY_NAMES;
  for (const n of pool) if (!used.has(n)) return n;
  return (team === 'red' ? 'Штурмовик-' : 'Крыло-') + (++eid);
}
function makeBot(team: Team): Ent {
  const tier = rollBotTier(maxHumanTier());
  const pl = pickBotPlane(tier);
  const pst = planeStatsBot(pl);
  const e: Ent = {
    id: 'e' + (++eid), kind: 'bot', team, name: botName(team), planeId: pl.id, pst,
    pos: V3(), quat: new Quaternion(), vel: V3(), speed: 60,
    hp: pst.hp, hpMax: pst.hp, alive: true, lives: LIVES, kills: 0,
    burst: 0, gunT: 0, attackT: rand(0.5, 2.2), threatT: 0, evadeDir: V3(),
    orbitA: rand(0, Math.PI * 2), orbitDir: Math.random() < 0.5 ? -1 : 1,
    mslAmmo: pst.msl, mslCd: rand(5, 9), flares: pst.jet ? 3 : 0, flareCd: rand(1, 3),
    cobraN: pst.prem ? 2 : 0, cobraCd: 0, deathT: 0, tgtId: null
  };
  baseSpawn(e);
  return e;
}
function fillBots() {
  for (const team of ['blue', 'red'] as Team[]) {
    let n = ents.filter(e => e.team === team).length;
    while (n < TEAM_SIZE) { ents.push(makeBot(team)); n++; }
  }
}
// подбор по уровням: боты раскатываются по рангу старшего живого пилота.
// Нужен потому, что resetRound() при первом join-е катит ботов ДО добавления человека (maxHumanTier()=3),
// и Су-57 попадал в бой против бипланов. Только апгрейд: слабые ранги перекатываем вверх, сильных не понижаем.
function refreshBotTiers() {
  const T = maxHumanTier();
  if (T <= 3) return;
  let changed = false;
  for (const e of ents) {
    if (e.kind !== 'bot' || e.pst.tier >= T - 1) continue;
    const pl = pickBotPlane(rollBotTier(T));
    e.planeId = pl.id; e.pst = planeStatsBot(pl);
    e.hpMax = e.pst.hp; e.hp = e.pst.hp;
    e.mslAmmo = e.pst.msl; e.flares = e.pst.jet ? 3 : 0; e.cobraN = e.pst.prem ? 2 : 0;
    io.emit('respawn', respawnDto(e));
    changed = true;
  }
  if (changed) broadcastEnts();
}
function entDto(e: Ent) {
  return { id: e.id, kind: e.kind, team: e.team, name: e.name, planeId: e.planeId, alive: e.alive, hpMax: e.hpMax, lives: e.lives, kills: e.kills };
}
function broadcastEnts() {
  io.emit('ents', { bl: blueLives, rl: redLives, list: ents.map(entDto) });
}
function resetRound() {
  missiles.length = 0;
  flareEnts.length = 0;
  blueLives = 15; redLives = 15; roundOver = false; roundOverT = 0;
  for (let i = ents.length - 1; i >= 0; i--) if (ents[i].kind === 'bot') ents.splice(i, 1);
  fillBots();
  for (const e of ents) {
    e.lives = LIVES; e.alive = true; e.deathT = 0; e.kills = 0;
    e.hp = e.hpMax;
    if (e.kind === 'bot') {
      e.mslAmmo = e.pst.msl; e.flares = e.pst.jet ? 3 : 0; e.cobraN = e.pst.prem ? 2 : 0;
      e.burst = 0; e.threatT = 0; e.attackT = rand(0.5, 2.2);
    }
    baseSpawn(e);
    io.emit('respawn', respawnDto(e));
  }
  broadcastEnts();
  io.emit('round', { bl: blueLives, rl: redLives });
}
function checkRoundEnd() {
  if (roundOver) return;
  if (redLives <= 0 || blueLives <= 0) {
    roundOver = true; roundOverT = 8;
    const winner: Team = redLives <= 0 ? 'blue' : 'red';
    const board = ents.map(e => ({ id: e.id, name: e.name, team: e.team, kind: e.kind, kills: e.kills }))
      .sort((a, b) => b.kills - a.kills);
    for (const e of ents) {
      if (e.kind !== 'human' || !e.nick_l) continue;
      const pay = e.pay || { money: 0, xp: 0 };
      const win = e.team === winner;
      const m = pay.money + PAY.part[0] + (win ? PAY.win[0] : 0);
      const x = pay.xp + PAY.part[1] + (win ? PAY.win[1] : 0);
      addReward(e.nick_l, m, x, { kill: e.kills, win, round: true });
      e.pay = { money: 0, xp: 0 };
      if (e.sock) {
        const prof = getProfile(e.nick_l);
        e.sock.emit('roundEnd', { winner, board, pay: { money: m, xp: x }, profile: prof });
      }
    }
  }
}

// ================= УРОН / СМЕРТИ =================
function damageEnt(v: Ent, dmg: number, killer: Ent | null, at?: Vector3) {
  if (!v.alive || roundOver) return;
  v.hp -= dmg;
  if (v.hp <= 0) { killEnt(v, killer); return; }
  if (v.kind === 'human' && v.sock) {
    v.sock.emit('hit', { tid: v.id, hp: Math.max(0, v.hp), by: killer ? killer.name : '' });
  }
  io.emit('hitfx', { tid: v.id, x: at ? at.x : v.pos.x, y: at ? at.y : v.pos.y, z: at ? at.z : v.pos.z });
}
function killEnt(v: Ent, killer: Ent | null) {
  if (!v.alive) return;
  v.alive = false; v.hp = 0;
  if (v.team === 'red') redLives--; else blueLives--;
  if (killer && killer !== v) {
    killer.kills++;
    if (killer.kind === 'human' && killer.nick_l) {
      killer.pay = killer.pay || { money: 0, xp: 0 };
      killer.pay.money += PAY.kill[0]; killer.pay.xp += PAY.kill[1];
    }
    for (const h of ents) {
      if (h.kind !== 'human' || h === killer || h.team !== killer.team || !h.nick_l) continue;
      h.pay = h.pay || { money: 0, xp: 0 };
      h.pay.money += PAY.teamKill[0]; h.pay.xp += PAY.teamKill[1];
    }
  }
  io.emit('killed', {
    id: v.id, by: killer && killer !== v ? killer.id : null,
    byName: killer && killer !== v ? killer.name : '',
    lives: v.lives - 1, bl: blueLives, rl: redLives
  });
  v.lives--;
  if (v.lives > 0) v.deathT = 4.5 + rand(0, 3);
  if (v.kind === 'human' && v.nick_l) addReward(v.nick_l, 0, 0, { death: 1 });
  checkRoundEnd();
}

// ================= ПУЛИ (визуал) + попадания ботов =================
function emitBullet(sid: string, o: Vector3, d: Vector3, v: number, team: Team) {
  io.emit('b', { sid, o: [o.x, o.y, o.z], d: [d.x, d.y, d.z], v, team });
}
function botFire(e: Ent, T: Ent) {
  const o = V3(0, 0.4, -3).applyQuaternion(e.quat).add(e.pos);
  const d = e.pos.distanceTo(T.pos);
  const lead = V3().copy(T.pos).addScaledVector(T.vel, d / 430 * 0.85).sub(o).normalize();
  const dev = (e.team === 'red' ? rand(2, 3.5) : rand(3, 5)) * Math.PI / 180, az = rand(0, Math.PI * 2);
  const s1 = V3().copy(Math.abs(lead.y) > 0.9 ? AX : AY).cross(lead).normalize();
  const s2 = V3().copy(lead).cross(s1);
  const dir = V3().copy(lead).multiplyScalar(Math.cos(dev))
    .addScaledVector(s1, Math.cos(az) * Math.sin(dev))
    .addScaledVector(s2, Math.sin(az) * Math.sin(dev)).normalize();
  emitBullet(e.id, o, dir, 430, e.team);
  const p = clamp(3.5 / d * 20, 0.06, 0.5); // угловой размер цели против разброса
  if (Math.random() < p) damageEnt(T, e.pst.dmg * 0.62 * rand(0.85, 1.2), e, T.pos); // ×0.62 — компенсация ИИ
}

// ================= РАКЕТЫ / ЛОВУШКИ =================
function spawnMissile(sh: Ent, tid: string | null, dirIn?: Vector3, cid?: string) {
  const dir = dirIn ? V3().copy(dirIn).normalize() : V3().copy(FWD).applyQuaternion(sh.quat);
  const pos = V3().copy(sh.pos).addScaledVector(dir, 2.5).add(V3(rand(-1, 1), 0.3, rand(-1, 1)));
  const m: Mis = { id: 'm' + (++mid), team: sh.team, sid: sh.id, tid, pos, dir, speed: sh.speed + 35, life: 14 };
  missiles.push(m);
  io.emit('mslS', { id: m.id, cid: cid || null, sid: sh.id, tid, team: sh.team, pos: [pos.x, pos.y, pos.z], dir: [dir.x, dir.y, dir.z] });
  return m;
}
function ejectFlaresSrv(e: Ent) {
  const batch: Flare[] = [];
  for (let i = 0; i < 3; i++) {
    const v = V3(rand(-1, 1), rand(-0.7, 0.1), rand(-0.6, 0.6)).normalize().applyQuaternion(e.quat).multiplyScalar(rand(15, 24));
    v.addScaledVector(V3().copy(FWD).applyQuaternion(e.quat), -8);
    const f: Flare = { id: 'f' + (++fid), pos: V3().copy(e.pos), vel: v, life: 3 };
    flareEnts.push(f); batch.push(f);
  }
  io.emit('flare', { id: e.id });
  return batch;
}
function retargetToFlares(e: Ent, batch: Flare[], chance: number): boolean {
  let saved = false;
  for (const m of missiles) {
    if (m.tid !== e.id) continue;
    const d2 = m.pos.distanceToSquared(e.pos);
    if (d2 > 14400 && d2 < 360000 && batch.length && Math.random() < chance) {
      m.tid = batch[(Math.random() * batch.length) | 0].id; saved = true;
    }
  }
  return saved;
}
function missileBoom(m: Mis, direct: Ent | null) {
  io.emit('mslB', { id: m.id, x: m.pos.x, y: m.pos.y, z: m.pos.z });
  const shooter = byId(m.sid);
  for (const v of ents) {
    if (!v.alive || v.team === m.team) continue;
    const d = m.pos.distanceTo(v.pos);
    if (v.kind === 'bot') {
      if (d < 50) damageEnt(v, direct === v ? 60 : 50 * (1 - d / 50), shooter, v.pos);
    } else {
      if (d < 45) damageEnt(v, 37 * (1 - d / 45), shooter, v.pos); // людям — щадящий урон (как ИИ в клиенте)
    }
  }
}
function updateMissiles(dt: number) {
  for (let i = missiles.length - 1; i >= 0; i--) {
    const m = missiles[i];
    m.life -= dt;
    const red = m.team === 'red';
    let tgt: Ent | null = null, flareT: Flare | null = null;
    if (m.tid) {
      if (m.tid[0] === 'f') {
        flareT = flareEnts.find(x => x.id === m.tid) || null;
        if (!flareT) m.tid = null;
      } else {
        tgt = byId(m.tid);
        if (tgt && !tgt.alive) { m.tid = null; tgt = null; }
      }
    }
    if (tgt) {
      const lead = V3().copy(tgt.pos).addScaledVector(tgt.vel || V3(), 0.25).sub(m.pos).normalize();
      m.dir.lerp(lead, Math.min(1, (red ? 2.6 : 3.4) * dt)).normalize();
    } else if (flareT) {
      const lead = V3().copy(flareT.pos).sub(m.pos).normalize();
      m.dir.lerp(lead, Math.min(1, (red ? 2.6 : 3.4) * dt)).normalize();
    }
    m.speed = Math.min(m.speed + (red ? 170 : 240) * dt, red ? 300 : 380);
    m.pos.addScaledVector(m.dir, m.speed * dt);
    let boom = false, direct: Ent | null = null;
    if (flareT && m.pos.distanceToSquared(flareT.pos) < 100) boom = true; // подрыв на ловушке
    if (!boom) {
      for (const v of ents) {
        if (!v.alive || v.team === m.team) continue;
        if (m.pos.distanceToSquared(v.pos) < 110) { boom = true; direct = v; if (v.id === m.tid) break; }
      }
    }
    if (!boom && m.pos.y < Math.max(terrainHeight(m.pos.x, m.pos.z), -2) + 1) boom = true;
    if (m.life <= 0) boom = true;
    if (boom) { missiles.splice(i, 1); missileBoom(m, direct); }
  }
  for (let i = flareEnts.length - 1; i >= 0; i--) {
    const f = flareEnts[i];
    f.life -= dt;
    f.vel.y -= 15 * dt; f.vel.multiplyScalar(1 - Math.min(1, 1.5 * dt));
    f.pos.addScaledVector(f.vel, dt);
    if (f.life <= 0 || f.pos.y < Math.max(terrainHeight(f.pos.x, f.pos.z), -2) + 0.5) flareEnts.splice(i, 1);
  }
}

// ================= ИИ БОТОВ (порт updateBots клиента) =================
const _v1 = V3(), _v2 = V3(), _v3 = V3(), _tgt = V3(), _v5 = V3(), _q1 = new Quaternion();
const _bf1 = V3(), _bf2 = V3(), _anchor = V3();
function steerToward(b: Ent, target: Vector3, dt: number) {
  _v1.copy(target).sub(b.pos).normalize().applyQuaternion(_q1.copy(b.quat).invert());
  const yawErr = Math.atan2(-_v1.x, -_v1.z);
  const pitchErr = Math.asin(clamp(_v1.y, -1, 1));
  const upW = _v2.set(0, 1, 0).applyQuaternion(_q1);
  const bank = Math.asin(clamp(-upW.x, -1, 1));
  const want = clamp(-yawErr * 1.35, -1.05, 1.05);
  const roll = clamp((want - bank) * 2.4, -1, 1);
  const bt = b.pst ? b.pst.turn : 1;
  b.quat.multiply(_q1.setFromAxisAngle(AX, clamp(pitchErr, -1, 1) * 1.5 * bt * dt));
  b.quat.multiply(_q1.setFromAxisAngle(AY, clamp(yawErr, -1, 1) * 0.85 * bt * dt));
  b.quat.multiply(_q1.setFromAxisAngle(AZ, -roll * 2.4 * bt * dt));
  b.quat.normalize();
}
function botFront(b: Ent, T: Ent): boolean {
  _bf1.copy(T.pos).sub(b.pos).normalize();
  return _bf1.dot(_bf2.copy(FWD).applyQuaternion(b.quat)) > 0.25;
}
function updateBot(b: Ent, dt: number) {
  let T: Ent | null = null;
  if (b.team === 'red') {
    let bd = 1e9;
    for (const e of ents) {
      if (!e.alive || e.team !== 'blue') continue;
      const d2 = b.pos.distanceTo(e.pos);
      if (d2 < bd) { T = e; bd = d2; }
    }
  } else {
    teamAnchor('blue', _anchor);
    let best = 1e9;
    for (const e of ents) {
      if (!e.alive || e.team !== 'red') continue;
      const dp = e.pos.distanceTo(_anchor), ds = b.pos.distanceTo(e.pos);
      const sc = dp * 0.65 + ds * 0.35;
      if (dp < 4200 && ds < 4200 && sc < best) { best = sc; T = e; }
    }
  }
  b.tgtId = T ? T.id : null;
  const distT = T ? b.pos.distanceTo(T.pos) : 1e9;
  const engage = !!T && distT < 5200;
  const target = _tgt;
  const agl = b.pos.y - Math.max(terrainHeight(b.pos.x, b.pos.z), -2);
  if (agl < 110) {
    target.copy(b.pos).addScaledVector(_v5.copy(FWD).applyQuaternion(b.quat), 350);
    target.y = b.pos.y + 420;
  } else if (engage && T && botFront(b, T)) {
    target.copy(T.pos).addScaledVector(T.vel, distT / 430 * 0.8);
  } else if (b.threatT! > 0) {
    target.copy(b.pos).addScaledVector(b.evadeDir!, 600);
  } else {
    teamAnchor(b.team === 'red' ? 'blue' : 'red', _anchor);
    b.orbitA! += dt * 0.22 * b.orbitDir!;
    target.copy(_anchor).add(_v5.set(Math.cos(b.orbitA!) * 4300, 160 + Math.sin(b.orbitA! * 0.7) * 120, Math.sin(b.orbitA!) * 4300));
  }
  if (engage && T && !botFront(b, T) && distT < 380 && b.threatT! <= 0) {
    b.threatT = rand(2.2, 4);
    b.evadeDir!.set(rand(-1, 1), rand(-0.35, 0.55), rand(-1, 1)).normalize();
    b.evadeDir!.addScaledVector(_v3.copy(T.pos).sub(b.pos).normalize(), -1.2).normalize();
  }
  if (b.threatT! > 0) b.threatT! -= dt;
  if (b.pos.y > 3800) target.y = Math.min(target.y, b.pos.y - 400);
  steerToward(b, target, dt);
  const tSpd = engage ? (b.team === 'red' ? b.pst.maxSpd * 0.95 : b.pst.maxSpd * 0.9) : b.pst.maxSpd * 0.75;
  b.speed += (tSpd - b.speed) * (1 - Math.exp(-dt * 0.5));
  _v5.copy(FWD).applyQuaternion(b.quat);
  b.pos.addScaledVector(_v5, b.speed * dt);
  b.vel.copy(_v5).multiplyScalar(b.speed);
  const fireR = b.team === 'red' ? 950 : 820;
  if (engage && T && distT < fireR) {
    b.attackT! -= dt;
    if (b.attackT! <= 0) {
      _v5.copy(FWD).applyQuaternion(b.quat);
      _v3.copy(T.pos).sub(b.pos).normalize();
      if (_v5.dot(_v3) > 0.955) { b.burst = b.team === 'red' ? 8 : 6; b.gunT = 0; }
      b.attackT = b.team === 'red' ? rand(0.9, 2.1) : rand(1.1, 2.6);
    }
  }
  if (b.burst! > 0 && T && T.alive) {
    b.gunT! -= dt;
    if (b.gunT! <= 0) { botFire(b, T); b.burst!--; b.gunT = 0.105; }
  }
  if (b.pst.msl > 0 && b.mslAmmo! > 0 && T && T.alive) {
    b.mslCd! -= dt;
    if (b.mslCd! <= 0 && distT > 450 && distT < 1800) {
      _v5.copy(FWD).applyQuaternion(b.quat);
      _v3.copy(T.pos).sub(b.pos).normalize();
      const ally = b.team === 'blue';
      if (_v5.dot(_v3) > (ally ? 0.94 : 0.93)) {
        spawnMissile(b, T.id);
        b.mslAmmo!--;
        b.mslCd = ally ? rand(11, 16) : rand(9, 14);
      }
    }
  }
  if (b.flares! > 0) {
    b.flareCd! -= dt;
    if (b.flareCd! <= 0) {
      for (const m of missiles) {
        if (m.tid === b.id) {
          const md2 = m.pos.distanceToSquared(b.pos);
          if (md2 > 19600 && md2 < 360000) {
            const batch = ejectFlaresSrv(b);
            retargetToFlares(b, batch, 0.55);
            b.flares!--; b.flareCd = rand(1.4, 2.4);
            break;
          }
        }
      }
    }
  }
  if (b.cobraCd! > 0) b.cobraCd! -= dt;
  if (b.pst.prem && b.cobraN! > 0 && b.cobraCd! <= 0) {
    for (const m of missiles) {
      if (m.tid !== b.id || m.team !== 'blue') continue;
      const md2 = m.pos.distanceToSquared(b.pos);
      if (md2 > 32400 && md2 < 270400) {
        if (Math.random() < 0.55) {
          m.tid = null; m.dir.y -= 0.22; m.dir.normalize(); m.life = Math.min(m.life, 3.2);
          b.cobraN!--; b.cobraCd = 12;
          io.emit('msg', { text: 'Цель ушла в кобру — ракета потеряна', team: 'blue' });
        } else b.cobraCd = rand(1.2, 2);
        break;
      }
    }
  }
  if (T && T.alive && b.pos.distanceTo(T.pos) < 9) {
    if (T.kind === 'human') damageEnt(T, 45, null, T.pos);
    else { T.hp -= 45; if (T.hp <= 0) killEnt(T, null); }
    killEnt(b, null);
    return;
  }
  if (b.pos.y < Math.max(terrainHeight(b.pos.x, b.pos.z), -2) + 2.2) killEnt(b, null);
}

// ================= ТИК СИМУЛЯЦИИ =================
let tickN = 0;
function tick() {
  const dt = SIM_DT;
  tickN++;
  for (const e of ents) {
    if (!e.alive && e.lives > 0 && e.deathT > 0) {
      e.deathT -= dt;
      if (e.deathT <= 0) {
        e.alive = true; e.hp = e.hpMax;
        if (e.kind === 'bot') { e.mslAmmo = e.pst.msl; e.flares = e.pst.jet ? 3 : 0; e.cobraN = e.pst.prem ? 2 : 0; e.burst = 0; e.threatT = 0; }
        baseSpawn(e);
        io.emit('respawn', respawnDto(e));
      }
    }
  }
  if (!roundOver) {
    for (const e of ents) if (e.kind === 'bot' && e.alive) updateBot(e, dt);
    for (const e of ents) {
      if (e.kind !== 'human' || !e.alive) continue;
      if (e.pos.y < Math.max(terrainHeight(e.pos.x, e.pos.z), -2) + 2) killEnt(e, null);
    }
  }
  updateMissiles(dt);
  checkRoundEnd();
  if (roundOver) {
    roundOverT -= dt;
    if (roundOverT <= 0) resetRound();
  }
  if (tickN % SNAP_EVERY === 0) {
    const eArr: any[] = [];
    for (const e of ents) {
      eArr.push([
        e.id,
        +e.pos.x.toFixed(1), +e.pos.y.toFixed(1), +e.pos.z.toFixed(1),
        +e.quat.x.toFixed(3), +e.quat.y.toFixed(3), +e.quat.z.toFixed(3), +e.quat.w.toFixed(3),
        Math.round(e.speed), e.alive ? 1 : 0, e.alive ? +(e.hp / e.hpMax).toFixed(2) : 0,
        e.kills
      ]);
    }
    const mArr: any[] = [];
    for (const m of missiles) {
      mArr.push([m.id, +m.pos.x.toFixed(1), +m.pos.y.toFixed(1), +m.pos.z.toFixed(1),
        +m.dir.x.toFixed(3), +m.dir.y.toFixed(3), +m.dir.z.toFixed(3), m.tid]);
    }
    io.emit('snap', { e: eArr, m: mArr, bl: blueLives, rl: redLives });
  }
}

// ================= SOCKET.IO =================
function nickOf(sock: Socket): string | null {
  const t = (sock.data as any).token;
  const p = t ? byToken(t) : null;
  return p ? p.nick.toLowerCase() : null;
}
function onConn(sock: Socket) {
  sock.on('auth:register', (b: any, cb?: (r: any) => void) => {
    const r = register(b && b.nick, b && b.pass);
    if (r.ok && r.token) (sock.data as any).token = r.token;
    if (cb) cb(r);
  });
  sock.on('auth:login', (b: any, cb?: (r: any) => void) => {
    const r = login(b && b.nick, b && b.pass);
    if (r.ok && r.token) (sock.data as any).token = r.token;
    if (cb) cb(r);
  });
  sock.on('auth:token', (b: any, cb?: (r: any) => void) => {
    const p = byToken(b && b.token);
    if (p) { (sock.data as any).token = b.token; if (cb) cb({ ok: true, profile: p }); }
    else if (cb) cb({ ok: false });
  });
  sock.on('shop', (b: any, cb?: (r: any) => void) => {
    const t = (sock.data as any).token;
    const p = t ? byToken(t) : null;
    if (!p) return cb ? cb({ ok: false, err: 'Нужно войти в профиль' }) : undefined;
    const nick_l = nickOf(sock)!;
    const r = shop(p, nick_l, b);
    if (cb) cb(r);
  });
  sock.on('lobby', (_b: any, cb?: (r: any) => void) => {
    if (cb) cb({ online: io.engine.clientsCount, room: ents.filter(e => e.kind === 'human').length });
  });

  sock.on('join', (_b: any, cb?: (r: any) => void) => {
    const p = byToken((sock.data as any).token);
    if (!p) return cb ? cb({ ok: false, err: 'Нужно войти в профиль' }) : undefined;
    if ((sock.data as any).entId) return cb ? cb({ ok: false, err: 'Вы уже в небе' }) : undefined;
    // первый живой пилот в комнате — свежий бой: боты воевали без людей, и счёт мог уползти (напр. 7:8)
    if (!ents.some(e => e.kind === 'human')) resetRound();
    const humansBlue = ents.filter(e => e.kind === 'human' && e.team === 'blue').length;
    const humansRed = ents.filter(e => e.kind === 'human' && e.team === 'red').length;
    if (humansBlue + humansRed >= 10) return cb ? cb({ ok: false, err: 'Небо заполнено: 10/10 пилотов' }) : undefined;
    const team: Team = humansBlue < humansRed ? 'blue' : humansRed < humansBlue ? 'red' : (Math.random() < 0.5 ? 'blue' : 'red');
    const pl = PLANES.find(x => x.id === p.sel) || PLANES[0];
    const pst = planeStatsHuman(pl, p.upg[p.sel] || { eng: 0, dur: 0, hdl: 0, gun: 0 });
    // освободить место: убрать одного бота этой команды (его остаток жизней уходит из счёта — иначе синие/красные получают лишние жизни: было 18 vs 15)
    const bot = ents.find(e => e.kind === 'bot' && e.team === team);
    if (bot) {
      if (!roundOver && bot.alive) { if (team === 'blue') blueLives = Math.max(0, blueLives - bot.lives); else redLives = Math.max(0, redLives - bot.lives); }
      ents.splice(ents.indexOf(bot), 1);
    }
    const ent: Ent = {
      id: 'e' + (++eid), kind: 'human', team, name: p.nick, planeId: pl.id, pst,
      pos: V3(), quat: new Quaternion(), vel: V3(), speed: pst.maxSpd * 0.65,
      hp: pst.hp, hpMax: pst.hp, alive: true, lives: LIVES, kills: 0,
      nick_l: p.nick.toLowerCase(), sock, lastSeen: Date.now(), dmgBudget: pst.dmg * 22, pay: { money: 0, xp: 0 }, deathT: 0, tgtId: null
    };
    baseSpawn(ent);
    ents.push(ent);
    fillBots();
    refreshBotTiers(); // прилетевший на технике выше ботов — поднять ботов под его ранг (подбор по уровням)
    (sock.data as any).entId = ent.id;
    if (!roundOver) { if (team === 'blue') blueLives += LIVES; else redLives += LIVES; }
    const msls = missiles.map(m => ({ id: m.id, sid: m.sid, tid: m.tid, team: m.team, pos: [m.pos.x, m.pos.y, m.pos.z], dir: [m.dir.x, m.dir.y, m.dir.z] }));
    if (cb) cb({
      ok: true,
      you: { id: ent.id, team, pos: [ent.pos.x, ent.pos.y, ent.pos.z], q: [ent.quat.x, ent.quat.y, ent.quat.z, ent.quat.w], lives: LIVES },
      bl: blueLives, rl: redLives, msls, list: ents.map(entDto)
    });
    broadcastEnts();
    lobbyInfo();
    io.emit('msg', { text: p.nick + ' в небе — команда ' + (team === 'blue' ? 'синих' : 'красных') });
  });

  sock.on('s', (b: any) => {
    const e = byId((sock.data as any).entId);
    if (!e || !e.alive || !b) return;
    const p = b.p, q = b.q, v = b.v;
    if (!Array.isArray(p) || !Array.isArray(q) || !Array.isArray(v)) return;
    if ([...p, ...q, ...v, b.spd].some((n: any) => typeof n !== 'number' || !isFinite(n))) return;
    e.pos.set(p[0], p[1], p[2]);
    e.quat.set(q[0], q[1], q[2], q[3]).normalize();
    e.vel.set(v[0], v[1], v[2]);
    e.speed = clamp(b.spd || 0, 0, 400);
    e.lastSeen = Date.now();
    if (e.dmgBudget !== undefined) e.dmgBudget = Math.min(e.pst.dmg * 22, e.dmgBudget + e.pst.dmg * 22 * SIM_DT);
  });
  sock.on('claim', (b: any) => {
    const sh = byId((sock.data as any).entId);
    if (!sh || !sh.alive || !b || typeof b.tid !== 'string') return;
    const v = byId(b.tid);
    if (!v || !v.alive || v.team === sh.team) return;
    if (sh.pos.distanceTo(v.pos) > 1500) return;
    const dmg = Math.min(Number(b.dmg) || 0, sh.pst.dmg * 1.6);
    if (sh.dmgBudget === undefined) return;
    const use = Math.min(dmg, sh.dmgBudget);
    sh.dmgBudget -= use;
    if (use > 0) damageEnt(v, use * rand(0.9, 1.1), sh, b.x !== undefined ? V3(b.x, b.y, b.z) : v.pos);
  });
  sock.on('msl', (b: any) => {
    const e = byId((sock.data as any).entId);
    if (!e || !e.alive) return;
    let tid: string | null = null;
    if (b && typeof b.tid === 'string') {
      const t = byId(b.tid);
      if (t && t.alive && t.team !== e.team) tid = b.tid;
    }
    spawnMissile(e, tid, b && Array.isArray(b.dir) ? V3(b.dir[0], b.dir[1], b.dir[2]) : undefined, b && b.cid);
  });
  sock.on('flare', () => {
    const e = byId((sock.data as any).entId);
    if (!e || !e.alive) return;
    const batch = ejectFlaresSrv(e);
    retargetToFlares(e, batch, 0.8); // шанс игрока — как deployFlares в клиенте
  });
  sock.on('cobra', () => {
    const e = byId((sock.data as any).entId);
    if (!e || !e.alive) return;
    let broke = 0;
    for (const m of missiles) {
      if (m.tid !== e.id || m.team === e.team) continue;
      const d2 = m.pos.distanceToSquared(e.pos);
      if (d2 > 25600 && d2 < 313600) { // окно 160–560 м
        m.tid = null; m.dir.y -= 0.22; m.dir.normalize(); m.life = Math.min(m.life, 3.2); broke++;
      }
    }
    if (broke) io.emit('msg', { text: 'Цель ушла в кобру — ракета потеряна', team: e.team === 'blue' ? 'red' : 'blue' });
  });
  sock.on('leave', () => leaveRoom(sock));
  sock.on('disconnect', () => leaveRoom(sock));
}

function leaveRoom(sock: Socket) {
  const id = (sock.data as any).entId;
  if (!id) return;
  (sock.data as any).entId = null;
  const i = ents.findIndex(e => e.id === id);
  if (i < 0) return;
  const e = ents[i];
  if (e.kind === 'human' && e.nick_l && e.pay && (e.pay.money || e.pay.xp)) {
    addReward(e.nick_l, e.pay.money, e.pay.xp, { kill: e.kills });
    e.kills = 0;
    if (e.sock) e.sock.emit('profile', { profile: getProfile(e.nick_l) });
  }
  const team = e.team, wasAlive = e.alive;
  ents.splice(i, 1);
  if (wasAlive && !roundOver) { if (team === 'blue') blueLives = Math.max(0, blueLives - e.lives); else redLives = Math.max(0, redLives - e.lives); }
  const hadB = ents.filter(x => x.team === 'blue').length, hadR = ents.filter(x => x.team === 'red').length;
  fillBots();
  // добор-боты привносят свои жизни в пул (симметрично замене бота игроком при join): уход игрока не истощает команду
  if (!roundOver) {
    const addB = ents.filter(x => x.team === 'blue').length - hadB;
    const addR = ents.filter(x => x.team === 'red').length - hadR;
    if (addB > 0) blueLives += LIVES * addB;
    if (addR > 0) redLives += LIVES * addR;
  }
  broadcastEnts();
  lobbyInfo();
  io.emit('msg', { text: e.name + ' покинул бой' });
  checkRoundEnd();
}
function lobbyInfo() {
  io.emit('lobby', { online: io.engine.clientsCount, room: ents.filter(e => e.kind === 'human').length });
}

// ================= ЗАПУСК: io создаёт хост (index.ts — bun-стендалоун, embed.ts — внутри Next) =================
export function initGame(ioI: IOServer) {
  io = ioI;
  io.on('connection', onConn);
  setInterval(tick, 33);
  resetRound(); // небо готово сразу при старте: боты обеих команд на местах — иначе первый join не находит бота для замены и получает 18/15 вместо 15/15
}

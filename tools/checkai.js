#!/usr/bin/env node
'use strict';
// Exercise the shipped WASM, bridge, road geometry and vehicle solver without rendering.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.resolve(__dirname, '..');
if (process.argv.includes('--suite')) {
  const {spawnSync} = require('child_process');
  for (const mode of ['driver','free','boss','tactics']) {
    const env = {...process.env, AI_MODE:mode, AI_SECONDS:'1200', AI_HZ:'60', AI_GAP:'0',
      AI_LEVEL:mode==='boss'?'7':'', AI_DIFFICULTY:mode==='boss'?'IMPOSSIBLE':'',
      AI_REPORT:`target/ai-${mode}.json`};
    const run = spawnSync(process.execPath,[__filename],{cwd:root,env,stdio:'inherit'});
    if (run.status !== 0) process.exit(run.status || 1);
  }
  process.exit(0);
}
const context = vm.createContext({ console, WebAssembly, TextDecoder, TextEncoder,
  fetch: async () => new Response(fs.readFileSync(path.join(root, 'web/wasm/synx_core.wasm')),
    {headers: {'Content-Type': 'application/wasm'}}),
});
context.window = context;
context.document = {body:null};
vm.runInContext(fs.readFileSync(path.join(root, 'web/js/wasm.js'), 'utf8'), context);
for (const name of ['gl','settings','game','chapters']) {
  vm.runInContext(fs.readFileSync(path.join(root, 'web/js/'+name+'.js'), 'utf8'), context);
}
const regions = [[60,13000], [13000,32000], [32000,54000], [54000,79900],
  [79900,111500], [112080,131300], [132070,173000]];
async function main() {
  const NR = await context.NR.loadCore();
  const scene = JSON.parse(fs.readFileSync(path.join(root, 'web/data/scene.json')));
  const track = new NR.Track(NR.buildCourse(scene.centre));
  const car = new NR.Vehicle(track);
  const driver = new NR.Driver(track, 'HARD');
  if (process.env.AI_MODE === 'tactics') {
    const assert = require('assert/strict');
    const traffic = new NR.Vehicle(track);
    const dt = 1/60;
    track.setWidth(NR.DRIVE_HALF,NR.ROAD_HALF);
    // An actual slower vehicle, including pair collisions: a pass must succeed
    // without hitting it or either barrier. No teleported ghost in this test.
    driver.setLevel('IMPOSSIBLE'); driver.reset(); car.reset(400,0); traffic.reset(455,0);
    let contacts = 0, walls = 0;
    for (let f=0;f<45*60;f++) {
      traffic.update(dt,{throttle:Math.max(0,Math.min(1,(45-traffic.vLong)*.4)),brake:traffic.vLong>47?.2:0},true);
      const cmd = driver.drive(dt,car,{raceOn:true,rivalS:traffic.sTrack,rivalX:traffic.x,rivalZ:traffic.z});
      car.update(dt,cmd,true);
      if (NR.collideCars(car,traffic)>0) contacts++;
      if (car.lastHit && car.lastHitType==='wall') walls++;
      car.lastHit=false;
    }
    assert(car.sTrack>traffic.sTrack+20,'did not complete an overtake');
    assert.equal(contacts,0,'made contact while overtaking');
    assert.equal(walls,0,'hit a wall while overtaking');

    // The same frame after a restart must not remember a previous passing lane.
    driver.boostHold=20; driver.laneHint=()=>14;
    driver.reset(); car.reset(400,0);
    const fresh = new NR.Driver(track,'IMPOSSIBLE');
    const world={raceOn:true};
    assert.deepEqual(driver.drive(dt,car,world),fresh.drive(dt,car,world));
    assert.equal(driver.laneHint,null);

    // Hard obstacle guidance overrides a pass and reaches the requested corridor.
    driver.reset(); car.reset(400,0); driver.laneHint=()=>13.2;
    for(let f=0;f<10*60;f++) {
      const p=track.at(car.sTrack+25);
      car.update(dt,driver.drive(dt,car,{raceOn:true,rivalS:car.sTrack+25,rivalX:p.x,rivalZ:p.z}),true);
    }
    assert(Math.abs(car.lateral-13.2)<1.5,'passing offset corrupted the obstacle lane');
    assert(!car.offroad,'obstacle guidance left the road');

    for (const side of [-1,1]) {
      driver.reset(); car.reset(800,side*15); car.minS=400;
      car.yaw+=side*1.3;
      for(let f=0;f<25*60;f++) car.update(dt,driver.drive(dt,car,{raceOn:true}),true);
      assert(car.sTrack>900 && car.vLong>20,'failed to recover from a wall-facing stop');
    }

    // The boss does not lift when the player boosts or the lead changes hands.
    const hunt=NR.chapter7HuntPace;
    for(const gap of [-500,-41,-39,-2,0,2,40,500]) {
      const o={confidence:1,playerV:100};
      assert(hunt(gap,{...o,playerBoosting:true}).wantV>=hunt(gap,o).wantV);
    }
    assert.equal(hunt(-41,{confidence:1,playerV:120}).wantV,hunt(-39,{confidence:1,playerV:120}).wantV);
    console.log('AI tactics passed: physical overtake, reset, obstacle corridor, wall recovery, boss pace continuity.');
    return;
  }
  const results = [];
  const selected = process.env.AI_LEVEL ? [Number(process.env.AI_LEVEL) - 1] : regions.map((_,i)=>i);
  const difficulties = process.env.AI_DIFFICULTY ? [process.env.AI_DIFFICULTY] : ['EASY','MEDIUM','HARD','IMPOSSIBLE'];
  for (const region of selected) for (const difficulty of difficulties) {
    const [start, finish] = regions[region];
    track.setWidth(region === 6 ? 30 : NR.DRIVE_HALF, region === 6 ? 32 : NR.ROAD_HALF);
    driver.setLevel(difficulty); driver.reset();
    driver.personality = difficulty === 'IMPOSSIBLE' ? 'predator' : ['ryker','kael','nova','ryker','ryker','nova','predator'][region];
    car.reset(start, 5.5);
    const mode = process.env.AI_MODE || 'driver';
    // Campaign rivals retain the stock engine; the free-roam entry equips both
    // cars with the Forge engine. Its hard speed cap matters to this test.
    if (mode === 'free') car.fitEngine('swap');
    const game = Object.create(NR.Game.prototype);
    Object.assign(game,{driver,rival:car,car:{sTrack:start,vLong:90,boosting:false},diffIndex:difficulties.indexOf(difficulty),
      hud:{toast(){}},audio:{boostHit(){}},freeRoamMode:{active:false}});
    game.diffIndex = ['EASY','MEDIUM','HARD','IMPOSSIBLE'].indexOf(difficulty);
    const boss = Object.create(NR.PredatorDirector.prototype);
    Object.assign(boss,{g:game,ui:{},rivalry:1,modeActive:false,lastDt:1/60,trapRun:false,toast(){},audio(){},say(){}});
    if (mode === 'boss') {
      boss.baseCfg=NR.AI_LEVELS.IMPOSSIBLE; boss.baseSkill=boss.baseCfg.skill;
      boss.cfg={...boss.baseCfg}; driver.cfg=boss.cfg;
    }
    let frames = 0, wallFrames = 0, offroadFrames = 0, maxSlip = 0, minSpeed = Infinity, firstWall = null;
    const dt = 1 / Number(process.env.AI_HZ || 60);
    const seconds = Number(process.env.AI_SECONDS || 1200);
    for (; frames * dt < seconds && car.sTrack < finish; frames++) {
      // The player repeatedly crosses the lead, but on a separate lane: proximity
      // must not switch off race pace or trigger a cross-track oscillation.
      const gap = Number(process.env.AI_GAP || 0) + 32 * Math.sin(frames * dt * .4);
      game.car.sTrack = car.sTrack + gap;
      if (mode === 'free') game.updateFreeRoamRival(dt);
      if (mode === 'boss') {
        boss.lastDt = dt;
        boss.rivalry=.5+.5*Math.sin(frames*dt*.1);
        boss.modeActive=frames*dt%100>70;
        boss.trapRun=game.car.sTrack<159840;
        game.car.boosting=frames*dt%30<8;
        game.car.vLong=boss.modeActive?120:game.car.boosting?105:85;
        boss.applyModel();
      }
      const p = track.at(car.sTrack + gap);
      const cmd = driver.drive(dt, car, {raceOn:true, rivalS:car.sTrack + gap,
        rivalX:p.x - Math.cos(p.yaw)*6, rivalZ:p.z + Math.sin(p.yaw)*6, finishAt:finish});
      car.update(dt, cmd, true);
      if (car.lastHitType === 'wall' && car.lastHit || car.scrape > .1) {
        wallFrames++;
        if (!firstWall) firstWall = {s:Math.round(car.sTrack),speed:+car.vLong.toFixed(1),target:+driver.lastTarget.toFixed(1),lane:+car.lateral.toFixed(1),steer:+cmd.steer.toFixed(2)};
      }
      if (car.offroad) offroadFrames++;
      maxSlip = Math.max(maxSlip, Math.abs(car.bodySlip));
      if (frames*dt > 10) minSpeed = Math.min(minSpeed, car.vLong);
      car.lastHit = false;
      if (![car.x,car.z,car.vLong,cmd.steer,driver.lastTarget].every(Number.isFinite)) throw Error('Non-finite simulation');
    }
    const row = {level:region+1,difficulty,mode,hz:1/dt,gapBase:Number(process.env.AI_GAP||0),seconds:+(frames*dt).toFixed(1),
      completed:car.sTrack>=finish,distance:Math.round(car.sTrack-start),pace:+((car.sTrack-start)/(frames*dt)).toFixed(2),
      wallPercent:+(100*wallFrames/frames).toFixed(3),offroadFrames,maxSlip:+maxSlip.toFixed(3),minSpeed:+minSpeed.toFixed(1),firstWall};
    results.push(row); console.log(JSON.stringify(row));
  }
  if (process.env.AI_REPORT) fs.writeFileSync(path.resolve(root,process.env.AI_REPORT),JSON.stringify(results,null,2)+'\n');
  if (!process.argv.includes('--baseline') && results.some(r=>r.firstWall || r.offroadFrames || r.pace < 45
      || (Number(process.env.AI_SECONDS || 1200)>=1200 && !r.completed))) process.exitCode=1;
}
main().catch(e=>{console.error(e);process.exitCode=1;});

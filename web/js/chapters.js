/* SYNX — the chapter directors.
 *
 * Chapters 5, 6 and 7 each layer a set piece over the running game. They are
 * directors, not engines: the Vehicle, the rival Driver, the camera, the
 * renderer and the race result stay authoritative throughout, and every one of
 * these files works by altering the ordinary inputs to them - an arc gate that
 * swaps the steering bus, a lane hint the AI has to thread, a palette that
 * bleeds in over a kilometre.
 *
 *   05  ASHFALL ZERO    three interactive cinematics: the collapse run, the
 *                       volcano gauntlet, and the redline finale that destroys
 *                       Ryker's car and reveals the AURORA R-IX RAPTOR
 *   06  AURORA FORGE    six factory trials, each teaching the same lesson from
 *                       a different angle - Aurora's line controller is a
 *                       MODEL, and a driver it can predict is one it can
 *                       process - ending in the engine swap and raceMode
 *   07  NEON HORIZON    a fifty-kilometre megacity finale: nine districts,
 *                       structural glass, three deterministic set pieces, and
 *                       the R-IX prediction model the whole campaign is about
 *
 * WHY THEY ARE THREE CLOSURES IN ONE FILE
 * ---------------------------------------
 * They used to be js/level5.js, js/level6.js and js/level7.js. Merging them
 * into one file is a loading win - three script tags become one - but they
 * cannot simply be concatenated: all three declare `GP`, `clamp`, `smooth`,
 * `makeCube` and `makeRing`, and two of them declare `EVENTS`, with different
 * values. Those are not accidents to be resolved, they are each chapter's own
 * local vocabulary for its own set piece.
 *
 * So each director keeps the closure it already had. That is what makes this a
 * merge rather than a rewrite: the three bodies below are byte-for-byte what
 * they were, and none of them can reach into another's names.
 *
 * All three attach themselves to NR and check for an existing copy first, so
 * loading this twice is harmless.
 */


/* ==========================================================================
 * CHAPTER 5 — ASHFALL ZERO
 * ========================================================================== */
/* SYNX Level 5 — ASHFALL ZERO interactive cinematic director
 *
 * Only Level 5 is touched. SYNX still owns the vehicle model, rival AI, race
 * flow and renderer. This file takes over for three deliberately rare set
 * pieces:
 *
 *   1)  6 s COLLAPSE RUN — mash Q fast enough to clear a falling tower.
 *   2) 20 s VOLCANO RUN  — a falling W/A/S/D sequence drives cinematic dodges
 *                          while the volcano throws fireballs at the road.
 *   3) 40 s REDLINE FINALE — the last 250 metres preserve the real race gap,
 *                            let Ryker steal the result, destroy his old car,
 *                            and reveal the AURORA R-IX RAPTOR.
 *
 * During the first two scenes the cars are advanced along the real SYNX track
 * every frame. The camera never leaves the race behind to admire an empty road.
 */
(function (global) {
  'use strict';

  const NR = global.NR;
  if (!NR || !NR.Game || NR.Level5Director) return;

  const { M, M4 } = NR;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const mix = (a, b, t) => a + (b - a) * t;
  const smooth = t => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
  const ease = t => 0.5 - 0.5 * Math.cos(clamp(t, 0, 1) * Math.PI);

  const EVENTS = {
    collapse: {
      trigger: 0.39,
      duration: 6.0,
      targetTaps: 50,
      successDuration: 3.0,
      failureDuration: 2.6,
      title: 'RUN THE COLLAPSE',
    },
    volcano: {
      trigger: 0.68,
      duration: 20.0,
      cueStart: 2.25,
      cueGap: 1.38,
      cueWindow: 1.02,
      cueCount: 10,
      title: 'ERUPTION GAUNTLET',
    },
    finish: {
      duration: 40.0,
      triggerMeters: 250,
      metresPerTrackUnit: .733,
      title: 'HUNT//REDLINE',
    },
  };

  const VOLCANO_ACTION = {
    w: 'W // BOOST PAST THE IMPACT',
    a: 'A // CUT LEFT',
    s: 'S // BRAKE UNDER THE FIREBALL',
    d: 'D // SNAP RIGHT',
  };

  const paletteMix = (a, b, t) => {
    const p = {};
    const arrays = ['edge','cap','post','sign','ground','grid','arch','tower','fogTint','sun','volcano','lava'];
    const nums = ['sky','ambient','fogRange','wet'];
    for (const k of arrays) {
      if (a && b && a[k] && b[k]) p[k] = [
        mix(a[k][0], b[k][0], t), mix(a[k][1], b[k][1], t), mix(a[k][2], b[k][2], t),
      ];
    }
    for (const k of nums) if (a && b && a[k] !== undefined && b[k] !== undefined) p[k] = mix(a[k], b[k], t);
    return p;
  };

  function routePalette(level, progress, forceDay) {
    if (!level) return null;
    if (forceDay && level.paletteDay) return paletteMix(level.paletteDay, level.paletteDay, 0);
    if (!level.paletteDawn || !level.paletteDay) return level.palette;
    // Keep the first half recognisably Midnight City; the broken city warms as
    // dawn arrives. The volcano event hard-switches to the procedural day sky.
    if (progress <= .22) return paletteMix(level.palette, level.palette, 0);
    if (progress < .52) return paletteMix(level.palette, level.paletteDawn, smooth((progress - .22) / .30));
    if (progress < EVENTS.volcano.trigger) return paletteMix(level.paletteDawn, level.paletteDay, smooth((progress - .52) / (EVENTS.volcano.trigger - .52)) * .72);
    return paletteMix(level.paletteDay, level.paletteDay, 0);
  }

  function seededSequence(n) {
    const keys = ['w', 'a', 's', 'd'];
    const out = [];
    let last = '';
    for (let i = 0; i < n; i++) {
      // Use Math.random for the actual run, but avoid ugly AAAA / WWW chains.
      let k = keys[(Math.random() * keys.length) | 0];
      if (k === last) k = keys[(keys.indexOf(k) + 1 + ((Math.random() * 3) | 0)) % 4];
      out.push(k); last = k;
    }
    return out;
  }

  function makeCube(gl, w, h, d) {
    // 24 vertices, four per face: position.xyz normal.xyz uv.xy.
    const x = w * .5, y = h * .5, z = d * .5;
    const V = [];
    const face = (n, a, b, c, e) => {
      const pts = [a, b, c, e], uvs = [[0,0],[1,0],[1,1],[0,1]];
      for (let i = 0; i < 4; i++) V.push(pts[i][0], pts[i][1], pts[i][2], n[0], n[1], n[2], uvs[i][0], uvs[i][1]);
    };
    face([ 1,0,0], [ x,-y,-z], [ x,-y, z], [ x, y, z], [ x, y,-z]);
    face([-1,0,0], [-x,-y, z], [-x,-y,-z], [-x, y,-z], [-x, y, z]);
    face([0, 1,0], [-x, y,-z], [ x, y,-z], [ x, y, z], [-x, y, z]);
    face([0,-1,0], [-x,-y, z], [ x,-y, z], [ x,-y,-z], [-x,-y,-z]);
    face([0,0, 1], [ x,-y, z], [-x,-y, z], [-x, y, z], [ x, y, z]);
    face([0,0,-1], [-x,-y,-z], [ x,-y,-z], [ x, y,-z], [-x, y,-z]);
    const I = [];
    for (let f = 0; f < 6; f++) { const o = f * 4; I.push(o,o+1,o+2, o,o+2,o+3); }
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const vb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vb);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(V), gl.STATIC_DRAW);
    const ib = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint32Array(I), gl.STATIC_DRAW);
    const stride = 8 * 4;
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, stride, 12);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 2, gl.FLOAT, false, stride, 24);
    gl.bindVertexArray(null);
    return { vao, vb, ib, count: I.length };
  }

  function makeRing(gl, outer, inner, depth, segments) {
    const V = [], I = [], n = segments || 32, hz = depth * .5;
    const vertex = (x,y,z,nx,ny,nz,u,v) => V.push(x,y,z,nx,ny,nz,u,v);
    for (let i=0;i<n;i++) {
      const a=i/n*Math.PI*2, c=Math.cos(a), s=Math.sin(a);
      vertex(c*outer,s*outer, hz,0,0, 1,i/n,1);
      vertex(c*inner,s*inner, hz,0,0, 1,i/n,0);
      vertex(c*outer,s*outer,-hz,0,0,-1,i/n,1);
      vertex(c*inner,s*inner,-hz,0,0,-1,i/n,0);
    }
    const at=(i,j)=>(i%n)*4+j;
    for(let i=0;i<n;i++){
      const j=i+1;
      I.push(at(i,0),at(i,1),at(j,1), at(i,0),at(j,1),at(j,0));
      I.push(at(i,2),at(j,3),at(i,3), at(i,2),at(j,2),at(j,3));
      I.push(at(i,0),at(j,0),at(j,2), at(i,0),at(j,2),at(i,2));
      I.push(at(i,1),at(i,3),at(j,3), at(i,1),at(j,3),at(j,1));
    }
    const vao=gl.createVertexArray();gl.bindVertexArray(vao);
    const vb=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,vb);
    gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(V),gl.STATIC_DRAW);
    const ib=gl.createBuffer();gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,ib);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,new Uint32Array(I),gl.STATIC_DRAW);
    const stride=8*4;
    gl.enableVertexAttribArray(0);gl.vertexAttribPointer(0,3,gl.FLOAT,false,stride,0);
    gl.enableVertexAttribArray(1);gl.vertexAttribPointer(1,3,gl.FLOAT,false,stride,12);
    gl.enableVertexAttribArray(2);gl.vertexAttribPointer(2,2,gl.FLOAT,false,stride,24);
    gl.bindVertexArray(null);
    return {vao,vb,ib,count:I.length};
  }

  /* One part of the R-IX's own hardware.
   *
   * `opts` is what the first version of this did not have, and its absence is
   * most of why the prototype looked cheaper than the car it is built on:
   * every one of these was `tex: null, nrm: null`, which is a flat colour with
   * a specular lobe on it, standing next to a shell whose every panel carries
   * a normal map. A surface with no map has no scale, and a surface with no
   * scale reads as plastic however glossy it is made.
   *
   * `reflect` is stated for the same reason it is stated on the shell: this is
   * the car the finale is about, what is reflected in it is the point, and
   * deriving that from three other numbers means a tweak to any of them
   * quietly changes it. */
  function partFor(mesh, name, color, emis, gain, opts) {
    const o = opts || {};
    return {
      mesh: { iOff: 0, vCount: 24, name },
      sub: { start: 0, count: mesh.count },
      mode: 0,
      mat: {
        name, tex: o.tex || null, nrm: o.nrm || null,
        color: [color[0], color[1], color[2], 1],
        tint: [0.5,0.5,0.5,0.5], emis: emis || [0,0,0], gain: gain || 0,
        cutoff: .25, tiling: o.tiling || [1,1], offset: [0,0],
        _smooth: .16, _metal: .03,
        _nrmTile: o.nrmTile || null,
        _reflect: o.reflect === undefined ? undefined : o.reflect,
      },
      _mesh: mesh,
    };
  }

  function scaledTrs(out, x,y,z, yaw,pitch,roll, sx,sy,sz) {
    M4.trs(out,x,y,z,yaw||0,pitch||0,roll||0);
    for(let i=0;i<4;i++)out[i]*=sx;
    for(let i=4;i<8;i++)out[i]*=sy;
    for(let i=8;i<12;i++)out[i]*=sz;
    return out;
  }


  class RaptorKit {
    constructor(game) {
      this.g=game;this.scene=game.scene;this.gl=game.gl;
      const gl=this.gl;
      this.unit=makeCube(gl,1,1,1);
      this.ringHousing=makeRing(gl,.76,.65,.34,40);
      this.ring=makeRing(gl,.69,.61,.28,40);
      this.ringCore=makeRing(gl,.35,.27,.32,32);
      this.local=M4.make();this.world=M4.make();this.base=M4.make();

      /* THE PAINT.
         Two coats, the way a real one is: a deep pearl base that is almost
         black until something is reflected in it, and a clearcoat lobe over
         the top that does not take the base colour. That second lobe is the
         difference between "dark car" and "expensive dark car" - it is what
         puts the sky, the neon and the horizon band on the shoulder line, and
         the renderer already has it. */
      this.clinePart=partFor(this.unit,'RaptorCLine',[.09,.010,.006],[.72,.062,.022],.55,{reflect:.55});
      this.clinePart.mat._smooth=.90;this.clinePart.mat._metal=.55;
      /* Body-coloured trim for the aero furniture that is painted rather than
         exposed weave - the mirror stalks, the wing stays. Matched to the
         livery's paint in js/scene.js so a stay looks bolted to the car. */
      this.bodyTrim=partFor(this.unit,'RaptorPaintTrim',[.030,.033,.042],[.055,.014,.004],.09,
        {nrm:'raptor_flake_NRM.png',nrmTile:[22,22],reflect:.92});
      this.bodyTrim.mat._smooth=.978;this.bodyTrim.mat._metal=.90;this.bodyTrim.mat._cc=1;
      this.chrome=partFor(this.unit,'RaptorChrome',[.10,.11,.13],[.006,.008,.012],0,{reflect:.97});
      this.chrome.mat._smooth=.97;this.chrome.mat._metal=1;this.chrome.mat._cc=.6;
      /* THE AERO IS EXPOSED WEAVE, and it now looks like it: the same twill
         albedo and relief the trim on the shell carries, tiled to the size of
         the part rather than of the car, so a dive plane and a diffuser fin
         are visibly cut from the same cloth. */
      this.carbon=partFor(this.unit,'RaptorAeroCarbon',[.70,.72,.80],[.002,.002,.003],0,
        {tex:'raptor_carbon.png',nrm:'raptor_carbon_NRM.png',tiling:[4,4],nrmTile:[4,4],reflect:.58});
      this.carbon.mat._smooth=.70;this.carbon.mat._metal=.38;this.carbon.mat._cc=.55;
      this.red=partFor(this.unit,'RaptorVectorVent',[.055,.002,.002],[.56,.006,.003],.95);
      this.red.mat._smooth=.84;this.red.mat._metal=.32;
      this.white=partFor(this.unit,'RaptorPredatorOptic',[.20,.05,.02],[1.00,.30,.12],.85);
      this.white.mat._smooth=.90;this.white.mat._metal=.28;
      this.ringPart=partFor(this.ring,'RaptorMomentumRing',[0,0,0],[.40,.001,0],.32,{reflect:.80});
      this.ringPart.mat._smooth=.9;this.ringPart.mat._metal=.75;
      this.corePart=partFor(this.ringCore,'RaptorTurbineCore',[0,0,0],[.68,.003,0],.46);
      this.corePart.mat._smooth=.88;this.corePart.mat._metal=.68;
      this.housingPart=partFor(this.ringHousing,'RaptorTurbineHousing',[.006,.007,.010],[.002,.001,.001],0,{reflect:.42});
      this.housingPart.mat._smooth=.42;this.housingPart.mat._metal=.90;this.housingPart.mat._cc=.10;
      this.parts=this.buildBaseSkin();
    }

    /* THE SHELL IS THE GAME'S SHELL.
       It used to be everything except the wheels, hand-lofted beside the car
       the rest of the game is made of - and that is exactly why it never
       looked like it belonged: different section language, different paint
       response, a canopy that read as a lid because it was one. The renderer
       already re-skins the one car mesh for the rival; the R-IX takes a third
       livery off the same shell (js/scene.js, buildRaptorCar) and keeps its
       identity in the aero, the optics and the rings that are built here. */
    buildBaseSkin() {
      const sc=this.scene;
      return {opaque:sc.raptorOpaque||sc.carOpaque, blend:sc.raptorBlend||sc.carBlend};
    }

    drawSpec(spec, part, parent) {
      const gl=this.gl;
      scaledTrs(this.local,spec[0],spec[1],spec[2],spec[3]||0,spec[4]||0,spec[5]||0,
        spec[6]||1,spec[7]||1,spec[8]||1);
      M4.mul(this.world,parent,this.local);
      gl.bindVertexArray(part._mesh.vao);
      this.scene.drawPart(part,this.world);
    }

    draw(model, charge, opts) {
      const gl=this.gl,sc=this.scene,q=clamp(charge||0,0,1);
      /* The shell takes panel damage like any other body. The kit's own aero
         does not - a wing that dents is a wing that has been in a crash that
         would have taken it off - so setDamage is armed only around the
         shell's own parts and cleared before the hand-built work. */
      const dmg=opts&&opts.damage;
      /* THE PROTOTYPE'S LAMPS READ THE PROTOTYPE'S PEDAL.
         The kit draws the shell's own blend parts through `sc.drawPart`
         directly rather than through `drawCar`, so nothing was ever setting
         `brakeLight` for it - the R-IX's tail bar was lit by whatever the
         PLAYER's brakes happened to be doing. */
      const ownBrake=sc.brakeLight;
      if(opts&&opts.brake!==undefined)sc.brakeLight=opts.brake;
      /* No global squash. The body is authored at its own size around the
         donor axles, so scaling the whole car here would only move the wheels
         out of the arches it was drawn to fit. */
      M4.copy(this.base,model);
      const f=sc.fillDir||[0,1,0],c=sc.fillCol||[.62,.72,1];
      const U=NR.gl.U;
      U.v3(gl,sc.prog.u.uFillDir,f[0],f[1],f[2]);
      /* A colder, harder key than the street cars get. The R-IX is lit like a
         product shot rather than like traffic. */
      U.v3(gl,sc.prog.u.uFillCol,c[0]*.46+.030,c[1]*.44+.036,c[2]*.48+.052);
      U.f(gl,sc.prog.u.uFillOn,(sc.fillOn===undefined?1:sc.fillOn)*.92);
      gl.enable(gl.DEPTH_TEST);gl.depthMask(true);gl.disable(gl.BLEND);

      /* --- the shell ---------------------------------------------------
         The game's car, in the R-IX's livery. Everything below this is what
         makes it the R-IX rather than a repaint. */
      gl.bindVertexArray(sc.vao);
      if(dmg&&sc.setDamage)sc.setDamage(dmg,this.base);
      for(const p of this.parts.opaque){M4.mul(this.world,this.base,p.m);sc.drawPart(p,this.world);}
      if(dmg&&sc.clearDamage)sc.clearDamage();

      /* Aero, and only where a car has any. Front dive planes, a splitter
         blade, side skirt fences, the swan-neck wing and the diffuser fins:
         all of them tapered plates that sit ON a surface rather than boxes
         floating beside one. Measured against the shell - grille at z 3.26,
         axles at +/-1.85, tail at -2.63 - not against the loft they were
         first drawn for. */
      const carbon=[
        [ 0.00,-0.72, 3.30, 0, .06, 0, 1.42, .045, .46],          // splitter
        [-1.02,-0.46, 2.92, 0,-.16,-.10, .40, .032, .34],         // dive plane
        [ 1.02,-0.46, 2.92, 0,-.16, .10, .40, .032, .34],
        [-1.20,-0.66,-0.05, 0, .04,-.06, .09, .10, 1.70],         // side skirt
        [ 1.20,-0.66,-0.05, 0, .04, .06, .09, .10, 1.70],
        /* THE DIFFUSER, PULLED IN UNDER THE CAR.
           It used to reach z -3.14 against a tail at -2.63 - half a unit of
           unsupported plate hanging in the air behind the bumper, which from
           behind reads as a second wing rather than as the floor of the car.
           A diffuser works because it is the underside; this one now ends
           where the bodywork does. */
        [ 0.00,-0.60,-2.42, 0,-.22, 0, 1.24, .055, .30],          // diffuser ramp
      ];
      for(const s of carbon)this.drawSpec(s,this.carbon,this.base);
      /* THE FINS, MOVED OUT OF THE EXHAUST.
         A 0.317 nozzle at x 0.56 covers 0.24 to 0.88, and the fins were at
         0.24 and 0.72 - the outer one entirely inside the nozzle and the inner
         one clipping its edge. Four fins in the two channels the nozzles leave
         either side of them, which is where a diffuser's strakes belong
         anyway: between the outlets, not through them. */
      for(const x of[-1.08,-0.17,0.17,1.08])
        this.drawSpec([x,-0.62,-2.42,0,-.22,0,.040,.17,.30],this.carbon,this.base);

      /* ------------------------------------------- THE REAR WING ----
       *
       * A BI-PLANE, AND ON PURPOSE. There was one plane with a chrome bar
       * buried inside it - 0.28 of chrome hidden inside a 0.42 chord, doing
       * nothing at all - and a gap under it big enough that the diffuser
       * behind read as its lower element. If the eye is going to read two
       * wings there, it can read two wings that are actually there: a main
       * plane and a real lower element with a slot between them, which is what
       * a car with this much rear downforce would carry.
       *
       * Both elements share the endplates, so it is one wing rather than two
       * stacked ones, and both are pulled forward to end level with the tail.
       */
      const rise=0.06+smooth(q)*0.20, aoa=-0.10-smooth(q)*0.16;
      // the swan-necks, over the top of the main plane the way the name means
      for(const x of[-0.80,0.80])
        this.drawSpec([x,0.14+rise*.5,-2.30,0,.34,0,.065,.42,.18],this.bodyTrim,this.base);
      // the main plane
      this.drawSpec([0,0.38+rise,-2.38,0,aoa,0,1.30,.045,.38],this.carbon,this.base);
      // ...and the lower element, in its own slot under the leading edge
      this.drawSpec([0,0.20+rise,-2.22,0,aoa-0.06,0,1.16,.032,.22],this.carbon,this.base);
      this.drawSpec([0,0.20+rise,-1.99,0,aoa-0.06,0,1.12,.020,.045],this.chrome,this.base);
      /* Endplates spanning BOTH elements, which is what ties the two into one
         wing. Tall enough to close the slot at its ends - an open-ended slot
         is a hole, and a hole is what was being seen. */
      for(const x of[-1.31,1.31])
        this.drawSpec([x,0.30+rise,-2.32,0,aoa,0,.030,.30,.40],this.carbon,this.base);
      // a gurney on the trailing edge, because this car is not subtle
      this.drawSpec([0,0.44+rise,-2.74,0,aoa,0,1.28,.055,.020],this.chrome,this.base);
      /* ------------------------------------------ MORE CAR ----
       *
       * FENDER LOUVRES, over the front arch. Air that gets into a wheel
       * arch has to leave it somewhere, and on a car with this much front
       * downforce it leaves through the top - which is why every serious
       * one has slats there. Four per side, stepped back and down along
       * the shoulder, sitting just outside the sill line at 1.29 so they
       * lie ON the flank rather than in it.
       */
      for(const sgn of[-1,1])for(let i=0;i<4;i++){
        this.drawSpec([sgn*1.305,-0.03-i*0.055,1.62-i*0.14,0,0.22,sgn*0.10,
          .018,.055,.30],this.carbon,this.base);
      }
      /* A SECOND CANARD outboard of the dive plane, smaller and lower, so
         the nose has a stack rather than a single blade. */
      for(const sgn of[-1,1])
        this.drawSpec([sgn*1.24,-0.60,2.78,0,-.20,sgn*.14,.26,.026,.24],
          this.carbon,this.base);
      /* WAKE VANES at the rear corners, standing in the air the back tyres
         throw. They are the last thing on the car and they are what makes
         the back of it read as WIDE from a chase camera - the wing is high
         and the diffuser is low, and there was nothing at all between them
         at the corners. */
      for(const sgn of[-1,1])
        this.drawSpec([sgn*1.22,-0.30,-2.18,0,0,sgn*.06,.022,.26,.42],
          this.carbon,this.base);
      /* ...and a blade along the top of each sill, which is the line a
         chase camera sees most of and the one the shell has nothing on. */
      for(const sgn of[-1,1])
        this.drawSpec([sgn*1.265,-0.40,-0.05,0,0,sgn*.10,.030,.045,1.44],
          this.carbon,this.base);

      // and the nose intake, recessed under the light bar
      this.drawSpec([0,-0.52,3.18,0,-.10,0,1.02,.16,.24],this.carbon,this.base);
      for(const x of[-0.86,0.86])
        this.drawSpec([x,-0.44,3.02,0,-.06,x>0?.16:-.16,.26,.18,.28],this.carbon,this.base);
      /* Mirrors on a stalk off the door skin, at the shell's own shoulder
         width rather than hanging in the air beside it. */
      for(const sgn of[-1,1]){
        this.drawSpec([sgn*1.12,-0.03,0.74,0,0,sgn*.10,.16,.045,.055],this.bodyTrim,this.base);
        this.drawSpec([sgn*1.30,0.01,0.74,0,0,sgn*.18,.22,.080,.095],this.chrome,this.base);
      }

      // --- the shell's own glass and lamps -----------------------------
      gl.bindVertexArray(sc.vao);
      gl.enable(gl.BLEND);gl.depthMask(false);
      if(dmg&&sc.setDamage)sc.setDamage(dmg,this.base);
      for(const p of this.parts.blend){
        if(p.mode===2||p.mode===7)gl.blendFunc(gl.SRC_ALPHA,gl.ONE);
        else gl.blendFunc(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA);
        M4.mul(this.world,this.base,p.m);sc.drawPart(p,this.world);
      }
      if(dmg&&sc.clearDamage)sc.clearDamage();

      // --- the lit work that is the R-IX's own -------------------------
      /* The shell brings its own headlights, tail bar and lit trim, so what
         is left to build is the thing the shell has no idea about: the
         momentum drive. Everything else that used to be here - a red slab
         down each flank, diagonal charge strips across the doors, a second
         set of headlights over the first - was trim drawn on top of trim,
         and it is what made the car read as decorated rather than designed. */
      gl.blendFunc(gl.SRC_ALPHA,gl.ONE);
      this.red.mat.gain=.24+q*.50;
      this.clinePart.mat.gain=.26+q*.40;
      this.ringPart.mat.gain=.07+q*.18;this.corePart.mat.gain=.08+q*.18;
      // one charge line, along the sill, where a skirt meets the body
      for(const sgn of[-1,1])
        this.drawSpec([sgn*1.215,-0.58,-0.05,0,0,sgn*.04,.022,.030,1.62],
          this.clinePart,this.base);
      /* ------------------------------------- THE DRIVE, IN THE TAIL ----
       *
       * TWO NOZZLES SET INTO THE CAR, not two rings behind it.
       *
       * They used to be a ring and a hot core at the same station, z -2.78,
       * with the shell's tail at -2.63: the whole assembly stood a fifth of a
       * unit clear of the bodywork with nothing joining it on, and it swallowed
       * the diffuser fins on the way past. `ringHousing` - the outer shroud
       * that makes an exhaust look like a hole in something rather than a ring
       * stuck on it - was built in the constructor and never drawn once.
       *
       * Three concentric parts at three depths now, so the eye reads INTO it:
       * the shroud stands proud of the tail, the ring is inside that, and the
       * core burns at the bottom of the bore. Raised out of the diffuser floor
       * so the strakes pass underneath rather than through.
       */
      for(const x of [-.62,.62]){
        this.drawSpec([x,-.13,-2.60,0,0,0,.50,.50,.34],this.housingPart,this.base);
        this.drawSpec([x,-.13,-2.52,0,0,0,.46,.46,.30],this.ringPart,this.base);
        this.drawSpec([x,-.13,-2.44,0,0,0,.46,.46,.26],this.corePart,this.base);
      }
      gl.depthMask(true);gl.disable(gl.BLEND);gl.bindVertexArray(sc.vao);
      sc.brakeLight=ownBrake;
      U.f(gl,sc.prog.u.uFillOn,0);
    }
  }

  /* The R-IX body kit, for tools/check.py car. Every piece of it is one
     drawSpec call, so a harness that records those instead of drawing them has
     the whole kit as boxes and can ask what passes through what - which is how
     the turbine outlets were found sitting inside the diffuser fins. */
  global.__SYNX_RAPTOR_KIT__ = RaptorKit;

  class DynamicSetpieceWorld {
    constructor(game) {
      this.g = game;
      this.scene = game.scene;
      this.gl = game.gl;
      this.visible = false;
      this.tower = null;
      this.debris = [];
      this.towerMesh = makeCube(this.gl, 18, 56, 16);
      this.seamMesh = makeCube(this.gl, 1.1, 40, 16.4);
      this.debrisMesh = makeCube(this.gl, 2.6, 1.1, 3.8);
      this.platformMesh = makeCube(this.gl, 1, 1, 1);
      this.towerPart = partFor(this.towerMesh, 'L5CollapseTower', [.055,.060,.070], [.025,.012,.008], 0);
      this.seamPart = partFor(this.seamMesh, 'L5RuptureSeam', [.18,.04,.012], [1.0,.19,.02], 1.35);
      this.debrisPart = partFor(this.debrisMesh, 'L5CollapseDebris', [.085,.075,.068], [.10,.025,.008], .12);
      this.platformPart = partFor(this.platformMesh, 'AuroraRaptorPlatform', [.006,.008,.012], [.004,.006,.010], 0);
      this.platformPart.mat._smooth=.76;this.platformPart.mat._metal=.82;this.platformPart.mat._cc=.55;
      this.platformGlow = partFor(this.platformMesh, 'AuroraPlatformLight', [.025,.002,.001], [.34,.009,.003], .72);
      this.model = M4.make();
      this.stage = null;
      this.scene.level5WorldFx = this;
    }

    setupTower(anchorS) {
      const p = this.g.track.at(anchorS, {});
      const sideSign = -1;
      const rx = Math.cos(p.yaw), rz = -Math.sin(p.yaw);
      this.tower = {
        anchorS, roadX: p.x, roadZ: p.z, yaw: p.yaw,
        sx: rx * sideSign, sz: rz * sideSign,
        baseX: p.x + rx * sideSign * 27,
        baseZ: p.z + rz * sideSign * 27,
        angle: 0, h: 56,
      };
      this.debris.length = 0;
      for (let i = 0; i < 18; i++) {
        const r = ((i * 73 + 17) % 101) / 101;
        const r2 = ((i * 47 + 29) % 97) / 97;
        this.debris.push({
          along: (r - .5) * 26, side: (r2 - .5) * 12,
          y: 7 + ((i * 31) % 23), vx: (r2 - .5) * 13,
          vy: 7 + r * 16, vz: (r - .5) * 12,
          rx: (r - .5) * 4, ry: (r2 - .5) * 5, rz: (r - .3) * 4,
        });
      }
      this.visible = true;
    }

    setRaptorStage(car) {
      this.stage=car?{x:car.x,y:car.y-.88,z:car.z,yaw:car.yaw}:null;
      if(car){this.tower=null;this.visible=true;}
    }

    hide() { this.visible = false; this.stage=null; }

    drawRaptorStage(scene) {
      const S=this.stage;if(!S)return;
      const gl=this.gl,draw=(x,y,z,sx,sy,sz,part)=>{
        const fx=Math.sin(S.yaw),fz=Math.cos(S.yaw),rx=Math.cos(S.yaw),rz=-Math.sin(S.yaw);
        const wx=S.x+rx*x+fx*z,wz=S.z+rz*x+fz*z;
        scaledTrs(this.model,wx,S.y+y,wz,S.yaw,0,0,sx,sy,sz);
        gl.bindVertexArray(this.platformMesh.vao);scene.drawPart(part,this.model);
      };
      draw(0,0,0,8.8,.44,12.4,this.platformPart);
      gl.enable(gl.BLEND);gl.depthMask(false);gl.blendFunc(gl.SRC_ALPHA,gl.ONE);
      draw(-4.18,.27,0,.08,.09,11.8,this.platformGlow);
      draw( 4.18,.27,0,.08,.09,11.8,this.platformGlow);
      draw(0,.27,-5.75,8.2,.09,.08,this.platformGlow);
      gl.depthMask(true);gl.disable(gl.BLEND);
    }

    draw(scene) {
      if (!this.visible) return;
      if (this.stage) this.drawRaptorStage(scene);
      if (!this.tower) { this.gl.bindVertexArray(scene.vao); return; }
      const gl = this.gl, T = this.tower;
      const a = T.angle;
      const half = T.h * .5;
      // Hinge around the base: as the tower rolls toward the road, the centre
      // moves sideways and down instead of rotating magically around mid-air.
      const cx = T.baseX - T.sx * Math.sin(a) * half;
      const cz = T.baseZ - T.sz * Math.sin(a) * half;
      const cy = Math.max(1.4, Math.cos(a) * half);
      const roll = a;
      M4.trs(this.model, cx, cy, cz, T.yaw, 0, roll);
      gl.bindVertexArray(this.towerMesh.vao);
      scene.drawPart(this.towerPart, this.model);
      gl.bindVertexArray(this.seamMesh.vao);
      scene.drawPart(this.seamPart, this.model);

      const dAge = Math.max(0, (T.eventT || 0) - 4.6);
      if (dAge > 0) {
        const fx = Math.sin(T.yaw), fz = Math.cos(T.yaw);
        const rx = Math.cos(T.yaw), rz = -Math.sin(T.yaw);
        gl.bindVertexArray(this.debrisMesh.vao);
        for (let i = 0; i < this.debris.length; i++) {
          const d = this.debris[i];
          const lat = d.side + d.vx * dAge;
          const along = d.along + d.vz * dAge;
          const px = T.baseX + rx * lat + fx * along;
          const pz = T.baseZ + rz * lat + fz * along;
          const py = Math.max(.55, d.y + d.vy * dAge - 9.5 * dAge * dAge);
          if (py <= .55 && dAge > 2.3) continue;
          M4.trs(this.model, px, py, pz, T.yaw + d.ry * dAge, d.rx * dAge, d.rz * dAge);
          scene.drawPart(this.debrisPart, this.model);
        }
      }
      gl.bindVertexArray(scene.vao);
    }
  }

  // Add the one moving world-space structure after the normal static world.
  if (NR.Scene && !NR.Scene.prototype.__level5WorldPatched) {
    const oldDrawWorld = NR.Scene.prototype.drawWorld;
    NR.Scene.prototype.drawWorld = function (camPos, viewDist) {
      oldDrawWorld.call(this, camPos, viewDist);
      if (this.level5WorldFx) this.level5WorldFx.draw(this);
    };
    NR.Scene.prototype.__level5WorldPatched = true;
  }

  class Director {
    constructor(game) {
      this.g = game;
      this.world = new DynamicSetpieceWorld(game);
      this.raptor = new RaptorKit(game);
      game.scene.level5RaptorKit=this.raptor;
      this.dom = this.findDom();
      this.collapseSeen = false;
      this.volcanoSeen = false;
      this.dayForced = false;
      this.active = null;
      this.finishPending = null;
      this.paletteClock = 0;
      this.prevProgress = game.progress || 0;
      this.fireballs = [];
      this.bgBallClock = 0;
      this.failClock = 0;
      this.hide();
    }

    findDom() {
      const d = global.document;
      if (!d || !d.getElementById) return {};
      return {
        root: d.getElementById('cine5'), copy: d.getElementById('cine5Copy'),
        kicker: d.getElementById('cine5Kicker'), title: d.getElementById('cine5Title'),
        actor: d.getElementById('cine5Actor'), flash: d.getElementById('cine5Flash'),
        prompt: d.getElementById('cine5Prompt'), meter: d.getElementById('cine5Meter'),
        meterFill: d.getElementById('cine5MeterFill'), hint: d.getElementById('cine5Hint'),
        timer: d.getElementById('cine5Timer'), telemetry: d.getElementById('cine5Telemetry'),
        telemetryTitle: d.getElementById('cine5TelemetryTitle'),
        telemetryBody: d.getElementById('cine5TelemetryBody'),
        bossCard: d.getElementById('cine5BossCard'),
      };
    }

    /* Ashfall's two set pieces - the collapse and the eruption - are hung off
       `g.progress`, which on a chapter is progress through Ashfall and on a
       Free Roam tour is progress through a hundred and twenty-seven
       kilometres of road. They are chapter beats either way, so the director
       stands down for a tour and the route is driven as scenery. */
    isLevel5() { return !!(this.g.level && this.g.level.level5 && this.g.levelIndex === 4 && !this.g.freeRoam); }

    reset() {
      const ending=this.active&&this.active.type==='finish'?this.active:null;
      if(ending&&this.g.scene){this.g.scene.ambInt=ending.prevAmb;this.g.scene.sunInt=ending.prevSun;}
      this.collapseSeen = false;
      this.volcanoSeen = false;
      this.dayForced = false;
      this.active = null;
      this.finishPending = null;
      this.prevProgress = this.g.progress || 0;
      this.fireballs.length = 0;
      this.failClock = 0;
      this.world.hide();
      this.g.storyRaptor=null;
      this.g.storyRaptorCharge=0;
      if (this.g.scene) { this.g.scene.level5DaySky = 0; this.g.scene.level5BossLight=null; }
      this.hide();
    }

    hide() {
      const D = this.dom || {};
      if (D.root) {
        D.root.classList.remove('show','finish','qte','danger','success','failed','fatality','redline','raptor','impact');
        D.root.setAttribute('aria-hidden', 'true');
      }
      if (D.prompt) { D.prompt.textContent = ''; D.prompt.classList.remove('drop','good','bad','mash'); }
      if (D.flash) D.flash.style.opacity = '0';
      if (D.telemetry) D.telemetry.classList.remove('show');
      if (D.bossCard) D.bossCard.classList.remove('show');
      if (global.document && global.document.body) global.document.body.classList.remove('cine5-active','cine5-finish','cine5-qte','cine5-redline','cine5-raptor');
    }

    show(opts) {
      const D = this.dom || {};
      if (D.kicker) D.kicker.textContent = opts.kicker || 'LEVEL 5 // LIVE EVENT';
      if (D.title) D.title.textContent = opts.title || '';
      if (D.actor) D.actor.textContent = opts.actor || '';
      if (D.hint) D.hint.textContent = opts.hint || '';
      if (D.root) {
        D.root.classList.remove('success','failed','fatality');
        D.root.classList.add('show');
        D.root.classList.toggle('finish', !!opts.finish);
        D.root.classList.toggle('qte', !!opts.qte);
        D.root.classList.toggle('danger', !!opts.danger);
        D.root.classList.toggle('redline', !!opts.redline);
        D.root.classList.toggle('raptor', !!opts.raptor);
        D.root.setAttribute('aria-hidden','false');
      }
      if (global.document && global.document.body) {
        global.document.body.classList.add('cine5-active');
        global.document.body.classList.toggle('cine5-finish', !!opts.finish);
        global.document.body.classList.toggle('cine5-qte', !!opts.qte);
        global.document.body.classList.toggle('cine5-redline', !!opts.redline);
        global.document.body.classList.toggle('cine5-raptor', !!opts.raptor);
      }
    }

    setTelemetry(title, lines, show) {
      const D=this.dom||{};
      if(D.telemetryTitle)D.telemetryTitle.textContent=title||'';
      if(D.telemetryBody)D.telemetryBody.innerHTML=(lines||[]).map(x=>'<span>'+x+'</span>').join('');
      if(D.telemetry)D.telemetry.classList.toggle('show',show!==false);
    }

    setCineStrength(v) {
      const D = this.dom || {};
      if (D.root && D.root.style && D.root.style.setProperty) {
        D.root.style.setProperty('--cine-strength', clamp(v, 0, 1).toFixed(3));
      }
    }

    setMeter(v) {
      const D = this.dom || {};
      const p = clamp(v, 0, 1);
      if (D.meterFill) D.meterFill.style.transform = 'scaleX(' + p.toFixed(4) + ')';
    }

    setTimer(t) {
      const D = this.dom || {};
      if (D.timer) D.timer.textContent = Math.max(0, t).toFixed(1) + 's';
    }

    pulseFlash(amount) {
      const D = this.dom || {};
      if (D.flash) D.flash.style.opacity = String(clamp(amount, 0, 1));
    }

    promptKey(k) {
      const D = this.dom || {};
      if (!D.prompt) return;
      D.prompt.textContent = String(k || '').toUpperCase();
      D.prompt.classList.remove('drop','good','bad','mash');
      void D.prompt.offsetWidth;
      D.prompt.classList.add('drop');
      if (D.hint && VOLCANO_ACTION[k]) D.hint.textContent = VOLCANO_ACTION[k];
    }

    markPrompt(ok) {
      const D = this.dom || {};
      if (!D.prompt) return;
      D.prompt.classList.remove('good','bad');
      D.prompt.classList.add(ok ? 'good' : 'bad');
    }

    updatePalette(dt) {
      const g = this.g;
      this.paletteClock -= dt;
      if (this.paletteClock > 0) return;
      this.paletteClock = .08;
      const p = routePalette(g.level, g.progress || 0, this.dayForced);
      if (!p) return;
      g.runtimePalette = p;
      g.scene.setPalette(p);
      if (p.sun) g.scene.sunColor = p.sun;
      if (p.ambient !== undefined) g.scene.ambInt = p.ambient;
      if (p.fogRange) g.fogDensity = 1 / p.fogRange;
      if (p.fogTint) g.levelFog = p.fogTint;
      if (p.wet !== undefined) g.levelWet = p.wet;
    }

    forceDay() {
      if (this.dayForced) return;
      this.dayForced = true;
      if (this.g.scene) this.g.scene.level5DaySky = 1;
      this.paletteClock = 0;
      this.updatePalette(0);
      this.g.flash = Math.max(this.g.flash || 0, .16);
    }

    /* PUT A CAR ON THE ROAD.
     *
     * ON the road, which is the whole point and is what this used to get
     * wrong: `car.y` was the ride height and nothing else, an ABSOLUTE world
     * height that quietly assumed every road in the game is laid at y=0.
     *
     * Most of them nearly are, so this survived six chapters. Chapter 7 is an
     * elevated deck: its surface is tens of units up, and every scripted
     * placement on it - a dodge, a checkpoint reset, a set piece moving the
     * R-IX into shot - dropped the car to a metre above the world origin,
     * which is somewhere underneath the city. During free driving the solver
     * recomputes y from the road at the end of every step and hides it, but a
     * cinematic suspends the solver and drives the car by placing it, so it
     * did not get hidden there: the car sank through the deck and kept going.
     * That is the reported clipping.
     *
     * So the height comes off the road, and so does the GRADE. A car placed on
     * a climbing deck with a level attitude has its nose in the surface and
     * its tail in the air, which is the same bug one derivative up; the
     * renderer adds `pitch` and `roadPitch` together, so the dodge animation
     * keeps `pitch` to itself and the road gets its own term. Six units either
     * side is the same baseline the solver uses (see Vehicle::step).
     */
    setVehicle(car, s, lateral, speed, dodgePitch) {
      if (!car) return;
      const p = this.g.track.at(s, {});
      const rx = Math.cos(p.yaw), rz = -Math.sin(p.yaw);
      car.sTrack = s;
      car.maxS = s; car.beached = 0; car.wrongWay = 0;
      car.lateral = lateral;
      car.x = p.x + rx * lateral;
      car.z = p.z + rz * lateral;
      const roadY = p.y || 0;
      car.roadY = roadY;
      car.y = roadY + (car.lift || 0);
      car.yaw = p.yaw;
      const back = this.g.track.at(s - 6, {}), ahead = this.g.track.at(s + 6, {});
      car.roadPitch = -Math.atan2((ahead.y || 0) - (back.y || 0), 12);
      car.pitch = dodgePitch || 0;
      car.roll = clamp(lateral * -.018, -.12, .12);
      car.vLong = speed; car.vLat = 0; car.speed = speed;
      car.vx = Math.sin(p.yaw) * speed;
      car.vz = Math.cos(p.yaw) * speed;
      car.yawRate = 0;
      car.steer = 0; car.steerVisual = 0;
      car.bodySlip = 0; car.driftAmount = 0; car.drifting = false;
      car.boosting = speed > 76;
      car.wheelSpin = (car.wheelSpin || 0) - speed * (this.g.__lastLevel5Dt || 1/60) / .45;
    }

    /* Cinematic cameras replace the chase transform, so the normal gameplay
       shake would otherwise be calculated and immediately overwritten.  Keep
       impact motion additive in camera-local space: lateral stays lateral no
       matter which way the track is pointing, matching the camera-shake model
       used by modern real-time cinematic tools. */
    /* A mark that lands outside the barrier films the set piece through it.
       These sequences are composed around the car, and the car can be
       anywhere across the carriageway, so the composition has to be checked
       against the road rather than trusted. */
    setEye(ex, ey, ez) {
      const g = this.g, e = [ex, ey, ez];
      if (g.story && g.story.guardEye) g.story.guardEye(e, g.car ? g.car.sTrack : 0);
      g.eye[0] = e[0]; g.eye[1] = e[1]; g.eye[2] = e[2];
    }

    applyCineShake(yaw, base) {
      const g=this.g;
      const hit=Math.max(0,g.shake||0),amp=(base||0)+hit*hit*1.15;
      if (amp < .002) return;
      const t=g.time||0,rx=Math.cos(yaw),rz=-Math.sin(yaw),fx=Math.sin(yaw),fz=Math.cos(yaw);
      const sx=(Math.sin(t*41.7)+Math.sin(t*67.1)*.43)*amp;
      const sy=(Math.sin(t*53.3+.7)+Math.sin(t*31.9)*.36)*amp*.55;
      const sz=Math.sin(t*37.6+1.4)*amp*.34;
      g.eye[0]+=rx*sx+fx*sz;g.eye[1]+=sy;g.eye[2]+=rz*sx+fz*sz;
      g.target[0]+=rx*sx*.18;g.target[1]+=sy*.16;g.target[2]+=rz*sx*.18;
    }

    updateRaceBookkeeping() {
      const g = this.g;
      g.distance = g.car.sTrack;
      const span = Math.max(1, g.finishAt - g.startAt);
      g.progress = clamp((g.distance - g.startAt) / span, 0, 1);
      if (g.rival) {
        g.rivalGap = g.car.sTrack - g.rival.sTrack;
        g.place = g.rivalGap >= 0 ? 1 : 2;
      }
      if (g.audio && g.audio.setEnvironment && g.scene.environmentAt) g.audio.setEnvironment(g.scene.environmentAt(g.distance));
    }

    commonCinematicTick(dt, raceClock) {
      const g = this.g;
      g.__lastLevel5Dt = dt;
      g.time += dt;
      g.scene.time = g.time;
      if (raceClock) g.raceTime += dt;
      g.flash = Math.max(0, (g.flash || 0) - dt * .85);
      g.shake = Math.max(0, (g.shake || 0) - dt * 1.6);
      // pulseFlash used to write a permanent DOM opacity, leaving every shot
      // after the first blast under a white/orange veil.  Tie the overlay to
      // the same decaying impact scalar as the renderer.
      this.pulseFlash((g.flash || 0) * .82);
      this.updateRaceBookkeeping();
      this.updatePalette(dt);
      g.updateAtmosphere(dt);
      g.updateCamera(dt); // establish sane matrices, then the director overrides
      if (g.fx) {
        g.fx.update(dt, g.rival ? [g.car, g.rival] : g.car, raceClock);
      }
      if (g.audio && g.audio.update) g.audio.update(g.car, dt, raceClock);
    }

    checkpointBeforeTunnel(s) {
      const g = this.g, C = g.track && g.track.C;
      if (!C || !C.tunnel || !C.step) return Math.max(g.startAt + 20, s - 1400);
      let i = Math.min(C.tunnel.length - 1, Math.floor(s / C.step));
      while (i > 0 && !C.tunnel[i]) i--;
      if (!C.tunnel[i]) return Math.max(g.startAt + 20, s - 1400);
      while (i > 0 && C.tunnel[i - 1]) i--;
      // Enough run-up to re-enter the tunnel at speed, but never rewind into
      // the previous level or onto the portal itself.
      return clamp(i * C.step - 120, g.startAt + 20, s - 320);
    }

    startCollapse() {
      const g = this.g;
      this.collapseSeen = true;
      const startS = g.car.sTrack;
      const rivalDelta = g.rival ? g.rival.sTrack - g.car.sTrack : -8;
      /* A full 50-hit run reaches this tower only in the closing second. The
         hinge still obeys road-space clearance, so success throws the building
         down behind the bumper rather than letting the car ghost through it. */
      const towerS = startS + 820;
      this.world.setupTower(towerS);
      this.active = {
        type: 'collapse', t: 0, startS, rivalDelta,
        startRaceTime: g.raceTime, checkpointS: this.checkpointBeforeTunnel(startS),
        taps: 0, towerS, lastTapT: -99, failed: false, failT: 0,
        success: false, escapeT: 0, slamT: -1, aftershock: false,
      };
      this.show({
        kicker: 'CITY EVENT // STRUCTURAL FAILURE', title: EVENTS.collapse.title,
        actor: '6 SECONDS // 50 HITS // THE TOWER IS COMING DOWN',
        hint: 'MASH Q // BUILD SPEED // CLEAR THE CRUSH ZONE', qte: true, danger: true,
      });
      this.setMeter(0); this.setTimer(EVENTS.collapse.duration);
      if (this.dom.prompt) { this.dom.prompt.textContent='Q'; this.dom.prompt.classList.add('mash'); }
      this.setCineStrength(.38);
      g.shake = Math.max(g.shake || 0, .34);
      if (g.audio && g.audio.crash) g.audio.crash(.42);
    }

    collapseCamera(a) {
      const g = this.g, car = g.car, T = this.world.tower;
      const t = a.t / EVENTS.collapse.duration;
      const yaw = car.yaw || 0;
      const fx = Math.sin(yaw), fz = Math.cos(yaw), rx = Math.cos(yaw), rz = -Math.sin(yaw);
      let ex, ey, ez, tx, ty, tz, fov;
      if (t < .28) {
        const q = smooth(t / .28);
        ex = car.x - fx * mix(10, 15, q) + rx * mix(5.5, 2.5, q);
        ey = car.y + mix(1.15, 2.1, q);
        ez = car.z - fz * mix(10, 15, q) + rz * mix(5.5, 2.5, q);
        const hazardMix = .22 + q * .14;
        tx = mix(car.x + fx * 10, T.baseX, hazardMix);
        ty = mix(car.y + 1.1, 16, hazardMix);
        tz = mix(car.z + fz * 10, T.baseZ, hazardMix);
        fov = 65;
      } else if (t < .72) {
        const q = smooth((t - .28) / .44);
        ex = car.x + rx * mix(15, -13, q) - fx * 4;
        ey = car.y + mix(2.4, 4.3, Math.sin(q * Math.PI));
        ez = car.z + rz * mix(15, -13, q) - fz * 4;
        tx = car.x + fx * 7; ty = car.y + 1.0; tz = car.z + fz * 7;
        fov = 70 + Math.sin(q * Math.PI) * 5;
      } else {
        const q = smooth((t - .72) / .28);
        // Low three-quarter escape shot.  The earlier head-on angle pointed
        // both headlights straight into bloom and erased the car into a white
        // disc.  This keeps the hero readable and biases the aim just far
        // enough back to retain the falling tower in the same composition.
        ex = car.x + fx * mix(7, 10, q) + rx * mix(-19, 13, q);
        ey = car.y + mix(2.0, 5.2, q);
        ez = car.z + fz * mix(7, 10, q) + rz * mix(-19, 13, q);
        const hazardMix = a.slamT >= 0 ? mix(.040, .018, q) : 0;
        tx = mix(car.x - fx * 1.5, T.roadX, hazardMix);
        ty = mix(car.y + 1.0, 4.0, hazardMix);
        tz = mix(car.z - fz * 1.5, T.roadZ, hazardMix);
        fov = mix(68, 59, q);
      }
      this.setEye(ex, ey, ez);
      g.target[0]=tx; g.target[1]=ty; g.target[2]=tz; g.fov=fov;
      this.applyCineShake(yaw, a.slamT >= 0 ? .065 : .018);
    }

    emitCollapseDebris(a, dt) {
      const T = this.world.tower;
      if (!T) return;
      T.eventT = a.t;
      /* UltraRace-inspired blast -> hang -> slam timing, with one hard spatial
         rule: the tower cannot enter the live lane until the hero is clear of
         it.  A small early lean sells structural failure; the destructive
         hinge starts only after the rear of the car is 46 units beyond the
         tower station. */
      const lean = smooth(clamp((a.t - .12) / 1.55, 0, 1)) * .12;
      const clearance = this.g.car.sTrack - a.towerS;
      if (a.slamT < 0 && clearance > 46) {
        a.slamT = a.t;
        this.explodeAt(T.baseX, 2.4, T.baseZ, .30);
      }
      const slam = a.slamT < 0 ? 0 : smooth((a.t - a.slamT) / .82);
      T.angle = mix(lean, 1.53, slam);
      if (this.g.fx && a.t > .42 && Math.random() < dt * (26 + a.t * 4)) {
        const px = T.baseX + (Math.random() - .5) * 16;
        const pz = T.baseZ + (Math.random() - .5) * 16;
        const py = 7 + Math.random() * 35;
        for (let i=0;i<3;i++) this.g.fx.spawn({
          x:px,y:py,z:pz, vx:(Math.random()-.5)*12,vy:4+Math.random()*9,vz:(Math.random()-.5)*12,
          life:.55+Math.random()*.45,size:.55+Math.random()*.55,grow:-.15,gravity:-20,drag:1.0,stretch:3.8,
          r:1,g:.28+Math.random()*.24,b:.05,a:1.25,
        });
      }
    }

    explodeAt(x, y, z, power) {
      const g = this.g;
      const force = clamp(power === undefined ? 1 : power, .1, 1);
      if (g.fx) {
        for (let i = 0; i < 54; i++) {
          const ang = Math.random() * Math.PI * 2, sp = 7 + Math.random() * 30 * (power || 1);
          g.fx.spawn({
            x:x+(Math.random()-.5)*1.4,y:y+(Math.random()-.5)*1.0,z:z+(Math.random()-.5)*1.4,
            vx:Math.cos(ang)*sp,vy:4+Math.random()*21,vz:Math.sin(ang)*sp,
            life:.30+Math.random()*.72,size:.65+Math.random()*1.7,grow:1.6,gravity:-18,drag:.8,stretch:2.8,
            r:1.0,g:.18+Math.random()*.42,b:.018,a:1.55,
          });
        }
        for (let i = 0; i < 18; i++) g.fx.spawn({
          x,y:y+.4,z, vx:(Math.random()-.5)*5,vy:1+Math.random()*4,vz:(Math.random()-.5)*5,
          life:.8+Math.random()*.8,size:3+Math.random()*4,grow:4,gravity:-1.4,drag:.28,stretch:0,
          r:.22,g:.13,b:.09,a:.65,
        });
      }
      // Distant/background impacts should add punctuation, not white out the
      // whole twenty-second sequence. Only a direct hit earns the full flash.
      g.flash = Math.max(g.flash || 0, .08 + force * .72);
      g.shake = Math.max(g.shake || 0, .12 + force * .93);
      this.pulseFlash((.08 + force * .72) * .82);
      if (g.audio && g.audio.crash) g.audio.crash(force);
    }

    failActive(reason, fatality) {
      const a = this.active;
      if (!a || a.failed) return;
      a.failed = true; a.failT = 0; a.failReason = reason;
      const D = this.dom || {};
      if (D.root) D.root.classList.add('failed');
      if (fatality && D.root) D.root.classList.add('fatality');
      if (fatality && D.title) D.title.textContent = 'FATALITY';
      if (D.actor) D.actor.textContent = fatality ? 'DIRECT HIT // RESTARTING GAUNTLET' : reason + ' // REWINDING EVENT';
      if (D.hint) D.hint.textContent = fatality ? reason : 'IMPACT';
      this.markPrompt(false);
      this.explodeAt(this.g.car.x, this.g.car.y + 1.0, this.g.car.z, 1);
    }

    restartActive() {
      const a = this.active;
      if (!a) return;
      const g = this.g;
      g.raceTime = a.startRaceTime;
      if (a.type === 'collapse') {
        this.rewindCollapseCheckpoint(a);
        return;
      } else if (a.type === 'volcano') {
        const startS = a.startS, rivalDelta = a.rivalDelta;
        this.active = this.makeVolcanoState(startS, rivalDelta, a.startRaceTime);
        this.show({ kicker:'VOLCANIC EVENT // RETRY', title:EVENTS.volcano.title, actor:'READ THE FALLING INPUTS', hint:'W / A / S / D // ONE MISS = IMPACT', qte:true, danger:true });
        this.setMeter(0);
      }
      const D = this.dom || {};
      if (D.root) D.root.classList.remove('failed','fatality');
      this.fireballs.length = 0;
      this.setCineStrength(.34);
    }

    beginCollapseEscape(a) {
      const g = this.g, D = this.dom || {}, T = this.world.tower;
      a.success = true;
      a.escapeT = 0;
      a.escapeS = g.car.sTrack;
      a.escapeRivalS = g.rival ? g.rival.sTrack : 0;
      if (T) {
        T.angle = 1.55;
        T.eventT = 6.2;
        this.explodeAt(T.baseX, 7.0, T.baseZ, .78);
        g.flash=Math.min(g.flash||0,.30);
      }
      if (D.root) {
        D.root.classList.remove('danger','qte','failed','fatality');
        D.root.classList.add('success');
      }
      if (D.title) D.title.textContent = 'ESCAPE THE BLAST';
      if (D.actor) D.actor.textContent = 'CLEAR // TOWER DETONATION';
      if (D.hint) D.hint.textContent = 'KEEP MOVING';
      if (D.prompt) { D.prompt.textContent = ''; D.prompt.classList.remove('mash'); }
      if (global.document && global.document.body) global.document.body.classList.remove('cine5-qte');
      this.setMeter(1);
      this.setTimer(0);
    }

    collapseEscapeCamera(a) {
      const g=this.g,car=g.car,T=this.world.tower,yaw=car.yaw||0;
      const fx=Math.sin(yaw),fz=Math.cos(yaw),rx=Math.cos(yaw),rz=-Math.sin(yaw);
      const t=clamp(a.escapeT/EVENTS.collapse.successDuration,0,1);
      let ex,ey,ez,tx,ty,tz,fov;
      if(t<.30 && T){
        // Front three-quarter escape shot. The car owns the foreground while
        // the detonating tower remains directly behind it in road space.
        const q=smooth(t/.30);
        ex=car.x+fx*mix(22,16,q)+rx*mix(15,-11,q);
        ey=car.y+mix(3.4,5.2,q);
        ez=car.z+fz*mix(22,16,q)+rz*mix(15,-11,q);
        tx=car.x-fx*3;ty=car.y+1.0;tz=car.z-fz*3;
        fov=mix(73,67,q);
      }else{
        const q=smooth((t-.30)/.70),side=Math.sin(q*Math.PI)*12;
        ex=car.x-fx*mix(19,11,q)+rx*side;ey=car.y+mix(2.0,4.0,q);
        ez=car.z-fz*mix(19,11,q)+rz*side;
        tx=car.x+fx*10;ty=car.y+1.0;tz=car.z+fz*10;fov=mix(70,61,q);
      }
      this.setEye(ex,ey,ez);
      g.target[0]=tx;g.target[1]=ty;g.target[2]=tz;g.fov=fov;
      this.applyCineShake(yaw,.035*(1-t));
    }

    updateCollapseEscape(dt) {
      const g=this.g,a=this.active,T=this.world.tower;
      a.escapeT+=dt;
      const kick=ease(a.escapeT/.72)*28;
      const s=a.escapeS+a.escapeT*78+kick;
      this.setVehicle(g.car,s,Math.sin(a.escapeT*2.2)*.22,91,-.02);
      if(g.rival)this.setVehicle(g.rival,a.escapeRivalS+a.escapeT*73,4.5,77,0);
      if(T){
        T.angle=1.55;T.eventT=6.2+a.escapeT;
        if(!a.aftershock&&a.escapeT>.62){
          a.aftershock=true;
          this.explodeAt(T.roadX,2.0,T.roadZ,.66);
          g.flash=Math.min(g.flash||0,.20);
        }
      }
      this.setCineStrength(.98-.22*smooth(a.escapeT/EVENTS.collapse.successDuration));
      this.commonCinematicTick(dt,true);
      this.collapseEscapeCamera(a);
      const D=this.dom||{};
      if(D.actor)D.actor.textContent=a.escapeT<1.15?'CLEAR // TOWER DETONATION':'SUCCESSFUL ESCAPE // FULL THROTTLE';
      if(a.escapeT>=EVENTS.collapse.successDuration)this.endInteractive();
      return true;
    }

    beginCollapseCrush(a) {
      const g=this.g,D=this.dom||{};
      a.failed=true;a.failT=0;a.crushS=g.car.sTrack;a.crushImpact=false;
      // Cut to the structure directly over the hero. This branch is allowed to
      // enter the lane; the success branch never is.
      a.towerS=a.crushS;
      this.world.setupTower(a.crushS);
      if(this.world.tower){this.world.tower.angle=.04;this.world.tower.eventT=4.6;}
      if(D.title)D.title.textContent='COLLAPSE IMMINENT';
      if(D.actor)D.actor.textContent='TOO SLOW // LOOK UP';
      if(D.hint)D.hint.textContent='STRUCTURAL IMPACT';
      if(D.prompt){D.prompt.textContent='';D.prompt.classList.remove('mash');}
      this.setTimer(0);
      this.markPrompt(false);
    }

    collapseFailureCamera(a) {
      const g=this.g,car=g.car,T=this.world.tower,yaw=car.yaw||0;
      const fx=Math.sin(yaw),fz=Math.cos(yaw),rx=Math.cos(yaw),rz=-Math.sin(yaw);
      const q=smooth(a.failT/.82),orbit=1-q;
      this.setEye(car.x+rx*mix(17,14,q)+fx*mix(7,28,q),
                  car.y+mix(2.2,8.5,q),
                  car.z+rz*mix(17,14,q)+fz*mix(7,28,q));
      g.target[0]=mix(car.x,T?T.baseX:car.x,.18*orbit);
      g.target[1]=mix(car.y+1,T?18:car.y+1,.26*orbit);
      g.target[2]=mix(car.z,T?T.baseZ:car.z,.18*orbit);
      g.fov=mix(68,61,q);
      this.applyCineShake(yaw,.025+q*.12);
    }

    updateCollapseFailure(dt) {
      const g=this.g,a=this.active,D=this.dom||{},T=this.world.tower;
      a.failT+=dt;
      this.setVehicle(g.car,a.crushS+(a.crushImpact?9:0),0,a.crushImpact?0:8,0);
      if(a.crushImpact)g.car.roll=.30;
      if(g.rival)this.setVehicle(g.rival,a.crushS+a.rivalDelta+18,4.7,28,0);
      if(T){T.angle=mix(.04,1.56,smooth(a.failT/.78));T.eventT=4.6+a.failT;}
      this.setCineStrength(clamp(.62+a.failT*.42,0,1));
      g.shake=Math.max(g.shake||0,.10+smooth(a.failT/.78)*.34);
      this.commonCinematicTick(dt,false);
      this.collapseFailureCamera(a);
      if(!a.crushImpact&&a.failT>=.76){
        a.crushImpact=true;
        if(T)this.explodeAt(T.roadX,1.4,T.roadZ,1);
        else this.explodeAt(g.car.x,g.car.y+1,g.car.z,1);
        if(D.root){D.root.classList.add('failed');D.root.classList.add('fatality');}
        if(D.title)D.title.textContent='FATALITY';
        if(D.actor)D.actor.textContent='CRUSHED // REWINDING BEFORE TUNNEL';
        if(D.hint)D.hint.textContent='BUILDING IMPACT';
        this.markPrompt(false);
      }
      if(a.failT>=EVENTS.collapse.failureDuration)this.rewindCollapseCheckpoint(a);
      return true;
    }

    rewindCollapseCheckpoint(a) {
      const g=this.g;
      const checkpoint=clamp(a.checkpointS===undefined?this.checkpointBeforeTunnel(a.startS):a.checkpointS,g.startAt+20,a.startS-320);
      g.raceTime=a.startRaceTime;
      this.setVehicle(g.car,checkpoint,0,48,0);
      if(g.rival)this.setVehicle(g.rival,checkpoint-8,4.5,46,0);
      this.collapseSeen=false;
      this.active=null;
      this.fireballs.length=0;
      this.world.hide();
      g.flash=0;g.shake=0;
      this.updateRaceBookkeeping();
      this.prevProgress=g.progress;
      this.hide();
    }

    updateCollapse(dt) {
      const g = this.g, a = this.active;
      if (a.failed) return this.updateCollapseFailure(dt);
      if (a.success) return this.updateCollapseEscape(dt);

      a.t += dt;
      const pressure=smooth(a.t/EVENTS.collapse.duration);
      this.setCineStrength(.42+pressure*.42+Math.abs(Math.sin(a.t*8.5))*pressure*.12+(a.slamT>=0?.12:0));
      if (g.input.hit('q')) {
        a.taps++;
        a.lastTapT = a.t;
        if (g.audio && g.audio.checkpoint) g.audio.checkpoint();
        g.shake = Math.max(g.shake || 0, .09);
      }
      const ratio = clamp(a.taps / EVENTS.collapse.targetTaps, 0, 1);
      const speed = 50 + ratio * 31 + (a.t - a.lastTapT < .22 ? 8 : 0);
      const s = a.startS + a.t * 50 + a.taps * 11.2;
      const weave = Math.sin(a.t * 1.35) * .32;
      this.setVehicle(g.car, s, weave, speed, -.015 * ratio);
      if (g.rival) this.setVehicle(g.rival, s + a.rivalDelta - 10 + Math.sin(a.t*.7)*3, 4.6, Math.max(48, speed-4), 0);
      this.emitCollapseDebris(a, dt);
      this.commonCinematicTick(dt, true);
      this.collapseCamera(a);
      this.setMeter(ratio);
      this.setTimer(EVENTS.collapse.duration - a.t);
      const D = this.dom || {};
      const remain=Math.max(0,EVENTS.collapse.duration-a.t);
      if (D.actor) D.actor.textContent = remain<2
        ? 'IMPACT IN '+remain.toFixed(1)+' // '+a.taps+' / '+EVENTS.collapse.targetTaps
        : 'Q MASH // '+a.taps+' / '+EVENTS.collapse.targetTaps;
      if (D.hint) D.hint.textContent = remain<1.35?'NO TIME LEFT // GO GO GO':'MASH Q // BUILD SPEED // CLEAR THE CRUSH ZONE';
      if (D.prompt) D.prompt.textContent = 'Q';

      if (a.t >= EVENTS.collapse.duration) {
        if (a.taps < EVENTS.collapse.targetTaps) {
          this.beginCollapseCrush(a);
        } else {
          this.beginCollapseEscape(a);
        }
      }
      return true;
    }

    makeVolcanoState(startS, rivalDelta, startRaceTime) {
      return {
        type:'volcano', t:0, startS, rivalDelta, startRaceTime,
        seq:seededSequence(EVENTS.volcano.cueCount), cueIndex:-1,
        cueBorn:0, cueAnswered:false, currentKey:'', failed:false, failT:0,
        carS:startS, dodge:0, surge:0, actionKey:'', actionT:99,
        currentBall:null, completed:false,
      };
    }

    startVolcano() {
      const g = this.g;
      this.volcanoSeen = true;
      this.forceDay();
      this.active = this.makeVolcanoState(g.car.sTrack, g.rival ? g.rival.sTrack - g.car.sTrack : -8, g.raceTime);
      this.bgBallClock = .1;
      this.show({
        kicker:'VOLCANIC EVENT // DAYBREAK', title:EVENTS.volcano.title,
        actor:'THE SKY IS GONE // READ THE FALLING INPUTS',
        hint:'W / A / S / D // DODGE EVERY FIREBALL', qte:true, danger:true,
      });
      this.setMeter(0); this.setTimer(EVENTS.volcano.duration);
      this.setCineStrength(.46);
      g.shake = Math.max(g.shake || 0, .26);
    }

    spawnBackgroundBall(a) {
      const g = this.g;
      const targetS = g.car.sTrack + 100 + Math.random() * 360;
      const p = g.track.at(targetS, {});
      const rx = Math.cos(p.yaw), rz = -Math.sin(p.yaw);
      const side = (Math.random() < .5 ? -1 : 1);
      const sourceS = targetS + 120 + Math.random() * 260;
      const s = g.track.at(sourceS, {});
      const life = 1.35 + Math.random() * .9;
      this.fireballs.push({
        age:0, life,
        sx:s.x + rx * side * (360 + Math.random()*520), sy:260+Math.random()*280, sz:s.z + rz * side * (360+Math.random()*520),
        tx:p.x + rx * side * (11 + Math.random()*18), ty:.8, tz:p.z + rz * side * (11+Math.random()*18),
        challenge:false,
      });
    }

    spawnChallengeBall(a, key) {
      const g = this.g;
      // Aim at where the car will be when the response window closes. W/S
      // change the longitudinal answer; A/D move it across the lane.
      const impactS = g.car.sTrack + 70 * (EVENTS.volcano.cueWindow + .10);
      const p = g.track.at(impactS, {});
      const rx = Math.cos(p.yaw), rz = -Math.sin(p.yaw);
      const side = key === 'a' ? 1 : key === 'd' ? -1 : (Math.random()<.5?-1:1);
      const src = g.track.at(impactS + 150, {});
      a.currentBall = {
        age:0, life:EVENTS.volcano.cueWindow + .18,
        sx:src.x + rx * side * 260, sy:185, sz:src.z + rz * side * 260,
        tx:p.x, ty:.9, tz:p.z,
        challenge:true, key, resolved:false,
      };
      this.fireballs.push(a.currentBall);
    }

    emitFireballVisual(ball, dt) {
      const g = this.g;
      ball.age += dt;
      const q = clamp(ball.age / ball.life, 0, 1);
      const h = Math.sin(q * Math.PI) * 74;
      const x = mix(ball.sx, ball.tx, q), y = mix(ball.sy, ball.ty, q) + h, z = mix(ball.sz, ball.tz, q);
      ball.x=x; ball.y=y; ball.z=z;
      if (g.fx) {
        const vx = (ball.tx-ball.sx)/ball.life, vz=(ball.tz-ball.sz)/ball.life;
        g.fx.spawn({x,y,z,vx:-vx*.03,vy:0,vz:-vz*.03,life:.10,size:3.2,grow:1.8,drag:1.7,gravity:0,stretch:2.6,r:1,g:.19,b:.012,a:1.9});
        if (Math.random() < .8) g.fx.spawn({x:x+(Math.random()-.5)*1.2,y:y+(Math.random()-.5)*1.2,z:z+(Math.random()-.5)*1.2,vx:(Math.random()-.5)*5,vy:(Math.random()-.5)*4,vz:(Math.random()-.5)*5,life:.22,size:1.2,grow:1.1,drag:1.4,gravity:-2,stretch:3,r:1,g:.55,b:.08,a:1.15});
        // A tightening ground marker makes the collision readable before it
        // happens instead of asking the player to infer a 3D ballistic arc.
        if (ball.challenge && q > .48 && Math.random() < .70) {
          const ang = Math.random() * Math.PI * 2;
          const rad = (1 - q) * 16 + 2;
          g.fx.spawn({x:ball.tx+Math.cos(ang)*rad,y:ball.ty+.18,z:ball.tz+Math.sin(ang)*rad,
            vx:-Math.cos(ang)*4,vy:.35,vz:-Math.sin(ang)*4,life:.16,size:.52,grow:.25,
            drag:2.2,gravity:0,stretch:1.8,r:1,g:.22,b:.015,a:1.35});
        }
      }
      return q >= 1;
    }

    updateFireballs(dt) {
      for (let i=this.fireballs.length-1;i>=0;i--) {
        const b=this.fireballs[i];
        const done=this.emitFireballVisual(b,dt);
        if (!done) continue;
        if (!b.challenge) this.explodeAt(b.tx,b.ty,b.tz,.30);
        this.fireballs.splice(i,1);
      }
    }

    emitHellWeather(dt) {
      const g=this.g,car=g.car;
      if (!g.fx || !car) return;
      const yaw=car.yaw||0,fx=Math.sin(yaw),fz=Math.cos(yaw),rx=Math.cos(yaw),rz=-Math.sin(yaw);
      const wanted=dt*78;
      const count=Math.floor(wanted)+(Math.random()<wanted-Math.floor(wanted)?1:0);
      for(let i=0;i<count;i++){
        const along=12+Math.random()*95,lateral=(Math.random()-.5)*58;
        g.fx.spawn({x:car.x+fx*along+rx*lateral,y:.8+Math.random()*18,z:car.z+fz*along+rz*lateral,
          vx:-fx*(8+Math.random()*17)+rx*(Math.random()-.5)*3,vy:1+Math.random()*4,
          vz:-fz*(8+Math.random()*17)+rz*(Math.random()-.5)*3,life:.45+Math.random()*.75,
          size:.18+Math.random()*.55,grow:.10,drag:.35,gravity:-.8,stretch:3.4,
          r:1,g:.10+Math.random()*.16,b:.004,a:.72+Math.random()*.42});
      }
    }

    answerVolcano(a, ok) {
      if (a.cueAnswered) return;
      a.cueAnswered = true;
      this.markPrompt(ok);
      if (!ok) { this.failActive('VOLCANIC FIREBALL IMPACT', true); return; }
      const k = a.currentKey;
      a.actionKey = k;
      a.actionT = 0;
      if (k === 'w') a.surge = Math.max(a.surge, 38);
      else if (k === 's') a.surge = Math.min(a.surge, -29);
      if (a.currentBall) {
        a.currentBall.challenge = false;
      }
      this.g.shake = Math.max(this.g.shake || 0, .15);
      if (this.g.audio) {
        if (k === 'w' && this.g.audio.boostHit) this.g.audio.boostHit();
        else if (this.g.audio.checkpoint) this.g.audio.checkpoint();
      }
      this.emitDodgeBurst(k);
    }

    emitDodgeBurst(key) {
      const g=this.g,car=g.car;
      if (!g.fx || !car) return;
      const yaw=car.yaw||0,fx=Math.sin(yaw),fz=Math.cos(yaw),rx=Math.cos(yaw),rz=-Math.sin(yaw);
      const side=key==='a'?-1:key==='d'?1:0;
      const count=key==='w'?34:20;
      for(let i=0;i<count;i++){
        const lateral=side*(1.8+Math.random()*2.8)+(Math.random()-.5)*1.5;
        const rear=key==='w'?-(3+Math.random()*5):(Math.random()-.5)*4;
        g.fx.spawn({x:car.x+rx*lateral+fx*rear,y:car.y+.25+Math.random()*.55,z:car.z+rz*lateral+fz*rear,
          vx:-fx*(18+Math.random()*36)+rx*side*(8+Math.random()*12),vy:(Math.random()-.15)*3,
          vz:-fz*(18+Math.random()*36)+rz*side*(8+Math.random()*12),life:.18+Math.random()*.28,
          size:.42+Math.random()*.8,grow:.4,drag:1.1,gravity:-3,stretch:5.2,
          r:1,g:key==='w'?.46:.24,b:.025,a:1.45});
      }
    }

    volcanoCamera(a) {
      const g=this.g, car=g.car, t=a.t/EVENTS.volcano.duration;
      const yaw=car.yaw||0, fx=Math.sin(yaw), fz=Math.cos(yaw), rx=Math.cos(yaw), rz=-Math.sin(yaw);
      let ex,ey,ez,tx,ty,tz,fov;
      if (t < .12) {
        const q=smooth(t/.12);
        ex=car.x-fx*mix(22,12,q)+rx*mix(18,7,q); ey=car.y+mix(13,4,q); ez=car.z-fz*mix(22,12,q)+rz*mix(18,7,q);
        tx=car.x+fx*18;ty=car.y+1;tz=car.z+fz*18;fov=mix(60,72,q);
      } else if (t < .86) {
        const q=(t-.12)/.74;
        const side=Math.sin(q*Math.PI*4.0)*8 + a.dodge*1.2;
        ex=car.x-fx*11+rx*side;ey=car.y+2.0+Math.abs(a.dodge)*.15;ez=car.z-fz*11+rz*side;
        tx=car.x+fx*9;ty=car.y+1.05;tz=car.z+fz*9;fov=74+Math.abs(a.dodge)*.8;
      } else {
        const q=smooth((t-.86)/.14);
        ex=car.x+fx*mix(20,8,q)+rx*mix(-8,10,q);ey=car.y+mix(2.2,9,q);ez=car.z+fz*mix(20,8,q)+rz*mix(-8,10,q);
        tx=car.x-fx*2;ty=car.y+1;tz=car.z-fz*2;fov=mix(73,58,q);
      }
      this.setEye(ex,ey,ez);g.target[0]=tx;g.target[1]=ty;g.target[2]=tz;g.fov=fov;
      this.applyCineShake(yaw, .025 + (a.actionT < 1.43 ? .05 : 0));
    }

    updateVolcano(dt) {
      const g=this.g,a=this.active;
      if (a.failed) {
        a.failT += dt;
        this.updateFireballs(dt);
        this.commonCinematicTick(dt,false);
        this.volcanoCamera(a);
        this.setCineStrength(1);
        if (a.failT > 1.8) this.restartActive();
        return true;
      }

      a.t += dt;
      this.setCineStrength(.46 + .28 * Math.abs(Math.sin(a.t * 1.8)) + (a.actionT < 1.43 ? .18 : 0));
      // Cue scheduling: each glyph drops from the top of the frame. The first
      // W/A/S/D press during the response window is judged immediately.
      const wantedIndex = Math.floor((a.t - EVENTS.volcano.cueStart) / EVENTS.volcano.cueGap);
      if (wantedIndex >= 0 && wantedIndex < a.seq.length && wantedIndex !== a.cueIndex) {
        if (a.cueIndex >= 0 && !a.cueAnswered) { this.answerVolcano(a,false); if (a.failed) return this.updateVolcano(0); }
        a.cueIndex=wantedIndex;a.cueBorn=a.t;a.cueAnswered=false;a.currentKey=a.seq[wantedIndex];
        this.promptKey(a.currentKey);this.spawnChallengeBall(a,a.currentKey);
      }
      if (a.cueIndex >= 0 && !a.cueAnswered) {
        let hit='';
        for (const k of ['w','a','s','d']) if (g.input.hit(k)) { hit=k;break; }
        if (hit) this.answerVolcano(a,hit===a.currentKey);
        else if (a.t-a.cueBorn > EVENTS.volcano.cueWindow) this.answerVolcano(a,false);
        if (a.failed) return this.updateVolcano(0);
      }

      this.bgBallClock -= dt;
      if (this.bgBallClock <= 0) { this.bgBallClock=.42+Math.random()*.42; this.spawnBackgroundBall(a); }
      this.updateFireballs(dt);
      this.emitHellWeather(dt);

      a.actionT += dt;
      const actionN=clamp(a.actionT/1.43,0,1);
      const actionPulse=a.actionT<.22?smooth(a.actionT/.22)
        :a.actionT<1.08?1:(1-smooth((a.actionT-1.08)/.35));
      const actionSide=a.actionKey==='a'?-1:a.actionKey==='d'?1:0;
      a.dodge=actionSide*7.4*actionPulse;
      a.surge *= Math.exp(-2.8*dt);
      const baseSpeed=70+a.surge;
      a.carS += baseSpeed*dt;
      const pitch=a.actionKey==='w'&&actionN<1?-.035*actionPulse:a.actionKey==='s'&&actionN<1?.055*actionPulse:0;
      this.setVehicle(g.car,a.carS,a.dodge,baseSpeed,pitch);
      if (g.rival) this.setVehicle(g.rival,a.carS+a.rivalDelta-12+Math.sin(a.t*.8)*4,-4.4,Math.max(58,baseSpeed-5),0);
      this.commonCinematicTick(dt,true);
      this.volcanoCamera(a);
      this.setTimer(EVENTS.volcano.duration-a.t);
      this.setMeter(clamp((a.cueIndex+(a.cueAnswered?1:0))/a.seq.length,0,1));
      const D=this.dom||{};
      if (D.actor) D.actor.textContent='DODGES // '+Math.max(0,a.cueIndex+(a.cueAnswered?1:0))+' / '+a.seq.length;

      const lastCueEnd=EVENTS.volcano.cueStart+(a.seq.length-1)*EVENTS.volcano.cueGap+EVENTS.volcano.cueWindow;
      if (a.t>=EVENTS.volcano.duration || (a.cueIndex===a.seq.length-1 && a.cueAnswered && a.t>lastCueEnd+2.0)) {
        if (D.root) {D.root.classList.remove('danger');D.root.classList.add('success');}
        if (D.actor) D.actor.textContent='ERUPTION CLEARED // FULL SEND';
        this.endInteractive();
      }
      return true;
    }

    endInteractive() {
      const g=this.g,a=this.active;
      if (!a) return;
      // Leave the cars at their cinematic positions with coherent velocity, so
      // the very next normal physics step continues instead of snapping.
      this.updateRaceBookkeeping();
      const D=this.dom||{};
      if (D.prompt) D.prompt.textContent='';
      this.active=null;
      this.fireballs.length=0;
      if (a.type==='collapse') this.world.hide();
      // A short visual tail, but input returns immediately.
      if (D.root) {
        setTimeout(() => {
          if (!this.active && !this.finishPending) this.hide();
        }, 520);
      }
    }

    finishTriggerUnits() {
      return EVENTS.finish.triggerMeters/EVENTS.finish.metresPerTrackUnit;
    }

    shouldStartFinish() {
      if(!this.isLevel5()||this.finishPending||this.active||this.g.state!=='racing'||this.g.raceOver)return false;
      const leader=Math.max(this.g.car.sTrack,this.g.rival?this.g.rival.sTrack:-Infinity);
      if(leader<this.g.finishAt-this.finishTriggerUnits())return false;
      /* ------------------- HUNT//REDLINE IS A THING THAT HAPPENS TO A LEADER
       *
       * The whole scene is Ryker taking a race the player had won: the opening
       * card reads THE ROOKIE LEADS, the camera is on a car in front, and the
       * R-IX is awarded at the end of it because the player showed the pace
       * Aurora wanted. Played from second it is none of those things - it is a
       * forty-second cinematic explaining that the man who was already beating
       * you has beaten you, followed by a prize.
       *
       * And it could not be declined: startFinish sets `won = false` on its
       * way in, so ASHFALL ZERO was a chapter with no losing condition at all.
       * Finish it second and you got the scene, the prototype, and no retry.
       *
       * So the last two hundred and fifty metres now ask who is in front. In
       * front, and the chapter ends the way it is written. Behind, and there
       * is no cinematic: the race runs to the line, the rival crosses it
       * first, and it is a lost race like any other lost race in this game.
       *
       * A car length of margin rather than zero, because a photo finish at the
       * trigger point is a race the player is still in and the scene is about
       * to take it off them anyway - which is the entire point of it. */
      if(this.g.rival && this.g.car.sTrack < this.g.rival.sTrack - 4) return false;
      return true;
    }

    finishOpening(gapM) {
      if(gapM>=50)return {key:'landslide',title:"THIS ONE'S OVER.",actor:'RYKER HAS NOTHING LEFT.',voice:'KAEL // THAT ISN\'T EVEN CLOSE.'};
      if(gapM>=10)return {key:'lead',title:'THE ROOKIE LEADS.',actor:'RYKER NEEDS A MIRACLE.',voice:'NOVA // HE DOESN\'T HAVE ENOUGH ROAD.'};
      if(gapM>-10)return {key:'even',title:'NOTHING BETWEEN THEM.',actor:'ONE LAST STRAIGHT.',voice:'SYNX GRID // POSITION UNRESOLVED.'};
      return {key:'ryker',title:'RYKER HAS THE ROAD.',actor:'THE ROOKIE IS STILL CLOSING.',voice:'SYNX GRID // FINAL SECTOR LIVE.'};
    }

    startFinish(originalFinish) {
      if(!this.isLevel5()||this.finishPending)return false;
      const g=this.g,r=g.rival||g.car;
      const gapUnits=g.car.sTrack-r.sTrack,gapM=gapUnits*EVENTS.finish.metresPerTrackUnit;
      const open=this.finishOpening(gapM);
      /* The scripted defeat, and the flag that says it was EARNED - see
         canonicalEarned in js/story.js. `won` is false because the player does
         lose this race; the chapter still completes, and that distinction is
         the whole of what this flag carries. */
      g.raceOver=true;g.state='cinematicFinish';g.won=false;
      if(g.story)g.story.canonicalEarned=true;
      this.finishPending=originalFinish||null;
      this.active={
        type:'finish',t:0,startS:g.car.sTrack,rivalStart:r.sTrack,
        playerSpeed:g.car.speed||g.car.vLong||55,rivalSpeed:r.speed||r.vLong||55,
        gapUnits,gapM,opening:open,
        beliefPlayerS:Math.max(g.car.sTrack,Math.min(g.finishAt-200,g.car.sTrack+125)),
        redlineStartS:Math.max(r.sTrack,Math.min(g.finishAt-185,r.sTrack+95)),
        ramPlayerS:Math.max(g.car.sTrack,g.finishAt-104),
        ramRivalS:Math.max(r.sTrack,g.finishAt-108),
        lastPlayerS:g.car.sTrack,lastRivalS:r.sTrack,impact:false,stage:false,
        prevAmb:g.scene.ambInt,prevSun:g.scene.sunInt,
      };
      this.show({kicker:'FINAL SECTOR // 250 METRES',title:open.title,actor:open.actor,hint:open.voice,finish:true});
      this.setTelemetry('LIVE GAP',[
        (gapM>=0?'PLAYER // 1ST':'RYKER // 1ST'),
        'RECORDED GAP // '+Math.abs(gapM).toFixed(0)+' M',
        'RACE CLOCK // FROZEN AT CINEMA ENTRY',
      ],true);
      if(g.audio&&g.audio.checkpoint)g.audio.checkpoint();
      return true;
    }

    requestFinish(originalFinish) {
      // Safety net for an old save or an enormous pre-trigger frame step. The
      // normal path starts 250 m early from shouldStartFinish().
      return this.startFinish(originalFinish);
    }

    setFinishCopy(kicker,title,actor,hint) {
      const D=this.dom||{};
      if(D.kicker)D.kicker.textContent=kicker||'';
      if(D.title)D.title.textContent=title||'';
      if(D.actor)D.actor.textContent=actor||'';
      if(D.hint)D.hint.textContent=hint||'';
    }

    emitRedline(a, intensity, vehicle) {
      const g=this.g,r=vehicle||g.rival;if(!g.fx||!r)return;
      const yaw=r.yaw||0,fx=Math.sin(yaw),fz=Math.cos(yaw),rx=Math.cos(yaw),rz=-Math.sin(yaw);
      const wanted=(.35+intensity*1.1)*(g.__lastLevel5Dt||1/60)*60;
      const count=Math.floor(wanted)+(Math.random()<wanted%1?1:0);
      for(let i=0;i<count;i++){
        const hot=Math.random()>.38,side=(Math.random()-.5)*3.1,rear=-2.7-Math.random()*2.5;
        g.fx.spawn({x:r.x+rx*side+fx*rear,y:r.y-.45+Math.random()*.7,z:r.z+rz*side+fz*rear,
          vx:-fx*(28+Math.random()*75)*intensity+rx*(Math.random()-.5)*12,vy:(Math.random()-.3)*5,
          vz:-fz*(28+Math.random()*75)*intensity+rz*(Math.random()-.5)*12,
          life:.14+Math.random()*.36,size:.25+Math.random()*.82,grow:.35,drag:1.0,gravity:-3.5,stretch:6.5,
          r:1,g:hot?.72:.015,b:hot?.30:.004,a:1.2+intensity*.8});
      }
    }

    setupRaptorStage(a) {
      if(a.stage)return;
      a.stage=true;
      const g=this.g,stageS=clamp(g.finishAt+112,g.startAt,g.track.length-36);
      g.storyRaptor={lift:g.car.lift||1.05,sTrack:stageS,x:0,y:0,z:0,yaw:0,pitch:0,roll:0};
      this.setVehicle(g.storyRaptor,stageS,0,0,0);
      g.storyRaptorCharge=0;
      this.world.setRaptorStage(g.storyRaptor);
    }

    finishCamera(a) {
      const g=this.g,car=g.car,rival=g.rival||car,t=a.t;
      let focus=car,yaw=focus.yaw||0,fx,fz,rx,rz,ex,ey,ez,tx,ty,tz,fov=58;
      const basis=()=>{yaw=focus.yaw||0;fx=Math.sin(yaw);fz=Math.cos(yaw);rx=Math.cos(yaw);rz=-Math.sin(yaw);};
      if(t<2.8){
        focus=car;basis();const q=smooth(t/2.8),lookBack=t>1.35&&t<2.25;
        if(lookBack){ex=car.x+fx*7;ey=car.y+2.0;ez=car.z+fz*7;tx=car.x-fx*42;ty=car.y+.7;tz=car.z-fz*42;fov=64;}
        else{ex=car.x-fx*mix(11,8,q)+rx*1.2;ey=car.y+mix(3.0,2.1,q);ez=car.z-fz*mix(11,8,q)+rz*1.2;tx=car.x+fx*17;ty=car.y+.7;tz=car.z+fz*17;fov=mix(66,72,q);}
      }else if(t<5.6){
        focus=rival;basis();const q=smooth((t-2.8)/2.8);
        ex=rival.x+rx*mix(4.6,-3.4,q)-fx*mix(3.2,6.5,q);ey=rival.y+mix(.35,1.55,q);ez=rival.z+rz*mix(4.6,-3.4,q)-fz*mix(3.2,6.5,q);
        tx=rival.x+fx*1.4;ty=rival.y-.05;tz=rival.z+fz*1.4;fov=mix(45,57,q);
      }else if(t<8.7){
        focus=car;basis();const q=smooth((t-5.6)/3.1);
        ex=car.x+fx*mix(9,5,q)+rx*.4;ey=car.y+1.65;ez=car.z+fz*mix(9,5,q)+rz*.4;
        tx=car.x-fx*mix(48,22,q);ty=car.y+.35;tz=car.z-fz*mix(48,22,q);fov=mix(49,62,q);
      }else if(t<10.7){
        focus=rival;basis();const side=Math.sin((t-8.7)*1.1)*.35;
        ex=rival.x+rx*(2.0+side)-fx*2.1;ey=rival.y-.12;ez=rival.z+rz*(2.0+side)-fz*2.1;
        tx=rival.x+fx*3.8;ty=rival.y-.28;tz=rival.z+fz*3.8;fov=72;
      }else if(t<13.15){
        focus=car;basis();const mx=(car.x+rival.x)*.5,mz=(car.z+rival.z)*.5;
        ex=mx+rx*8.2-fx*3;ey=car.y+3.2;ez=mz+rz*8.2-fz*3;tx=mx+fx*4;ty=car.y+.35;tz=mz+fz*4;fov=58;
      }else if(t<15.3){
        focus=car;basis();const q=smooth((t-13.15)/2.15),ang=mix(-.25,1.75,q),rad=mix(7.4,10.5,q);
        ex=car.x+Math.cos(ang)*rx*rad-Math.sin(ang)*fx*rad;ey=car.y+mix(2.8,6.0,q);ez=car.z+Math.cos(ang)*rz*rad-Math.sin(ang)*fz*rad;
        tx=car.x;ty=car.y+.45;tz=car.z;fov=mix(60,68,q);
      }else if(t<20.8){
        focus=t<18.0?car:rival;basis();const q=smooth((t-15.3)/5.5);
        ex=focus.x+rx*mix(-13,9,q)-fx*mix(7,12,q);ey=focus.y+mix(3.8,2.0,q);ez=focus.z+rz*mix(-13,9,q)-fz*mix(7,12,q);
        tx=focus.x+fx*2;ty=focus.y+.4;tz=focus.z+fz*2;fov=mix(60,48,q);
      }else{
        focus=g.storyRaptor||rival;basis();
        // Keep reveal lenses outside the donor body's 3.4 m bounds.  The old
        // macro shots intersected the mesh and briefly rendered its cross-section
        // as a long, thin slab before the rest of the car appeared.
        if(t<23.0){ex=focus.x+rx*4.9-fx*4.2;ey=focus.y+.62;ez=focus.z+rz*4.9-fz*4.2;tx=focus.x+rx*.55-fx*.35;ty=focus.y-.02;tz=focus.z+rz*.55-fz*.35;fov=42;}
        else if(t<25.4){const side=t<24.2?-1:1;ex=focus.x+rx*side*4.7+fx*.25;ey=focus.y+.72;ez=focus.z+rz*side*4.7+fz*.25;tx=focus.x+rx*side*.65-fx*.3;ty=focus.y;tz=focus.z+rz*side*.65-fz*.3;fov=43;}
        else if(t<27.8){ex=focus.x-fx*6.5+rx*.55;ey=focus.y+.78;ez=focus.z-fz*6.5+rz*.55;tx=focus.x-fx*.55;ty=focus.y-.02;tz=focus.z-fz*.55;fov=43;}
        else if(t<30.7){ex=focus.x+fx*7.2+rx*4.8;ey=focus.y+1.25;ez=focus.z+fz*7.2+rz*4.8;tx=focus.x+fx*.75;ty=focus.y-.08;tz=focus.z+fz*.75;fov=45;}
        else if(t<34.3){const q=(t-30.7)/3.6,ang=mix(-1.05,.72,q),rad=11.4;ex=focus.x-fx*Math.cos(ang)*rad+rx*Math.sin(ang)*rad;ey=focus.y+mix(1.65,4.4,q);ez=focus.z-fz*Math.cos(ang)*rad+rz*Math.sin(ang)*rad;tx=focus.x;ty=focus.y+.08;tz=focus.z;fov=47;}
        else{const q=clamp((t-34.3)/5.7,0,1);ex=focus.x+rx*mix(10,18,q)-fx*mix(4,13,q);ey=focus.y+mix(2,5,q);ez=focus.z+rz*mix(10,18,q)-fz*mix(4,13,q);tx=focus.x+fx*mix(7,18,q);ty=focus.y+.35;tz=focus.z+fz*mix(7,18,q);fov=mix(50,72,q);}
      }
      this.setEye(ex,ey,ez);g.target[0]=tx;g.target[1]=ty;g.target[2]=tz;g.fov=fov;
      this.applyCineShake(yaw,(t>=5.2&&t<14.5)?.035+(t>12.8?.09:0):t>34?.018:.007);
    }

    updateFinish(dt) {
      const g=this.g,a=this.active,D=this.dom||{};
      a.t+=dt;const t=a.t,finish=g.finishAt;
      let ps,rs,plat=-1.1,rlat=2.0;
      if(t<5.6){
        const q=smooth(t/5.6);
        ps=mix(a.startS,a.beliefPlayerS,q);
        rs=mix(a.rivalStart,a.redlineStartS,q);
      }else if(t<13.15){
        const q=smooth((t-5.6)/7.55);
        ps=mix(a.beliefPlayerS,a.ramPlayerS,q);
        rs=mix(a.redlineStartS,a.ramRivalS,q*q);
      }else if(t<15.8){
        const q=smooth((t-13.15)/2.65);
        ps=mix(a.ramPlayerS,Math.max(finish-18,a.ramPlayerS+86),q);
        rs=mix(a.ramRivalS,Math.max(finish+64,a.ramRivalS+172),q);
        plat=mix(-1.1,5.6,q)+Math.sin(q*Math.PI*5)*1.1*(1-q);
        rlat=mix(2.0,-.2,smooth(q/.24));
      }else{
        const q=clamp((t-15.8)/4.2,0,1);
        const p0=Math.max(finish-18,a.ramPlayerS+86),r0=Math.max(finish+64,a.ramRivalS+172);
        ps=mix(p0,Math.max(finish+28,a.ramPlayerS+170),smooth(q));
        rs=mix(r0,Math.max(finish+88,a.ramRivalS+210),smooth(q));
        plat=5.6-q*2.3;rlat=-.2;
      }
      ps=clamp(ps,g.startAt,g.track.length-8);rs=clamp(rs,g.startAt,g.track.length-8);
      const pSpeed=dt>0?clamp((ps-a.lastPlayerS)/dt,0,220):60,rSpeed=dt>0?clamp((rs-a.lastRivalS)/dt,0,360):60;
      this.setVehicle(g.car,ps,plat,pSpeed,t>=13.15&&t<15.8?.04:0);
      if(g.rival)this.setVehicle(g.rival,rs,rlat,rSpeed,0);
      if(t>=13.15&&t<16.4){
        const q=clamp((t-13.15)/3.25,0,1);
        g.car.yaw+=q*Math.PI*2.35;g.car.roll=Math.sin(q*Math.PI*3)*.12*(1-q*.55);
      }
      a.lastPlayerS=ps;a.lastRivalS=rs;

      if(t>=5.2&&t<17.8){this.emitRedline(a,clamp((t-5.2)/2.1,0,1));g.rival.boosting=true;}
      if(t>=13.15&&!a.impact){
        a.impact=true;g.flash=1;g.shake=1.15;if(g.audio&&g.audio.crash)g.audio.crash(1);
        if(g.fx&&g.fx.sparks){g.fx.sparks(g.car);if(g.rival)g.fx.sparks(g.rival);}
        if(D.root)D.root.classList.add('impact');
      }
      if(t>=20.8)this.setupRaptorStage(a);
      if(g.storyRaptor){
        let charge=t<27.6?0:t<30.2?smooth((t-27.6)/2.6):1;
        g.storyRaptorCharge=charge;
        if(t>=34.3){
          const q=clamp((t-34.3)/5.7,0,1),travel=18*q+165*q*q*q;
          this.setVehicle(g.storyRaptor,clamp(g.finishAt+112+travel,g.startAt,g.track.length-8),0,18+210*q*q,0);
          this.world.setRaptorStage(t<35.0?g.storyRaptor:null);
          if(g.fx&&q>.15)this.emitRedline(a,.35+q*.65,g.storyRaptor);
        }
      }

      this.commonCinematicTick(dt,false);
      if(t>=20.8){g.scene.ambInt=.34;g.scene.sunInt=.46;g.scene.level5BossLight=[.34,.38,.44];}
      this.finishCamera(a);
      this.setTimer(EVENTS.finish.duration-t);
      this.setCineStrength(t<5?.38:t<15.5?.82:t<20.8?.48:t<34.3?.64:.88);
      if(t<2.8){this.setFinishCopy('FINAL SECTOR // 250 METRES',a.opening.title,a.opening.actor,a.opening.voice);}
      else if(t<4.0){this.setFinishCopy('RYKER // INTERNAL','...AGAIN.','HUNT // ENERGY LOW','THE FINISH IS ALREADY IN SIGHT.');}
      else if(t<5.2){this.setFinishCopy('HUNT PROTOCOL','REDLINE?','CORE PROTECTION // ACTIVE','OVERRIDE MAY CAUSE TERMINAL POWERTRAIN FAILURE');this.setTelemetry('HUNT PROTOCOL',['NORMAL LIMITER ........ ACTIVE','CORE PROTECTION ....... ACTIVE','ENERGY ................ LOW'],true);}
      else if(t<8.6){this.setFinishCopy('LIMITER DISABLED // CORE PROTECTION DISABLED','HUNT//REDLINE','RYKER // NOT... AGAIN.','POWERTRAIN OUTSIDE SAFE OPERATING LIMITS');this.setTelemetry('REDLINE OVERRIDE',['OUTPUT ............... UNBOUNDED','TEMPERATURE .......... CRITICAL','STABILITY ............ FAILING'],true);if(D.root)D.root.classList.add('redline');}
      else if(t<11.8){const live=(g.car.sTrack-g.rival.sTrack)*EVENTS.finish.metresPerTrackUnit;this.setFinishCopy('SYNX GRID // LIVE','...WHAT?','THE GAP IS DISAPPEARING.','RYKER IS PHYSICALLY CLOSING THE DISTANCE');this.setTelemetry('LIVE GAP',['RYKER CLOSING // '+Math.max(0,live).toFixed(0)+' M','OUTPUT EXCEEDS HOMOLOGATED LIMITS','NOVA // HE\'S DESTROYING THE CAR.'],true);}
      else if(t<13.15){this.setFinishCopy('FINAL APPROACH','COME ON...','PLAYER BOOST // MAXIMUM','RYKER // ACTUALLY— I\'M NOT.');}
      else if(t<15.8){this.setFinishCopy('IMPACT // REAR QUARTER','RYKER!','CONTROL LOST','THE PLAYER HAD THE PACE. RYKER STOLE THE LINE.');}
      else if(t<18.2){this.setFinishCopy('OFFICIAL RESULT','RYKER CROSSES FIRST.','SILENCE ON THE GRID.','WHAT THE HELL WAS THAT?');}
      else if(t<20.8){this.setFinishCopy('RYKER // POWERTRAIN FAILURE','HUNT OFFLINE','THE OLD MACHINE DIED FOR THE RESULT.','PLAYER // YOU COULDN\'T BEAT ME.  RYKER // ...NO.');this.setTelemetry('TERMINAL FAILURE',['TRANSMISSION ......... OFFLINE','CORE TEMPERATURE ...... CRITICAL','PROPULSION ............ LOST'],true);}
      else if(t<23.0){this.show({kicker:'AURORA MOTORWORKS // PRIZE TRANSFER',title:'WINNER AUTHORIZATION ACCEPTED',actor:'HYDRAULIC LOCKS RELEASED',hint:'SOMETHING IS UNDER THE PLATFORM.',finish:true,raptor:true});this.setTelemetry('',[],false);if(D.root)D.root.classList.add('raptor');}
      else if(t<25.4){this.setFinishCopy('AURORA // PROTOTYPE HARDWARE','VECTOR IMPULSE','LATERAL PROPULSION VENTS // ONLINE','KAEL // ...OH.');}
      else if(t<27.8){this.setFinishCopy('AURORA // MOMENTUM DRIVE','KINETIC RETENTION','TWIN PROPULSION RINGS // ONLINE','MAXIMUM MOMENTUM // DATA UNAVAILABLE');}
      else if(t<30.7){this.setFinishCopy('AURORA EXPERIMENTAL VEHICLE','R-IX','PREDATOR OPTICS // ONLINE','DESIGNATION PENDING');}
      else if(t<34.3){this.setFinishCopy('','','MOMENTUM DRIVE // ONLINE  ·  VECTOR IMPULSE // ONLINE','RYKER // THIS IS YOUR PROBLEM.');this.setTelemetry('AURORA SYSTEM',['DRIVER LINK ........... RYKER','MOMENTUM DRIVE ......... ONLINE','VECTOR IMPULSE ......... ONLINE','ACTIVE AERO ............ ONLINE'],true);if(D.bossCard)D.bossCard.classList.add('show');}
      else if(t<37.4){this.setFinishCopy('LOW SPEED RESPONSE // SUBOPTIMAL','IT BUILDS.','KINETIC RETENTION // 99.7%','NOVA // WAIT.');this.setTelemetry('',[],false);if(D.bossCard)D.bossCard.classList.remove('show');}
      else{this.setFinishCopy('SYNX // CHAPTER 6','BROKEN CIRCUIT','AURORA FORGE // RECOVERY PROTOCOL','BEFORE YOU HUNT THE RAPTOR, YOU NEED A CAR THAT CAN SURVIVE IT.');this.setTelemetry('',[],false);if(D.bossCard)D.bossCard.classList.remove('show');}

      if(t>=EVENTS.finish.duration){
        const cb=this.finishPending;this.finishPending=null;this.active=null;this.world.hide();g.storyRaptor=null;g.storyRaptorCharge=0;
        g.scene.ambInt=a.prevAmb;g.scene.sunInt=a.prevSun;g.scene.level5BossLight=null;this.hide();
        g.won=false;if(cb)cb();
      }
      return true;
    }

    updateInteractive(dt) {
      if (!this.active) return false;
      if (this.active.type==='collapse') return this.updateCollapse(dt);
      if (this.active.type==='volcano') return this.updateVolcano(dt);
      if (this.active.type==='finish') return this.updateFinish(dt);
      return false;
    }

    afterNormalUpdate(dt) {
      if(!this.isLevel5()) return;
      this.updatePalette(dt);
      const p=this.g.progress||0;
      if(this.g.state==='racing' && !this.active){
        const reached=(id,at)=>p>=at && this.prevProgress<at;
        /* The set pieces are ROAD, not adjudication. The tower comes down and
           the caldera goes up where the track says they do, whoever is in
           front at the time - a cinematic that interrupts a race to tell the
           player they are losing it is the game answering a question nobody
           asked. Who won is settled at the finish line and nowhere else; see
           shouldStartFinish. */
        if(!this.collapseSeen && reached('collapse',EVENTS.collapse.trigger)) this.startCollapse();
        else if(!this.volcanoSeen && reached('volcano',EVENTS.volcano.trigger)) this.startVolcano();
      }
      this.prevProgress=p;
    }
  }

  NR.Level5Director=Director;
  NR.LEVEL5_CINEMATICS=[
    {id:'collapse',duration:EVENTS.collapse.duration,trigger:EVENTS.collapse.trigger,qte:'Q mash'},
    {id:'volcano',duration:EVENTS.volcano.duration,trigger:EVENTS.volcano.trigger,qte:'WASD sequence'},
    {id:'finish',duration:EVENTS.finish.duration,triggerMeters:EVENTS.finish.triggerMeters,qte:null},
  ];

  function director(g){if(!g.__level5Director)g.__level5Director=new Director(g);return g.__level5Director;}
  const GP=NR.Game.prototype;
  const oldUpdate=GP.update;
  GP.update=function(dt){
    // main.js starts the animation loop before the asynchronous scene load.
    // The Raptor reskin depends on the imported car draw lists, so wait until
    // those lists exist instead of constructing a half-loaded boss every frame.
    if(!this.scene||!this.scene.ready||!this.scene.carOpaque){oldUpdate.call(this,dt);return;}
    const d=director(this);
    if(d.isLevel5() && d.active && d.updateInteractive(dt)) return;
    if(d.shouldStartFinish()){
      d.startFinish(()=>oldFinish.call(this));
      d.updateInteractive(0);
      return;
    }
    oldUpdate.call(this,dt);
    // ...only if the world moved. See Game.simulating.
    if(this.simulating)d.afterNormalUpdate(dt);
  };

  const oldReset=GP.resetCar;
  GP.resetCar=function(){oldReset.call(this);if(this.__level5Director)this.__level5Director.reset();};
  const oldApply=GP.applyLevel;
  GP.applyLevel=function(){oldApply.call(this);if(this.__level5Director)this.__level5Director.reset();};
  const oldMenu=GP.toMenu;
  GP.toMenu=function(){oldMenu.call(this);if(this.__level5Director)this.__level5Director.reset();};
  const oldFinish=GP.finish;
  GP.finish=function(){const g=this,d=director(g);if(d.requestFinish(function(){oldFinish.call(g);} ))return;oldFinish.call(this);};

  global.__SYNX_LEVEL5__={
    name:'ASHFALL ZERO',mainCutscenes:3,
    collapseSeconds:EVENTS.collapse.duration,volcanoSeconds:EVENTS.volcano.duration,finishSeconds:EVENTS.finish.duration,
    collapseQTaps:EVENTS.collapse.targetTaps,volcanoCueCount:EVENTS.volcano.cueCount,
    noMicroCuts:true,daySkyAtVolcano:true,canonicalLoss:true,
    finaleTriggerMeters:EVENTS.finish.triggerMeters,raptorReveal:true,
  };
})(window);



/* ==========================================================================
 * CHAPTER 6 — AURORA FORGE / BROKEN CIRCUIT
 * ========================================================================== */
/* SYNX Chapter 6 — BROKEN CIRCUIT
 *
 * AURORA FORGE is a story-owned factory trial layered over the existing
 * Vehicle, Driver, camera, renderer and StoryManager. Nothing here creates a
 * second driving model: arc gates alter the normal input, the machinery uses
 * the normal track position, and raceMode extends the shipped boost reservoir
 * and velocity envelope instead of replacing them.
 *
 * Six trials, and every one of them is the same lesson from a different angle:
 * Aurora's line controller is a MODEL, models predict, and a driver it can
 * predict is a driver it can process. That is the sentence Chapter 7 is built
 * on, so the factory teaches it here rather than announcing it there.
 *
 *   01 LIGHTNING CRASH   thread the live arc walls
 *   02 COGNITION PRESS   the driver-link handshake, replayed under a press
 *   03 SORTING FLOOR     three chutes, one of them a car crusher
 *   04 SCRAP LINE        a stamping run and a magnet on a traverse
 *   05 GHOST LINE        be somewhere the model did not project you
 *   06 CALIBRATION       raceMode, and the hauler in the way of it
 */
(function (global) {
  'use strict';
  const NR = global.NR;
  if (!NR || !NR.Game || NR.Level6Director) return;
  const { M, M4 } = NR;
  const clamp = (v,a,b) => Math.max(a, Math.min(b,v));
  const smooth = v => { v=clamp(v,0,1); return v*v*(3-2*v); };

  /* The chapter, as distances. The factory course turns twice - a tight snake
     from 112.5 to 115.8 km and a wider set of six from 116.4 to 118.9 - and
     then runs dead straight to the end. The two trials that are about reading
     a corner sit in the corners; the four that are about reading a LANE sit on
     the straight, where a lane is a choice rather than an accident. */
  const START = 112080;
  const ELECTRIC_END = 115950;
  const MACHINE_END = 119050;
  const SORT_END = 122150;
  const SCRAP_END = 124450;
  const GHOST_END = 126450;
  /* HOW GOOD AURORA IS AT EACH ARCH. See Level6Director.updateGhost.
       track   how fast the drawn clamp damps onto its live aim, per second.
               Higher is a model that follows a steering input more tightly,
               so moving early buys less.
       commit  how far out it stops tracking. LOWER is harder - the window in
               which a jink cannot be answered opens later and is shorter.
       catch   half-width of the clamp, in units. The road is +-16.
       habit   how hard it leans on ghostHabit, the direction the player keeps
               escaping in. */
  /* THE COMMIT DISTANCES ARE IN SECONDS, REALLY.
     The trial caps the car at 132 km/h, which capFor turns into just about
     fifty units a second, so a commit of 62 is a window of 1.24s and one of 46
     is 0.92s. They were first written at 132..80 - between 2.6 and 1.6 seconds
     - and tools/smoke.py --probe ghost measured what that actually bought:
     full lock inside the window moved the car nineteen units sideways against
     a five-unit clamp. Four times more room than the escape needs is not a
     window, it is a formality, which is the thing this trial was being
     rebuilt to stop being.

     The second pass at them asked for seven units in 0.92s at the last arch,
     and the probe measured what the car can actually do from a standing
     lateral start: 4.6 units in 0.91. Not close. A trap the intended solution
     cannot beat is not hard, it is broken, and it would have shipped reading
     as "the last one always gets you".

     So the escape distances come off the measurement - about 5.05 units of
     lateral per second of window - and every tier is sized to be beatable with
     margin left over:

         tier  window   can move   must move   margin
           1    1.56s     7.9u       4.2u       3.7u
           2    1.44s     7.3u       4.4u       2.9u
           3    1.34s     6.8u       4.6u       2.2u
           4    1.24s     6.3u       4.8u       1.5u
           5    1.16s     5.9u       5.0u       0.9u

     The FIRST one is comfortable and the last one needs the input to be
     immediate. And that is only where the difficulty starts: the real ramp is
     `track` and `habit`. At tier five the clamp converges onto its aim in
     about a third of a second, so nothing done before the commit survives at
     all, and the habit term is nearly nine units wide across a full swing -
     which is more than the road has room for. Beating the last arch means
     going late AND going the way you did not go last time. */
  const GHOST_TIERS = [
    { track: 1.05, commit: 78, catch: 4.2, habit: 1.6 },
    { track: 1.45, commit: 72, catch: 4.4, habit: 2.3 },
    { track: 1.90, commit: 67, catch: 4.6, habit: 3.0 },
    { track: 2.40, commit: 62, catch: 4.8, habit: 3.7 },
    { track: 2.95, commit: 58, catch: 5.0, habit: 4.4 },
  ];
  // the tuning harness reads these; nothing in the game does
  global.__ghostTiers = GHOST_TIERS;
  const TEST_START = 126700;
  const TRUCK_S = 128200;
  const GATE_REVEAL_UNITS = 50 / .733;
  const DAMAGED_CAP = (100 / 3.6) / .733; // the physics world is .733 m/unit
  /* LOSING THE FORGE. `JAVAS_WARN` is where the chapter starts saying so and
     `JAVAS_GONE` is where it stops asking; the two hundred units between them
     are about four seconds at the trial's pace, which is long enough to be a
     warning and short enough not to be a second chance. `LOST_CARD` is how
     long TRIAL FAILED holds before js/story.js takes the frame back. */
  const JAVAS_WARN = 480, JAVAS_GONE = 680, LOST_CARD = 1.5;
  /* The phases the player has the car on this road. Everything else is a
     cinematic, a conversation, a rewind or the solo calibration run, and none
     of those is a thing that can be lost by being behind. */
  const LIVE_PHASES = new Set(['lightning', 'machinery', 'sorting', 'scrap', 'ghost']);
  const RACEMODE_CAP = (198 * .44704) / .733; // 50% above the observed 132 MPH limit
  /* The sorting floor's three chutes, and the walls between them. The road is
     forty units of tarmac inside a barrier at twenty, so three lanes wide
     enough to take a car at speed leaves the dividers at just under seven. */
  const CHUTE = [-13, 0, 13], DIVIDER = 6.8;
  /* THE BALERS THAT STAND IN THEM.
     `BORE_W` is the widest a machine can be without putting its parts in the
     bay next door: three of them at 12.4 leave two tenths of clear air
     between one platen and the next, and nothing any of them carries reaches
     past its own chute wall. At the seventeen and eighteen-four they were
     built at, every machine overlapped both its neighbours - which is a
     z-fight on three coplanar roofs as well as a lane full of somebody
     else's hydraulics.
     `BORE_CLEAR` is the height the bore is a clear tube to. Two of the three
     have to be driveable end to end - that is the trial - so everything that
     moves at idle lives above it, and only a machine that has actually taken
     a car puts anything on the floor.
     `COLUMN` is the outboard frame line, outside the twenty-unit barrier. */
  const BORE_W = 12.4, BORE_CLEAR = 2.0, JAW_HIGH = 3.95, COLUMN = 21.4;
  /* The two faces each bore presses between, which are the faces of its OWN
     bay: the road edge and the chute wall for the outer two, both chute walls
     for the middle one. A shoe placed a fixed distance from the machine's
     centre instead - which is how they were placed - lands in the next bay
     along for two of the three, and in the same half-metre of air as its
     neighbour's shoe for all three. */
  const BORE_FACE = [[-20.0, -8.4], [-5.2, 5.2], [8.4, 20.0]];
  /* How far from the centreline a car can reach on the Forge deck. LEVELS[5]
     names no driveHalf of its own, so it takes NR.DRIVE_HALF - and the scrap
     line has to solve against the same number the physics does, or a ram that
     is meant to cover the road leaves a lane down one edge of it. */
  const DRIVE_HALF6 = 18;

  function makeCube(gl) {
    const V=[],I=[], face=(n,a,b,c,d)=>{
      const o=V.length/8,pts=[a,b,c,d],uv=[[0,0],[1,0],[1,1],[0,1]];
      for(let i=0;i<4;i++)V.push(pts[i][0],pts[i][1],pts[i][2],n[0],n[1],n[2],uv[i][0],uv[i][1]);
      I.push(o,o+1,o+2,o,o+2,o+3);
    };
    face([1,0,0],[.5,-.5,-.5],[.5,-.5,.5],[.5,.5,.5],[.5,.5,-.5]);
    face([-1,0,0],[-.5,-.5,.5],[-.5,-.5,-.5],[-.5,.5,-.5],[-.5,.5,.5]);
    face([0,1,0],[-.5,.5,-.5],[.5,.5,-.5],[.5,.5,.5],[-.5,.5,.5]);
    face([0,-1,0],[-.5,-.5,.5],[.5,-.5,.5],[.5,-.5,-.5],[-.5,-.5,-.5]);
    face([0,0,1],[.5,-.5,.5],[-.5,-.5,.5],[-.5,.5,.5],[.5,.5,.5]);
    face([0,0,-1],[-.5,-.5,-.5],[.5,-.5,-.5],[.5,.5,-.5],[-.5,.5,-.5]);
    const vao=gl.createVertexArray();gl.bindVertexArray(vao);
    const vb=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,vb);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(V),gl.STATIC_DRAW);
    const ib=gl.createBuffer();gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,ib);gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,new Uint32Array(I),gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);gl.vertexAttribPointer(0,3,gl.FLOAT,false,32,0);
    gl.enableVertexAttribArray(1);gl.vertexAttribPointer(1,3,gl.FLOAT,false,32,12);
    gl.enableVertexAttribArray(2);gl.vertexAttribPointer(2,2,gl.FLOAT,false,32,24);
    gl.bindVertexArray(null);return{vao,vb,ib,count:I.length};
  }

  function makeRing(gl, outer, inner, depth, segments) {
    const V=[],I=[],n=segments||28,h=depth*.5;
    for(let i=0;i<n;i++){
      const a=i/n*Math.PI*2,c=Math.cos(a),s=Math.sin(a);
      for(const q of [[outer,h],[inner,h],[outer,-h],[inner,-h]])V.push(c*q[0],s*q[0],q[1],0,0,q[1]>0?1:-1,i/n,q[0]===outer?1:0);
    }
    const at=(i,j)=>(i%n)*4+j;
    for(let i=0;i<n;i++){const j=i+1;I.push(at(i,0),at(i,1),at(j,1),at(i,0),at(j,1),at(j,0));I.push(at(i,2),at(j,3),at(i,3),at(i,2),at(j,2),at(j,3));}
    const vao=gl.createVertexArray();gl.bindVertexArray(vao);
    const vb=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,vb);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(V),gl.STATIC_DRAW);
    const ib=gl.createBuffer();gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,ib);gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,new Uint32Array(I),gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);gl.vertexAttribPointer(0,3,gl.FLOAT,false,32,0);gl.enableVertexAttribArray(1);gl.vertexAttribPointer(1,3,gl.FLOAT,false,32,12);gl.enableVertexAttribArray(2);gl.vertexAttribPointer(2,2,gl.FLOAT,false,32,24);gl.bindVertexArray(null);
    return{vao,vb,ib,count:I.length};
  }

  /* `nrm` and `tiling` are optional and are what stop a surface reading as a
     coloured box. Every material in here shipped without either, so a wall, a
     press housing and a battery stack were the same flat plastic with three
     different colours on it - which is most of why the hall read as blocky
     however many boxes were put in it. The renderer already loads the map and
     already honours both fields. */
  function part(mesh,name,color,emis,gain,smoothness,metal,nrm,tile) {
    return{mesh:{iOff:0,vCount:24,name},sub:{start:0,count:mesh.count},mode:0,_mesh:mesh,
      mat:{name,tex:null,nrm:nrm||null,color:[color[0],color[1],color[2],1],tint:[.5,.5,.5,.5],emis:emis||[0,0,0],gain:gain||0,cutoff:.25,tiling:[tile?tile[0]:1,tile?tile[1]:1],offset:[0,0],_smooth:smoothness||.25,_metal:metal||.1}};
  }

  function scaled(out,x,y,z,yaw,pitch,roll,sx,sy,sz){
    M4.trs(out,x,y,z,yaw||0,pitch||0,roll||0);
    for(let i=0;i<4;i++)out[i]*=sx;for(let i=4;i<8;i++)out[i]*=sy;for(let i=8;i<12;i++)out[i]*=sz;
  }

  /* ------------------------------------------------------------ the hall --
   *
   * Two things were wrong with it, and the second one is why the first one
   * could not simply be patched.
   *
   * Every longitudinal member - the roof deck, the wall panelling, the crane
   * rails, the catwalks - was ONE BOX 176 units long, drawn once per 180-unit
   * bay. That leaves a four-unit slot in the roof and in both walls once a bay,
   * with the shipped landscape and the night sky visible through every one of
   * them: a hall with its roof off. And a straight box does not follow a road
   * that is turning. Aurora Forge opens with a snake of ten linked corners on a
   * hundred-and-fifty-unit radius, where the ends of a 176-unit box are
   * twenty-four units off the centreline they were placed against - so the wall
   * behind the player swung across the carriageway and the roof went with it.
   *
   * So the shell is built ONCE, as merged geometry walked along the actual
   * centreline, and cut into chunks the way js/scene.js cuts its dressing.
   * Runs are extruded cross-sections, sampled by curvature, so they bend with
   * the road and there is no seam anywhere in nineteen kilometres. Only the
   * things that MOVE - the cranes, the weld arcs, the press rams, the trial
   * hardware - are still drawn a piece at a time, and there are about forty of
   * those on screen rather than three thousand.
   *
   * The other half of "half open" was light. Unlit concrete fifteen units over
   * a hall whose only sources were a cyan strip on the floor is black, and
   * black overhead is sky. There are high-bay lamps in the roof now, a glazed
   * monitor along the ridge, and the deck is a material that knows the floor
   * under it is lit.
   */
  const HALL_FROM = 112000, HALL_TO = 131500, HALL_CHUNK = 1800;
  /* THE BREACH, declared in js/game.js because the solver is armed from the
     same numbers. See NR.FORGE_ROOF and the note above it. */
  const ROOF = NR.FORGE_ROOF
    || { foot: 128760, deck: 128900, edge: 129900, floor: 130060, h: 18,
         clearFrom: 128600, clearTo: 130220 };
  /* WHAT "EMPTY" MEANS, as one number.
     A member whose whole depth sits above this line is overhead: the roof, the
     purlins, the crane rails, the conveyor, the ducts, the trays, the high
     bays. Below it are the things that hold the building up and the things a
     driver passes at eye level - the walls reach 15.6 but start at 0.2, the
     columns are founded on the slab, the catwalk deck is at 6.1 and its
     handrail tops out at 7.9. So the rule cuts the services and leaves the
     structure, and it does it in two places rather than at thirty call sites.
     See FactoryWorld.buildBreach. */
  const BREACH_CLEAR = 8.0;

  class FactoryWorld {
    constructor(game) {
      this.g=game;this.sc=game.scene;this.gl=game.gl;this.cube=makeCube(this.gl);this.ring=makeRing(this.gl,.5,.34,.18,30);this.m=M4.make();
      this.steel=part(this.cube,'ForgeSteel',[.09,.11,.13],[.008,.014,.018],0,.38,.82,'speed_bump_normal.png',[3,3]);
      this.concrete=part(this.cube,'ForgeConcrete',[.16,.18,.19],[.004,.006,.007],0,.18,.05,'speed_bump_normal.png',[6,6]);
      /* The roof takes its own material. The hall's only other pale surface is
         the floor, which is lit from above by definition; a ceiling is lit by
         what bounces off that floor, and at this scale that is a small
         constant rather than anything worth marching a ray for. */
      this.roof=part(this.cube,'ForgeRoof',[.185,.195,.215],[.026,.031,.040],.10,.22,.08,'speed_bump_normal.png',[8,4]);
      this.deck=part(this.cube,'ForgeDeck',[.13,.14,.16],[.012,.016,.021],.04,.30,.30,'speed_bump_normal.png',[4,4]);
      this.glaze=part(this.cube,'ForgeGlazing',[.05,.10,.13],[.055,.14,.21],.16,.86,.06);
      this.yellow=part(this.cube,'ForgeSafety',[.30,.18,.026],[.34,.17,.014],.30,.30,.56);
      this.cyan=part(this.cube,'ForgeArc',[.008,.08,.11],[.04,.62,1.0],1.15,.65,.20);
      this.arc=part(this.cube,'ForgeArcWall',[.004,.055,.085],[.025,.31,.72],.62,.62,.18);
      this.red=part(this.cube,'ForgeDanger',[.075,.008,.006],[.38,.018,.006],.46,.58,.35);
      this.battery=part(this.cube,'ForgeBattery',[.035,.055,.065],[.02,.16,.20],.15,.48,.72,'speed_bump_normal.png',[2,3]);
      this.saw=part(this.cube,'ForgeSaw',[.22,.23,.24],[.035,.04,.045],.04,.52,.92,'speed_bump_normal.png',[2,2]);
      this.ringPart=part(this.ring,'ForgeMachineRing',[.12,.14,.15],[.03,.25,.30],.24,.55,.9,'speed_bump_normal.png',[4,1]);
      // Aurora's own house colours, shared with the Chapter 7 test deck so the
      // two Aurora properties read as one company rather than two art passes.
      this.aurora=part(this.cube,'AuroraPanel',[.055,.075,.090],[.010,.030,.042],.03,.62,.55,'speed_bump_normal.png',[5,2]);
      this.sign=part(this.cube,'AuroraSign',[.010,.10,.14],[.04,.52,.78],.62,.70,.15);
      this.hazard=part(this.cube,'ForgeHazardStripe',[.30,.19,.021],[.26,.125,.010],.30,.34,.40);
      /* The same yellow, as paint rather than as a lamp. Hazard banding down a
         wall is continuous, so it stays a run - but a continuous EMISSIVE run
         is a nineteen-kilometre neon tube, which is what it looked like. */
      this.hazardPaint=part(this.cube,'ForgeHazardPaint',[.34,.21,.024],[.020,.010,.001],.02,.30,.18,'speed_bump_normal.png',[10,1]);
      this.floorLamp=part(this.cube,'ForgeFloorLamp',[.20,.13,.02],[.28,.14,.017],.30,.42,.30);
      this.shell=part(this.cube,'ForgeBodyShell',[.045,.050,.060],[.006,.009,.012],0,.66,.74,'speed_bump_normal.png',[2,2]);
      this.lamp=part(this.cube,'ForgeWorkLamp',[.14,.15,.16],[.62,.68,.74],.90,.55,.20);
      this.bay=part(this.cube,'ForgeHighBay',[.16,.17,.18],[1.00,.95,.84],.92,.50,.22);
      this.weld=part(this.cube,'ForgeWeldArc',[.20,.17,.10],[1.00,.72,.28],1.40,.70,.10);
      this.pipe=part(this.cube,'ForgePipe',[.14,.15,.17],[.010,.014,.018],0,.46,.72,'speed_bump_normal.png',[6,1]);
      this.duct=part(this.cube,'ForgeDuct',[.19,.20,.22],[.014,.018,.024],0,.34,.55,'speed_bump_normal.png',[6,2]);
      this.tray=part(this.cube,'ForgeCableTray',[.11,.12,.13],[.010,.012,.016],0,.40,.60,'speed_bump_normal.png',[8,1]);
      this.crate=part(this.cube,'ForgeStock',[.22,.16,.07],[.030,.020,.008],.03,.30,.20,'speed_bump_normal.png',[2,2]);
      this.coil=part(this.cube,'ForgeCoil',[.24,.25,.27],[.020,.024,.030],0,.62,.95,'speed_bump_normal.png',[3,3]);
      this.green=part(this.cube,'ForgeClear',[.010,.075,.030],[.06,.90,.28],.80,.60,.20);
      this.amber=part(this.cube,'ForgeLive',[.10,.055,.006],[1.00,.44,.030],.95,.55,.25);
      this.sc.level6World=this;
      this.built=false;
    }
    /* The hall stands whenever the car is actually inside Aurora Forge.
       Chapter 6 runs it as a trial; a Free Roam tour drives straight through
       it, and a nineteen-kilometre production hall that vanishes because
       nobody is being tested in it would be a hole in the road.

       A tour asks the CAR where it is rather than asking which region owns it.
       drawStatic reaches about a kilometre and a half up the road, so keying
       this to the region boundary put the whole mouth of the building on the
       screen in one frame the instant the boundary was crossed. Coming on
       early instead lets the hall arrive out of the fog the way every other
       piece of the course does. */
    /* WHERE THE CAMERA IS, not what the game thinks it is doing.
       Nothing else in the course occupies 112-131 km, so a hall that stands
       whenever the view is inside it is right in every mode at once: the
       chapter, a Free Roam tour, and the idle camera that flies the Story hub
       and the title screen - which is why the menu backdrop used to be bare
       road with the Forge's palette on it after Chapter 6 had been played. */
    isOn(){const s=(this.g.distance!==undefined?this.g.distance:(this.g.car&&this.g.car.sTrack))||0;
      return s>HALL_FROM-2200&&s<HALL_TO+900;}
    at(s,lat,y,sx,sy,sz,p,yawOff,pitch,roll){
      const a=this.g.track.at(clamp(s,0,this.g.track.length-3),{}),rx=Math.cos(a.yaw),rz=-Math.sin(a.yaw);
      scaled(this.m,a.x+rx*(lat||0),y||0,a.z+rz*(lat||0),a.yaw+(yawOff||0),pitch||0,roll||0,sx,sy,sz);
      this.gl.bindVertexArray(p._mesh.vao);this.sc.drawPart(p,this.m);
    }

    // ------------------------------------------------------- the emitter --
    frame(s){
      const a=this.g.track.at(clamp(s,0,this.g.track.length-3),{});
      return {x:a.x,y:0,z:a.z,rx:Math.cos(a.yaw),rz:-Math.sin(a.yaw),fx:Math.sin(a.yaw),fz:Math.cos(a.yaw)};
    }
    /* One box, in the road's own frame at `s`: `w` across, `h` up, `len` along,
       optionally rolled about the along-road axis so a roof panel can have a
       pitch on it. */
    box(s,lat,y,w,h,len,roll){
      /* NOTHING OVERHEAD EXISTS INSIDE THE BREACH - except the thing that
         replaced it. Everything buildBreach emits is overhead and inside, so
         it sets `_raw` while it runs; without that exemption the set piece
         deletes itself and all that is left of the section is a hole. */
      if(!this._raw&&y-h*.5>BREACH_CLEAR&&this.cleared(s))return;
      const F=this.frame(s),c=Math.cos(roll||0),sn=Math.sin(roll||0);
      // the rolled cross-section basis
      const ax=F.rx*c,ay=sn,az=F.rz*c;              // across
      const ux=-F.rx*sn,uy=c,uz=-F.rz*sn;           // up
      const ox=F.x+F.rx*lat,oy=y,oz=F.z+F.rz*lat;
      const hw=w*.5,hh=h*.5,hl=len*.5;
      const P=(a,b,d)=>[ox+ax*hw*a+ux*hh*b+F.fx*hl*d,
                        oy+ay*hw*a+uy*hh*b,
                        oz+az*hw*a+uz*hh*b+F.fz*hl*d];
      const c000=P(-1,-1,-1),c100=P(1,-1,-1),c110=P(1,1,-1),c010=P(-1,1,-1);
      const c001=P(-1,-1,1),c101=P(1,-1,1),c111=P(1,1,1),c011=P(-1,1,1);
      const F4=(n,a,b,cc,d)=>this.quad(n,a,b,cc,d);
      F4([ax,ay,az],c100,c101,c111,c110);
      F4([-ax,-ay,-az],c001,c000,c010,c011);
      F4([ux,uy,uz],c010,c110,c111,c011);
      F4([-ux,-uy,-uz],c001,c101,c100,c000);
      F4([F.fx,0,F.fz],c101,c001,c011,c111);
      F4([-F.fx,0,-F.fz],c000,c100,c110,c010);
    }
    /* Emitted into the CURRENT material's bucket rather than into one index
       list. Interleaving materials as they are met produces a batch per
       switch - five hundred and forty of them in view at once, which is
       worse than the immediate-mode draw this replaced. Bucketing gives one
       batch per material per chunk: about sixteen, of which three chunks are
       ever in view. */
    quad(n,a,b,c,d){
      const V=this._V,o=V.length/8,I=this._bucket;
      const uv=[[0,0],[1,0],[1,1],[0,1]],p=[a,b,c,d];
      for(let i=0;i<4;i++)V.push(p[i][0],p[i][1],p[i][2],n[0],n[1],n[2],uv[i][0],uv[i][1]);
      I.push(o,o+1,o+2,o,o+2,o+3);
    }
    /* A longitudinal run, extruded along the centreline. This is the piece
       that could not be a box: it is sampled by CURVATURE, so a member that
       crosses one of the opening snake's hundred-and-fifty-unit corners bends
       with it instead of cutting the corner and standing in the road. */
    /* The frames a chunk's runs are extruded through, sampled ONCE per chunk
       by curvature and shared by all thirty of them. Sampling inside run()
       meant a hundred thousand centreline queries to build the hall. */
    sampleFrames(s0,s1){
      const out=[this.frame(s0)],step=6;
      let last=s0,turn=0,prevYaw=null;
      for(let s=s0;s<=s1;s+=step){
        const a=this.g.track.at(clamp(s,0,this.g.track.length-3),{});
        if(prevYaw!==null)turn+=Math.abs(M.angDiff(prevYaw,a.yaw));
        prevYaw=a.yaw;
        if(s-last>=180||turn>=.13){
          out.push({x:a.x,y:0,z:a.z,rx:Math.cos(a.yaw),rz:-Math.sin(a.yaw),fx:Math.sin(a.yaw),fz:Math.cos(a.yaw)});
          last=s;turn=0;
        }
      }
      if(last<s1-1)out.push(this.frame(s1));
      return out;
    }
    /* A longitudinal member, in two halves: the gate, and the extrusion.
       An overhead run that crosses the breach is emitted as the pieces either
       side of it, each with frames of its own - the chunk's shared frames
       cover the whole chunk and cannot describe a member with a hole in it. */
    run(s0,s1,lat,y,w,h,roll){
      if(!this._raw&&y-h*.5>BREACH_CLEAR&&s1>ROOF.clearFrom&&s0<ROOF.clearTo){
        const keep=this._frames;
        for(const[p,q]of[[s0,Math.min(s1,ROOF.clearFrom)],[Math.max(s0,ROOF.clearTo),s1]]){
          if(q-p<2)continue;
          this._frames=this.sampleFrames(p,q);
          this._extrude(lat,y,w,h,roll);
        }
        this._frames=keep;
        return;
      }
      this._extrude(lat,y,w,h,roll);
    }
    _extrude(lat,y,w,h,roll){
      const c=Math.cos(roll||0),sn=Math.sin(roll||0);
      const rings=this._frames.map(F=>{
        const ax=F.rx*c,ay=sn,az=F.rz*c,ux=-F.rx*sn,uy=c,uz=-F.rz*sn;
        const ox=F.x+F.rx*lat,oy=y,oz=F.z+F.rz*lat,hw=w*.5,hh=h*.5;
        const P=(a,b)=>[ox+ax*hw*a+ux*hh*b,oy+ay*hw*a+uy*hh*b,oz+az*hw*a+uz*hh*b];
        return {v:[P(-1,-1),P(1,-1),P(1,1),P(-1,1)],n:[[ax,ay,az],[ux,uy,uz]]};
      });
      for(let i=0;i<rings.length-1;i++){
        const A=rings[i],B=rings[i+1],n=A.n;
        this.quad([n[0][0],n[0][1],n[0][2]],A.v[1],B.v[1],B.v[2],A.v[2]);
        this.quad([-n[0][0],-n[0][1],-n[0][2]],B.v[0],A.v[0],A.v[3],B.v[3]);
        this.quad([n[1][0],n[1][1],n[1][2]],A.v[3],A.v[2],B.v[2],B.v[3]);
        this.quad([-n[1][0],-n[1][1],-n[1][2]],B.v[0],B.v[1],A.v[1],A.v[0]);
      }
    }

    // ------------------------------------------------------- the build ----
    /* Everything static in the hall, walked once along the centreline and
       merged. `use(part)` closes off whatever was being emitted and starts a
       new batch, so each chunk ends up as one draw per material. */
    build(){
      if(this.built)return;this.built=true;
      const gl=this.gl;this._V=[];this._I=[];this.batches=[];
      const buckets=new Map();
      const use=(p)=>{
        let b=buckets.get(p);
        if(!b){b=[];buckets.set(p,b);}
        this._bucket=b;
      };
      this.glowBatches=[];
      const drain=(into,c)=>{
        for(const [p,idx] of buckets){
          if(!idx.length)continue;
          const start=this._I.length;
          for(let i=0;i<idx.length;i++)this._I.push(idx[i]);
          into.push({p,start,count:idx.length,s0:c,s1:c+HALL_CHUNK});
        }
      };
      for(let c=HALL_FROM;c<HALL_TO;c+=HALL_CHUNK){
        const a=c,b=Math.min(HALL_TO,c+HALL_CHUNK)+2;   // overlap, so no seams
        /* The chunk's OWN span, without the overlap. Runs may be emitted
           twice at a seam and that is what the overlap is for; a set piece may
           not, so anything placed at a station asks this instead. */
        this._lo=c;this._hi=c+HALL_CHUNK;
        this._frames=this.sampleFrames(a,b);
        buckets.clear();
        use(this.steel);
        this.buildShell(a,b,use);
        this.buildDetail(a,b,use);
        this.buildBreach(a,b,use);
        /* Both mouths of the building, set a little inside the ends so the
           structure has hall on both sides of it. */
        this.buildPortal(HALL_FROM+40,1,use);
        this.buildPortal(HALL_TO-40,-1,use);
        drain(this.batches,c);
        /* THE FITTINGS, MERGED TOO.
           The high bays, the ridge rooflight, the wall channels and the floor
           lamps are at fixed stations with fixed geometry - they are as static
           as the walls they are bolted to. They were nonetheless issued one
           immediate-mode draw at a time, every frame, and `strip` subdivides
           each run on a bend, so a corner of the hall cost several hundred
           calls to draw a set of light fittings that never move. Baked into
           the same buffer they are six. */
        buckets.clear();
        this.buildLights(a,b,use);
        drain(this.glowBatches,c);
      }
      this._frames=null;this._bucket=null;

      const vao=gl.createVertexArray();gl.bindVertexArray(vao);
      const vb=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,vb);
      gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(this._V),gl.STATIC_DRAW);
      const ib=gl.createBuffer();gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,ib);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,new Uint32Array(this._I),gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);gl.vertexAttribPointer(0,3,gl.FLOAT,false,32,0);
      gl.enableVertexAttribArray(1);gl.vertexAttribPointer(1,3,gl.FLOAT,false,32,12);
      gl.enableVertexAttribArray(2);gl.vertexAttribPointer(2,2,gl.FLOAT,false,32,24);
      gl.bindVertexArray(null);
      this.vao=vao;this.verts=this._V.length/8;this.indices=this._I.length;
      this.identity=M4.identity(M4.make());
      this._V=null;this._I=null;
    }

    /* ------------------------------------------------- the working floor --
     *
     * The shell above is the BUILDING - walls, roof, trusses, services. What
     * it was missing is the FACTORY: the things that are only there because
     * somebody works here, and which every other route on this course has and
     * this one did not.
     *
     * Two problems, both about spacing. The bays that did exist were pitched
     * at 540, 720 and 1,440 units, and the draw window is 1,770 - so at any
     * moment the hall held about one of each with several hundred units of
     * bare wall between them. And outside the barrier there was no floor at
     * all: the slab stopped at the carriageway, so the wall met the generated
     * country instead of meeting a floor, which is the single thing that most
     * made a nineteen-kilometre production hall read as a corridor with a
     * picture of a factory on the side of it.
     *
     * All of this merges into the same chunk buffer as the shell, so the whole
     * of it costs no extra draw calls - only vertices, which is the cheap
     * axis. The hall draws in the same number of calls with it as without.
     */
    buildDetail(a,b,use){
      const S=(x)=>Math.ceil(a/x)*x;

      // --- the slab ---------------------------------------------------------
      /* A floor, out to the wall, both sides. Set a fraction below the road
         surface so the two never fight for the same pixel. */
      use(this.concrete);
      for(const side of[-1,1])this.run(a,b,side*24.6,-0.06,13.4,.30);
      /* The expansion joints across it. A flat grey strip nineteen kilometres
         long reads as a flat grey strip; the joints are what give it a scale
         and give the eye something to measure speed against. */
      use(this.hazardPaint);
      for(let s=S(30);s<b;s+=30)
        for(const side of[-1,1])this.box(s,side*24.6,.02,13.2,.06,.22);
      // the painted lane a working hall keeps clear along its walls
      for(const side of[-1,1]){
        this.run(a,b,side*19.35,.03,.34,.06);
        this.run(a,b,side*22.90,.03,.34,.06);
      }

      // --- the wall, at a spacing you actually meet -------------------------
      /* Every 45 units, alternating: a control cabinet with a live panel, or
         an extract fan and its cowl. Two variants on one pitch reads as
         equipment; one variant on one pitch reads as wallpaper. */
      for(let s=S(45);s<b;s+=45){
        const k=(s/45)|0;
        for(const side of[-1,1]){
          if((k+(side>0?1:0))%2===0){
            use(this.aurora);this.box(s,side*26.0,2.35,1.15,3.5,2.2);
            use(this.steel);this.box(s,side*25.3,3.20,.22,.9,1.5);
            use(this.green);this.box(s,side*25.28,3.20,.06,.34,.55);
          }else{
            use(this.steel);this.box(s,side*26.2,9.4,.9,2.6,2.6);
            use(this.duct);this.box(s,side*25.4,9.4,.9,1.9,1.9);
          }
        }
      }
      /* Bay numbering. A hall this long with nothing written on it is the
         other half of why it read as one corridor - there was no way to tell
         the twelfth kilometre from the third. */
      for(let s=S(180);s<b;s+=180){
        use(this.sign);
        for(const side of[-1,1])this.box(s,side*26.15,8.6,.10,1.5,3.0);
      }

      // --- goods doors ------------------------------------------------------
      /* A roller shutter, its guide rails and the loading apron inside it.
         Big, infrequent, and the thing that says the hall has an outside. */
      for(let s=S(360);s<b;s+=360){
        const side=((s/360)|0)%2?1:-1;
        /* Inboard of the wall panel, which spans 27.0 to 28.2 across. A
            shutter centred ON the wall shares a plane with it and the two
            flicker against each other at distance. */
        use(this.steel);
        this.box(s,side*26.4,3.4,1.0,6.9,9.2);
        for(const o of[-4.6,4.6])this.box(s+o,side*26.2,3.5,1.2,7.1,.5);
        this.box(s,side*26.2,7.15,1.2,.6,10.0);
        use(this.hazardPaint);
        this.box(s,side*22.0,.03,8.4,.06,9.0);
        use(this.amber);
        this.box(s,side*25.7,7.55,.5,.30,.5);
      }

      // --- the line overhead ------------------------------------------------
      /* An overhead conveyor: a rail down the hall with carriers hanging off
         it on a regular pitch. This is the piece that makes the roof read as
         machinery rather than as a lid, and it is what the wet floor picks up
         in the middle distance.

         At lateral 18.6, which is not where it wants to be aesthetically -
         the gantry crane in `moving` runs its carriage out to 15 either side
         with a body shell on the hoist at head height, so a fixed line
         anywhere inside that is something the crane drives through once a
         bay. Outboard of the carriage it hangs over the catwalk, which is
         where an overhead line goes in a building this shape anyway. */
      const CONV = 18.6;
      use(this.steel);
      for(const side of[-1,1])this.run(a,b,side*CONV,10.40,.30,.55);
      for(let s=S(9);s<b;s+=9){
        const k=(s/9)|0;
        for(const side of[-1,1]){
          use(this.steel);
          this.box(s,side*CONV,10.90,.16,.9,.16);
          if(k%3===0){
            // a carrier, with a body shell on it every third hook
            this.box(s,side*CONV,9.80,.90,1.3,.22);
            use(this.shell);this.box(s,side*CONV,9.20,1.9,.75,3.2);
          }
        }
      }
      // hangers all the way to the roof deck, so the rail hangs off something
      for(let s=S(36);s<b;s+=36){
        use(this.steel);
        for(const side of[-1,1])this.box(s,side*CONV,13.75,.18,6.7,.18);
      }

      // --- services, denser -------------------------------------------------
      /* Pipe runs with flanges on a spacing, and a compressed-air main. A
         straight tube nineteen kilometres long is a line; a tube with a
         fitting on it every twenty units is plant. */
      use(this.pipe);
      for(const side of[-1,1]){
        this.run(a,b,side*5.6,13.35,.34,.34);
        this.run(a,b,side*6.4,13.35,.26,.26);
      }
      for(let s=S(20);s<b;s+=20){
        use(this.steel);
        for(const side of[-1,1]){
          this.box(s,side*5.6,13.35,.50,.50,.30);
          this.box(s,side*6.4,13.35,.40,.40,.24);
        }
      }
      /* At 14.3: inboard of the shipped tray at 16.4 (which spans 15.45 to
         17.35) and outboard of the duct at 11.5, so the three of them read as
         three separate services rather than as one thick one. */
      use(this.tray);
      for(const side of[-1,1])this.run(a,b,side*14.3,12.55,1.1,.22);
      for(let s=S(24);s<b;s+=24){
        use(this.steel);
        for(const side of[-1,1])this.box(s,side*14.3,12.95,1.2,.80,.14);
      }

      // --- stock and plant, at half the old pitch ---------------------------
      /* The racking ran every 540 units. In a 1,770-unit window that is three
         of the same thing spread over a kilometre and a half of empty wall.
         It runs every 270 now, and the odd stations carry something else, so
         the repeat is 540 rather than 270 and it does not read as a pattern. */
      /* INSIDE THE BUILDING.
         The racking that was already here stood at lateral 29, and the wall
         panel spans 27.0 to 28.2 - so three levels of pallet racking, its
         uprights and every crate on it were behind an opaque wall, drawn
         every frame and visible from nowhere on the course. It stands on the
         floor between the barrier and the wall now, which is where a stores
         aisle goes and where it can actually be seen. */
      const RACK = 25.2;
      for(let s=S(270);s<b;s+=270){
        const odd=((s/270)|0)%2===1;
        for(const side of[-1,1]){
          if(!odd){
            use(this.steel);
            for(const lev of[1.6,4.2,6.8])this.box(s,side*RACK,lev,2.8,.30,44);
            for(const o of[-20,-7,7,20])this.box(s+o,side*RACK,4.2,2.9,8.4,.44);
            use(this.crate);
            for(const lev of[1.6,4.2,6.8])for(const o of[-15,0,15])
              this.box(s+o,side*RACK,lev+1.0,2.3,1.7,6.4);
          }else{
            /* A finished-goods bay: coil stock on end, a stillage stack and a
               works trolley. Different silhouette, same materials. */
            use(this.coil);
            for(const o of[-9,0,9])this.box(s+o,side*RACK,2.0,2.9,4.0,3.6);
            use(this.steel);
            for(const o of[-9,0,9])this.box(s+o,side*RACK,.20,3.3,.4,4.0);
            use(this.crate);
            for(const o of[-19,19])this.box(s+o,side*(RACK-.4),1.1,2.6,2.2,4.6);
            use(this.deck);this.box(s+24,side*23.0,.55,2.2,1.1,3.6);
          }
        }
      }

      // --- robot cells, between the presses ---------------------------------
      for(let s=S(360);s<b;s+=360){
        if(((s/360)|0)%2!==1)continue;
        for(const side of[-1,1]){
          /* A fenced pen with a manipulator in it. Static - the arcs that
             fire off one belong to `moving`. */
          use(this.steel);
          for(const o of[-3.4,3.4])this.box(s+o,side*24.6,1.6,4.4,3.2,.14);
          this.box(s,side*22.5,1.6,.14,3.2,6.8);
          this.box(s,side*24.6,1.05,1.5,2.1,1.5);
          this.box(s,side*24.6,2.60,2.6,.5,.5,side*.5);
          use(this.yellow);this.box(s,side*24.6,.28,4.6,.5,7.0);
          use(this.red);this.box(s,side*22.4,3.35,.10,.26,1.2);
        }
      }
    }

    buildShell(a,b,use){
      const S=(x)=>Math.ceil(a/x)*x;               // first multiple of x in range
      // --- walls, dado, skirt and the lit fascia --------------------------
      use(this.aurora);
      for(const side of[-1,1])this.run(a,b,side*27.6,7.9,1.2,15.4);
      use(this.concrete);
      for(const side of[-1,1])this.run(a,b,side*26.9,1.3,1.6,2.6);
      for(const side of[-1,1])this.run(a,b,side*22.8,.06,7.6,.12);
      /* Hazard banding is PAINT, and paint is not a light source. Kept as a
         run because a painted line down a wall genuinely is continuous, but
         with the gain taken out of it so it stops reading as neon. */
      use(this.hazardPaint);
      for(const side of[-1,1])this.run(a,b,side*26.4,2.78,.5,.34);
      for(const side of[-1,1])this.run(a,b,side*17.6,.07,2.2,.07);
      /* The wall fascia used to be a continuous lit line down both walls for
         the whole nineteen kilometres. On a corner that is a bright bar
         sweeping across the frame with nothing holding it up. It is a run of
         FITTINGS now - a dark channel with a lamp in it every twelve units -
         which is both what a factory looks like and what stops it reading as
         a stray line. The channel itself is unlit steel. */
      use(this.steel);
      for(const side of[-1,1])this.run(a,b,side*26.5,10.9,.30,.62);
      // --- the roof -------------------------------------------------------
      use(this.roof);
      for(const side of[-1,1])this.run(a,b,side*17.2,17.35,20.7,.55,side*-.0898);
      this.run(a,b,0,21.2,16.4,.55);
      use(this.glaze);
      for(const side of[-1,1])this.run(a,b,side*7.0,19.6,.55,3.0);
      /* The ridge is a ROOFLIGHT, not a neon tube. It used to be the sign
         material - a bright cyan line down the apex for the whole nineteen
         kilometres - which on a corner is one of the bars sweeping across the
         frame with nothing holding it up. Glazing, at a sixth of the gain. */
      use(this.glaze);
      this.run(a,b,0,20.84,2.6,.18);
      // purlins across the trusses
      use(this.steel);
      for(const x of[-24,-17,-10,0,10,17,24])this.run(a,b,x,16.55,.8,.8);
      for(const side of[-1,1])this.run(a,b,side*7.6,19.6,.35,3.2);
      // crane rails, which are steel, and were glowing
      use(this.steel);
      for(const side of[-1,1])this.run(a,b,side*10.8,12.8,.36,.38);
      // --- ceiling services ------------------------------------------------
      use(this.duct);
      for(const side of[-1,1])this.run(a,b,side*11.5,12.3,2.4,1.7);
      use(this.tray);
      for(const side of[-1,1])this.run(a,b,side*16.4,12.0,1.9,.36);
      /* The high-bay strips and the floor washers were continuous too. Both
         become fittings on a spacing below; what is left here is the dark
         housing they sit in. */
      use(this.tray);
      for(const side of[-1,1])this.run(a,b,side*16.4,12.30,1.5,.16);
      for(const side of[-1,1])this.run(a,b,side*20.9,.62,.26,.42);
      use(this.pipe);
      for(const side of[-1,1])this.run(a,b,side*4.6,12.8,.44,.44);
      // --- catwalks --------------------------------------------------------
      use(this.deck);
      for(const side of[-1,1])this.run(a,b,side*21.4,6.10,3.6,.36);
      /* A catwalk toe-board is painted steel and a catwalk handrail is
         steel. Both were emissive, so both were continuous amber lines the
         length of the hall at head height - two more bars going nowhere. */
      use(this.hazardPaint);
      for(const side of[-1,1])this.run(a,b,side*19.8,7.05,.18,1.55);
      use(this.steel);
      for(const side of[-1,1])this.run(a,b,side*19.8,7.82,.32,.20);
      use(this.steel);
      for(const side of[-1,1])this.run(a,b,side*23.1,7.05,.18,1.55);
      /* THE FITTINGS.
         What the four continuous lit strips above turned into: discrete
         luminaires on a twelve-unit spacing, placed with `box()` so each one
         is squared to the centreline where it actually stands rather than
         extruded down a kilometre of it. Dark between them, which is the
         whole point - a hall lit by fittings has shadow in it, and shadow is
         what was missing. */
      for(let s=S(16);s<b;s+=16){
        use(this.sign);
        for(const side of[-1,1])this.box(s,side*26.32,10.9,.10,.30,3.6);
        use(this.floorLamp);
        for(const side of[-1,1])this.box(s,side*16.4,12.20,1.30,.09,5.2);
      }
      for(let s=S(36);s<b;s+=36){
        use(this.floorLamp);
        for(const side of[-1,1])this.box(s,side*20.9,.62,.20,.30,2.2);
      }
      // --- per-station work ------------------------------------------------
      for(let s=S(90);s<b;s+=90){
        // columns, founded, with a haunch into the truss
        use(this.steel);
        for(const side of[-1,1]){
          this.box(s,side*25.5,7.8,1.7,15.6,1.7);
          this.box(s,side*24.4,13.5,3.6,.55,1.3,side*.42);
        }
        use(this.concrete);
        for(const side of[-1,1])this.box(s,side*25.5,.35,3.4,.7,3.4);
        // wall pilaster
        use(this.aurora);
        for(const side of[-1,1])this.box(s,side*26.6,7.6,1.0,14.6,2.4);
        // handrail stanchions, on the bay pitch
        if((s%180)<1){
          use(this.steel);
          for(const side of[-1,1]){this.box(s,side*19.8,6.95,.18,1.6,.18);this.box(s,side*23.1,6.95,.18,1.6,.18);}
        }
      }
      // --- roof trusses -----------------------------------------------------
      for(let s=S(180);s<b;s+=180){
        use(this.steel);
        this.box(s,0,13.3,54,.6,1.2);
        this.box(s,0,16.0,54,.6,1.2);
        for(let x=-24;x<=24;x+=12)this.box(s,x,14.65,.50,3.0,1.0);
        for(let x=-18;x<=18;x+=12)this.box(s,x,14.65,12.8,.34,.8,.52);
      }
      // --- high-bay lighting ------------------------------------------------
      for(let s=S(60);s<b;s+=60){
        const x=((s/60)|0)%2?9:-9;
        use(this.steel);this.box(s,x,11.9,2.3,1.0,2.3);
        use(this.bay);this.box(s,x,11.22,2.0,.32,2.0);
        use(this.steel);this.box(s,-x*.45,12.1,1.5,.8,1.5);
        use(this.bay);this.box(s,-x*.45,11.60,1.3,.26,1.3);
      }
      /* The stores aisle used to be here, at lateral 29 - which is OUTSIDE
         the wall panel at 27.0-28.2, so all of it was drawn every frame and
         visible from nowhere. It lives in buildDetail now, on the floor
         between the barrier and the wall, at half this pitch. Only the stair
         off the catwalk survives from this block, because that was the one
         part of it standing inside the building. */
      for(let s=S(540);s<b;s+=540){
        use(this.deck);
        for(const side of[-1,1])this.box(s+120,side*24.4,3.1,2.6,6.2,.9,side*.62);
      }
      // --- weld cells and press frames --------------------------------------
      for(let s=S(720);s<b;s+=720){
        for(const side of[-1,1]){
          use(this.steel);this.box(s+40,side*24.2,1.4,3.2,2.8,3.2);
          use(this.duct);this.box(s+40,side*24.2,9.4,4.4,1.6,4.4);this.box(s+40,side*24.2,10.9,1.5,2.0,1.5);
          use(this.yellow);this.box(s,side*23.6,4.2,3.4,6.4,3.4);
          // the stamping press: a founded bolster, a real frame, and a crown
          const L=side*27.4;
          use(this.concrete);this.box(s+120,L,.7,8.2,1.4,7.4);
          use(this.deck);this.box(s+120,L,6.4,7.2,11.4,1.5);this.box(s+120,L,12.3,8.0,1.6,7.6);
          use(this.steel);for(const f of[-3.0,3.0])this.box(s+120+f,L,6.4,1.6,11.4,1.6);
          use(this.deck);this.box(s+114.8,L,2.4,1.6,4.2,1.6);
          use(this.sign);this.box(s+114.8,L,3.9,1.2,.5,1.2);
        }
      }
      // --- Aurora portal gantries -------------------------------------------
      for(let s=S(1440);s<b;s+=1440){
        use(this.aurora);
        this.box(s,-22.5,6.6,1.9,13.2,2.6);this.box(s,22.5,6.6,1.9,13.2,2.6);
        this.box(s,0,12.9,48,1.9,2.6);
        use(this.sign);
        this.box(s,0,11.75,44,.26,2.9);
        this.box(s,-21.2,6.6,.24,12.4,2.9);this.box(s,21.2,6.6,.24,12.4,2.9);
        for(const side of[-1,1])this.box(s+4,side*21.0,9.4,.22,1.6,3.4);
      }
    }

    /* The light fittings. Everything here used to be re-issued per frame from
       `draw`; it is emitted once into the merged buffer instead. The runs are
       genuine extrusions along the centreline now rather than 182-unit boxes
       laid on the tangent, so they also stop cutting the corner on a bend. */
    buildLights(a,b,use){
      use(this.bay);
      for(let q=Math.ceil(a/60)*60;q<b;q+=60){
        const x=((q/60)|0)%2?9:-9;
        this.box(q,x,11.20,2.1,.30,2.1);
        this.box(q,-x*.45,11.58,1.4,.26,1.4);
      }
      use(this.sign);
      this.run(a,b,0,20.86,2.4,.14);
      for(const side of[-1,1])this.run(a,b,side*26.3,10.9,.32,.52);
      use(this.glaze);
      for(const side of[-1,1])this.run(a,b,side*7.0,19.6,.42,2.6);
      use(this.floorLamp);
      for(const side of[-1,1]){
        this.run(a,b,side*16.4,12.26,1.4,.09);
        this.run(a,b,side*20.9,.62,.22,.34);
      }
      use(this.hazard);
      for(const side of[-1,1]){
        this.run(a,b,side*19.8,7.05,.15,1.4);
        this.run(a,b,side*26.4,2.78,.46,.30);
      }
    }

    /* One merged batch list, drawn. `reach` is how far up the road to go:
       the full view distance for the frame the player sees, and a much
       shorter one for a 128-pixel reflection face. */
    drawBatches(list,s,back,fwd){
      for(const b of list){
        if(b.s1<s-back||b.s0>s+fwd)continue;
        this.sc.drawPart({mesh:{iOff:0,vCount:0,name:b.p.mat.name},sub:{start:b.start,count:b.count},
          mode:0,mat:b.p.mat,m:this.identity},this.identity);
      }
    }

    /* The shell, drawn. Two or three chunks a frame, one call per material. */
    /* ============================================== THE BROKEN ROOF ======
     *
     * A kilometre of the hall has lost its roof, and Aurora has run a steel
     * ramp up through the hole. The road carries straight on underneath; this
     * is a second line over the top of it, and both cars take it.
     *
     * Every mark comes from NR.FORGE_ROOF in js/game.js, which is also what
     * arms the solver - see the long note on it there. Nothing in this file
     * restates a distance.
     *
     * # The one rule that empties the hall
     *
     * Everything overhead inside the breach simply is not built: the roof
     * panels, the ridge, the purlins, the crane rails, the conveyor, the
     * ducts, the trays and the high bays. That is not thirty edits at thirty
     * call sites - it is one test in `box` and one in `run`, keyed on whether
     * the member's whole depth sits above BREACH_CLEAR. The walls, the floor,
     * the columns and the catwalks all reach below that line and stand; the
     * services all sit above it and go.
     *
     * Doing it as a rule rather than as a list is what makes it stay true.
     * Anything hung over this road later is cut here automatically, and a
     * gantry crane left standing in a section the car drives OVER is a
     * collision with something a kilometre up that nothing would have caught.
     */

    /** Is this station inside the breach - the roofless, emptied stretch? */
    cleared(s) { return s > ROOF.clearFrom && s < ROOF.clearTo; }

    /* The height of the running surface, and it has to be EXACTLY the profile
       the solver uses or the car drives through its own road. Smoothstep on
       the climb and on the descent, flat along the deck - see `Ramp` in
       crates/synx-core/src/vehicle.rs. */
    roofY(s) {
      const R = ROOF;
      if (s <= R.foot || s >= R.floor) return 0;
      if (s <= R.deck) {
        const u = (s - R.foot) / (R.deck - R.foot);
        return R.h * u * u * (3 - 2 * u);
      }
      if (s <= R.edge) return R.h;
      const v = (s - R.edge) / (R.floor - R.edge);
      return R.h * (1 - v * v * (3 - 2 * v));
    }

    /* A swept deck whose height follows a function of arc length.
     *
     * `run` cannot do this: a run is a constant-height extrusion, which is
     * right for every member in a building and wrong for the one thing here
     * that is a road. Clipped to the chunk being built, so the descent - which
     * crosses a chunk boundary - is emitted once rather than twice. */
    deckSweep(s0, s1, lat, w, thick, yAt, step) {
      const p = Math.max(s0, this._lo), q = Math.min(s1, this._hi);
      if (q - p < 0.5) return;
      const n = Math.max(2, Math.ceil((q - p) / (step || 7)));
      const rings = [];
      for (let i = 0; i <= n; i++) {
        const s = p + (q - p) * (i / n), F = this.frame(s), y = yAt(s);
        const ox = F.x + F.rx * lat, oz = F.z + F.rz * lat, hw = w * 0.5;
        rings.push({
          rx: F.rx, rz: F.rz, cx: ox, cy: y, cz: oz,
          v: [[ox - F.rx * hw, y - thick, oz - F.rz * hw],
              [ox + F.rx * hw, y - thick, oz + F.rz * hw],
              [ox + F.rx * hw, y, oz + F.rz * hw],
              [ox - F.rx * hw, y, oz - F.rz * hw]],
        });
      }
      for (let i = 0; i < rings.length - 1; i++) {
        const A = rings[i], B = rings[i + 1];
        /* The top face's normal is taken from the segment rather than assumed
           to be up: on the climb it is tilted by a seventh of a radian, and a
           deck lit as though it were flat reads as a decal on the air. */
        let fx = B.cx - A.cx, fy = B.cy - A.cy, fz = B.cz - A.cz;
        const fl = Math.hypot(fx, fy, fz) || 1;
        fx /= fl; fy /= fl; fz /= fl;
        const nx = fy * A.rz, ny = fz * A.rx - fx * A.rz, nz = -fy * A.rx;
        this.quad([nx, ny, nz], A.v[3], A.v[2], B.v[2], B.v[3]);
        this.quad([-nx, -ny, -nz], B.v[0], B.v[1], A.v[1], A.v[0]);
        this.quad([A.rx, 0, A.rz], A.v[1], B.v[1], B.v[2], A.v[2]);
        this.quad([-A.rx, 0, -A.rz], B.v[0], A.v[0], A.v[3], B.v[3]);
      }
    }

    /** A box only if this chunk owns the station - see deckSweep. */
    spot(s, lat, y, w, h, len, roll) {
      if (s < this._lo || s >= this._hi) return;
      this.box(s, lat, y, w, h, len, roll);
    }

    /* ------------------------------------------------- the set piece ---- */
    buildBreach(a, b, use) {
      const R = ROOF;
      if (b <= R.clearFrom || a >= R.clearTo) return;
      this._raw = true;
      try { this._breach(a, b, use); } finally { this._raw = false; }
    }

    _breach(a, b, use) {
      const R = ROOF;
      const S = (x, from) => Math.ceil(Math.max(a, from) / x) * x;
      const yAt = (s) => this.roofY(s);
      const DECK_W = 54;          // the car cannot pass 18 either side of centre

      // --- what is left of the roof, torn open ----------------------------
      /* The two ends of the hole. Purlin stubs bent down out of the cut, a
         ragged concrete lip, and cable that was carrying something. Without
         them the roof simply stops in mid-air, which reads as an unfinished
         model rather than as damage. */
      for (const [edge, dir] of [[R.clearFrom, 1], [R.clearTo, -1]]) {
        if (edge < a || edge >= this._hi) continue;
        use(this.roof);
        this.spot(edge - dir * 1.2, 0, 17.2, 56, 1.3, 2.6);
        use(this.steel);
        for (let i = -6; i <= 6; i++) {
          const lat = i * 4.3 + (i % 2 ? 0.8 : -0.6);
          const drop = 1.1 + Math.abs(Math.sin(i * 2.1)) * 3.4;
          this.spot(edge + dir * (1.4 + Math.abs(i) * 0.7), lat,
            16.4 - drop * 0.5, 0.42, drop, 0.42,
            (i % 3 - 1) * 0.30 * dir);
        }
        // the cut edge of the deck, bright where the steel is fresh
        use(this.hazardPaint);
        this.spot(edge - dir * 0.2, 0, 16.55, 56.4, 0.34, 0.5);
        // cable, still live, hanging out of the severed tray
        use(this.tray);
        for (const side of [-1, 1]) {
          this.spot(edge + dir * 2.0, side * 16.4, 11.1, 1.6, 2.4, 1.2, side * 0.5);
        }
        use(this.amber);
        for (const side of [-1, 1]) this.spot(edge + dir * 2.0, side * 16.4, 10.0, 0.5, 0.5, 0.5);
      }

      // --- the ramp, and what holds it up ---------------------------------
      /* The running surface first. It starts a little before the foot so the
         plate is seen to be laid ON the floor rather than growing out of it. */
      use(this.deck);
      this.deckSweep(R.foot - 7, R.deck, 0, DECK_W - 6, 1.15, yAt, 6);
      use(this.roof);
      this.deckSweep(R.deck, R.edge, 0, DECK_W, 1.5, yAt, 14);
      use(this.deck);
      this.deckSweep(R.edge, R.floor + 7, 0, DECK_W - 6, 1.15, yAt, 6);

      /* THE LEGS. A deck eighteen units up with nothing under it is a plank
         floating in a room, and the whole of what sells this as somebody's
         bodge is the scaffold holding it there. Four to a bent, cross-braced,
         and they stop where the deck starts rather than passing through it. */
      use(this.steel);
      const IN = 20.8, OUT = 24.6;   // both outboard of the barrier at twenty
      for (let s = S(24, R.foot); s < Math.min(b, R.floor + 8); s += 24) {
        const y = yAt(s);
        if (y < 0.7) continue;
        const stand = Math.max(0.4, y - 1.5);
        for (const side of [-1, 1]) {
          for (const lat of [IN, OUT]) this.spot(s, side * lat, stand * 0.5, 0.82, stand, 0.82);
          // the ties that make the pair a trestle rather than two stilts
          const ties = Math.max(1, Math.floor(stand / 5));
          for (let i = 1; i <= ties; i++) {
            this.spot(s, side * (IN + OUT) * 0.5, stand * (i / (ties + 1)),
              OUT - IN + 0.8, 0.42, 0.42);
          }
        }
        /* The transverse beam the deck sits on, and only where there is room
           under it: at the foot of the climb the deck IS the floor, and a beam
           below that is a beam in the ground. */
        if (y > 4.2) this.spot(s, 0, y - 1.85, OUT * 2 + 1.6, 0.55, 0.95);
      }

      // --- the kerbs, and the light on them -------------------------------
      /* Outboard of the barrier at twenty, so they are a boundary the eye
         reads rather than a wall the car finds. */
      const kerb = (s0, s1, w) => {
        for (const side of [-1, 1]) {
          use(this.hazardPaint);
          this.deckSweep(s0, s1, side * (w * 0.5 - 1.5), 2.4, 0.55,
            (s) => yAt(s) + 0.55, 7);
          use(this.steel);
          this.deckSweep(s0, s1, side * (w * 0.5 - 0.5), 0.5, 1.5,
            (s) => yAt(s) + 1.5, 7);
        }
      };
      kerb(R.foot - 7, R.deck, DECK_W - 6);
      kerb(R.deck, R.edge, DECK_W);
      kerb(R.edge, R.floor + 7, DECK_W - 6);

      // the edge tube, which is the one thing on this structure that is lit
      use(this.cyan);
      for (const side of [-1, 1]) {
        this.deckSweep(R.foot - 6, R.floor + 6, side * (DECK_W * 0.5 - 2.6), 0.30, 0.30,
          (s) => yAt(s) + 0.62, 9);
      }

      /* CHEVRONS, up the climb and down the slope. They are the reason a
         player reads the ramp as a thing to take rather than as scenery, and
         they are only on the two pitched sections - a flat roof does not need
         telling you which way is up. */
      use(this.yellow);
      for (const [s0, s1] of [[R.foot + 6, R.deck - 4], [R.edge + 6, R.floor - 4]]) {
        for (let s = S(14, s0); s < Math.min(b, s1); s += 14) {
          for (let i = -1; i <= 1; i++) {
            this.spot(s, i * 9.5, yAt(s) + 0.05, 7.0, 0.06, 1.5);
            this.spot(s + 1.6, i * 9.5, yAt(s + 1.6) + 0.05, 4.2, 0.06, 1.5);
          }
        }
      }

      // --- what is on the roof --------------------------------------------
      /* Plant, all of it outboard of twenty-two: the car is held inside
         eighteen by the same barrier it has everywhere else, so nothing here
         can be hit - it is there to make a roof read as a roof rather than as
         a wide grey road in the sky. */
      for (let s = S(56, R.deck); s < Math.min(b, R.edge); s += 56) {
        const k = (s / 56) | 0;
        for (const side of [-1, 1]) {
          if ((k + (side > 0 ? 1 : 0)) % 2 === 0) {
            // an air handling unit on its frame
            use(this.aurora); this.spot(s, side * 24.2, R.h + 1.9, 4.6, 2.8, 7.4);
            use(this.steel);
            this.spot(s, side * 24.2, R.h + 3.5, 4.0, 0.5, 6.6);
            this.spot(s - 2.6, side * 24.2, R.h + 4.4, 1.5, 1.6, 1.5);
            use(this.green); this.spot(s + 3.0, side * 24.2, R.h + 1.6, 0.3, 0.4, 0.4);
          } else {
            // an extract cowl and a run of duct going nowhere
            use(this.duct);
            this.spot(s, side * 23.6, R.h + 1.4, 2.4, 2.0, 2.4);
            this.spot(s + 6, side * 23.6, R.h + 2.3, 1.5, 1.5, 9.0);
            use(this.steel); this.spot(s, side * 23.6, R.h + 2.8, 3.0, 0.4, 3.0);
          }
        }
      }
      /* Aviation lamps, because the building has an outside now and something
         a kilometre long with a flat top on it carries them. 0.4 Hz, which is
         a beacon rather than a strobe - the same ceiling every other light in
         this game keeps. */
      for (let s = S(130, R.deck); s < Math.min(b, R.edge); s += 130) {
        use(this.steel);
        for (const side of [-1, 1]) this.spot(s, side * 26.6, R.h + 2.2, 0.34, 4.4, 0.34);
        use(this.red);
        for (const side of [-1, 1]) this.spot(s, side * 26.6, R.h + 4.5, 0.75, 0.6, 0.75);
      }
      /* THE SIGN. One of them, facing the way the cars arrive, which is what
         makes the top of the building a place rather than a surface. */
      if (R.deck + 150 >= this._lo && R.deck + 150 < this._hi) {
        const s = R.deck + 150;
        use(this.steel);
        for (const side of [-1, 1]) this.spot(s, side * 21.5, R.h + 5.4, 0.55, 10.6, 0.55);
        this.spot(s, 0, R.h + 10.4, 44, 0.6, 0.6);
        use(this.aurora); this.spot(s, 0, R.h + 8.2, 40, 3.4, 0.55);
        use(this.sign); this.spot(s - 0.35, 0, R.h + 8.2, 33, 1.6, 0.30);
      }

      /* GRATINGS. Four openings in the deck, hard outboard, where the hall
         below shows through - the one thing that says what the car is driving
         on top of. Outside the barrier, so they are a view rather than a
         hazard. */
      use(this.tray);
      for (let s = S(180, R.deck + 60); s < Math.min(b, R.edge - 40); s += 180) {
        for (const side of [-1, 1]) {
          this.spot(s, side * 23.0, R.h - 0.72, 6.0, 0.16, 12.0);
          for (let i = -2; i <= 2; i++) this.spot(s + i * 2.4, side * 23.0, R.h - 0.55, 6.2, 0.30, 0.22);
        }
      }
    }

    /* ------------------------------------------------ the end portals ----
     *
     * Both mouths of the hall, and they are the same structure mirrored.
     *
     * Aurora Forge used to simply BEGIN: nineteen kilometres of production
     * hall whose first bay was identical to its four hundredth, so arriving
     * at it read as the fog thinning rather than as entering a building. A
     * portal is the cheapest thing in architecture and the most effective -
     * a frame, a lintel deep enough to throw a shadow, the company's name on
     * it and a light either side saying whether you may come in.
     */
    buildPortal(s, dir, use) {
      if (s < this._lo || s >= this._hi) return;
      this._raw = true;
      try { this._portal(s, dir, use); } finally { this._raw = false; }
    }

    _portal(s, dir, use) {
      const B = (ds, lat, y, w, h, len, roll) => this.box(s + ds * dir, lat, y, w, h, len, roll);

      /* The head beam, and it is DEEP. A portal that is the same thickness as
         the wall it is cut into is a doorway; one with a metre and a half of
         structure over it is an entrance, and the depth is what the headlights
         rake across on the way in. */
      use(this.aurora);
      B(0, 0, 19.4, 64, 7.0, 7.0);
      B(0, -30.5, 9.0, 7.0, 14.0, 7.0);
      B(0, 30.5, 9.0, 7.0, 14.0, 7.0);
      /* The reveal: a second, slightly smaller frame set back inside the
         first, so the opening has a thickness rather than an edge. */
      use(this.concrete);
      B(-5.2, 0, 18.1, 58, 3.4, 2.4);
      for (const side of [-1, 1]) B(-5.2, side * 27.6, 8.6, 3.0, 16.0, 2.4);

      // the lintel's underside, lit, which is what puts the arch on the road
      use(this.cyan);
      B(-1.2, 0, 16.15, 54, 0.34, 0.9);
      for (const side of [-1, 1]) B(-1.2, side * 26.4, 8.4, 0.34, 15.2, 0.9);

      /* HAZARD BANDING down both jambs. Real, and the only warning a building
         this size gives a driver about how wide its door is. */
      use(this.hazardPaint);
      for (const side of [-1, 1]) {
        for (let i = 0; i < 9; i++) {
          B(-2.0, side * 28.6, 1.4 + i * 1.75, 0.5, 0.95, 2.0, 0.5);
        }
      }

      // the name, on the beam, facing the way the cars come
      use(this.steel);
      B(-3.6, 0, 22.4, 46, 0.7, 0.7);
      B(-3.6, 0, 26.0, 46, 0.7, 0.7);
      use(this.aurora);
      B(-3.7, 0, 24.2, 42, 3.2, 0.6);
      use(this.sign);
      B(-4.05, 0, 24.2, 34, 1.5, 0.30);
      /* ...and a second, smaller plate under it. Two lines of type is a
         company; one is a label. */
      use(this.amber);
      B(-4.05, -14.5, 21.6, 5.0, 0.55, 0.28);
      B(-4.05, 14.5, 21.6, 5.0, 0.55, 0.28);

      /* THE SIGNALS. One either side, at the height a driver looks, and they
         are the thing that makes a portal read as controlled access rather
         than as a hole. Green on the way in, red behind. */
      use(this.steel);
      for (const side of [-1, 1]) {
        B(3.4, side * 24.6, 5.2, 1.1, 10.4, 1.1);
        B(3.4, side * 22.9, 9.6, 3.4, 1.9, 1.4);
      }
      use(dir > 0 ? this.green : this.red);
      for (const side of [-1, 1]) B(3.2, side * 22.9, 9.6, 2.4, 1.1, 0.4);

      /* The apron: a painted threshold across the road, which is what tells
         you the surface under the car has just changed owner. */
      use(this.hazardPaint);
      for (let i = -1; i <= 1; i += 2) B(i * 3.2, 0, 0.05, 44, 0.10, 1.6);
      use(this.yellow);
      B(0, 0, 0.06, 44, 0.10, 0.7);
    }

    drawStatic(s,back,fwd){
      this.gl.bindVertexArray(this.vao);
      this.drawBatches(this.batches,s,back===undefined?620:back,fwd===undefined?1150:fwd);
    }

    /* THE HALL, INTO A REFLECTION FACE.
     *
     * The probe captures six 128-pixel faces every frame to keep the
     * reflections live. `drawWorld` has its own tight budget for that and
     * returns early - but the Chapter 6 hook ran AFTER it and drew the whole
     * building anyway, apparatus, cranes and all, six more times a frame.
     * Measured, that was 3,755 of the level's 4,701 draw calls: the hall cost
     * eight times what any other level does, and four fifths of it was going
     * into a cube nobody looks at directly.
     *
     * What a reflection actually needs from this room is the shell around the
     * car and the lights in it, so that is what it gets - two chunks and the
     * fittings, about a dozen calls. */
    drawProbe(s){
      const gl=this.gl;
      this.build();
      gl.enable(gl.DEPTH_TEST);gl.depthMask(true);gl.disable(gl.BLEND);
      this.drawStatic(s,220,420);
      gl.enable(gl.BLEND);gl.blendFunc(gl.SRC_ALPHA,gl.ONE);gl.depthMask(false);
      gl.bindVertexArray(this.vao);
      this.drawBatches(this.glowBatches,s,220,420);
      gl.depthMask(true);gl.disable(gl.BLEND);
      gl.bindVertexArray(this.sc.vao);
    }

    /* `strip` used to live here: a longitudinal member laid down as a chain
       of short boxes, subdivided on a bend so its ends did not swing wide of
       the carriageway. Every one of its callers was a light fitting drawn
       per frame, and all of them are baked into the merged buffer by
       buildLights now - where `run` extrudes the same member through frames
       sampled by curvature, which follows the road exactly rather than
       approximately. Nothing calls it, so it is gone. */

    /* What moves. About forty pieces on screen, which is what immediate mode
       is for. */
    moving(s){
      const t=this.g.time;
      const lo=Math.floor((s-500)/180)*180,hi=s+900;
      for(let q=lo;q<=hi;q+=180){
        if(q<HALL_FROM||q>HALL_TO)continue;
        /* AND NOTHING MOVING IN THE BREACH.
           A gantry crane straddles the hall at twelve units and runs its
           carriage out to fifteen either side; the car is eighteen units up
           and directly over it. The margin covers the crane's own travel,
           which carries it 120 units past the bay it belongs to. */
        if(q>ROOF.clearFrom-220&&q<ROOF.clearTo+220)continue;
        const bay=(q/180)|0;
        if(bay%2===0){
          /* A gantry crane straddling the hall with a body shell on the hoist.
             The shell used to hang at 3.5 and swing out to lateral 13, which
             is a car-shaped object crossing the carriageway at car height once
             a bay - it hangs clear of the corridor now. */
          const phase=Math.sin(t*.22+bay)*.5+.5,carriage=(phase-.5)*30,qs=q+phase*120;
          this.at(qs,0,12.05,54,1.15,2.4,this.steel);
          this.at(qs,0,12.75,54,.3,.9,this.yellow);
          this.at(qs,carriage,11.3,3.6,2.0,3.2,this.yellow);
          this.at(qs,carriage,10.0,.30,2.4,.30,this.steel);
          this.at(qs,carriage,8.75,4.6,1.5,2.6,this.shell);
          this.at(qs,carriage,9.55,3.0,.55,2.0,this.shell);
        }
        if(bay%4===0){
          for(const side of[-1,1]){
            const swing=Math.sin(t*1.6+bay*.7+(side>0?1.9:0));
            this.at(q+40,side*24.2,4.1,.62,4.0,.62,this.steel,0,0,swing*.26);
            this.at(q+40,side*(24.2-swing*2.2),5.9,2.8,.48,.48,this.steel,0,swing*.3);
            if(((t*2.2+bay)%3)<1.1)this.at(q+40,side*(22.7-swing*2.2),5.4,.5,.5,.5,this.weld);
          }
          for(const side of[-1,1]){
            const stroke=Math.max(0,Math.sin(t*1.1+bay*1.3+(side>0?2.1:0))),L=side*27.4;
            this.at(q+120,L,3.6+stroke*2.8,6.0,1.7,5.6,this.steel);
            this.at(q+120,L,3.6+stroke*2.8,6.2,.22,5.8,this.hazard);
            this.at(q+120,L,2.05,7.0,.24,6.6,stroke>.55?this.amber:this.green);
          }
        }
      }
    }

    electricGate(gate) {
      const left=-18,right=18,half=gate.gapW*.5,gs=gate.gap-half,ge=gate.gap+half;
      // The frame is visible machinery; only its live arc is the ambush. It
      // rises in about a tenth of a second once the player crosses 50 metres.
      this.at(gate.s,-19,3.8,.55,7.6,.75,this.yellow);this.at(gate.s,19,3.8,.55,7.6,.75,this.yellow);
      this.at(gate.s,0,7.6,39,.55,.65,this.steel);
      if(gate.open||!gate.live)return;
      const pop=smooth(gate.pop||0),height=6.8*pop;
      const grid=(a,b)=>{
        if(b-a<=.4)return;
        for(let y=.35;y<=height;y+=.72)this.at(gate.s,(a+b)*.5,y,b-a,.055,.13,this.arc);
        for(let x=a+.45;x<b;x+=2.2)this.at(gate.s,x,height*.5,.055,height,.13,this.arc);
      };
      grid(left,gs);grid(ge,right);
    }

    machine(h,i) {
      if(h.open)return;
      const t=this.g.time;
      if(h.type==='saw'){
        const roll=t*5.5;
        this.at(h.s,0,2.0,14,.32,.7,this.saw,0,0,roll);this.at(h.s,0,2.0,.32,14,.7,this.saw,0,0,roll);
        this.at(h.s,0,2.0,4.2,4.2,.5,this.ringPart);
        this.at(h.s-3,0,5.6,15,.5,.6,this.deck);
        this.at(h.s-3,0,4.9,13,.22,.7,this.sign);
      }else if(h.type==='battery'){
        for(const x of [-8.4,0,8.4])this.at(h.s,x,2.1+Math.sin(t*2+x)*.35,5.4,4.2,3.8,this.battery);
        this.at(h.s,0,7.0,31,.7,1.1,this.red);
      }else{
        for(const x of [-9,0,9]){
          this.at(h.s,x,1.0,5.8,1.25,2.8,this.concrete,Math.PI*.5,0,(x/9)*.05);
          this.at(h.s,x-1.8,.45,1.0,1.0,.28,this.ringPart,Math.PI*.5);this.at(h.s,x+1.8,.45,1.0,1.0,.28,this.ringPart,Math.PI*.5);
        }
      }
    }

    /* --------------------------------------------------- the sorting floor --
       Three chutes and two walls, and NOTHING that says which of them feeds
       the baler.

       It used to say so four times over - a red pip on a gantry board, red
       paint down the deck, a red plate at the chute mouth, and the press
       itself - which made the trial "look up, then steer" and meant nobody
       ever looked at the factory they were driving through. All three chutes
       now carry the same amber plate and the same number. The only thing in
       the hall that knows is the machine, working its cycle down the live
       chute where anyone who looks past the end of their bonnet can see it,
       and it is a long way down a narrow corridor at a hundred km/h.

       The confirmation comes at the mouth, twenty units after the walls have
       closed either side of the car: too late to be a warning, which is the
       point of it. */
    sortGate(g) {
      const t=this.g.time;
      this.at(g.s-300,-24,7.4,2.4,14.6,2.4,this.aurora);this.at(g.s-300,24,7.4,2.4,14.6,2.4,this.aurora);
      this.at(g.s-300,0,13.2,52,3.4,2.6,this.aurora);
      this.at(g.s-300,0,13.2,48,2.4,.24,this.sign);
      // three identical bay plates. No pip is lit, because the board is not
      // wired to the line: it never was, it only ever said "SORT".
      for(let i=0;i<3;i++){
        this.at(g.s-300.4,CHUTE[i],13.2,7.6,1.5,.22,this.amber);
        this.at(g.s-300.6,CHUTE[i],13.2,6.2,.9,.24,this.sign);
      }
      // the chute walls, in segments so they follow the road
      for(const side of[-1,1])for(let o=-140;o<=200;o+=20){
        this.at(g.s+o,side*DIVIDER,2.2,3.2,4.4,21,this.deck);
        this.at(g.s+o,side*DIVIDER,4.62,3.4,.5,21,this.hazard);
      }
      // identical deck paint and an identical bay marker down all three
      for(let i=0;i<3;i++){
        for(let o=-360;o<-20;o+=30)this.at(g.s+o,CHUTE[i],.11,7.0,.06,22,this.deck);
        this.at(g.s-24,CHUTE[i],2.6,8.4,.5,.8,this.amber);
      }
      /* THE MOUTH. Inside the last twenty units the live chute finally admits
         what it is - a strobe on the wall and the interlock going over - and
         by then there is a wall on both sides of the car. */
      const near=this.g.car?this.g.car.sTrack:0;
      if(!g.resolved&&near>g.s-52&&Math.sin(t*22)>0){
        this.at(g.s-16,CHUTE[g.live],3.4,8.0,1.1,.5,this.red);
        for(const side of[-1,1])this.at(g.s-8,CHUTE[g.live]+side*5.6,3.0,.5,2.2,1.0,this.red);
      }
      this.baleYard(g);
      this.crushers(g);
    }

    /* ------------------------------------------------------ the bale yard --
     *
     * WHAT CAME OUT OF THE MACHINES, AND WHERE IT WAS PUT.
     *
     * Each baler used to stack its own output ten units past its own bore -
     * which is to say ON THE CARRIAGEWAY, in the lane the car has already
     * committed to, as three boxes with no collider in them. So the one piece
     * of scenery in this hall a player is guaranteed to meet is the one piece
     * they drive straight through, immediately after being crushed or not
     * crushed by the machine in front of it. Decoration in the racing line
     * costs more than it gives: it is the thing that proves the factory is
     * not solid, and it was reported as exactly that.
     *
     * A scrap line does not stack bales in the chute. It stacks them at the
     * side of the floor where a loader can reach them, so that is where they
     * are: outboard of the gantry legs at +-26, past the machines, on ground
     * no car on this road can get to. Three courses high, staggered, with a
     * few degrees of lean on each - a stack that was built by a machine and
     * left, rather than a row of boxes.
     *
     * The machine still reads as a baler without them. It has a platen, a
     * jaw plate, hazard stripes and an interlock beacon, and it works its
     * cycle in front of you; what it does not need is its product in your
     * lane. */
    baleYard(g){
      for(const side of[-1,1]){
        for(let r=0;r<3;r++)for(let k=0;k<3-r;k++){
          const lean=(((r*3+k)*37)%7-3)*.035;
          this.at(g.s+188+k*7.4,side*(26.4+r*.5),1.05+r*2.05,
            5.0,1.9,6.4,this.shell,lean*.4,0,lean);
        }
      }
    }

    /* The car crushers. THERE ARE THREE OF THEM NOW, and that is the fix.
     *
     * Reported: the sorting trial is readable from the far end of the hall,
     * and not from anything the design intended.
     *
     * There was ONE baler and it stood in the live chute. Measured: its frame
     * crown sits at y=12.6, its hazard cap at 13.5 and its beacon at 14.1. The
     * chute walls that are supposed to hold the answer are 4.62 high. So nine
     * units of moving machinery stood above the wall line in exactly one of
     * the three bays, three hundred units before the player has to commit -
     * and the amber bay plates, which were deliberately made identical so that
     * nothing would give it away, were answering a question the silhouette had
     * already settled. The moving parts were the loudest thing on the skyline.
     *
     * A scrap line has a baler on every chute. All three are built, all three
     * run the SAME cycle off the same clock, and above the wall line they are
     * indistinguishable - same frame, same crown, same platen, same stroke.
     *
     * What is left to read is INSIDE the bore, which is where the design
     * always meant the answer to be: the live chute's chamber lamps are lit
     * and its jaw plate is hot; the two dead ones are dark and their jaws are
     * cold steel. Both of those parts sit BELOW the wall line. That is plainly
     * visible a long
     * way down a narrow corridor to a driver who looks into it, it is nothing
     * at all to a driver reading the skyline, and it cannot be had from the
     * silhouette - which is the whole difference between a trial and a tell.
     */
    crushers(g) {
      /* THE FRAME IS SHARED, AND IT STANDS WHERE A COLUMN CAN STAND.
         Four column lines - the two chute walls and the two road edges -
         carrying one gantry roof and the hydraulics for all three machines.
         Each baler used to bring its own pair of legs at +-8.4 from its own
         centre and its own roof at 18.4 wide, which put two of the six legs
         and two of the six ram cylinders inside the CENTRE bay at windscreen
         height, another four 0.9 into the outer bays, and three coplanar
         roofs on top of each other. None of it had a collider - see
         obstacles() - so the car drove through all of it. */
      const s = g.s + 150;
      for (const lp of [-COLUMN, -DIVIDER, DIVIDER, COLUMN]) {
        for (const o of [-15, 15]) this.at(s + o, lp, 6.2, 1.9, 12.4, 1.9, this.deck);
        // the ram cylinder, buried in the wall the ram pushes off
        this.at(s, lp, 3.9, 2.6, 3.0, 3.0, this.steel);
      }
      // one roof over the whole floor, rather than three fighting for the pixel
      this.at(s, 0, 12.6, 2 * COLUMN + 1.9, 1.6, 34, this.deck);
      this.at(s, 0, 13.5, 2 * COLUMN - 2.4, .34, 30, this.hazard);
      for (let i = 0; i < 3; i++) this.crusher(g, i);
    }
    /* One baler. `live` decides whether it is LIT and whether it crushes. It
       never decides whether the machine is there, and it never decides how it
       moves: both of those were the giveaway. */
    crusher(g, chute) {
      const live=chute===g.live;
      const x=CHUTE[chute],s=g.s+150,t=this.g.time;
      /* One clock for all three. Not a per-chute phase: three balers on
         visibly different strokes is the same tell in a quieter voice, because
         the player only has to learn which stroke belongs to the live one. */
      const cyc=(t*.55)%1;
      const jaw=(live&&g.crush)?clamp(g.crushT/.55,0,1)
        :(cyc<.34?smooth(cyc/.34):cyc<.62?1:1-smooth((cyc-.62)/.38));
      const side=(live&&g.crush)?smooth(clamp((g.crushT-.5)/1.1,0,1)):jaw*.30;
      const top=(live&&g.crush)?smooth(clamp((g.crushT-1.55)/1.05,0,1)):jaw*.26;
      /* THE FLOOR OF THE BORE IS THE ROAD.
         It used to be a slab standing 1.1 above it, seventeen wide and
         thirty-four long, with no collider in it - a kerb the car could see
         and went straight through, in the one place on this road where the
         player is looking hardest at what is directly in front of them. It is
         a painted apron now, flush with the tarmac, exactly like the bay paint
         that leads into it. The threshold at each end is PAINTED rather than
         proud: nothing on this machine has a collider, so anything standing
         above the tarmac is something the car is going to pass through, and a
         small lip is only a small version of the bug. A hazard band on the
         deck says where the bore starts and costs the suspension nothing. */
      this.at(s,x,.055,BORE_W,.11,34,this.concrete);
      for(const q of[-1,1])this.at(s+q*16.2,x,.13,BORE_W,.06,2.4,this.hazard);
      /* THE BORE IS A CLEAR TUBE TO BORE_CLEAR, and the shoes swing above it.
         They used to swing at y=0.7..5.3 with their cylinders at 1.5..4.5 and
         a unit and a half of that inside the NEXT bay along - so two of the
         three chutes, the two the trial requires a car to be able to drive
         all the way through, had a moving steel plate at chest height in them.
         The cylinders are on the frame now, see crushers(); this is the
         pressing face, and it starts above anything that can be driven. */
      const[fl,fr]=BORE_FACE[chute];
      this.at(s,fl-.75+side*3.1,4.3,1.5,4.4,26,this.steel);
      this.at(s,fr+.75-side*3.1,4.3,1.5,4.4,26,this.steel);
      this.at(s,x,10.4-top*7.2,BORE_W+.4,1.7,28,this.steel);
      /* Buried 0.06 into the platen rather than flush under it. Flush is two
         faces on the same plane thirty units long, which is a sheet of
         flickering hazard stripe across the top of the hall. */
      this.at(s,x,9.46-top*7.2,BORE_W-.8,.30,26,this.hazard);
      /* THE JAW COMES DOWN, AND AT REST IT HANGS CLEAR.
         It was CENTRED on 1.1 with 2.2 of height on it - y=0..2.2, which is on
         the road and through the car, in the mouth of all three bores at once.
         The note beside it claimed y=1.1..4.5, which is what that number would
         have meant if it had been the underside rather than the middle.

         THE JAW PLATE IS STILL THE READ: hot red on the machine that is about
         to take a car, cold steel on the two that are not, and its whole
         travel stays under the 4.62 chute wall, so it can only be had by
         looking down the bore. What is new is that the idle stroke stops at
         BORE_CLEAR. A baler only puts its jaw on the floor when the trial
         says it has a car in it. */
      const low=(live&&g.crush)?.62:BORE_CLEAR+.6;
      const jy=JAW_HIGH-jaw*(JAW_HIGH-low);
      this.at(s-19,x,jy,BORE_W,1.2,1.6,this.steel);
      this.at(s-19,x,jy,BORE_W-1.0,.30,1.9,live?this.red:this.steel);
      /* Work lamps inside the chamber, and only in the live one. Without them
         the machine is a black box with a car somewhere in it: the hall's high
         bays are outside and the platen shuts out what little reaches in. Lit
         is therefore both the lighting and the tell, and it is contained
         entirely inside a bore that is 34 units deep. */
      if(live)for(const q of[-1,1])for(const o of[-9,0,9]){
        this.at(s+o,x+q*5.6,8.6,.7,.5,3.4,this.lamp);
        this.at(s+o,x+q*5.6,8.15,1.1,.22,3.0,this.lamp);
      }
      /* The interlock beacon. It stands at 14.1 - the highest thing on the
         machine and well clear of the 4.62 wall - so it is the one part of
         this that MUST be identical on all three. Same colour, same strobe,
         same clock. Giving the live one a hot lamp here would have undone the
         whole change with a single flashing light, which is precisely the
         shape of the bug being fixed. */
      if(Math.sin(t*6.2)>0)this.at(s,x,14.1,1.6,.9,1.6,this.amber);
    }

    /* ----------------------------------------------------- the scrap line --
       Stamping presses straddling the road and a magnet on a traverse.
       Everything here is timing, and the only telegraph a press needs is that
       you can see it working. */
    /* A PRESS THAT COVERS THE WHOLE CARRIAGEWAY.
     *
     * It used to cover a lane. `half` was 6.5 to 8.5 against a drivable half
     * of 18, so every ram left twenty units of clear road beside it and the
     * trial was "read which side and steer there" - a lane-choice puzzle with
     * a stamping press drawn over it. The rhythm the four phases were built to
     * teach was decoration, because nobody ever had to wait for anything.
     *
     * The slide now spans the full corridor and a little past it. There is no
     * way round; there is only a way THROUGH, and it is open for about three
     * fifths of every cycle. The trial is the one the phases were always
     * describing: read the stroke, judge the closing speed, and go when it
     * lifts.
     *
     * The frame is unchanged and still stands outside the barrier at +-21.6,
     * where a frame belongs. What changed is the slide between the uprights,
     * and the gibs it runs in - which have to move out with it, or the columns
     * that used to sit beside a half-width ram end up in the road.
     */
    stampCell(p) {
      const x=p.lane,drop=p.drop,y=11.2-drop*10.0;
      for(const q of[-1,1]){
        this.at(p.s,q*21.6,7.0,2.4,14.4,3.6,this.deck);
        this.at(p.s,q*21.6,14.4,2.8,1.0,4.0,this.steel);
      }
      this.at(p.s,0,13.6,46,2.0,3.6,this.deck);
      this.at(p.s,0,14.7,44,.30,3.0,this.hazard);
      // the bolster, flush with the deck: a plate, not a kerb
      this.at(p.s,x,.06,p.half*2+2,.12,7.0,this.steel);
      this.at(p.s,x,.10,p.half*2+2,.06,7.4,this.hazard);
      // the slide, and the gibs it runs in - above head height, always
      this.at(p.s,x,y,p.half*2,2.2,5.0,this.steel);
      this.at(p.s,x,y-1.25,p.half*2-.6,.34,4.6,this.hazard);
      for(const q of[-1,1])this.at(p.s,x+q*(p.half+.5),9.6,.6,7.4,.6,this.steel);
      /* THE STROKE, READ FROM BEHIND.
       *
       * A full-width ram is a timing gate, and a timing gate that can only be
       * read by looking at the ram itself is unfair at a hundred and thirty:
       * by the time the slide is legible against the roof of the hall the car
       * is already committed. So the cell says what it is about to do, on the
       * road, seven units before the bolster and across the whole width the
       * ram will cover.
       *
       * Green while there is time to go, amber while the slide is falling and
       * red while the way is shut. Three states rather than two, because the
       * one thing a player has to be able to tell apart is "still open" from
       * "closing now", and a bar that only knows open and shut cannot say it.
       */
      const bar=drop>.55?this.red:drop>.06?this.amber:this.green;
      this.at(p.s-7,x,3.0,p.half*2+3,.24,.8,bar);
      this.at(p.s-7,x,3.0,p.half*2+3.4,.5,.4,this.deck);
      /* ...and a countdown down the approach: a run of chevrons that lights up
         toward the cell as the window closes, so the stroke has a length in
         ROAD rather than only in time. Sixty units is about a second at deck
         speed, which is the distance the decision is actually made over. */
      for(let k=0;k<4;k++){
        const lit=drop>.06?(k/4<drop):false;
        this.at(p.s-22-k*14,x,.10,p.half*2-1.5,.06,2.4,lit?this.red:this.green);
      }
    }
    magnetRig(m) {
      const t=this.g.time;
      this.at(m.s,0,13.9,56,1.4,3.0,this.deck);
      this.at(m.s,m.lat,10.6,4.6,2.8,4.6,this.yellow);
      this.at(m.s,m.lat,7.0,.36,5.2,.36,this.steel);
      this.at(m.s,m.lat,4.0,5.6,1.6,5.6,this.steel);
      this.at(m.s,m.lat,3.1,6.0,.5,6.0,Math.sin(t*8)>0?this.red:this.amber);
      this.at(m.s,m.lat,1.4,7.4,2.6,6.4,this.coil);
      this.at(m.s,m.lat,.16,9.0,.10,8.0,this.hazard);
    }

    /* ------------------------------------------------------ the ghost line --
       A scanning arch, and the lane Aurora's model says the car will be in
       when it goes through. The projection is drawn on the road as a car-sized
       outline, because a number on a screen is not a thing you can steer away
       from. */
    /* THE ARCH, AND WHAT IT IS CURRENTLY THINKING.
     *
     * The clamp lane MOVES now (see updateGhost), so the read on the floor has
     * to carry three things rather than one: where the clamp is, where it is
     * heading, and whether it is still allowed to change its mind. A player
     * who cannot see the difference between tracking and committed cannot play
     * the timing, and the timing is the trial.
     *
     *   TRACKING   the clamp band is drawn hollow and dim, in amber, and a
     *              thin leading marker sits out at the live aim - so the model
     *              visibly leans the way it thinks you are going before it
     *              gets there. The scan bar sweeps.
     *   COMMITTED  the band snaps to solid red, the aim marker and the scan
     *              bar both stop, and the arch pulses once. Everything that
     *              was moving stops moving, which is the loudest way to say
     *              "now" without a caption.
     *
     * The two cyan lanes are the nearest clear air either side, and they now
     * follow the clamp instead of standing still.
     */
    ghostArch(a) {
      const t=this.g.time,armed=a.armed&&!a.done;
      const tier=a.tier||0,live=armed&&!a.committed;
      for(const side of[-1,1]){
        this.at(a.s,side*21.5,6.0,2.0,12.0,3.0,this.aurora);
        this.at(a.s,side*20.2,6.0,.26,11.0,3.3,this.sign);
      }
      this.at(a.s,0,12.4,46,1.8,3.0,this.aurora);
      this.at(a.s,0,11.35,42,.24,3.3,this.sign);
      /* One lit rib per tier across the crown: which of the five this is, and
         so how good it is, readable from four hundred units out. */
      for(let i=0;i<=tier;i++)this.at(a.s,-9+i*4.5,13.1,1.5,.30,3.2,a.committed?this.red:this.cyan);
      if(armed){
        // the scan bar falls while it is looking and stops dead when it is not
        const y=a.committed?.9:11.0-((t*1.4)%1)*10.2;
        this.at(a.s,0,y,40,.22,.5,a.committed?this.red:this.cyan);
      }
      if(!armed)return;
      const p=a.predicted,col=a.committed?this.red:this.sign;
      const blink=a.committed?(.55+.45*Math.sin(t*14)):.34;
      const w=(GHOST_TIERS[tier]||GHOST_TIERS[0]).catch*2;
      // the clamp footprint, at its real width - what it can actually reach
      for(let o=-70;o<=70;o+=14)this.at(a.s+o,p,.12,w,.06,9,col);
      this.at(a.s-40,p,.9,w*.93,1.5,10,col);
      this.at(a.s-40,p,1.75,w*.64,.22,7.4,col);
      this.at(a.s,p,3.0,w*1.1,.30*blink,.5,col);
      // ...and the edges, so the width is a thing you can steer to
      for(const e of[-1,1])for(let o=-70;o<=70;o+=14)this.at(a.s+o,p+e*w*.5,.16,.34,.09,9,col);
      if(live){
        /* WHERE IT IS HEADING. The whole skill is reading this and refusing to
           feed it, so it is drawn - dim, thin, and out in front of the band it
           is dragging along behind it. */
        const q=a.aim;
        if(Math.abs(q-p)>.6)for(let o=-70;o<=70;o+=26)this.at(a.s+o,q,.09,1.1,.05,7,this.sign);
      }
      for(const side of[-1,1]){
        const lane=clamp(p+side*(w*.5+5.4),-16,16);
        if(Math.abs(lane-p)<w*.5+1.5)continue;
        for(let o=-70;o<=70;o+=18)this.at(a.s+o,lane,.11,4.6,.06,9,this.cyan);
      }
    }

    truck(d) {
      if(!d||(d.phase!=='test'&&d.phase!=='modeCinematic'))return;
      const shift=d.truckCleared?35*smooth((this.g.time-d.truckClearT)/1.45):0;
      this.at(TRUCK_S,shift,2.4,4.7,4.8,17.5,this.concrete,Math.PI*.5);
      this.at(TRUCK_S+3.8,shift-10.2,1.9,4.9,3.8,5.4,this.yellow,Math.PI*.5);
      this.at(TRUCK_S,shift,5.05,3.7,.18,14.5,this.red,Math.PI*.5);
    }

    draw() {
      if(!this.isOn())return;
      const gl=this.gl,d=this.g.__level6Director;
      /* The camera's arc length, which during a race is the car's and during
         an attract flyby is not. */
      const s=(this.g.distance!==undefined?this.g.distance:this.g.car.sTrack)||START;
      this.build();
      gl.enable(gl.DEPTH_TEST);gl.depthMask(true);gl.disable(gl.BLEND);
      this.drawStatic(s);
      this.moving(s);
      /* The trial hardware - the arc gates, the chute walls, the presses, the
         magnet and the hauler - belongs to the test, not to the building. On a
         Free Roam tour nothing is armed and nothing is scored, so a closed
         sorting gate across the road would be a wall with no rule behind it.
         The shell and its running machinery stay; the apparatus does not. */
      if(d&&!this.g.freeRoam){
        for(const g of d.gates)if(Math.abs(g.s-s)<1050)this.electricGate(g);
        for(let i=0;i<d.machines.length;i++)if(Math.abs(d.machines[i].s-s)<1100)this.machine(d.machines[i],i);
        for(const g of d.sortGates)if(g.s-s<900&&g.s-s>-500)this.sortGate(g);
        for(const p of d.stamps)if(Math.abs(p.s-s)<700)this.stampCell(p);
        if(d.magnet&&Math.abs(d.magnet.s-s)<800)this.magnetRig(d.magnet);
        for(const a of d.arches)if(Math.abs(a.s-s)<850)this.ghostArch(a);
        this.truck(d);
      }
      /* The lights, as light. Everything below is drawn a second time with
         additive blending so it reads as a SOURCE rather than as a bright
         face - and the high bays are the reason the roof is now a roof: an
         unlit ceiling at fifteen units is indistinguishable from night sky,
         which is exactly what this hall used to look like from inside it. */
      gl.enable(gl.BLEND);gl.blendFunc(gl.SRC_ALPHA,gl.ONE);gl.depthMask(false);
      /* The fittings are one batch per material per chunk now - see
         buildLights. This loop used to be about four hundred immediate-mode
         draws a frame for geometry that is bolted to the building. */
      gl.bindVertexArray(this.vao);
      this.drawBatches(this.glowBatches,s,620,1150);
      gl.bindVertexArray(this.sc.vao);
      /* THE FLOOR PAINT STOPS ANSWERING THE QUESTION.
       *
       * It used to run RED down the live chute and GREEN down the two safe
       * ones, for three hundred and sixty units before the funnel. The trial
       * is "the routing board is not wired to anything, the line is" - and
       * then the floor printed the answer in traffic-light colours, so there
       * was nothing left to read and no way to get it wrong.
       *
       * All three lanes are the same amber routing paint now. What separates
       * them is the FACTORY: the live chute's line is actually running, and
       * that is visible from four hundred units out if you look at the plant
       * instead of at the floor - the feed conveyor above it is moving, its
       * hazard beacon is lit and turning, and its baler is drawing power. The
       * two dead ones are still. Same information, in the place the trial
       * says to look for it.
       */
      if(d&&!this.g.freeRoam){
        for(const g of d.sortGates)if(g.s-s<900&&g.s-s>-500){
          for(let i=0;i<3;i++)
            for(let o=-360;o<-20;o+=30)this.at(g.s+o,CHUTE[i],.13,6.2,.05,22,this.amber);
          /* The one that is live is the one whose plant is running. The
             conveyor flights travel, the beacon turns; neither is a colour
             code, both are movement, and movement is what a working line has
             and a stopped one does not. */
          const live=g.live,x=CHUTE[live],t=this.g.time||0;
          for(let k=0;k<9;k++){
            const o=-330+((k*38+t*46)%330);
            this.at(g.s+o,x,9.2,5.4,.30,2.2,this.amber);
          }
          const turn=(t*2.4)%(Math.PI*2);
          this.at(g.s-26,x,11.4,1.5+Math.abs(Math.cos(turn))*3.6,.5,.9,this.red);
          this.at(g.s-26,x,11.4,.9,1.1,.9,this.red);
        }
        for(const a of d.arches)if(a.armed&&!a.done&&Math.abs(a.s-s)<850)
          for(let o=-70;o<=70;o+=14)this.at(a.s+o,a.predicted,.14,5.2,.05,8,this.red);
      }
      gl.depthMask(true);gl.disable(gl.BLEND);gl.bindVertexArray(this.sc.vao);
    }
  }

  /* The hall, published for tools/check.py forge. The structure is the one
     thing about the broken roof no unit test can reach - the solver's profile
     is checked by cargo and the table by tools/check.py ramps, and whether the
     DECK is where the car will be is a question about vertices. Same reason
     __SYNX_LEVEL7__ is published a few thousand lines below. */
  global.__SYNX_FACTORY_WORLD__ = FactoryWorld;


  /* Aurora's driver-link handshake. Four glyphs, on 1-4.

     The press cells used to ask arithmetic - "99 x 6 = ?" - which is a quiz
     stapled to a racing game: it tests something the chapter is not about, it
     is the same difficulty every time you meet it, and the answer is the same
     answer whether you are doing 30 or 130. The handshake is the thing the
     chapter IS about. Aurora's line controller will not release a cell to a
     car it has not authenticated, the challenge is a short sequence flashed on
     the cell's own board, and replaying it while driving is exactly the split
     attention the trial is claiming to measure. It gets longer each cell. */
  const GLYPHS = ['▲', '◆', '■', '●'];
  const GLYPH_NAMES = ['DELTA', 'VECTOR', 'BLOCK', 'CORE'];

  class Level6Director {
    constructor(game) {
      this.g=game;this.world=new FactoryWorld(game);this.bind();this.reset();game.__level6Director=this;
    }
    bind(){const id=n=>global.document.getElementById(n);this.ui={root:id('forge6'),objective:id('forge6Objective'),strikes:id('forge6Strikes'),phase:id('forge6Phase'),objectiveText:id('forge6ObjectiveText'),rule:id('forge6Rule'),round:id('forge6Round'),roundKicker:id('forge6RoundKicker'),roundTitle:id('forge6RoundTitle'),roundCopy:id('forge6RoundCopy'),math:id('forge6Math'),question:id('forge6Question'),answers:id('forge6Answers'),mathTime:id('forge6MathTime'),skill:id('forge6Skill'),swap:id('forge6Swap'),fatal:id('forge6Fatal'),fatalReason:id('forge6FatalReason')};
      this.ui.mathCaption=this.ui.math?this.ui.math.querySelector('small'):null;}
    reset(){
      // ...and on a restart too. See beginGhost for why this is not optional.
      if(this.g.driver)this.g.driver.paceScale=1;
      this.started=false;this.phase='idle';this.phaseTime=0;this.roundTime=0;this.rewinds=0;this.chapterLost=false;this.handedOver=false;this.lostCardDown=false;this.lostTimer=0;this.javasWarnT=-9;this.prevS=START;this.strikes=0;this.invertTime=0;this.question=null;this.questionIndex=0;this.failTimer=0;this.raceModeActive=false;this.raceModeTimer=0;this.raceModeCooldown=0;this.reserveLoaded=false;this.truckCleared=false;this.truckClearT=0;this.truckPrompt=false;this.activationTime=0;this.skillFlash=0;this.finalStarted=false;
      this.gates=[
        {s:112760,gap:-8,gapW:7,open:false,checked:false,live:false,pop:0},{s:113410,gap:8,gapW:7,open:false,checked:false,live:false,pop:0},
        {s:114060,gap:-6,gapW:7,open:false,checked:false,live:false,pop:0},{s:114710,gap:7,gapW:7,open:false,checked:false,live:false,pop:0},
        {s:115390,gap:0,gapW:6.5,open:false,checked:false,live:false,pop:0},
      ];
      this.machines=[{s:116620,type:'saw',open:false},{s:117610,type:'battery',open:false},{s:118570,type:'cars',open:false}];
      /* Three handshakes of three, four and five glyphs. Authored rather than
         random, so a retry is a retry of the same test and the player can
         actually get better at it. */
      this.sequences=[[0,2,1],[3,1,0,2],[1,3,2,0,1]];
      /* THE SORTING FLOOR. Which chute the line controller has routed to
         scrap is fixed per gate, and it moves across the hall - right, then
         centre, then left - so the third one cannot be taken on muscle memory
         from the first two. */
      this.sortGates=[
        {s:119600,live:2,armed:false,resolved:false,crush:false,crushT:0},
        {s:120700,live:1,armed:false,resolved:false,crush:false,crushT:0},
        {s:121800,live:0,armed:false,resolved:false,crush:false,crushT:0},
      ];
      /* THE SCRAP LINE. Four presses on their own beat and a magnet on a
         traverse. `phase` is where in its cycle the ram is at t=0, so the four
         of them never come down together and the run has a rhythm to learn.

         EVERY ONE OF THEM NOW SPANS THE ROAD. `lane` is 0 and `half` is 19
         against a drivable half of 18, so the slide covers the corridor and
         two units past it either side: there is no line through a closed ram,
         only a time. That is what makes the four phases mean something - the
         rhythm was always the trial, and a ram covering a lane let the player
         ignore it and steer round instead.

         The periods stay coprime-ish and the phases stay spread, so the four
         gates never open together and the run has to be read one at a time
         rather than sprinted through on one lucky window. */
      this.stamps=[
        {s:122650,lane:0,half:19,period:2.5,duty:.34,phase:.00,drop:0},
        {s:123150,lane:0,half:19,period:2.5,duty:.34,phase:.50,drop:0},
        {s:123700,lane:0,half:19,period:2.2,duty:.32,phase:.25,drop:0},
        {s:124200,lane:0,half:19,period:2.0,duty:.36,phase:.70,drop:0},
      ];
      this.magnet={s:124400,lat:0,dir:1,speed:5.2};
      /* THE GHOST LINE. Five scanning arches, and Aurora gets better at each
         one. See updateGhost for the rule; GHOST_TIERS for the numbers. */
      this.arches=[
        {s:124800,armed:false,done:false,predicted:0,aim:0,lock:0,committed:false,hit:false,tier:0},
        {s:125200,armed:false,done:false,predicted:0,aim:0,lock:0,committed:false,hit:false,tier:1},
        {s:125620,armed:false,done:false,predicted:0,aim:0,lock:0,committed:false,hit:false,tier:2},
        {s:126020,armed:false,done:false,predicted:0,aim:0,lock:0,committed:false,hit:false,tier:3},
        {s:126400,armed:false,done:false,predicted:0,aim:0,lock:0,committed:false,hit:false,tier:4},
      ];
      /* Which way the player keeps getting out of the way, -1..1. The model
         reads it, which is the entire trial. */
      this.ghostHabit=0;this.ghostClamped=0;
      this.ghostBroken=0;
      this.lastObstacleHit=-9;this.crushGate=null;this.crushT=0;this.cp=null;
      /* Back on the street engine. The swap is something Javas does at the
         end of the trials, so a replay of the chapter earns it again in the
         same place rather than starting with it. */
      if(this.g.car&&this.g.car.fitEngine)this.g.car.fitEngine(null);
      /* The wreck is this chapter's, not the player's. Leaving it on would
         hand Chapter 7 a bent car and a permanent drag penalty. */
      if(this.g.damage&&this.g.damage.reset)this.g.damage.reset();
      if(this.g.car)this.g.car.damage=0;
      if(this.g.driver&&this.g.driver.laneHint)this.g.driver.laneHint=null;
      if(this.g.scene)this.g.scene.drivers=true;
      this.g.carSquash=null;
      this.hideAll();this.g.blockQuickRestart=false;this.g.controlsSwapped=false;this.g.raceModeBlueFuel=false;this.g.raceModeActive=false;this.g.raceModeAvailable=false;if(this.g.car)this.g.car.raceModeMultiplier=1;if(NR.__level6ActiveDirector===this)NR.__level6ActiveDirector=null;global.document.body.classList.remove('forge6-invert','forge6-racemode');
    }
    hideAll(){if(!this.ui||!this.ui.root)return;this.ui.root.classList.remove('show');this.ui.root.setAttribute('aria-hidden','true');for(const x of [this.ui.round,this.ui.math,this.ui.skill,this.ui.fatal])if(x){x.classList.remove('show');x.setAttribute('aria-hidden','true');}}
    showRoot(){this.ui.root.classList.add('show');this.ui.root.setAttribute('aria-hidden','false');}
    isChapter(){return !!(this.g.level&&this.g.level.level6&&this.g.story&&this.g.story.chapter&&this.g.story.chapter.id===6);}

    /* THE SOLID HARDWARE.
       Everything else in the hall is scenery that has been moved clear of the
       road. These are the objects the trials are ABOUT - the saw, the battery
       stacks, the wrecked cars, the chute walls, the press rams, the magnet's
       load and the hauler - and every one of them is a box in TRACK space: an
       arc-length half-extent and a lateral half-extent, which is all the
       collision this route needs because the road is a corridor and the
       obstacles are square to it. `soft` is the ones that are a wall rather
       than a guillotine: they hurt, they never kill. */
    obstacles(){
      const out=[];
      for(const h of this.machines){
        if(h.open)continue;
        if(h.type==='saw')out.push({s:h.s,halfS:1.6,lat:0,halfLat:7.0,kind:'saw',label:'SAW GUARD'});
        else if(h.type==='battery')for(const x of[-8.4,0,8.4])out.push({s:h.s,halfS:2.1,lat:x,halfLat:2.7,kind:'battery',label:'BATTERY STACK'});
        else for(const x of[-9,0,9])out.push({s:h.s,halfS:3.0,lat:x,halfLat:1.5,kind:'cars',label:'STRIPPED SHELL'});
      }
      if(this.phase==='sorting'||this.phase==='crush'){
        for(const g of this.sortGates){
          if(g.resolved||g.s-this.g.car.sTrack>620)continue;
          for(const side of[-1,1])
            out.push({s:g.s+40,halfS:180,lat:side*DIVIDER,halfLat:1.7,kind:'divider',label:'CHUTE WALL',soft:true,wall:true});
        }
      }
      if(this.phase==='scrap'){
        for(const p of this.stamps){
          if(p.drop<.62)continue;
          out.push({s:p.s,halfS:2.6,lat:p.lane,halfLat:p.half,kind:'ram',label:'PRESS RAM'});
        }
        const m=this.magnet;
        /* The magnet's load is resolved as a WALL - always sideways, never
           head-on. It is a nine-unit slab parked at a fixed arc length that
           sweeps across the hall, so a car that meets it square is stopped
           dead by it, and a car stopped dead in front of something that keeps
           sweeping back over it never gets out again. Shoved aside and slowed
           is the honest outcome for a swinging load, and it cannot trap. */
        if(Math.abs(m.s-this.g.car.sTrack)<400)
          out.push({s:m.s,halfS:4.2,lat:m.lat,halfLat:4.6,kind:'slab',label:'MAGNET LOAD',soft:true,wall:true});
      }
      if(!this.truckCleared&&(this.phase==='test'||this.phase==='modeCinematic'))
        out.push({s:TRUCK_S,halfS:2.6,lat:0,halfLat:8.9,kind:'truck',label:'AURORA HAULER'});
      return out;
    }
    /* Resolve one car against them. Push out along whichever axis is least
       penetrated - sideways for a glance, backwards for a head-on - and take
       the velocity into the object with it. */
    resolveObstacles(car,isPlayer){
      const list=this.obstacles();if(!list.length)return null;
      const track=this.g.track,p=track.project(car.x,car.z,car.sTrack);
      const lat=p.lateral,s=car.sTrack,HS=2.15,HL=.95;
      const rx=Math.cos(p.yaw),rz=-Math.sin(p.yaw),fx=Math.sin(p.yaw),fz=Math.cos(p.yaw);
      let hit=null;
      for(const o of list){
        const ds=s-o.s,dl=lat-o.lat;
        const ovS=(o.halfS+HS)-Math.abs(ds),ovL=(o.halfLat+HL)-Math.abs(dl);
        if(ovS<=0||ovL<=0)continue;
        const speed=Math.abs(car.vLong);
        if(o.wall||ovL<=ovS){
          const sgn=dl>=0?1:-1,push=ovL+.02;
          car.x+=rx*sgn*push;car.z+=rz*sgn*push;
          car.vLat*=.35;car.vLong*=o.soft?.97:.90;car.yawRate+=sgn*(o.soft?.04:.10);
        }else{
          const sgn=ds>=0?1:-1,push=ovS+.02;
          car.x+=fx*sgn*push;car.z+=fz*sgn*push;
          car.vLong*=.18;car.vLat*=.4;
        }
        // its own scratch: `p` above is still the projection this resolve
        // started from, and the lane arithmetic below reads it
        car.sTrack=track.project(car.x,car.z,car.sTrack,this._hitProj||(this._hitProj={})).sExact;
        // a press shoving a car back down the road is the trial working; the
        // backtrack wall must give way to it rather than fight it
        car.maxS=Math.max(car.sTrack,Math.min(car.maxS===undefined?car.sTrack:car.maxS,car.sTrack+40));
        if(!hit||speed>hit.speed)hit={o,speed,head:ovS<ovL};
      }
      if(hit&&isPlayer)this.onObstacleHit(hit);
      return hit;
    }
    /* What lane Javas needs to be in, that far up the road. Gates first,
       because a live arc wall is the only thing here that punishes a driver
       for merely touching it; then the hardware, by widest clear lane. */
    laneFor(sAhead){
      for(const g of this.gates){
        if(g.open)continue;
        if(sAhead>g.s-360&&sAhead<g.s+30)return g.gap;
      }
      for(const h of this.machines){
        if(h.open)continue;
        if(sAhead<h.s-340||sAhead>h.s+30)continue;
        // saw spans the middle fourteen; the stacks and shells leave the
        // outer lane clear either side of the outermost block
        return h.type==='saw'?13.2:14.3;
      }
      // the sorting floor: whichever chute the controller has NOT routed to
      // scrap, and never the one the player has committed to
      for(const g of this.sortGates){
        if(g.resolved)continue;
        if(sAhead<g.s-360||sAhead>g.s+200)continue;
        const safe=[0,1,2].filter(i=>i!==g.live),lat=this.g.car.lateral||0;
        let pick=safe[0];
        for(const i of safe)if(Math.abs(CHUTE[i]-lat)<Math.abs(CHUTE[pick]-lat))pick=i;
        return CHUTE[pick];
      }
      /* The scrap line used to hand back a lane to steer into. The rams cover
         the whole carriageway now, so there is no such lane and saying there
         is would drive Javas at a barrier: a full-width gate is answered with
         the THROTTLE, in scrapPace, not with the wheel. Anything narrower than
         the corridor is still worth going round. */
      for(const p of this.stamps){
        if(sAhead<p.s-320||sAhead>p.s+40)continue;
        const cover=[p.lane-p.half,p.lane+p.half];
        if(cover[0]<=-DRIVE_HALF6&&cover[1]>=DRIVE_HALF6)return null;
        return cover[1]<15?clamp(cover[1]+3.5,-16,16):clamp(cover[0]-3.5,-16,16);
      }
      const m=this.magnet;
      if(this.phase==='scrap'&&sAhead>m.s-320&&sAhead<m.s+40)
        return clamp(m.lat>0?m.lat-11:m.lat+11,-15,15);
      if(!this.truckCleared&&(this.phase==='test'||this.phase==='modeCinematic')
        &&sAhead>TRUCK_S-420&&sAhead<TRUCK_S+30)return 14.5;
      return null;
    }
    chuteOf(lat){return lat<-DIVIDER?0:lat>DIVIDER?2:1;}
    onObstacleHit(hit){
      const now=this.g.time||0;
      if(now-(this.lastObstacleHit||-9)<.6)return;
      this.lastObstacleHit=now;
      const force=Math.min(1,hit.speed/26);
      this.g.audio.crash(Math.max(.35,force));
      this.g.shake=Math.max(this.g.shake||0,.4+force*.5);
      this.g.flash=Math.max(this.g.flash||0,.10+force*.10);
      if(this.g.fx)this.g.fx.sparks(this.g.car,Math.max(.5,force));
      if(hit.o.kind==='truck'){
        if(hit.head||force>.35){this.g.hud.toast('HAULER STRUCK // CALIBRATION RESET','#ff6a3a');this.resetTest();}
        return;
      }
      if(hit.o.kind==='ram'&&(hit.head||force>.30)){this.fail('CAUGHT UNDER THE RAM // PRESS CYCLE FATALITY');return;}
      if(hit.o.soft){this.g.hud.toast(hit.o.label+' // SCRAPED','#ffb04a');return;}
      if(hit.head&&force>.30)this.fail(hit.o.label+' // PRESS CYCLE FATALITY');
      else this.g.hud.toast(hit.o.label+' // CONTACT','#ffb04a');
    }
    showRound(kicker,title,copy,seconds){this.ui.roundKicker.textContent=kicker;this.ui.roundTitle.textContent=title;this.ui.roundCopy.textContent=copy;this.ui.round.classList.add('show');this.roundTime=seconds||3.0;}
    startTrial(){
      // Javas has to be able to see the hardware, or it drives through it
      if(this.g.driver)this.g.driver.laneHint=(sAhead)=>this.laneFor(sAhead);
      /* THE CAR THAT ARRIVES AT THE FORGE IS THE ONE RYKER LEFT.

         Chapter 5 ends with the player put into a wall and the R-IX driven
         away; Chapter 6 is what is done about that. It used to open on a car
         in showroom condition doing the full street hundred and thirty-two,
         which makes the rebuild at the end of it - the whole point of the
         chapter - worth twelve miles an hour and no visible difference.

         So it arrives wrecked, and it arrives wrecked in both senses: the
         body is at the end of its scale, which the panel shader draws and the
         solver charges drag for, and the engine is the seventy-mile-an-hour
         block in crates/synx-core/src/vehicle.rs. Both are undone in one
         moment by the same hands - see showSkill. */
      if(this.g.car&&this.g.car.fitEngine)this.g.car.fitEngine('broken');
      if(this.g.damage&&this.g.damage.wreck)this.g.damage.wreck();
      this.started=true;this.phase='lightning';this.prevS=this.g.car.sTrack;this.showRoot();this.mark(this.g.car.sTrack,'LIGHTNING GAPS');this.g.blockQuickRestart=true;NR.__level6ActiveDirector=this;
      this.ui.phase.textContent='AURORA FORGE // TRIAL 01';this.ui.objectiveText.textContent='LIGHTNING CRASH';this.updateRule();
      this.showRound('AURORA MOTORWORKS // CLOSED COURSE','LIGHTNING CRASH','THREAD THE LIVE WALLS. THREE STRIKES ENDS THE TEST.',3.4);
      this.g.story.showCompact('JAVAS','calm','Live walls read intent. Hesitate and they read you instead.',4.0);
    }
    updateRule(){
      const R={lightning:'ARC STRIKES '+this.strikes+' / 3',
        machinery:'HANDSHAKE '+this.questionIndex+' / '+this.sequences.length,
        sorting:'CHUTES CLEARED '+this.sortGates.filter(g=>g.resolved).length+' / 3',
        scrap:'PRESS LINE // TIME THE RAM',
        ghost:'MODEL BROKEN '+this.ghostBroken+' / 3',
        test:'R — raceMode  //  B — BOOST'};
      this.ui.rule.textContent=R[this.phase]||'';
      // Three pips read at a glance at racing speed; a fraction does not.
      if(this.ui.strikes){
        this.ui.strikes.style.display=(this.phase==='lightning'||this.phase==='ghost')?'flex':'none';
        const pips=this.ui.strikes.children,n=this.phase==='ghost'?this.ghostBroken:this.strikes;
        for(let i=0;i<pips.length;i++)pips[i].classList.toggle('hit',i<n);
      }
    }
    cap(car,limit){if(!car||car.speed<=limit)return;const k=limit/Math.max(.001,car.speed);car.vLong*=k;car.vLat*=k;car.vx*=k;car.vz*=k;car.speed=limit;}
    capFor(){const kmh={lightning:100,machinery:100,sorting:118,scrap:112,ghost:132}[this.phase];
      return kmh?(kmh/3.6)/.733:0;}

    // ------------------------------------------------ TRIAL 01: arc walls --
    electricHit(gate){
      this.strikes++;gate.open=true;this.invertTime=5;this.g.controlsSwapped=true;global.document.body.classList.add('forge6-invert');
      this.g.car.vLong*=.58;this.g.car.vLat*=-.35;this.g.flash=.22;this.g.shake=.72;this.g.audio.crash(.75);if(this.g.fx)this.g.fx.sparks(this.g.car,.9);
      this.g.hud.toast('ARC STRIKE '+this.strikes+'/3  //  A ↔ D  5.0s','#52dfff');this.updateRule();
      this.g.story.showCompact(this.strikes===1?'NOVA':'JAVAS',this.strikes===1?'calculating':'calm',this.strikes===1?'Steering bus inverted. Five seconds—read the car, not your hands.':'Again. The wall is not going to apologize.',3.8);
      if(this.strikes>=3)this.fail('THREE ARC STRIKES // DRIVER LINK REJECTED');
    }
    checkGates(){
      const car=this.g.car;
      for(const gate of this.gates){
        if(gate.checked||car.sTrack<gate.s-5)continue;gate.checked=true;
        if(Math.abs(car.lateral-gate.gap)>gate.gapW*.52)this.electricHit(gate);else{gate.open=true;this.g.audio.checkpoint();}
      }
    }
    armGates(dt){
      const car=this.g.car;
      for(const gate of this.gates){
        if(!gate.live&&!gate.open&&car.sTrack>=gate.s-GATE_REVEAL_UNITS&&car.sTrack<gate.s+5){
          gate.live=true;gate.pop=.001;this.g.audio.goBeep();this.g.flash=Math.max(this.g.flash||0,.06);
          this.g.hud.toast('ARC WALL // LIVE','#55e6ff');
        }
        if(gate.live&&!gate.open)gate.pop=Math.min(1,(gate.pop||0)+dt*9.5);
      }
    }

    // ------------------------------------------ TRIAL 02: the handshake ----
    beginMachinery(){
      if(this.phase!=='lightning')return;this.phase='machinery';this.ui.phase.textContent='AURORA FORGE // TRIAL 02';this.ui.objectiveText.textContent='COGNITION PRESS';this.updateRule();this.mark(this.g.car.sTrack-40,'COGNITION PRESS');
      this.showRound('DAMAGE LIMIT // 100 KM/H','COGNITION PRESS','WATCH THE HANDSHAKE. REPLAY IT BEFORE THE RAM CLOSES.',3.2);
      this.g.story.showCompact('JAVAS','calculating','The cell will not open for a car it has not authenticated. Watch the board.',4.2);
    }
    beginQuestion(index){
      const seq=this.sequences[index]||this.sequences[0];
      this.question={index,seq,step:0,time:2.2+seq.length*1.6,show:0,watch:seq.length*0.55,key:String(seq[0]+1)};
      this.renderHandshake();
      this.ui.math.classList.add('show');this.ui.math.setAttribute('aria-hidden','false');this.g.audio.select();
    }
    renderHandshake(){
      const q=this.question;if(!q)return;
      if(this.ui.mathCaption)this.ui.mathCaption.textContent=
        q.watch>0?'AURORA DRIVER LINK // MEMORISE':'AURORA DRIVER LINK // REPLAY  1–4';
      if(q.watch>0){
        // one glyph at a time, big, while the board is playing it
        const i=Math.min(q.seq.length-1,Math.floor((q.seq.length*0.55-q.watch)/0.55));
        this.ui.question.textContent=GLYPHS[q.seq[i]];
      }else{
        this.ui.question.textContent=q.seq.map((gl,i)=>i<q.step?GLYPHS[gl]:'·').join(' ');
      }
      if(this.ui.answers.childElementCount!==4){
        this.ui.answers.replaceChildren();
        GLYPHS.forEach((glyph,i)=>{
          const row=global.document.createElement('span'),key=global.document.createElement('em');
          key.textContent=String(i+1);
          row.append(key,global.document.createTextNode(glyph+'  '+GLYPH_NAMES[i]));
          this.ui.answers.appendChild(row);
        });
      }
    }
    updateQuestion(dt){
      const q=this.question;if(!q)return;
      if(q.watch>0){
        q.watch-=dt;this.renderHandshake();
        if(q.watch<=0){this.g.audio.goBeep();this.renderHandshake();}
        return;
      }
      q.time-=dt;this.ui.mathTime.style.transform='scaleX('+clamp(q.time/(2.2+q.seq.length*1.6),0,1)+')';
      let hit='';for(const k of ['1','2','3','4'])if(this.g.input.hit(k))hit=k;
      if(hit){
        if(hit===String(q.seq[q.step]+1)){
          q.step++;this.g.audio.select();
          if(q.step>=q.seq.length){this.passQuestion();return;}
          q.key=String(q.seq[q.step]+1);this.renderHandshake();
        }else this.fail('HANDSHAKE REJECTED // PRESS CYCLE FATALITY');
        return;
      }
      if(q.time<=0||this.g.car.sTrack>=this.machines[q.index].s-12)this.fail('LINK TIMED OUT // PRESS CYCLE FATALITY');
    }
    passQuestion(){
      const i=this.question.index;this.machines[i].open=true;this.question=null;this.questionIndex=i+1;this.ui.math.classList.remove('show');this.ui.math.setAttribute('aria-hidden','true');this.g.audio.checkpoint();this.g.hud.toast('CELL AUTHENTICATED','#62e7ff');this.updateRule();
      const lines=['Good. Three was the easy one.','Four. It gets longer because you get better.','Five, at a hundred, on a damaged car. That is the whole point.'];this.g.story.showCompact('JAVAS','calm',lines[i]||lines[0],3.2);
    }
    checkMachines(dt){
      if(this.question){this.updateQuestion(dt);return;}
      const i=this.questionIndex;
      if(i<this.machines.length&&this.g.car.sTrack>=this.machines[i].s-640){
        // one rewind point per handshake, so a missed glyph costs that press
        this.mark(this.machines[i].s-700,'COGNITION PRESS '+(i+1));
        this.beginQuestion(i);
      }
      if(this.g.car.sTrack>=MACHINE_END&&i>=this.machines.length)this.beginSorting();
    }

    // ---------------------------------------- TRIAL 03: the sorting floor --
    beginSorting(){
      if(this.phase!=='machinery')return;this.phase='sorting';this.ui.phase.textContent='AURORA FORGE // TRIAL 03';this.ui.objectiveText.textContent='SORTING FLOOR';this.updateRule();
      this.mark(this.g.car.sTrack-40,'SORTING FLOOR');
      this.showRound('LINE CONTROL // SCRAP ROUTING','SORTING FLOOR','THREE CHUTES. ONE IS RUNNING. THE PAINT WILL NOT TELL YOU WHICH.',3.8);
      this.g.story.showCompact('JAVAS','smug',"The board lies and the floor is just paint. Find the one whose line is moving.",4.8);
    }
    checkSorting(dt){
      const car=this.g.car;
      for(const g of this.sortGates){
        if(g.resolved)continue;
        if(!g.armed&&car.sTrack>g.s-620){
          /* The toast used to name the live chute, which is the board by
             another route. It now says only that a decision is coming, and
             takes the rewind point for the one that is. */
          g.armed=true;this.g.audio.goBeep();
          this.mark(g.s-560,'SORTING FLOOR');
          this.g.hud.toast('SORTING FLOOR — PICK A CHUTE','#ffb020');
        }
        // committed once past the funnel mouth: the walls are already either
        // side of the car and there is nowhere left to change your mind
        if(car.sTrack>=g.s-30&&!g.resolved){
          g.resolved=true;
          if(this.chuteOf(car.lateral||0)===g.live){this.beginCrush(g);return;}
          this.g.audio.checkpoint();this.g.hud.toast('CHUTE CLEAR','#91ff31');this.updateRule();
          const said=this.sortGates.filter(x=>x.resolved).length;
          if(said===1)this.g.story.showCompact('JAVAS','calm','You watched the conveyor. Most of them watch the floor.',3.2);
          if(said===3)this.g.story.showCompact('NOVA','smug','Three for three. Javas, he is reading your factory.',3.2);
        }
      }
      if(car.sTrack>=SORT_END&&this.sortGates.every(g=>g.resolved))this.beginScrap();
    }
    /* THE BALER.
       Four beats: the infeed jaws shut behind the car, the side rams close,
       the platen comes down, and what is left is ejected onto the stack. The
       car is squashed by scaling its own model matrix, which is why the
       driver is switched off for the duration - there is a person in that
       cabin now and this is not a thing to do to one on camera. */
    beginCrush(g){
      if(this.phase==='crush')return;
      /* THE BEATS ARE ONE-SHOT FLAGS AND NOBODY WAS PUTTING THEM BACK.
         A second wrong chute at the same gate replayed the whole set piece in
         silence - no impacts, no sparks, no shake, and no UNIT SCRAPPED card,
         because b1..b4 were still set from the first one. Cleared here as well
         as in rewind(), since either can be the thing that comes first. */
      this.phase='crush';this.crushGate=g;this.crushT=0;
      g.crush=true;g.crushT=0;g.b1=0;g.b2=0;g.b3=0;g.b4=0;
      this.crushS=g.s+140;this.crushLat=CHUTE[g.live];
      this.g.state='story';this.g.story.mode='level6Special';
      this.g.story.setLayer(this.g.story.ui.raceMeta,false);
      this.g.story.setLayer(this.g.story.ui.letterbox,true);
      global.document.body.classList.add('story-cinematic');
      if(this.g.scene)this.g.scene.drivers=false;
      this.g.story.hideCompact();
      this.g.audio.crash(1);this.g.flash=.16;this.g.shake=1.0;
      this.g.hud.toast('WRONG CHUTE','#ff3b1e');
    }
    updateCrush(dt){
      const g=this.crushGate;if(!g)return true;
      this.crushT+=dt;g.crushT=this.crushT;const t=this.crushT;
      const car=this.g.car;
      // the car is dragged the last few units onto the bed and then held
      const in0=clamp(t/0.55,0,1);
      this.g.story.setVehicle(car,this.crushS-26+in0*24,this.crushLat,0);
      car.vLong=0;car.vLat=0;car.speed=0;this.g.distance=car.sTrack;
      const sq=[1,1,1];
      if(t>0.55)sq[0]=1-0.62*smooth((t-0.55)/1.05);
      if(t>1.55){sq[1]=1-0.84*smooth((t-1.55)/1.05);sq[2]=1-0.20*smooth((t-1.55)/1.05);}
      this.g.carSquash=sq;
      // the beats, and what each one sounds and feels like
      if(!g.b1&&t>0.05){g.b1=1;this.g.audio.crash(.9);this.g.shake=.9;}
      if(!g.b2&&t>0.58){g.b2=1;this.g.audio.crash(1);this.g.shake=1.1;this.g.flash=.22;
        if(this.g.fx)this.g.fx.sparks(car,1);}
      if(!g.b3&&t>1.58){g.b3=1;this.g.audio.crash(1);this.g.shake=1.4;this.g.flash=.20;
        if(this.g.fx)this.g.fx.sparks(car,1);}
      if(t>0.6&&t<2.8&&this.g.fx&&((t*7)|0)%2===0)this.g.fx.sparks(car,.55);
      if(!g.b4&&t>2.70){
        g.b4=1;this.ui.fatalReason.textContent='UNIT SCRAPPED // AURORA BALE 07';
        this.ui.fatal.classList.add('show');this.ui.fatal.setAttribute('aria-hidden','false');
        this.g.story.showCompact('JAVAS','calm','That is what the board was for.',3.2);
      }
      /* A rig built for this machine rather than one of the stock car marks.
         The stock marks put the lens four and a half units off the car's flank
         - which inside a baler is inside the side ram, so the shot was the
         inside of a steel plate. Every mark below is placed from the OPEN side
         of the chute, looking in past the frame. */
      {
        const p=this.g.track.at(car.sTrack,{}),fx=Math.sin(p.yaw),fz=Math.cos(p.yaw);
        const rx=Math.cos(p.yaw),rz=-Math.sin(p.yaw),open=this.crushLat>0?-1:1;
        /* Every mark is INSIDE the chute, because a chute has walls: the
           first pass put the lens thirteen units to the side and got the
           inside of the divider. Two of the three look back down the bale
           chamber, which is the only place in this machine with a view of
           the car in it. */
        let e,f,fov;
        if(t<0.62){        // over the jaws, looking down as they shut
          e=[-11.0,6.4,open*1.4];f=[1.0,1.0,0];fov=50;
        }else if(t<1.62){  // from the far end of the chamber, level with the rams
          e=[10.5,1.9,open*1.6];f=[0,0.9,0];fov=46;
        }else{             // and back a little, as the platen comes down
          /* Back out of the chamber and up, for the last beat. There is no
             mark inside a closed bale press that can see a car in it once the
             platen is down - the platen is between the lens and everything -
             and the shot that lands anyway is the machine finishing, with the
             jaws shut and nothing left to look at. */
          e=[-26.0,9.4,open*1.0];f=[14.0,3.4,0];fov=46;
        }
        const eye=[car.x+fx*e[0]+rx*e[2],car.y+e[1],car.z+fz*e[0]+rz*e[2]];
        const tgt=[car.x+fx*f[0]+rx*f[2],car.y+f[1],car.z+fz*f[0]+rz*f[2]];
        if(this.g.story.commitShot)this.g.story.commitShot('forge-crush',eye,tgt,fov,.3);
      }
      this.g.story.baseTick(dt,false);
      if(t>=4.2){
        this.g.carSquash=null;if(this.g.scene)this.g.scene.drivers=true;
        this.ui.fatal.classList.remove('show');this.ui.fatal.setAttribute('aria-hidden','true');
        /* A CRUSH COSTS A RUN, LIKE EVERY OTHER FAILURE IN THIS CHAPTER.
           This called rewind() directly, so the sorting floor was the one
           trial with no budget on it: a player could guess wrong at the same
           chute for as long as they liked while a missed handshake three doors
           back cost them the chapter. Same counter, same ceiling, and it goes
           through the shared loss path when it runs out. */
        this.rewinds=(this.rewinds||0)+1;
        if(this.rewinds>3){this.loseChapter('SCRAPPED // NO RUNS LEFT');return true;}
        /* Back in front of the chute you got wrong, not back at the start of
           the route. A one-in-three guess that costs eight minutes is not a
           trial, it is a punishment for having played. */
        if(this.cp&&this.rewind())return true;
        this.g.story.pendingRetryChapter=6;this.g.story.retryChapterRace();
      }
      return true;
    }

    // ------------------------------------------ TRIAL 04: the scrap line --
    beginScrap(){
      if(this.phase!=='sorting')return;this.phase='scrap';this.ui.phase.textContent='AURORA FORGE // TRIAL 04';this.ui.objectiveText.textContent='SCRAP LINE';this.updateRule();this.mark(this.g.car.sTrack-40,'SCRAP LINE');
      this.showRound('LINE 04 // STAMPING','SCRAP LINE','THE RAMS DO NOT STOP FOR YOU. GO WHEN THEY LIFT.',3.4);
      this.g.story.showCompact('JAVAS','calm','Nothing on this line is aimed at you. That is what makes it dangerous.',4.0);
    }
    /* WHERE A RAM IS IN ITS STROKE, as one function.

       Both the animation and the two controllers that have to reason about it
       read this, so there is exactly one description of the cycle. It used to
       be written out inline in updateScrap and nowhere else, because nothing
       else needed it - a lane-wide ram is steered around and never timed. */
    ramDropAt(p,t){
      const u=((t/p.period)+p.phase)%1;
      // down for `duty` of the cycle, with a fast fall and a slower lift
      return u<p.duty*.35?smooth(u/(p.duty*.35))
        :u<p.duty?1
        :u<p.duty+.30?1-smooth((u-p.duty)/.30):0;
    }
    /* WHAT JAVAS DOES ABOUT A GATE SHE CANNOT STEER ROUND.
     *
     * The rams cover the whole carriageway, so the lane hint that used to get
     * the rival through them has nothing to offer - see laneFor. A full-width
     * gate is answered with the throttle instead, and it has to be answered,
     * or the one car on the road that the player is measuring themselves
     * against spends the trial being punched backwards by a press.
     *
     * The controller aims for an absolute TIME rather than correcting an
     * error: it works out when the next window is properly open and asks for
     * the pace that arrives in the middle of it. That is what keeps it stable.
     * A controller that slowed down while a gate was shut and sped up while it
     * was open would chase its own tail at the frequency of the press, which
     * is the same limit cycle the finale's R-IX spent three attempts on.
     */
    scrapPace(){
      const r=this.g.rival;
      if(!r||this.phase!=='scrap')return 1;
      let best=null;
      for(const p of this.stamps){
        const d=p.s-(r.sTrack||0);
        if(d>6&&d<300&&(!best||d<best.d))best={p,d};
      }
      if(!best)return 1;
      const P=best.p,v=Math.max(20,r.vLong||0),now=this.g.time;
      // wide open, not merely passable: the ram is fully up for the last
      // stretch of every cycle, and that is the only part worth aiming at
      const openFrom=P.duty+.30,openTo=1;
      const eta=best.d/v;
      const at=((now+eta)/P.period+P.phase)%1;
      if(at>=openFrom&&at<openTo)return 1;     // already arriving in the clear
      // ...otherwise aim at the middle of the next fully-open window
      const want=openFrom+(openTo-openFrom)*.5;
      const u0=((now/P.period)+P.phase)%1;
      let du=want-u0; if(du<0)du+=1;
      const target=du*P.period;                // seconds from now
      return clamp(best.d/Math.max(.35,target)/v,.58,1.14);
    }
    updateScrap(dt){
      const t=this.g.time,car=this.g.car;
      for(const p of this.stamps)p.drop=this.ramDropAt(p,t);
      // Javas times the gates rather than steering round them; see scrapPace
      if(this.g.driver)this.g.driver.paceScale=this.scrapPace();
      const m=this.magnet;
      m.lat+=m.dir*m.speed*dt;
      if(m.lat>15){m.lat=15;m.dir=-1;}
      if(m.lat<-15){m.lat=-15;m.dir=1;}
      if(car.sTrack>=SCRAP_END)this.beginGhost();
    }

    // ------------------------------------------ TRIAL 05: the ghost line --
    beginGhost(){
      if(this.phase!=='scrap')return;
      /* HAND THE THROTTLE BACK. scrapPace writes paceScale on the SHARED
         driver, and this chapter has already shipped one bug of exactly this
         shape - a Chapter 6 lane-hint closure left installed on that driver,
         which then told Chapter 7's R-IX to sit at +-13 for the whole finale.
         State put on a shared object has to be taken off it at every exit, not
         at the one the author was thinking about. */
      if(this.g.driver)this.g.driver.paceScale=1;
      this.phase='ghost';this.ui.phase.textContent='AURORA FORGE // TRIAL 05';this.ui.objectiveText.textContent='GHOST LINE';this.updateRule();this.mark(this.g.car.sTrack-40,'GHOST LINE');
      this.showRound('PREDICTION ARCH // R-IX FEED','GHOST LINE','IT FOLLOWS YOU UNTIL IT COMMITS. MOVE AFTER THAT, NOT BEFORE.',4.2);
      this.g.story.showCompact('JAVAS','calculating','It tracks. Steering early only tells it where you are going. Wait for the lock to go solid, then go.',5.2);
    }
    /* TRIAL 05: THE GHOST LINE.
     *
     * WHAT WAS WRONG WITH IT. The arch locked a lane four hundred units out
     * off the player's ROLLING AVERAGE and then never looked again. So the
     * whole trial was: see a red stripe five seconds early, steer six units
     * away from it, done. Three times. There was no decision in it, no timing
     * in it and no way to be good at it - and being clamped cost a fifth of
     * the speed and nothing else, so there was no reason to care either.
     *
     * WHAT IT IS NOW. The arch TRACKS. It re-aims every frame at where the car
     * will actually be when it arrives - the current lane carried forward by
     * the current lateral speed over the real time to arrival - and the drawn
     * clamp damps onto that aim. Steering away early no longer works, because
     * the clamp simply comes with you.
     *
     * What beats it is the COMMIT WINDOW. Inside the last hundred-odd units it
     * stops tracking and fires on where it last had you, and that window is
     * short - under a second at racing speed. So the trial is a timing
     * problem: hold your line while it is watching, break late and break hard
     * once it can no longer answer. That is a thing a player can get better at
     * and can fail for a reason they understand.
     *
     * And it LEARNS. Aurora keeps ghostHabit, which way the last few escapes
     * went, and leans the aim that way; break left twice and the third arch is
     * already sitting left of you. Alternating is the counter. That is the
     * chapter's actual argument - the model beats repetition, not driving -
     * made playable instead of stated.
     *
     * Each arch is a tier harder than the last: it tracks faster, it grabs
     * wider and it commits later. Break three of the five to pass. Get clamped
     * three times and it rewinds, so the two you are allowed to lose are a
     * real budget rather than a formality.
     */
    updateGhost(dt){
      const car=this.g.car,T=GHOST_TIERS;
      for(const a of this.arches){
        if(a.done)continue;
        const dist=a.s-car.sTrack,k=T[a.tier]||T[0];
        if(!a.armed&&dist<420){
          a.armed=true;a.predicted=clamp(car.lateral||0,-15,15);
          this.g.audio.goBeep();
          this.g.hud.toast('ARCH 0'+(a.tier+1)+' // TRACKING','#ffb400');
        }
        if(!a.armed)continue;
        if(dist>k.commit){
          // where the car will be when it gets here, plus what the model
          // thinks it has learned about this driver
          const tta=dist/Math.max(30,Math.abs(car.vLong)||60);
          a.aim=clamp((car.lateral||0)+(car.vLat||0)*tta*.8+this.ghostHabit*k.habit,-15,15);
          a.predicted+=(a.aim-a.predicted)*(1-Math.exp(-k.track*dt));
          a.lock=clamp(1-Math.abs(a.predicted-(car.lateral||0))/9,0,1);
        }else if(!a.committed){
          /* IT HAS STOPPED LOOKING. Announced, because a window whose edge the
             player cannot see is not a window. */
          a.committed=true;a.aim=a.predicted;
          this.g.audio.goBeep();
          this.g.hud.toast('COMMITTED // GO','#39e6ff');
        }
        if(dist<=2){
          a.done=true;
          const lat=car.lateral||0,miss=Math.abs(lat-a.predicted);
          if(miss<k.catch){
            a.hit=true;this.ghostClamped++;
            /* A CLAMP, not a speed bump. It takes half the speed and HAULS the
               car into the lane it called, which is both the right fiction and
               the thing that makes the next arch harder: you come out of it
               exactly where the model wanted you. */
            car.vLong*=.52;
            car.vLat+=(a.predicted-lat)*1.9;
            car.yawRate+=(lat>=a.predicted?-1:1)*.52;
            car.stun=Math.max(car.stun||0,1.1);
            this.g.flash=.26;this.g.shake=.82;this.g.audio.crash(.8);
            if(this.g.fx&&this.g.fx.sparks)this.g.fx.sparks(car,1.0);
            this.g.hud.toast('PREDICTED // CLAMP FIRED','#ff3b1e');
            if(this.ghostClamped>=3){
              /* ...AND SO DOES BEING READ THREE TIMES. rewind() puts
                 ghostClamped back to whatever the checkpoint held, which on
                 this trial is zero - so three clamps sent the player back to
                 a state from which three more clamps sent them back again,
                 with nothing counting and no way out but to win. The budget
                 is the same one every other failure here spends. */
              this.rewinds=(this.rewinds||0)+1;
              if(this.rewinds>3){this.loseChapter('THE MODEL READ YOU EVERY TIME // NO RUNS LEFT');return;}
              this.g.story.showCompact('JAVAS','calm','Three. It has your number. Again - and do not give it the same answer twice.',4.0);
              if(this.cp&&this.rewind())return;
            }else{
              this.g.story.showCompact('JAVAS','calm',this.ghostClamped===1
                ?'It went with you. Stop steering so early.'
                :'You broke the same way twice. It is reading that.',3.2);
            }
          }else{
            this.ghostBroken++;this.g.audio.checkpoint();
            // the model watches HOW it was beaten, not only that it was
            const dir=lat>=a.predicted?1:-1;
            this.ghostHabit=clamp(this.ghostHabit*.5+dir*.5,-1,1);
            this.g.hud.toast('PROJECTION BROKEN // '+this.ghostBroken+'/3','#39e6ff');
            if(this.ghostBroken===3)this.g.story.showCompact('JAVAS','smug','Three from three. That is the number Aurora cannot get out of you.',3.4);
            else if(Math.abs(this.ghostHabit)>.7)this.g.story.showCompact('JAVAS','calculating','Same side again. It is learning that faster than you are changing it.',3.2);
          }
          this.updateRule();
        }
      }
      if(car.sTrack>=GHOST_END&&this.arches.every(a=>a.done)){
        /* Three of five, or it was not beaten. A trial that ends by being
           driven past is a trial that was never a trial. */
        if(this.ghostBroken>=3)this.beginUnlock();
        else if(this.rewinds<3&&this.cp&&this.rewind()){
          this.rewinds=(this.rewinds||0)+1;
          this.g.hud.toast('MODEL HELD // RUN IT AGAIN','#ff3b1e');
          this.g.story.showCompact('JAVAS','calm','It got three of you. That is a pass for Aurora, not for us.',3.6);
        }else{
          /* NOT beginUnlock. This is the branch where the player failed the
             trial and there is nowhere left to put them back - and it used to
             hand them the driver link for it, which made the one genuinely
             failed run the one that paid out. */
          this.loseChapter('THE MODEL READ YOU EVERY TIME');
        }
      }
    }

    /* ------------------------------------------------------- the rewind --
       A trial that can kill you in a tenth of a second is only fair if losing
       costs a retry rather than the chapter - which is exactly how Chapter 5
       treats its collapsing tower and its lava field. A rewind point is taken
       at the head of each trial and in front of each gate, and it carries the
       trial's own state as well as a place on the road: how many presses have
       been authenticated, which chutes are behind you, which arches are done.
       Without that, a rewind into the middle of Trial 02 would put the car
       back with every question already answered. */
    mark(s,label){
      const g=this.g;
      this.cp={
        s:Math.max(START+30,s),label:label||'',raceTime:g.raceTime||0,phase:this.phase,
        questionIndex:this.questionIndex,strikes:this.strikes,ghostBroken:this.ghostBroken,
        /* The clamp count and what the model has learned both belong to the
           attempt, so a rewind puts them back with everything else - a player
           who is sent round again should not inherit two of their three
           clamps, and should not face a model that is still leaning on a habit
           from a run that no longer happened. */
        ghostClamped:this.ghostClamped,ghostHabit:this.ghostHabit,
        machines:this.machines.map(m=>m.open),
        gates:this.sortGates.map(x=>x.resolved),
        arches:this.arches.map(a=>a.done),
        gaps:this.gates.map(x=>x.checked),
      };
    }
    rewind(){
      const cp=this.cp;if(!cp)return false;
      const g=this.g,story=g.story;
      g.raceTime=cp.raceTime;
      this.phase=cp.phase;this.phaseTime=0;this.failTimer=0;
      this.questionIndex=cp.questionIndex;this.strikes=cp.strikes;this.ghostBroken=cp.ghostBroken;
      this.ghostClamped=cp.ghostClamped||0;this.ghostHabit=cp.ghostHabit||0;
      this.machines.forEach((m,i)=>{m.open=cp.machines[i];});
      this.sortGates.forEach((x,i)=>{x.resolved=cp.gates[i];x.armed=cp.gates[i];x.crush=false;x.crushT=0;
        x.b1=0;x.b2=0;x.b3=0;x.b4=0;});
      this.arches.forEach((a,i)=>{a.done=cp.arches[i];a.armed=cp.arches[i];a.hit=false;
        a.committed=cp.arches[i];a.predicted=0;a.aim=0;a.lock=0;});
      this.gates.forEach((x,i)=>{x.checked=cp.gaps[i];x.open=cp.gaps[i];x.live=false;x.pop=0;});
      this.question=null;this.crushGate=null;this.crushT=0;this.invertTime=0;
      g.carSquash=null;if(g.scene)g.scene.drivers=true;
      this.ui.fatal.classList.remove('show');this.ui.fatal.setAttribute('aria-hidden','true');
      this.ui.math.classList.remove('show');this.ui.math.setAttribute('aria-hidden','true');
      global.document.body.classList.remove('forge6-invert','story-cinematic');
      story.setLayer(story.ui.letterbox,false);
      story.setVehicle(g.car,cp.s,0,46);
      if(g.rival)story.setVehicle(g.rival,cp.s-34,5.5,44);
      g.car.surfaceGrip=1;g.car.surfaceDrag=0;g.car.boost=Math.max(g.car.boost||0,.55);
      g.flash=0;g.shake=0;
      this.prevS=cp.s;
      g.state='racing';story.mode='race';
      story.setLayer(story.ui.raceMeta,true);
      this.showRoot();this.updateRule();
      g.hud.toast('REWIND — '+(cp.label||'TRIAL'),'#62e7ff');
      if(g.audio&&g.audio.checkpoint)g.audio.checkpoint();
      return true;
    }
    /* ------------------------------- LOSING THE FORGE, WHICH WAS NOT POSSIBLE
     *
     * Three separate ways this chapter could not be lost, and all three ended
     * with the player being handed the driver link anyway:
     *
     *   JAVAS COULD NOT WIN. He drives the whole line alongside the player,
     *   capped three per cent under them, and nothing anywhere compared the
     *   two positions. He could finish the trials first and the chapter
     *   carried on regardless.
     *
     *   THE GHOST TRIAL REWARDED FAILING IT. Three of five arches or it was
     *   not beaten - and the branch for "not beaten, and there is nowhere to
     *   rewind to" fell through to beginUnlock. The one case where the player
     *   had comprehensively failed was the case that paid out.
     *
     *   AND A FAILURE WAS ALWAYS A REWIND. Every fail() went back to the last
     *   checkpoint, forever, with no count and no end - which is the glitchy
     *   restart in the report. A trial you cannot pass should cost the run,
     *   not loop.
     *
     * All three now come here, and here goes through the one loss path the
     * whole game shares. See loseRace in js/story.js. */
    loseChapter(reason){
      if(this.chapterLost)return;
      const g=this.g;
      /* The run is already over - the line was crossed, or something else
         ended it. There is nothing left to take away and finishing twice
         would run the whole end-of-race sequence on top of itself. */
      if(g.raceOver)return;
      this.chapterLost=true;
      this.phase='lost';
      this.lostTimer=LOST_CARD;
      this.ui.fatalReason.textContent=reason;
      this.ui.fatal.classList.add('show');
      this.ui.fatal.setAttribute('aria-hidden','false');
      g.car.vLong=0;g.car.vLat=0;
      if(g.audio&&g.audio.crash)g.audio.crash(1);
      g.story.hideCompact();
      /* THE LOSS HAS TO BE ACCEPTED, AND IT WAS NOT ALWAYS BEING ACCEPTED.
         `loseRace` refuses anything that is not the race mode, and so does
         `handleFinish` behind it - but this only ever checked that the method
         EXISTED. Raised from a phase that had put the story in
         'level6Special' - a rewind, the ability cinematic, the unlock - the
         call returned false, nothing finished the run, and the card sat there
         over a game that had quietly stopped having an ending. Put the story
         back in the mode the loss path is written for, then hand it over. */
      g.story.mode='race';
      this.handedOver=!!(g.story.loseRace&&g.story.loseRace('JAVAS'));
      if(!this.handedOver){g.won=false;g.finish();}
    }

    /* Has Javas finished the line the player is still on?
       0 = in the fight, 1 = about to be gone, 2 = gone. */
    javasNear(){
      const g=this.g,r=g.rival;
      if(!r||this.chapterLost)return 0;
      /* He reached the end of the trials first, which is the plainest way to
         lose a race and was the one this chapter did not implement. */
      if(r.sTrack>=GHOST_END&&g.car.sTrack<GHOST_END)return 2;
      /* ...or he is simply gone. Half a kilometre of road, which he can only
         open up if the player has stopped, crashed or been rewound - he is
         capped under them for the whole of the line. */
      const gap=r.sTrack-g.car.sTrack;
      return gap>JAVAS_GONE?2:gap>JAVAS_WARN?1:0;
    }
    javasAhead(){return this.javasNear()>=2;}

    fail(reason){
      if(this.phase==='fail'||this.phase==='crush'||this.phase==='lost')return;
      /* A REWIND IS FORGIVENESS, AND FORGIVENESS RUNS OUT. Three goes at a
         trial is generous; the fourth is a chapter the player is not passing
         today, and looping them through the same checkpoint forever is worse
         than telling them so. */
      this.rewinds=(this.rewinds||0)+1;
      if(this.rewinds>3){this.loseChapter(reason+' // NO RUNS LEFT');return;}
      this.phase='fail';this.failTimer=2.2;this.question=null;this.ui.math.classList.remove('show');this.ui.fatalReason.textContent=reason;this.ui.fatal.classList.add('show');this.ui.fatal.setAttribute('aria-hidden','false');this.g.state='story';this.g.story.mode='level6Special';this.g.car.vLong=0;this.g.car.vLat=0;this.g.audio.crash(1);this.g.story.hideCompact();this.g.story.setLayer(this.g.story.ui.raceMeta,false);global.document.body.classList.remove('forge6-invert');
    }
    beginUnlock(){
      if(this.phase==='unlockDialogue'||this.phase==='skillCard')return;this.phase='unlockDialogue';this.g.state='story';this.g.story.mode='level6Special';this.g.car.vLong=0;this.g.rival.vLong=0;this.g.story.setLayer(this.g.story.ui.raceMeta,false);this.g.story.setLayer(this.g.story.ui.letterbox,true);global.document.body.classList.add('story-cinematic');
      this.g.story.dialogue.play([
        {speaker:'JAVAS',expression:'calm',text:'You brought a damaged car through my whole line.',shot:'rival'},
        {speaker:'PLAYER',expression:'focus',text:'And your arch never got me twice the same way.',shot:'player'},
        {speaker:'JAVAS',expression:'smug',text:'No. It did not. That is the only interesting thing about you.',shot:'rival'},
        {speaker:'NOVA',expression:'calm',text:'Show them the mode.',shot:'wide'},
        {speaker:'JAVAS',expression:'calculating',text:"That chassis won't survive the Raptor by asking for more boost.",shot:'rival'},
        {speaker:'JAVAS',expression:'calm',text:'So for thirty seconds, it stops asking.',shot:'rival'},
        {speaker:'JAVAS',expression:'calm',text:'And the engine goes in the skip. You are not taking a street block onto that route.',shot:'wheel'},
        {speaker:'PLAYER',expression:'focus',text:'You are rebuilding it. Here. Now.',shot:'player'},
        {speaker:'JAVAS',expression:'smug',text:'I built the link. The block is the easy half.',shot:'rival'},
        {speaker:'JAVAS',expression:'calm',text:'A hundred and forty-four on the block. Two hundred with the reserve in.',shot:'low'},
        {speaker:'JAVAS',expression:'smug',text:'Go and find out which one you need. Straight seven is clear.',shot:'low'},
        {speaker:'NOVA',expression:'calm',text:'He does not do that for people he expects to lose.',shot:'wide'},
      ],{key:'chapter_6_racemode_unlock',onLine:l=>{this.g.story.currentShot=l.shot||'wide';this.g.story.currentSpeaker=l.speaker;},onDone:()=>this.showSkill()});
    }
    showSkill(){
      /* THE SWAP. Fitted here rather than in a menu: the calibration run is
         the first metre the player drives on it, and `raceMode` and the new
         block are the same gift. */
      if(this.g.car&&this.g.car.fitEngine)this.g.car.fitEngine('swap');
      /* ...AND THE BODY GOES BACK WITH IT.

         Javas is not fitting an engine into a wreck and handing it back bent.
         The panels come out, the bar goes back to full, and the drag and
         reheat penalties the solver has been charging all chapter are gone -
         which is most of why the calibration run feels like a different car
         rather than the same one with a bigger number on the dial. */
      if(this.g.damage&&this.g.damage.reset)this.g.damage.reset();
      if(this.g.car)this.g.car.damage=0;
      /* ...AND IT SAYS WHAT IT IS WORTH, IN BOTH NUMBERS.
         The card used to quote one figure - a 200 mph ceiling - which is what
         the car does WITH the reserve in, for thirty seconds at a time. What
         it does the rest of the time is 144, and that is the half the player
         is about to spend the whole calibration run and the whole of Chapter 7
         driving on. Quoting only the ceiling made the rebuild look like a
         raceMode upgrade rather than a new engine.
         Both are read off the car, so the card cannot quote a figure the
         solver has stopped producing - and the speedometer re-scales to the
         same ceiling at the same moment, see the dial in js/hud.js. */
      const car=this.g.car;
      if(this.ui.swap&&car){
        const eng=Math.round(car.engineTopMph||0),cap=Math.round(car.ceilingMph||0);
        this.ui.swap.textContent='ENGINE REBUILD  \u00b7  '+eng+' MPH ON THE BLOCK'
          +'  \u00b7  '+cap+' MPH WITH THE RESERVE';
      }
      if(car&&this.g.hud&&this.g.hud.toast){
        this.g.hud.toast('ENGINE REBUILT \u2014 '+Math.round(car.engineTopMph||0)+' MPH','#62e7ff');
      }
      this.phase='skillCard';this.phaseTime=0;this.g.story.setDialogueVisible(false);this.ui.skill.classList.add('show');this.ui.skill.setAttribute('aria-hidden','false');this.g.audio.goBeep();}
    startTest(){
      this.phase='test';this.phaseTime=0;this.ui.skill.classList.remove('show');this.ui.skill.setAttribute('aria-hidden','true');this.g.story.mode='race';this.g.state='racing';this.g.story.setLayer(this.g.story.ui.letterbox,false);global.document.body.classList.remove('story-cinematic');
      this.g.story.setVehicle(this.g.car,TEST_START,0,0);this.g.car.boost=1;this.g.story.setVehicle(this.g.rival,START,-6,0);this.g.storyHideRival=true;this.g.distance=TEST_START;this.g.raceOver=false;this.g.raceModeAvailable=true;this.g.blockQuickRestart=true;this.ui.phase.textContent='AURORA FORGE // CALIBRATION';this.ui.objectiveText.textContent='CLEAR THE HAULER';this.updateRule();this.showRound('ABILITY TEST // STRAIGHT 07','raceMode','PRESS R WHEN NOVA CALLS IT. HOLD B UNTIL BLUE RESERVE IS EMPTY.',3.4);this.g.story.showCompact('NOVA','calculating','Hauler ahead. Do not brake yet.',3.4);
    }
    activateRaceMode(){
      if(this.raceModeActive||this.raceModeCooldown>0)return;this.raceModeActive=true;this.raceModeTimer=30;this.raceModeCooldown=70;this.reserveLoaded=false;this.truckCleared=true;this.truckClearT=this.g.time;this.activationTime=0;this.activationS=this.g.car.sTrack;this.activationLateral=this.g.car.lateral||0;this.activationSpeed=Math.max(28,this.g.car.vLong||this.g.car.speed||0);this.phase='modeCinematic';this.g.raceModeActive=true;this.g.raceModeBlueFuel=true;this.g.car.raceModeMultiplier=1.5;this.g.car.boosting=true;this.g.state='story';this.g.story.mode='level6Special';this.g.story.setLayer(this.g.story.ui.letterbox,true);global.document.body.classList.add('forge6-racemode','story-cinematic');this.ui.skill.classList.add('show');this.ui.skill.setAttribute('aria-hidden','false');this.skillFlash=0;if(this.g.fx&&this.g.fx.raceModeBurst)this.g.fx.raceModeBurst(this.g.car);this.g.audio.boostHit();this.g.flash=.09;this.g.shake=.48;this.g.story.showCompact('NOVA','smug','Now. Give it everything.',3.0);
    }
    finishActivation(){
      this.phase='test';this.g.state='racing';this.g.story.mode='race';this.g.story.setLayer(this.g.story.ui.letterbox,false);global.document.body.classList.remove('story-cinematic');this.ui.skill.classList.remove('show');this.ui.skill.setAttribute('aria-hidden','true');this.skillFlash=0;this.g.flash=.12;this.g.shake=.42;this.g.audio.goBeep();
    }
    resetTest(){this.g.story.setVehicle(this.g.car,TEST_START,0,0);this.g.distance=TEST_START;this.g.car.boost=1;this.g.hud.toast('CALIBRATION RESET // USE R BEFORE THE HAULER','#ffb04a');this.g.story.showCompact('JAVAS','calm','The truck was the obvious part.',2.8);}
    updateRaceMode(dt){
      if(this.skillFlash>0){this.skillFlash-=dt;if(this.skillFlash<=0){this.ui.skill.classList.remove('show');this.ui.skill.setAttribute('aria-hidden','true');}}
      this.raceModeCooldown=Math.max(0,this.raceModeCooldown-dt);
      // the readout is the canvas widget now; see Game.syncRaceMode
      if(!this.raceModeActive)return;
      this.raceModeTimer=Math.max(0,this.raceModeTimer-dt);const car=this.g.car;
      if(car.boosting){
        const add=24*dt,forward=Math.sin(car.yaw),depth=Math.cos(car.yaw);car.vLong=Math.min(RACEMODE_CAP,car.vLong+add);car.vx=forward*car.vLong+Math.cos(car.yaw)*car.vLat;car.vz=depth*car.vLong-Math.sin(car.yaw)*car.vLat;car.speed=Math.min(RACEMODE_CAP,Math.hypot(car.vLong,car.vLat));
      }
      if(!this.reserveLoaded&&car.boost<=.021){this.reserveLoaded=true;car.boost=.50;this.g.raceModeBlueFuel=true;this.g.hud.toast('BLUE RESERVE // FLOW RESTORED','#39c7ff');this.g.audio.checkpoint();}
      if((this.reserveLoaded&&car.boost<=.012)||this.raceModeTimer<=0)this.finishRaceMode();
    }
    /* THE CALIBRATION IS PASSED, AND THE CHAPTER HAS TO SAY SO.
     *
     * This is the bug that made BROKEN CIRCUIT the last chapter anybody could
     * play. Chapter 6 does not end at a finish line - it ends when the blue
     * reserve runs out on the calibration run, about a kilometre short of one
     * - so it never passes through the two lines in Game.update that decide a
     * race, and `won` was still false from resetCar when its closing
     * conversation handed over to completeChapter.
     *
     * completeChapter has a door on it: a chapter completes when the player
     * WON it, or when it is the one chapter whose written ending is a defeat
     * and that defeat was earned. Chapter 6 is neither. So every successful
     * run of the Forge reached the last line of Javas congratulating the
     * player, logged "tried to complete without being won" to a console
     * nobody has open, and was recorded as a loss - which meant chapter 6 was
     * never added to completedChapters, NEON HORIZON was never unlocked, and
     * the campaign stopped there.
     *
     * The door is right and stays. What was missing is the chapter answering
     * it. Chapter 5 already does exactly this for the opposite case - it sets
     * `won = false` and `canonicalEarned = true` because its ending is a
     * defeat that still completes; see startFinish above. This is the same
     * statement for a chapter that is simply won.
     *
     * `raceOver` goes with it. Nothing reaches the finish line from here -
     * the state is about to become 'story', and `simulating` is false there -
     * but a trial that has been passed is a race that is over, and saying so
     * is what stops any later path through this chapter firing a second,
     * ordinary finish underneath the ending. */
    finishRaceMode(){
      if(this.finalStarted)return;this.finalStarted=true;
      this.g.won=true;this.g.raceOver=true;
      this.raceModeActive=false;this.g.raceModeActive=false;this.g.raceModeBlueFuel=false;this.g.car.raceModeMultiplier=1;global.document.body.classList.remove('forge6-racemode');this.phase='finalDialogue';this.g.state='story';this.g.story.mode='level6Special';this.g.car.vLong*=.35;this.g.car.vLat=0;this.g.story.setLayer(this.g.story.ui.letterbox,true);global.document.body.classList.add('story-cinematic');
      this.g.story.dialogue.play([
        {speaker:'NOVA',expression:'calm',text:'Blue reserve is empty. Link stayed clean.',shot:'player'},
        {speaker:'PLAYER',expression:'race',text:'It felt like the car got lighter.',shot:'player'},
        {speaker:'JAVAS',expression:'smug',text:"It didn't. You finally stopped asking it politely.",shot:'rival'},
        {speaker:'JAVAS',expression:'calculating',text:'Thirty seconds active. Seventy to cool. The reserve gives boost fifty percent more burn time.',shot:'rival'},
        {speaker:'JAVAS',expression:'calm',text:'raceMode is yours. Next time Ryker runs, make him look back.',shot:'rival'},
        {speaker:'NOVA',expression:'smug',text:"That's Javas congratulating you.",shot:'wide'},
        {speaker:'JAVAS',expression:'calm',text:'Bad habit.',shot:'rival'},
      ],{key:'chapter_6_complete',onLine:l=>{this.g.story.currentShot=l.shot||'wide';this.g.story.currentSpeaker=l.speaker;},onDone:()=>{this.phase='done';this.hideAll();this.g.story.completeChapter();}});
    }
    updateExclusive(dt){
      if(!this.isChapter())return false;
      if(this.phase==='crush')return this.updateCrush(dt);
      if(this.phase==='lost'){
        /* THE CARD IS A BEAT, NOT A DESTINATION.
           It holds for a second and a half so the player can read why the run
           ended, and then THE FRAME GOES BACK to js/story.js, which owns
           everything after that: the finish roll, Javas' line, and the retry.

           Returning true forever is what froze it. This director is the OUTER
           update wrapper - js/chapters.js patches Game.update after
           js/story.js does, see the bottom of both files - so an exclusive
           frame here never reaches story.update, and story.update is the only
           thing that advances the loss. The card came up and the game stopped,
           permanently, with every key still being read by a director that had
           decided it was finished driving. */
        this.lostTimer-=dt;
        if(this.lostTimer>0){
          this.g.story.baseTick(dt,false);
          this.g.story.cameraCar(this.g.car,'hero',58);
          return true;
        }
        if(!this.lostCardDown){
          this.lostCardDown=true;
          this.ui.fatal.classList.remove('show');
          this.ui.fatal.setAttribute('aria-hidden','true');
          if(!this.handedOver){
            /* js/story.js would not take the loss - there is no chapter under
               it, or the run had already ended. Go to the retry directly
               rather than sit on a card with nothing behind it. */
            this.handedOver=true;
            this.g.story.pendingRetryChapter=6;
            this.g.story.retryChapterRace();
            return true;
          }
        }
        return false;
      }
      if(this.phase==='fail'){
        this.g.story.baseTick(dt,false);this.g.story.cameraCar(this.g.car,'hero',58);this.failTimer-=dt;
        if(this.failTimer<=0&&this.cp&&this.rewind())return true;
        if(this.failTimer<=0){this.ui.fatal.classList.remove('show');this.g.story.pendingRetryChapter=6;this.g.story.retryChapterRace();}
        return true;
      }
      if(this.phase==='unlockDialogue'||this.phase==='finalDialogue'){
        this.g.story.baseTick(dt,true);this.g.story.cameraConversation(this.g.story.currentShot||'wide');this.g.story.dialogue.update(dt);return true;
      }
      if(this.phase==='skillCard'){
        this.g.story.baseTick(dt,true);this.g.story.cameraCar(this.g.car,'hero',56);this.phaseTime+=dt;if(this.phaseTime>=4.0)this.startTest();return true;
      }
      if(this.phase==='modeCinematic'){
        this.g.story.baseTick(dt,true);this.activationTime+=dt;
        const carry=this.activationSpeed*(1+.24*smooth(this.activationTime/1.35));
        this.g.story.setVehicle(this.g.car,this.activationS+carry*this.activationTime,this.activationLateral,carry);
        this.g.car.boosting=true;this.g.distance=this.g.car.sTrack;
        if(this.activationTime>.72){this.ui.skill.classList.remove('show');this.ui.skill.setAttribute('aria-hidden','true');}
        const shot=this.activationTime<.48?'wheel':this.activationTime<1.02?'frontLow':'rearLow';
        this.g.story.cameraCar(this.g.car,shot,48+this.activationTime*12);
        if(this.activationTime>=1.35)this.finishActivation();
        return true;
      }
      return false;
    }
    afterUpdate(dt){
      if(!this.isChapter()){if(this.started)this.reset();return;}
      if(this.phase==='done')return;
      if(this.g.story.mode==='race'&&!this.started)this.startTrial();if(!this.started)return;
      this.showRoot();if(this.roundTime>0){this.roundTime-=dt;if(this.roundTime<=0)this.ui.round.classList.remove('show');}
      if(this.invertTime>0){this.invertTime-=dt;if(this.invertTime<=0){this.g.controlsSwapped=false;global.document.body.classList.remove('forge6-invert');this.g.hud.toast('STEERING BUS RESTORED','#66e8ff');}}
      const cap=this.capFor();
      if(cap>0){this.cap(this.g.car,cap);this.cap(this.g.rival,cap*.97);}
      /* He is on this road too, and until now nothing ever looked at where he
         was. Asked only on the phases the player is actually DRIVING - not on
         the calibration run at the end, which is the player alone on Straight
         07, and not while a rewind, a cinematic or a conversation has the car
         parked. Those last three were the ones that hurt: the car is held
         still for two and a bit seconds after a fail while Javas keeps going,
         so a rewind could hand out the loss for the crash it was forgiving.
         And the loss it handed out from there was the one the story refused,
         which is the frozen card. See loseChapter. */
      if(LIVE_PHASES.has(this.phase)){
        /* AND HE IS SEEN COMING. A run that ends the instant a number crosses
           a threshold the player was never shown is a run that ends unfairly;
           the last two hundred metres of the gap are a warning instead. */
        const near=this.javasNear();
        if(near>=2){this.loseChapter('JAVAS TOOK THE LINE');return;}
        if(near===1&&this.g.time-(this.javasWarnT||-9)>3.4){
          this.javasWarnT=this.g.time;
          this.g.hud.toast('JAVAS IS PULLING AWAY','#ff8a3a');
          this.g.story.showCompact('NOVA','calculating','He is gone if you lose any more of this.',2.6);
        }
      }
      if(this.phase==='lightning'){this.armGates(dt);this.checkGates();if(this.g.car.sTrack>=ELECTRIC_END)this.beginMachinery();}
      else if(this.phase==='machinery')this.checkMachines(dt);
      else if(this.phase==='sorting')this.checkSorting(dt);
      else if(this.phase==='scrap')this.updateScrap(dt);
      else if(this.phase==='ghost')this.updateGhost(dt);
      else if(this.phase==='test'){
        if(this.g.input.actHit('raceMode'))this.activateRaceMode();if(!this.raceModeActive)this.cap(this.g.car,DAMAGED_CAP);
        if(this.g.car.sTrack>TRUCK_S-480&&!this.truckPrompt){this.truckPrompt=true;this.g.story.showCompact('NOVA','calculating','R. Now.',2.4);this.g.hud.toast('R — ACTIVATE raceMode','#55dfff');}
        this.updateRaceMode(dt);
      }
      /* Solid hardware, for BOTH cars. The player has to be stopped by it -
         that is the trial - and the rival has to be stopped by it too, or
         Javas simply drives through the press it is supposedly threading. */
      if(this.phase!=='fail'&&this.phase!=='done'&&this.phase!=='crush'){
        this.resolveObstacles(this.g.car,true);
        if(this.g.rival)this.resolveObstacles(this.g.rival,false);
      }
      this.prevS=this.g.car.sTrack;this.updateRule();
    }
  }

  NR.Level6Director=Level6Director;
  function director(g){return g.__level6Director||new Level6Director(g);}

  if(NR.Scene&&!NR.Scene.prototype.__level6WorldPatched){
    const oldWorld=NR.Scene.prototype.drawWorld;
    /* The hall hangs off drawWorld so it is in every pass the world is in -
       including the reflection capture, which has its own much smaller budget
       and its own entry point. Without the split, a 128-pixel cube face drew
       the entire building. */
    NR.Scene.prototype.drawWorld=function(camPos,viewDist){
      oldWorld.call(this,camPos,viewDist);
      const w=this.level6World;
      if(!w||!w.isOn())return;
      if(this.probeCapturing){
        const s=(w.g.distance!==undefined?w.g.distance:(w.g.car&&w.g.car.sTrack))||0;
        w.drawProbe(s);
      }else w.draw();
    };
    NR.Scene.prototype.__level6WorldPatched=true;
  }

  const GP=NR.Game.prototype,oldUpdate=GP.update,oldApply=GP.applyLevel,oldReset=GP.resetCar,oldMenu=GP.toMenu;
  GP.update=function(dt){
    if(!this.scene||!this.scene.ready||!this.scene.carOpaque){oldUpdate.call(this,dt);return;}
    const d=director(this);if(d.updateExclusive(dt))return;oldUpdate.call(this,dt);
    if(this.simulating)d.afterUpdate(dt);
  };
  GP.applyLevel=function(){
    oldApply.call(this);
    if(!this.__level6Director)return;
    this.__level6Director.reset();
    /* Nineteen kilometres of merged hall takes about a third of a second to
       walk and upload. Doing it lazily on the first frame that draws it puts
       that third of a second in the middle of the opening lap; doing it here
       puts it under the chapter title card, where the game is already waiting
       on a fade. */
    if(this.level&&this.level.level6)this.__level6Director.world.build();
  };
  GP.resetCar=function(){oldReset.call(this);if(this.__level6Director&&!(this.story&&this.story.chapter&&this.story.chapter.id===6))this.__level6Director.reset();};
  GP.toMenu=function(){oldMenu.call(this);if(this.__level6Director)this.__level6Director.reset();};

  global.__SYNX_LEVEL6__={name:'BROKEN CIRCUIT',track:'AURORA FORGE',gateRevealMetres:50,electricStrikes:3,inversionSeconds:5,
    quizInputs:'1234',handshakeGlyphs:GLYPHS.length,handshakeLengths:[3,4,5],
    damagedTopKmh:100,raceModeSeconds:30,raceModeCooldown:70,blueReserve:.5,speedMultiplier:1.5,
    engineSwapMph:200,
    trials:['LIGHTNING CRASH','COGNITION PRESS','SORTING FLOOR','SCRAP LINE','GHOST LINE','CALIBRATION'],
    chutes:CHUTE,dividerLateral:DIVIDER,crusherSeconds:4.2,
    bounds:{lightning:[START,ELECTRIC_END],machinery:[ELECTRIC_END,MACHINE_END],sorting:[MACHINE_END,SORT_END],
      scrap:[SORT_END,SCRAP_END],ghost:[SCRAP_END,GHOST_END],test:[TEST_START,TRUCK_S]}};
})(window);



/* ==========================================================================
 * CHAPTER 7 — NEON HORIZON
 * ========================================================================== */
/* SYNX Chapter 7 — NEON HORIZON
 *
 * A fifty-kilometre playable finale. The normal Track, Vehicle, Driver,
 * collision, story and race flow remain authoritative; this file contributes
 * a data-authored megacity, structural glass, three deterministic set pieces,
 * local checkpoint recovery and the R-IX prediction model.
 */
(function(global){
  'use strict';
  const NR=global.NR;
  if(!NR||!NR.Game||NR.Level7World)return;
  const {M4}=NR;
  /* TO is where the WORLD stops, and it is not where the race stops.
     Crossing the line does not park the car - the finish card runs while it
     coasts, which is deliberate - so the deck has to carry it through the
     run-off as well. It used to end at 173,250 against a centreline that runs
     to 173,400, and a car that took the flag at speed drove off the end of the
     road and out over a city sixty-four units below it. */
  /* TO is where the WORLD stops, not where the race does.
     It used to be four hundred units past FINISH, which is the length of the
     run-off - and every post-race camera looks three hundred units up the
     road, so the finale was framed on the edge of the built world with nothing
     behind it. The course itself now carries two and a half kilometres of
     straight road past the flag (see COURSE_LENGTH) and the deck, the grade
     and the city run to the end of it. */
  const FROM=132000,ROUTE_FROM=132070,TO=175800,FINISH=173000;
  const GLASS_A=141420,GLASS_B=145890,DECK_B=146130;
  /* Neon Horizon is an elevated expressway, not a ribbon in a void.
     js/scene.js's generated ground carries the shipped landscape's shape and
     would cut straight through this route's raised deck, so drawWorld culls it
     here - which left the road, the towers, the billboards and the palms all
     hanging on nothing with the sky visible underneath them.
     FLOOR is this chapter's own city grade. Everything that is supposed to be
     standing on the ground is built down to it, and the road is carried above
     it on a deck and piers. */
  const FLOOR=-64, DECK_T=3.2, DECK_HALF=38, PIER_STEP=180;
  /* AN ARCH IS A STRUCTURE, NOT A DECAL.
     Every ring on this route used to be centred low enough that its lower limb
     came down through the carriageway: the Data Cathedral's lintels crossed
     the road at knee height and the maze gates at the deck itself, so the car
     drove THROUGH the thing that was supposed to be spanning it, and the rings
     read as flat decals hung in the air rather than as architecture.
     archRing() lifts each one until its opening clears the road by RING_CLEAR
     and stands it on two columns that meet the ellipse exactly where it
     crosses the deck edge - so it becomes a gantry the road passes under,
     which is what all of them always looked like they were meant to be. */
  const RING_CLEAR=13;             // headroom under the lowest point of an arch
  const RING_FOOT=DECK_HALF-2;     // the furthest out a column can still stand
  /* How far from the centreline the car can actually reach. It is the route's
     own `driveHalf` in js/game.js LEVELS[6]; anything founded inside it is
     something the player can drive into. Written here because archRing has to
     solve against it, and a number solved against the wrong corridor is a
     column in the road. */
  const DRIVE_HALF=30;
  const PRED_MAX_PACE=1.92;    // ...and this is what a closing R-IX looks like
  const PRED_GRIP=0.60;        // extra cornering grip per unit of pursuit
  const PRED_GRIP_CAP=1.34;    // ...but a corner is still a corner
  const PRED_DRIVE=10;         // units/s^2 the momentum drive is worth
  /* THE TRAP RUN.
     Ryker is not racing for position in the first half of this route, he is
     herding: every trap in DEAD AHEAD is one he drops in front of himself, and
     a trap the player has already driven past is a cutscene rather than a
     hazard. So through the trap run he is quicker - properly quicker, by
     driving - and he is telling you why on the channel.

     What is deliberately NOT here any more is a floor on the gap. Holding a
     car's arc length every frame overrides the physics that is meant to be
     driving it: the steering still runs, the position does not answer it, and
     the lateral offset the clamp preserves walks outward until the car is
     scraping a barrier. Over a full run of the finale that had Ryker against a
     wall fifty-five per cent of the time and never more than twenty metres
     away, which reads as a tow rope rather than as a rival. If a player is
     genuinely better than the trap run, they get past it - that is the
     difference between a boss and a barrier. */
  const TRAP_RUN_TO=159840;    // the end of the DEAD AHEAD event
  const TRAP_MATCH=0.30;       // extra terminal speed he asks for while it runs
  /* ---------------------------------------------- THE ONE SPEED DIAL ------
   *
   * `top` IS THE R-IX's SPEED CAP, not a clamp on one term of the model.
   *
   * It used to bound only the momentum drive, which meant it bounded nothing
   * that mattered: the prototype carries an unlimited reserve, and boost
   * thrust alone is worth about a hundred and thirty units a second against
   * this car's drag. So the number in this constant said 118 while the car
   * measured 117 on the twisty districts and 125 on the straights, and every
   * attempt to tune the fight moved terms that were not the binding one.
   *
   * applyModel now writes it to `rival.speedCap`, which the solver's
   * `ceiling()` and the driver's own planner BOTH read - one number, hard, and
   * the only thing standing between this model and a tuner is arithmetic.
   *
   * WHAT THE NUMBERS ARE MEASURED AGAINST. On this route, with the Forge
   * engine, a player driving it well averages:
   *
   *     86 u/s  on nothing but the throttle
   *     86 u/s  spamming boost - the reserve is worth 1.2 s in every 3.6, and
   *             the car cannot even reach the higher ceiling inside a burn, so
   *             ordinary boost is worth well under a unit a second averaged
   *     105 u/s synchronised, peaking at the 120.75 raceMode cap
   *
   * So this sits ABOVE the first two and BELOW the third, which is the whole
   * bargain the chapter is written on: he is quicker than you are, and the
   * thirty seconds of raceMode are the only thing you own that he is not. */
  const PRED_TOP=97;
  /* ...and what it may do while it is CHASING.
     A predator is allowed to run harder than its prey while it is behind it:
     the ceiling lifts with the pursuit and drops straight back the moment the
     R-IX is the one in front, so it buys a chase and never a lead it did not
     drive for. This is also what takes a raceMode window back afterwards - at
     three hundred metres down it runs at 123, which closes a full window's
     worth of road in about twenty seconds. */
  const PRED_CHASE_TOP=24;     // units/s of extra ceiling, at full pursuit
  const PRED_CHASE_GAP=300;    // ...reached this far behind
  /* ...and what it does about a lead it has genuinely lost.
     Past half a kilometre the player is not in a fight with this thing, they
     are away from it, and a boss that cannot come back from that is a boss
     for the first ninety seconds of a thirty-kilometre route. This is the
     difference between a rival and a hunt, and it is only ever available to
     the car that is behind. */
  const PRED_LOST_TOP=18;      // further units/s once the gap is out of hand
  const PRED_LOST_FROM=500, PRED_LOST_TO=1200;
  /* THE ESCAPE, AND THE ONE PLACE THE MODEL IS TOLD TO STAND DOWN.
   *
   * Reported, and the arithmetic agreed: raceMode bought nothing. The match
   * term asked for 121.4 against a synchronised player's 120.75 cap, and the
   * chase ceiling then lifted with the very gap the window was opening - so
   * the counterplay the whole of Chapter 6 exists to hand over was worth about
   * sixty metres and re-armed the thing it was supposed to escape.
   *
   * While the player is synchronised the ceiling is held HERE and the chase
   * and lost terms are switched off entirely. Thirty seconds against a player
   * averaging 105 is a little over four hundred units, and a good line through
   * the fast districts is worth half as much again. It is a window, not an
   * exit: the moment it closes the chase ceiling comes back and so does he. */
  const PRED_MODE_TOP=96;
  /* Terminal speed the R-IX WANTS, as a multiple of a stock car's, in each of
     the three states the player can be in. This is the "how hard is he
     trying" end of the model - it drives the planner's pace, the torque and
     the tyre - while PRED_TOP above is the hard ceiling on the result.

     MODE is deliberately the lowest of the three. A synchronised player is
     doing something the prototype has no answer to, and a model that asks for
     MORE while the one counterplay in the chapter is running is a model that
     has cancelled it. */
  const PRED_MATCH_IDLE=1.14, PRED_MATCH_BOOST=1.17, PRED_MATCH_MODE=1.02;
  /* THE ANSWER TO AN UPGRADE.
   *
   * Every term above is a multiple of a STOCK car's terminal speed, and that
   * is the flaw: the player does not finish this chapter in a stock car. They
   * arrive with the Forge engine (144 mph where the street car did 132) and
   * raceMode on top of it (200 mph), and against a ceiling written in stock
   * multiples the correct play was simply to hold the upgrade down. The R-IX
   * fell behind and stayed behind, which is the opposite of what the chapter
   * is about.
   *
   * So the hunt reads the player's ACTUAL speed as well. `PRED_TAIL` is how
   * much quicker than whatever the player is currently doing the R-IX will ask
   * to be when it is behind them - four per cent, which is a closing rate you
   * can see in the mirror and cannot out-accelerate, but which never becomes a
   * car that is simply somewhere else. It answers an upgrade because it is
   * measured against the upgrade rather than against the car that had none. */
  const PRED_TAIL=1.06;
  /* ...but NOT while they are synchronised. The tail is measured against what
     the player is doing right now, so during a raceMode window it would track
     them up to their own cap and hand the escape straight back. */
  const PRED_TAIL_MODE=0.90;
  /* ...and the pickup. Out of a slow corner an ordinary car is torque-limited
     and this one is not, which is the single most legible thing a chasing car
     can do: it comes back onto your gearbox on the exit. It only applies BELOW
     the speed the driver has decided the corner allows, so it is acceleration
     rather than a higher cornering speed - it can never push the car wide. */
  /* The corner-exit shove, in units per second per second, at full pursuit -
     and the size of the speed deficit that counts as "coming out of a corner".
     Roughly half a g on top of what the car is already doing, which closes a
     corner's worth of lost ground over the following straight without ever
     looking like a car that teleports. */
  /* Both of these were sized when `top` clamped nothing, so the drive was
     doing the work the ceiling should have been doing: thirty plus twenty-six
     is fifty-six units a second per second, which is four g, which is not a
     car accelerating - it is a car being placed. A stock car manages about
     5.6, so these are a supplement of roughly one and two thirds of its own
     acceleration at full pursuit. It still comes back onto your gearbox out
     of a corner; it no longer arrives there instantly. */
  const PRED_PICKUP=11;
  const PRED_PICKUP_TO=34;
  /* A stock car on this route is drag-limited here. Everything the model says
     is a multiple of it, so it has to be written down once. */
  const STOCK_TERMINAL=88;
  const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
  const KM_PER_UNIT=.000733;
  const ZONE_PALETTES=[
    ['#39e6ff','#255dff','#bf38ff'],['#8c31ff','#ff2bd6','#39e6ff'],
    ['#39e6ff','#1b75ff','#b8f5ff'],['#ff9825','#ff3b72','#8538ff'],
    ['#ff3b1e','#ff9b22','#c52cff'],['#39e6ff','#ff2bd6','#91ff31'],
    ['#91ff31','#ff9b22','#5a44ff'],['#ff3b1e','#ff2bd6','#39e6ff'],
    ['#39e6ff','#ffffff','#ff2bd6'],
  ];
  const ZONES=((NR.CHAPTER7_GEOMETRY&&NR.CHAPTER7_GEOMETRY.zones)||[
    {id:'ascension_gate',label:'ASCENSION GATE',from:132000,to:136710},
    {id:'understack',label:'THE UNDERSTACK',from:136710,to:141420},
    {id:'skybreak',label:'SKYBREAK SPAN',from:141420,to:146130},
    {id:'data_cathedral',label:'DATA CATHEDRAL',from:146130,to:150840},
    {id:'the_gauntlet',label:'THE GAUNTLET',from:150840,to:155550},
    {id:'skyscraper_dive',label:'SKYSCRAPER DIVE',from:155550,to:160260},
    {id:'rotation_yard',label:'ROTATION YARD',from:160260,to:164960},
    {id:'tower_run',label:'TOWER RUN',from:164960,to:169670},
    {id:'apex_recursion',label:'APEX RECURSION',from:169670,to:173210},
  ]).map((z,i)=>Object.assign({},z,{palette:ZONE_PALETTES[i%ZONE_PALETTES.length],distanceKm:+((z.to-z.from)*KM_PER_UNIT).toFixed(2)}));

  /* THE THREE SET PIECES.
     Renamed. The middle one used to announce itself as "RYKER: DEAD AHEAD" and
     toast "RYKER DEPLOYING TRAPS", which put him in charge of hazards he does
     not have a mechanism to place - he is in a car, in front of you, driving.
     This is Aurora's validation deck: the hazards are the deck's, they are
     what it was built to test a car against, and he is being driven through
     them at the same time you are. */
  /* WHERE THE LAST SET PIECE STOPS, and the run to the line begins. The
     sector's event, its maze gates, the arches those gates hang on and the
     checkpoint at the far end of them are four separate pieces of code that
     have to agree about one number, so they are given one. */
  const MAZE_FROM=165900,MAZE_STEP=700,MAZE_TO=167800;
  const EVENTS=[
    {id:'skybreak',type:'SKYBREAK',label:'SKYBREAK',from:141240,to:145830,checkpointId:'pre_skybreak'},
    {id:'gauntlet',type:'GAUNTLET',label:'THE GAUNTLET',from:150720,to:159840,checkpointId:'pre_gauntlet'},
    /* THE TOWER RUN ENDS, AND THEN THERE IS A RACE.

       It used to run to the flag. That is not a finale, it is a corridor with
       a finish line at the end of it: whoever is in front when the last slab
       lands stays in front, because there is nothing after it but the line.
       A thirty-kilometre chapter that comes down to the R-IX should come down
       to the two cars, and for that the player needs road - somewhere to
       spend a reserve, take a tow, and make the pass.

       So the sector finishes at 169,000 and the last three kilometres of
       NEON HORIZON are clear deck. Everything in it moved earlier with it;
       see the hazard rows and the maze below, which share MAZE_TO. */
    {id:'tower_run',type:'TOWER_RUN',label:'TOWER RUN',from:165600,to:MAZE_TO,checkpointId:'pre_tower_run'},
  ];
  const CHECKPOINTS=[
    {id:'start',label:'NEON GATE',s:ROUTE_FROM},
    {id:'understack',label:'UNDERSTACK LINK',s:136590},
    {id:'pre_skybreak',label:'SKYBREAK UPLINK',s:141190,eventId:'skybreak'},
    {id:'post_skybreak',label:'GLASS SPAN CLEAR',s:145960,eventId:'skybreak'},
    {id:'pre_gauntlet',label:'GAUNTLET ENTRY',s:150610,eventId:'gauntlet'},
    {id:'post_gauntlet',label:'GAUNTLET CLEAR',s:159910,eventId:'gauntlet'},
    {id:'pre_tower_run',label:'TOWER RUN',s:165500,eventId:'tower_run'},
    // the far side of the maze, and the start of the run to the line
    {id:'apex',label:'APEX RECURSION',s:MAZE_TO,eventId:'predator_maze'},
  ];
  /* THE SET PIECES.
     The first pass fielded six different hazard mechanics across three events -
     retracting glass, a swinging mass, oil, spike beds, dropping barriers and
     a "false route" that failed the player for being in a lane that looked
     exactly like the other one. Six rules is not a set piece, it is a quiz,
     and every one of them ended in the same full checkpoint rewind.

     There are now three verbs, and they are the same three in every event:

       AVOID   a solid object. Touching it is a heavy hit - speed, spin and a
               point of confidence to the R-IX - but the race carries on.
       SLIDE   a surface that takes grip away for a few seconds. No fail.
       FALL    the road itself opens. This is the only thing that rewinds, and
               it only exists on the glass span, where there genuinely is no
               road underneath.

     Every one telegraphs the same way: a RED strip on the lane to leave and a
     CYAN strip on the lane to take, both laid on the road far enough ahead to
     be read at speed. */
  const HAZARDS=[
    /* SKYBREAK - FALL. The only rewind on the route, because it is the only
       place where the road genuinely is not there. Scored over a DISTANCE
       rather than at a line: see updateGlassRun. */
    {id:'sky_panel_a',type:'sky_panel',s:142040,lane:-10.5,safeLane:10.5,eventId:'skybreak',telegraph:520},
    {id:'sky_panel_b',type:'sky_panel',s:142870,lane:10.5,safeLane:-10.5,eventId:'skybreak',telegraph:560},
    {id:'sky_panel_c',type:'sky_panel',s:143780,lane:0,safeLane:11.5,eventId:'skybreak',telegraph:600},
    {id:'sky_panel_d',type:'sky_panel',s:144810,lane:-10.5,safeLane:10.5,eventId:'skybreak',telegraph:640},
    /* THE GAUNTLET - the deck's structural test bay. Five mechanics, and the
       new one is the one that hurts: a shear panel comes off a tower and lands
       across the carriageway. It is telegraphed by its own SHADOW - the patch
       of road it is going to occupy, painted before it arrives - which is the
       only honest way to telegraph something that comes from above. */
    /* ONE AT A TIME, AND WITH ROOM TO READ IT.

       The spacings here were 760, 1730, 890, 930, 1720, 1030 and 710, and a
       hazard is painted on the road a telegraph-length before it arrives - so
       the 760 and the 710 put the next warning on the deck while the last
       object was still ahead of the car. Two hazards telegraphed at once is
       not a harder gauntlet, it is an unreadable one: a player who commits to
       the cyan lane of the second is in the red lane of the first. The two
       1,7xx gaps were the opposite problem - half a kilometre of nothing in
       the middle of the set piece.

       Ten sixty apart, all eight of them, which clears the longest telegraph
       on the route (820) with room over. The first one now sits nine hundred
       units inside the event instead of three hundred outside it, so its
       warning is painted on a deck the gauntlet has actually been announced
       on. Types, lanes and order are exactly what they were - this is where
       they stand, not what they do. */
    {id:'slab_a',type:'slab',s:151620,lane:-12,safeLane:12,eventId:'gauntlet',telegraph:760,radius:15},
    {id:'ball_a',type:'metal_ball',s:152680,lane:0,safeLane:12,eventId:'gauntlet',telegraph:620,radius:8},
    {id:'oil_a',type:'oil',s:153740,lane:-9,safeLane:9,eventId:'gauntlet',telegraph:520,radius:9},
    {id:'slab_b',type:'slab',s:154800,lane:10,safeLane:-13,eventId:'gauntlet',telegraph:780,radius:16},
    {id:'barrier_a',type:'barrier',s:155860,lane:9,safeLane:-11,eventId:'gauntlet',telegraph:640,radius:11},
    {id:'ball_b',type:'metal_ball',s:156920,lane:-11,safeLane:10,eventId:'gauntlet',telegraph:660,radius:8},
    {id:'slab_c',type:'slab',s:157980,lane:0,safeLane:14,eventId:'gauntlet',telegraph:820,radius:17},
    {id:'oil_b',type:'oil',s:159040,lane:8,safeLane:-10,eventId:'gauntlet',telegraph:560,radius:9},
    /* THE TOWER RUN - the last sector. The sensor gates are live all the way
       through it (see updateMazeGates) and the towers either side are coming
       apart, so a slab lands between every second gate. This is the hardest
       stretch on the route and it is meant to be. */
    /* AND NOBODY GETS MUGGED ON THE LINE.

       The last of these stood at 172,180. The flag is at 173,000 - eight
       hundred and twenty units, which at the speed this deck is taken at is
       nine seconds. A shear panel coming off a tower nine seconds from the
       end does not test anything: there is no race left to recover in, so it
       either happens to miss you or it decides the chapter, and which of
       those it does is not up to the player.

       They finish at 170,280 now, which leaves two thousand seven hundred
       units - about thirty seconds - of clear deck between the last falling
       thing and the line. The sector is still the hardest on the route and
       still ends on the maze, which is a line to thread rather than an object
       that hits you; what the finale no longer does is take the decision off
       the two cars in the last ten seconds of a thirty kilometre race.

       Nine hundred and forty apart, which clears the 860 telegraph on the
       last one, and the first is far enough inside the event for its own
       warning to be painted after the sector is announced. */
    /* AND NOBODY GETS MUGGED ON THE LINE.

       The last of these stood at 172,180 - eight hundred and twenty units
       short of the flag, which at the speed this deck is taken at is nine
       seconds. A shear panel coming off a tower nine seconds from the end
       does not test anything: there is no race left to recover in, so it
       either happens to miss you or it decides the chapter, and which of
       those it does is not up to the player.

       They finish at 168,750 now. That is four thousand two hundred and fifty
       units - THREE KILOMETRES, about forty-five seconds - of clear deck
       between the last falling thing and the line, which is the run-in the
       finale needed and did not have.

       Eight hundred apart on a six-hundred telegraph: six and a half seconds
       of warning each, in family with the gauntlet's, and enough room that no
       two are ever painted on the deck at once. */
    /* AND NOBODY GETS MUGGED ON THE LINE.

       The last of these once stood at 172,180 - eight hundred units short of
       the flag, nine seconds at the speed this deck is taken at. A shear panel
       coming off a tower nine seconds from the end does not test anything:
       there is no race left to recover in, so it either happens to miss you or
       it decides the chapter, and which of those it does is not up to the
       player.

       THREE, NOT FOUR, AND THEY FINISH AT 167,700. That is five thousand three
       hundred units - nearly four kilometres, the best part of a minute - of
       clear deck between the last falling thing and the line. The finale is a
       thirty-kilometre race against the R-IX and it has to come down to the
       two cars: the player needs road to spend a reserve on, take a tow down
       and make the pass, and a sector that runs to the flag takes all of that
       away.

       They are easier to take, too. Seven hundred apart on a 620 telegraph, so
       each one is read on its own with nearly seven seconds of warning; and
       the panels are smaller - thirteen and fourteen rather than sixteen and
       eighteen - so a car that is visibly beside one is past it. This is the
       last thing between the player and the end of the campaign, and it was
       the hardest thing on the route AND the closest to the line. */
    /* THE CYAN LINE IS OUTSIDE THE FOOTPRINT, and it was not.
       A shear panel is SLAB_LEN across - forty-two units, two thirds of this
       deck - centred on its own lane, and being under one is now fatal. So
       where the panel lands and where the player is told to be cannot overlap,
       and on the middle one they did: lane 0 covers -21..21 and the cyan strip
       was painted at 15, inside it, with a tolerance of 5.6 either side. The
       line the game drew was under the thing it was telling you to avoid.
       Every safe lane now clears its own panel by more than the tolerance, so
       a car anywhere on the paint is a car the slab misses. */
    {id:'slab_d',type:'slab',s:166300,lane:-14,safeLane:19,eventId:'tower_run',telegraph:620,radius:13},
    {id:'slab_e',type:'slab',s:167000,lane:12,safeLane:-19,eventId:'tower_run',telegraph:620,radius:13},
    {id:'slab_f',type:'slab',s:167700,lane:-9,safeLane:21,eventId:'tower_run',telegraph:620,radius:14},
  ];
  /* THE LINE, not the way out.

     A red strip on the lane to leave and a cyan strip on the lane to take used
     to mean "be anywhere except the red one", so the whole middle of a sixty-
     four-unit deck was a pass. The cyan strip is the line now: anything that is
     not on it takes the hazard, including the empty road between the two. The
     tolerance is wider than the strip is drawn, so a car that is visibly on the
     paint is always clear - what it costs is committing to a lane instead of
     drifting between them. */
  /* ----------------------------------------------------- the stunt course --
   *
   * Three launch ramps in the quiet stretch between the tunnel that ends at
   * 162,294 and the first maze gate - the one part of Neon Horizon that was
   * kilometres of clear expressway with nothing on it but scenery.
   *
   * WHAT A JUMP NEEDS THAT THIS GAME DID NOT HAVE. The solver is road-locked:
   * a car's height is the road's elevation plus its spring travel, so there
   * was no state in which it could be anywhere the road was not. The vertical
   * dynamics are in crates/synx-core/src/vehicle.rs - see the note above
   * `Ramp` there - and everything below is the COURSE: where the ramps are,
   * what they look like, and what the landing is worth.
   *
   * THE RULE IS THE LANDING, not the jump. Anyone can drive up a ramp. The
   * trial is arriving straight: the score is the angle between where the car
   * is pointing and where the road is going at the moment the wheels touch,
   * and a bad one scrubs speed rather than ending the run. That makes it a
   * thing to get better at rather than a thing to survive, which is the same
   * bargain every other trial on this route makes.
   *
   * They get harder in the order they are met, which is the only progression
   * a set piece with no dialogue in it can have - and WHERE they stand is not
   * a matter of taste either, because the score is that heading error: what a
   * site costs is the angle the road turns through while the car is in the
   * air. See COURSE_RAMPS in js/game.js, which is where the rows live and
   * which carries the measurement for all eight of them.
   */
  /* THIS ROUTE'S THREE, READ OFF THE COURSE'S OWN TABLE.
     They used to be authored here, which is what made them a property of the
     finale rather than of the road - so nothing but the player was ever
     launched by them and no other route had any. The rows are now in
     COURSE_RAMPS in js/game.js alongside the other five, `Game.updateRamps`
     arms whichever is next for every car being simulated, and what is left
     here is what genuinely belongs to the chapter: the objective line, the
     scoring and the voice. */
  const JUMPS=(NR.COURSE_RAMPS||[]).filter(r=>r.level===7);
  const JUMP_TELEGRAPH=NR.RAMP_TELEGRAPH===undefined?280:NR.RAMP_TELEGRAPH;
  /* What a landing has to score to count as clean. The solver's `landing` is
     1 at dead straight and 0 at twelve degrees out, squared - so 0.62 is about
     four and a half degrees, which is tight enough to be worth doing and wide
     enough that a deliberate line through it lands it. */
  const JUMP_CLEAN=NR.RAMP_CLEAN===undefined?0.62:NR.RAMP_CLEAN;

  const SAFE_TOL=5.6;
  /* THE GLASS RUN, AS A DISTANCE.
   *
   * Reported, and the reported version is exactly what it was: the span was
   * scored at ONE LINE, four units before each panel. Everything before that
   * was decoration, so the correct play was to drive anywhere at all and flick
   * onto the cyan strip in the last car length - which is not a set piece, it
   * is a quick-time event with a very long fuse.
   *
   * It is a RUN now. Each panel owns a stretch of the span, and the player has
   * to be on the line for most of it:
   *
   *   GLASS_IN / GLASS_OUT   how much road the run covers, either side of the
   *                          panel itself
   *   GLASS_HOLD             the fraction of that they have to hold. Not all
   *                          of it - a car changing lanes at a hundred and
   *                          thirty needs somewhere to arrive from.
   *   GLASS_GRACE            and how far they may be off it in one go before
   *                          the deck simply opens under them. This is the
   *                          teleport-back the report asks for, and it happens
   *                          WHERE it happens rather than at the panel.
   */
  const GLASS_IN=210, GLASS_OUT=40, GLASS_HOLD=.68, GLASS_GRACE=34;
  /* THE SHEAR PANEL.
   *
   * A slab of a tower comes off and lands across the carriageway. It replaces
   * the phantom - the prediction model drawn as a car - because with the model
   * gone the phantom was a rule with nothing behind it, and because what this
   * route was missing was the thing Chapter 5 does best: something enormous
   * arriving from outside the road.
   *
   * The whole trap is in the telegraph. Something that falls from above cannot
   * be read by looking ahead, so the road is told first: the patch of tarmac
   * it will occupy is painted, in red, from `telegraph` units out - and the
   * slab itself is visible above it the whole time, tipping. By the time it is
   * moving fast the decision has already been made.
   *
   * SLAB_FALL is how long it takes from release to landing, and it starts
   * SLAB_DROP units up - which at deck speed means a car that is still in the
   * marked lane a second out cannot get out of it. That is the point. */
  const SLAB_FALL=1.45, SLAB_DROP=96, SLAB_LEN=42, SLAB_H=9;
  /* THE HUNT.

     `gapM` is metres, positive when the player leads.

     The trap this went through twice is worth writing down. `raceModeMultiplier`
     raises a top-speed CEILING, and a ceiling is not speed: a stock car is
     already drag-limited around 83 units/s and goes no faster for being allowed
     to. So the finale's "1.5x envelope" bought the R-IX nothing at all, while
     the player's raceMode - which injects velocity directly, up to 120 - was
     worth about forty per cent. That is the whole five-hundred-metre gap the
     boss fight was losing, and no amount of AI skill closes it, because it was
     never a driving problem.

     The model is therefore written in terms of the terminal speed the R-IX
     wants, as a multiple of a stock car's, and the thrust is derived from it:
     drag goes with the square of speed, so torque has to as well.

       MATCH is what it does to stay level - a shade over a boosting player, a
       shade under a synchronised one. At match it is a stock car on stock
       tyres, which is why an ordinary boost burn is worth about ten metres.
       HUNT is what it does about a lead, and only this buys grip and thrust.
       That is what makes it read as a predator rather than a difficulty slider:
       an ordinary rival right up until you get away from it. */
  function huntPace(gapM,o){
    o=o||{};
    const conf=o.confidence===undefined?1:o.confidence;
    const hunt=clamp(gapM/170,0,1);
    const surge=clamp((gapM-140)/300,0,1);
    /* The hunt, rebuilt. The first pass weighted it so lightly that a lead the
       R-IX had "decided to close" closed at about eight units a second, which
       over the twelve seconds a raceMode window is worth is eighty units - a
       tenth of the lead. It read as a fast rival rather than as something
       coming for you, and the harness said so: nought per cent of the window
       taken back. It is a predator or it is a difficulty slider. */
    /* THE CHASE IS NOT THE PREDICTION.
       Confidence is the model's certainty about where you will BE, and losing
       it is the whole counterplay - but it used to halve the pursuit as well,
       so a player who drove unpredictably did not merely stop being predicted,
       they stopped being followed. Zero confidence now costs a fifth of the
       hunt rather than nearly half of it: the R-IX still cannot read you, and
       it is still right behind you. */
    const pursuit=(hunt*.72+surge*.62)*(.82+.18*conf);
    /* ...and it genuinely eases when IT is the one out in front. A ten per
       cent give-up over nine hundred metres is not easing off, it is running
       away: at a kilometre and a half ahead the old model still asked for 1.24
       of a stock car's terminal speed, so a player who lost the opening
       exchange never saw the R-IX again and the finale was decided in its
       first minute. */
    /* It eases only when it is genuinely clear, and by less than it did.
       A predator that backs off the moment it takes a lead hands the race back
       every time it wins an exchange; ten per cent over half a kilometre is
       enough to stop it disappearing over the horizon and no more. */
    const ease=0; // Holding a lead never asks the boss to slow down.
    // terminal speed it wants, as a multiple of a stock car's
    /* There is no `pressure` term any more - see the long note above
       RETAKE_CLEAR. What he does about being overtaken is entirely in `hunt`
       and `surge` below, both of which are functions of the gap. */
    const match=(o.playerMode?PRED_MATCH_MODE:o.playerBoosting?PRED_MATCH_BOOST:PRED_MATCH_IDLE)
      +(o.trapRun?TRAP_MATCH:0);
    let wantV=clamp((match+ease)*(.97+.03*conf)+pursuit*.92,.90,PRED_MAX_PACE/1.05);

    /* THE FLOOR THE UPGRADES CANNOT GET UNDER.
       Everything above is a multiple of a stock car. This is the same number
       expressed against what the player is ACTUALLY doing right now, and the
       hunt takes whichever is greater - so the Forge engine and raceMode move
       the target with them instead of walking away from it. Only while behind:
       once the R-IX is ahead there is nothing to answer. */
    if(o.playerV>0){
      const tail=(o.playerV/STOCK_TERMINAL)
        *(o.playerMode?PRED_TAIL_MODE:PRED_TAIL)*(.94+.06*conf);
      wantV=Math.max(wantV,Math.min(tail,PRED_MAX_PACE/1.05));
    }
    /* The ceiling, which is the thing that actually decides whether a lead can
       be closed. Squared, so being alongside costs nothing and being half a
       kilometre back is a hunt; and nought whenever the R-IX is ahead. */
    const chase=clamp(gapM/PRED_CHASE_GAP,0,1);
    const lost=clamp((gapM-PRED_LOST_FROM)/(PRED_LOST_TO-PRED_LOST_FROM),0,1);
    /* THE WINDOW. While the player is synchronised the ceiling is held and
       neither gap term is allowed to lift it - otherwise the chase answers the
       very distance the escape is opening, which is what made the Chapter 6
       reward worth sixty metres. Everything comes back the frame it ends. */
    const top=o.playerMode
      ? Math.min(PRED_MODE_TOP,PRED_TOP)
      : PRED_TOP+chase*chase*PRED_CHASE_TOP+lost*PRED_LOST_TOP;
    return {
      pace:clamp(wantV*1.05,.92,PRED_MAX_PACE),
      // The ceiling. `chase` earns him speed for a gap that has opened, and
      // `lost` for one that has opened a long way.
      top,
      chase,pursuit,wantV,
      /* Torque, and barely any of it.

         Squaring the wanted speed gave 2.4x a stock car's drive, which at the
         speed a corner exit happens at is not a faster car, it is a car with
         no rear grip - and the hunt curve then read the gap that lost it as a
         reason to ask for more. Everything that makes this thing quick is
         either a target the driver aims at or an injection that cannot break
         traction; the engine is very nearly stock, on purpose. */
      power:clamp(1+(wantV-1)*.45,1,1.32),
      /* Same argument for the tyre. A quarter more grip is a tenth more
         corner speed, which is a real advantage over a whole route and is
         still inside what the chassis can carry. */
      grip:clamp(1+pursuit*PRED_GRIP,1,PRED_GRIP_CAP),
    };
  }
  /* HOW HARD HE IS TRYING, and what makes it move.
   *
   * This replaces the prediction model. That model reported a percentage the
   * player could not act on directly, competed for attention with the one
   * instrument on this route they must read - the hazard call in the middle of
   * the frame - and asked them to play against an abstraction rather than
   * against a car. What is left is the part that was actually doing the work:
   * one number, never displayed, that says how hard the R-IX is pushing.
   *
   * It is driven by the RACE rather than by a guess about the player:
   *
   *   BEING LED      every second the player is in front of him raises it.
   *                  A predator that is behind is a predator that is working.
   *   BEING PASSED   an overtake is a step, not a slope - it is the moment the
   *                  chapter is about and he answers it immediately.
   *   BEING AHEAD    a lead he is comfortable with lets it back down, so the
   *                  race breathes instead of running at maximum for thirty
   *                  kilometres.
   *   CONTACT        he takes a hit personally.
   */
  const RIVALRY_LED=0.052, RIVALRY_PASS=0.30, RIVALRY_EASE=0.030, RIVALRY_HIT=0.10;
  /* ------------------------------------------------------------ PRESSURE --
   *
   * THE COUNTER-ATTACK, AND WHY THERE IS NO LONGER ONE.
   *
   * Two of them have stood here. The first was a timed burst: once the player
   * had held the lead for a few seconds the R-IX spent a scripted eleven
   * seconds worth a quarter more pace and fifty units of extra ceiling, then
   * sat in a seventeen-second cooldown during which nothing could provoke him
   * at all - which made him PASSIVE at exactly the moment the player had just
   * gone past, the opposite of a predator.
   *
   * It was replaced by `pressure`: one integrator, no states, no timers,
   * rising while the player was in front and feeding extra terminal speed and
   * extra ceiling into the same hunt curve everything else went through. That
   * was a better shape and it worked.
   *
   * BOTH ARE GONE NOW, removed on request. The reason is worth recording
   * exactly, because the reason GIVEN for the removal was that the counter-
   * attack was making the R-IX dash from one side of the deck to the other
   * instead of racing - and it was not, and could not have been. Every term
   * `pressure` fed was longitudinal: a terminal speed, a ceiling, a skill
   * nudge and the reheat lamp. Not one of them could move the car sideways.
   *
   * The dash was in the general overtaking controller in ai::Driver, which
   * committed to a side to pass on and then released and re-armed that
   * commitment every time the lead changed hands - so on a route whose whole
   * design keeps the two cars level, the side flipped every few seconds and
   * the car chased it across the road. Seventeen units of travel, measured.
   * That is fixed at source; see the long note in `drive`.
   *
   * WHAT ANSWERS AN OVERTAKE NOW is the hunt curve alone, and the hunt curve
   * is a function of the GAP. He still comes back - a gap he has decided to
   * close, closes - but he comes back over a few hundred units rather than
   * immediately, and there is one fewer system with an opinion about how fast
   * he ought to be going. Measured on the balance probe his ceiling is 118
   * units/s against 129 with the counter-attack; the player's engine holds 96,
   * boost 100 and the sync window 133, so boost still does not shake him off
   * and raceMode still does. The chapter's argument is unchanged.
   */
  /* How far ahead he has to be before he claims the place back out loud. Not
     zero: a car being drafted a metre behind has not been passed, and a line
     that fires on every twitch of the gap is noise. */
  const RETAKE_CLEAR=9;

  function confidenceDelta(sample){
    sample=sample||{};
    let d=.016;
    if((sample.moved||0)>2.2)d-=.038;
    if((sample.drift||0)>.28)d-=.034;
    if(sample.speedFeint)d-=.030;
    if(sample.raceMode)d-=.052;
    if(sample.routeChange)d-=.040;
    return clamp(d,-.115,.022);
  }
  function telegraphSeconds(speed,type){
    const base={metal_ball:5.4,oil:4.6,barrier:5.6,sky_panel:5.2,slab:6.4};
    return clamp((base[type]||4.6)+clamp((speed||0)/160,0,1.2)*.65,4,7.5);
  }
  const neonPulse=(speed,phase,low)=>t=>{
    const floor=low===undefined?.64:low;
    return floor+(1-floor)*(.5+.5*Math.sin(t*speed+phase));
  };

  /* Every mesh this route builds carries the box it lives in.
   *
   * Chapter 7 culled on arc length alone, which is a window along the road and
   * says nothing about across it. On a route with a three-tier city standing
   * on both sides that is most of what it submits: at any moment half the
   * skyline is behind the camera's shoulder and most of the rest is outside a
   * ninety-degree cone. The renderer already extracts frustum planes from the
   * view-projection matrix and tests the shipped dressing against them
   * (Scene.setFrustum / boxVisible); this is what lets the finale's own
   * geometry use the same test, and it is where most of the level's frame
   * time was going. The box costs one pass over the vertices at build time. */
  function meshBounds(V){
    if(!V.length)return[0,0,0,0,0,0];
    let a=V[0],b=V[1],c=V[2],d=a,e=b,f=c;
    for(let i=8;i<V.length;i+=8){
      const x=V[i],y=V[i+1],z=V[i+2];
      if(x<a)a=x;else if(x>d)d=x;
      if(y<b)b=y;else if(y>e)e=y;
      if(z<c)c=z;else if(z>f)f=z;
    }
    return[a,b,c,d,e,f];
  }
  function makeMesh(gl,V,I,name){
    /* V and I arrive either as ordinary arrays (the emitters below build them
       that way) or as typed arrays straight out of the core's baker. Wrapping
       a Float32Array in `new Float32Array(...)` would copy it again for
       nothing, which on a route that bakes half a million vertices is a
       megabyte of pointless work per chunk. */
    const vf=V instanceof Float32Array?V:new Float32Array(V);
    const idx=I instanceof Uint32Array?I:new Uint32Array(I);
    const vao=gl.createVertexArray();gl.bindVertexArray(vao);
    const vb=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,vb);gl.bufferData(gl.ARRAY_BUFFER,vf,gl.STATIC_DRAW);
    const ib=gl.createBuffer();gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,ib);gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,idx,gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);gl.vertexAttribPointer(0,3,gl.FLOAT,false,32,0);
    gl.enableVertexAttribArray(1);gl.vertexAttribPointer(1,3,gl.FLOAT,false,32,12);
    gl.enableVertexAttribArray(2);gl.vertexAttribPointer(2,2,gl.FLOAT,false,32,24);
    gl.bindVertexArray(null);
    return{vao,vb,ib,count:idx.length,vCount:vf.length/8,name,aabb:meshBounds(vf)};
  }
  /* The same merge, in JavaScript, for a build with no core. It is never the
     path that runs in the shipped game; it exists so that a development
     checkout without a compiled .wasm still produces a correct route rather
     than an empty one. */
  function bakeFallback(srcV,srcI,list){
    const V=[],I=[],n=list.length,per=srcV.length/8;
    for(let k=0;k<n;k++){
      const mats=list[k],o=0,base=k*per;
      const m0=mats[o],m1=mats[o+1],m2=mats[o+2],m4=mats[o+4],m5=mats[o+5],m6=mats[o+6];
      const m8=mats[o+8],m9=mats[o+9],m10=mats[o+10],m12=mats[o+12],m13=mats[o+13],m14=mats[o+14];
      for(let i=0;i<srcV.length;i+=8){
        const x=srcV[i],y=srcV[i+1],z=srcV[i+2],nx=srcV[i+3],ny=srcV[i+4],nz=srcV[i+5];
        let qx=m0*nx+m4*ny+m8*nz,qy=m1*nx+m5*ny+m9*nz,qz=m2*nx+m6*ny+m10*nz;
        const inv=1/Math.max(1e-6,Math.hypot(qx,qy,qz));
        V.push(m0*x+m4*y+m8*z+m12,m1*x+m5*y+m9*z+m13,m2*x+m6*y+m10*z+m14,
          qx*inv,qy*inv,qz*inv,srcV[i+6],srcV[i+7]);
      }
      for(let i=0;i<srcI.length;i++)I.push(base+srcI[i]);
    }
    return [V,I];
  }
  function makeCube(gl){
    const V=[],I=[],face=(n,a,b,c,d)=>{const o=V.length/8,ps=[a,b,c,d],uv=[[0,0],[1,0],[1,1],[0,1]];
      for(let i=0;i<4;i++)V.push(...ps[i],...n,...uv[i]);I.push(o,o+1,o+2,o,o+2,o+3);};
    face([1,0,0],[.5,-.5,-.5],[.5,-.5,.5],[.5,.5,.5],[.5,.5,-.5]);
    face([-1,0,0],[-.5,-.5,.5],[-.5,-.5,-.5],[-.5,.5,-.5],[-.5,.5,.5]);
    face([0,1,0],[-.5,.5,-.5],[.5,.5,-.5],[.5,.5,.5],[-.5,.5,.5]);
    face([0,-1,0],[-.5,-.5,.5],[.5,-.5,.5],[.5,-.5,-.5],[-.5,-.5,-.5]);
    face([0,0,1],[.5,-.5,.5],[-.5,-.5,.5],[-.5,.5,.5],[.5,.5,.5]);
    face([0,0,-1],[-.5,-.5,-.5],[.5,-.5,-.5],[.5,.5,-.5],[-.5,.5,-.5]);
    const mesh=makeMesh(gl,V,I,'Neon7Cube');mesh._sourceV=V;mesh._sourceI=I;return mesh;
  }
  function makeRing(gl,segments){
    const V=[],I=[],n=segments||32,ro=.5,ri=.455,d=.09;
    for(let i=0;i<n;i++){const a=i/n*Math.PI*2,c=Math.cos(a),s=Math.sin(a);
      for(const q of [[ro,d],[ri,d],[ro,-d],[ri,-d]])V.push(c*q[0],s*q[0],q[1],0,0,q[1]>0?1:-1,i/n,q[0]===ro?1:0);}
    const at=(i,j)=>(i%n)*4+j;
    for(let i=0;i<n;i++){const j=i+1;I.push(at(i,0),at(i,1),at(j,1),at(i,0),at(j,1),at(j,0));I.push(at(i,2),at(j,3),at(i,3),at(i,2),at(j,2),at(j,3));}
    /* The source geometry is kept, exactly as the cube's is, so ring items can
       be merged too. Without it `bakeCubeItems` had no choice but to leave
       every arch, gate and portal ring as an individual draw call. */
    const mesh=makeMesh(gl,V,I,'Neon7Ring');mesh._sourceV=V;mesh._sourceI=I;return mesh;
  }
  function makeSphere(gl,segments,rings){
    const V=[],I=[],n=segments||24,m=rings||12;
    for(let y=0;y<=m;y++){
      const v=y/m,phi=v*Math.PI,sy=Math.cos(phi)*.5,sr=Math.sin(phi)*.5;
      for(let x=0;x<=n;x++){
        const u=x/n,a=u*Math.PI*2,nx=Math.sin(a)*Math.sin(phi),nz=Math.cos(a)*Math.sin(phi),ny=Math.cos(phi);
        V.push(Math.sin(a)*sr,sy,Math.cos(a)*sr,nx,ny,nz,u,v);
      }
    }
    for(let y=0;y<m;y++)for(let x=0;x<n;x++){
      const a=y*(n+1)+x,b=a+n+1;I.push(a,b,a+1,a+1,b,b+1);
    }
    return makeMesh(gl,V,I,'Neon7Sphere');
  }
  function material(sc,name,color,emis,mode,opts){
    opts=opts||{};
    return{name,tex:opts.tex||null,nrm:opts.nrm||null,
      // js/scene.js drives a building's windows from a tiled emissive texture,
      // which is how the shipped city gets lit facades for one draw call. The
      // Chapter 7 skyline uses exactly the same sheet.
      emisTex:opts.emisTex||null,emisTile:opts.emisTile||null,
      color:[color[0],color[1],color[2],opts.alpha===undefined?1:opts.alpha],
      tint:opts.tint||[.5,.5,.5,.5],emis:emis||[0,0,0],gain:opts.gain||0,cutoff:.25,tiling:opts.tiling||[1,1],offset:[0,0],
      _smooth:opts.smooth===undefined?.35:opts.smooth,_metal:opts.metal||0,_reflect:opts.reflect||0,mode,
      noFog:!!opts.noFog,pulse:opts.pulse||null};
  }
  function part(sc,mesh,mat){return{mesh:{iOff:0,vCount:mesh.vCount,name:mesh.name},sub:{start:0,count:mesh.count},mode:sc.modeId(mat.mode),_mesh:mesh,mat,m:M4.identity(M4.make())};}
  function scaled(out,x,y,z,yaw,pitch,roll,sx,sy,sz){
    M4.trs(out,x,y,z,yaw||0,pitch||0,roll||0);
    for(let i=0;i<4;i++)out[i]*=sx;for(let i=4;i<8;i++)out[i]*=sy;for(let i=8;i<12;i++)out[i]*=sz;
  }
  function lanePoint(track,s,lat,y){const p=track.at(s,{}),rx=Math.cos(p.yaw),rz=-Math.sin(p.yaw);return[p.x+rx*lat,(p.y||0)+(y||0),p.z+rz*lat,p];}
  function ribbon(gl,track,s0,s1,l0,l1,y,name){
    const V=[],I=[];let o=0;
    for(let s=s0;s<s1-.01;s+=24){const e=Math.min(s1,s+24),a=lanePoint(track,s,l0,y),b=lanePoint(track,s,l1,y),c=lanePoint(track,e,l1,y),d=lanePoint(track,e,l0,y);
      const vv=[[a,0,0],[b,1,0],[c,1,1],[d,0,1]];for(const q of vv)V.push(q[0][0],q[0][1],q[0][2],0,1,0,q[1],(s/18)+q[2]*((e-s)/18));
      I.push(o,o+1,o+2,o,o+2,o+3);o+=4;}
    return makeMesh(gl,V,I,name);
  }
  /* A horizontal sheet at one absolute world height, independent of the road's
     own elevation - the city floor and everything laid on it. */
  function flatRibbon(gl,track,s0,s1,l0,l1,worldY,step,name){
    const V=[],I=[];let o=0,dz=step||36;
    for(let s=s0;s<s1-.01;s+=dz){
      const e=Math.min(s1,s+dz);
      const q=(ss,lat)=>{const p=track.at(ss,{}),rx=Math.cos(p.yaw),rz=-Math.sin(p.yaw);return[p.x+rx*lat,worldY,p.z+rz*lat];};
      const a=q(s,l0),b=q(s,l1),c=q(e,l1),d=q(e,l0);
      const vv=[[a,0,0],[b,1,0],[c,1,1],[d,0,1]];
      for(const v of vv)V.push(v[0][0],v[0][1],v[0][2],0,1,0,v[1],(s/90)+v[2]*((e-s)/90));
      I.push(o,o+1,o+2,o,o+2,o+3);o+=4;
    }
    return makeMesh(gl,V,I,name);
  }
  /* EVERY LANE OF THE FLOOR GRID, IN ONE MESH.
   *
   * The city grade's longitudinal light lines were eight separate flatRibbon
   * calls per chunk, and the chunk was 1,200 units against a draw window of
   * sixteen thousand - a hundred and twelve draw calls a frame to lay down
   * eight straight lines. They share a material and they never move relative
   * to one another, so they are one buffer: fourteen calls become one, and the
   * vertex count is identical. */
  function flatRibbonLanes(gl,track,s0,s1,lanes,worldY,step,name){
    const V=[],I=[];let o=0,dz=step||36;
    for(let s=s0;s<s1-.01;s+=dz){
      const e=Math.min(s1,s+dz);
      const pa=track.at(s,{}),pb=track.at(e,{});
      const ax=Math.cos(pa.yaw),az=-Math.sin(pa.yaw);
      const bx=Math.cos(pb.yaw),bz=-Math.sin(pb.yaw);
      for(const ln of lanes){
        const l0=ln[0],l1=ln[1];
        const a=[pa.x+ax*l0,worldY,pa.z+az*l0],b=[pa.x+ax*l1,worldY,pa.z+az*l1];
        const c=[pb.x+bx*l1,worldY,pb.z+bz*l1],d=[pb.x+bx*l0,worldY,pb.z+bz*l0];
        const vv=[[a,0,0],[b,1,0],[c,1,1],[d,0,1]];
        for(const v of vv)V.push(v[0][0],v[0][1],v[0][2],0,1,0,v[1],(s/90)+v[2]*((e-s)/90));
        I.push(o,o+1,o+2,o,o+2,o+3);o+=4;
      }
    }
    return makeMesh(gl,V,I,name);
  }

  /* ROAD MARKINGS, AND WHY THEY ARE NOT CUBES.
   *
   * Every dash as its own box is twenty-four vertices to draw a rectangle, and
   * a lane divider down a forty-one kilometre route is three thousand of them.
   * Worse, each of these builders used to be called once PER LINE - four
   * polished bands, four rubber lines, two dividers, two shoulders, two
   * hatchings - which is thirteen draw calls for a chunk of road whose
   * markings are all the same paint and never move relative to each other.
   *
   * So each takes a LIST. One call, one buffer, one draw per material per
   * chunk, four vertices a dash. That is the whole difference between road
   * detailing being affordable on this route and not.
   */

  /* Longitudinal bands, following the road's own elevation.
     `bands` is [[latFrom, latTo, height], ...]. */
  function roadBands(gl,track,s0,s1,bands,name){
    const V=[],I=[];let o=0;
    for(let s=s0;s<s1-.01;s+=24){
      const e=Math.min(s1,s+24);
      const pa=track.at(s,{}),pb=track.at(e,{});
      const ax=Math.cos(pa.yaw),az=-Math.sin(pa.yaw),ay=pa.y||0;
      const bx=Math.cos(pb.yaw),bz=-Math.sin(pb.yaw),by=pb.y||0;
      for(const q of bands){
        const l0=q[0],l1=q[1],y=q[2];
        const v=[
          [pa.x+ax*l0,ay+y,pa.z+az*l0,0,0],
          [pa.x+ax*l1,ay+y,pa.z+az*l1,1,0],
          [pb.x+bx*l1,by+y,pb.z+bz*l1,1,1],
          [pb.x+bx*l0,by+y,pb.z+bz*l0,0,1],
        ];
        for(const t of v)V.push(t[0],t[1],t[2],0,1,0,t[3],(s/18)+t[4]*((e-s)/18));
        I.push(o,o+1,o+2,o,o+2,o+3);o+=4;
      }
    }
    return makeMesh(gl,V,I,name);
  }

  /* Broken lines. `specs` is [{lat, half, dash, gap, y}]; a dash of 0 means a
     continuous line, which is how a shoulder marking and a lane divider come
     out of the same buffer. */
  function roadLines(gl,track,s0,s1,specs,name){
    const V=[],I=[];let o=0;
    const put=(a,b,l0,l1,y)=>{
      const pa=track.at(a,{}),pb=track.at(b,{});
      const ax=Math.cos(pa.yaw),az=-Math.sin(pa.yaw),ay=pa.y||0;
      const bx=Math.cos(pb.yaw),bz=-Math.sin(pb.yaw),by=pb.y||0;
      const v=[
        [pa.x+ax*l0,ay+y,pa.z+az*l0,0,0],
        [pa.x+ax*l1,ay+y,pa.z+az*l1,1,0],
        [pb.x+bx*l1,by+y,pb.z+bz*l1,1,1],
        [pb.x+bx*l0,by+y,pb.z+bz*l0,0,1],
      ];
      for(const t of v)V.push(t[0],t[1],t[2],0,1,0,t[3],t[4]);
      I.push(o,o+1,o+2,o,o+2,o+3);o+=4;
    };
    for(const q of specs){
      const l0=q.lat-q.half,l1=q.lat+q.half;
      if(!q.dash){
        for(let a=s0;a<s1-.01;a+=24)put(a,Math.min(s1,a+24),l0,l1,q.y);
        continue;
      }
      const pitch=q.dash+q.gap;
      for(let a=Math.ceil(s0/pitch)*pitch;a<s1;a+=pitch){
        const b=Math.min(s1,a+q.dash);
        if(b>a+.01)put(a,b,l0,l1,q.y);
      }
    }
    return makeMesh(gl,V,I,name);
  }

  /* Bands ACROSS the road, repeated: the viaduct's expansion joints, and the
     rumble strips on the approach to a bore. */
  function crossBands(gl,track,s0,s1,l0,l1,pitch,width,y,name){
    const V=[],I=[];let o=0;
    for(let a=Math.ceil(s0/pitch)*pitch;a<s1;a+=pitch){
      const b=Math.min(s1,a+width);
      if(b<=a+.005)continue;
      const pa=track.at(a,{}),pb=track.at(b,{});
      const ax=Math.cos(pa.yaw),az=-Math.sin(pa.yaw),ay=pa.y||0;
      const bx=Math.cos(pb.yaw),bz=-Math.sin(pb.yaw),by=pb.y||0;
      const v=[
        [pa.x+ax*l0,ay+y,pa.z+az*l0,0,0],
        [pa.x+ax*l1,ay+y,pa.z+az*l1,1,0],
        [pb.x+bx*l1,by+y,pb.z+bz*l1,1,1],
        [pb.x+bx*l0,by+y,pb.z+bz*l0,0,1],
      ];
      for(const t of v)V.push(t[0],t[1],t[2],0,1,0,t[3],t[4]);
      I.push(o,o+1,o+2,o,o+2,o+3);o+=4;
    }
    return makeMesh(gl,V,I,name);
  }

  /* Diagonal hatching, both shoulders, in one buffer. */
  function hatchStrips(gl,track,s0,s1,lats,half,pitch,skew,y,name){
    const V=[],I=[];let o=0;
    for(let a=Math.ceil(s0/pitch)*pitch;a<s1-skew-3;a+=pitch){
      const pa=track.at(a,{}),pb=track.at(a+2.4,{});
      const pc=track.at(a+skew,{}),pd=track.at(a+skew+2.4,{});
      const ax=Math.cos(pa.yaw),az=-Math.sin(pa.yaw),ay=pa.y||0;
      const bx=Math.cos(pb.yaw),bz=-Math.sin(pb.yaw),by=pb.y||0;
      const cx=Math.cos(pc.yaw),cz=-Math.sin(pc.yaw),cyy=pc.y||0;
      const dx=Math.cos(pd.yaw),dz=-Math.sin(pd.yaw),dy=pd.y||0;
      for(const lat of lats){
        const l0=lat-half,l1=lat+half;
        const v=[
          [pa.x+ax*l0,ay+y,pa.z+az*l0,0,0],
          [pb.x+bx*l0,by+y,pb.z+bz*l0,1,0],
          [pd.x+dx*l1,dy+y,pd.z+dz*l1,1,1],
          [pc.x+cx*l1,cyy+y,pc.z+cz*l1,0,1],
        ];
        for(const t of v)V.push(t[0],t[1],t[2],0,1,0,t[3],t[4]);
        I.push(o,o+1,o+2,o,o+2,o+3);o+=4;
      }
    }
    return makeMesh(gl,V,I,name);
  }

  /* A vertical strip between two heights measured from the road, for the
     deck's own fascia. */
  function fascia(gl,track,s0,s1,lat,y0,y1,name){
    const V=[],I=[];let o=0,side=lat<0?1:-1;
    for(let s=s0;s<s1-.01;s+=24){
      const e=Math.min(s1,s+24);
      const a=lanePoint(track,s,lat,y0),b=lanePoint(track,e,lat,y0),
            c=lanePoint(track,e,lat,y1),d=lanePoint(track,s,lat,y1);
      const n=[Math.cos(a[3].yaw)*side,0,-Math.sin(a[3].yaw)*side],vv=[[a,0,0],[b,1,0],[c,1,1],[d,0,1]];
      for(const q of vv)V.push(q[0][0],q[0][1],q[0][2],...n,q[1],q[2]);
      I.push(o,o+1,o+2,o,o+2,o+3);o+=4;
    }
    return makeMesh(gl,V,I,name);
  }
  function wall(gl,track,s0,s1,lat,h,name){
    const V=[],I=[];let o=0,side=lat<0?1:-1;
    for(let s=s0;s<s1-.01;s+=24){const e=Math.min(s1,s+24),a=lanePoint(track,s,lat,.05),b=lanePoint(track,e,lat,.05),c=lanePoint(track,e,lat,h),d=lanePoint(track,s,lat,h);
      const n=[Math.cos(a[3].yaw)*side,0,-Math.sin(a[3].yaw)*side],vv=[[a,0,0],[b,1,0],[c,1,1],[d,0,1]];
      for(const q of vv)V.push(q[0][0],q[0][1],q[0][2],...n,q[1],q[2]);I.push(o,o+1,o+2,o,o+2,o+3);o+=4;}
    return makeMesh(gl,V,I,name);
  }

  class Level7World{
    constructor(game){
      this.g=game;this.sc=game.scene;this.gl=game.gl;this.track=game.track;this.cube=makeCube(this.gl);this.ring=makeRing(this.gl,36);this.sphere=makeSphere(this.gl,24,12);
      this.opaque=[];this.blend=[];this.glow=[];this.itemsOpaque=[];this.itemsBlend=[];this.itemsGlow=[];
      /* The city grade is drawn on its own, much longer leash. Everything else
         on this route is cut off at the draw window and hidden by fog, but a
         ground plane that stops inside the fog does not disappear - its far
         edge lands as a hard bright band right across the horizon, with the
         road apparently ending at it. It is the single most "unfinished" thing
         the route was doing, and it is a draw-distance artefact, not geometry. */
      this.groundOpaque=[];this.groundGlow=[];
      /* The back row of the skyline, kept apart from everything else so it can
         be given its own draw window and dropped from a reflection face. */
      this.horizon=[];this.itemsHorizon=[];
      /* Anything this build places inside the driving corridor, recorded by
         name. A skybridge authored as FLOOR+66 was correct while the city
         grade was -34 and became a 168-unit wall across the carriageway the
         moment the grade moved to -64 to give the towers somewhere to stand.
         Nothing catches that by reading the arithmetic; this does. */
      this.corridorViolations=[];
      /* Timed, in the same table the rest of the load reports through, because
         this is the one build in the game that is not the shipped scene's and
         it is the one the frame budget of this route depends on. */
      const T=(global.__synxLoad=global.__synxLoad||{});
      const mark=(k,fn)=>{const a=performance.now();fn();T[k]=+(performance.now()-a).toFixed(1);};
      mark('l7Materials',()=>this.buildMaterials());
      mark('l7Ground',()=>this.buildGround());
      mark('l7Road',()=>{this.buildRoad();this.buildRoadDetail();this.buildSubstructure();});
      mark('l7City',()=>this.buildCity());
      mark('l7Props',()=>{this.buildTunnels();this.buildGlassway();this.buildHighwayNetwork();this.buildLandmarks();});
      mark('l7Bake',()=>this.finalize());
      this.sc.level7World=this;
    }
    buildMaterials(){const s=this.sc;
      // The reference keeps the asphalt almost black.  Saturated architecture,
      // lane light and wet reflections supply the colour instead of a pale road.
      this.asphalt=material(s,'Neon7Asphalt',[.026,.030,.046],[.001,.002,.006],'lit',{tex:'sunset_road_new.png',nrm:'sunset_road_NRM.png',tiling:[4,1],smooth:.58,reflect:.46});
      this.carbon=material(s,'Neon7Carbon',[.012,.016,.027],[.001,.003,.007],'lit',{nrm:'sunset_road_NRM.png',tiling:[8,2],smooth:.70,metal:.42,reflect:.54});
      this.grate=material(s,'Neon7Grate',[.020,.024,.032],[.002,.004,.008],'lit',{smooth:.30,metal:.82,reflect:.26});
      this.roadGrid=material(s,'Neon7RoadGrid',[.008,.018,.050],[.002,.036,.16],'lit',{smooth:.64,metal:.22,reflect:.52});
      this.steel=material(s,'Neon7Steel',[.022,.028,.055],[.003,.006,.018],'lit',{smooth:.62,metal:.88});
      this.tower=material(s,'Neon7Tower',[.010,.012,.030],[.001,.002,.009],'lit',{smooth:.41,metal:.44});
      this.glass=material(s,'Neon7Glass',[.015,.095,.34],[.002,.018,.075],'glass',{alpha:.18,tint:[.02,.20,.72,.20],gain:.025,smooth:.94,reflect:.86});
      this.glassWall=material(s,'Neon7GlassWall',[.010,.070,.26],[.002,.015,.065],'glass',{alpha:.15,tint:[.01,.18,.65,.18],gain:.02,smooth:.92,reflect:.80});
      this.oil=material(s,'Neon7Oil',[.025,.006,.035],[.012,.002,.022],'glass',{alpha:.28,tint:[.12,.02,.16,.30],gain:.03,smooth:.98,reflect:.92});
      this.hazardSteel=material(s,'Neon7HazardSteel',[.045,.050,.060],[.004,.005,.008],'lit',{smooth:.66,metal:.95,reflect:.46});
      this.cyan=material(s,'Neon7Cyan',[.005,.065,.18],[.005,.14,.46],'glow',{alpha:.68,gain:.22,noFog:true});
      this.blue=material(s,'Neon7Blue',[.006,.04,.18],[.004,.10,.52],'glow',{alpha:.70,gain:.22,noFog:true});
      this.grid=material(s,'Neon7Grid',[.003,.016,.07],[.003,.055,.25],'glow',{alpha:.40,gain:.09,noFog:true});
      // Four offset phases keep the city alive without strobing the whole view.
      /* THE FACADES ARE LIT SURFACES, NOT LAMPS.
         These four went out at gain .50-.54 on emissives at or near 1.0, with
         `noFog` and 84% alpha - a saturated panel emitting at full strength
         right up to the lens, on every block, three of them pulsing. That is a
         frame with no shadow in it and no depth cue except size, and it is
         why the route out-shouted the road, the car and the rival at once.
         Halved, stepped back toward their own base tone, and made translucent
         enough that the block behind reads as being behind. */
      this.cityCyan=material(s,'Neon7CityCyan',[.003,.048,.15],[.010,.36,.62],'glow',{alpha:.62,gain:.26,noFog:true,pulse:neonPulse(1.65,.0,.62)});
      this.cityMagenta=material(s,'Neon7CityMagenta',[.15,.003,.080],[.56,.010,.30],'glow',{alpha:.62,gain:.26,noFog:true,pulse:neonPulse(1.35,1.7,.60)});
      this.cityLime=material(s,'Neon7CityLime',[.021,.12,.005],[.085,.54,.014],'glow',{alpha:.60,gain:.24,noFog:true,pulse:neonPulse(1.52,3.0,.58)});
      this.cityGold=material(s,'Neon7CityGold',[.15,.062,.002],[.60,.19,.006],'glow',{alpha:.62,gain:.25,noFog:true,pulse:neonPulse(1.18,4.5,.61)});
      this.red=material(s,'Neon7Red',[.15,.004,.055],[.34,.006,.06],'glow',{alpha:.73,gain:.25,noFog:true});
      this.magenta=material(s,'Neon7Magenta',[.13,.006,.10],[.30,.008,.18],'glow',{alpha:.74,gain:.28,noFog:true});
      this.orange=material(s,'Neon7Sunburst',[.18,.032,.003],[.30,.058,.003],'glow',{alpha:.70,gain:.24,noFog:true});
      this.yellow=material(s,'Neon7Reflector',[.15,.09,.003],[.54,.25,.006],'glow',{alpha:.82,gain:.24,noFog:true,pulse:neonPulse(2.4,.5,.52)});
      this.white=material(s,'Neon7Finish',[.10,.15,.20],[.28,.38,.52],'glow',{alpha:.78,gain:.26,noFog:true});
      // Skyline rings cover far more pixels than a window strip. Lower energy
      // preserves their cyan/lime hue through bloom instead of clipping an
      // entire landmark to white.
      this.ringCool=material(s,'Neon7RingCyan',[.001,.018,.055],[.0005,.030,.10],'glow',{alpha:.64,gain:.03,noFog:true});
      this.ringAcid=material(s,'Neon7RingLime',[.010,.045,.002],[.040,.14,.002],'glow',{alpha:.64,gain:.04,noFog:true});
      // The city grade and the structure that stands on it. Deliberately near
      // black and rough: the deck reads as mass, and every colour in the frame
      // still comes from neon rather than from a lit surface.
      /* A smooth surface seen at grazing incidence is a mirror, and the city
         grade is a plane the size of the route seen edge-on from the deck. At
         any appreciable smoothness its Fresnel term turns the whole horizon
         into a hard white bar with the road apparently ending at it - which is
         what the "elements all over the place" complaint was actually looking
         at. Matte, so the grade stays a grade. */
      this.floorMat=material(s,'Neon7CityFloor',[.009,.010,.020],[.001,.002,.005],'lit',{smooth:.04,metal:0,reflect:0,tiling:[6,6]});
      this.floorGrid=material(s,'Neon7FloorGrid',[.003,.020,.07],[.003,.055,.19],'glow',{alpha:.40,gain:.06,noFog:false});
      this.deck=material(s,'Neon7Deck',[.020,.022,.038],[.002,.003,.008],'lit',{smooth:.34,metal:.30});
      this.pier=material(s,'Neon7Pier',[.026,.028,.044],[.002,.004,.010],'lit',{smooth:.40,metal:.42});
      // Aurora's own hardware. The deck is a validation route, not a street:
      // instrumented gantries, sensor masts and hazard-marked service bays,
      // in exactly the greys and cyans the Aurora Forge is built from.
      this.auroraPanel=material(s,'AuroraDeckPanel',[.030,.040,.052],[.004,.010,.016],'lit',{smooth:.58,metal:.62});
      this.auroraSign=material(s,'AuroraDeckSign',[.003,.055,.12],[.004,.16,.40],'glow',{alpha:.78,gain:.18,noFog:true});
      this.auroraHazard=material(s,'AuroraDeckHazard',[.24,.15,.02],[.52,.26,.010],'glow',{alpha:.82,gain:.30,noFog:true,pulse:neonPulse(1.9,.9,.55)});
      /* THE SKYLINE.
         The first pass drew every building as a near-black box and then hung
         a handful of thin neon strips on it. That is a wireframe, not a city:
         the facades stayed dark, the gaps between the boxes showed the void
         behind them, and it cost a draw call per strip.

         js/scene.js already solves this for the shipped city - one `lit`
         material with `sunset_grid.png` as a TILED EMISSIVE, so every window
         on a tower lights up for free. These are the same material, in six
         vibrant tints and two densities, and they are what makes Neon Horizon
         a colourful place rather than a set of silhouettes. */
      /* A lit tower is two surfaces, because the shader's emissive is a
         single masked term and neither mask alone is a building:

           BODY   no emissive texture, so `emMask` falls back to the albedo and
                  the whole mass glows its own colour. On its own this is a
                  flat slab of colour - vibrant, but featureless.
           GRID   a shell half a unit proud of the body, masked by
                  `sunset_grid.png`. Its average is 2/255, so on its own it
                  lights the mullions and leaves the glass between them dead -
                  a wireframe, which is what the first pass looked like.

         Together they are a coloured tower with its windows picked out, which
         is what the shipped Midnight City skyline reads as and what this route
         was missing. The shell costs vertices, not draw calls: everything here
         is merged per chunk by bakeCubeItems(). */
      const body=(name,base,emis,gain)=>material(s,name,base,emis,'lit',{
        nrm:'speed_bump_normal.png',gain,smooth:.22,metal:.06,reflect:.03});
      const facade=(name,base,emis,gain,tile)=>material(s,name,base,emis,'lit',{
        emisTex:'sunset_grid.png',emisTile:tile,nrm:'speed_bump_normal.png',
        gain,smooth:.30,metal:.10,reflect:.06});
      const TINTS=[
        ['Cyan',[.014,.026,.052],[.10,.66,1.00]],
        ['Magenta',[.046,.014,.038],[1.00,.11,.58]],
        ['Violet',[.026,.018,.058],[.52,.20,1.00]],
        ['Gold',[.040,.024,.010],[.86,.44,.06]],
        ['Lime',[.015,.038,.015],[.26,.82,.15]],
        ['Ice',[.024,.034,.055],[.58,.84,1.00]],
      ];
      this.bodyNear=TINTS.map(t=>body('Neon7Body'+t[0],
        [t[1][0]*2.2,t[1][1]*2.2,t[1][2]*2.2],t[2],.58));
      this.facadeNear=TINTS.map(t=>facade('Neon7Facade'+t[0],
        [t[1][0]*.5,t[1][1]*.5,t[1][2]*.5],[t[2][0]*1.15+.10,t[2][1]*1.15+.10,t[2][2]*1.15+.10],1.55,[7,24]));
      /* The middle distance and the horizon carry MORE gain, not less. Fog
         eats an emissive at range, so matching the near towers' brightness on
         paper leaves the far city reading as black slabs - which is what made
         the skyline look like a wall of holes. */
      /* The horizon only ever gets the body: a window grid a kilometre away
         mips down to its own average, which is black, so paying for the shell
         out there buys a darker skyline for more vertices. */
      this.facadeFar=TINTS.map(t=>body('Neon7Skyline'+t[0],
        [t[1][0]*1.35,t[1][1]*1.35,t[1][2]*1.5],t[2],.52));
      /* THE BACK ROW IS ITS OWN MATERIAL SET, and not because it looks
         different - it is the same body shader at the same gain. It is so the
         bake groups it separately.
         bakeCubeItems merges by (chunk, material), so a tier that shares a
         material with the tier in front of it lands in the same buffer and can
         never be dropped, skipped for a reflection face or given a shorter
         leash on a slow machine. Two kilometres of skyline is the one thing on
         this route that is pure backdrop, and this is what makes it separable. */
      this.facadeHorizon=TINTS.map(t=>body('Neon7Horizon'+t[0],
        [t[1][0]*1.35,t[1][1]*1.35,t[1][2]*1.5],t[2],.52));
      for(const m of this.facadeHorizon)m._horizon=true;
      for(const m of this.facadeFar)m._city=true;
      for(const m of this.bodyNear)m._city=true;
      for(const m of this.facadeNear)m._city=true;
      /* --- ROAD FURNITURE ---------------------------------------------
         What a real carriageway has on it and this one did not. All of it is
         merged into the chunk buffers, so the whole set is a handful of draw
         calls whatever the route does.

         The paint is a LIT material with a high reflect, not a glow: road
         markings are not light sources, they are retroreflective sheeting, and
         the whole reason they read at night is that they throw the headlights
         back at the car. Making them emissive is what turns a road into a
         diagram of a road. */
      this.paint=material(s,'Neon7Paint',[.42,.46,.52],[.030,.038,.050],'lit',
        {smooth:.52,metal:.05,reflect:.55,gain:.05});
      this.paintWarm=material(s,'Neon7PaintWarm',[.52,.36,.10],[.055,.032,.004],'lit',
        {smooth:.50,metal:.05,reflect:.50,gain:.06});
      // the joint between two deck sections: a recessed dark seam with a
      // sealant bead in it, which is what breaks up a kilometre of flat tarmac
      this.joint=material(s,'Neon7Joint',[.010,.011,.016],[.0004,.0008,.0018],'lit',
        {smooth:.22,metal:.30,reflect:.14});
      // worn surface: where the racing line has polished the aggregate
      this.polish=material(s,'Neon7Polish',[.034,.038,.056],[.001,.002,.006],'lit',
        {nrm:'sunset_road_NRM.png',tiling:[3,1],smooth:.70,metal:.10,reflect:.62});
      this.rubber=material(s,'Neon7Rubber',[.014,.014,.017],[.0004,.0004,.0008],'lit',
        {smooth:.30,metal:.02,reflect:.10});
      this.kerb=material(s,'Neon7Kerb',[.048,.050,.058],[.003,.004,.007],'lit',
        {smooth:.38,metal:.18,reflect:.22});
      this.podiumMat=material(s,'Neon7Podium',[.013,.015,.025],[.002,.004,.009],'lit',{smooth:.16,metal:.08,reflect:.04});
      /* THE SHEAR PANEL'S CONCRETE.
         Poured, not painted: a rough dielectric with the road's own normal map
         on it, so a slab lying across the deck under the neon reads as the
         same material the piers and the podium are made of rather than as a
         prop that arrived from another game. Its lit edge is the rebar cage
         glowing where it tore. */
      this.slabMat=material(s,'Neon7Slab',[.085,.088,.098],[.004,.004,.006],'lit',
        {nrm:'sunset_road_NRM.png',tiling:[2,2],smooth:.24,metal:.06,reflect:.10});
      this.slabEdge=material(s,'Neon7SlabEdge',[.30,.14,.03],[.62,.20,.03],'glow',
        {alpha:.72,gain:.20,noFog:true});
      this.p={slab:part(s,this.cube,this.slabMat),slabEdge:part(s,this.cube,this.slabEdge),steel:part(s,this.cube,this.steel),deck:part(s,this.cube,this.deck),pier:part(s,this.cube,this.pier),hazardSteel:part(s,this.cube,this.hazardSteel),hazardBall:part(s,this.sphere,this.hazardSteel),oil:part(s,this.cube,this.oil),
        floorGrid:part(s,this.cube,this.floorGrid),auroraPanel:part(s,this.cube,this.auroraPanel),auroraSign:part(s,this.cube,this.auroraSign),auroraHazard:part(s,this.cube,this.auroraHazard),tower:part(s,this.cube,this.tower),cyan:part(s,this.cube,this.cyan),blue:part(s,this.cube,this.blue),grid:part(s,this.cube,this.grid),grate:part(s,this.cube,this.grate),cityCyan:part(s,this.cube,this.cityCyan),cityMagenta:part(s,this.cube,this.cityMagenta),cityLime:part(s,this.cube,this.cityLime),cityGold:part(s,this.cube,this.cityGold),red:part(s,this.cube,this.red),magenta:part(s,this.cube,this.magenta),orange:part(s,this.cube,this.orange),yellow:part(s,this.cube,this.yellow),white:part(s,this.cube,this.white),glass:part(s,this.cube,this.glassWall),ringSteel:part(s,this.ring,this.steel),ringOrange:part(s,this.ring,this.orange),ringMagenta:part(s,this.ring,this.magenta),ringCyan:part(s,this.ring,this.ringCool),ringLime:part(s,this.ring,this.ringAcid)};
      this.pPaint=part(s,this.cube,this.paint);
      this.pPaintWarm=part(s,this.cube,this.paintWarm);
      this.pKerb=part(s,this.cube,this.kerb);
      this.pJoint=part(s,this.cube,this.joint);
      this.pRubber=part(s,this.cube,this.rubber);
      this.pBodyNear=this.bodyNear.map(m=>part(s,this.cube,m));
      this.pFacadeNear=this.facadeNear.map(m=>part(s,this.cube,m));
      this.pFacadeFar=this.facadeFar.map(m=>part(s,this.cube,m));
      this.pFacadeHorizon=this.facadeHorizon.map(m=>part(s,this.cube,m));
      this.podiumMat._city=true;
      this.pPodium=part(s,this.cube,this.podiumMat);
      this.cityPhases=[this.p.cityCyan,this.p.cityMagenta,this.p.cityLime,this.p.cityGold];
      this.roadMats=[this.asphalt,this.carbon,this.grate,this.roadGrid,this.asphalt,this.carbon,this.grate,this.roadGrid,this.carbon];
    }
    /* HOW FAR BACK THE SCAN HAS TO REACH, kept by the list itself.

       drawMeshes finds its first candidate with a binary search on s0, so it
       has to start BEFORE the window by at least the length of the longest
       mesh in the list - otherwise a mesh that starts behind the window and
       runs right through it is never even looked at. That margin used to be
       the constant 2,100, which was true of everything here until it was not:
       a wider bake bucket makes 3,600-unit meshes, and the city they are made
       of vanished for the stretch of every bucket that fell outside the old
       margin. Buildings gone, neon still standing, and only on some parts of
       the route - see the note on chunkSize in bakeCubeItems.

       A constant cannot know that. The list does: every mesh that goes into
       one records its own span, and the widest wins. */
    addMesh(list,mesh,mat,s0,s1){
      const p=part(this.sc,mesh,mat);p.s0=s0;p.s1=s1;p.aabb=mesh.aabb;
      const span=(s1-s0)||0;
      if(!(list.reach>=span))list.reach=span;
      list.push(p);return p;
    }
    /* The world box of a unit primitive under `m`.
       Every item on this route is a cube, a ring or a sphere, and all three fit
       inside the unit box - so the extent along each world axis is the sum of
       the absolute values of that row of the upper 3x3, which is the standard
       AABB-of-a-transformed-box and needs no vertices. */
    itemBounds(m){
      const ex=Math.abs(m[0])+Math.abs(m[4])+Math.abs(m[8]);
      const ey=Math.abs(m[1])+Math.abs(m[5])+Math.abs(m[9]);
      const ez=Math.abs(m[2])+Math.abs(m[6])+Math.abs(m[10]);
      return[m[12]-ex*.5,m[13]-ey*.5,m[14]-ez*.5,m[12]+ex*.5,m[13]+ey*.5,m[14]+ez*.5];
    }
    /* Place a box at an ABSOLUTE world height rather than relative to the
       road. Anything standing on the city floor has to use this - relative
       placement is exactly why the towers were riding up and down with the
       flyovers instead of staying on the ground. */
    addWorld(list,s,lat,worldY,sx,sy,sz,p,yawOff,pitch,roll){
      const a=this.track.at(clamp(s,FROM,TO-3),{}),rx=Math.cos(a.yaw),rz=-Math.sin(a.yaw),m=M4.make();
      this.checkCorridor(p,lat,worldY-(a.y||0),sx,sy,'world@'+(s|0));
      scaled(m,a.x+rx*(lat||0),worldY,a.z+rz*(lat||0),a.yaw+(yawOff||0),pitch||0,roll||0,sx,sy,sz);
      list.push({s,p,m,aabb:this.itemBounds(m)});
    }
    /* The corridor is the 60 units of road the car can actually be on, from
       just above the surface to well over its roof. Thin road furniture - lane
       lights, chevrons, grid strips - is allowed in it; anything with real
       height is not, and nothing that spans the road is. */
    checkCorridor(p,lat,y,sx,sy,where){
      if(sy<=0.8)return;                       // road furniture, not structure
      /* A RING IS A HOLE.
         The bore linings and the arch glows are annuli, and the box around one
         contains the opening the road goes through - so a 76x46 lining
         correctly centred on the carriageway looks, to a box test, exactly
         like a 76x46 slab across it. Their clearance is the ellipse's own
         inner opening, which archRing already founds against RING_CLEAR. */
      if(p&&p._mesh===this.ring)return;
      const top=y+sy*.5,bot=y-sy*.5;
      if(top<0.5||bot>12)return;               // under the deck, or safely over it
      if(Math.abs(lat)-sx*.5>30)return;        // outside the driving corridor
      this.corridorViolations.push((p&&p.mat&&p.mat.name||'?')+' '+where+
        ' lat'+lat.toFixed(0)+' y'+y.toFixed(1)+' w'+sx.toFixed(0)+'x'+sy.toFixed(1));
    }
    addItem(list,s,lat,y,sx,sy,sz,p,yawOff,pitch,roll){
      const a=this.track.at(clamp(s,FROM,TO-3),{}),rx=Math.cos(a.yaw),rz=-Math.sin(a.yaw),m=M4.make();
      /* The corridor guard covered addWorld and not this, which is half the
         placements on the route - including every gantry, portal and arch
         column. A guard that only watches one of the two ways to put an object
         on the road is a guard that will eventually be surprised. */
      this.checkCorridor(p,lat||0,y||0,sx,sy,'item@'+(s|0));
      const back=this.track.at(s-6,{}),ahead=this.track.at(s+6,{}),roadPitch=-Math.atan2((ahead.y||0)-(back.y||0),12);
      scaled(m,a.x+rx*(lat||0),(a.y||0)+(y||0),a.z+rz*(lat||0),a.yaw+(yawOff||0),(pitch===undefined?roadPitch:pitch),roll||0,sx,sy,sz);
      list.push({s,p,m,aabb:this.itemBounds(m)});
    }
    /* One founded arch across the road. `w`/`h` are the ellipse; everything
       else is worked out from them so a ring can never be authored back into
       the corridor by hand again. */
    archRing(s,w,h,glow,opts){
      const o=opts||{};
      const cw=o.footWidth||3.0,cd=o.footDepth||3.6,trim=o.trim||this.p.cyan;
      /* WHERE A COLUMN MAY STAND, AND HOW WIDE THE ARCH HAS TO BE TO LET IT.
       *
       * The feet went wherever the ellipse crossed RING_FOOT, and for the
       * narrower maze gates that is INSIDE the carriageway: a 62-unit gate
       * founded its columns at lateral 30 with a 4.6-unit base pad, so the pad
       * reached 27.7 against a corridor the car can drive to 30. Twenty-four
       * of them, every seven hundred and twenty units, each a 25-unit column
       * standing in the outside lane.
       *
       * The constraint runs the other way round. First work out how far out a
       * foot must be for the widest thing standing on it - the base pad, which
       * is 2.1 times the column - to clear the corridor. Then, if the arch is
       * too narrow to reach that, WIDEN THE ARCH. An arch is a shape and a
       * column in the road is a bug, so the shape is what gives. */
      const need=DRIVE_HALF+cw*1.05+0.6;
      let a=w*.5;
      let foot=Math.min(RING_FOOT,a-1);
      if(foot<need){
        foot=Math.min(RING_FOOT,need);
        a=Math.max(a,foot+1);
      }
      w=a*2;
      const b=h*.5;
      const yc=(o.clear===undefined?RING_CLEAR:o.clear)+b+(o.lift||0);
      if(o.steel)this.addItem(this.itemsOpaque,s,0,yc,w+o.steel,h+o.steel,o.depth||2.4,this.p.ringSteel);
      this.addItem(this.itemsGlow,s,0,yc,w,h,o.glowDepth||1.5,glow);
      /* The strip up the column is a CUBE part, not the arch's own ring: an
         annulus scaled to the size of a column is another ring, and it hangs
         back down through the carriageway the arch was just lifted clear of. */
      const drop=yc-b*Math.sqrt(Math.max(0,1-(foot/a)*(foot/a)));
      for(const side of[-1,1]){
        this.addItem(this.itemsOpaque,s,side*foot,drop*.5,cw,drop,cd,this.p.pier);
        this.addItem(this.itemsGlow,s,side*foot,drop*.5,.24,drop*.92,cd*1.08,trim);
        this.addItem(this.itemsOpaque,s,side*foot,1.15,cw*2.1,2.3,cd*2.0,this.p.pier);
      }
      /* What a harness can assert against: one entry per arch that spans the
         road, with the columns it was founded on. */
      (this.arches||(this.arches=[])).push({s,w,h,yc,low:yc-b,foot,drop});
      return yc;
    }
    zoneAt(s){return ZONES.find(z=>s>=z.from&&s<z.to)||ZONES[ZONES.length-1];}
    finalize(){
      if(this.corridorViolations.length&&global.console)
        global.console.warn('Chapter 7: '+this.corridorViolations.length+
          ' object(s) inside the driving corridor:\n  '+this.corridorViolations.slice(0,8).join('\n  '));
      this.bakeCubeItems(this.itemsOpaque,this.opaque,'Opaque');
      this.bakeCubeItems(this.itemsGlow,this.glow,'Glow');
      this.bakeCubeItems(this.itemsHorizon,this.horizon,'Horizon');
      /* ...and the rings, on the same three lists. Whatever the first pass
         left behind is a ring instance, and there is nothing about a ring that
         makes it less mergeable than a box. The blend list is deliberately not
         merged: alpha is order-dependent, and grouping by chunk and material
         reorders it. */
      this.bakeCubeItems(this.itemsOpaque,this.opaque,'OpaqueRing',this.ring);
      this.bakeCubeItems(this.itemsGlow,this.glow,'GlowRing',this.ring);
      this.bakeCubeItems(this.itemsHorizon,this.horizon,'HorizonRing',this.ring);
      for(const list of[this.opaque,this.blend,this.glow,this.groundOpaque,this.groundGlow,this.horizon])list.sort((a,b)=>a.s0-b.s0);
      for(const list of[this.itemsOpaque,this.itemsBlend,this.itemsGlow,this.itemsHorizon])list.sort((a,b)=>a.s-b.s);
    }
    /* MERGE THE BOXES.
     *
     * Everything on this route that is an instanced box - every barrier post,
     * stud, grate, gantry member, building body and window shell - is
     * transformed into a per-chunk, per-material buffer here, so what the
     * frame submits is one draw per material per chunk instead of twenty
     * thousand.
     *
     * THE TRANSFORM ITSELF IS IN THE CORE. It is half a million vertex
     * transforms and two million appends of eight boxed floats, it is pure
     * arithmetic with no art direction in it, and it was the most expensive
     * thing left in this level's load. `NR.bakeInstances` hands the source
     * box and a block of matrices across once and gets the finished buffers
     * back (see js/wasm.js); the JavaScript that used to do it inline is kept
     * as the fallback for a build without the core, and only for that.
     */
    /* `src` is the mesh whose instances are being merged. It used to be the
       cube and only the cube, which left every ring on the route - the arches,
       the sensor gates, the portals - as one draw call each, for no reason
       other than that the function had the cube's name on it. */
    bakeCubeItems(items,meshList,label,src){
      const source=src||this.cube;
      /* EIGHTEEN HUNDRED, AND IT STAYS THERE.
       *
       * This was widened to 3,600 to halve the draw calls, and it did - 1,053
       * baked meshes became 563 and the frame went from 765 calls to 700. It
       * also made the city start disappearing partway through the route:
       * buildings gone, neon still standing, which is the signature of the
       * OPAQUE bake failing while the smaller glow buckets survived.
       *
       * A bucket twice as wide holds twice the instances, and every instance
       * is sixteen floats written straight into the core's own matrix buffer
       * and a vertex block written back out of it (see bakeBegin in
       * js/wasm.js, and the note there about views being valid only until the
       * next call that can grow a Vec). Somewhere past the old bucket size
       * that stops holding. Sixty-five draw calls are not worth a city that
       * evaporates, and the honest fix for the call count is fewer materials
       * rather than bigger buckets - which is a change to how the city is
       * coloured, not to how it is merged.
       */
      const groups=new Map(),keep=[],srcV=source._sourceV,srcI=source._sourceI,chunkSize=1800;
      if(!srcV||!srcI){items.length=items.length;return;}
      /* Group first, WITHOUT touching the matrices. Each group keeps the
         instances themselves; the numbers are only ever read once, straight
         into the core's own buffer, because copying them into an intermediate
         array is most of what this used to cost. */
      for(const e of items){
        if(!e.p||e.p._mesh!==source){keep.push(e);continue;}
        const ci=Math.floor((e.s-FROM)/chunkSize),key=ci+'|'+e.p.mat.name;
        let g=groups.get(key);
        if(!g){g={list:[],mat:e.p.mat,s0:FROM+ci*chunkSize,s1:FROM+(ci+1)*chunkSize};groups.set(key,g);}
        g.list.push(e.m);
      }
      items.length=0;items.push(...keep);
      /* What the merge was worth, published rather than assumed. Two numbers:
         how many instances went in and how many draw calls came out. A bake
         that silently matches nothing looks exactly like a bake that worked. */
      const B=this.bakeStats||(this.bakeStats={});
      for(const g of groups.values()){
        B[label]=B[label]||{in:0,out:0};
        B[label].in+=g.list.length;B[label].out++;
        const view=NR.bakeBegin?NR.bakeBegin(srcV,srcI,g.list.length):null;
        let mesh;
        if(view){
          // one typed-array copy per instance, into the core's memory
          for(let i=0;i<g.list.length;i++)view.set(g.list[i],i*16);
          const out=NR.bakeRun();
          mesh=makeMesh(this.gl,out.verts,out.idx,'Neon7Baked'+label);
        }else{
          mesh=makeMesh(this.gl,...bakeFallback(srcV,srcI,g.list),'Neon7Baked'+label);
        }
        this.addMesh(meshList,mesh,g.mat,g.s0,g.s1);
      }
    }
    /* The city grade: one dark plane the whole route runs over, with a neon
       grid on it so the height of the deck above it is readable at speed. It
       is what the towers stand on and what the piers land on. */
    buildGround(){
      const lanes=[-1180,-620,-360,-190,190,360,620,1180].map(l=>[l-1.6,l+1.6]);
      for(let s=FROM;s<TO;s+=2400){
        const e=Math.min(TO,s+2400);
        // wide enough that its lateral edge is past full fog in every direction
        this.addMesh(this.groundOpaque,flatRibbon(this.gl,this.track,s,e,-2600,2600,FLOOR,150,'Neon7Floor'),this.floorMat,s,e);
        // Longitudinal arteries: eight lines, ONE buffer. See flatRibbonLanes.
        this.addMesh(this.groundGlow,flatRibbonLanes(this.gl,this.track,s,e,lanes,FLOOR+.16,150,'Neon7FloorLine'),this.floorGrid,s,e);
      }
      // Cross streets, far enough apart to read as blocks rather than a mesh.
      for(let s=FROM+90;s<TO;s+=420)
        this.addWorld(this.itemsGlow,s,0,FLOOR+.16,1720,.06,2.0,this.p.floorGrid);
    }
    /* The deck and its piers. Without this the road is a sheet of paper and
       every roadside object beside it is floating next to the sheet. */
    buildSubstructure(){
      /* Fourteen hundred was tried here and reverted with the bake bucket
         above: the deck is a ribbon rather than an instanced box so it was
         almost certainly innocent, but the two went in together and the city
         came apart, so they come out together and go back one at a time. */
      for(let s=FROM;s<TO;){
        let e=Math.min(TO,s+700);
        if(s<GLASS_A&&e>GLASS_A)e=GLASS_A;
        if(s<GLASS_B&&e>GLASS_B)e=GLASS_B;
        const isGlass=s>=GLASS_A&&s<GLASS_B;
        // Structural glass has no opaque full-width substrate. Outside it the
        // normal slab remains the load-bearing elevated expressway.
        if(!isGlass){
          this.addMesh(this.opaque,ribbon(this.gl,this.track,s,e,-DECK_HALF,DECK_HALF,-.06,'Neon7DeckTop'),this.deck,s,e);
          this.addMesh(this.opaque,ribbon(this.gl,this.track,s,e,DECK_HALF,-DECK_HALF,-DECK_T,'Neon7DeckSoffit'),this.deck,s,e);
        }
        this.addMesh(this.opaque,fascia(this.gl,this.track,s,e,-DECK_HALF,-DECK_T,-.06,'Neon7DeckEdgeL'),this.deck,s,e);
        this.addMesh(this.opaque,fascia(this.gl,this.track,s,e,DECK_HALF,-.06,-DECK_T,'Neon7DeckEdgeR'),this.deck,s,e);
        // a lit line along the soffit edge, so the deck reads as a lit object
        // from below and from the side rather than as a black band
        this.addMesh(this.glow,fascia(this.gl,this.track,s,e,-DECK_HALF-.05,-DECK_T+.35,-DECK_T+.95,'Neon7DeckGlowL'),this.blue,s,e);
        this.addMesh(this.glow,fascia(this.gl,this.track,s,e,DECK_HALF+.05,-DECK_T+.95,-DECK_T+.35,'Neon7DeckGlowR'),this.blue,s,e);
        s=e>s?e:s+120;   // never stall: a zone end behind s must still advance
      }
      // Visible ribs, longitudinal spines, cross-braces and suspension cables
      // turn the glass span into an engineered structure rather than a decal.
      for(const lat of[-27,-9,9,27])
        this.addMesh(this.opaque,ribbon(this.gl,this.track,GLASS_A,GLASS_B,lat-.42,lat+.42,-1.65,'Neon7GlassSpine'),this.steel,GLASS_A,GLASS_B);
      for(let s=GLASS_A+45,n=0;s<GLASS_B;s+=135,n++){
        this.addItem(this.itemsOpaque,s,0,-1.7,70,.56,2.2,this.p.steel);
        this.addItem(this.itemsOpaque,s,0,-3.0,48,.42,1.0,this.p.steel,n&1?.18:-.18);
        for(const side of[-1,1]){
          this.addItem(this.itemsOpaque,s,side*34,7.0,.34,16,.34,this.p.steel,0,0,side*(n&1?.10:-.10));
          this.addItem(this.itemsGlow,s,side*34,7.0,.10,15.2,.38,n&1?this.p.cyan:this.p.blue);
        }
      }
      /* Hammerhead piers on the centreline. One column and one cap per bent is
         a third of the draw calls of a two-column bent and is the silhouette a
         real elevated expressway actually has. */
      for(let s=FROM+60,n=0;s<TO;s+=PIER_STEP,n++){
        const road=this.track.at(clamp(s,FROM,TO-3),{}).y||0;
        const capY=road-DECK_T-1.2, footY=FLOOR+1.4;
        const colTop=capY-1.2, colH=Math.max(4,colTop-footY);
        this.addWorld(this.itemsOpaque,s,0,capY,58,2.4,8.5,this.p.pier);
        this.addWorld(this.itemsOpaque,s,0,colTop-colH*.5,9.5,colH,11,this.p.pier);
        this.addWorld(this.itemsOpaque,s,0,footY,17,2.8,19,this.p.pier);
        // a strip up the column reads the pier's height against the floor grid
        if(n%2===0)this.addWorld(this.itemsGlow,s,0,colTop-colH*.5,.34,colH*.94,11.3,this.cityPhases[n&3]);
      }
    }
    buildRoad(){
      // Opaque districts are exact-boundary chunks with alternating asphalt,
      // carbon, metal grate and instrumented grid surfaces.
      for(let s=FROM;s<TO;){
        const z=this.zoneAt(s);let e=Math.min(TO,s+700,z.to);
        if(s<GLASS_A&&e>GLASS_A)e=GLASS_A;
        if(s<GLASS_B&&e>GLASS_B)e=GLASS_B;
        const isGlass=s>=GLASS_A&&s<GLASS_B;
        if(!isGlass)this.addMesh(this.opaque,ribbon(this.gl,this.track,s,e,-32,32,.02,'Neon7Road'),this.roadMats[ZONES.indexOf(z)],s,e);
        if(!isGlass){
          this.addMesh(this.opaque,wall(this.gl,this.track,s,e,-32,2.6,'Neon7WallL'),this.steel,s,e);
          this.addMesh(this.opaque,wall(this.gl,this.track,s,e,32,2.6,'Neon7WallR'),this.steel,s,e);
        }else{
          this.addMesh(this.blend,wall(this.gl,this.track,s,e,-32,5.2,'Neon7GlassL'),this.glassWall,s,e);
          this.addMesh(this.blend,wall(this.gl,this.track,s,e,32,5.2,'Neon7GlassR'),this.glassWall,s,e);
        }
        this.addMesh(this.glow,ribbon(this.gl,this.track,s,e,-31.5,-31.08,.11,'Neon7EdgeR'),isGlass?this.cyan:this.red,s,e);
        this.addMesh(this.glow,ribbon(this.gl,this.track,s,e,31.08,31.5,.11,'Neon7EdgeC'),this.cyan,s,e);
        this.addMesh(this.glow,ribbon(this.gl,this.track,s,e,-.16,.16,.10,'Neon7Center'),isGlass?this.blue:this.cityCyan,s,e);
        s=e>s?e:s+120;   // never stall: a zone end behind s must still advance
      }
      // Glass panels are five longitudinal strips. Authored unsafe panels are
      // omitted from the static mesh and supplied dynamically by the director,
      // so retraction reveals a genuine visual opening and the ribs below.
      const panelLanes=[[-32,-24],[-24,-8],[-8,8],[8,24],[24,32]];
      const sky=HAZARDS.filter(h=>h.type==='sky_panel');
      const cuts=[GLASS_A,...sky.flatMap(h=>[h.s-55,h.s+55]),GLASS_B].sort((a,b)=>a-b);
      for(let i=0;i<cuts.length-1;i++){
        const a=cuts[i],b=cuts[i+1],haz=sky.find(h=>Math.abs((a+b)*.5-h.s)<56);
        for(const lane of panelLanes){
          const mid=(lane[0]+lane[1])*.5;
          if(haz&&Math.abs(mid-haz.lane)<8.2)continue;
          this.addMesh(this.blend,ribbon(this.gl,this.track,a,b,lane[0]+.16,lane[1]-.16,.025,'Neon7GlassPanel'),this.glass,a,b);
        }
      }
      for(let s=FROM+120,n=0;s<TO-80;s+=128,n++){
        const p=this.cityPhases[n&3];
        this.addItem(this.itemsGlow,s,-10.8,.15,1.65,.045,.24,n%3?p:this.p.yellow);
        this.addItem(this.itemsGlow,s,10.8,.15,1.65,.045,.24,(n+2)%3?this.cityPhases[(n+2)&3]:this.p.yellow);
      }
      // Animated roadside pylons create the flashing cadence visible in the film.
      for(let s=ROUTE_FROM,n=0;s<TO-80;s+=260,n++)for(const side of[-1,1]){
        const p=this.cityPhases[(n+(side>0?2:0))&3],h=5.5+(n%4)*1.2;
        this.addItem(this.itemsGlow,s,side*34.3,h*.5,.18,h,.28,p);
      }
      for(const s of[132620,140890,146080,150470,153890,159410,165290,172660])this.rampChevrons(s);
    }
    /* WHAT THE ROAD WAS MISSING.
     *
     * The expressway was a coloured ribbon with two edge lines, a centre line
     * and a pair of lane lights on it, and at two hundred miles an hour that
     * is a corridor rather than a road: nothing on it has a size, so nothing
     * gives the speed a scale, and the two kilometres between one set piece
     * and the next read as unfinished because there is nothing in them.
     *
     * A real carriageway is covered in things, and almost all of them are
     * flat. That is what makes this affordable: everything below is either a
     * merged quad strip or a merged cube, so the whole pass is about six draw
     * calls per chunk and costs vertices - which this route has budget for now
     * that the frustum test and the merged floor grid have given some back.
     *
     * The lane structure comes off the road's own width. It is sixty-four
     * units between the barriers, which at this scale is four lanes: dividers
     * at +/-16, a centre at 0, shoulders outside +/-28.
     *
     * HEIGHTS ARE STACKED ON PURPOSE. The road surface is at 0.02 and
     * everything painted on it is above that in a fixed order - polish, rubber,
     * joints, hatching, paint - with two centimetres between layers, which at
     * this near plane is enough separation to hold to about a kilometre and
     * far enough inside the existing centre line at 0.10 not to disturb it.
     */
    buildRoadDetail(){
      const gl=this.gl,tr=this.track;
      const LANE=16, SHOULDER=28.4, LANES=[-24,-8,8,24];
      const CHUNK=1200;
      for(let s=FROM;s<TO;){
        const e=Math.min(TO,s+CHUNK);
        const glass=s>=GLASS_A&&s<GLASS_B;
        if(glass){ s=e>s?e:s+120; continue; }
        const bore=this.inTunnel(s+CHUNK*.5);

        /* THE RACING LINE, painted in by three hundred thousand cars.
           A polished band down each lane where the tyres actually run: the
           same asphalt at a much higher smoothness, so in the wet it is the
           part of the road that mirrors. It is the cheapest single thing that
           makes tarmac look driven on rather than extruded. */
        this.addMesh(this.opaque,
          roadBands(gl,tr,s,e,LANES.map(l=>[l-3.4,l+3.4,.040]),'Neon7Wear'),
          this.polish,s,e);
        // ...and the black rubber laid down the middle of each of them
        this.addMesh(this.opaque,
          roadBands(gl,tr,s,e,LANES.map(l=>[l-.9,l+.9,.050]),'Neon7Rubber'),
          this.rubber,s,e);
        /* Deck joints: a slab every twenty-four units, which is the pitch a
           segmental viaduct is actually cast at, and the thing that turns a
           continuous sheet into a structure made of pieces. */
        this.addMesh(this.opaque,
          crossBands(gl,tr,s,e,-31.2,31.2,24,.55,.056,'Neon7Joint'),
          this.joint,s,e);
        // the shoulders nobody may drive on
        this.addMesh(this.opaque,
          hatchStrips(gl,tr,s,e,[-30.0,30.0],1.5,11,3.2,.066,'Neon7Hatch'),
          this.paintWarm,s,e);
        // dividers (broken) and shoulder lines (continuous), one buffer
        if(!bore){
          this.addMesh(this.opaque,roadLines(gl,tr,s,e,[
            {lat:-LANE,half:.30,dash:5,gap:7,y:.074},
            {lat: LANE,half:.30,dash:5,gap:7,y:.074},
            {lat:-SHOULDER,half:.34,dash:0,gap:0,y:.074},
            {lat: SHOULDER,half:.34,dash:0,gap:0,y:.074},
          ],'Neon7Lane'),this.paint,s,e);
        }
        // the kerb the barrier stands behind, top and face in one buffer
        this.addMesh(this.opaque,roadBands(gl,tr,s,e,
          [[30.9,32.0,.42],[-32.0,-30.9,.42]],'Neon7Kerb'),this.kerb,s,e);
        s=e>s?e:s+120;
      }

      /* --- the small hard things, as merged cubes --------------------- */
      /* Reflective studs down both lane lines.
         Pitched at 48 rather than at the dash pitch on purpose: this is the
         one thing here that is placed per station rather than merged into a
         strip, and forty-one kilometres of route makes any pitch under about
         forty a five-figure box count in the bake. At 48 units they still read
         as a continuous run of light at speed, which is what they are for. */
      for(let s=FROM+24,n=0;s<TO-40;s+=48,n++){
        if(this.inTunnel(s)||(s>=GLASS_A&&s<GLASS_B))continue;
        for(const lat of[-LANE,LANE]){
          this.addItem(this.itemsGlow,s,lat,.14,.36,.06,.46,n&1?this.p.yellow:this.p.white);
        }
      }
      /* Drain grates and inspection covers in the shoulder, sunk flush, in
         metal - so they catch the headlights differently from the tarmac. */
      for(let s=FROM+70,n=0;s<TO-40;s+=96,n++){
        if(this.inTunnel(s)||(s>=GLASS_A&&s<GLASS_B))continue;
        const side=n&1?-1:1;
        this.addItem(this.itemsOpaque,s,side*30.2,.05,2.1,.09,1.5,this.p.grate);
        if(n%3===0)this.addItem(this.itemsOpaque,s+34,-side*29.2,.05,1.7,.08,1.7,this.p.hazardSteel);
      }
      /* THE BARRIER, which was a plain wall.
         Posts on a twenty-four unit pitch OUTSIDE the wall so their heads show
         over it, and a retroreflector on the wall's inner face at every one.
         This is what gives the edge of the road a rhythm to read speed
         against, and the route had nothing. */
      for(let s=FROM+12,n=0;s<TO-40;s+=36,n++){
        if(s>=GLASS_A&&s<GLASS_B)continue;
        for(const side of[-1,1]){
          this.addItem(this.itemsOpaque,s,side*32.6,1.55,.38,3.10,.38,this.p.hazardSteel);
          this.addItem(this.itemsGlow,s,side*31.86,1.95,.14,.36,.32,
            side>0?this.p.yellow:this.p.red);
        }
      }
      /* Distance markers every five hundred units, alternating sides: a lit
         plate on a post. On a route with nine districts and no mile posts it
         is the only thing that says how far into one you are without reading
         the interface. */
      for(let s=FROM+250,n=0;s<TO-60;s+=500,n++){
        if(this.inTunnel(s))continue;
        const side=n&1?-1:1;
        this.addItem(this.itemsOpaque,s,side*33.6,1.05,.16,2.10,.16,this.p.hazardSteel);
        this.addItem(this.itemsGlow,s,side*33.6,2.25,.10,.62,.90,this.p.cyan);
      }
      /* OVERHEAD SIGN GANTRIES.
         A truss across the road on two legs outside the barrier, carrying
         three lit panels. It is the structure a real motorway has every
         kilometre and the strongest cue there is for how fast the road is
         going past - and it is held above RING_CLEAR, the same headroom the
         arches are founded to, so nothing here can ever be authored into the
         carriageway (see checkCorridor). */
      for(let s=FROM+520,n=0;s<TO-400;s+=1150,n++){
        if(this.inTunnel(s)||this.inTunnel(s+40))continue;
        if(s>=GLASS_A&&s<GLASS_B)continue;
        const p=this.cityPhases[n&3];
        for(const side of[-1,1]){
          this.addItem(this.itemsOpaque,s,side*35.4,8.4,1.1,16.8,1.1,this.p.auroraPanel);
          this.addItem(this.itemsGlow,s,side*35.4,8.4,.14,15.8,1.20,p);
        }
        this.addItem(this.itemsOpaque,s,0,16.2,74,1.20,1.9,this.p.auroraPanel);
        this.addItem(this.itemsOpaque,s,0,15.1,72,.32,2.5,this.p.steel);
        for(let k=-1;k<=1;k++){
          this.addItem(this.itemsOpaque,s,k*20,13.9,15.5,2.6,.38,this.p.tower);
          this.addItem(this.itemsGlow,s,k*20,13.9,14.6,2.1,.44,
            k===0?this.p.auroraSign:(k<0?this.p.cyan:this.p.blue));
        }
        // and the camera mast that always stands beside one
        this.addItem(this.itemsOpaque,s+6,34.8,9.0,.22,6.0,.22,this.p.steel);
        this.addItem(this.itemsOpaque,s+6,34.1,12.2,1.5,.42,.42,this.p.hazardSteel);
        this.addItem(this.itemsGlow,s+6,33.4,12.2,.20,.20,.20,this.p.red);
      }
      /* Rumble strips and warning chevrons on the approach to every bore. The
         portals were a silhouette change with no lead-in, which is why a
         tunnel used to arrive rather than approach. */
      for(const t of[137090,146540,160840]){
        this.addMesh(this.opaque,
          crossBands(gl,tr,t-260,t-20,-31.2,31.2,12,1.6,.070,'Neon7Rumble'),
          this.paintWarm,t-260,t-20);
        for(let k=0;k<5;k++){
          const ss=t-210+k*38;
          for(const side of[-1,1]){
            this.addItem(this.itemsGlow,ss,side*26,.22,4.2,.06,1.1,this.p.orange,side*.55);
          }
        }
      }
    }

    rampChevrons(s){
      for(let k=0;k<4;k++){
        const p=this.cityPhases[(k+1)&3],ss=s+k*22;
        this.addItem(this.itemsGlow,ss,-6.2,.20,.72,.055,10.5,p,.62);
        this.addItem(this.itemsGlow,ss,6.2,.20,.72,.055,10.5,p,-.62);
      }
    }
    inTunnel(s){return(s>=137090&&s<=138500)||(s>=146540&&s<=147920)||(s>=160840&&s<=162290);}
    /* Every building is built from the city floor to its roof, in absolute
       world height. The first pass placed them relative to the road, which
       meant a tower beside a flyover rode 18 units into the air with it and
       every tower on the route had open sky underneath it. */
    /* Deterministic per-station hash. The skyline is the same skyline every
       time the chapter is loaded, which matters when a checkpoint restart puts
       the player back through the same kilometre. */
    hash(i,k){const x=Math.sin(i*127.1+k*311.7)*43758.5453;return x-Math.floor(x);}
    /* One building. `tier` picks the facade density and how much of the light
       budget it is allowed, which is the whole depth cue: near blocks blaze,
       the mid city is dimmer, and the far skyline is a haze of window grids. */
    building(s,lat,roof,w,d,tint,tier,crown){
      const list=tier>=2?this.itemsHorizon:this.itemsOpaque;
      const h=roof-FLOOR,cy=(FLOOR+roof)*.5;
      const t=tint%6;
      if(tier===0){
        this.addWorld(list,s,lat,cy,w,h,d,this.pBodyNear[t]);
        // the window shell, half a unit proud so it never z-fights the body
        this.addWorld(list,s,lat,cy,w+1.1,h+.5,d+1.1,this.pFacadeNear[t]);
      }else if(tier>=2){
        this.addWorld(list,s,lat,cy,w,h,d,this.pFacadeHorizon[t]);
      }else{
        this.addWorld(list,s,lat,cy,w,h,d,this.pFacadeFar[t]);
      }
      if(tier===0){
        // a podium, so the tower is founded on the ground instead of ending
        // in mid-air where the fog happens to swallow it
        this.addWorld(list,s,lat,FLOOR+9,w*1.24,18,d*1.20,this.pPodium);
        if(crown){
          this.addWorld(this.itemsGlow,s,lat,roof+1.2,w*1.02,.55,d*1.02,this.cityPhases[tint&3]);
          this.addWorld(list,s,lat,roof+7,w*.62,14,d*.58,this.pPodium);
          this.addWorld(this.itemsGlow,s,lat,roof+21,.55,16,.55,this.p.red);
        }
      }else if(crown){
        // ...in the GLOW list whatever tier it belongs to: this material is
        // additive, and the horizon list is submitted in the opaque pass
        this.addWorld(this.itemsGlow,s,lat,roof+1.4,w*1.02,.6,d*1.02,this.cityPhases[tint&3]);
        /* AND SOMETHING ON TOP OF IT.

           The street wall has had a setback and a mast since it was built and
           the two tiers behind it have had a lit band and a flat lid - so from
           the road the near buildings are architecture and the skyline behind
           them is a bar chart. At this distance nobody reads a facade; the
           silhouette IS the building, and a row of boxes all stopping dead at
           different heights is the one thing that says 'extruded'.

           A setback each, in the tier's own facade so it costs no new
           material and no new batch, and a beacon on the middle tier - big
           enough to survive the resolution it is seen at, which a half-unit
           mast at four hundred units is not. */
        const face=tier>=2?this.pFacadeHorizon[t]:this.pFacadeFar[t];
        this.addWorld(list,s,lat,roof+8,w*.58,16,d*.58,face);
        if(tier===1)this.addWorld(this.itemsGlow,s,lat,roof+19,1.6,7,1.6,this.p.red);
      }
    }
    /* THE CITY, in three tiers.

       The complaint the first pass earned was exact: the buildings stood in a
       thin line beside the road, and you could see the empty void straight
       through the gaps between them. A city is not a row of boxes, it is a
       DEPTH - a street wall you nearly touch, a middle distance behind it, and
       a skyline that closes the horizon. Each tier is offset from the one in
       front so no sightline runs clean through all three. */
    buildCity(){
      // -- continuous podium band ---------------------------------------
      /* The ground beside an elevated road is the first thing a void shows
         through. This is one merged mass either side of the deck, the whole
         length of the route, so there is always solid city under the barrier. */
      for(let s=FROM;s<TO;s+=900){
        const e=Math.min(TO,s+900);
        for(const side of[-1,1]){
          this.addMesh(this.opaque,ribbon(this.gl,this.track,s,e,side*46,side*104,FLOOR+14,'Neon7BlockTop'),this.podiumMat,s,e);
          this.addMesh(this.opaque,fascia(this.gl,this.track,s,e,side*46,FLOOR,FLOOR+14,'Neon7BlockFace'),this.podiumMat,s,e);
          this.addMesh(this.glow,fascia(this.gl,this.track,s,e,side*45.6,FLOOR+12.6,FLOOR+13.8,'Neon7BlockLip'),
            this.grid,s,e);
        }
      }

      // -- tier 0: the street wall ---------------------------------------
      for(let s=FROM+60,n=0;s<TO-160;s+=118,n++){
        if(this.inTunnel(s))continue;
        const z=ZONES.indexOf(this.zoneAt(s));
        for(const side of[-1,1]){
          const k=n*2+(side>0?1:0);
          const r1=this.hash(k,1),r2=this.hash(k,2),r3=this.hash(k,3),r4=this.hash(k,4);
          const spire=r4>.86;
          const lat=side*(84+r1*46);
          const w=16+r2*30,d=34+r3*54;
          const roof=spire?(215+r2*190):(52+r3*150);
          this.building(s+(side>0?34:-34),lat,roof,w,d,(z*2+(r1*6|0))%6,0,spire||r3>.62);
          /* An infill block half a station along, deliberately shallower and
             offset, so the eye never finds a straight gap between two towers
             on the same side. */
          if(r2>.30)this.building(s+(side>0?-26:26),side*(60+r3*24),FLOOR+34+r1*46,14+r3*18,24+r1*26,(z+k)%6,0,false);
        }
      }

      // -- tier 1: the middle distance ------------------------------------
      for(let s=FROM+140,n=0;s<TO-240;s+=214,n++){
        const z=ZONES.indexOf(this.zoneAt(s));
        for(const side of[-1,1]){
          const k=n*2+(side>0?1:0)+9001;
          const r1=this.hash(k,1),r2=this.hash(k,2),r3=this.hash(k,3);
          const lat=side*(158+r1*146);
          this.building(s+(side>0?70:-70),lat,110+r2*260,36+r2*52,52+r3*74,(z*3+(r2*6|0))%6,1,r3>.55);
        }
      }

      // -- tier 2: the horizon --------------------------------------------
      /* Two staggered rows. The back row sits in the gaps of the front row,
         which is what stops the sky showing between them and is the whole
         reason the route now reads as a city rather than as a corridor. */
      for(let s=FROM+90,n=0;s<TO-400;s+=352,n++){
        const z=ZONES.indexOf(this.zoneAt(s));
        for(const side of[-1,1])for(let row=0;row<2;row++){
          const k=n*4+row*2+(side>0?1:0)+42007;
          const r1=this.hash(k,1),r2=this.hash(k,2),r3=this.hash(k,3);
          const lat=side*(360+row*250+r1*180);
          this.building(s+row*176+(side>0?110:-110),lat,150+r2*330,74+r2*96,96+r3*120,(z+row*2+(r3*6|0))%6,2,r2>.62);
        }
      }

      this.buildSkybridges();
      this.buildBillboards();
    }
    /* Lit walkways strung between the two tower rows, crossing high over the
       expressway. They give the route a ceiling to read speed against, which a
       road with open sky on both sides never has. */
    buildSkybridges(){
      /* Measured UP FROM THE ROAD, not up from the city grade.
         These were authored as FLOOR+66 when the grade was -34, which put them
         thirty-two units over the deck. The grade later moved to -64 to give
         the towers somewhere to stand, and the same expression dropped every
         bridge to two units above the tarmac - a 168-unit wall straight across
         the carriageway, lit along both edges, with the road disappearing
         behind it. It was the single worst object on the route and it read as
         exactly what it was: a map that had not been finished. */
      for(let s=132940,n=0;s<TO-800;s+=2860,n++){
        if(this.inTunnel(s))continue;
        const y=62+(n%3)*24,a=this.cityPhases[n&3],b=this.cityPhases[(n+2)&3];
        this.addItem(this.itemsOpaque,s,0,y,168,3.0,11,this.p.tower);
        this.addItem(this.itemsGlow,s,0,y+1.7,164,.30,11.4,a);
        this.addItem(this.itemsGlow,s,0,y-1.7,164,.30,11.4,b);
        for(const side of[-1,1])this.addItem(this.itemsGlow,s,side*5.8,y,164,2.6,.26,side>0?a:b);
      }
    }
    buildBillboards(){
      for(let s=132450,n=0;s<TO-800;s+=1900,n++){
        if(this.inTunnel(s))continue;
        const side=n&1?-1:1,lat=side*(41+(n%3)*3),p=this.cityPhases[n&3],q=this.cityPhases[(n+1)&3];
        // A board on a mast that reaches the floor, not a panel in mid-air.
        this.addWorld(this.itemsOpaque,s,lat,FLOOR+21,3.0,42,3.0,this.p.tower);
        this.addWorld(this.itemsOpaque,s,lat,FLOOR+1.6,7,3.2,7,this.p.pier);
        this.addItem(this.itemsOpaque,s,lat,13,.9,22,31,this.p.tower);
        this.addItem(this.itemsGlow,s-14.8,lat-side*.55,13,.28,21,.32,p);
        this.addItem(this.itemsGlow,s+14.8,lat-side*.55,13,.28,21,.32,p);
        this.addItem(this.itemsGlow,s,lat-side*.55,23.3,.30,.28,30,q);
        this.addItem(this.itemsGlow,s,lat-side*.55,2.7,.30,.28,30,q);
        for(let k=0;k<4;k++)this.addItem(this.itemsGlow,s,lat-side*.72,7+k*4.1,.32,.35,22-k*2,(k&1)?p:q);
      }
    }
    violetBore(a,b){
      for(let s=a+52.5;s<=b;s+=105){
        this.addItem(this.itemsOpaque,s,-33.5,10.5,1.8,21,105,this.p.steel);
        this.addItem(this.itemsOpaque,s,33.5,10.5,1.8,21,105,this.p.steel);
        this.addItem(this.itemsOpaque,s,0,21.0,69,1.7,105,this.p.steel);
      }
      for(let s=a;s<=b;s+=105){
        this.addItem(this.itemsOpaque,s,-33,10,.8,20,1.5,this.p.steel);this.addItem(this.itemsOpaque,s,33,10,.8,20,1.5,this.p.steel);
        this.addItem(this.itemsOpaque,s,0,20,66,.8,1.5,this.p.steel);
        this.addItem(this.itemsGlow,s,0,19.55,21,.10,1.1,this.p.magenta);
        /* THE BORE'S OWN LIGHT BARS, ON THE BORE'S OWN WALLS.
           These stood at lateral +/-22 - eleven units INBOARD of the shell, in
           clear air over the carriageway, running from five units up to
           nineteen. A fourteen-unit neon rod hanging in the middle of a tunnel
           with nothing holding it there is not set dressing, it is an object
           the author has lost track of, and the corridor guard says so now
           that it watches addItem as well as addWorld. They belong on the rib
           line at +/-32.4, which is where the ribs they light actually are. */
        if(((s-a)/105|0)%3===0){this.addItem(this.itemsGlow,s,-32.4,12,.13,14,.55,this.p.blue);this.addItem(this.itemsGlow,s,32.4,12,.13,14,.55,this.p.magenta);}
      }
    }
    buildTunnels(){
      this.violetBore(137090,138500);this.violetBore(160840,162290);
      for(let s=146540,n=0;s<=147920;s+=72,n++){
        /* A bore lining, not an arch: its lower limb belongs UNDER the slab
           rather than level with it, or the ring scrapes a bright arc across
           the tarmac it is supposed to be buried in. */
        this.addItem(this.itemsGlow,s,0,20.2,76,46,1.5,this.p.ringOrange);
        /* On the lining, not in the lane. These ran from the road surface to
           nineteen units up at lateral +/-27 - five units INSIDE a carriageway
           that is thirty-two half-wide, so a car holding the outside line
           drove through a column of neon every two hundred and eighty units.
           The violet bores put the same strip on the rib at +/-33; this one
           was simply authored to a different number. */
        if(n%4===0){this.addItem(this.itemsGlow,s,-31.6,10,.16,19,.7,this.p.orange);this.addItem(this.itemsGlow,s,31.6,10,.16,19,.7,this.p.orange);}
      }
      // Portal lips make entering each tunnel a deliberate silhouette change.
      for(const s of[137070,138520,146520,147940,160830,162300])this.portal(s,s>145540&&s<148480?this.p.orange:this.p.magenta);
    }
    portal(s,p){
      this.addItem(this.itemsOpaque,s,-34,11,2,22,3,this.p.steel);this.addItem(this.itemsOpaque,s,34,11,2,22,3,this.p.steel);this.addItem(this.itemsOpaque,s,0,22,70,2,3,this.p.steel);
      this.addItem(this.itemsGlow,s,-31.8,11,.22,20,3.2,p);this.addItem(this.itemsGlow,s,31.8,11,.22,20,3.2,p);this.addItem(this.itemsGlow,s,0,20.8,64,.22,3.2,p);
    }
    buildGlassway(){
      for(let s=GLASS_A+70;s<=GLASS_B-50;s+=150){
        this.addItem(this.itemsGlow,s,0,.14,63,.045,.13,this.p.grid);
        this.addItem(this.itemsGlow,s,-31.5,2.7,.14,5.2,.24,this.p.grid);this.addItem(this.itemsGlow,s,31.5,2.7,.14,5.2,.24,this.p.grid);
        for(const lat of[-24,-8,8,24])this.addItem(this.itemsOpaque,s,lat,.10,.34,.10,.34,this.p.hazardSteel);
      }
      for(const lat of[-24,-8,8,24])this.addMesh(this.glow,ribbon(this.gl,this.track,GLASS_A,GLASS_B,lat-.10,lat+.10,.13,'Neon7GlassGrid'),this.grid,GLASS_A,GLASS_B);
      // A bright lip at the drop and a second lip as the deck climbs above the city.
      this.portal(GLASS_A-30,this.p.cyan);this.portal(143600,this.p.blue);this.portal(GLASS_B+30,this.p.cyan);
    }
    /* The Aurora portal: leg, lintel, lit fascia. The same silhouette straddles
       the production hall in Chapter 6, so crossing one here reads as walking
       into the same company's property rather than as new scenery. */
    auroraGantry(s,tag){
      for(const side of[-1,1]){
        this.addItem(this.itemsOpaque,s,side*35.4,9.2,2.6,18.4,3.4,this.p.auroraPanel);
        this.addItem(this.itemsGlow,s,side*33.9,9.2,.26,17.4,3.7,this.p.auroraSign);
        this.addItem(this.itemsGlow,s,side*35.4,.55,3.0,1.1,3.6,this.p.auroraHazard);
      }
      this.addItem(this.itemsOpaque,s,0,18.0,74,2.6,3.4,this.p.auroraPanel);
      this.addItem(this.itemsGlow,s,0,16.55,68,.28,3.7,this.p.auroraSign);
      // Sensor heads along the lintel: the deck is watching the car.
      for(let k=-3;k<=3;k++)this.addItem(this.itemsGlow,s,k*9.4,15.9,.9,.7,.9,tag||this.p.auroraSign);
    }
    /* Roadside instrumentation, thinned out so it punctuates the run instead
       of lining it: a mast, a service bay and a hazard-marked apron. */
    auroraInstrument(s,side){
      // mast on the deck shoulder, service bay on the city floor below it
      this.addItem(this.itemsOpaque,s,side*36,5.6,1.5,11.2,1.5,this.p.auroraPanel);
      this.addItem(this.itemsGlow,s,side*36,11.6,2.4,.5,2.4,this.p.auroraSign);
      this.addItem(this.itemsGlow,s,side*34.6,.16,4.2,.06,9.0,this.p.auroraHazard);
      this.addWorld(this.itemsOpaque,s+18,side*54,FLOOR+3.4,9.0,6.8,12.0,this.p.auroraPanel);
      this.addWorld(this.itemsGlow,s+18,side*(54-4.6),FLOOR+3.4,.26,5.8,11.4,this.p.auroraSign);
      this.addWorld(this.itemsGlow,s+18,side*54,FLOOR+7.0,9.2,.24,12.2,this.p.auroraHazard);
    }
    /* WHAT THE CITY DOES, AT GROUND LEVEL.
     *
     * This used to hang two decorative expressway strata beside the route at
     * lateral 104-152 and thirty to sixty units up, with a two-hundred-and-ten
     * unit cross-span over the top of each district. Every one of them was
     * inside the tier-0 street wall, whose blocks stand at lateral 84-130 and
     * reach four hundred units up - so the columns holding them were buried in
     * buildings and what the player actually saw was a long dark plate lying
     * in the sky with nothing under it. That is the reported floating block,
     * and there was one per district.
     *
     * Sixty-four units below the deck there is already a city grade with lit
     * arteries drawn down it. Traffic BELONGS on those: it is founded by
     * construction, it cannot intersect anything, it reads instantly as a city
     * going about its business under an elevated road, and it is the view an
     * expressway of this kind actually has. The strata are gone.
     */
    buildHighwayNetwork(){
      this.traffic=[];
      /* The arteries buildGround lays down, and a stream of light on each. The
         far ones run the other way, because a city with all its traffic going
         one direction is a conveyor. */
      const LANES=[[-1180,-1],[-620,1],[-360,-1],[-190,1],[190,-1],[360,1],[620,-1],[1180,1]];
      ZONES.forEach((z,n)=>{
        const a=z.from+220,b=z.to-220;
        for(let i=0;i<LANES.length;i++){
          const lane=LANES[i],lat=lane[0],dir=lane[1];
          // two streams per artery, and the outer ones are sparser and slower
          const far=Math.abs(lat)>500;
          for(let k=0;k<(far?2:3);k++){
            this.traffic.push({
              from:a,to:b,lat:lat+(k&1?-3.2:3.2),y:FLOOR+.9,
              phase:k*911+n*617+i*337,dir,
              speed:(far?16:26)+(k%3)*7,
              p:this.cityPhases[(n+i+k)&3],
            });
          }
        }
      });
    }
    /* Street traffic, on the city grade.
       `y` is ABSOLUTE - these run on the ground sixty-four units below the
       deck, and adding the road's own elevation to them would send them up the
       flyovers with it. The window is the ground's, not the deck's, because
       the grade is drawn far past where the deck stops. */
    drawTraffic(lo,hi){
      const t=(this.sc.time||this.g.time||0);
      for(const e of this.traffic){
        const span=e.to-e.from;
        let q=(t*e.speed+e.phase)%span;
        const ss=e.from+(e.dir>0?q:span-q);
        if(ss<lo||ss>hi)continue;
        const a=this.track.at(ss,{}),rx=Math.cos(a.yaw),rz=-Math.sin(a.yaw),m=M4.make();
        scaled(m,a.x+rx*e.lat,e.y,a.z+rz*e.lat,a.yaw,0,0,.9,.30,11.0);
        this.drawPart(e.p,m);
      }
    }
    buildLandmarks(){
      // District thresholds double as navigation silhouettes and checkpoint
      // language. Set-piece entries use amber Aurora instrumentation.
      for(const z of ZONES.slice(1))this.auroraGantry(z.from);
      for(const s of[141240,145830,150720,159840,166140,169790])this.auroraGantry(s,this.p.auroraHazard);
      for(let s=GLASS_A+360,n=0;s<GLASS_B-200;s+=1280,n++)this.auroraInstrument(s,n&1?-1:1);
      for(let s=133530,n=0;s<TO-900;s+=4700,n++)if(!this.inTunnel(s))this.auroraInstrument(s,n&1?1:-1);
      for(const s of[134740,140270,148630,156280,163930,171530])this.portal(s,(s/1000|0)%2?this.p.magenta:this.p.cyan);

      // Massive cross-city flyovers establish stacked transport depth and hide
      // the R-IX merge at DEAD AHEAD without introducing a second vehicle.
      const flyovers=[134880,147410,150910,154190,159140,164080,168970];
      for(let n=0;n<flyovers.length;n++){
        const s=flyovers[n],y=31+(n%3)*12,span=190+(n%2)*46;
        this.addItem(this.itemsOpaque,s,0,y,43,5.0,span,this.p.steel,Math.PI/2,0,0);
        if(n===1||n===4)this.addItem(this.itemsBlend,s,0,y+3,41,.55,span-4,this.p.glass,Math.PI/2,0,0);
        this.addItem(this.itemsGlow,s,-39,y+3.8,.26,.26,span-4,this.cityPhases[n&3],Math.PI/2,0,0);
        this.addItem(this.itemsGlow,s,39,y+3.8,.26,.26,span-4,this.cityPhases[(n+2)&3],Math.PI/2,0,0);
        /* FOUNDED ALONG ITS WHOLE LENGTH.
           The deck is rotated a quarter turn, so `span` runs ACROSS the road:
           a hundred-and-ninety-unit bridge carried on two columns at plus and
           minus forty-two has fifty-three units hanging off each end, which is
           the loose slab floating out of a building with nothing under it.
           A bent near each end as well, and it is a viaduct. */
        for(const lat of[-(span*.5-14),-42,42,span*.5-14]){
          const outer=Math.abs(lat)>50;
          const top=y-4+(this.track.at(s,{}).y||0),h=top-FLOOR;
          this.addWorld(this.itemsOpaque,s,lat,FLOOR+h*.5,outer?3.8:4.6,h,outer?6.2:7.5,this.p.pier);
          this.addWorld(this.itemsGlow,s,lat,FLOOR+h*.5,.32,h*.94,outer?6.5:7.8,lat<0?this.p.cyan:this.p.blue);
          this.addWorld(this.itemsOpaque,s,lat,FLOOR+1.6,outer?10:12,3.2,outer?12:15,this.p.pier);
          // a haunch where the column meets the soffit, so the joint is a joint
          this.addItem(this.itemsOpaque,s,lat,y-5.4,outer?7:9,3.0,outer?7:9,this.p.pier,Math.PI/2,0,0);
        }
      }

      // Data Cathedral: nested luminous lintels and a suspended core give one
      // unmistakable long-range landmark in the middle of the route.
      for(let k=0;k<7;k++){
        const s=149070+k*105,scale=1+k*.10;
        /* Seven nested lintels, each clearing the road and standing on its own
           pair of columns, fanning up and out as they recede. */
        this.archRing(s,74*scale,54*scale,k&1?this.p.ringMagenta:this.p.ringCyan,
          {lift:k*2.2,steel:4,depth:2.4,glowDepth:2.8,footWidth:3.4,footDepth:4.2,
           trim:k&1?this.p.magenta:this.p.cyan});
      }
      this.addWorld(this.itemsOpaque,149280,116,FLOOR+150,86,428,112,this.p.tower);
      this.addWorld(this.itemsGlow,149280,72,FLOOR+150,.8,408,116,this.p.cityGold);

      /* Maze sensor gates tighten in cadence toward the finish - and STOP two
         thousand units short of it, not five hundred. The arches and the rule
         that hangs on them are two loops over the same range and they have to
         agree, or there is a gate with no arch over it. See the note on the
         rule loop below for why the range moved. */
      for(let s=MAZE_FROM,n=0;s<MAZE_TO-200;s+=MAZE_STEP,n++){
        this.archRing(s,70-n%3*4,44-n%4*3,n&1?this.p.ringMagenta:this.p.ringCyan,
          {clear:11,glowDepth:1.2,footWidth:2.2,footDepth:2.6,
           trim:n&1?this.p.magenta:this.p.cyan});
      }
      /* THE SENSOR GATES ARE LIVE.
         Seven arches with nothing under them were seven decorations. Each one
         now hangs a curtain of light across the deck with one gap cut in it,
         the way Aurora Forge's arc walls do - a rule the player can read at a
         hundred and thirty miles an hour and answer with one decisive move.
         The gaps are authored, not random, so a retry is a retry of the same
         maze and getting better at it is possible. */
      /* EIGHT CURTAINS, AND NOT EIGHT OF THE SAME CURTAIN.
       *
       * They were: one gap, in an authored place, held still. Which means the
       * eighth one asks exactly what the first one did, and a last sector
       * built out of eight identical questions is a corridor with a
       * decoration in it.
       *
       * Four kinds now, cycled so no two in a row are alike, and every one of
       * them is the same VERB - be in the gap - asked differently:
       *
       *   HOLD    the gap is where it is. The one you learn on.
       *   SWEEP   the gap slides across the deck as you approach, so the
       *           answer is where it is GOING to be rather than where it is.
       *   CLOSE   the gap narrows the whole way in: commit early or not at
       *           all, which is the opposite instinct to the sweep.
       *   SPLIT   two gaps, either will do - and they are far enough apart
       *           that picking late costs more than picking wrong.
       */
      this.mazeGates=[];
      const GAPS=[-13,11,0,-16,14,-9,17,-4];
      const KINDS=['hold','sweep','close','split','hold','close','sweep','split'];
      /* ...AND THE MAZE STOPS BEFORE THE LINE TOO. It used to run to five
         hundred units short of the flag, so the last gate stood at 172,020 and
         the final eleven seconds of the campaign were still a sensor gate.
         Two thousand short leaves seven of them and two thousand four hundred
         units of clear deck to the flag. The arch loop further up shares this
         range: the arches and the rule that hangs on them are two loops over
         the same numbers and a gate with no arch over it is a rule nobody can
         see. */
      /* ...AND THE MAZE STOPS WITH THE SECTOR. It used to run to five hundred
         units short of the flag, so the last gate stood at 172,020 and the
         final eleven seconds of the campaign were still a sensor gate. It
         finishes at 168,510 now - three kilometres out, with the slabs - and
         what is after it is a race. The arch loop further up shares these
         numbers: the arches and the rule that hangs on them are two loops over
         the same range, and a gate with no arch over it is a rule nobody can
         see. */
      for(let s=MAZE_FROM,n=0;s<MAZE_TO-200;s+=MAZE_STEP,n++){
        const kind=KINDS[n%KINDS.length];
        this.mazeGates.push({
          s:s,gap:GAPS[n%GAPS.length],half:kind==='split'?5.4:7.4,
          kind,
          // where a sweeping gap starts, and where a closing one starts from
          sweep:kind==='sweep'?(n&1?1:-1)*17:0,
          gap2:kind==='split'?-GAPS[n%GAPS.length]*.9-(n&1?6:-6):0,
          live:false,pop:0,
        });
      }

      // Moonlit finish gantry, with three nested lines for a genuine campaign
      // climax rather than another ordinary timing bar.
      for(const side of[-1,1])this.addItem(this.itemsOpaque,FINISH,side*34,11,2.8,22,5,this.p.steel);
      this.addItem(this.itemsOpaque,FINISH,0,22,74,3.8,5,this.p.steel);
      this.addItem(this.itemsGlow,FINISH,0,20.0,69,.52,5.4,this.p.white);
      this.addItem(this.itemsGlow,FINISH-5,0,17.2,38,.26,5.6,this.p.cyan);
      this.addItem(this.itemsGlow,FINISH-10,0,14.7,22,.18,5.8,this.p.magenta);
    }
    dynamicMatrix(s,lat,y,sx,sy,sz,yawOff,pitch,roll){
      const a=this.track.at(clamp(s,FROM,TO-3),{}),rx=Math.cos(a.yaw),rz=-Math.sin(a.yaw),m=M4.make();
      scaled(m,a.x+rx*(lat||0),(a.y||0)+(y||0),a.z+rz*(lat||0),a.yaw+(yawOff||0),pitch||0,roll||0,sx,sy,sz);
      return m;
    }
    /* ------------------------------------------------------ the ramps --
     *
     * THE RAMP THE PLAYER SEES IS THE RAMP THE SOLVER USES.
     *
     * The physics does not collide with a mesh: it has an arc-length window
     * and a height profile, `h * u^2` over `[s - len, s]` - see the note above
     * `Ramp` in the core. So this draws exactly that curve, sliced, rather
     * than a wedge of its own devising. A ramp that looked steeper or
     * shallower than the one being driven would be the worst kind of bug in a
     * timing trial: everything the player reads would be a lie, and nothing
     * would look broken.
     *
     * Full width, for the same reason. The window is arc length and knows
     * nothing about lateral, so a narrow ramp would launch a car driving
     * beside it. Spanning the carriageway keeps the picture and the simulation
     * telling the same story, and it makes the jump a thing to be taken rather
     * than a thing to be dodged.
     */
    /* Every ramp inside the drawn span. The ramps are STRUCTURE - they stand
       on the road whether or not the chapter is running - so unlike the
       hazards they are not gated on a director state, and Free Roam gets them
       too. Only the approach paint is gated, because that is a cue for a trial
       and there is no trial in a tour. */
    drawJumps(lo,hi){
      const J=this.g.__jumps;
      for(const j of JUMPS){
        if(j.s<lo-JUMP_TELEGRAPH-200||j.s>hi+200)continue;
        this.stuntRamp(j,!!(J&&J.live&&J.live.id===j.id));
      }
    }
    stuntRamp(j,armed){
      /* Eighteen slices rather than ten. The other five ramps on the course
         are extruded as a smooth surface by js/scene.js, and this one is a
         stack of instanced boxes - so the only way the eight read as one piece
         of road furniture is for the steps here to be short enough not to be
         steps. Eighteen over a thirty-two unit incline is under two units. */
      const t=this.sc.time||0,SL=18,edge=DRIVE_HALF;
      /* The incline, as ten slices of the curve it actually is. Each slice is
         a box standing from the deck to the profile at its own midpoint, so
         the top of the run is a stepped approximation of h*u^2 - and at ten
         steps over forty units the steps are under a car's length. */
      for(let k=0;k<SL;k++){
        const u=(k+.5)/SL,y=j.h*u*u;
        const ss=j.s-j.len+j.len*(k+.5)/SL;
        this.drawPart(this.p.steel,
          this.dynamicMatrix(ss,0,y*.5,edge*2,y,j.len/SL*1.04));
        // the running surface, lit, so the climb reads as a surface and not a
        // stack of boxes
        this.drawPart(k&1?this.p.orange:this.p.yellow,
          this.dynamicMatrix(ss,0,y+.05,edge*2-1.2,.06,j.len/SL*.72));
      }
      // the lip, and the edge lights that say where it ends
      this.drawPart(this.p.white,this.dynamicMatrix(j.s,0,j.h+.10,edge*2,.10,1.4));
      for(const side of[-1,1])
        this.drawPart(this.p.cyan,this.dynamicMatrix(j.s,side*(edge-1.2),j.h+.5,1.0,1.0,1.6));
      /* THE APPROACH, and the centre line to take it on.
         A jump is aimed before it is taken: the car has to arrive straight, so
         the thing to paint is the line, not the ramp. Chevrons down the middle
         with a run of edge bars either side, brightening toward the lip. */
      if(armed){
        for(let k=0;k<9;k++){
          const f=k/9,ss=j.s-j.len-JUMP_TELEGRAPH*(1-f);
          const lit=(t*2.2+k*.34)%1<.5;
          this.drawPart(lit?this.p.cyan:this.p.blue,
            this.dynamicMatrix(ss,0,.14,3.0,.05,10.0));
          for(const side of[-1,1])
            this.drawPart(this.p.magenta,
              this.dynamicMatrix(ss,side*(edge-2.0),.14,2.2,.05,6.0));
        }
      }
      /* THE LANDING ZONE. Where the car is expected to come down, marked as a
         box on the road with a line down the middle of it - so the aim is
         visible from the top of the flight, which is the moment the player is
         actually steering for it. The reach is measured from the launch rather
         than guessed: at deck speed a lip this high throws the car about this
         far, and painting it anywhere else would teach the wrong thing. */
      const reach=j.s+58+j.h*11;
      for(let k=0;k<6;k++){
        const ss=reach-40+k*16;
        this.drawPart(this.p.cyan,this.dynamicMatrix(ss,0,.14,1.6,.05,9.0));
        for(const side of[-1,1])
          this.drawPart(this.p.grid,this.dynamicMatrix(ss,side*11,.13,.9,.05,9.0));
      }
    }

    drawHazards(pass,lo,hi){
      const d=this.g.__level7Director,states=d&&d.hazardStates,time=this.sc.time||0;
      /* THE SET PIECES BELONG TO THE CHAPTER.
         Dormant is a WAITING state, not a scenery state: the wrecking balls
         and their masts, the oil, the drop barriers and the shear panels are
         all sitting on the road waiting for an event that a Free Roam tour
         never arms. They come off - all except the retracting deck panels,
         because a dormant one of those IS the glass floor over the Skybreak
         span and taking it away would leave a hole in the road. */
      const free=!!this.g.freeRoam;
      for(const h of HAZARDS){
        if(free&&h.type!=='sky_panel')continue;
        if(h.s<lo-180||h.s>hi+180)continue;
        const st=states&&states[h.id]||{phase:'dormant',progress:0,visible:true,targetLane:h.lane};
        if(st.visible===false)continue;
        const p=clamp(st.progress||0,0,1),lane=st.targetLane===undefined?h.lane:st.targetLane;
        /* ONE TELEGRAPH, for every hazard on the route. A red carpet down the
           lane that is about to become dangerous and a cyan one down the lane
           to take, both long enough to be read at a hundred and thirty miles an
           hour. The first pass gave each mechanic its own bespoke cue, which is
           why nothing on this route was legible on the first attempt. */
        if(pass==='glow'&&st.phase!=='resolved'&&st.phase!=='dormant'){
          const reach=Math.max(120,(h.telegraph||420)*.62),live=st.phase==='active';
          /* THE DECK IS THE HAZARD; THE SLOT IS THE ROAD.
           *
           * This used to be two stripes of about the same size: a danger bar
           * as wide as the hazard's own radius, and a seven-unit cyan bar
           * beside it. On a sixty-unit deck that is two ribbons on a lot of
           * empty tarmac, and empty tarmac reads as drivable - so the cue was
           * describing a lane to avoid when what it needed to describe was a
           * lane to take. A player who read it as "not there" rather than
           * "here, and only here" was not misreading it.
           *
           * It is inverted now. Magenta covers the WHOLE carriageway, edge to
           * edge, with one narrow slot cut out of it; the slot is cyan. There
           * is nothing left over to be ambiguous about, and the thing the eye
           * has to find is a gap rather than an obstacle - which is the way
           * every real hazard marking on a road works.
           *
           * Still HATCHED rather than painted, for the reason the old note
           * gives: a solid emissive surface over the whole deck blooms into a
           * wall of light. Eight bars with gaps between them say the same
           * thing and leave the road visible under them.
           */
          const mark=(st.lane===undefined)?lane:st.lane,bars=8,seg=reach/bars;
          /* How wide the way through is. Half of the scored tolerance, so the
             painted slot always sits INSIDE what the trial will accept: a
             player on the paint is comfortably on the line, and the few units
             either side are the margin rather than a trap. Small on purpose -
             five and a half units of a sixty-unit deck. */
          const slot=SAFE_TOL,half=slot*.5;
          const edge=DRIVE_HALF;
          for(let k=0;k<bars;k++){
            const at=h.s-reach+seg*(k+.5);
            const danger=live?this.p.red:this.p.magenta;
            if(h.safeLane===undefined){
              // nowhere to go: the whole deck is the hazard and says so
              this.drawPart(danger,this.dynamicMatrix(at,mark,.13,edge*2,.05,seg*.52));
            }else{
              /* Two bars, one either side of the slot, each sized to exactly
                 the road it covers. A single bar with a hole in it is not
                 something a box can be, and two boxes are cheaper than the
                 alpha-cut sheet that would be. */
              const lo=h.safeLane-half,hi=h.safeLane+half;
              if(lo>-edge)this.drawPart(danger,
                this.dynamicMatrix(at,(-edge+lo)*.5,.13,lo+edge,.05,seg*.52));
              if(hi<edge)this.drawPart(danger,
                this.dynamicMatrix(at,(hi+edge)*.5,.13,edge-hi,.05,seg*.52));
              // ...and the slot itself, brighter and a hair higher so the two
              // never z-fight along the seam
              this.drawPart(this.p.cyan,
                this.dynamicMatrix(at,h.safeLane,.145,slot,.05,seg*.52));
            }
          }
          // chevrons pointing at the way out, so the cue reads as an instruction
          if(h.safeLane!==undefined)for(let k=0;k<3;k++){
            const t=(k+1)/4,ll=lane+(h.safeLane-lane)*t;
            this.drawPart(this.p.cyan,this.dynamicMatrix(h.s-reach*(1-t*.7),ll,.16,5.2,.06,1.5));
          }
        }
        if(h.type==='sky_panel'){
          if(pass==='blend'&&p<.99){
            /* The panel that retracts IS the lane that opens. It used to be
               drawn at -16, 0 or +16 depending on which side of the road the
               lane was, which for every panel but the middle one is five and a
               half units away from the hole the player actually falls into. */
            const m=this.dynamicMatrix(h.s,h.lane,.02-p*10,16.4,.18,110,0,0,p*(h.lane<0?-.18:.18));
            this.drawPart(this.p.glass,m);
          }
        }else if(h.type==='metal_ball'){
          if(pass==='opaque'){
            // the same lane the collision uses; see hazardLane()
            const swung=(st.lane===undefined)?lane:st.lane;
            this.drawPart(this.p.hazardBall,this.dynamicMatrix(st.currentS||h.s,swung,8-p*5,15,15,15,0,0,(st.age||0)*2.2));
            this.drawPart(this.p.hazardSteel,this.dynamicMatrix(h.s,swung,31,1.2,45,1.2));
            // ...and the arm it hangs from, so the swing is legible as a swing
            this.drawPart(this.p.hazardSteel,this.dynamicMatrix(h.s,(swung+lane)*.5,24,Math.abs(swung-lane)+1.4,1.0,1.4));
          }
          if(pass==='glow'){
            /* A beacon on it. Bare gunmetal against wet tarmac at night is the
               same colour as the road it is hanging over, so the object the
               whole set piece is about was the last thing in the frame the
               player could see. */
            const swung=(st.lane===undefined)?lane:st.lane,blink=.55+.45*Math.sin(time*7);
            this.drawPart(this.p.red,this.dynamicMatrix(st.currentS||h.s,swung,8-p*5,16.4,1.5*blink,1.4));
            this.drawPart(this.p.red,this.dynamicMatrix(h.s,swung,23.2,3.0,.5,3.0));
          }
        }else if(h.type==='oil'){
          if(pass==='blend'){
            this.drawPart(this.p.oil,this.dynamicMatrix(h.s,lane,.07,15,.06,32,Math.sin(time*.8)*.05));
            this.drawPart(this.p.oil,this.dynamicMatrix(h.s+12,lane+2,.075,12,.05,20,-.22));
          }
          if(pass==='glow')for(let k=-2;k<=2;k++){
            // Broken interference bands read as a thin-film spill rather than
            // a flat black gameplay rectangle.
            const wide=10-Math.abs(k)*1.35,slip=Math.sin(k*1.9)*2.4;
            this.drawPart(this.cityPhases[(k+8)&3],this.dynamicMatrix(h.s+k*6,lane+slip,.115,wide,.032,.66,k*.27));
          }
        }else if(h.type==='barrier'){
          if(pass==='opaque')this.drawPart(this.p.hazardSteel,this.dynamicMatrix(h.s,lane,8-p*6,20,2.4,2.6));
          if(pass==='glow'){
            this.drawPart(this.p.auroraHazard,this.dynamicMatrix(h.s,lane,8-p*6,19.2,.30,2.9));
            // and the gantry it drops from, lit, so it is visible before it moves
            this.drawPart(this.p.red,this.dynamicMatrix(h.s,lane,15.4,20.4,.34,1.2));
          }
        }else if(h.type==='slab'){
          /* A SHEAR PANEL, FALLING.
           *
           * Everything about this trap is in being able to see it early, so it
           * is drawn from the moment the hazard arms - hanging off the tower,
           * tipping - and the fall itself is the last second and a half of a
           * telegraph that started six hundred units back.
           *
           * `fall` is the collision's own number (see updateSlab), so what is
           * on screen and what the car is scored against cannot disagree - the
           * mistake the wrecking mass made in an earlier pass.
           */
          const f=clamp(st.fall||0,0,1),tip=clamp(st.tip||0,0,1);
          const landed=!!st.landed;
          const y=landed?SLAB_H*.5:SLAB_DROP*(1-f)+SLAB_H*.5;
          // it leaves the tower leaning, and lands flat
          const roll=(landed?0:(1-tip)*(h.lane<0?.55:-.55))+(landed?0:tip*.06);
          const side=h.lane<0?-1:1;
          if(pass==='opaque'){
            this.drawPart(this.p.slab,this.dynamicMatrix(h.s,h.lane,y,SLAB_LEN,SLAB_H,14,0,0,roll));
            /* The stub it came off. A slab that falls out of clear air is a
               slab nobody believes; this is the torn face of the tower it
               sheared from, and it stays there afterwards. */
            if(!landed)this.drawPart(this.p.tower,
              this.dynamicMatrix(h.s,side*46,SLAB_DROP+10,26,20,26,0,0,0));
          }
          if(pass==='glow'){
            const glow=landed?.35:1;
            // the torn rebar edge, along the long axis
            this.drawPart(this.p.slabEdge,
              this.dynamicMatrix(h.s,h.lane,y+SLAB_H*.5,SLAB_LEN*.98,.34*glow,14.4,0,0,roll));
            /* THE SHADOW, which is the whole telegraph.
               A thing that arrives from above cannot be read by looking ahead,
               so the patch of road it is going to occupy is painted before it
               gets there - and it pulses faster the closer the slab is. */
            if(!landed){
              const beat=.35+.65*Math.abs(Math.sin(time*(3+f*9)));
              for(let k=-2;k<=2;k++)this.drawPart(this.p.red,
                this.dynamicMatrix(h.s+k*3.0,h.lane,.15,SLAB_LEN*.96,.05*beat,1.5));
            }
          }
        }
      }
    }
    /* The curtain, drawn as bars rather than as a sheet: a solid wall of
       emissive across a sixty-four-unit deck is most of the frame, and eight
       bars say the same thing and leave the road visible underneath. */
    drawMazeGates(lo,hi){
      if(!this.mazeGates||this.g.freeRoam)return;
      const d=this.g.__level7Director;
      if(!d||!d.isChapter||!d.isChapter())return;
      const t=this.sc.time||0;
      const gap=NR.chapter7GateGap;
      for(const gt of this.mazeGates){
        if(gt.s<lo-40||gt.s>hi+40)continue;
        const pop=Math.max(0,Math.min(1,gt.pop||0));
        if(pop<=.01)continue;
        /* The gap is resolved by the SAME function the collision uses, at the
           same moment of the approach - so a sweeping curtain's opening is
           drawn where the car will actually be scored against it rather than
           where it was authored. */
        const G=gap(gt,gt.t===undefined?0:gt.t);
        const bar=(a,b)=>{
          if(b-a<1)return;
          for(let y=.5;y<11.5*pop;y+=1.5){
            const flick=.72+.28*Math.sin(t*24+y*3.1+gt.s);
            this.drawPart(this.p.red,this.dynamicMatrix(gt.s,(a+b)*.5,y,b-a,.10*flick,.5));
          }
        };
        const edges=[];
        if(G.gap2===null){
          bar(-30,G.gap-G.half);bar(G.gap+G.half,30);
          edges.push(G.gap-G.half,G.gap+G.half);
        }else{
          // two ways through: three panels of wall rather than two
          const a=Math.min(G.gap,G.gap2),b=Math.max(G.gap,G.gap2);
          bar(-30,a-G.half);bar(a+G.half,b-G.half2);bar(b+G.half2,30);
          edges.push(a-G.half,a+G.half,b-G.half2,b+G.half2);
        }
        /* Arc heads on the curtain's inner edges. A wall of bars is a wall;
           crackling terminals either side of a gap are a live wall, and the
           difference is whether the player expects it to hurt. */
        for(const e of edges){
          const arc=.5+.5*Math.sin(t*31+e*2.7);
          for(let y=1.2;y<10*pop;y+=2.6)
            this.drawPart(this.p.cyan,this.dynamicMatrix(gt.s,e,y,.55+arc*.5,.55+arc*.5,.6));
        }
        // ...and the way through it, marked on the road, wherever it now is
        const ways=G.gap2===null?[[G.gap,G.half]]:[[G.gap,G.half],[G.gap2,G.half2]];
        for(const wgt of ways){
          this.drawPart(this.p.cyan,this.dynamicMatrix(gt.s-1.2,wgt[0],.14,wgt[1]*2,.06,3.0));
          for(let k=1;k<=3;k++)this.drawPart(this.p.cyan,
            this.dynamicMatrix(gt.s-k*26,wgt[0],.13,wgt[1]*1.5,.05,7));
        }
      }
    }
    drawPart(p,m){this.gl.bindVertexArray(p._mesh.vao);this.sc.drawPart(p,m);}
    lowerBound(list,value,key){let a=0,b=list.length;while(a<b){const m=(a+b)>>1;if(key(list[m])<value)a=m+1;else b=m;}return a;}
    /* HOW FAR BEHIND THE WINDOW THE SCAN HAS TO START.
       drawMeshes finds its first candidate by binary search on s0, so it has
       to begin before the window by at least the length of the longest mesh in
       the list - otherwise a mesh that starts behind the window and runs right
       through it is never even looked at.
       It was the constant 2,100, which was true of everything here until it
       was not: the bake buckets are 3,600 and the longest run of city is
       4,470, so two fifths of the buildings stopped being drawn and only the
       neon was left standing. The list measures itself instead - see addMesh -
       and this is the one place that arithmetic lives, so --probe city can ask
       the renderer what its own margin is rather than keeping a second copy
       that would agree with a bug. */
    scanBack(list){return ((list&&list.reach)||0)+120;}
    /* Arc length says how far up the road something is; the frustum says
       whether the camera is pointing at it. Both, in that order, because the
       first is a binary search over a sorted list and the second is six plane
       equations - so the cheap test runs on everything and the expensive one
       only on what survived it. */
    drawMeshes(list,lo,hi){
      const sc=this.sc;
      const skipCity=this.probeOnly;
      const back=this.scanBack(list);
      for(let i=this.lowerBound(list,lo-back,e=>e.s0);i<list.length&&list[i].s0<=hi;i++){
        const p=list[i];
        if(p.s1<lo)continue;
        /* A 128-pixel cube face, read at a blurred mip, gets nothing from a
           tower two hundred units away that it does not already get from the
           clear colour - and the city is most of this route's geometry. What
           the reflection is FOR is the deck, its barrier line and the neon
           standing on it, which is what is left when the buildings go. */
        if(skipCity&&p.mat&&(p.mat._city||p.mat._horizon))continue;
        if(p.aabb&&!sc.boxVisible(p.aabb))continue;
        this.drawPart(p,p.m);
      }
    }
    /* THE ITEMS, DRAWN IN MATERIAL ORDER RATHER THAN IN ROAD ORDER.
     *
     * The list is sorted by arc length, which is what makes the range lookup
     * possible and is the wrong order to draw in. Consecutive items down a
     * carriageway are a reflector, then a light on the other side, then a
     * pylon - three different materials - so drawing them in the order they
     * are found means every single draw restates its whole material. Measured
     * on Chapter 7 before this: 561 of 792 draws re-uploaded, so the cache in
     * Scene.drawPart was only catching 29% of them.
     *
     * WHEN REORDERING IS ALLOWED, which is the whole question. Opaque geometry
     * is order-independent because the depth test decides what wins, and
     * ADDITIVE blending is order-independent because addition commutes. Alpha
     * blending is neither - `src*a + dst*(1-a)` depends on what was underneath
     * - so the pass that uses it passes `false` and keeps road order. Getting
     * that backwards would not crash; it would quietly re-stack the glass on
     * the Skybreak span, which is why it is a parameter rather than a guess.
     *
     * The scratch array is reused across frames and passes. It is refilled
     * every call, so it holds nothing between them, and not allocating it is
     * several hundred objects a frame the collector never has to look at.
     */
    drawItems(list,lo,hi,sortable){
      const sc=this.sc;
      const skipCity=this.probeOnly;
      const out=this._itemDraw||(this._itemDraw=[]);
      out.length=0;
      for(let i=this.lowerBound(list,lo,e=>e.s);i<list.length&&list[i].s<=hi;i++){
        const e=list[i];
        if(skipCity&&e.p&&e.p.mat&&(e.p.mat._city||e.p.mat._horizon))continue;
        if(e.aabb&&!sc.boxVisible(e.aabb))continue;
        out.push(e);
      }
      if(sortable!==false&&out.length>2)out.sort(byMaterial);
      for(let i=0;i<out.length;i++)this.drawPart(out[i].p,out[i].m);
    }
    draw(){
      const gl=this.gl,s=this.g.distance||this.g.car.sTrack||FROM,low=this.g.quality&&this.g.quality.scale<.8,lo=s-(low?700:950),hi=s+(low?2600:4200);
      // the grade first, on its own window, so it always reaches past the fog
      const glo=s-(low?2600:4200),ghi=s+(low?7000:12000);
      gl.enable(gl.DEPTH_TEST);gl.depthMask(true);gl.disable(gl.BLEND);
      this.drawMeshes(this.groundOpaque,glo,ghi);
      /* The back row of the skyline reaches further than anything else and is
         the first thing to go when the machine cannot afford it - it is two
         kilometres away, it is behind the row in front of it, and on LOW the
         fog has it at ninety per cent before it is even drawn. */
      this.drawMeshes(this.horizon,s-(low?1200:2200),s+(low?4200:9000));
      this.drawMeshes(this.opaque,lo,hi);this.drawItems(this.itemsOpaque,lo,hi);this.drawHazards('opaque',lo,hi);this.drawJumps(lo,hi);
      gl.enable(gl.BLEND);gl.depthMask(false);gl.blendFunc(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA);
      // Glass chunks are already authored in route order with little overlap;
      // depth testing stays on and depth writes stay off.
      // itemsBlend is the ONE pass that keeps road order: alpha blending is
      // not commutative, so reordering it re-stacks the glass. See drawItems.
      this.drawMeshes(this.blend,lo,hi);this.drawItems(this.itemsBlend,lo,hi,false);this.drawHazards('blend',lo,hi);
      gl.blendFunc(gl.SRC_ALPHA,gl.ONE);this.drawMeshes(this.groundGlow,glo,ghi);this.drawMeshes(this.glow,lo,hi);this.drawItems(this.itemsGlow,lo,hi);this.drawHazards('glow',lo,hi);this.drawTraffic(glo,ghi);this.drawMazeGates(lo,hi);
      gl.depthMask(true);gl.disable(gl.BLEND);gl.bindVertexArray(this.sc.vao);
    }

    /* THE DECK, INTO A REFLECTION FACE.
       Same reasoning as the Forge's drawProbe: what a 128-pixel cube face
       needs from this route is the deck under the car and the neon along it,
       not five kilometres of elevated city and every hazard on it. The
       traffic and the maze gates come out too - a car reflected in a car is
       a texel, and both of them are re-issued per frame. */
    drawProbe(){
      const gl=this.gl,s=this.g.distance||this.g.car.sTrack||FROM;
      const lo=s-160,hi=s+300;
      gl.enable(gl.DEPTH_TEST);gl.depthMask(true);gl.disable(gl.BLEND);
      this.probeOnly=true;
      this.drawMeshes(this.opaque,lo,hi);this.drawItems(this.itemsOpaque,lo,hi);
      gl.enable(gl.BLEND);gl.depthMask(false);gl.blendFunc(gl.SRC_ALPHA,gl.ONE);
      this.drawMeshes(this.glow,lo,hi);this.drawItems(this.itemsGlow,lo,hi);
      this.probeOnly=false;
      gl.depthMask(true);gl.disable(gl.BLEND);gl.bindVertexArray(this.sc.vao);
    }
  }

  /* WHICH GROUND THIS ROUTE ACTUALLY CLAIMS.
     The generated country is batched into 1,600-unit world tiles with no arc
     length on them, so Chapter 7 drops all of it - correct for a chapter that
     never leaves the deck, and wrong for a tour that drives onto it, because
     the country BEHIND the car would go at the same instant. Each tile is
     asked once which stretch of road is nearest to it; the ones the elevated
     route claims are dropped and the rest are left standing. */
  function tagGroundTiles(scene){
    if(!scene||scene.__l7GroundTagged||!scene.roadAt)return;
    scene.__l7GroundTagged=true;
    for(const list of [scene.dressingOpaque,scene.dressingGlow]){
      if(!list)continue;
      for(const p of list){
        if(!p||!p.worldCull||!p.aabb)continue;
        const a=p.aabb,r=scene.roadAt((a[0]+a[3])*.5,(a[2]+a[5])*.5);
        p.l7Ground=!!(r&&r.s>=FROM-400);
      }
    }
  }
  NR.level7TagGround=tagGroundTiles;

  const SP=NR.Scene&&NR.Scene.prototype;
  if(SP){
    const oldPart=SP.drawPart;
    SP.drawPart=function(p,m){
      // Generated flat barriers and ground would cut through Chapter 7's
      // raised deck. Older chapters remain byte-for-byte untouched.
      if(this.level7Override&&p&&p.dressing){
        if(p.worldCull){ if(!this.level7GroundKeep||p.l7Ground!==false)return; }
        else if(p.s1!==undefined&&p.s1>=FROM-40)return;
      }
      return oldPart.call(this,p,m);
    };
    const oldWorld=SP.drawWorld;
    SP.drawWorld=function(cam,dist){
      /* A Chapter 7 reflection face has nothing to gain from the generated
         country: drawPart rejects every dressing batch on this route anyway
         (the deck stands over it), so walking both lists six times a frame to
         frustum-test geometry that is guaranteed to be thrown away is pure
         cost. The main pass still calls through - the shipped scene meshes and
         the sun live in there. */
      if(!(this.level7Override&&this.probeCapturing&&!this.level7GroundKeep)){
        oldWorld.call(this,cam,dist);
      }
      if(!this.level7Override||!this.level7World)return;
      /* Same split as the Forge: the test deck is a large piece of standing
         geometry and a reflection face does not need all of it. */
      if(this.probeCapturing){
        if(this.level7World.drawProbe)this.level7World.drawProbe();
      }else this.level7World.draw();
    };
  }

  const GP=NR.Game.prototype,oldApply=GP.applyLevel;
  GP.applyLevel=function(){
    oldApply.call(this);const on=!!(this.level&&this.level.level7);this.scene.level7Override=on;
    /* A chapter drops the whole country, as it always has. Only a Free Roam
       tour keeps the tiles behind the gate, and it says so itself. */
    this.scene.level7GroundKeep=false;
    if(on){if(!this.__level7World)this.__level7World=new Level7World(this);this.scene.level7World=this.__level7World;}
  };

  /* ------------------------------------------------------ CHAPTER 07 ----
     PREDATOR. The rival Vehicle is skinned as the R-IX by the Level 5 Raptor
     kit and driven by the normal Driver, so the boss races real physics on the
     real racing line. What makes it a boss is the model: it opens at full
     confidence and loses confidence every time the player does something it
     cannot predict, and it drives harder the more certain it is.

     Confidence is not a health bar with a different name - it is read off the
     player's own driving. Repeating a line feeds it; varying the line, sliding
     the car and spending raceMode starve it. That is the story beat expressed
     as a rule, and raceMode - the Chapter 6 reward - is its counter. */
  const PRED = {
    /* The hunt curve itself, so a harness can assert what it does at a given
       gap and a given player speed rather than having to win a race to find
       out. Read-only by convention; the director is the only caller. */
    hunt: huntPace,
    stockTerminal: STOCK_TERMINAL,
    basePace: PRED_MATCH_IDLE,
    maxPace: PRED_MAX_PACE,
    lockFrom: 166610,
    lockTo: FINISH,
    /* TEN SECONDS, AND THIS CHAPTER ONLY.
     *
     * Thirty seconds of window against a ten-to-twenty-second cooldown is
     * raceMode running sixty to seventy-five per cent of the finale - which is
     * not a counter the player spends, it is the car they drive. The R-IX is
     * balanced against a player who has it some of the time, so having it
     * nearly all of the time is why the last chapter reads as the easy one.
     *
     * Ten seconds is a window you have to aim: enough to take a straight off
     * him or to hold a pass through the tower run, not enough to sit in. With
     * the ladder below it runs at about forty per cent of the sector early and
     * a quarter of it by the end, which is the shape the chapter's own
     * dialogue describes - "thirty seconds of raceMode are the only thing you
     * own that he is not" was written about a resource, and this makes it one.
     *
     * NOWHERE ELSE. Free Roam keeps RACE_MODE_SECONDS and Chapter 6's
     * calibration run keeps its own thirty; both are read separately in
     * Game.syncRaceMode. This constant is Chapter 7's alone. */
    modeSeconds: 10,
    /* WHAT THE NEXT ONE COSTS, and it is not a flat minute any more.
     *
     * Seventy seconds is most of a kilometre of this deck. Spend raceMode to
     * answer the R-IX once and the rest of the sector is driven without it,
     * which turns the one counter the chapter gives the player into something
     * they are afraid to use - and a tool nobody dares spend is not a tool.
     *
     * It climbs instead, and it climbs SLOWLY. Ten seconds for the first -
     * enough to be a cost rather than a formality, which is the point of
     * having one at the start at all - and two more each time after it, to a
     * ceiling of twenty. That is a rhythm a player can plan around: early in
     * the sector raceMode comes back almost as fast as it runs out, and by the
     * tower run each spend is most of a straight.
     *
     * Twenty is the ceiling on purpose. The old flat seventy was most of a
     * kilometre of this deck, which turned the one counter the chapter gives
     * the player into something they were afraid to use - and a tool nobody
     * dares spend is not a tool, it is a trap.
     *
     * Indexed by how many have been spent this run; see activate(), which also
     * says the next figure out loud so the ladder is something the player can
     * see rather than something they have to feel. */
    /* ...and the ladder moves up with it. Ten on and ten off is a window that
       is back before the player has finished spending the last one; these keep
       the rhythm the note above describes at a window a third of the length. */
    modeCooldowns: [14, 17, 20, 23, 26, 30],
    reserve: .5,
    cap: (198 * .44704) / .733, // the same +50% envelope the Forge calibrated
  };
  const setText=(el,value)=>{if(el)el.textContent=value;};
  const setHidden=(el,hidden)=>{if(el)el.setAttribute('aria-hidden',hidden?'true':'false');};
  const smooth=t=>{t=clamp(t,0,1);return t*t*(3-2*t);};
  const EVENT_FLOW={idle:['arming'],arming:['active','failed'],active:['resolved','failed'],failed:['arming'],resolved:['cleanup'],cleanup:[]};

  class PredatorDirector {
    constructor(game){this.g=game;this.bind();this.reset();game.__level7Director=this;}
    bind(){
      const id=n=>global.document.getElementById(n);
      this.ui={root:id('pred7'),objective:id('pred7Objective'),phase:id('pred7Phase'),
        objectiveText:id('pred7ObjectiveText'),rule:id('pred7Rule'),
        event:id('pred7Event'),
        eventKicker:id('pred7EventKicker'),eventText:id('pred7EventText'),
        checkpoint:id('pred7Checkpoint'),live:id('pred7Live')};
    }
    reset(){
      this.started=false;this.rivalry=.35;this.lastLateral=0;this.lastSpeed=0;this.lastSide=0;this.sampleS=0;this.lockOn=false;
      this.eventBannerTimer=0;this.cueKey='';
      /* The counter-attack, and the state that decides when it fires. */
      /* How badly he is losing, and whether he was in front last frame. Two
         value where there were five timers, and now none at all - the whole
         counter-attack is gone; see the note above RETAKE_CLEAR. */
      this.wasLeading=false;this.passSaid=0;
      /* The glass run is scored over a DISTANCE, not at one line. */
      this.glassHeld=0;this.glassRun=0;this.glassArmed=false;
      this.events={};for(const e of EVENTS)this.events[e.id]={state:'idle',age:0};
      this.hazardStates={};for(const h of HAZARDS)this.hazardStates[h.id]={phase:'dormant',age:0,progress:0,visible:true,targetLane:h.lane,lane:h.lane,triggered:false,held:0,off:0,released:false,landed:false,fall:0,tip:0};
      this.glassPrevS=undefined;this.glassLive=false;
      this.checkpointIndex=0;this.checkpointSnapshot=null;this.failure=null;this.intercept=null;
      this.oilTimer=0;this.shockTimer=0;
      this.taunt={timer:0,boostFor:0,gapAtBoost:0,used:0,lastGap:0,modeSeen:false};
      /* The stunt course. A ramp is a window installed on the SHARED car, so a
         restart has to take it off: one left armed would launch the car off a
         piece of road that the restart has put a long way behind it. The
         counters live on the game, not here, because driveJumps keeps them and
         it runs whether or not this director does. */
      this.announcedJump=null;
      if(this.g.clearRamps)this.g.clearRamps();
      else this.g.__jumps={armed:null,live:null,taken:0,clean:0,landing:0,landedId:null};
      // hand the shared difficulty table back to the driver
      if(this.g.driver&&this.cfg&&this.g.driver.cfg===this.cfg)this.g.driver.setLevel(this.g.driver.levelName||'HARD');
      this.cfg=null;this.baseCfg=null;
      this.modeActive=false;this.modeTimer=0;this.modeCooldown=0;this.modeUses=0;
      this.modeWindow=PRED.modeSeconds;
      this.modeRest=PRED.modeCooldowns[0];this.reserveLoaded=false;
      this.huntPace=1;this.huntGap=0;
      {const w=this.g.__level7World;if(w&&w.mazeGates)for(const gt of w.mazeGates){gt.cleared=false;gt.pop=0;}}
      this.trapRun=true;this.leadSaid=0;this.leadUsed=0;
      if(this.g.driver)this.g.driver.paceScale=1;
      if(this.g.driver)this.g.driver.gripScale=1;
      // ...including the speed cap: a chapter that left it on would follow the
      // R-IX out of the finale and into a Free Roam tour.
      if(this.g.rival){this.g.rival.powerScale=1;this.g.rival.gripScale=1;this.g.rival.raceModeMultiplier=1;this.g.rival.speedCap=Infinity;}
      this.hide();
      this.shockTimer=0;this.g.controlsSwapped=false;
      this.g.raceModeActive=false;this.g.raceModeBlueFuel=false;this.g.raceModeAvailable=false;this.g.blockQuickRestart=false;
      if(this.g.car){this.g.car.raceModeMultiplier=1;this.g.car.surfaceGrip=1;this.g.car.surfaceDrag=0;}
      if(this.g.rival)this.g.rival.raceModeMultiplier=1;
      this.g.storyRaptorRenderPose=null;this.g.predatorRivalry=null;
      if(global.document.body)global.document.body.classList.remove('pred7-lock','forge6-racemode','pred7-failure','forge6-invert');
      this.clearFatality();
    }
    hide(){
      if(!this.ui||!this.ui.root)return;
      this.ui.root.classList.remove('show','lock');
      this.ui.root.setAttribute('aria-hidden','true');
      setHidden(this.ui.event,true);
    }
    isChapter(){return !!(this.g.level&&this.g.level.level7&&this.g.story&&this.g.story.chapter&&this.g.story.chapter.finale);}
    toast(text,color){if(this.g.hud&&this.g.hud.toast)this.g.hud.toast(text,color);}
    say(speaker,expression,text,seconds){if(this.g.story&&this.g.story.showCompact)this.g.story.showCompact(speaker,expression,text,seconds);}
    audio(name,...args){
      const a=this.g.audio;if(!a)return;
      if(typeof a[name]==='function')a[name](...args);
      else if(name==='hazardCue'&&a.crash)a.crash(.22);
      else if(name==='predatorScan'&&a.checkpoint)a.checkpoint();
    }
    eventBanner(kicker,text,seconds){
      setText(this.ui.eventKicker,kicker);setText(this.ui.eventText,text);setText(this.ui.live,kicker+' — '+text);
      this.eventBannerTimer=seconds||3.2;
      if(this.ui.event){this.ui.event.classList.add('show');setHidden(this.ui.event,false);}
    }
    burstAt(h,r,g,b,count){
      if(!this.g.fx||!this.g.fx.spawn)return;
      const p=lanePoint(this.g.track,h.s,h.lane||0,.5),n=count||12;
      for(let i=0;i<n;i++){
        const a=i*2.399,sp=5+(i%5)*2.2;
        this.g.fx.spawn({x:p[0],y:p[1]+.4,z:p[2],vx:Math.cos(a)*sp,vy:4+(i%4)*2,vz:Math.sin(a)*sp,life:.38+(i%3)*.14,size:.18+(i%4)*.05,grow:-.08,gravity:-12,drag:1.2,stretch:3,r,g,b,a:1.25});
      }
    }
    start(){
      this.started=true;this.rivalry=.35;this.sampleS=this.g.car.sTrack;this.lastLateral=this.g.car.lateral||0;this.lastSpeed=this.g.car.vLong||0;this.lastSide=Math.sign(this.lastLateral);
      /* The R-IX drives to its own confidence rather than to a fixed
         difficulty. `skill` is the AI's real lever - it scales the target
         speed it will carry, how far ahead it plans, how hard it defends and
         how late it reacts - so the profile is cloned (never the shared
         LEVELS entry, which every other race reads) and moved with the model. */
      const base=(NR.AI_LEVELS&&NR.AI_LEVELS.IMPOSSIBLE)||null;
      if(base&&this.g.driver){
        this.baseCfg=base;this.cfg=Object.assign({},base);this.baseSkill=base.skill;
        this.g.driver.cfg=this.cfg;this.g.driver.personality='predator';this.g.driver.reset();
      }
      if(this.ui.root){this.ui.root.classList.add('show');this.ui.root.setAttribute('aria-hidden','false');}
      setText(this.ui.phase,'CHAPTER 07 // NEON HORIZON');setText(this.ui.objectiveText,'BEAT THE R-IX');
      this.g.raceModeAvailable=true;this.g.blockQuickRestart=true;
      this.captureCheckpoint(0,false);
      this.updateRule();
      if(this.g.story&&this.g.story.showCompact)this.g.story.showCompact('JAVAS','calculating','Thirty kilometres of Aurora\u2019s own deck. Everything on it is a test, and so is he.',4.2);
    }
    /* --------------------------------------------------- the stunt course --
     *
     * The ramps themselves are not the finale's - see `driveJumps` at the foot
     * of this file for why they belong to the ROAD rather than to the trial.
     * What is here is the part that is genuinely the chapter's: what a landing
     * is worth, and who says so.
     */
    announceJump(j){
      this.eventBanner('STUNT SECTION',j.name+' // LAND IT STRAIGHT',3.0);
      this.audio('predatorScan',1);
    }
    /* WHAT A LANDING WAS WORTH.
     *
     * `landing` is the solver's own measurement - the heading error at the
     * moment of touchdown, squared, times a roll term - so there is nothing to
     * judge here and no second opinion about it. This turns it into something
     * the player can see, and into the one thing that makes the trial worth
     * playing well rather than merely surviving: a clean landing gives boost
     * back.
     *
     * NOTHING HERE FAILS THE RUN. The penalty for a bad landing has already
     * been paid, in the speed the solver scrubbed off, and a set piece that
     * can end a thirty-kilometre race because a car came down four degrees out
     * is a set piece nobody would take twice.
     */
    scoreLanding(q){
      const J=this.g.__jumps||{taken:0,clean:0};
      if(q>=JUMP_CLEAN){
        this.toast(q>.9?'PERFECT LANDING // +RESERVE':'CLEAN LANDING // +RESERVE','#91ff31');
        // a clean one makes him work, the same way a clean maze gate does
        this.rivalry=clamp(this.rivalry+.03,0,1);
        if(J.clean===JUMPS.length)
          this.say('RAPTOR','angry','...Three for three. Fine. You can drive.',3.2);
      }else{
        this.toast('LANDED CROOKED // SPEED LOST','#ff6a3a');
        if(this.g.fx&&this.g.fx.sparks)this.g.fx.sparks(this.g.car,.7);
        if(this.g.audio&&this.g.audio.crash)this.g.audio.crash(.28);
      }
      this.updateRule();
    }
    /* THE OBJECTIVE LINE, and nothing else.
       It used to carry a percentage as well - see the note above
       confidenceDelta for why that is gone. What is left says where the player
       is in the race and what the road is doing, both of which they can act
       on. */
    updateRule(){
      const gap=this.huntGap||0;
      const state=this.modeActive?'SYNC WINDOW'
        :gap>18?'YOU LEAD'
        :gap<-18?'HE LEADS'
        :'WHEEL TO WHEEL';
      setText(this.ui.objectiveText,this.trapRun?'SURVIVE THE GAUNTLET':'BEAT THE R-IX');
      setText(this.ui.rule,'R-IX // '+state);
      if(this.ui.objective)this.ui.objective.style.setProperty('--edge',
        gap>18?'#91ff31':gap<-18?'#ff3b1e':'#ffb400');
    }
    /* Ryker on the channel.
       He is inside a car that never has to charge a reserve, and he knows what
       the player's boost is worth against it. So the taunt is not on a timer -
       it fires when the player has actually spent boost and the gap has not
       moved, which is the exact moment the lesson lands. Spending raceMode
       shuts him up, because that is the answer. */
    TAUNTS(){return[
      ['smug','Boost. Cute. I do that all the time.'],
      ['amused','You felt that, right? Nothing. That was nothing.'],
      ['smug','Mine does not run out. That is the difference.'],
      ['angry','Push the button again. I will wait.'],
      ['smug','You are burning a reserve I do not have.'],
      ['amused','Still there? Barely.'],
    ];}
    updateTaunt(dt){
      const T=this.taunt,car=this.g.car,r=this.g.rival;
      T.timer=Math.max(0,T.timer-dt);
      if(!r)return;
      const gap=r.sTrack-car.sTrack;
      if(this.modeActive){
        // raceMode is the counter, and he has to acknowledge it exactly once
        if(!T.modeSeen&&gap<T.lastGap-6){
          T.modeSeen=true;T.timer=9;
          this.say('RAPTOR','concerned','...That is the Aurora link. Where did you get that.',3.6);
        }
        T.boostFor=0;T.lastGap=gap;return;
      }
      if(car.boosting&&gap>18){
        if(T.boostFor<=0)T.gapAtBoost=gap;
        T.boostFor+=dt;
        /* Two full seconds of boost that bought less than eight units of road.
           Only then, and never more than twice a minute. */
        if(T.boostFor>2.0&&gap>T.gapAtBoost-8&&T.timer<=0){
          const line=this.TAUNTS()[T.used%6];T.used++;
          this.say('RAPTOR',line[0],line[1],3.6);
          this.toast('BOOST INEFFECTIVE // R-IX SYNCHRONISED','#ff3b1e');
          T.timer=26;T.boostFor=0;
        }
      }else T.boostFor=Math.max(0,T.boostFor-dt*2);
      T.lastGap=gap;
    }
    /* HOW HARD HE IS TRYING, AND WHEN HE ANSWERS.
     *
     * The old version of this sampled the player's line every ninety units and
     * moved a "prediction confidence" the interface then reported. It is
     * replaced by the race itself: he pushes harder the longer he is being
     * led, hardest immediately after being passed, and eases off when he is
     * comfortably in front.
     *
     * THE COUNTER-ATTACK is the part that was missing. Being overtaken used to
     * change nothing except the sign of the gap, so the hunt curve closed it
     * over a kilometre and an overtake felt like the end of the fight. He now
     * gives the player a few seconds of it - an overtake has to be worth
     * something - and then comes back with a burst of his own reserve, held
     * until he is in front again or it runs out.
     */
    updateRivalry(dt){
      const car=this.g.car,r=this.g.rival;
      if(!r)return;
      const lead=car.sTrack-r.sTrack;          // + = the player is in front
      const leading=lead>4;

      // the moment of the pass, which is a step rather than a slope
      if(leading&&!this.wasLeading){
        this.rivalry=clamp(this.rivalry+RIVALRY_PASS,0,1);
        // He still says something about it. What he no longer does is answer
        // it with a burst; see the note at the foot of this method.
        if(this.passSaid<=0){
          this.passSaid=1;
          this.say('RAPTOR','angry','Past me. That is temporary.',3.0);
        }
      }
      if(!leading&&this.wasLeading&&lead<-RETAKE_CLEAR){
        // ...and he says so exactly once per exchange, when he takes it back
        this.passSaid=0;
        this.say('RAPTOR','smug','And back where it belongs.',2.6);
      }
      this.wasLeading=leading;

      if(leading){
        this.rivalry=clamp(this.rivalry+RIVALRY_LED*dt*(1+clamp(lead/240,0,1.6)),0,1);
      }else if(lead<-70){
        // a lead he is comfortable with lets it back down
        this.rivalry=clamp(this.rivalry-RIVALRY_EASE*dt,0,1);
      }

      /* THE COUNTER-ATTACK IS GONE. Removed on request, and the request is
         worth recording accurately because the reason given for it was not
         the reason the chapter was misbehaving.

         `pressure` was an integrator of how badly he was losing, and every
         term it fed was LONGITUDINAL: extra terminal speed (PRESSURE_MATCH),
         extra ceiling (PRESSURE_TOP), a nudge to skill and grip, and the
         reheat lamp. None of them could move the car sideways, and the fault
         it was blamed for - the R-IX dashing left and right across the deck -
         was in the general overtaking controller in ai::Driver, where the
         committed pass side was released and re-armed every time the lead
         changed hands. That is fixed at source; see the long note there.

         What is left answering an overtake is the hunt curve, which is a
         function of the GAP alone. That is a slower, smoother answer - he
         comes back over a few hundred units rather than immediately - and it
         is one fewer system with an opinion about how fast he should be going.
         Measured on the balance probe, his provoked ceiling drops from 129 to
         118 units/s; the player's raceMode window is 133, so the counterplay
         the chapter is built around is untouched. */
      this.updateRule();
    }

    /* The rival drives harder the more certain it is. This is the one thing
       the boss gets that the player does not - and the player takes it away by
       refusing to be predictable, which is the whole point of the chapter. */
    /* THERE IS NO SHOULDER, AND THE R-IX DOES NOT ATTACK THE PLAYER.

       Two methods stood here. updateAggression decided the player was in the
       R-IX road rather than on it and handed the driver an absolute lateral
       to steer AT; settleShove then made the resulting contact asymmetric, so
       the car that was leaned on lost grip and yaw and the one that leaned
       shrugged it off.

       Both are gone, and so is the driver-side controller behind them - see
       the long note on ai::Driver in the core. The short version is that the
       shove was expressed as a correction from the car's own position while
       every other steering term is an offset from the racing line, so the
       error nulled itself and re-armed every time the car reached the player.
       That is a limit cycle, and it is what the finale's R-IX was doing when
       it dashed left and right across the deck instead of driving down it.

       Nothing replaces it. The prototype is already the fastest thing on the
       road: it has the momentum drive, the hunt curve, an unlimited reserve
       and a driver with no assist and no mistakes. Racecraft it has to win by
       is racecraft; ramming was never the reason it was frightening. */

    applyModel(){
      const r=this.g.rival;if(!r)return;
      /* THE R-IX LIVES IN THE raceMode ENVELOPE.
         Every other car on the Grid, the player's included, has to charge a
         reserve and spend it. The prototype does not: synchronised drive is
         its idle state, which is the whole reason Chapter 6 exists and the
         reason plain boost barely dents it here.

         It is still beatable, and the thing that beats it is the model. At
         full confidence it runs the complete +50% envelope; starved, it falls
         back to +20% - so the player's own 30 seconds of raceMode are worth
         more than its permanent one the moment they stop being predictable. */
      const car=this.g.car;
      const gapM=(car.sTrack-r.sTrack)*.733;          // + means the player leads
      /* THE HUNT.
         The R-IX is not a rival with a difficulty setting, it is a predator
         with a distance it will not accept. Everything below is one number -
         how much faster than the racing line it is willing to travel - and the
         whole boss fight is what moves it:

           base      it is always quicker than the player's ordinary pace, so
                     sitting still is never an option
           hunt      the further ahead the player gets, the harder it comes
                     back; a gap it has decided to close, closes
           match     the player's ORDINARY boost is answered exactly, which is
                     why a full burn buys about ten metres and no more
           give      the player's raceMode is the one thing it cannot answer.
                     That window is the whole counterplay, and it is deliberately
                     worth a hundred metres rather than five hundred
           model     and all of it scales with confidence, so a player who stops
                     being predictable is a player it cannot chase properly */
      const H=huntPace(gapM,{confidence:clamp(.55+this.rivalry*.45,0,1),
        playerBoosting:!!car.boosting,playerMode:this.modeActive,
        /* What the player is actually doing, and what the R-IX is. The first
           is what stops an upgrade being an escape; the second is what makes
           the pickup a corner-exit shove rather than a permanent power gain. */
        playerV:car.vLong||0, ownV:r.vLong||0,

        // while he is dropping traps in front of himself, he means to be in
        // front of them
        trapRun:this.trapRun});
      this.huntPace=H.pace;this.huntGap=gapM;this.huntPursuit=H.pursuit;
      /* Ceiling, thrust AND grip. A ceiling on its own is decoration - a car
         already at its drag-limited terminal speed goes no faster for being
         allowed to - and thrust on its own just means it arrives at the corner
         faster and leaves the road. */
      // a ceiling, kept just above what the drive will actually reach
      r.raceModeMultiplier=clamp(H.pace*1.06,1,1.62);
      /* AND THE CEILING THAT IS ACTUALLY A CEILING.
         `speedCap` is read by the solver's own `ceiling()` and by the driver's
         planner, so this one number bounds the physics, the plan and the
         momentum drive together. Without it the prototype's unlimited reserve
         decided its top speed - boost thrust alone outruns this car's drag at
         about a hundred and thirty units a second - and every constant in the
         hunt curve was tuning something that was not binding. */
      r.speedCap=H.top;
      r.powerScale=H.power;
      r.gripScale=H.grip;
      if(this.g.driver){this.g.driver.paceScale=H.pace;this.g.driver.gripScale=H.grip;}
      /* THE MOMENTUM DRIVE.
         Thrust alone cannot get a car past its drag, and the engine's torque
         falls away exactly where the extra speed is wanted - so the prototype
         is HELD at its speed rather than accelerated to it, which is the same
         mechanic, and the same fiction, as the player's synchronised drive.
         It is clamped to what the driver has just decided the corner allows,
         so it never becomes a car being pushed into a barrier. */
      const drv=this.g.driver;
      if(drv&&drv.lastInput&&drv.lastInput.brake===0&&drv.lastInput.throttle>.5
          &&Math.abs(r.bodySlip)<.12&&!r.airborne){
        // ...and never past the ceiling. See PRED_TOP.
        const top=H.top||PRED_TOP;
        const want=Math.min(STOCK_TERMINAL*H.wantV,drv.lastTarget,top);
        /* ...and it only does work where an ordinary car cannot. At match pace
           the rate is zero and the R-IX accelerates out of a corner exactly the
           way the player's car does; a drive that ran at match pace handed it a
           better exit out of every corner on the route, which is a four per
           cent advantage compounded over thirty kilometres and reads as the
           boss simply being faster for no stated reason. */
        let rate=PRED_DRIVE*clamp((H.wantV-1)*3,0,1);
        /* THE PICKUP.

           The drive above is a cruise: it holds the prototype at a speed an
           ordinary car cannot hold. What it did not do is get it back TO that
           speed, so every corner reset the chase and a player who was clean
           through the twisty districts simply walked away - which is the
           opposite of a predator.

           This is the shove out of a slow corner, and it is deliberately put
           here rather than into `powerScale`. Crank torque cannot do it: two
           driven wheels at three times the torque do not accelerate a car,
           they light up, and past the peak of the slip curve that is LESS
           force. The momentum drive is a velocity the chassis is carried to,
           the same fiction as the player's own synchronised drive, and the
           tyres then work from it - so it can never spin the car or push it
           wide.

           Gated on the deficit, so at pace it contributes nothing and the
           R-IX accelerates exactly as the player's car does. */
        const deficit=clamp((want-r.vLong)/PRED_PICKUP_TO,0,1);
        rate+=PRED_PICKUP*H.pursuit*deficit*deficit;
        if(rate>0&&r.vLong<want)r.vLong=Math.min(want,r.vLong+rate*(this.lastDt||1/60));
      }
      r.boost=1;                      // the reserve never empties
      if(this.g.driver)this.g.driver.boostHold=Math.max(this.g.driver.boostHold||0,.4);
      if(this.cfg){
        /* Measured against Chapter 3's Nova, who is a full HARD driver: skill
           0.97, eighty-five thousandths of reaction, 0.72 of the drift and
           0.962 of the tyre. At full confidence the prototype is past every one of
           those - it reacts in five hundredths, it never misses a slide, and
           it runs within one and a half per cent of the limit - and at zero
           confidence it falls well under her. Those numbers belong to the
           player, which is the whole counterplay. */
        /* A FLOOR UNDER IT.
           Starving the model used to take the DRIVER away with the prediction:
           at zero confidence the R-IX reacted in a quarter of a second and
           drove at four fifths of its own skill, which is slower than Nova and
           is why a good player saw it once and then never again. Confidence
           still buys real pace - it is the counterplay and it has to be worth
           playing - but what it now moves between is "a full HARD driver" and
           "something past the top of the ladder". It never becomes easy. */
        /* A FLOOR, AND NO CEILING WORTH THE NAME.
           He is never worse than a full HARD driver and is past the top of
           the ladder while he is working. Rivalry moves him between those
           two, and the counter-attack puts him above both. */
        const push=clamp(this.rivalry,0,1.4);
        this.cfg.skill=clamp(this.baseSkill*(.99+push*.05),.40,1);
        this.cfg.react=clamp(.062-.016*push,.044,.09);
        this.cfg.driftSkill=clamp(.92+push*.08,.70,1);
        this.cfg.boostSkill=1;
        this.cfg.mistakes=0;
        this.cfg.grip=clamp((this.baseCfg&&this.baseCfg.grip||.95)+.014+push*.020,.88,.99);
        this.cfg.assist=0;
      }
      /* NO BURSTS. Both of them - the counter-attack and the sync burst - used
         to be applied here, each multiplying the pace and the ceiling the hunt
         curve had just decided. They are gone: `pressure` is already a term in
         that curve, so being provoked raises the SAME target rather than
         overriding it, and there is no longer any state in which two systems
         disagree about how fast he should be going.

         The one thing kept from them is the visible tell. A player has to be
         able to see that they have provoked him, or the answer is invisible
         until it arrives on their gearbox. */
      /* The reheat lamp. It used to be the counter-attack's tell; with that
         gone it says the same thing the drive is actually doing - he is
         reheating whenever he is chasing a gap worth chasing. */
      // Vehicle.boosting is physics state, not a lamp override. The kit already
      // receives storyRaptorCharge below for its visual intensity.
      // the defensive line is the personality's job now; see NR.Driver
      const gap=r.sTrack-this.g.car.sTrack;
      // the kit's momentum rings glow with how hard he is pushing
      this.g.storyRaptorCharge=clamp(this.rivalry+H.pursuit*.4,0,1);
      const lock=this.g.car.sTrack>=PRED.lockFrom&&this.g.car.sTrack<=PRED.lockTo;
      if(lock!==this.lockOn){
        this.lockOn=lock;
        if(this.ui.root)this.ui.root.classList.toggle('lock',lock);
        if(global.document.body)global.document.body.classList.toggle('pred7-lock',lock);
        if(lock){
          this.toast('FINAL SECTOR // NO LIFT','#ff3b1e');this.audio('predatorScan',1);
          this.say('RAPTOR','angry','Last sector. I am not lifting.',3.4);
        }
      }
    }
    /* THE TRAP RUN, as pace rather than as a rope.

       While DEAD AHEAD is live the prototype asks for a genuinely higher
       terminal speed, spends its reserve, and is told so on the objective
       line. Nothing here writes a position: if the player is quick enough to
       come past during the trap run they come past, and Ryker has something to
       say about that too. */
    updateTrapRun(dt){
      const car=this.g.car,r=this.g.rival;
      if(!r)return;
      const live=car.sTrack<TRAP_RUN_TO
        &&this.events.gauntlet.state!=='resolved'
        &&this.events.gauntlet.state!=='cleanup';
      if(!live){
        if(this.trapRun){
          this.trapRun=false;
          this.eventBanner('TEST BAY CLEAR','THE ROAD AHEAD IS OPEN',3.4);
          this.toast('GAUNTLET CLEAR','#91ff31');
          this.say('RAPTOR','angry','No more hardware. Just the two of us now.',3.6);
        }
        return;
      }
      this.trapRun=true;
      const gap=r.sTrack-car.sTrack;
      // he only has something to say when the mirror is actually full
      this.leadSaid=Math.max(0,this.leadSaid-dt);
      if(gap<40&&gap>-260&&this.leadSaid<=0){
        this.leadSaid=this.g.car.sTrack<TRAP_RUN_TO?26:1e9;
        const lines=gap<0
          ? [['angry','Past me, through that? Do it again.'],
             ['smug','Enjoy the view. It does not last.']]
          : [['angry','Not past me. Not in here.'],
             ['smug','Aurora built this bay to break cars. Mine is fine.'],
             ['amused','Still back there. Watch the shadows.']];
        const l=lines[(this.leadUsed=(this.leadUsed||0)+1)%lines.length];
        this.say('RAPTOR',l[0],l[1],3.2);
      }
    }
    activate(){
      if(this.modeActive||this.modeCooldown>0||this.failure)return;
      this.modeActive=true;this.modeTimer=PRED.modeSeconds;this.modeWindow=PRED.modeSeconds;
      /* The nth spend costs the nth rung, and the last rung repeats. */
      const L=PRED.modeCooldowns,used=this.modeUses||0;
      this.modeCooldown=L[Math.min(used,L.length-1)];
      /* The rung that was charged, kept so the HUD's cooldown ring has the
         right denominator. Against a fixed 70 a ten-second rest barely moves
         the meter, which reads as "still not ready" for the whole of it. */
      this.modeRest=this.modeCooldown;
      this.modeUses=used+1;
      this.reserveLoaded=false;
      this.g.raceModeActive=true;this.g.raceModeBlueFuel=true;this.g.car.raceModeMultiplier=1.5;
      this.rivalry=clamp(this.rivalry+0.10,0,1);this.updateRule();
      if(global.document.body)global.document.body.classList.add('forge6-racemode');
      if(this.g.fx&&this.g.fx.raceModeBurst)this.g.fx.raceModeBurst(this.g.car);
      if(this.g.audio&&this.g.audio.boostHit)this.g.audio.boostHit();this.g.flash=.09;this.g.shake=.42;
      /* ...and what the next one will cost, because a ladder nobody is told
         about is just a cooldown that changes for no reason. */
      this.toast('raceMode // SYNCHRONIZED  \u2014  NEXT IN '
        +Math.round(this.modeCooldown)+'s','#39c7ff');
    }
    updateMode(dt){
      this.modeCooldown=Math.max(0,this.modeCooldown-dt);
      // the readout is the canvas widget now; see Game.syncRaceMode
      if(!this.modeActive)return;
      this.modeTimer=Math.max(0,this.modeTimer-dt);
      const car=this.g.car;
      if(car.boosting){
        car.vLong=Math.min(PRED.cap,car.vLong+24*dt);
        car.vx=Math.sin(car.yaw)*car.vLong+Math.cos(car.yaw)*car.vLat;
        car.vz=Math.cos(car.yaw)*car.vLong-Math.sin(car.yaw)*car.vLat;
        car.speed=Math.min(PRED.cap,Math.hypot(car.vLong,car.vLat));
      }
      if(!this.reserveLoaded&&car.boost<=.021){
        this.reserveLoaded=true;car.boost=PRED.reserve;
        this.toast('BLUE RESERVE // FLOW RESTORED','#39c7ff');if(this.g.audio&&this.g.audio.checkpoint)this.g.audio.checkpoint();
      }
      if((this.reserveLoaded&&car.boost<=.012)||this.modeTimer<=0)this.endMode();
    }
    endMode(){
      this.modeActive=false;this.g.raceModeActive=false;this.g.raceModeBlueFuel=false;
      if(this.g.car)this.g.car.raceModeMultiplier=1;if(global.document.body)global.document.body.classList.remove('forge6-racemode');
    }
    transitionEvent(id,next){
      const st=this.events[id],ev=EVENTS.find(e=>e.id===id);if(!st||!ev||st.state===next)return;
      if(!(EVENT_FLOW[st.state]||[]).includes(next))return;
      st.state=next;st.age=0;
      if(next==='arming'){
        if(id==='skybreak'){
          this.eventBanner('STRUCTURAL WARNING','SKYBREAK // PANELS WILL RETRACT',4.2);
          this.say('JAVAS','calculating','The span is live. Read the warning ribs, then commit.',3.7);
        }else if(id==='gauntlet'){
          this.eventBanner('STRUCTURAL TEST BAY','THE GAUNTLET // FIVE HAZARDS',4.4);this.beginIntercept();
          this.say('JAVAS','calculating','Test bay. Shear panels, swinging mass, spill. Read the shadow before you read the road.',4.8);
        }else{
          this.eventBanner('TOWER RUN','SENSOR CURTAINS LIVE // TOWERS SHEDDING',4.4);
          this.say('NOVA','calculating','Gates are live the whole way and the towers are coming apart. One line, all the way to the flag.',4.8);
        }
      }else if(next==='active'){
        if(id==='skybreak')this.toast('SKYBREAK // PANELS ARMED','#ffb52d');
        if(id==='gauntlet')this.toast('HAZARD BAY LIVE','#ff3b1e');
        if(id==='tower_run')this.audio('predatorScan',1);
      }else if(next==='resolved'){
        if(id==='skybreak'){this.toast('SKYBREAK CLEARED','#39e6ff');this.say('NOVA','smug','Glass held. So did you.',2.8);}
        if(id==='gauntlet'){this.toast('GAUNTLET CLEARED','#91ff31');this.say('RAPTOR','angry','Nothing in there touched you. Fine.',2.8);}
        if(id==='tower_run')this.toast('TOWER RUN CLEAR','#39e6ff');
      }
    }
    captureCheckpoint(index,notify){
      const cp=CHECKPOINTS[index];if(!cp)return;
      this.checkpointIndex=index;
      /* The gap goes in the snapshot with everything else. A rewind restores a
         moment in the race, and who was in front is part of that moment. */
      const gap=(this.g.rival&&this.g.car)?this.g.rival.sTrack-this.g.car.sTrack:95;
      this.checkpointSnapshot={index,rivalry:this.rivalry,raceTime:this.g.raceTime||0,
        boost:this.g.car?this.g.car.boost:1,modeCooldown:this.modeCooldown,modeUses:this.modeUses||0,
        gap:clamp(gap,-620,620)};
      setText(this.ui.checkpoint,'CHECKPOINT // '+cp.label);
      if(this.ui.checkpoint){this.ui.checkpoint.classList.toggle('show',!!notify);setHidden(this.ui.checkpoint,!notify);}
      this.checkpointTimer=notify?2.8:0;
      if(notify){
        this.toast('CHECKPOINT // '+cp.label,'#39e6ff');
        if(this.g.audio&&this.g.audio.checkpoint)this.g.audio.checkpoint();
        // ...and the run is written here, because this is the point a resume
        // would put the player back to
        if(this.g.markAutosave)this.g.markAutosave('checkpoint');
      }
    }
    updateCheckpoints(){
      while(this.checkpointIndex+1<CHECKPOINTS.length&&this.g.car.sTrack>=CHECKPOINTS[this.checkpointIndex+1].s)this.captureCheckpoint(this.checkpointIndex+1,true);
    }
    restoreCheckpoint(){
      const snap=this.checkpointSnapshot||{index:0,rivalry:.35,raceTime:0,boost:1,modeCooldown:0,modeUses:0,gap:95},cp=CHECKPOINTS[snap.index]||CHECKPOINTS[0];
      this.endMode();this.rivalry=snap.rivalry===undefined?.35:snap.rivalry;this.modeCooldown=snap.modeCooldown;
      this.modeUses=snap.modeUses||0;this.reserveLoaded=false;
      const speed=54,story=this.g.story;
      /* The rival comes back where he WAS relative to the player, not ninety
         five units in front of them. Restoring a fixed lead meant every rewind
         was also a penalty of whatever the player had built up, and the only
         rewind on the route is a glass panel - which is the one hazard a
         player who is already winning is most likely to be carrying speed
         into. */
      const gap=clamp(snap.gap===undefined?95:snap.gap,-620,620);
      const rivalS=clamp(cp.s+10+gap,FROM+40,TO-40);
      const rivalLat=gap>0?9:-9;
      if(story&&story.setVehicle){story.setVehicle(this.g.car,cp.s+10,0,speed);story.setVehicle(this.g.rival,rivalS,rivalLat,Math.max(56,speed));}
      else{this.g.car.reset(cp.s+10,0);this.g.rival.reset(rivalS,rivalLat);}
      this.g.car.minS=cp.s-2;this.g.car.boost=snap.boost;this.g.car.surfaceGrip=1;this.g.car.surfaceDrag=0;
      this.g.rival.minS=Math.min(cp.s-2,rivalS-2);this.g.rival.surfaceGrip=1;this.g.rival.surfaceDrag=0;
      this.g.distance=this.g.car.sTrack;this.g.raceTime=snap.raceTime+2;this.g.raceOver=false;
      this.g.storyRaptor=this.g.rival;this.g.storyHideRival=true;this.g.storyRaptorRenderPose=null;
      if(this.g.driver){if(this.cfg)this.g.driver.cfg=this.cfg;this.g.driver.reset();}
      for(const ev of EVENTS){
        const st=this.events[ev.id];st.age=0;
        st.state=cp.s>ev.to?'cleanup':cp.s>=ev.from-700?'arming':'idle';
      }
      for(const h of HAZARDS){
        const st=this.hazardStates[h.id];Object.assign(st,{phase:h.s<cp.s-30?'resolved':'dormant',age:0,progress:h.s<cp.s-30?1:0,visible:true,targetLane:h.lane,lane:h.lane,triggered:h.s<cp.s-30,currentS:h.s,
          held:0,off:0,released:false,landed:false,fall:0,tip:0});
      }
      this.glassPrevS=undefined;this.glassLive=false;
      this.intercept=null;this.oilTimer=0;this.failure=null;this.clearShock();
      this.trapRun=cp.s<TRAP_RUN_TO;this.leadSaid=0;
      this.sampleS=this.g.car.sTrack;this.lastLateral=0;this.lastSpeed=speed;
      /* A rewind puts the two cars back level, so it puts his provocation back
         to nothing as well. Restoring mid-pressure would have him answering an
         overtake that no longer happened. */
      this.wasLeading=false;this.passSaid=0;
      this.glassHeld=0;this.glassRun=0;this.glassArmed=false;this.updateRule();
      this.g.haveHistory=false;this.g.flash=.16;this.g.shake=.12;
      if(global.document.body)global.document.body.classList.remove('pred7-failure');
      this.clearFatality();
      this.eventBanner('LOCAL RESTART',cp.label+' // SYSTEMS CLEAN',2.8);
      if(this.g.audio&&this.g.audio.checkpoint)this.g.audio.checkpoint();
    }
    /* `fatality` is for the one failure that is not a mistake to be corrected
       but a thing that happened to you: a building comes down and the car is
       under it. Chapter 5 has said FATALITY across the screen for that since
       it shipped; this is the same event in chapter 7 and now says the same
       word, with the same shake, on the same frame budget. See #pred7Fatality
       in index.html. */
    fail(reason,hazard,fatality){
      if(this.failure)return;
      this.failure={age:0,reason,hazard:hazard&&hazard.id,fatality:!!fatality};
      if(hazard&&hazard.eventId)this.transitionEvent(hazard.eventId,'failed');
      this.endMode();this.g.car.surfaceGrip=1;this.g.car.surfaceDrag=0;this.clearShock();
      const body=global.document.body;
      if(body)body.classList.add('pred7-failure');
      if(fatality){
        const el=global.document.getElementById('pred7Fatality');
        const tx=global.document.getElementById('pred7FatalText');
        if(tx)tx.textContent=reason+' // REWINDING TO THE LAST GATE';
        if(el)el.setAttribute('aria-hidden','false');
        if(body)body.classList.add('pred7-fatality');
        /* Harder than an ordinary failure, because it is one. The chapter 5
           crush uses the same two numbers. */
        this.g.flash=.55;this.g.shake=1.15;
      }else{
        this.eventBanner('ROUTE FAILURE',reason+' // REWINDING',2.0);
        this.g.flash=.35;this.g.shake=.85;
      }
      this.toast('CHECKPOINT RESTART','#ff3b1e');
      this.audio('hazardCue','failure',1);
    }

    /** Put the word away again, wherever the failure is being cleared from. */
    clearFatality(){
      const el=global.document.getElementById('pred7Fatality');
      if(el)el.setAttribute('aria-hidden','true');
      if(global.document.body)global.document.body.classList.remove('pred7-fatality');
    }
    updateExclusive(dt){
      if(!this.isChapter()||!this.failure)return false;
      this.failure.age+=dt;
      if(this.g.story&&this.g.story.baseTick){
        this.g.story.baseTick(dt,false);
        if(this.g.story.cameraCar)this.g.story.cameraCar(this.g.car,'hero',58);
      }
      if(this.failure.age>=1.65)this.restoreCheckpoint();
      return true;
    }
    beginIntercept(){
      if(this.intercept||!this.g.rival)return;
      /* PURELY A SHOT.
         This used to place the rival at `max(150910, player + 380)` before
         flying him in, which hands him the race whenever the player arrives at
         DEAD AHEAD in front - and arriving in front is what the first third of
         the route is for. The fly-in now starts from an overpass behind
         wherever he actually is and settles onto him, so the camera gets its
         entrance and the timing sheet is untouched. */
      const r=this.g.rival,side=-1;
      if(this.g.driver){if(this.cfg)this.g.driver.cfg=this.cfg;this.g.driver.reset();this.g.driver.boostHold=1.2;}
      this.intercept={age:0,target:r.sTrack,side};
      this.g.storyRaptor=this.g.rival;this.g.storyHideRival=true;
    }
    updateIntercept(dt){
      const q=this.intercept,r=this.g.rival;if(!q||!r)return;
      q.age+=dt;const t=smooth(q.age/3.4),ss=(q.target-190)*(1-t)+r.sTrack*t,p=this.g.track.at(ss,{}),rx=Math.cos(p.yaw),rz=-Math.sin(p.yaw);
      const lat=q.side*92*(1-t)+(r.lateral||0)*t,y=(p.y||0)+(r.lift||0)+(1-t)*(42+Math.sin(t*Math.PI)*10);
      this.g.storyRaptorRenderPose={x:p.x+rx*lat,y,z:p.z+rz*lat,yaw:p.yaw-q.side*(1-t)*.32,pitch:0,roll:q.side*(1-t)*.10};
      if(q.age>=3.4){this.g.storyRaptorRenderPose=null;this.intercept=null;this.toast('R-IX MERGED // LIVE RIVAL','#ff3b1e');}
    }
    armHazard(h,st){
      st.phase='arming';st.age=0;st.progress=0;st.currentS=h.s;
      if(h.type==='slab'){
        st.fall=0;st.landed=false;st.tip=0;
        this.say('NOVA','shocked','Shear panel. It is coming down on the marked lane.',2.6);
      }
      const names={sky_panel:'PANEL RETRACTION',metal_ball:'WRECKING MASS',oil:'OIL FILM',barrier:'BARRIER DROP',slab:'SHEAR PANEL // FROM ABOVE'};
      this.eventBanner('HAZARD TELEGRAPH',names[h.type]||h.type,2.2);
      this.audio('hazardCue',h.type,clamp(this.rivalry+.45,.35,1));
    }
    /* A solid hit. Heavy enough to cost the race a real amount of time and to
       hand the R-IX a point of certainty, but it does NOT rewind: a boss chapter
       that restarts the kilometre every time you clip something stops being a
       race and starts being a memory test. */
    impact(h,label,r,g,b){
      const car=this.g.car;
      car.vLong*=.44;car.vLat*=.5;
      car.yawRate+=((car.lateral||0)>=(h.lane||0)?1:-1)*.42;
      car.stun=Math.max(car.stun||0,1.0);
      this.rivalry=clamp(this.rivalry-.05,0,1);   // he is in front; he can relax
      this.toast(label,'#ff3b1e');this.eventBanner('IMPACT',label,2.0);
      this.burstAt(h,r,g,b,28);this.audio('hazardCue','impact',1);
      this.g.flash=.24;this.g.shake=.72;this.updateRule();
    }
    triggerHazard(h,st){
      if(st.triggered)return;st.triggered=true;
      const car=this.g.car,lat=car.lateral||0,
        target=st.lane===undefined?(st.targetLane===undefined?h.lane:st.targetLane):st.lane;
      /* ON THE LINE, or not. Every AVOID/SLIDE/FALL hazard on the route is
         scored against the CYAN strip rather than against the red one: the
         road between them is not a pass any more. */
      const onLine=h.safeLane!==undefined&&Math.abs(lat-h.safeLane)<SAFE_TOL;
      const clear=(drop)=>{
        this.rivalry=clamp(this.rivalry+drop,0,1); // a clean line makes him work
        this.updateRule();
        this.audio('hazardCue','clear',.6);
        /* HOW CLOSE IT WAS.
         * Clearing a hazard is binary in the rules and continuous in the
         * experience: a car that crosses the line with fifteen units in hand
         * and one that crosses with two have done very different things and
         * used to get identical feedback. Inside a third of the tolerance, at
         * speed, the game slows down and says so - which is the beat the whole
         * route was missing and it costs one comparison. */
        const room=h.safeLane===undefined?99:Math.abs(lat-h.safeLane);
        const margin=SAFE_TOL-room;
        if(margin<SAFE_TOL*.34&&(car.vLong||0)>52){
          const tight=clamp(1-margin/(SAFE_TOL*.34),0,1);
          this.g.slowMo(.30+tight*.34,.20+tight*.16);
          this.toast('CLOSE','#91ff31');
          if(this.g.audio&&this.g.audio.whoosh)this.g.audio.whoosh();
          else if(this.g.audio&&this.g.audio.checkpoint)this.g.audio.checkpoint();
        }
      };
      /* FALL - the only rewind on the route, and only where the road opens.
         The verdict is the RUN's, not this frame's: see updateGlassRun. By the
         time the trigger line is reached the answer has already been decided
         over two hundred units of road, and all that is left is to act on it. */
      if(h.type==='sky_panel'){
        const held=st.held||0,need=(GLASS_IN+GLASS_OUT)*GLASS_HOLD;
        if(held<need){
          this.burstAt(Object.assign({},h,{lane:lat}),.25,.8,1,20);
          this.fail('GLASS LINE NOT HELD',h);
        }else clear(.05);
        return;
      }
      // AVOID - a solid object
      if(h.type==='metal_ball'){
        if(!onLine)this.impact(h,'WRECKING MASS',1,.55,.18); else clear(.04);
        return;
      }
      if(h.type==='barrier'){
        if(!onLine)this.impact(h,'BARRIER DROP',1,.28,.08); else clear(.04);
        return;
      }
      // SLIDE - grip, not damage
      if(h.type==='oil'){
        if(!onLine){
          this.oilTimer=2.8;
          this.toast('OFF LINE // GRIP REDUCED','#ff2bd6');this.burstAt(Object.assign({},h,{lane:lat}),.65,.16,1,12);
          this.audio('hazardCue','oil_hit',.8);
        }else clear(.04);
        return;
      }
      /* THE SHEAR PANEL, AND THE ONE THING ON THIS ROUTE THAT KILLS.
       *
       * Nine units of concrete and forty-two across, coming off a tower from
       * ninety-six units up. It used to be survivable wherever it hit you: a
       * heavy nudge, most of a straight lost, race carries on. That is the
       * right verdict for a wrecking mass on a chain and the wrong one for a
       * building landing on the car, and it left the finale with no stake in
       * it at all - every hazard on thirty kilometres cost speed and nothing
       * cost the run.
       *
       * There are three verdicts now, and which one you get is WHERE YOU ARE:
       *
       *   ON THE CYAN LINE - clear, as before. The line always wins. It is
       *   outside every panel's footprint by more than the tolerance (see the
       *   hazard rows), so this is never a matter of luck.
       *
       *   UNDER IT - fatal. Not "off the line": under the painted red patch,
       *   which is the panel's own footprint and has been pulsing on the road
       *   since 620 units out. The route rewinds to the last checkpoint, the
       *   same machinery the glass span uses.
       *
       *   OFF THE LINE BUT CLEAR OF IT - the heavy hit it always was. A player
       *   who bailed to the wrong side of the deck is not under the thing and
       *   should not be killed by it; they have still lost the line and most
       *   of a straight with it.
       *
       * The half-width is SLAB_LEN/2 - the same number the renderer scales the
       * panel and its shadow by - so what kills you is what you were shown. */
      if(h.type==='slab'){
        const under=Math.abs(lat-(h.lane||0))<=SLAB_LEN*.5;
        if(!onLine&&under){
          this.burstAt(Object.assign({},h,{lane:lat}),.78,.70,.62,54);
          this.g.flash=.42;
          if(this.g.damage&&this.g.damage.hit)this.g.damage.hit(0,.95,.6,0,-1,0,1);
          // a building on the roof of the car: the same word chapter 5 uses
          this.fail('SHEAR PANEL DOWN ON THE CAR',h,true);
          this.updateRule();
          return;
        }
        if(!onLine){
          const car2=this.g.car;
          car2.vLong*=.22;car2.vLat*=.4;
          car2.yawRate+=((car2.lateral||0)>=(h.lane||0)?1:-1)*.85;
          car2.stun=Math.max(car2.stun||0,1.6);
          car2.contactTimer=Math.max(car2.contactTimer||0,1.2);
          this.rivalry=clamp(this.rivalry-.05,0,1);
          this.toast('SHEAR PANEL // BURIED','#ff3b1e');
          this.eventBanner('IMPACT','SHEAR PANEL DOWN ON YOUR LANE',2.4);
          this.burstAt(Object.assign({},h,{lane:lat}),.70,.66,.60,40);
          this.audio('hazardCue','impact',1);
          if(this.g.glass&&this.g.glass.impact)
            this.g.shake=Math.max(this.g.shake||0,.9)+(this.g.glass.impact(car2,.95,'wall')||0);
          this.g.flash=.32;
          if(this.g.damage&&this.g.damage.hit)this.g.damage.hit(0,.72,.4,0,-1,0,.9);
        }else{
          clear(.05);
          this.toast('PANEL MISSED','#91ff31');
        }
        this.updateRule();
        return;
      }
    }

    /* The lane a hazard occupies right now, in one place. */
    hazardLane(h,st){
      const base=st.targetLane===undefined?h.lane:st.targetLane;
      if(h.type!=='metal_ball')return base;
      return base+(st.phase==='active'?Math.sin((st.age||0)*2.4)*8:0);
    }
    /* The slab, per frame.
       It hangs off the tower until the car is close enough that the decision
       is already made, then shears and falls. `fall` is 0..1 from release to
       landing; the renderer reads it for the height and the tip and nothing
       else, so what is drawn and what is collided against cannot disagree. */
    updateSlab(h,st,dt){
      const car=this.g.car,ahead=h.s-car.sTrack;
      const speed=Math.max(30,car.vLong||0);
      // release so that it lands at about the moment the car arrives
      if(!st.released&&ahead<=speed*SLAB_FALL*1.05){
        st.released=true;st.fall=0;
        this.audio('hazardCue','slab_release',1);
        this.toast('SHEAR PANEL FALLING','#ff8a3a');
      }
      if(st.released&&!st.landed){
        st.fall=Math.min(1,(st.fall||0)+dt/SLAB_FALL);
        st.tip=st.fall*st.fall;
        if(st.fall>=1){
          st.landed=true;
          this.g.shake=Math.max(this.g.shake||0,.95);
          if(this.g.audio&&this.g.audio.crash)this.g.audio.crash(1);
          this.burstAt({s:h.s,lane:h.lane},.62,.58,.54,34);
        }
      }
    }
    /* THE GLASS RUN, PER FRAME.
     *
     * Runs before the hazards, because it is what decides their verdict.
     *
     * For each panel, the stretch from GLASS_IN units before it to GLASS_OUT
     * after is a RUN, and the car is scored over every unit of it: distance
     * held on the cyan line accumulates, distance off it accumulates
     * separately, and the off-line counter RESETS every time the car comes
     * back. Two ways to lose it, and they are different failures:
     *
     *   the deck opens UNDER YOU, the moment the off-line run passes
     *   GLASS_GRACE. This is the reported fix: the panel that gives way is the
     *   one you are actually standing on, at the moment you have been off the
     *   line too long, rather than a verdict delivered at a line four units
     *   before the panel with everything up to it ignored.
     *
     *   ...or you arrive at the panel not having held enough of the run, which
     *   is the slow version of the same mistake - weaving across it rather
     *   than committing to it.
     *
     * `held` is what triggerHazard reads, so the two cannot disagree.
     */
    updateGlassRun(dt){
      const car=this.g.car,s=car.sTrack,lat=car.lateral||0;
      const ds=Math.max(0,s-(this.glassPrevS===undefined?s:this.glassPrevS));
      this.glassPrevS=s;
      if(ds>400){                       // a rewind, not a metre of road
        for(const h of HAZARDS){const st=this.hazardStates[h.id];if(st){st.held=0;st.off=0;}}
        return;
      }
      let live=null;
      for(const h of HAZARDS){
        if(h.type!=='sky_panel')continue;
        const st=this.hazardStates[h.id];
        if(!st||st.triggered||st.phase==='resolved')continue;
        const from=h.s-GLASS_IN,to=h.s+GLASS_OUT;
        if(s<from||s>to)continue;
        st.held=st.held||0;st.off=st.off||0;
        const on=h.safeLane!==undefined&&Math.abs(lat-h.safeLane)<SAFE_TOL;
        if(on){st.held+=ds;st.off=0;}
        else{
          st.off+=ds;
          if(st.off>GLASS_GRACE&&!st.triggered){
            st.triggered=true;
            this.burstAt({s,lane:lat},.25,.8,1,26);
            this.fail('THE DECK OPENED UNDER YOU',h);
            return;
          }
        }
        live={h,st,on};
      }
      /* ...and the player can see how much of it they have. A run that is
         scored over two hundred units and reported nowhere is a rule the
         player has to infer from being teleported. */
      if(live){
        const need=(GLASS_IN+GLASS_OUT)*GLASS_HOLD;
        const pct=Math.round(clamp(live.st.held/need,0,1)*100);
        const room=Math.max(0,GLASS_GRACE-(live.st.off||0));
        setText(this.ui.eventKicker,'GLASS LINE // '+pct+'%');
        setText(this.ui.eventText,live.on
          ?'ON THE LINE \u2014 STAY ON IT'
          :'OFF THE LINE \u2014 '+Math.round(room*KM_PER_UNIT*1000)+' M OF DECK LEFT');
        if(this.ui.event){this.ui.event.classList.add('show');setHidden(this.ui.event,false);}
        this.eventBannerTimer=Math.max(this.eventBannerTimer||0,.4);
        this.glassLive=true;
      }else this.glassLive=false;
    }
    updateHazards(dt){
      const s=this.g.car.sTrack,speed=Math.max(45,this.g.car.vLong||0);
      for(const h of HAZARDS){
        const st=this.hazardStates[h.id],ev=this.events[h.eventId];if(!st||!ev||ev.state==='idle'||ev.state==='cleanup')continue;
        const ahead=h.s-s,reveal=Math.max(h.telegraph||420,speed*telegraphSeconds(speed,h.type));
        if(st.phase==='dormant'&&ahead>0&&ahead<=reveal)this.armHazard(h,st);
        if(st.phase==='arming'){
          st.age+=dt;
          // the slab is live for the whole approach, not just the last 180
          if(h.type==='slab')this.updateSlab(h,st,dt);
          const actionDistance=h.type==='metal_ball'?240:h.type==='barrier'?210:h.type==='slab'?300:180;
          if(ahead<=actionDistance){st.phase='active';st.age=0;this.audio('hazardCue',h.type+'_active',1);}
        }else if(st.phase==='active'){
          st.age+=dt;st.progress=smooth(st.age/(h.type==='sky_panel' ? .72 : h.type==='barrier' ? .55 : .38));st.currentS=h.s;
          if(h.type==='slab')this.updateSlab(h,st,dt);
          /* Where the thing actually IS this frame. The wrecking mass is on a
             pendulum and the renderer knew that; the collision did not, and
             the two of them disagreed by up to a quarter of the carriageway.
             One number, written once, read by both. */
          if(h.type!=='slab')st.lane=this.hazardLane(h,st);
          if(s>=h.s-4)this.triggerHazard(h,st);
          if(s>h.s+150){st.phase='resolved';st.age=0;st.progress=1;}
        }
        /* ...and a hazard the player has outrun still happened. `active` is
           only ever entered while they are still approaching, so at high speed
           a frame could step from "too far away to arm" to "already past it"
           and the trap was silently skipped. */
        else if(ahead<=4&&ahead>-150&&!st.triggered&&st.phase!=='resolved'){
          st.phase='active';st.age=Math.max(st.age,.34);st.progress=1;
          st.lane=this.hazardLane(h,st);
          this.triggerHazard(h,st);
        }
      }
    }
    /* One live cue, for whichever hazard is closest and still ahead.
       `verb` is the same three-verb vocabulary the route is built on, `dir` is
       the answer, and the distance counts down in metres so the player can see
       how long they have rather than guessing from a stripe. */
    hazardCue(){
      const s=this.g.car.sTrack;
      let best=null,bestD=1e9;
      for(const h of HAZARDS){
        const st=this.hazardStates[h.id];
        if(!st||st.triggered||st.phase==='dormant'||st.phase==='resolved')continue;
        const d=h.s-s;
        if(d<-6||d>Math.max(h.telegraph||420,300))continue;
        if(d<bestD){bestD=d;best={h,st,d};}
      }
      if(!best){
        if(this.cueKey){this.cueKey='';this.eventBannerTimer=Math.min(this.eventBannerTimer||0,.35);}
        return;
      }
      const h=best.h,st=best.st;
      const NAME={sky_panel:'GLASS SPAN RETRACTING',metal_ball:'WRECKING MASS',
        oil:'OIL FILM',barrier:'BARRIER DROP',slab:'SHEAR PANEL // ABOVE YOU'};
      const VERB={sky_panel:'FALL',metal_ball:'AVOID',oil:'SLIDE',
        barrier:'AVOID',slab:'GET OUT'};
      const lat=this.g.car.lateral||0;
      const dir=h.safeLane===undefined?'HOLD YOUR LINE'
        :Math.abs(lat-h.safeLane)<SAFE_TOL?'ON THE LINE - HOLD IT'
        :h.safeLane<lat?'LEFT ONTO THE LINE':'RIGHT ONTO THE LINE';
      const metres=Math.max(0,Math.round(best.d*KM_PER_UNIT*1000));
      const kicker=VERB[h.type]+' // '+metres+' M';
      const text=NAME[h.type]+'  —  '+dir;
      const key=h.id+'|'+dir;
      // the live region is only written when the instruction itself changes
      if(key!==this.cueKey){this.cueKey=key;setText(this.ui.live,kicker+' — '+text);}
      setText(this.ui.eventKicker,kicker);setText(this.ui.eventText,text);
      if(this.ui.event){this.ui.event.classList.add('show');setHidden(this.ui.event,false);}
      this.eventBannerTimer=Math.max(this.eventBannerTimer||0,.4);
    }
    /* Take the steering bus, for `t` seconds. One entry point, so the class on
       the body, the flag the input layer reads and the timer that clears them
       can never disagree - which is how the Forge's version left the bus
       inverted after a checkpoint restart. */
    shockFor(t){
      this.shockTimer=Math.max(this.shockTimer||0,t);
      this.g.controlsSwapped=true;
      if(global.document.body)global.document.body.classList.add('forge6-invert');
    }
    clearShock(){
      this.shockTimer=0;this.g.controlsSwapped=false;
      if(global.document.body)global.document.body.classList.remove('forge6-invert');
    }
    updateSurface(dt){
      this.oilTimer=Math.max(0,this.oilTimer-dt);
      if(this.shockTimer>0){
        this.shockTimer-=dt;
        if(this.shockTimer<=0){this.clearShock();this.toast('STEERING BUS RESTORED','#66e8ff');}
      }
      let grip=1,drag=0;
      if(this.oilTimer>0){grip=Math.min(grip,1-.58*clamp(this.oilTimer/2.8,0,1));drag=Math.max(drag,.22*clamp(this.oilTimer/2.8,0,1));}
      this.g.car.surfaceGrip=grip;this.g.car.surfaceDrag=drag;
    }
    updateEvents(dt){
      const s=this.g.car.sTrack;
      for(const ev of EVENTS){
        const st=this.events[ev.id];st.age+=dt;
        if(st.state==='idle'&&s>=ev.from-700&&s<ev.to)this.transitionEvent(ev.id,'arming');
        if(st.state==='arming'&&s>=ev.from)this.transitionEvent(ev.id,'active');
        if(st.state==='active'&&s>ev.to)this.transitionEvent(ev.id,'resolved');
        if(st.state==='resolved'&&st.age>2)this.transitionEvent(ev.id,'cleanup');
      }
      this.updateGlassRun(dt);
      this.updateHazards(dt);this.updateIntercept(dt);
      // the glass run writes its own live readout; the generic cue would
      // overwrite it with a distance-to-panel that says nothing about the rule
      if(!this.glassLive)this.hazardCue();
      const active=EVENTS.find(e=>['arming','active'].includes(this.events[e.id].state)),zone=ZONES.find(z=>s>=z.from&&s<z.to)||ZONES[ZONES.length-1];
      setText(this.ui.phase,'CHAPTER 07 // '+zone.label);
      setText(this.ui.objectiveText,active?(active.id==='skybreak'?'HOLD THE GLASS LINE':active.id==='gauntlet'?'SURVIVE THE GAUNTLET':'THREAD THE TOWER RUN'):'BEAT THE R-IX');
      if(active&&this.ui.objective)this.ui.objective.dataset.event=active.id;
    }
    updateTimers(dt){
      if(this.eventBannerTimer>0){this.eventBannerTimer-=dt;if(this.eventBannerTimer<=0&&this.ui.event){this.ui.event.classList.remove('show');setHidden(this.ui.event,true);this.cueKey='';}}
      if(this.checkpointTimer>0){this.checkpointTimer-=dt;if(this.checkpointTimer<=0&&this.ui.checkpoint){this.ui.checkpoint.classList.remove('show');setHidden(this.ui.checkpoint,true);}}
      if(this.reasonTimer>0)this.reasonTimer-=dt;
    }
    afterUpdate(dt){
      if(!this.isChapter()){if(this.started)this.reset();return;}
      if(this.g.story.mode!=='race'){
        this.g.predatorRivalry=this.rivalry;
      /* The car that finished the Forge is the car that starts here. A player
         who jumps straight to Chapter 7 gets the same one: the finale is
         balanced against the rebuilt engine, not against the street block. */
      if(this.g.car&&this.g.car.fitEngine&&this.g.car.speedCap===Infinity)
        this.g.car.fitEngine('swap');
        if(this.modeActive)this.endMode();this.hide();return;
      }
      if(!this.started)this.start();
      if(this.ui.root){this.ui.root.classList.add('show');this.ui.root.setAttribute('aria-hidden','false');}
      if(this.g.input.actHit('raceMode'))this.activate();
      this.lastDt=dt;
      this.updateTimers(dt);this.updateCheckpoints();this.updateSurface(dt);this.updateEvents(dt);this.updateTaunt(dt);
      this.updateRivalry(dt);this.updateTrapRun(dt);this.updateMazeGates(dt);this.applyModel();this.updateMode(dt);
      this.updateRule();
      this.g.predatorRivalry=this.rivalry;
    }
  }

  /* THE MAZE, AS A RULE.
     Arms about a hundred and eighty units out, so it can be read; costs the
     car its steering for a moment if it is taken anywhere but through the gap,
     which is exactly the Forge's arc walls transplanted onto a deck the player
     is crossing at a hundred and thirty. It buys the model a point of
     certainty, because being where it expected you is what certainty is. */
/* WHERE A CURTAIN'S GAP IS, RIGHT NOW.
 *
 * Four kinds of gate (see buildLandmarks) and one function that resolves all
 * of them, so the renderer and the collision cannot disagree about where the
 * way through is. `t` is how far into the approach the car is, 0 at the arming
 * distance and 1 at the curtain.
 *
 * It is a free function rather than a method because both the director and the
 * world's renderer need it and neither owns the other.
 */
function gateGap(gt,t){
  const k=gt.kind||'hold';
  if(k==='sweep'){
    /* The gap slides across the deck on the way in, so the answer is where it
       is GOING to be. Eased, not linear: a constant slide is something you can
       track without thinking, and the whole point is that you cannot. */
    const e=t*t*(3-2*t);
    return {gap:gt.gap+(gt.sweep||0)*(1-e),half:gt.half,gap2:null,half2:0};
  }
  if(k==='close'){
    // ...and this one narrows the whole way in: commit early or not at all
    return {gap:gt.gap,half:gt.half*(1-.52*t),gap2:null,half2:0};
  }
  if(k==='split')return {gap:gt.gap,half:gt.half,gap2:gt.gap2,half2:gt.half};
  return {gap:gt.gap,half:gt.half,gap2:null,half2:0};
}
NR.chapter7GateGap=gateGap;

PredatorDirector.prototype.updateMazeGates=function(dt){
    const w=this.g.__level7World;
    if(!w||!w.mazeGates)return;
    const car=this.g.car,s=car.sTrack;
    for(const gt of w.mazeGates){
      const d=gt.s-s;
      const arming=d<190&&d>-30;
      gt.pop=clamp((gt.pop||0)+(arming?dt*5:-dt*4),0,1);
      // how far into the approach, for the kinds that move
      gt.t=clamp(1-d/190,0,1);
      if(gt.cleared)continue;
      if(d<=0&&d>-14){
        gt.cleared=true;
        const lat=car.lateral||0;
        const G=gateGap(gt,1);
        const tol=SAFE_TOL*.35;
        const through=Math.abs(lat-G.gap)<=G.half+tol
          ||(G.gap2!==null&&Math.abs(lat-G.gap2)<=G.half2+tol);
        if(through){
          /* ...and how close it was. Same rule as the hazards: threading a
             narrowing gap by half a metre and sailing through the middle of a
             wide one are different things and used to feel identical. */
          const room=Math.min(Math.abs(lat-G.gap)-G.half,
            G.gap2!==null?Math.abs(lat-G.gap2)-G.half2:99);
          if(room>-1.6&&(car.vLong||0)>52){
            this.g.slowMo(.34,.22);
            this.toast('THREADED IT','#91ff31');
          }
          this.rivalry=clamp(this.rivalry+.03,0,1);   // clean, so he has to work
          this.toast('THROUGH THE GAP','#39e6ff');this.audio('hazardCue','clear',.6);
          this.gatesCleared=(this.gatesCleared||0)+1;
        }else{
          /* THE CURTAINS ARE LIVE WIRE, exactly as the Forge's arc walls are.
           *
           * Reported: they should be electrified. They were - as a nudge: a
           * bit of speed and a bit of yaw, which at a hundred and thirty on a
           * straight is a thing you drive out of without noticing you hit it.
           *
           * What an arc wall actually costs in Chapter 6 is the STEERING BUS,
           * inverted for five seconds, and that is a rule the player has
           * already been taught by the time they arrive here. It is the same
           * rule, shorter - the deck is faster and the gates are closer - and
           * it makes the last sector a place where one mistake stays with you
           * into the next two gates rather than one that is over on the frame
           * it happened. */
          car.vLong*=.62;
          car.stun=Math.max(car.stun||0,.85);
          car.yawRate+=(lat>=G.gap?1:-1)*.44;
          car.vLat=(car.vLat||0)+(lat>=G.gap?1:-1)*3.2;
          this.rivalry=clamp(this.rivalry-.04,0,1);
          this.shockFor(2.6);
          this.toast('ARC CURTAIN // A \u2194 D  2.6s','#52dfff');
          this.eventBanner('LIVE CURTAIN','STEERING BUS INVERTED',2.4);
          this.burstAt({s:gt.s,lane:lat},.30,.86,1,26);
          this.audio('hazardCue','impact',.9);
          if(this.g.fx&&this.g.fx.sparks)this.g.fx.sparks(car,.85);
          this.g.flash=Math.max(this.g.flash||0,.26);
          this.g.shake=Math.max(this.g.shake||0,.66);
        }
        this.updateRule();
      }
    }
  };

  NR.PredatorDirector=PredatorDirector;
  /* The R-IX's tuning, published so a harness can assert the hunt curve
     directly instead of having to win a thirty-kilometre race to observe it. */
  NR.PRED=PRED;
  /* --------------------------------------------------- the stunt course --
   *
   * THE RAMPS BELONG TO THE ROAD, NOT TO THE TRIAL.
   *
   * This started life inside PredatorDirector, which is where the rest of
   * Chapter 7's rules live, and that was wrong for a reason worth writing
   * down: `afterUpdate` returns immediately unless the finale is actually
   * running as a story chapter. So the ramps were DRAWN on every visit to this
   * route - they are structure, and structure is not gated on a director - and
   * were only ARMED during the campaign. A Free Roam tour got three solid
   * concrete ramps across the carriageway that the car drove through as though
   * they were painted on.
   *
   * It then moved here, to the route's own update, and that was still one
   * route's answer to a question the whole road asks. Arming now lives in
   * `Game.updateRamps` for every car on every route - see COURSE_RAMPS in
   * js/game.js - and what is left here is the part that is genuinely the
   * finale's: the objective line, the score and the voice.
   */
  function driveJumps(g){
    const dir=g.__level7Director;
    if(!dir||!dir.started)return;
    const J=g.__jumps;
    if(!J)return;
    /* One frame of a landing, and one frame of arming, both published by
       updateRamps rather than re-derived from the car - so the chapter and the
       solver cannot disagree about which ramp was taken or how well. */
    if(J.landedId)dir.scoreLanding(J.landing||0);
    if(J.armed&&J.armed!==dir.announcedJump){
      dir.announcedJump=J.armed;
      const j=JUMPS.find(r=>r.id===J.armed);
      if(j)dir.announceJump(j);
    }else if(!J.armed)dir.announcedJump=null;
  }


  /* A stable draw order for material coherence.
   *
   * Sorting on the part's own identity rather than on anything about the
   * material: two parts sharing a material must sort adjacent, and that is a
   * property of the object, not of its colour. The id is handed out lazily on
   * first sight and then never changes, so the order is stable within a run
   * and a part cannot swap places with another between frames - which would
   * make an additive pass flicker even though addition commutes, because the
   * DEPTH state around it does not.
   *
   * The mesh is the outer key: binding a different vertex array is the more
   * expensive of the two switches, and grouping by it first means the material
   * runs sit inside mesh runs rather than cutting across them.
   */
  let _sortSeq = 0;
  function sortKey(o) {
    if (o._sortKey === undefined) o._sortKey = ++_sortSeq;
    return o._sortKey;
  }
  function byMaterial(a, b) {
    const pa = a.p, pb = b.p;
    if (pa === pb) return 0;
    const ma = pa._mesh, mb = pb._mesh;
    if (ma !== mb) return sortKey(ma || pa) - sortKey(mb || pb);
    return sortKey(pa.mat || pa) - sortKey(pb.mat || pb);
  }

  function pred(g){return g.__level7Director||new PredatorDirector(g);}

  const GP2=NR.Game.prototype,oldUpdate7=GP2.update,oldApply7=GP2.applyLevel,oldMenu7=GP2.toMenu;
  GP2.update=function(dt){
    if(this.scene&&this.scene.ready&&this.story&&pred(this).updateExclusive(dt))return;
    oldUpdate7.call(this,dt);
    if(this.scene&&this.scene.ready&&this.simulating&&this.level&&this.level.level7)driveJumps(this);
    if(this.scene&&this.scene.ready&&this.story&&this.simulating)pred(this).afterUpdate(dt);
  };
  GP2.applyLevel=function(){oldApply7.call(this);if(this.__level7Director)this.__level7Director.reset();};
  GP2.toMenu=function(){oldMenu7.call(this);if(this.__level7Director)this.__level7Director.reset();};

  NR.Level7World=Level7World;
  NR.chapter7ConfidenceDelta=confidenceDelta;NR.chapter7TelegraphSeconds=telegraphSeconds;
  NR.chapter7HuntPace=huntPace;
  global.__SYNX_LEVEL7__={version:4,name:'NEON HORIZON',jumps:JUMPS,jumpClean:JUMP_CLEAN,jumpTelegraph:JUMP_TELEGRAPH,from:ROUTE_FROM,to:FINISH,distanceKm:+((FINISH-ROUTE_FROM)*KM_PER_UNIT).toFixed(2),roadHalf:32,deckHalf:DECK_HALF,cityFloor:FLOOR,pierStep:PIER_STEP,glassway:[GLASS_A,GLASS_B],zones:ZONES,events:EVENTS,checkpoints:CHECKPOINTS,hazards:HAZARDS,chapter:7,predatorLock:[PRED.lockFrom,PRED.lockTo],raceMode:true,eventStates:['idle','arming','active','resolved','failed','cleanup'],confidenceDelta,telegraphSeconds,
  /* What the finale actually contains, for the harnesses to assert against. */
  cityTiers:3,hazardVerbs:['AVOID','SLIDE','FALL'],
  hazardTypes:['sky_panel','metal_ball','oil','barrier','slab'],
  safeLaneTolerance:SAFE_TOL,slabFall:SLAB_FALL,slabDrop:SLAB_DROP,
  rivalRaceModeRange:[PRED.basePace,PRED.maxPace],rivalUnlimitedReserve:true,
  rivalBasePace:PRED.basePace,rivalMaxPace:PRED.maxPace,rivalGrip:PRED_GRIP,
  rivalMatch:[PRED_MATCH_IDLE,PRED_MATCH_BOOST,PRED_MATCH_MODE],
  rivalChaseTop:PRED_CHASE_TOP,rivalChaseGap:PRED_CHASE_GAP,
  rivalLostTop:PRED_LOST_TOP,rivalLostRange:[PRED_LOST_FROM,PRED_LOST_TO],
  mazeGates:9,mazeGateArmsAt:190,mazeGateCosts:'steering',
  rivalStockTerminal:STOCK_TERMINAL,rivalDrive:PRED_DRIVE,
  rivalRams:false,
  trapRunTo:TRAP_RUN_TO,trapRunMatch:TRAP_MATCH,rivalTopSpeed:PRED_TOP,
  worldTo:TO,shearPanelsFall:true,
  rivalPersonality:'predator',
  corridorHalf:30,corridorTop:12};
})(window);

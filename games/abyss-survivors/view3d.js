/* 深淵倖存者 Abyss Survivors — view3d.js
 * All 3D rendering (three.js r170). Everything is procedural: models are merged primitives,
 * textures are generated in code. Crowds are drawn with one InstancedMesh per enemy type and a
 * vertex-shader limb rig, VFX with a handful of instanced batches, so a 400-enemy frame stays
 * well under ~120 draw calls. See SPEC.md for the state/events contract this module reads.
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const PI = Math.PI, TAU = PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const sat = v => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = t => { t = sat(t); return t * t * (3 - 2 * t); };
const easeOut = t => 1 - (1 - t) * (1 - t);
const num = (v, d) => (typeof v === 'number' && v === v ? v : d);
function hash1(n) {
  n = Math.imul((n | 0) ^ 0x9e3779b9, 0x85ebca6b); n ^= n >>> 13;
  n = Math.imul(n, 0xc2b2ae35); n ^= n >>> 16;
  return (n >>> 0) / 4294967296;
}
function hash2(a, b) { return hash1(Math.imul(a | 0, 73856093) ^ Math.imul(b | 0, 19349663)); }
function rng(seed) {
  let s = (seed | 0) || 1;
  return () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const VIS = 1.12, HERO_VIS = 1.3;            // characters are drawn a little larger than their collision size so they read on phones

/* ---------------------------------------------------------------------------------------------
 * GeoBuilder — merges primitives into one flat-shaded BufferGeometry with per-vertex colour
 * (rgb + emissive) and an optional per-vertex "swing" rig (pivot, axis, amplitude, phase, pose)
 * that the vertex shader animates per instance.
 * ------------------------------------------------------------------------------------------- */
const _gm = new THREE.Matrix4(), _gq = new THREE.Quaternion(), _ge = new THREE.Euler(), _gp = new THREE.Vector3(), _gs = new THREE.Vector3();
const _gc = new THREE.Color(), _ga = new THREE.Vector3(), _gb = new THREE.Vector3(), _gcv = new THREE.Vector3(), _gn = new THREE.Vector3();
const _gnm = new THREE.Matrix3(), _up = new THREE.Vector3(0, 1, 0);
class GeoBuilder {
  constructor() {
    this.p = []; this.n = []; this.c = []; this.pv = []; this.sw = [];
    this.cr = 1; this.cg = 1; this.cb = 1; this.ce = 0;
    this.rg = null; this.smoothN = false;
    this.cur = new THREE.Matrix4(); this.stack = [];
  }
  color(hex, emi = 0) { _gc.set(hex); this.cr = _gc.r; this.cg = _gc.g; this.cb = _gc.b; this.ce = emi; return this; }
  /* axis 0/1/2 = rotate about X/Y/Z through (px,py,pz) by amp*sin(phase+ph) + pose*poseAmp */
  rig(axis, px, py, pz, amp, ph = 0, pose = 0) { this.rg = [px, py, pz, axis, amp, ph, pose]; return this; }
  norig() { this.rg = null; return this; }
  smooth(v = true) { this.smoothN = v; return this; }
  push(x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, s = 1) {
    this.stack.push(this.cur.clone());
    _gm.compose(_gp.set(x, y, z), _gq.setFromEuler(_ge.set(rx, ry, rz)), _gs.set(s, s, s));
    this.cur.multiply(_gm); return this;
  }
  pop() { this.cur = this.stack.pop(); return this; }
  _add(geo, m) {
    const g = geo.index ? geo.toNonIndexed() : geo;
    const pa = g.attributes.position.array, na = g.attributes.normal ? g.attributes.normal.array : null;
    const M = _gm.copy(this.cur).multiply(m);
    const flip = M.determinant() < 0;
    if (this.smoothN && na) _gnm.getNormalMatrix(M);
    const rg = this.rg;
    for (let i = 0; i < pa.length; i += 9) {
      _ga.set(pa[i], pa[i + 1], pa[i + 2]).applyMatrix4(M);
      _gb.set(pa[i + 3], pa[i + 4], pa[i + 5]).applyMatrix4(M);
      _gcv.set(pa[i + 6], pa[i + 7], pa[i + 8]).applyMatrix4(M);
      if (flip) { const tx = _gb.x, ty = _gb.y, tz = _gb.z; _gb.copy(_gcv); _gcv.set(tx, ty, tz); }
      this.p.push(_ga.x, _ga.y, _ga.z, _gb.x, _gb.y, _gb.z, _gcv.x, _gcv.y, _gcv.z);
      if (this.smoothN && na && !flip) {
        for (let k = 0; k < 9; k += 3) { _gn.set(na[i + k], na[i + k + 1], na[i + k + 2]).applyMatrix3(_gnm).normalize(); this.n.push(_gn.x, _gn.y, _gn.z); }
      } else {
        _gb.sub(_ga); _gcv.sub(_ga); _gn.crossVectors(_gb, _gcv).normalize();
        this.n.push(_gn.x, _gn.y, _gn.z, _gn.x, _gn.y, _gn.z, _gn.x, _gn.y, _gn.z);
      }
      for (let k = 0; k < 3; k++) {
        this.c.push(this.cr, this.cg, this.cb, this.ce);
        if (rg) { this.pv.push(rg[0], rg[1], rg[2]); this.sw.push(rg[3], rg[4], rg[5], rg[6]); }
        else { this.pv.push(0, 0, 0); this.sw.push(0, 0, 0, 0); }
      }
    }
    if (g !== geo) g.dispose();
    geo.dispose();
    return this;
  }
  add(geo, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
    const m = new THREE.Matrix4().compose(_gp.set(x, y, z), _gq.setFromEuler(_ge.set(rx, ry, rz)), _gs.set(sx, sy, sz));
    return this._add(geo, m);
  }
  box(w, h, d, x, y, z, rx, ry, rz) { return this.add(new THREE.BoxGeometry(w, h, d), x, y, z, rx, ry, rz); }
  cyl(rt, rb, h, seg, x, y, z, rx, ry, rz) { return this.add(new THREE.CylinderGeometry(rt, rb, h, seg, 1), x, y, z, rx, ry, rz); }
  cone(r, h, seg, x, y, z, rx, ry, rz) { return this.add(new THREE.ConeGeometry(r, h, seg, 1), x, y, z, rx, ry, rz); }
  sph(r, x, y, z, sx = 1, sy = 1, sz = 1, ws = 6, hs = 4) { return this.add(new THREE.SphereGeometry(r, ws, hs), x, y, z, 0, 0, 0, sx, sy, sz); }
  ico(r, x, y, z, sx = 1, sy = 1, sz = 1, det = 0, rx = 0, ry = 0, rz = 0) { return this.add(new THREE.IcosahedronGeometry(r, det), x, y, z, rx, ry, rz, sx, sy, sz); }
  oct(r, x, y, z, sx = 1, sy = 1, sz = 1, rx = 0, ry = 0, rz = 0) { return this.add(new THREE.OctahedronGeometry(r, 0), x, y, z, rx, ry, rz, sx, sy, sz); }
  torus(R, r, rs, ts, arc, x, y, z, rx, ry, rz) { return this.add(new THREE.TorusGeometry(R, r, rs, ts, arc), x, y, z, rx, ry, rz); }
  /* tapered cylinder from point A to point B */
  limb(x1, y1, z1, x2, y2, z2, r1, r2, seg = 5) {
    _gp.set(x2 - x1, y2 - y1, z2 - z1); const len = _gp.length() || 0.001;
    _gq.setFromUnitVectors(_up, _gp.divideScalar(len));
    const m = new THREE.Matrix4().compose(new THREE.Vector3((x1 + x2) / 2, (y1 + y2) / 2, (z1 + z2) / 2), _gq, _gs.set(1, 1, 1));
    return this._add(new THREE.CylinderGeometry(r2, r1, len, seg, 1), m);
  }
  /* merge another already-built geometry (aColor required) through a matrix */
  merge(geo, m) {
    const pa = geo.attributes.position.array, ca = geo.attributes.aColor.array;
    const M = _gm.copy(this.cur).multiply(m);
    for (let i = 0, v = 0; i < pa.length; i += 9, v += 3) {
      _ga.set(pa[i], pa[i + 1], pa[i + 2]).applyMatrix4(M);
      _gb.set(pa[i + 3], pa[i + 4], pa[i + 5]).applyMatrix4(M);
      _gcv.set(pa[i + 6], pa[i + 7], pa[i + 8]).applyMatrix4(M);
      this.p.push(_ga.x, _ga.y, _ga.z, _gb.x, _gb.y, _gb.z, _gcv.x, _gcv.y, _gcv.z);
      _gb.sub(_ga); _gcv.sub(_ga); _gn.crossVectors(_gb, _gcv).normalize();
      this.n.push(_gn.x, _gn.y, _gn.z, _gn.x, _gn.y, _gn.z, _gn.x, _gn.y, _gn.z);
      for (let k = 0; k < 3; k++) {
        const o = (v + k) * 4; this.c.push(ca[o], ca[o + 1], ca[o + 2], ca[o + 3]);
        this.pv.push(0, 0, 0); this.sw.push(0, 0, 0, 0);
      }
    }
    return this;
  }
  build(withRig = false) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('aColor', new THREE.Float32BufferAttribute(this.c, 4));
    if (withRig) {
      g.setAttribute('aPivot', new THREE.Float32BufferAttribute(this.pv, 3));
      g.setAttribute('aSwing', new THREE.Float32BufferAttribute(this.sw, 4));
    }
    g.computeBoundingSphere();
    g.userData.tris = this.p.length / 9;
    return g;
  }
}
const GB = () => new GeoBuilder();

/* ---------------------------------------------------------------------------------------------
 * Shaders
 * ------------------------------------------------------------------------------------------- */
const GLSL_NOISE = /* glsl */`
float h21(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
  return mix(mix(h21(i), h21(i+vec2(1.0,0.0)), f.x), mix(h21(i+vec2(0.0,1.0)), h21(i+vec2(1.0,1.0)), f.x), f.y); }
float fbm(vec2 p){ return vnoise(p)*0.55 + vnoise(p*2.13+3.7)*0.3 + vnoise(p*4.31+1.2)*0.15; }
`;
/* shared world lighting: hemisphere ambient + moon key + warm hero light radius + up to 6 prop lights,
 * then a radial "darkness fog" measured from the hero (not the camera). */
const GLSL_LIGHT = /* glsl */`
uniform vec3 uHero; uniform vec4 uHeroLight; uniform vec3 uAmbSky; uniform vec3 uAmbGnd;
uniform vec3 uKeyDir; uniform vec3 uKeyCol; uniform vec3 uFogCol; uniform vec4 uFog;
uniform vec4 uPL[6]; uniform vec3 uPLC[6];
vec3 abyssLight(vec3 W, vec3 N){
  vec3 lit = mix(uAmbGnd, uAmbSky, N.y * 0.5 + 0.5);
  lit += uKeyCol * max(dot(N, uKeyDir), 0.0);
  vec3 L = vec3(uHero.x, uHero.y + 3.0, uHero.z + 1.2) - W;
  float d2 = dot(L, L);
  float att = clamp(1.0 - d2 / (uHeroLight.a * uHeroLight.a), 0.0, 1.0); att *= att;
  lit += uHeroLight.rgb * att * max(dot(N, L) * inversesqrt(d2 + 0.0001) * 0.65 + 0.35, 0.0);
  for (int i = 0; i < 6; i++) {
    vec3 Lp = uPL[i].xyz - W; float dd = dot(Lp, Lp);
    float a = clamp(1.0 - dd / (uPL[i].w * uPL[i].w), 0.0, 1.0);
    lit += uPLC[i] * (a * a) * max(dot(N, Lp) * inversesqrt(dd + 0.0001) * 0.6 + 0.4, 0.0);
  }
  return lit;
}
float abyssFog(vec3 W){ return smoothstep(uFog.x, uFog.y, distance(W.xz, uHero.xz)) * uFog.z; }
`;
const LIT_VS = /* glsl */`
attribute vec4 aColor;
#ifdef RIG
attribute vec3 aPivot; attribute vec4 aSwing;
#endif
#ifdef INST
attribute vec4 aFx; attribute vec4 aTint;
#else
uniform vec4 uFx; uniform vec4 uTint;
#endif
varying vec3 vW; varying vec3 vN; varying vec4 vCol; varying vec4 vFx; varying vec4 vTint; varying float vBaseZ;
void main(){
  #ifdef INST
  vFx = aFx; vTint = aTint;
  #else
  vFx = uFx; vTint = uTint;
  #endif
  vec3 p = position; vec3 n = normal;
  #ifdef RIG
  float ang = aSwing.y * sin(vFx.x + aSwing.z) + aSwing.w * vFx.y;
  if (abs(ang) > 0.0005) {
    float c = cos(ang), s = sin(ang); vec3 q = p - aPivot;
    if (aSwing.x < 0.5) { q = vec3(q.x, q.y*c - q.z*s, q.y*s + q.z*c); n = vec3(n.x, n.y*c - n.z*s, n.y*s + n.z*c); }
    else if (aSwing.x < 1.5) { q = vec3(q.x*c + q.z*s, q.y, -q.x*s + q.z*c); n = vec3(n.x*c + n.z*s, n.y, -n.x*s + n.z*c); }
    else { q = vec3(q.x*c - q.y*s, q.x*s + q.y*c, q.z); n = vec3(n.x*c - n.y*s, n.x*s + n.y*c, n.z); }
    p = q + aPivot;
  }
  #endif
  #ifdef USE_INSTANCING
  vec4 wp = modelMatrix * (instanceMatrix * vec4(p, 1.0));
  vN = mat3(modelMatrix) * (mat3(instanceMatrix) * n);
  vBaseZ = (modelMatrix * instanceMatrix[3]).z;
  #else
  vec4 wp = modelMatrix * vec4(p, 1.0);
  vN = mat3(modelMatrix) * n;
  vBaseZ = modelMatrix[3].z;
  #endif
  vW = wp.xyz; vCol = aColor;
  gl_Position = projectionMatrix * (viewMatrix * wp);
}`;
const LIT_FS = /* glsl */`
uniform float uTime; uniform float uRimK; uniform float uEmiK; uniform float uAlpha; uniform vec3 uRimCol; uniform vec4 uHeroScr; uniform vec2 uDim;
varying vec3 vW; varying vec3 vN; varying vec4 vCol; varying vec4 vFx; varying vec4 vTint; varying float vBaseZ;
${GLSL_NOISE}
${GLSL_LIGHT}
void main(){
  #ifdef OCCLUDE
  // props standing between the camera and the hero become a see-through dither
  if (vBaseZ > uHero.z + 0.2 && vW.y > 0.5) {
    float od = distance(gl_FragCoord.xy, uHeroScr.xy) / uHeroScr.z;
    if (od < 1.0) { vec2 g = floor(gl_FragCoord.xy); float dth = fract(dot(g, vec2(0.5, 0.25)) + 0.25 * mod(g.x, 2.0)); if (dth > od * od * 0.9 + 0.12) discard; }
  }
  #endif
  vec3 N = normalize(vN);
  #ifdef DOUBLE_SIDED
  if (!gl_FrontFacing) N = -N;
  #endif
  float fade = vFx.w; vec3 edge = vec3(0.0);
  if (fade < 0.999) {
    float dn = fbm(vW.xz * 2.3 + vW.y * 1.7);
    if (dn > fade) discard;
    edge = vec3(2.2, 0.7, 0.15) * smoothstep(fade - 0.16, fade, dn);
  }
  float ta = max(vTint.a, 0.0);
  vec3 base = mix(vCol.rgb, vTint.rgb, ta * 0.6);
  vec3 emc = vTint.a < 0.0 ? vTint.rgb * (-vTint.a) : base;   // negative tint alpha = tint only the emissive parts
  vec3 lit = abyssLight(vW, N);
  vec3 V = normalize(cameraPosition - vW);
  float rim = pow(1.0 - max(dot(N, V), 0.0), 2.5);
  vec3 col = base * (lit * uDim.x + uDim.y) + uRimCol * (rim * uRimK) * (0.4 + 0.6 * max(N.y, 0.0)) * (0.35 + lit);
  col += vTint.rgb * ta * 0.08;
  float fl = clamp(vFx.z, 0.0, 1.0);
  col = col * (1.0 + fl * 1.1) + vec3(0.34, 0.3, 0.25) * fl;
  float f = abyssFog(vW);
  col = mix(col, uFogCol, f);
  col += emc * (vCol.a * uEmiK) * (1.0 - f * uFog.w) + edge;
  gl_FragColor = vec4(col, uAlpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const GROUND_VS = /* glsl */`
uniform vec3 uGOrigin; uniform float uTile;
varying vec3 vW; varying vec2 vUv; varying vec2 vUv2;
void main(){
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vW = wp.xyz;
  vec2 loc = position.xz + uGOrigin.xy;      // hero position modulo the texture period: keeps uv small and the ground from swimming
  vUv = loc / uTile; vUv2 = (position.xz + uGOrigin.xy + vec2(uGOrigin.z)) / (uTile * 8.0);
  gl_Position = projectionMatrix * (viewMatrix * wp);
}`;
const GROUND_FS = /* glsl */`
uniform sampler2D uMap; uniform float uTime; uniform vec3 uLava; uniform vec4 uGroundFx; uniform vec3 uAurora;
varying vec3 vW; varying vec2 vUv; varying vec2 vUv2;
${GLSL_LIGHT}
void main(){
  vec4 t = texture2D(uMap, vUv);
  vec4 m = texture2D(uMap, vUv2);
  vec3 base = t.rgb * (0.72 + 0.56 * m.g);
  vec3 lit = abyssLight(vW, vec3(0.0, 1.0, 0.0));
  vec3 col = base * lit;
  float f = abyssFog(vW);
  // emissive mask (lava cracks / snow glints) with a slow travelling pulse
  float pulse = uGroundFx.x + uGroundFx.y * sin(uTime * 1.3 + m.r * 9.0 + vW.x * 0.21 + vW.z * 0.17);
  vec3 emi = uLava * t.a * pulse;
  if (uGroundFx.z > 0.5) emi *= lit * 1.5;           // glints only where light reaches (snow sparkle)
  // aurora: slow bands of coloured light sweeping across the ground (frostkeep)
  float au = sin(vW.x * 0.11 + uTime * 0.21 + sin(vW.z * 0.07 - uTime * 0.13) * 2.0);
  col += base * uAurora * (au * 0.5 + 0.5) * (0.5 + 0.5 * sin(vW.z * 0.05 + uTime * 0.1));
  col = mix(col, uFogCol, f);
  col += emi * (1.0 - f * uGroundFx.w);
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

/* instanced ground decals (flat textured quads lit like the ground) */
const DECAL_VS = /* glsl */`
attribute vec4 aD;   // x, z, rot, size
attribute vec4 aE;   // cell u, cell v, tint, alpha
uniform vec2 uCells;
varying vec3 vW; varying vec2 vUv; varying vec2 vE;
void main(){
  float c = cos(aD.z), s = sin(aD.z);
  vec2 q = position.xz * aD.w;
  vec3 wp = vec3(aD.x + q.x * c + q.y * s, 0.02, aD.y - q.x * s + q.y * c);
  vW = wp; vUv = (aE.xy + uv) / uCells; vE = aE.zw;
  gl_Position = projectionMatrix * (viewMatrix * vec4(wp, 1.0));
}`;
const DECAL_FS = /* glsl */`
uniform sampler2D uMap;
varying vec3 vW; varying vec2 vUv; varying vec2 vE;
${GLSL_LIGHT}
void main(){
  vec4 t = texture2D(uMap, vUv);
  float a = t.a * vE.y;
  if (a < 0.01) discard;
  vec3 col = t.rgb * vE.x * abyssLight(vW, vec3(0.0, 1.0, 0.0));
  col = mix(col, uFogCol, abyssFog(vW));
  gl_FragColor = vec4(col, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

/* blob shadows */
const SHADOW_VS = /* glsl */`
attribute vec4 aS;   // x, z, radius, alpha
varying vec2 vUv; varying float vA;
void main(){
  vUv = position.xz; vA = aS.w;
  gl_Position = projectionMatrix * (viewMatrix * vec4(aS.x + position.x * aS.z, 0.035, aS.y + position.z * aS.z * 0.82, 1.0));
}`;
const SHADOW_FS = /* glsl */`
varying vec2 vUv; varying float vA;
void main(){ float r = length(vUv); float a = smoothstep(1.0, 0.25, r) * vA; if (a < 0.004) discard; gl_FragColor = vec4(0.0, 0.0, 0.0, a); }`;

/* camera-facing sprites: particles, glows, flames, glints (premultiplied: additive<->alpha per instance) */
const SPRITE_VS = /* glsl */`
attribute vec4 aPos;   // xyz, size
attribute vec4 aCol;   // rgb, alpha
attribute vec4 aMisc;  // atlas cell, rotation, additive 0..1, aspect
varying vec2 vUv; varying vec4 vCol; varying float vAdd;
void main(){
  vec4 mv = viewMatrix * vec4(aPos.xyz, 1.0);
  float c = cos(aMisc.y), s = sin(aMisc.y);
  vec2 q = position.xy * vec2(1.0, aMisc.w);
  mv.xy += vec2(q.x * c - q.y * s, q.x * s + q.y * c) * aPos.w;
  gl_Position = projectionMatrix * mv;
  float cell = floor(aMisc.x + 0.5);
  vUv = (vec2(mod(cell, 4.0), floor(cell / 4.0)) + vec2(uv.x, 1.0 - uv.y)) * 0.25;
  vCol = aCol; vAdd = aMisc.z;
}`;
const SPRITE_FS = /* glsl */`
uniform sampler2D uMap;
varying vec2 vUv; varying vec4 vCol; varying float vAdd;
void main(){
  float a = texture2D(uMap, vUv).a * vCol.a;
  if (a < 0.003) discard;
  gl_FragColor = vec4(vCol.rgb * a, a * (1.0 - vAdd));
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

/* camera-facing line segments: projectile streaks, beams, lightning */
const LINE_VS = /* glsl */`
attribute vec4 aA;    // xyz, width
attribute vec4 aB;    // xyz, mode (0 tail->head streak, 1 uniform bolt, 2 beam, 3 soft pillar)
attribute vec4 aCol;
varying vec2 vUv; varying vec4 vCol; varying float vMode;
void main(){
  vec4 a = viewMatrix * vec4(aA.xyz, 1.0); vec4 b = viewMatrix * vec4(aB.xyz, 1.0);
  vec2 d = b.xy - a.xy; float l = length(d); d = l > 0.00001 ? d / l : vec2(1.0, 0.0);
  vec4 p = mix(a, b, position.x);
  p.xy += vec2(-d.y, d.x) * (position.y * aA.w);
  gl_Position = projectionMatrix * p;
  vUv = vec2(position.x, position.y + 0.5); vCol = aCol; vMode = aB.w;
}`;
const LINE_FS = /* glsl */`
varying vec2 vUv; varying vec4 vCol; varying float vMode;
void main(){
  float ac = 1.0 - abs(vUv.y * 2.0 - 1.0);
  float along = 1.0, core, soft;
  if (vMode < 0.5) { float tp = mix(0.2, 1.0, vUv.x); ac = clamp(1.0 - abs(vUv.y * 2.0 - 1.0) / tp, 0.0, 1.0); along = vUv.x * sqrt(vUv.x); soft = ac * (0.6 + 0.4 * ac); core = ac * ac * ac * 0.6 * vUv.x; }
  else if (vMode < 1.5) { soft = ac * ac * 0.7; core = smoothstep(0.55, 0.9, ac); }
  else if (vMode < 2.5) { along = smoothstep(0.0, 0.08, vUv.x) * (1.0 - vUv.x * 0.75); soft = ac * ac; core = pow(ac, 5.0) * 0.8; }
  else { along = smoothstep(0.0, 0.05, vUv.x) * pow(1.0 - vUv.x, 1.5); soft = ac * ac * (3.0 - 2.0 * ac); core = 0.0; }
  vec3 c = vCol.rgb * soft + vec3(1.0, 0.97, 0.9) * core;
  gl_FragColor = vec4(c * (along * vCol.a), 0.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

/* horizontal ground effects: rings, flashes, telegraphs, zones, scorch, auras, runes, slashes */
const GFX_VS = /* glsl */`
attribute vec4 aPos;   // x, y, z, rot
attribute vec4 aScl;   // half-size x, half-size z, mode, t
attribute vec4 aCol;
attribute vec4 aPar;   // p1, p2, p3, seed
varying vec2 vUv; varying vec4 vCol; varying vec4 vPar; varying vec2 vMT; varying vec2 vSz;
void main(){
  float c = cos(aPos.w), s = sin(aPos.w);
  vec2 q = position.xz * aScl.xy;
  vec3 wp = vec3(aPos.x + q.x * c + q.y * s, aPos.y, aPos.z - q.x * s + q.y * c);
  vUv = position.xz; vCol = aCol; vPar = aPar; vMT = aScl.zw; vSz = aScl.xy;
  gl_Position = projectionMatrix * (viewMatrix * vec4(wp, 1.0));
}`;
const GFX_FS = /* glsl */`
uniform float uTime;
varying vec2 vUv; varying vec4 vCol; varying vec4 vPar; varying vec2 vMT; varying vec2 vSz;
${GLSL_NOISE}
void main(){
  float r = length(vUv); float ang = atan(vUv.x, vUv.y);
  float mode = vMT.x, t = vMT.y;
  vec3 c = vCol.rgb; float a = 0.0; float occ = 0.0;      // a: light added, occ: how much it darkens what is below
  float disc = smoothstep(1.0, 0.94, r);
  if (mode < 0.5) {                 // 0 expanding ring
    a = smoothstep(vPar.y, 0.0, abs(r - vPar.x)) + 0.35 * smoothstep(vPar.y * 3.0, 0.0, abs(r - vPar.x));
    a *= 0.75 * smoothstep(1.0, 0.9, r); occ = vPar.z * disc;
  } else if (mode < 1.5) {          // 1 soft disc flash
    a = pow(clamp(1.0 - r, 0.0, 1.0), max(vPar.x, 0.2)); occ = vPar.z * smoothstep(1.0, 0.5, r);
  } else if (mode < 2.5) {          // 2 telegraph circle (fills up with t)
    float ring = smoothstep(0.07, 0.0, abs(r - 0.95));
    float fillR = max(t, 0.02);
    float fill = smoothstep(fillR, fillR - 0.05, r) * (0.34 + 0.12 * sin(r * 26.0 - uTime * 7.0));
    float front = smoothstep(0.06, 0.0, abs(r - fillR)) * 0.7;
    a = (ring + fill + front + 0.1) * disc; occ = 0.3 * disc;
    c = mix(c, vec3(1.0, 0.92, 0.75), front * 0.6 + smoothstep(0.85, 1.0, t) * 0.4);
  } else if (mode < 3.5) {          // 3 telegraph line (rect, fills from start to end)
    float sx = vSz.x, sz = vSz.y; vec2 dE = vec2((1.0 - abs(vUv.x)) * sx, (1.0 - abs(vUv.y)) * sz);
    float ed = min(dE.x, dE.y);
    float outline = smoothstep(0.14, 0.04, ed);
    float sAl = vUv.y * 0.5 + 0.5;
    float fill = step(sAl, t) * (0.3 + 0.12 * sin((sAl * sz * 2.0) * 3.0 - uTime * 9.0));
    float front = smoothstep(0.05, 0.0, abs(sAl - t)) * 0.7;
    a = (outline + fill + front + 0.1) * smoothstep(0.0, 0.03, ed); occ = 0.3 * smoothstep(0.0, 0.03, ed);
    c = mix(c, vec3(1.0, 0.92, 0.75), front * 0.6);
  } else if (mode < 4.5) {          // 4 poison / plague pool (swirl + bubbles)
    vec2 sw = vUv * 2.6 + vec2(sin(uTime * 0.4 + r * 3.0), cos(uTime * 0.35 - r * 3.0)) * 0.35 + vPar.w;
    float n = fbm(sw + uTime * 0.12);
    float bub = smoothstep(0.82, 0.9, vnoise(vUv * 7.0 + vec2(0.0, -uTime * 0.6) + vPar.w));
    float edge = smoothstep(0.16, 0.0, abs(r - 0.9 - (n - 0.5) * 0.12));
    float body = smoothstep(1.0, 0.8, r + (n - 0.5) * 0.25);
    a = body * (0.16 + 0.42 * n) + edge * 0.5 + bub * body * 0.3; occ = body * 0.4;
    c = mix(c * 0.5, c * 1.3 + vec3(0.06), n * 0.7 + bub * 0.3);
  } else if (mode < 5.5) {          // 5 fire field
    float n = fbm(vUv * 3.4 + vec2(vPar.w, vPar.w - uTime * 1.6));
    float n2 = vnoise(vUv * 8.0 + vec2(uTime * 0.7, -uTime * 2.4));
    float body = smoothstep(1.0, 0.72, r + (n - 0.5) * 0.3);
    float heat = clamp(n * 1.5 + n2 * 0.35 - r * 0.55, 0.0, 1.2) * body;
    a = heat * 0.62; occ = body * 0.35;
    c = mix(c * vec3(0.85, 0.3, 0.25), c + vec3(0.25, 0.3, 0.12), smoothstep(0.45, 1.1, heat)) * 1.25;
    a += smoothstep(0.1, 0.0, abs(r - 0.92)) * 0.35 * body;
  } else if (mode < 6.5) {          // 6 frost field
    float n = fbm(vUv * 3.0 + vPar.w);
    vec2 g = vUv * 5.0 + n * 1.3; float cr = abs(sin(g.x * 1.7 + g.y)) * abs(sin(g.y * 1.9 - g.x * 0.8));
    float lines = smoothstep(0.12, 0.0, cr);
    a = disc * (0.2 + 0.25 * n + lines * 0.55) + smoothstep(0.08, 0.0, abs(r - 0.94)) * 0.7; occ = disc * 0.25;
    c = mix(c, vec3(1.0), lines * 0.6);
  } else if (mode < 7.5) {          // 7 web
    float sp = pow(abs(cos(ang * 5.0)), 60.0);
    float rr = r * 5.0 + 0.35 * abs(sin(ang * 5.0));
    float rings = smoothstep(0.1, 0.0, abs(fract(rr) - 0.5));
    a = disc * (sp * 0.8 + rings * 0.55 + 0.08) * smoothstep(0.03, 0.12, r); occ = disc * 0.12;
  } else if (mode < 8.5) {          // 8 scorch mark (p1 = remaining heat)
    float n = fbm(vUv * 3.0 + vPar.w);
    float body = smoothstep(1.0, 0.25, r + (n - 0.5) * 0.7);
    float crack = smoothstep(0.1, 0.0, abs(fbm(vUv * 4.0 + vPar.w * 2.0) - 0.5)) * body;
    a = crack * vPar.x * 1.4; occ = body * 0.8;
  } else if (mode < 9.5) {          // 9 hero aura (p1: 0 holy, 1 fire)
    float rays = pow(abs(sin(ang * 6.0 + uTime * 0.7)), 4.0);
    float ring = smoothstep(0.06, 0.0, abs(r - 0.95)) + 0.5 * smoothstep(0.03, 0.0, abs(r - 0.84));
    float fl = fbm(vec2(ang * 4.0 + uTime * 0.6 * (1.0 + vPar.x), r * 5.0 - uTime * 1.4)) ;
    float glow = smoothstep(0.25, 1.0, r) * (0.2 + 0.35 * rays);
    a = disc * (glow + ring * (0.7 + 0.5 * fl) + vPar.x * fl * smoothstep(0.5, 1.0, r) * 0.8);
  } else if (mode < 10.5) {         // 10 rune circle (fills with t)
    float ring = smoothstep(0.035, 0.0, abs(r - 0.95)) + smoothstep(0.03, 0.0, abs(r - 0.7));
    float seg = fract((ang / 6.2831853 + uTime * 0.04 * (vPar.x + 1.0)) * 12.0);
    float ticks = step(0.55, seg) * smoothstep(0.045, 0.0, abs(r - 0.83) - 0.06);
    float tri = smoothstep(0.03, 0.0, abs(cos(floor(0.5 + (ang + uTime * 0.2) / 2.0944) * 2.0944 - (ang + uTime * 0.2)) * r - 0.34)) * step(r, 0.7);
    float fill = smoothstep(t, t - 0.08, r) * 0.22;
    a = (ring + ticks * 0.45 + tri * 0.5 + fill) * disc + 0.05 * disc; occ = disc * vPar.z;
  } else if (mode < 11.5) {         // 11 slash crescent (p1 = arc radians, t = progress)
    float hf = vPar.x * 0.5; float full = step(6.1, vPar.x);
    float lead = mix(-hf, hf, clamp(t * 1.8, 0.0, 1.0));
    float behind = lead - ang; if (full > 0.5) behind = mod(behind + 6.2831853, 6.2831853);
    float inArc = step(-hf, ang) * step(ang, lead); inArc = mix(inArc, 1.0, full);
    float sweep = exp(-behind * mix(2.2, 0.9, full)) * inArc;
    float radial = smoothstep(1.0, 0.95, r) * (pow(smoothstep(0.3, 0.97, r), 3.0) + 0.9 * smoothstep(0.86, 0.97, r));
    float tip = smoothstep(hf, hf - 0.25, abs(ang)); tip = mix(tip, 1.0, full);
    a = radial * sweep * tip * (1.0 - t) * 2.2;
    c = mix(c, vec3(1.0), pow(smoothstep(0.7, 1.0, r), 3.0) * sweep * 0.8);
  } else if (mode < 12.5) {         // 12 blizzard ground
    float n = fbm(vec2(ang * 2.5 + r * 5.0 - uTime * 2.2, r * 5.0 + vPar.w));
    a = disc * (0.16 + 0.42 * n * smoothstep(0.1, 0.7, r)) + smoothstep(0.07, 0.0, abs(r - 0.94)) * 0.5; occ = disc * 0.15;
    c = mix(c, vec3(1.0), n * 0.5);
  } else if (mode < 13.5) {         // 13 arrow-rain target
    float seg = step(0.5, fract((ang / 6.2831853 + uTime * 0.06) * 18.0));
    float ring = smoothstep(0.045, 0.0, abs(r - 0.94)) * seg;
    float cross = (smoothstep(0.03, 0.0, abs(vUv.x)) + smoothstep(0.03, 0.0, abs(vUv.y))) * step(0.72, r) * disc;
    a = ring + cross * 0.6 + disc * 0.09; occ = disc * 0.12;
  } else {                          // 14 thin double ring (hero marker / shrine)
    a = smoothstep(vPar.y, 0.0, abs(r - 0.86)) + 0.4 * smoothstep(0.14, 0.0, abs(r - 0.86)) * vPar.x;
  }
  a *= vCol.a; occ *= vCol.a;
  gl_FragColor = vec4(c * a, clamp(occ, 0.0, 1.0));
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

/* text / damage numbers */
const TEXT_VS = /* glsl */`
attribute vec4 aPos;    // world xyz, height (world units)
attribute vec4 aRect;   // x offset, width (in heights), u0, u1
attribute vec4 aCol;
attribute vec2 aV;      // v0, v1
varying vec2 vUv; varying vec4 vCol;
void main(){
  vec4 mv = viewMatrix * vec4(aPos.xyz, 1.0);
  mv.x += (aRect.x + (position.x + 0.5) * aRect.y) * aPos.w;
  mv.y += position.y * aPos.w;
  gl_Position = projectionMatrix * mv; gl_Position.z = -gl_Position.w * 0.999;
  vUv = vec2(mix(aRect.z, aRect.w, position.x + 0.5), mix(aV.x, aV.y, position.y + 0.5)); vCol = aCol;
}`;
const TEXT_FS = /* glsl */`
uniform sampler2D uMap;
varying vec2 vUv; varying vec4 vCol;
void main(){
  vec4 t = texture2D(uMap, vUv);
  float a = t.a * vCol.a; if (a < 0.01) discard;
  gl_FragColor = vec4(mix(vec3(0.02, 0.01, 0.03), vCol.rgb, t.r) , a);
  #include <colorspace_fragment>
}`;

/* fullscreen overlay: vignette + hurt pulse + flash */
const OVER_VS = /* glsl */`varying vec2 vUv; void main(){ vUv = position.xy; gl_Position = vec4(position.xy, 0.0, 1.0); }`;
const OVER_FS = /* glsl */`
uniform vec4 uVig; uniform vec4 uHurt; uniform vec4 uFlash; uniform float uAspect;
varying vec2 vUv;
void main(){
  vec2 q = vUv * vec2(min(uAspect, 1.0) * 0.5 + 0.5, min(1.0 / uAspect, 1.0) * 0.5 + 0.5);
  float d = length(q);
  float vig = smoothstep(uVig.x, uVig.y, d) * uVig.z;
  float edge = smoothstep(0.62, 1.42, length(vUv));
  vec3 add = uHurt.rgb * (uHurt.a * edge * 0.2) + uFlash.rgb * uFlash.a * 0.6;
  float a = clamp(vig + uHurt.a * edge * 0.12 + uFlash.a * 0.25, 0.0, 1.0);
  gl_FragColor = vec4(add, a);
}`;

/* dash after-images / ghosts */
const GHOST_VS = /* glsl */`
attribute vec4 aG;   // rgb, alpha
varying vec3 vN; varying vec3 vW; varying vec4 vG;
void main(){
  vec4 wp = modelMatrix * (instanceMatrix * vec4(position, 1.0));
  vN = mat3(instanceMatrix) * normal; vW = wp.xyz; vG = aG;
  gl_Position = projectionMatrix * (viewMatrix * wp);
}`;
const GHOST_FS = /* glsl */`
varying vec3 vN; varying vec3 vW; varying vec4 vG;
void main(){
  float fr = pow(1.0 - abs(dot(normalize(vN), normalize(cameraPosition - vW))), 1.5);
  gl_FragColor = vec4(vG.rgb * (0.25 + fr) * vG.a, 0.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

/* hero x-ray: flat tint drawn only where something hides the hero */
const XRAY_VS = /* glsl */`void main(){ gl_Position = projectionMatrix * (modelViewMatrix * vec4(position, 1.0)); }`;
const XRAY_FS = /* glsl */`uniform vec4 uXray; void main(){ gl_FragColor = vec4(uXray.rgb * uXray.a, uXray.a * 0.35); }`;

/* shield bubbles */
const BUBBLE_FS = /* glsl */`
uniform float uTime;
varying vec3 vN; varying vec3 vW; varying vec4 vG;
void main(){
  float fr = pow(1.0 - abs(dot(normalize(vN), normalize(cameraPosition - vW))), 3.2);
  float band = 0.5 + 0.5 * sin(vW.y * 9.0 - uTime * 4.0);
  gl_FragColor = vec4(vG.rgb * (fr * 0.9 + band * 0.03) * vG.a, 0.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

/* ambient motes (snow / embers / dust): stateless, wrapped around the camera target in the vertex shader */
const MOTE_VS = /* glsl */`
uniform vec3 uCenter; uniform float uTime; uniform vec4 uVel; uniform vec4 uBox; uniform float uPx;
attribute vec4 aSeed;
varying float vA; varying float vTw;
void main(){
  vec3 p = aSeed.xyz * uBox.xyz;
  p += uVel.xyz * uTime * (0.6 + 0.8 * aSeed.w);
  p.x += sin(uTime * (0.5 + aSeed.w) + aSeed.y * 40.0) * uVel.w;
  p.z += cos(uTime * (0.4 + aSeed.w * 0.7) + aSeed.x * 40.0) * uVel.w;
  vec3 rel = mod(p - uCenter + uBox.xyz * 0.5, uBox.xyz) - uBox.xyz * 0.5;
  rel.y = mod(p.y, uBox.y);
  vec3 wp = vec3(uCenter.x + rel.x, rel.y, uCenter.z + rel.z);
  vec4 mv = viewMatrix * vec4(wp, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = uBox.w * (0.5 + aSeed.w) * uPx / -mv.z;
  float edge = 1.0 - smoothstep(0.38, 0.5, max(abs(rel.x) / uBox.x, abs(rel.z) / uBox.z));
  vA = edge * smoothstep(0.0, 0.08, rel.y / uBox.y) * (1.0 - smoothstep(0.8, 1.0, rel.y / uBox.y));
  vTw = 0.6 + 0.4 * sin(uTime * (2.0 + aSeed.w * 5.0) + aSeed.x * 90.0);
}`;
const MOTE_FS = /* glsl */`
uniform vec4 uMoteCol;
varying float vA; varying float vTw;
void main(){
  vec2 q = gl_PointCoord - 0.5; float d = 1.0 - length(q) * 2.0; if (d <= 0.0) discard;
  float a = d * d * vA * vTw * uMoteCol.a;
  gl_FragColor = vec4(uMoteCol.rgb * a, 0.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;
/* drifting fog cards */
const FOGCARD_VS = /* glsl */`
uniform vec3 uCenter; uniform float uTime; uniform vec4 uBox; uniform vec2 uDrift;
attribute vec4 aSeed;
varying vec2 vUv; varying float vA; varying float vS;
void main(){
  vec3 p = vec3(aSeed.x * uBox.x + uTime * uDrift.x * (0.5 + aSeed.w), 0.0, aSeed.z * uBox.z + uTime * uDrift.y * (0.5 + aSeed.w));
  vec3 rel = mod(p - uCenter + uBox.xyz * 0.5, uBox.xyz) - uBox.xyz * 0.5;
  float sz = uBox.w * (0.7 + 0.8 * aSeed.w);
  vec3 wp = vec3(uCenter.x + rel.x + position.x * sz * 1.6, 0.5 + aSeed.y * 1.4, uCenter.z + rel.z + position.z * sz);
  vUv = position.xz; vS = aSeed.w * 17.0;
  vA = 1.0 - smoothstep(0.3, 0.5, max(abs(rel.x) / uBox.x, abs(rel.z) / uBox.z));
  gl_Position = projectionMatrix * (viewMatrix * vec4(wp, 1.0));
}`;
const FOGCARD_FS = /* glsl */`
uniform vec4 uFogCard; uniform float uTime; uniform vec3 uHero;
varying vec2 vUv; varying float vA; varying float vS;
${GLSL_NOISE}
void main(){
  float r = length(vUv); if (r > 1.0) discard;
  float n = fbm(vUv * 1.6 + vS + uTime * 0.05);
  float a = pow(1.0 - r, 1.5) * (0.35 + 0.65 * n) * vA * uFogCard.a;
  gl_FragColor = vec4(uFogCard.rgb * a, a * 0.55);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

/* ---------------------------------------------------------------------------------------------
 * Procedural textures
 * ------------------------------------------------------------------------------------------- */
function fbmField(size, seed, basePeriod, octaves, gain = 0.5) {
  const out = new Float32Array(size * size); let amp = 1, tot = 0;
  for (let o = 0; o < octaves; o++) {
    const per = basePeriod << o; if (per > size / 2) break;
    const R = rng(seed + o * 131), tab = new Float32Array(per * per);
    for (let i = 0; i < tab.length; i++) tab[i] = R();
    const sc = per / size;
    for (let y = 0; y < size; y++) {
      const fy = y * sc, y0 = Math.floor(fy), y1 = (y0 + 1) % per; let ty = fy - y0; ty = ty * ty * (3 - 2 * ty);
      for (let x = 0; x < size; x++) {
        const fx = x * sc, x0 = Math.floor(fx), x1 = (x0 + 1) % per; let tx = fx - x0; tx = tx * tx * (3 - 2 * tx);
        const a = tab[y0 * per + x0], b = tab[y0 * per + x1], c = tab[y1 * per + x0], d = tab[y1 * per + x1];
        out[y * size + x] += (a + (b - a) * tx + (c + (d - c) * tx - a - (b - a) * tx) * ty) * amp;
      }
    }
    tot += amp; amp *= gain;
  }
  for (let i = 0; i < out.length; i++) out[i] /= tot;
  return out;
}
/* tileable voronoi: returns {edge, id} fields (edge = F2-F1 in cell units) */
function voronoiField(size, seed, nc) {
  const R = rng(seed), px = new Float32Array(nc * nc), py = new Float32Array(nc * nc);
  for (let i = 0; i < nc * nc; i++) { px[i] = 0.15 + R() * 0.7; py[i] = 0.15 + R() * 0.7; }
  const edge = new Float32Array(size * size), id = new Uint16Array(size * size), cs = size / nc;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const gx = x / cs, gy = y / cs, cx = Math.floor(gx), cy = Math.floor(gy);
    let f1 = 9, f2 = 9, bi = 0;
    for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
      const ix = ((cx + i) % nc + nc) % nc, iy = ((cy + j) % nc + nc) % nc, k = iy * nc + ix;
      const dx = cx + i + px[k] - gx, dy = cy + j + py[k] - gy, d = Math.sqrt(dx * dx + dy * dy);
      if (d < f1) { f2 = f1; f1 = d; bi = k; } else if (d < f2) f2 = d;
    }
    edge[y * size + x] = f2 - f1; id[y * size + x] = bi;
  }
  return { edge, id };
}
const ss = (a, b, x) => { const t = sat((x - a) / (b - a)); return t * t * (3 - 2 * t); };
function paintGround(stage, S) {
  const px = new Uint8Array(S * S * 4);
  const put = (i, r, g, b, a) => { const o = i * 4; px[o] = r < 0 ? 0 : r > 255 ? 255 : r; px[o + 1] = g < 0 ? 0 : g > 255 ? 255 : g; px[o + 2] = b < 0 ? 0 : b > 255 ? 255 : b; px[o + 3] = a < 0 ? 0 : a > 255 ? 255 : a; };
  const k = S / 512;
  const n1 = fbmField(S, 11, 4, 5), n2 = fbmField(S, 23, 3, 4), n3 = fbmField(S, 37, 32, 3), n4 = fbmField(S, 51, 8, 4);
  const R = rng(977);
  const stamp = (x, y, r, g, b, al) => {
    x = ((Math.round(x) % S) + S) % S; y = ((Math.round(y) % S) + S) % S; const o = (y * S + x) * 4;
    px[o] = px[o] + (r - px[o]) * al; px[o + 1] = px[o + 1] + (g - px[o + 1]) * al; px[o + 2] = px[o + 2] + (b - px[o + 2]) * al;
  };
  if (stage === 'catacombs') {
    const rows = 8, rh = S / rows, ids = [], dl = [], dr = [];
    for (let r = 0; r < rows; r++) {
      const cuts = []; let x = R() * 40 * k;
      while (x < S - 30 * k) { cuts.push(x); x += (46 + R() * 70) * k; }
      const id = new Int16Array(S), l = new Float32Array(S), rr = new Float32Array(S);
      for (let xx = 0; xx < S; xx++) {
        let ci = cuts.length - 1; for (let c = 0; c < cuts.length; c++) if (cuts[c] <= xx) ci = c; else break;
        if (xx < cuts[0]) ci = cuts.length - 1;
        const left = cuts[ci], right = cuts[(ci + 1) % cuts.length];
        id[xx] = ci; l[xx] = ((xx - left) % S + S) % S; rr[xx] = ((right - xx) % S + S) % S;
      }
      ids.push(id); dl.push(l); dr.push(rr);
    }
    for (let y = 0; y < S; y++) {
      const r = Math.floor(y / rh), dt = y - r * rh, db = rh - dt;
      for (let x = 0; x < S; x++) {
        const i = y * S + x, sid = ids[r][x], L = dl[r][x], Rr = dr[r][x];
        const ed = Math.min(L, Rr, dt, db) / k;
        const hs = hash2(r * 31 + 7, sid * 17 + 3), hs2 = hash2(r * 13 + 1, sid * 29 + 11);
        let v = 100 + (hs - 0.5) * 44 + (n3[i] - 0.5) * 34 + (n1[i] - 0.5) * 30;
        if (hs2 < 0.08) v -= 30;
        v += ss(0, 18, ed) * 8;
        if (Math.min(L, dt) / k < 5) v += 13; if (Math.min(Rr, db) / k < 5) v -= 16;
        let rC = v * 1.0, gC = v * 0.99, bC = v * 0.93;
        if (hs2 > 0.8) { rC *= 1.08; bC *= 0.9; }
        const moss = ss(0.56, 0.72, n2[i]) * (1 - ss(2, 16, ed)) * 0.7 + ss(0.72, 0.84, n2[i]) * 0.35;
        rC += (58 - rC) * moss; gC += (92 - gC) * moss; bC += (44 - bC) * moss;
        const mort = 1 - ss(1.2, 3.2, ed);
        rC += (30 - rC) * mort; gC += (33 - gC) * mort; bC += (27 - bC) * mort;
        put(i, rC, gC, bC, 0);
      }
    }
    for (let c = 0; c < 26; c++) {           // cracks
      let x = R() * S, y = R() * S, a = R() * TAU;
      for (let s = 0; s < (30 + R() * 50) * k; s++) { a += (R() - 0.5) * 0.9; x += Math.cos(a); y += Math.sin(a); stamp(x, y, 22, 24, 20, 0.75); stamp(x + 1, y, 130, 132, 118, 0.25); }
    }
  } else if (stage === 'inferno') {
    const V = voronoiField(S, 5, 7);
    for (let i = 0; i < S * S; i++) {
      const e = V.edge[i], ct = hash1(V.id[i] * 7 + 3);
      const lava = ss(0.5, 0.64, n2[i]);
      const crack = 1 - ss(0.01, 0.06, e);
      const halo = (1 - ss(0.0, 0.3, e)) * lava;
      let v = 58 + (ct - 0.5) * 30 + (n3[i] - 0.5) * 36 + (n1[i] - 0.5) * 26 + ss(0.05, 0.4, e) * 12;
      let rC = v * 1.08, gC = v * 0.94, bC = v * 0.92;
      const dk = crack * (1 - lava) * 0.75; rC *= 1 - dk; gC *= 1 - dk; bC *= 1 - dk;
      rC += halo * 50; gC += halo * 10;
      put(i, rC, gC, bC, 255 * sat(crack * lava * 1.1 + halo * halo * 0.22));
    }
  } else if (stage === 'frostkeep') {
    const V = voronoiField(S, 9, 9);
    for (let i = 0; i < S * S; i++) {
      const ice = ss(0.6, 0.68, n2[i]), rim = ss(0.54, 0.6, n2[i]) * (1 - ice);
      const d = n1[i], f = n3[i];
      let rC = lerp(120, 178, d) + (f - 0.5) * 16 + rim * 22, gC = lerp(138, 190, d) + (f - 0.5) * 16 + rim * 22, bC = lerp(170, 208, d) + (f - 0.5) * 12 + rim * 18;
      const cr = (1 - ss(0.01, 0.04, V.edge[i])) * 0.8;
      const ir = 44 + f * 22 + cr * 120 + (n4[i] - 0.5) * 20, ig = 78 + f * 26 + cr * 120 + (n4[i] - 0.5) * 24, ib = 112 + f * 30 + cr * 110;
      rC += (ir - rC) * ice; gC += (ig - gC) * ice; bC += (ib - bC) * ice;
      const gl = (hash1(i * 3 + 1) > 0.9978 ? 1 : 0) * (1 - ice);
      put(i, rC, gC, bC, 255 * (gl + ice * cr * 0.25));
    }
  } else {                                   // graveyard: damp grass and bare earth
    for (let i = 0; i < S * S; i++) {
      const d = ss(0.5, 0.6, n2[i]), g = n1[i], f = n3[i], q = n4[i];
      let rC = 46 + g * 34 + (f - 0.5) * 30, gC = 70 + g * 44 + (f - 0.5) * 40, bC = 58 + g * 26 + (f - 0.5) * 22;
      const dr = 84 + q * 34 + (f - 0.5) * 26, dg = 74 + q * 28 + (f - 0.5) * 22, db = 64 + q * 22 + (f - 0.5) * 18;
      rC += (dr - rC) * d; gC += (dg - gC) * d; bC += (db - bC) * d;
      put(i, rC, gC, bC, 0);
    }
    for (let t = 0; t < 2600 * k * k; t++) {    // grass blades
      const x = R() * S, y = R() * S, i = (Math.floor(y) * S + Math.floor(x));
      if (ss(0.5, 0.6, n2[i]) > 0.6 && R() < 0.85) continue;
      const a = -PI / 2 + (R() - 0.5) * 1.2, len = (3 + R() * 6) * k, lt = R() > 0.45;
      for (let s = 0; s < len; s++) stamp(x + Math.cos(a) * s, y + Math.sin(a) * s, lt ? 96 : 26, lt ? 132 : 44, lt ? 84 : 34, 0.5);
    }
    for (let t = 0; t < 70; t++) {              // pebbles
      const x = R() * S, y = R() * S, r = (1.5 + R() * 3) * k;
      for (let j = -r; j <= r; j++) for (let i2 = -r; i2 <= r; i2++) if (i2 * i2 + j * j <= r * r) stamp(x + i2, y + j, j < 0 ? 138 : 96, j < 0 ? 140 : 98, j < 0 ? 136 : 100, 0.85);
    }
  }
  const tex = new THREE.DataTexture(px, S, S, THREE.RGBAFormat);
  tex.colorSpace = THREE.SRGBColorSpace; tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter; tex.minFilter = THREE.LinearMipmapLinearFilter; tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

function makeCanvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
function makeSpriteAtlas() {
  const C = 64, cv = makeCanvas(256, 256), g = cv.getContext('2d');
  const cell = (i, fn) => { g.save(); g.translate((i % 4) * C + C / 2, Math.floor(i / 4) * C + C / 2); g.beginPath(); g.rect(-C / 2, -C / 2, C, C); g.clip(); fn(); g.restore(); };
  const radial = (r, stops) => { const gr = g.createRadialGradient(0, 0, 0, 0, 0, r); for (const [o, a] of stops) gr.addColorStop(o, `rgba(255,255,255,${a})`); g.fillStyle = gr; g.beginPath(); g.arc(0, 0, r, 0, TAU); g.fill(); };
  cell(0, () => radial(31, [[0, 1], [0.18, 0.62], [0.45, 0.2], [0.75, 0.05], [1, 0]]));                   // 0 soft glow
  cell(1, () => radial(30, [[0, 1], [0.22, 1], [0.4, 0.35], [1, 0]]));                                    // 1 spark
  cell(2, () => { radial(14, [[0, 1], [0.4, 0.5], [1, 0]]); g.fillStyle = '#fff';                         // 2 four-point glint
    for (let a = 0; a < 2; a++) { g.save(); g.rotate(a * PI / 2); g.beginPath(); g.moveTo(-30, 0); g.quadraticCurveTo(0, -3.5, 30, 0); g.quadraticCurveTo(0, 3.5, -30, 0); g.fill(); g.restore(); } });
  cell(3, () => { const R = rng(5); for (let i = 0; i < 9; i++) { g.save(); g.translate((R() - 0.5) * 26, (R() - 0.5) * 26); radial(12 + R() * 8, [[0, 0.55], [0.6, 0.25], [1, 0]]); g.restore(); } });  // 3 smoke
  cell(4, () => { const gr = g.createRadialGradient(0, 8, 1, 0, 4, 26); gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.5, 'rgba(255,255,255,0.7)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.beginPath(); g.moveTo(0, -30); g.bezierCurveTo(10, -10, 20, 4, 14, 18); g.bezierCurveTo(8, 30, -8, 30, -14, 18); g.bezierCurveTo(-20, 4, -8, -8, 0, -30); g.fill(); });           // 4 flame
  cell(5, () => { g.fillStyle = '#fff'; g.beginPath(); g.moveTo(0, -28); g.lineTo(11, 0); g.lineTo(0, 28); g.lineTo(-11, 0); g.closePath(); g.fill(); });                                                // 5 shard
  cell(6, () => { g.strokeStyle = '#fff'; g.lineWidth = 4; g.beginPath(); g.arc(0, 0, 25, 0, TAU); g.stroke(); });                                                                                   // 6 ring
  cell(7, () => { g.fillStyle = '#fff'; g.beginPath(); g.moveTo(-18, -6); g.lineTo(-4, -20); g.lineTo(16, -10); g.lineTo(20, 8); g.lineTo(2, 20); g.lineTo(-16, 12); g.closePath(); g.fill(); });        // 7 ash flake
  cell(8, () => { g.fillStyle = '#fff'; g.beginPath(); g.moveTo(0, -28); g.quadraticCurveTo(18, 0, 0, 28); g.quadraticCurveTo(-18, 0, 0, -28); g.fill(); });                                           // 8 leaf
  cell(9, () => { g.strokeStyle = 'rgba(255,255,255,0.9)'; g.lineWidth = 3; g.beginPath(); g.arc(0, 0, 22, 0, TAU); g.stroke(); g.fillStyle = 'rgba(255,255,255,0.25)'; g.fill(); g.fillStyle = '#fff'; g.beginPath(); g.arc(-8, -8, 4, 0, TAU); g.fill(); }); // 9 bubble
  cell(10, () => { g.fillStyle = '#fff'; g.fillRect(-6, -24, 12, 48); g.fillRect(-24, -6, 48, 12); radial(20, [[0, 0.6], [1, 0]]); });                                                              // 10 plus
  cell(11, () => { g.fillStyle = '#fff'; g.beginPath(); g.moveTo(-20, -14); g.lineTo(8, -22); g.lineTo(22, -2); g.lineTo(12, 20); g.lineTo(-16, 18); g.closePath(); g.fill(); });                     // 11 chunk
  cell(12, () => { g.fillStyle = '#fff'; g.beginPath(); g.moveTo(0, -28); g.bezierCurveTo(4, -8, 18, 2, 18, 12); g.arc(0, 12, 18, 0, PI); g.bezierCurveTo(-18, 2, -4, -8, 0, -28); g.fill(); });      // 12 droplet
  cell(13, () => { g.strokeStyle = '#fff'; g.lineWidth = 3.5; g.lineCap = 'round'; for (let a = 0; a < 3; a++) { g.save(); g.rotate(a * PI / 3); g.beginPath(); g.moveTo(-26, 0); g.lineTo(26, 0); g.moveTo(16, 0); g.lineTo(22, -6); g.moveTo(16, 0); g.lineTo(22, 6); g.moveTo(-16, 0); g.lineTo(-22, -6); g.moveTo(-16, 0); g.lineTo(-22, 6); g.stroke(); g.restore(); } }); // 13 snowflake
  cell(14, () => { g.strokeStyle = '#fff'; g.lineWidth = 5; g.lineJoin = 'miter'; g.beginPath(); g.moveTo(-12, 24); g.lineTo(-12, -24); g.lineTo(12, -8); g.lineTo(-12, 6); g.lineTo(14, 24); g.stroke(); });  // 14 rune
  cell(15, () => { g.fillStyle = '#fff'; g.beginPath(); g.arc(0, 0, 22, 0, TAU); g.fill(); });                                                                                                         // 15 solid dot
  const t = new THREE.CanvasTexture(cv); t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter;
  return t;
}
const SP = { GLOW: 0, SPARK: 1, GLINT: 2, SMOKE: 3, FLAME: 4, SHARD: 5, RING: 6, ASH: 7, LEAF: 8, BUBBLE: 9, PLUS: 10, CHUNK: 11, DROP: 12, SNOW: 13, RUNE: 14, DOT: 15 };

const GLYPHS = '0123456789k+-!%x';
const TEXT_FONT = '"Noto Sans TC","PingFang TC","Microsoft JhengHei","Heiti TC",system-ui,sans-serif';
function makeTextAtlas() {
  const cv = makeCanvas(512, 512), g = cv.getContext('2d');
  g.textAlign = 'center'; g.textBaseline = 'middle'; g.lineJoin = 'round';
  g.font = `900 50px ${TEXT_FONT}`;
  for (let i = 0; i < GLYPHS.length; i++) {
    const x = (i % 8) * 64 + 32, y = Math.floor(i / 8) * 64 + 34;
    g.strokeStyle = '#000'; g.lineWidth = 9; g.strokeText(GLYPHS[i], x, y);
    g.fillStyle = '#fff'; g.fillText(GLYPHS[i], x, y);
  }
  const t = new THREE.CanvasTexture(cv); t.generateMipmaps = false; t.minFilter = THREE.LinearFilter; t.magFilter = THREE.LinearFilter;
  return { cv, g, tex: t, rows: [], next: 0 };
}

/* 4x2 atlas of ground decals per stage (128 px cells) */
function makeDecalAtlas(stage) {
  const C = 128, cv = makeCanvas(512, 256), g = cv.getContext('2d'), R = rng(stage.length * 7919 + 13);
  const cell = (i, fn) => { g.save(); g.translate((i % 4) * C + C / 2, Math.floor(i / 4) * C + C / 2); g.beginPath(); g.rect(-C / 2, -C / 2, C, C); g.clip(); fn(); g.restore(); };
  const blot = (x, y, r, col, a, n = 7, spread = 0.6) => {
    for (let i = 0; i < n; i++) {
      const bx = x + (R() - 0.5) * r * spread * 2, by = y + (R() - 0.5) * r * spread * 2, br = r * (0.45 + R() * 0.5);
      const gr = g.createRadialGradient(bx, by, 0, bx, by, br); gr.addColorStop(0, `rgba(${col},${a})`); gr.addColorStop(0.6, `rgba(${col},${a * 0.7})`); gr.addColorStop(1, `rgba(${col},0)`);
      g.fillStyle = gr; g.beginPath(); g.arc(bx, by, br, 0, TAU); g.fill();
    }
  };
  const crack = (col, w = 2.2, len = 46) => {
    g.strokeStyle = col; g.lineCap = 'round';
    const walk = (x, y, a, l, wd) => { g.lineWidth = wd; g.beginPath(); g.moveTo(x, y); for (let s = 0; s < l; s += 5) { a += (R() - 0.5) * 0.9; x += Math.cos(a) * 5; y += Math.sin(a) * 5; g.lineTo(x, y); if (R() < 0.16 && wd > 1) walk(x, y, a + (R() < 0.5 ? 0.8 : -0.8), l * 0.4, wd * 0.6); } g.lineWidth = wd; g.stroke(); };
    for (let k = 0; k < 3; k++) walk(0, 0, R() * TAU, len, w);
  };
  const bone = (x, y, a, l, col) => { g.save(); g.translate(x, y); g.rotate(a); g.strokeStyle = col; g.lineWidth = 5; g.lineCap = 'round'; g.beginPath(); g.moveTo(-l, 0); g.lineTo(l, 0); g.stroke(); g.fillStyle = col; for (const s of [-1, 1]) for (const t of [-1, 1]) { g.beginPath(); g.arc(s * l, t * 3.2, 3.6, 0, TAU); g.fill(); } g.restore(); };
  const skull = (x, y, s, col, dark) => { g.fillStyle = col; g.beginPath(); g.arc(x, y, 10 * s, 0, TAU); g.fill(); g.fillRect(x - 6 * s, y + 4 * s, 12 * s, 9 * s); g.fillStyle = dark; g.beginPath(); g.arc(x - 4 * s, y + 1 * s, 2.8 * s, 0, TAU); g.arc(x + 4 * s, y + 1 * s, 2.8 * s, 0, TAU); g.fill(); g.fillRect(x - 1 * s, y + 5 * s, 2 * s, 3 * s); };
  const stones = (n, colA, colB, snow) => { for (let i = 0; i < n; i++) { const x = (R() - 0.5) * 80, y = (R() - 0.5) * 80, r = 5 + R() * 11; g.fillStyle = 'rgba(0,0,0,0.45)'; g.beginPath(); g.ellipse(x + 2, y + 3, r, r * 0.8, R(), 0, TAU); g.fill(); g.fillStyle = colA; g.beginPath(); g.ellipse(x, y, r, r * 0.78, R(), 0, TAU); g.fill(); g.fillStyle = snow || colB; g.beginPath(); g.ellipse(x - r * 0.2, y - r * 0.25, r * 0.62, r * 0.42, R(), 0, TAU); g.fill(); } };
  const bonesCell = (col, dark) => { bone(-12, 10, 0.5, 22, col); bone(8, 18, -0.6, 18, col); bone(14, -22, 1.3, 14, col); skull(-14, -16, 1.2, col, dark); };
  if (stage === 'catacombs') {
    cell(0, () => { g.strokeStyle = 'rgba(215,225,205,0.5)'; g.lineWidth = 1.4; for (let i = 0; i < 9; i++) { const a = i / 9 * TAU + R() * 0.2; g.beginPath(); g.moveTo(0, 0); g.lineTo(Math.cos(a) * 58, Math.sin(a) * 58); g.stroke(); } for (let r = 12; r < 58; r += 10) { g.beginPath(); for (let i = 0; i <= 9; i++) { const a = i / 9 * TAU, rr = r * (0.9 + 0.1 * Math.sin(i * 2.3)); const x = Math.cos(a) * rr, y = Math.sin(a) * rr; i ? g.lineTo(x, y) : g.moveTo(x, y); } g.stroke(); } blot(0, 0, 50, '200,210,190', 0.1); });
    cell(1, () => bonesCell('#cfc8ac', '#2a2a22'));
    cell(2, () => crack('rgba(14,16,12,0.85)'));
    cell(3, () => { blot(0, 0, 44, '52,88,40', 0.55, 9); blot(0, 0, 30, '86,120,52', 0.4, 6); });
    cell(4, () => { skull(-18, 6, 1.3, '#c9c2a4', '#26261f'); skull(10, -10, 1.5, '#d6cfb2', '#26261f'); skull(16, 22, 1.1, '#b9b294', '#26261f'); });
    cell(5, () => { blot(0, 0, 40, '40,92,36', 0.7, 8); blot(-4, -4, 22, '120,200,70', 0.5, 5); g.strokeStyle = 'rgba(200,255,150,0.6)'; g.lineWidth = 2; g.beginPath(); g.arc(-8, -10, 14, 3.4, 4.6); g.stroke(); });
    cell(6, () => stones(9, '#5c5e52', '#8b8d7c'));
    cell(7, () => { g.strokeStyle = 'rgba(190,170,230,0.55)'; g.lineWidth = 2.5; g.beginPath(); g.arc(0, 0, 46, 0, TAU); g.stroke(); g.beginPath(); g.arc(0, 0, 36, 0, TAU); g.stroke(); g.beginPath(); for (let i = 0; i <= 5; i++) { const a = i * TAU * 2 / 5 - PI / 2; const x = Math.cos(a) * 36, y = Math.sin(a) * 36; i ? g.lineTo(x, y) : g.moveTo(x, y); } g.stroke(); });
  } else if (stage === 'inferno') {
    cell(0, () => { blot(0, 0, 44, '70,64,62', 0.7, 9); blot(0, 0, 26, '120,112,108', 0.5, 6); });
    cell(1, () => blot(0, 0, 50, '6,4,4', 0.75, 10));
    cell(2, () => stones(8, '#2c2524', '#5a4a46'));
    cell(3, () => bonesCell('#8a7c6c', '#1a1210'));
    cell(4, () => { crack('rgba(255,120,30,0.95)', 3, 50); crack('rgba(255,220,120,0.9)', 1.2, 30); });
    cell(5, () => { blot(0, 0, 40, '120,96,40', 0.3, 8); blot(0, 0, 22, '150,125,60', 0.22, 5); });
    cell(6, () => { for (let i = 0; i < 9; i++) { const x = (R() - 0.5) * 80, y = (R() - 0.5) * 80, a = R() * TAU, l = 8 + R() * 14; g.fillStyle = '#18141a'; g.beginPath(); g.moveTo(x + Math.cos(a) * l, y + Math.sin(a) * l); g.lineTo(x + Math.cos(a + 2.2) * l * 0.5, y + Math.sin(a + 2.2) * l * 0.5); g.lineTo(x + Math.cos(a - 2.2) * l * 0.5, y + Math.sin(a - 2.2) * l * 0.5); g.fill(); g.fillStyle = 'rgba(150,130,170,0.6)'; g.beginPath(); g.moveTo(x + Math.cos(a) * l, y + Math.sin(a) * l); g.lineTo(x, y); g.lineTo(x + Math.cos(a + 2.2) * l * 0.5, y + Math.sin(a + 2.2) * l * 0.5); g.fill(); } });
    cell(7, () => crack('rgba(8,5,5,0.9)', 3, 50));
  } else if (stage === 'frostkeep') {
    cell(0, () => { blot(0, 0, 46, '236,242,252', 0.6, 9); blot(-6, -8, 26, '255,255,255', 0.5, 5); });
    cell(1, () => { blot(0, 0, 44, '50,96,140', 0.75, 8); crack('rgba(225,242,255,0.8)', 1.6, 40); });
    cell(2, () => { for (let i = 0; i < 5; i++) { g.fillStyle = 'rgba(70,96,140,0.6)'; g.beginPath(); g.ellipse((i % 2 ? 9 : -9), -44 + i * 22, 6, 9, 0.1, 0, TAU); g.fill(); } });
    cell(3, () => stones(7, '#4b5566', '#7c8aa0', '#eef4ff'));
    cell(4, () => { g.strokeStyle = '#3a2f2a'; g.lineCap = 'round'; for (let i = 0; i < 5; i++) { g.lineWidth = 2 + R() * 2; const x = (R() - 0.5) * 70, y = (R() - 0.5) * 70, a = R() * TAU, l = 14 + R() * 20; g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); g.lineTo(x + Math.cos(a + 0.5) * l * 1.4, y + Math.sin(a + 0.5) * l * 1.4); g.stroke(); } });
    cell(5, () => { blot(0, 0, 40, '90,140,180', 0.65, 7); g.strokeStyle = 'rgba(255,255,255,0.7)'; g.lineWidth = 2; g.beginPath(); g.arc(-6, -8, 18, 3.3, 4.7); g.stroke(); });
    cell(6, () => { for (let i = 0; i < 10; i++) { const x = (R() - 0.5) * 84, y = (R() - 0.5) * 84, l = 6 + R() * 12, a = R() * TAU; g.fillStyle = 'rgba(190,230,255,0.85)'; g.beginPath(); g.moveTo(x + Math.cos(a) * l, y + Math.sin(a) * l); g.lineTo(x + Math.cos(a + 1.6) * l * 0.35, y + Math.sin(a + 1.6) * l * 0.35); g.lineTo(x - Math.cos(a) * l, y - Math.sin(a) * l); g.lineTo(x + Math.cos(a - 1.6) * l * 0.35, y + Math.sin(a - 1.6) * l * 0.35); g.fill(); } });
    cell(7, () => blot(0, 0, 48, '60,84,128', 0.45, 9));
  } else {
    cell(0, () => { g.lineCap = 'round'; for (let i = 0; i < 46; i++) { const x = (R() - 0.5) * 70, y = (R() - 0.5) * 60 + 10, a = -PI / 2 + (R() - 0.5) * 1.3, l = 10 + R() * 18; g.strokeStyle = R() < 0.5 ? 'rgba(30,54,36,0.9)' : 'rgba(86,128,78,0.9)'; g.lineWidth = 1.6 + R() * 1.6; g.beginPath(); g.moveTo(x, y); g.quadraticCurveTo(x + Math.cos(a) * l * 0.5, y + Math.sin(a) * l * 0.5, x + Math.cos(a + 0.3) * l, y + Math.sin(a + 0.3) * l); g.stroke(); } });
    cell(1, () => { for (let i = 0; i < 13; i++) { g.save(); g.translate((R() - 0.5) * 90, (R() - 0.5) * 90); g.rotate(R() * TAU); g.fillStyle = ['#7a4a22', '#94602a', '#5e3a20', '#a8742c'][i % 4]; g.beginPath(); g.moveTo(0, -9); g.quadraticCurveTo(7, 0, 0, 9); g.quadraticCurveTo(-7, 0, 0, -9); g.fill(); g.strokeStyle = 'rgba(0,0,0,0.35)'; g.lineWidth = 1; g.beginPath(); g.moveTo(0, -8); g.lineTo(0, 8); g.stroke(); g.restore(); } });
    cell(2, () => bonesCell('#c9c4b0', '#232622'));
    cell(3, () => { blot(0, 0, 46, '58,46,36', 0.8, 10); blot(-4, -6, 28, '92,76,58', 0.6, 6); });
    cell(4, () => { blot(0, 0, 40, '22,38,48', 0.8, 8); g.strokeStyle = 'rgba(170,215,225,0.6)'; g.lineWidth = 2; g.beginPath(); g.arc(-6, -8, 18, 3.3, 4.7); g.stroke(); });
    cell(5, () => stones(8, '#4c5350', '#7d8680'));
    cell(6, () => crack('rgba(26,22,18,0.85)', 3.2, 52));
    cell(7, () => { for (let i = 0; i < 9; i++) { const x = (R() - 0.5) * 80, y = (R() - 0.5) * 80; g.fillStyle = '#d8d2c0'; g.fillRect(x - 1.2, y, 2.4, 7); g.fillStyle = i % 3 ? '#b9a48a' : '#9a3a34'; g.beginPath(); g.ellipse(x, y, 6, 3.6, 0, PI, TAU); g.fill(); } });
  }
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}

/* ---------------------------------------------------------------------------------------------
 * Props (colliding obstacles). Each kind: one or more variant geometries built for a nominal
 * collision radius; instances are placed/rotated/scaled deterministically from the obstacle seed.
 * ------------------------------------------------------------------------------------------- */
const PROP_DEFS = {
  tomb: { r: 0.55, face: true, variants: [
    g => { g.color(0x5f6b6e).box(1.15, 0.16, 0.55, 0, 0.08, 0); g.color(0x8a989b).box(0.9, 1.0, 0.26, 0, 0.62, 0).cyl(0.45, 0.45, 0.26, 10, 0, 1.12, 0, PI / 2, 0, 0);
      g.color(0x4c585b).box(0.5, 0.08, 0.04, 0, 0.95, 0.14).box(0.08, 0.5, 0.04, 0, 0.9, 0.14); g.color(0x4f7550).box(0.4, 0.2, 0.3, -0.3, 0.2, 0.05, 0, 0.3, 0.2).box(0.3, 0.12, 0.28, 0.25, 1.2, 0, 0, 0, -0.4); },
    g => { g.color(0x59656a).box(0.8, 0.3, 0.6, 0, 0.15, 0); g.color(0x8f9c9e).box(0.26, 1.6, 0.22, 0, 1.0, 0).box(0.95, 0.24, 0.22, 0, 1.3, 0); g.color(0x4f7550).box(0.3, 0.1, 0.26, -0.3, 1.45, 0).box(0.5, 0.14, 0.4, 0.2, 0.34, 0.1); },
    g => { g.color(0x5b676a).box(0.95, 0.45, 1.25, 0, 0.225, 0); g.color(0x7f8d90).box(1.05, 0.14, 1.36, 0, 0.52, 0, 0, 0.12, 0.03); g.color(0x9aa7a8).box(0.12, 0.05, 0.8, 0, 0.6, 0, 0, 0.12, 0).box(0.5, 0.05, 0.12, 0, 0.6, -0.2, 0, 0.12, 0); g.color(0x4f7550).box(0.4, 0.12, 0.4, 0.35, 0.5, 0.45); }
  ], h: 1.5, shadow: 0.9 },
  deadtree: { r: 0.45, variants: [g => {
    const R = rng(77); g.color(0x3f3832);
    g.limb(0, 0, 0, 0.08, 1.5, 0.05, 0.36, 0.24, 6).limb(0.08, 1.5, 0.05, -0.1, 2.5, 0, 0.24, 0.16, 5);
    for (let i = 0; i < 4; i++) { const a = i * 1.6 + 0.4; g.limb(Math.cos(a) * 0.2, 0.25, Math.sin(a) * 0.2, Math.cos(a) * 0.62, 0.0, Math.sin(a) * 0.62, 0.13, 0.05, 4); }
    g.color(0x4a423a);
    const br = (x, y, z, a, len, r, d) => { const up = 0.5 + R() * 0.4, x2 = x + Math.cos(a) * len, y2 = y + len * up, z2 = z + Math.sin(a) * len; g.limb(x, y, z, x2, y2, z2, r, r * 0.55, 4); if (d > 0) { br(x2, y2, z2, a + 0.5 + R() * 0.5, len * 0.66, r * 0.55, d - 1); br(x2, y2, z2, a - 0.5 - R() * 0.5, len * 0.6, r * 0.5, d - 1); } };
    br(0.06, 1.4, 0.04, 0.3, 0.9, 0.13, 2); br(0, 1.9, 0, 2.5, 0.85, 0.12, 2); br(-0.08, 2.4, 0, 4.4, 0.8, 0.11, 1); br(-0.1, 2.5, 0, 1.2, 0.7, 0.1, 1);
  }], h: 3.6, shadow: 0.9 },
  lantern: { r: 0.3, variants: [g => {
    g.color(0x5a6466).box(0.5, 0.3, 0.5, 0, 0.15, 0); g.color(0x23262b).cyl(0.06, 0.08, 2.5, 6, 0, 1.5, 0).limb(0, 2.7, 0, 0.55, 2.82, 0, 0.05, 0.04, 4).limb(0, 2.3, 0, 0.3, 2.74, 0, 0.03, 0.03, 4);
    g.limb(0.52, 2.8, 0, 0.52, 2.5, 0, 0.015, 0.015, 3); g.cone(0.2, 0.16, 4, 0.52, 2.52, 0, 0, PI / 4, 0);
    g.color(0xffb64e, 2.6).box(0.22, 0.3, 0.22, 0.52, 2.3, 0); g.color(0x23262b).box(0.28, 0.04, 0.28, 0.52, 2.13, 0);
    for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) g.box(0.03, 0.32, 0.03, 0.52 + sx * 0.12, 2.3, sz * 0.12);
  }], h: 2.9, shadow: 0.45, light: { x: 0.52, y: 2.3, col: [1.0, 0.6, 0.24], k: 1.5, r: 7.5 }, glow: 1.5 },
  pillar: { r: 0.7, variants: [
    g => { g.color(0x6e7062).box(1.5, 0.3, 1.5, 0, 0.15, 0).box(1.25, 0.2, 1.25, 0, 0.4, 0); g.color(0x8f9180).cyl(0.52, 0.56, 2.9, 8, 0, 1.95, 0); g.color(0x777969).box(1.3, 0.18, 1.3, 0, 3.49, 0).box(1.55, 0.26, 1.55, 0, 3.71, 0); g.color(0x62644f).cyl(0.57, 0.57, 0.1, 8, 0, 1.2, 0).cyl(0.55, 0.55, 0.1, 8, 0, 2.6, 0); },
    g => { g.color(0x6e7062).box(1.5, 0.3, 1.5, 0, 0.15, 0).box(1.25, 0.2, 1.25, 0, 0.4, 0); g.color(0x8f9180).cyl(0.54, 0.56, 1.3, 8, 0, 1.15, 0); g.color(0x9a9c8a).cone(0.5, 0.5, 5, 0.06, 2.0, 0.05, 0.2, 0.4, 0.1).cone(0.3, 0.6, 4, -0.2, 2.0, -0.1, -0.2, 0, 0.2);
      g.color(0x85877a).cyl(0.5, 0.5, 1.1, 8, 1.2, 0.5, 0.5, PI / 2, 0, 0.5).box(0.5, 0.3, 0.4, -0.9, 0.15, 0.7, 0, 0.6, 0); }
  ], h: 3.8, shadow: 1.15 },
  rubble: { r: 0.7, variants: [g => {
    const R = rng(31);
    for (let i = 0; i < 9; i++) { const a = R() * TAU, d = R() * 0.55, s = 0.28 + R() * 0.42; g.color(i % 3 ? 0x7c7e6e : 0x62645a).box(s * 1.3, s, s, Math.cos(a) * d, s * 0.45 + (i < 3 ? 0.3 : 0), Math.sin(a) * d, R(), R() * 3, R()); }
    g.color(0x4f6a40).box(0.4, 0.1, 0.4, 0.2, 0.62, 0.1, 0.2, 0.5, 0);
  }], h: 0.9, shadow: 1.0 },
  brazier: { r: 0.4, variants: [g => {
    g.color(0x25272c);
    for (let i = 0; i < 3; i++) { const a = i * TAU / 3 + 0.5; g.limb(Math.cos(a) * 0.45, 0, Math.sin(a) * 0.45, Math.cos(a) * 0.14, 1.0, Math.sin(a) * 0.14, 0.05, 0.04, 4); }
    g.cyl(0.52, 0.26, 0.32, 8, 0, 1.12, 0).cyl(0.56, 0.56, 0.06, 8, 0, 1.3, 0);
    g.color(0x9dff5a, 2.2).cyl(0.44, 0.44, 0.05, 8, 0, 1.31, 0); g.color(0xe8ff9a, 3).ico(0.16, 0.1, 1.38, 0.05).ico(0.13, -0.15, 1.36, -0.1);
  }], h: 1.4, shadow: 0.6, light: { x: 0, y: 1.9, col: [0.62, 1.0, 0.5], k: 0.8, r: 7.5 }, flame: { y: 1.45, col: [0.55, 1.0, 0.3], s: 1.0 }, glow: 1.9 },
  spike: { r: 0.6, variants: [g => {
    const R = rng(91);
    for (let i = 0; i < 5; i++) { const a = i * 1.3, d = i ? 0.34 : 0, h = i ? 1.1 + R() * 1.0 : 2.6; g.color(i % 2 ? 0x3d3236 : 0x4b3d40).cone(0.3 + (i ? 0 : 0.14), h, 5, Math.cos(a) * d, h / 2, Math.sin(a) * d, Math.sin(a) * 0.3 * (i ? 1 : 0), R(), -Math.cos(a) * 0.3 * (i ? 1 : 0)); }
    g.color(0xff6a1a, 1.4).cone(0.08, 0.5, 4, 0, 2.5, 0);
  }], h: 2.7, shadow: 0.8 },
  basalt: { r: 0.9, variants: [g => {
    const R = rng(17); const pts = [[0, 0], [0.56, 0.1], [-0.5, 0.26], [0.2, -0.56], [-0.3, -0.48], [0.3, 0.6], [-0.66, -0.2]];
    for (let i = 0; i < pts.length; i++) { const h = i ? 0.5 + R() * 1.3 : 2.3; g.color(0x443a40).cyl(0.34, 0.36, h, 6, pts[i][0], h / 2, pts[i][1], 0, R() * 2, 0); g.color(0x66575c).cyl(0.3, 0.34, 0.06, 6, pts[i][0], h + 0.02, pts[i][1]); }
  }], h: 2.3, shadow: 1.2 },
  lavavent: { r: 0.7, variants: [g => {
    g.color(0x3a2f31).cyl(0.52, 1.0, 0.55, 9, 0, 0.275, 0); g.color(0x1d1517).cyl(0.44, 0.5, 0.1, 9, 0, 0.54, 0);
    g.color(0xff5a14, 3).cyl(0.4, 0.4, 0.06, 9, 0, 0.56, 0); g.color(0xffc040, 4).ico(0.14, 0.1, 0.6, 0.05).ico(0.1, -0.16, 0.6, -0.12);
    const R = rng(3); for (let i = 0; i < 5; i++) { const a = i * 1.3 + R(); g.color(0x4b3d40).ico(0.16 + R() * 0.1, Math.cos(a) * 0.7, 0.3, Math.sin(a) * 0.7, 1, 0.8, 1, 0, R(), R()); }
  }], h: 0.7, shadow: 1.0, light: { x: 0, y: 1.2, col: [1.0, 0.36, 0.08], k: 1.7, r: 8 }, flame: { y: 0.75, col: [1.0, 0.45, 0.1], s: 0.9 }, glow: 2.2 },
  icecrystal: { r: 0.6, variants: [g => {
    const R = rng(41); const sp = [[0, 0, 1.25, 0, 0], [0.4, 0.1, 0.8, 0.35, 0], [-0.36, 0.2, 0.9, -0.3, 0.15], [0.1, -0.4, 0.7, 0, -0.4], [-0.2, -0.3, 0.55, -0.4, -0.3], [0.3, 0.42, 0.5, 0.3, 0.5]];
    for (let i = 0; i < sp.length; i++) { const s = sp[i]; g.color(i % 2 ? 0x8fd4ff : 0xbfeaff, 0.55).oct(0.3, s[0], s[2] * 0.9, s[1], 0.85, s[2] * 3.2, 0.85, s[4], R() * 2, -s[3]); }
    g.color(0xe8f6ff).box(1.0, 0.1, 1.0, 0, 0.04, 0, 0, 0.6, 0);
  }], h: 2.2, shadow: 0.8, light: { x: 0, y: 1.2, col: [0.3, 0.72, 1.0], k: 0.9, r: 5.5 }, glow: 1.2 },
  statue: { r: 0.6, face: true, variants: [g => {
    g.color(0x6f8094).box(1.15, 0.5, 1.15, 0, 0.25, 0); g.color(0x8a9db2).box(0.95, 0.12, 0.95, 0, 0.56, 0);
    g.color(0x8296ac).cyl(0.24, 0.42, 1.2, 7, 0, 1.2, 0).sph(0.36, 0, 1.85, 0, 1.25, 0.7, 0.85).sph(0.22, 0, 2.2, 0.02);
    g.limb(0.42, 1.8, 0, 0.2, 1.3, 0.34, 0.11, 0.09, 5).limb(-0.42, 1.8, 0, -0.2, 1.3, 0.34, 0.11, 0.09, 5);
    g.color(0x9fb4c8).box(0.1, 1.5, 0.05, 0, 1.3, 0.42).box(0.44, 0.08, 0.08, 0, 1.75, 0.42);
    g.color(0xf2f7ff).sph(0.2, 0, 2.36, 0, 1.05, 0.45, 1.05).sph(0.2, 0.36, 1.97, 0, 1.1, 0.4, 1).sph(0.2, -0.36, 1.97, 0, 1.1, 0.4, 1).box(1.2, 0.08, 1.2, 0, 0.62, 0);
    g.color(0xa8dcff, 0.5).oct(0.2, 0.5, 0.45, 0.5, 0.7, 2.2, 0.7, 0.3, 0, -0.3).oct(0.16, -0.5, 0.36, 0.45, 0.7, 2, 0.7, 0.3, 0, 0.4);
  }], h: 2.5, shadow: 1.0 },
  pine: { r: 0.5, variants: [g => {
    g.color(0x4a362a).cyl(0.16, 0.22, 1.0, 6, 0, 0.5, 0);
    const tiers = [[1.15, 1.3, 1.35], [0.9, 1.2, 2.15], [0.62, 1.15, 2.95]];
    for (const [r, h, y] of tiers) { g.color(0x234a3e).cone(r, h, 7, 0, y, 0, 0, y, 0); g.color(0xeaf2fb).cone(r * 0.62, h * 0.55, 7, 0, y + h * 0.26, 0, 0, y, 0); }
  }], h: 3.5, shadow: 1.1 },
  rock: { r: 0.6, variants: [g => { g.color(0x666a70).ico(0.6, 0, 0.35, 0, 1, 0.75, 1, 0, 0.3, 0.2, 0.1).ico(0.35, 0.5, 0.2, 0.2, 1, 0.8, 1); }], h: 0.8, shadow: 0.9 }
};

/* ---------------------------------------------------------------------------------------------
 * Enemy models. Front = +Z, feet at y=0, natural size (the instance matrix applies scale).
 * meta: h height, fly hover height, freq anim phase speed, bob walk bounce, sh shadow radius,
 *       lean forward lean while charging, alpha (<1 = translucent), pulse (bomber sac).
 * ------------------------------------------------------------------------------------------- */
const BONE = 0xddd6ba, BONE_D = 0xa9a288;
function humanLegs(g, col, x, hip, r, amp, footCol) {
  for (const s of [1, -1]) {
    g.color(col).rig(0, s * x, hip, 0, amp, s > 0 ? 0 : PI);
    g.limb(s * x, hip, 0, s * x, 0.06, 0, r, r * 0.85, 5);
    g.color(footCol === undefined ? col : footCol).box(r * 2.2, 0.1, r * 3.6, s * x, 0.05, r * 0.9);
  }
  g.norig();
}
function buildSkeleton(g, eye, ally) {
  humanLegs(g, BONE, 0.13, 0.78, 0.06, 0.75);
  g.color(BONE).box(0.36, 0.14, 0.2, 0, 0.82, 0).cyl(0.05, 0.05, 0.5, 5, 0, 1.08, 0);
  g.color(BONE_D).box(0.46, 0.08, 0.26, 0, 1.02, 0).box(0.5, 0.08, 0.28, 0, 1.15, 0).box(0.48, 0.08, 0.26, 0, 1.28, 0);
  g.color(BONE).box(0.6, 0.1, 0.2, 0, 1.4, 0);
  // left arm (+X)
  g.rig(0, 0.32, 1.4, 0, 0.6, 0, -0.5).limb(0.32, 1.4, 0, 0.34, 0.8, 0.06, 0.055, 0.045, 5);
  if (ally) g.color(0x3a5c8a).cyl(0.26, 0.26, 0.05, 8, 0.4, 0.95, 0.1, 0, 0, PI / 2).color(0x9fd8ff, 1.2).cyl(0.09, 0.09, 0.07, 6, 0.42, 0.95, 0.1, 0, 0, PI / 2);
  // right arm + blade
  g.color(BONE).rig(0, -0.32, 1.4, 0, 0.6, PI, -1.5).limb(-0.32, 1.4, 0, -0.34, 0.82, 0.08, 0.055, 0.045, 5);
  g.color(ally ? 0x8fb6d8 : 0x8f887a).box(0.05, 0.1, 0.95, -0.34, 0.86, 0.6, -0.25, 0, 0).color(0x4a3a2a).box(0.22, 0.06, 0.06, -0.34, 0.8, 0.16);
  g.norig().color(BONE).sph(0.21, 0, 1.66, 0.02, 1, 0.95, 1.08).box(0.2, 0.1, 0.18, 0, 1.5, 0.07);
  g.color(eye, 3.2).box(0.07, 0.07, 0.04, 0.08, 1.67, 0.21).box(0.07, 0.07, 0.04, -0.08, 1.67, 0.21);
  if (ally) g.color(0x6fc8ff, 1.6).cone(0.1, 0.3, 5, 0, 1.98, 0);
}
const ENEMY_DEFS = {
  skeleton: g => { buildSkeleton(g, 0xff3a22, false); return { h: 1.75, freq: 9, bob: 0.05, sh: 0.5 }; },
  zombie: g => {
    humanLegs(g, 0x4a3b2e, 0.17, 0.8, 0.1, 0.42, 0x2c241c);
    g.color(0x5d5346).box(0.62, 0.72, 0.38, 0, 1.12, 0.04, 0.25, 0, 0); g.color(0x7c9a5c).box(0.3, 0.2, 0.06, 0.05, 0.98, 0.26, 0.25, 0, 0);
    g.color(0x86a565).sph(0.23, 0, 1.6, 0.2, 1, 1, 1.05); g.color(0x2a1c1c).box(0.16, 0.07, 0.08, 0, 1.5, 0.4);
    g.color(0xe8e8a0, 1.6).box(0.06, 0.05, 0.04, 0.09, 1.63, 0.41).box(0.06, 0.05, 0.04, -0.09, 1.63, 0.41);
    for (const s of [1, -1]) { g.color(0x7c9a5c).rig(0, s * 0.38, 1.38, 0.08, 0.14, s > 0 ? 0 : PI, -0.45).limb(s * 0.38, 1.38, 0.08, s * 0.32, 1.3, 0.8, 0.1, 0.08, 5); g.color(0x5c7646).box(0.14, 0.1, 0.16, s * 0.32, 1.29, 0.86); }
    g.norig(); return { h: 1.8, freq: 5, bob: 0.03, sh: 0.6, sway: 0.1 };
  },
  bat: g => {
    g.color(0x7a1f2c).sph(0.2, 0, 0, 0, 1, 0.9, 1.35).sph(0.15, 0, 0.06, 0.24);
    g.color(0x4a1420).cone(0.06, 0.2, 4, 0.1, 0.24, 0.22, 0, 0, -0.3).cone(0.06, 0.2, 4, -0.1, 0.24, 0.22, 0, 0, 0.3);
    g.color(0xffd84a, 3).box(0.05, 0.05, 0.04, 0.07, 0.08, 0.38).box(0.05, 0.05, 0.04, -0.07, 0.08, 0.38);
    for (const s of [1, -1]) {
      g.rig(2, s * 0.12, 0, 0, s * 0.95, 0);
      g.color(0x5c1826).box(0.5, 0.035, 0.46, s * 0.38, 0, -0.02, 0, s * 0.25, 0); g.color(0x4a1420).box(0.46, 0.03, 0.34, s * 0.8, 0, -0.12, 0, s * 0.5, 0);
      g.color(0x8a2a3a).limb(s * 0.12, 0.02, 0.12, s * 1.02, 0.02, 0.0, 0.03, 0.015, 3);
    }
    g.norig(); return { h: 0.5, fly: 1.5, freq: 16, bob: 0.12, sh: 0.32, flyBob: 0.2 };
  },
  ghoul: g => {
    g.color(0x9a8fa8).box(0.5, 0.42, 0.85, 0, 0.78, 0, -0.42, 0, 0);
    g.color(0x6f6680).cone(0.07, 0.2, 4, 0, 1.12, 0.1, -0.5).cone(0.07, 0.2, 4, 0, 0.98, -0.16, -0.6).cone(0.06, 0.18, 4, 0, 0.84, -0.4, -0.7);
    g.color(0xa99fb6).sph(0.21, 0, 1.02, 0.55, 1, 0.85, 1.2); g.color(0x7a1a22).box(0.24, 0.09, 0.24, 0, 0.88, 0.64);
    g.color(0xf4f0d0).cone(0.03, 0.09, 3, 0.08, 0.93, 0.74, PI).cone(0.03, 0.09, 3, -0.08, 0.93, 0.74, PI);
    g.color(0xfff2a0, 3).box(0.06, 0.05, 0.04, 0.09, 1.07, 0.76).box(0.06, 0.05, 0.04, -0.09, 1.07, 0.76);
    for (const s of [1, -1]) {
      g.color(0x8a7f98).rig(0, s * 0.2, 0.62, -0.28, 0.85, s > 0 ? 0 : PI).limb(s * 0.2, 0.62, -0.28, s * 0.22, 0.04, -0.2, 0.09, 0.07, 5);
      g.rig(0, s * 0.32, 0.92, 0.3, 0.85, s > 0 ? PI : 0, -1.0).limb(s * 0.32, 0.92, 0.3, s * 0.36, 0.05, 0.58, 0.08, 0.06, 5);
      g.color(0xf4f0d0).cone(0.035, 0.16, 3, s * 0.36, 0.06, 0.7, PI / 2).cone(0.035, 0.16, 3, s * 0.3, 0.06, 0.68, PI / 2);
    }
    g.norig(); return { h: 1.25, freq: 13, bob: 0.07, sh: 0.6, lean: 0.35 };
  },
  spider: g => {
    g.color(0x2a2233).sph(0.34, 0, 0.4, -0.32, 1, 0.82, 1.2).sph(0.22, 0, 0.33, 0.16);
    g.color(0x7dff5a, 2.4).oct(0.1, 0, 0.67, -0.24, 1, 0.4, 1.5).oct(0.08, 0, 0.64, -0.5, 1.4, 0.4, 1);
    g.color(0xff3030, 3).box(0.05, 0.05, 0.03, 0.07, 0.4, 0.36).box(0.05, 0.05, 0.03, -0.07, 0.4, 0.36).box(0.04, 0.04, 0.03, 0.14, 0.34, 0.33).box(0.04, 0.04, 0.03, -0.14, 0.34, 0.33);
    g.color(0xd8d0b8).cone(0.03, 0.14, 3, 0.06, 0.22, 0.36, PI).cone(0.03, 0.14, 3, -0.06, 0.22, 0.36, PI);
    const spread = [1.0, 0.35, -0.3, -0.95];
    for (const s of [1, -1]) for (let i = 0; i < 4; i++) {
      const bx = s * 0.17, bz = 0.22 - i * 0.13, a = spread[i], dx = s * Math.cos(a), dz = Math.sin(a);
      g.color(0x3a3046).rig(1, bx, 0.34, bz, 0.34, (i % 2 ? 0 : PI) + (s > 0 ? 0 : PI));
      g.limb(bx, 0.34, bz, bx + dx * 0.42, 0.66, bz + dz * 0.42, 0.045, 0.035, 3).limb(bx + dx * 0.42, 0.66, bz + dz * 0.42, bx + dx * 0.82, 0.0, bz + dz * 0.82, 0.035, 0.018, 3);
    }
    g.norig(); return { h: 0.7, freq: 18, bob: 0.02, sh: 0.7 };
  },
  imp: g => {
    humanLegs(g, 0xa82e22, 0.11, 0.4, 0.06, 0.85, 0x1a1014);
    g.color(0xc23a2a).sph(0.24, 0, 0.62, 0, 1, 1.15, 0.9); g.color(0xe0684a).sph(0.16, 0, 0.58, 0.1, 1, 1.1, 0.7);
    g.color(0xc23a2a).sph(0.22, 0, 1.0, 0.04); g.color(0x1a1014).cone(0.06, 0.28, 4, 0.14, 1.24, 0, 0, 0, -0.45).cone(0.06, 0.28, 4, -0.14, 1.24, 0, 0, 0, 0.45);
    g.color(0xffe24a, 3).box(0.07, 0.05, 0.04, 0.08, 1.02, 0.22).box(0.07, 0.05, 0.04, -0.08, 1.02, 0.22);
    g.color(0xa82e22).limb(0, 0.5, -0.18, 0, 0.8, -0.52, 0.04, 0.025, 3); g.color(0x1a1014).cone(0.06, 0.14, 3, 0, 0.86, -0.56, -0.6);
    for (const s of [1, -1]) { g.rig(2, s * 0.1, 0.8, -0.16, s * 0.6, 0); g.color(0x5c1418).box(0.4, 0.03, 0.3, s * 0.3, 0.86, -0.2, 0.5, s * 0.3, s * 0.4); }
    g.color(0xc23a2a).rig(0, 0.26, 0.82, 0, 0.5, 0).limb(0.26, 0.82, 0, 0.3, 0.46, 0.08, 0.055, 0.045, 4);
    g.rig(0, -0.26, 0.82, 0, 0.2, PI, -0.9).limb(-0.26, 0.82, 0, -0.34, 0.98, 0.3, 0.055, 0.045, 4);
    g.color(0xff8a20, 3.2).ico(0.13, -0.36, 1.12, 0.36);
    g.norig(); return { h: 1.3, freq: 14, bob: 0.1, sh: 0.42 };
  },
  cultist: g => {
    g.color(0x5a2f7a).cyl(0.22, 0.5, 1.3, 7, 0, 0.65, 0); g.color(0xb8943a).cyl(0.51, 0.51, 0.07, 7, 0, 0.05, 0).box(0.1, 1.0, 0.04, 0, 0.75, 0.33, -0.2);
    g.color(0x4a2468).sph(0.3, 0, 1.3, 0, 1.25, 0.75, 0.95);
    g.color(0x140c1c).sph(0.17, 0, 1.52, 0.08); g.color(0x5a2f7a).cone(0.27, 0.56, 6, 0, 1.7, -0.03, -0.25);
    g.color(0xff5ae0, 3).box(0.05, 0.04, 0.03, 0.06, 1.54, 0.24).box(0.05, 0.04, 0.03, -0.06, 1.54, 0.24);
    for (const s of [1, -1]) { g.color(0x4a2468).rig(0, s * 0.36, 1.34, 0, 0.1, s > 0 ? 0 : PI, -0.95).limb(s * 0.36, 1.34, 0, s * 0.26, 1.02, 0.42, 0.11, 0.15, 5); g.color(0xcaa8b0).box(0.1, 0.1, 0.12, s * 0.24, 1.0, 0.5); }
    g.rig(0, 0, 1.34, 0, 0.1, 0, -0.95).color(0xe04aff, 3).ico(0.14, 0, 1.08, 0.56);
    g.norig(); return { h: 2.0, freq: 6, bob: 0.03, sh: 0.6 };
  },
  wraith: g => {
    g.color(0xa8e8f0, 0.45).rig(0, 0, 1.15, 0, 0.22, 0).cyl(0.36, 0.04, 1.15, 7, 0, 0.58, -0.08, 0.15);
    g.norig().sph(0.38, 0, 1.18, 0, 1.15, 0.6, 0.9);
    g.color(0xc8f4f8, 0.5).sph(0.22, 0, 1.42, 0.05); g.color(0x8fd0dc, 0.4).cone(0.26, 0.5, 6, 0, 1.58, -0.06, -0.3);
    g.color(0x0c1a20).box(0.12, 0.12, 0.05, 0, 1.33, 0.24);
    g.color(0xffffff, 4).box(0.07, 0.05, 0.04, 0.08, 1.45, 0.25).box(0.07, 0.05, 0.04, -0.08, 1.45, 0.25);
    for (const s of [1, -1]) { g.color(0xa8e8f0, 0.45).rig(0, s * 0.34, 1.2, 0, 0.2, s > 0 ? 0 : PI, -0.7).limb(s * 0.34, 1.2, 0.02, s * 0.42, 0.95, 0.62, 0.07, 0.04, 4); g.color(0xe8ffff, 1.2).cone(0.04, 0.2, 3, s * 0.42, 0.92, 0.74, PI / 2); }
    g.norig(); return { h: 1.9, fly: 0.35, freq: 4, bob: 0, sh: 0.45, alpha: 0.72, flyBob: 0.14 };
  },
  golem: g => {
    for (const s of [1, -1]) g.color(0x625c57).rig(0, s * 0.38, 0.8, 0, 0.4, s > 0 ? 0 : PI).box(0.44, 0.74, 0.5, s * 0.38, 0.37, 0);
    g.norig().color(0x6c655f).box(0.95, 0.3, 0.55, 0, 0.85, 0); g.color(0x7d756e).box(1.35, 0.95, 0.85, 0, 1.5, 0, 0.08);
    g.color(0xff7a1a, 2.8).box(0.34, 0.34, 0.05, 0, 1.52, 0.46, 0.08, 0, PI / 4); g.color(0x4a4440).box(0.9, 0.06, 0.04, 0, 1.24, 0.42, 0.08);
    for (const s of [1, -1]) {
      g.color(0x6c655f).ico(0.44, s * 0.84, 1.86, 0, 1, 0.9, 1); g.color(0x5d7a4a).sph(0.3, s * 0.84, 2.14, -0.05, 1.1, 0.35, 1.1);
      g.rig(0, s * 0.88, 1.78, 0, 0.36, s > 0 ? PI : 0, -1.7); g.color(0x7d756e).box(0.42, 1.0, 0.46, s * 0.94, 1.2, 0.05); g.color(0x8c847c).ico(0.36, s * 0.94, 0.62, 0.1);
    }
    g.norig().color(0x8c847c).box(0.46, 0.38, 0.44, 0, 2.12, 0.14); g.color(0xffa030, 3.2).box(0.32, 0.07, 0.04, 0, 2.14, 0.37);
    g.color(0x5a534e).cone(0.2, 0.5, 4, 0.3, 2.1, -0.3, -0.5).cone(0.24, 0.6, 4, -0.2, 2.15, -0.34, -0.4);
    return { h: 2.5, freq: 4.5, bob: 0.06, sh: 1.05 };
  },
  bomber: g => {
    g.color(0xffb030, 1.5).sph(0.42, 0, 0.52, -0.05, 1, 0.95, 1.1, 7, 5);
    g.color(0x3a2418).sph(0.3, 0, 0.84, -0.05, 1.15, 0.4, 1.3); g.color(0xff5a20, 2.5).cone(0.07, 0.24, 4, 0, 1.04, -0.05);
    g.color(0x4a3020).sph(0.18, 0, 0.36, 0.42); g.color(0xffffff, 2.5).box(0.05, 0.05, 0.03, 0.07, 0.42, 0.58).box(0.05, 0.05, 0.03, -0.07, 0.42, 0.58);
    g.color(0x2a1a12).cone(0.03, 0.14, 3, 0.07, 0.28, 0.6, PI / 2).cone(0.03, 0.14, 3, -0.07, 0.28, 0.6, PI / 2);
    for (const s of [1, -1]) for (let i = 0; i < 3; i++) { const z = 0.25 - i * 0.26; g.color(0x2a1a12).rig(1, s * 0.3, 0.3, z, 0.5, (i % 2 ? 0 : PI) + (s > 0 ? 0 : PI)).limb(s * 0.3, 0.32, z, s * 0.58, 0, z + 0.05, 0.05, 0.025, 3); }
    g.norig(); return { h: 1.1, freq: 20, bob: 0.03, sh: 0.6, pulse: 1 };
  },
  deathknight: g => {
    for (const s of [1, -1]) { g.color(0x2c3444).rig(0, s * 0.2, 0.85, 0, 0.55, s > 0 ? 0 : PI).box(0.25, 0.84, 0.3, s * 0.2, 0.42, 0); g.color(0x56627a).box(0.28, 0.16, 0.34, s * 0.2, 0.5, 0.02).box(0.27, 0.12, 0.42, s * 0.2, 0.06, 0.06); }
    g.norig().color(0x343e52).box(0.82, 0.78, 0.48, 0, 1.27, 0); g.color(0x56627a).box(0.52, 0.42, 0.06, 0, 1.36, 0.25).box(0.86, 0.12, 0.5, 0, 0.92, 0);
    g.color(0x40e0ff, 2.2).box(0.1, 0.3, 0.04, 0, 1.36, 0.29);
    for (const s of [1, -1]) { g.color(0x56627a).ico(0.27, s * 0.54, 1.66, 0, 1.1, 0.9, 1.1).cone(0.08, 0.34, 4, s * 0.64, 1.9, 0, 0, 0, -s * 0.6); }
    g.color(0x2c3444).box(0.36, 0.4, 0.38, 0, 1.88, 0.02); g.color(0x40e0ff, 3.4).box(0.28, 0.06, 0.04, 0, 1.9, 0.22);
    g.color(0x1a1e2a).cone(0.07, 0.42, 4, 0.2, 2.2, 0, 0, 0, -0.45).cone(0.07, 0.42, 4, -0.2, 2.2, 0, 0, 0, 0.45);
    g.color(0x6a1420).rig(0, 0, 1.6, -0.26, 0.16, 1.0).box(0.84, 1.25, 0.05, 0, 0.98, -0.34, -0.12);
    g.color(0x2c3444).rig(0, 0.52, 1.56, 0, 0.3, 0).limb(0.52, 1.56, 0, 0.58, 1.0, 0.14, 0.1, 0.09, 5); g.color(0x232a38).box(0.08, 0.86, 0.56, 0.66, 1.08, 0.2); g.color(0x40e0ff, 1.8).box(0.03, 0.3, 0.16, 0.71, 1.12, 0.2);
    g.color(0x2c3444).rig(0, -0.52, 1.56, 0, 0.22, PI, -0.7).limb(-0.52, 1.56, 0, -0.58, 1.02, 0.16, 0.1, 0.09, 5);
    g.color(0x8fa0b8).box(0.13, 0.05, 1.6, -0.58, 1.02, 0.98); g.color(0x40e0ff, 1.6).box(0.05, 0.06, 1.1, -0.58, 1.03, 1.05); g.color(0x1a1e2a).box(0.4, 0.07, 0.08, -0.58, 1.02, 0.2);
    g.norig(); return { h: 2.4, freq: 7, bob: 0.05, sh: 0.75, lean: 0.3 };
  },
  shaman: g => {
    g.color(0x2f6a66).cyl(0.26, 0.5, 1.1, 6, 0, 0.55, 0); g.color(0x1f4a48).sph(0.32, 0, 1.14, 0.08, 1.15, 0.8, 1); g.color(0x8a3a2a).box(0.7, 0.08, 0.3, 0, 1.3, 0.0, 0.3);
    g.color(BONE).sph(0.19, 0, 1.42, 0.22, 1, 0.95, 1.1).box(0.14, 0.1, 0.14, 0, 1.28, 0.3); g.color(0x6aff7a, 3.2).box(0.06, 0.06, 0.04, 0.07, 1.43, 0.41).box(0.06, 0.06, 0.04, -0.07, 1.43, 0.41);
    for (const s of [1, -1]) { g.color(BONE).limb(s * 0.1, 1.55, 0.16, s * 0.42, 1.98, 0.06, 0.04, 0.025, 4).limb(s * 0.26, 1.76, 0.11, s * 0.5, 1.72, 0.2, 0.025, 0.015, 3).limb(s * 0.36, 1.9, 0.08, s * 0.3, 2.14, 0.0, 0.025, 0.012, 3); }
    g.rig(0, -0.46, 1.0, 0.3, 0.06, 0, -0.4).color(0x4a3a2a).limb(-0.46, 0, 0.3, -0.46, 1.95, 0.3, 0.045, 0.04, 4);
    g.color(BONE).sph(0.13, -0.46, 2.0, 0.3); g.color(0x6aff7a, 3.4).ico(0.11, -0.46, 2.22, 0.3); g.color(0x8a3a2a).box(0.05, 0.3, 0.02, -0.4, 1.8, 0.3, 0, 0, 0.3).box(0.05, 0.3, 0.02, -0.52, 1.8, 0.3, 0, 0, -0.3);
    g.color(0x1f4a48).limb(-0.3, 1.22, 0.08, -0.46, 1.25, 0.3, 0.07, 0.06, 4);
    g.rig(0, 0.32, 1.22, 0.08, 0.2, PI, -1.1).limb(0.32, 1.22, 0.08, 0.36, 0.88, 0.3, 0.07, 0.06, 4);
    g.norig(); return { h: 2.3, freq: 6, bob: 0.04, sh: 0.6 };
  },
  hound: g => {
    g.color(0x33282a).box(0.42, 0.44, 0.98, 0, 0.58, 0).box(0.46, 0.5, 0.4, 0, 0.62, 0.3);
    g.color(0x3d3032).box(0.3, 0.3, 0.4, 0, 0.78, 0.66); g.color(0x2a2022).box(0.2, 0.16, 0.28, 0, 0.7, 0.92); g.color(0xf0e8d0).box(0.16, 0.04, 0.2, 0, 0.62, 0.93);
    g.color(0x2a2022).cone(0.06, 0.2, 3, 0.11, 1.0, 0.56).cone(0.06, 0.2, 3, -0.11, 1.0, 0.56);
    g.color(0xff8a20, 3.4).box(0.06, 0.05, 0.04, 0.1, 0.84, 0.86).box(0.06, 0.05, 0.04, -0.1, 0.84, 0.86);
    g.color(0xff7a20, 1.9); for (let i = 0; i < 5; i++) g.cone(0.09, 0.3 - i * 0.03, 4, 0, 0.92 - i * 0.015, 0.4 - i * 0.2, -0.5);
    for (const s of [1, -1]) {
      g.color(0x2a2022).rig(0, s * 0.17, 0.5, 0.36, 0.95, s > 0 ? 0 : 0.7).limb(s * 0.17, 0.5, 0.36, s * 0.17, 0.02, 0.4, 0.075, 0.05, 4);
      g.rig(0, s * 0.17, 0.5, -0.38, 0.95, PI + (s > 0 ? 0 : 0.7)).limb(s * 0.17, 0.5, -0.38, s * 0.17, 0.02, -0.42, 0.085, 0.05, 4);
    }
    g.norig().color(0x33282a).limb(0, 0.7, -0.48, 0, 0.98, -0.82, 0.05, 0.03, 3); g.color(0xff7a20, 2.2).ico(0.07, 0, 1.02, -0.86);
    return { h: 1.1, freq: 17, bob: 0.08, sh: 0.6, lean: 0.12, gallop: 0.1 };
  },
  frostling: g => {
    for (const s of [1, -1]) g.color(0x6aa8d8, 0.25).rig(0, s * 0.15, 0.42, 0, 0.75, s > 0 ? 0 : PI).cone(0.11, 0.44, 4, s * 0.15, 0.22, 0, PI);
    g.norig().color(0x8fd0ff, 0.4).oct(0.34, 0, 0.66, 0, 1, 1.25, 0.9); g.color(0xffffff, 3.2).ico(0.11, 0, 0.7, 0.26);
    g.color(0xa8dcff, 0.45).oct(0.22, 0, 1.12, 0.05); g.color(0xffffff, 3.4).box(0.06, 0.05, 0.04, 0.07, 1.13, 0.2).box(0.06, 0.05, 0.04, -0.07, 1.13, 0.2);
    g.color(0xd8f4ff, 0.7).cone(0.06, 0.3, 4, 0, 1.44, 0).cone(0.05, 0.24, 4, 0.13, 1.36, 0, 0, 0, -0.5).cone(0.05, 0.24, 4, -0.13, 1.36, 0, 0, 0, 0.5);
    for (const s of [1, -1]) {
      g.color(0xbfe8ff, 0.5).oct(0.14, s * 0.4, 0.98, -0.02, 0.7, 2.2, 0.7, 0, 0, -s * 0.8);
      g.rig(0, s * 0.34, 0.8, 0, 0.4, s > 0 ? PI : 0, -1.0).color(0x8fd0ff, 0.4).oct(0.12, s * 0.44, 0.58, 0.16, 0.8, 1.7, 0.8, 0.5);
    }
    g.norig(); return { h: 1.6, freq: 12, bob: 0.08, sh: 0.48 };
  },
  unknown: g => {
    g.color(0x6a5a8a).sph(0.42, 0, 0.38, 0, 1, 0.85, 1, 7, 5); g.color(0x4a3e66).cone(0.1, 0.3, 4, 0, 0.84, -0.05).cone(0.08, 0.24, 4, 0.22, 0.72, -0.1, 0, 0, -0.5).cone(0.08, 0.24, 4, -0.22, 0.72, -0.1, 0, 0, 0.5);
    g.color(0xffffff, 3).box(0.08, 0.1, 0.04, 0.12, 0.46, 0.38).box(0.08, 0.1, 0.04, -0.12, 0.46, 0.38);
    return { h: 1.0, freq: 8, bob: 0.1, sh: 0.5, pulse: 0.5 };
  }
};
const ALLY_DEFS = {
  skel: g => { buildSkeleton(g, 0x6fd8ff, true); return { h: 1.9, freq: 10, bob: 0.05, sh: 0.5 }; },
  lich: g => {
    g.color(0x1c3a34).rig(0, 0, 1.1, 0, 0.16, 0).cyl(0.34, 0.06, 1.1, 7, 0, 0.56, -0.06, 0.12);
    g.norig().color(0x24504a).sph(0.36, 0, 1.16, 0, 1.2, 0.65, 0.9); g.color(0x6affc0, 1.4).box(0.5, 0.06, 0.04, 0, 1.0, 0.3);
    g.color(BONE).sph(0.19, 0, 1.44, 0.05); g.color(0x6affc0, 3.4).box(0.06, 0.06, 0.04, 0.07, 1.46, 0.23).box(0.06, 0.06, 0.04, -0.07, 1.46, 0.23);
    g.color(0xd8b84a, 0.6); for (let i = 0; i < 5; i++) { const a = i / 5 * TAU; g.cone(0.045, 0.2, 3, Math.cos(a) * 0.15, 1.68, 0.03 + Math.sin(a) * 0.15); }
    g.rig(0, -0.4, 1.2, 0, 0.1, 0, -0.6).color(0x3a2a22).limb(-0.44, 0.5, 0.3, -0.44, 1.9, 0.3, 0.035, 0.03, 4); g.color(0x6affc0, 3.6).oct(0.13, -0.44, 2.04, 0.3, 1, 1.5, 1);
    g.color(0x1c3a34).limb(-0.36, 1.2, 0.02, -0.44, 1.18, 0.3, 0.08, 0.06, 4);
    g.rig(0, 0.36, 1.2, 0, 0.15, PI, -1.0).limb(0.36, 1.2, 0.02, 0.4, 0.95, 0.4, 0.08, 0.06, 4);
    g.norig(); return { h: 2.1, fly: 0.3, freq: 4, bob: 0, sh: 0.45, flyBob: 0.12 };
  },
  unknown: g => { g.color(0x8fd8ff, 0.8).sph(0.3, 0, 0.6, 0, 1, 1.2, 1); g.color(0xffffff, 3).box(0.06, 0.06, 0.04, 0.09, 0.68, 0.28).box(0.06, 0.06, 0.04, -0.09, 0.68, 0.28); return { h: 1.2, fly: 0.3, freq: 5, bob: 0, sh: 0.4, flyBob: 0.1 }; }
};

/* ---------------------------------------------------------------------------------------------
 * Small instanced things: projectiles, pickups, shrines
 * ------------------------------------------------------------------------------------------- */
const PROJ_DEFS = {
  // spin: rad/s about Y; tumble: rad/s about X; streak [r,g,b,len,width]; glow [r,g,b,size]; s nominal radius
  firebolt: { s: 0.35, build: g => { g.color(0xffe08a, 4).oct(0.2, 0, 0, 0.05, 0.8, 0.8, 1.6); g.color(0xff7a18, 3).oct(0.28, 0, 0, -0.08, 0.9, 0.9, 1.5); }, streak: [1.0, 0.42, 0.08, 2.0, 0.55], glow: [1.0, 0.5, 0.12, 1.5], ember: 1 },
  arrow: { s: 0.25, build: g => { g.color(0x7a5a3a).cyl(0.025, 0.025, 0.9, 4, 0, 0, 0, PI / 2); g.color(0xcfd8e0, 0.3).cone(0.07, 0.2, 4, 0, 0, 0.52, PI / 2); g.color(0x3fae6a).box(0.16, 0.02, 0.2, 0, 0, -0.4).box(0.02, 0.16, 0.2, 0, 0, -0.4); }, streak: [0.75, 0.95, 0.8, 1.3, 0.14] },
  axe: { s: 0.55, build: g => { g.color(0x6a4a2e).cyl(0.04, 0.04, 0.8, 5, 0, 0, 0, PI / 2); g.color(0xb8c2cc, 0.25).box(0.5, 0.06, 0.34, 0.2, 0, 0.26).box(0.2, 0.05, 0.5, 0.42, 0, 0.26); g.color(0xe8f0f8, 0.6).box(0.06, 0.04, 0.56, 0.52, 0, 0.26); }, spin: 15, ring: [0.8, 0.85, 0.95, 0.55] },
  bloodaxe: { s: 0.6, build: g => { g.color(0x3a1418).cyl(0.05, 0.05, 1.0, 5, 0, 0, 0, PI / 2); for (const s of [1, -1]) { g.color(0xa01828, 0.8).box(0.56, 0.07, 0.4, s * 0.24, 0, 0.3).box(0.22, 0.06, 0.62, s * 0.5, 0, 0.3); g.color(0xff4a5a, 2.6).box(0.06, 0.05, 0.68, s * 0.62, 0, 0.3); } }, spin: 18, ring: [1.0, 0.12, 0.2, 0.75], glow: [1.0, 0.1, 0.15, 1.6] },
  orb: { s: 0.42, build: g => { g.color(0x8fd0ff, 1.5).ico(0.22, 0, 0, 0, 1, 1, 1, 1); g.color(0x4aa8ff, 1.5).torus(0.3, 0.035, 4, 12, TAU, 0, 0, 0, PI / 2); }, spin: 4, streak: [0.3, 0.65, 1.0, 1.1, 0.4], glow: [0.3, 0.6, 1.0, 1.3] },
  soulorb: { s: 0.55, build: g => { g.color(0xd0a8ff, 1.7).ico(0.27, 0, 0, 0, 1, 1, 1, 1); g.color(0xa050ff, 1.8).torus(0.38, 0.04, 4, 12, TAU, 0, 0, 0, PI / 2).torus(0.38, 0.04, 4, 12, TAU, 0, 0, 0, 0, 0, 0); g.color(0x50ffc8, 2.4).oct(0.1, 0.38, 0, 0).oct(0.1, -0.38, 0, 0); }, spin: 6, streak: [0.65, 0.3, 1.0, 1.5, 0.55], glow: [0.6, 0.3, 1.0, 2.0] },
  dagger: { s: 0.22, build: g => { g.color(0xe0e8f0, 0.7).oct(0.1, 0, 0, 0.16, 0.6, 0.25, 3.4); g.color(0x3a3040).box(0.2, 0.05, 0.05, 0, 0, -0.14).box(0.05, 0.05, 0.2, 0, 0, -0.26); }, streak: [0.8, 0.9, 1.0, 1.1, 0.12] },
  flask: { s: 0.25, build: g => { g.color(0x6aff5a, 1.6).ico(0.2, 0, 0, 0, 1, 1, 1, 1); g.color(0xcfe8d8, 0.3).cyl(0.07, 0.09, 0.16, 6, 0, 0.24, 0); g.color(0x6a4a2e).cyl(0.06, 0.06, 0.07, 6, 0, 0.35, 0); }, tumble: 9, glow: [0.3, 1.0, 0.25, 1.0] },
  spirit: { s: 0.35, build: g => { g.color(0xc8fff0, 2.2).sph(0.24, 0, 0, 0.08, 1, 1, 1.15); g.color(0x7ae8d0, 1.2).cone(0.22, 0.6, 6, 0, 0, -0.34, -PI / 2); g.color(0x0c2a2a).box(0.07, 0.08, 0.04, 0.09, 0.03, 0.31).box(0.07, 0.08, 0.04, -0.09, 0.03, 0.31).box(0.08, 0.06, 0.04, 0, -0.1, 0.3); }, streak: [0.35, 1.0, 0.8, 1.9, 0.45], glow: [0.3, 1.0, 0.8, 1.5], wisp: 1 },
  reaper: { s: 0.9, build: g => { g.color(0x2a2030).cyl(0.045, 0.045, 1.5, 5, 0, 0, 0, PI / 2); g.color(0x1a1420).torus(0.6, 0.07, 4, 10, 1.9, 0, 0, 0.15, PI / 2, 0, 0.6); g.color(0xc87aff, 3).torus(0.66, 0.035, 3, 10, 1.9, 0, 0, 0.15, PI / 2, 0, 0.6); }, spin: 13, ring: [0.7, 0.3, 1.0, 1.0], glow: [0.6, 0.2, 1.0, 2.2] },
  e_fireball: { s: 0.38, build: g => { g.color(0x2a0806).ico(0.2, 0, 0, 0, 1, 1, 1, 1); g.color(0xff3a14, 3.2).ico(0.27, 0, 0, 0, 1, 1, 1, 0); }, spin: 8, streak: [1.0, 0.16, 0.05, 1.5, 0.5], glow: [1.0, 0.15, 0.05, 1.8], hostile: 1 },
  e_bolt: { s: 0.3, build: g => { g.color(0xf0b0ff, 3.4).oct(0.16, 0, 0, 0, 0.8, 0.8, 2.6); g.color(0x8a20c0, 1.5).oct(0.24, 0, 0, -0.1, 1, 1, 1.4); }, streak: [0.75, 0.2, 1.0, 1.4, 0.4], glow: [0.7, 0.15, 1.0, 1.6], hostile: 1 },
  e_web: { s: 0.3, build: g => { g.color(0xe8f0e0, 0.4).ico(0.26, 0, 0, 0, 1, 0.8, 1, 1); g.color(0xdfe8d8, 0.5); for (let i = 0; i < 5; i++) { const a = i / 5 * TAU; g.limb(0, 0, 0, Math.cos(a) * 0.42, 0, Math.sin(a) * 0.42, 0.025, 0.01, 3); } }, spin: 5, streak: [0.9, 1.0, 0.85, 1.0, 0.3], glow: [0.8, 1.0, 0.7, 1.2], hostile: 1 },
  e_bone: { s: 0.3, build: g => { g.color(0xe8e0c4, 0.35).cyl(0.05, 0.05, 0.6, 5, 0, 0, 0, PI / 2).sph(0.09, 0.05, 0, 0.3).sph(0.09, -0.05, 0, 0.3).sph(0.09, 0.05, 0, -0.3).sph(0.09, -0.05, 0, -0.3); }, spin: 14, glow: [1.0, 0.3, 0.2, 1.1], hostile: 1 },
  e_frost: { s: 0.3, build: g => { g.color(0xe8f8ff, 2.6).oct(0.15, 0, 0, 0.08, 0.8, 0.8, 3.0); g.color(0x5ab8ff, 1.2).oct(0.11, 0.14, 0, -0.1, 0.7, 0.7, 2.2).oct(0.11, -0.14, 0, -0.1, 0.7, 0.7, 2.2); }, streak: [0.4, 0.8, 1.0, 1.5, 0.36], glow: [0.35, 0.75, 1.0, 1.5], hostile: 1 },
  unknown: { s: 0.3, build: g => { g.color(0xffffff, 2.6).ico(0.2, 0, 0, 0, 1, 1, 1, 1); }, streak: [0.9, 0.9, 1.0, 1.0, 0.3], glow: [0.9, 0.9, 1.0, 1.2] }
};
const PICKUP_DEFS = {
  xp_s: { build: g => { g.color(0x4aa8ff, 1.3).oct(0.17, 0, 0, 0, 0.8, 1.35, 0.8); }, glow: [0.25, 0.6, 1.0, 0.75], y: 0.4, spin: 2.2 },
  xp_m: { build: g => { g.color(0x4affa0, 1.4).oct(0.22, 0, 0, 0, 0.8, 1.35, 0.8); g.color(0xd8ffe8, 2).oct(0.09, 0, 0, 0, 1, 2.6, 1); }, glow: [0.25, 1.0, 0.55, 0.95], y: 0.45, spin: 2.6 },
  xp_l: { build: g => { g.color(0xff4a5a, 1.5).oct(0.28, 0, 0, 0, 0.8, 1.35, 0.8); g.color(0xffe0d0, 2.4).oct(0.12, 0, 0, 0, 1, 2.6, 1); g.color(0xff9a7a, 1.2).torus(0.34, 0.025, 3, 10, TAU, 0, 0, 0, PI / 2); }, glow: [1.0, 0.25, 0.3, 1.3], y: 0.5, spin: 3 },
  gold: { build: g => { g.color(0xffc83a, 0.9).cyl(0.2, 0.2, 0.06, 10, 0, 0, 0, PI / 2); g.color(0xfff0a0, 1.6).cyl(0.12, 0.12, 0.075, 6, 0, 0, 0, PI / 2); }, glow: [1.0, 0.75, 0.2, 0.7], y: 0.35, spin: 4.5 },
  heart: { build: g => { g.color(0xff3a4a, 1.2).sph(0.17, 0.12, 0.1, 0).sph(0.17, -0.12, 0.1, 0).cone(0.28, 0.36, 4, 0, -0.14, 0, PI, PI / 4, 0); g.color(0xffb0b8, 2).box(0.05, 0.08, 0.04, 0.16, 0.16, 0.14); }, glow: [1.0, 0.2, 0.3, 1.3], y: 0.55, spin: 0, tilt: -0.75, sc: 1.25 },
  magnet: { build: g => { g.color(0xd83a3a, 0.5).torus(0.22, 0.075, 5, 8, PI, 0, 0, 0, 0, 0, 0).box(0.15, 0.2, 0.15, 0.22, -0.1, 0).box(0.15, 0.2, 0.15, -0.22, -0.1, 0); g.color(0xf0f4ff, 1.4).box(0.16, 0.1, 0.16, 0.22, -0.24, 0).box(0.16, 0.1, 0.16, -0.22, -0.24, 0); }, glow: [0.5, 0.7, 1.0, 1.3], y: 0.6, spin: 0, tilt: -0.75, sc: 1.2 },
  bomb: { build: g => { g.color(0x23232c).sph(0.26, 0, 0, 0, 1, 1, 1, 7, 5); g.color(0x8a8a96).cyl(0.07, 0.07, 0.1, 6, 0, 0.27, 0); g.color(0x8a6a3a).limb(0, 0.3, 0, 0.1, 0.46, 0, 0.02, 0.02, 3); g.color(0xffd84a, 4).ico(0.06, 0.11, 0.49, 0); }, glow: [1.0, 0.6, 0.2, 1.2], y: 0.5, spin: 1.2 },
  unknown: { s: 0.3, build: g => { g.color(0xffffff, 1.6).oct(0.2, 0, 0, 0); }, glow: [1, 1, 1, 0.8], y: 0.45, spin: 2 }
};
function buildChest(lid) {
  const g = GB();
  if (!lid) { g.color(0x6a3e1e).box(0.9, 0.42, 0.6, 0, 0.21, 0); g.color(0xe0b040, 0.5).box(0.94, 0.07, 0.64, 0, 0.42, 0).box(0.08, 0.44, 0.63, 0.34, 0.22, 0).box(0.08, 0.44, 0.63, -0.34, 0.22, 0); g.color(0xfff0a0, 2.2).box(0.8, 0.02, 0.5, 0, 0.44, 0); }
  else { g.color(0x7a4a26).cyl(0.3, 0.3, 0.9, 8, 0, 0.0, 0.3, 0, 0, PI / 2); g.color(0xe0b040, 0.5).cyl(0.315, 0.315, 0.08, 8, 0.34, 0, 0.3, 0, 0, PI / 2).cyl(0.315, 0.315, 0.08, 8, -0.34, 0, 0.3, 0, 0, PI / 2); g.color(0xfff0a0, 1.6).box(0.14, 0.16, 0.05, 0, -0.04, 0.61); }
  return g.build();
}
function buildShrine() {
  const g = GB();
  g.color(0x4c5058).cyl(0.9, 1.05, 0.22, 8, 0, 0.11, 0).cyl(0.65, 0.75, 0.2, 8, 0, 0.32, 0);
  g.color(0x6a6e78).box(0.5, 1.7, 0.36, 0, 1.25, 0).cone(0.36, 0.5, 4, 0, 2.34, 0, 0, PI / 4, 0);
  g.color(0xffffff, 1).box(0.26, 0.5, 0.04, 0, 1.5, 0.19).box(0.26, 0.5, 0.04, 0, 1.5, -0.19).oct(0.13, 0, 2.72, 0, 1, 1.5, 1);   // rune panel + crystal: white, tinted per instance
  return g.build();
}
const SHRINE_COL = { shrine_power: [1.0, 0.25, 0.2], shrine_haste: [1.0, 0.85, 0.25], shrine_guard: [0.3, 0.6, 1.0], shrine_fortune: [0.35, 1.0, 0.5] };

/* ---------------------------------------------------------------------------------------------
 * Heroes: small Object3D rigs (hips / torso / head / 2 arms / 2 legs / cape), animated procedurally.
 * Model front = +Z, the character's right hand is at -X.
 * ------------------------------------------------------------------------------------------- */
const SKIN = 0xe2b48c;
const HERO_DEFS = {
  knight: {
    accent: [0.45, 0.7, 1.0], hip: 0.78, sh: 0.44, shY: 0.6, neck: 0.74, legX: 0.16, atk: 'slash',
    leg: (g, s) => { g.color(0x8f9bb0).box(0.22, 0.5, 0.26, 0, -0.26, 0); g.color(0xc6d0e0).box(0.25, 0.14, 0.3, 0, -0.42, 0.01); g.color(0x5e6a80).box(0.24, 0.3, 0.28, 0, -0.62, 0).box(0.24, 0.12, 0.4, 0, -0.72, 0.06); },
    torso: g => { g.color(0x94a1b8).box(0.7, 0.62, 0.44, 0, 0.36, 0); g.color(0x2f5fc0).box(0.4, 0.86, 0.05, 0, 0.2, 0.23); g.color(0xf0c84a, 0.5).box(0.12, 0.34, 0.03, 0, 0.42, 0.26).box(0.3, 0.1, 0.03, 0, 0.48, 0.26); g.color(0x6a4a2e).box(0.74, 0.1, 0.47, 0, 0.06, 0);
      for (const s of [1, -1]) { g.color(0xaab6ca).sph(0.25, s * 0.44, 0.66, 0, 1.1, 0.8, 1.1); g.color(0xf0c84a, 0.4).box(0.3, 0.05, 0.42, s * 0.44, 0.58, 0); } },
    head: g => { g.color(0x9facc2).sph(0.27, 0, 0.24, 0, 1, 1.05, 1.05, 7, 5); g.color(0x161a24).box(0.3, 0.06, 0.06, 0, 0.26, 0.26).box(0.05, 0.2, 0.06, 0, 0.18, 0.27); g.color(0xf0c84a, 0.4).box(0.5, 0.05, 0.5, 0, 0.36, 0, 0, PI / 4, 0);
      g.color(0xe03a3a, 0.7).box(0.08, 0.26, 0.5, 0, 0.58, -0.08, -0.25).box(0.07, 0.2, 0.3, 0, 0.5, -0.36, -0.9); },
    armL: g => { g.color(0x8f9bb0).limb(0, 0, 0, 0.04, -0.52, 0.06, 0.11, 0.1, 6); g.color(0x2f5fc0).box(0.09, 0.95, 0.68, 0.17, -0.38, 0.16); g.color(0xc6d0e0).box(0.1, 1.0, 0.08, 0.175, -0.38, 0.52).box(0.1, 1.0, 0.08, 0.175, -0.38, -0.2).box(0.1, 0.08, 0.7, 0.175, 0.1, 0.16).box(0.1, 0.08, 0.7, 0.175, -0.86, 0.16);
      g.color(0xf0c84a, 0.7).box(0.04, 0.6, 0.12, 0.225, -0.36, 0.16).box(0.04, 0.12, 0.44, 0.225, -0.26, 0.16); },
    armR: g => { g.color(0x8f9bb0).limb(0, 0, 0, -0.04, -0.52, 0.06, 0.11, 0.1, 6); g.color(0x5e6a80).box(0.16, 0.14, 0.18, -0.04, -0.56, 0.08);
      g.color(0x6a4a2e).box(0.06, 0.06, 0.26, -0.04, -0.56, 0.1); g.color(0xf0c84a, 0.5).box(0.36, 0.07, 0.07, -0.04, -0.56, 0.26); g.color(0xd0dcf0, 0.3).box(0.11, 0.035, 1.15, -0.04, -0.56, 0.86); g.color(0xffffff, 0.7).box(0.03, 0.045, 1.0, -0.04, -0.56, 0.84); },
    back: g => { g.color(0x2f5fc0).box(0.68, 1.0, 0.05, 0, -0.5, -0.04); g.color(0xf0c84a, 0.4).box(0.7, 0.07, 0.06, 0, -0.98, -0.04); }
  },
  mage: {
    accent: [1.0, 0.55, 0.2], hip: 0.72, sh: 0.36, shY: 0.52, neck: 0.66, legX: 0.12, atk: 'cast',
    leg: g => { g.color(0x3a2a66).box(0.2, 0.6, 0.22, 0, -0.3, 0); g.color(0x2a1c40).box(0.2, 0.12, 0.32, 0, -0.66, 0.05); },
    torso: g => { g.color(0x5a3fb0).cyl(0.24, 0.5, 0.8, 8, 0, -0.26, 0); g.color(0x6a4cc8).cyl(0.26, 0.3, 0.62, 8, 0, 0.36, 0); g.color(0xf0c84a, 0.6).cyl(0.31, 0.31, 0.09, 8, 0, 0.08, 0).cyl(0.51, 0.51, 0.06, 8, 0, -0.64, 0).box(0.1, 0.6, 0.04, 0, 0.36, 0.27);
      g.color(0x7a5cd8).sph(0.2, 0.34, 0.56, 0, 1, 0.7, 1).sph(0.2, -0.34, 0.56, 0, 1, 0.7, 1); },
    head: g => { g.color(SKIN).sph(0.22, 0, 0.2, 0.02); g.color(0xe8e0f8).box(0.3, 0.2, 0.1, 0, 0.1, -0.18).sph(0.14, 0, 0.04, 0.16, 1, 1.4, 0.6);
      g.color(0x4a30a0).cyl(0.56, 0.6, 0.06, 10, 0, 0.36, 0); g.color(0x5a3fb0).cone(0.32, 0.5, 8, 0, 0.62, 0).cone(0.16, 0.42, 6, 0, 0.98, -0.12, -0.7); g.color(0xf0c84a, 0.7).cyl(0.33, 0.33, 0.08, 8, 0, 0.42, 0); g.color(0xffa030, 3).oct(0.07, 0, 1.12, -0.3); },
    armL: g => { g.color(0x6a4cc8).limb(0, 0, 0, 0.06, -0.46, 0.12, 0.1, 0.15, 6); g.color(SKIN).box(0.12, 0.12, 0.12, 0.07, -0.52, 0.15); g.color(0xffb040, 3.2).ico(0.1, 0.08, -0.5, 0.32); },
    armR: g => { g.color(0x6a4cc8).limb(0, 0, 0, -0.06, -0.46, 0.12, 0.1, 0.15, 6); g.color(SKIN).box(0.12, 0.12, 0.12, -0.07, -0.52, 0.15);
      g.color(0x6a4a2e).limb(-0.08, -1.2, 0.2, -0.08, 0.72, 0.2, 0.04, 0.035, 5); g.color(0xf0c84a, 0.6).torus(0.14, 0.03, 4, 8, PI * 1.4, -0.08, 0.86, 0.2, 0, 0, -PI * 0.2); g.color(0xffa030, 3.4).oct(0.13, -0.08, 0.9, 0.2, 1, 1.6, 1); },
    back: g => { g.color(0x4a30a0).box(0.6, 0.7, 0.05, 0, -0.35, -0.08); }
  },
  ranger: {
    accent: [0.35, 1.0, 0.6], hip: 0.8, sh: 0.36, shY: 0.56, neck: 0.68, legX: 0.14, atk: 'shoot',
    leg: g => { g.color(0x4a3a2c).limb(0, 0, 0, 0, -0.5, 0, 0.11, 0.09, 6); g.color(0x2e2a26).box(0.2, 0.34, 0.24, 0, -0.62, 0).box(0.2, 0.1, 0.36, 0, -0.75, 0.06); },
    torso: g => { g.color(0x6a4a2e).box(0.56, 0.6, 0.36, 0, 0.36, 0); g.color(0x2f6a4a).box(0.6, 0.2, 0.4, 0, 0.6, 0).cyl(0.34, 0.4, 0.3, 7, 0, -0.06, 0); g.color(0x2a2420).box(0.6, 0.08, 0.4, 0, 0.1, 0).box(0.1, 0.7, 0.42, 0.1, 0.36, 0, 0, 0, 0.7); g.color(0x5affa0, 1.6).oct(0.06, 0, 0.5, 0.2); },
    head: g => { g.color(0x16201c).sph(0.19, 0, 0.2, 0.05); g.color(0x2f6a4a).sph(0.27, 0, 0.24, -0.03, 1, 1, 1.05, 7, 5).cone(0.2, 0.5, 6, 0, 0.36, -0.28, -1.15); g.color(0x16201c).box(0.3, 0.2, 0.1, 0, 0.18, 0.2); g.color(0x5affa0, 3.4).box(0.07, 0.04, 0.04, 0.08, 0.22, 0.25).box(0.07, 0.04, 0.04, -0.08, 0.22, 0.25); },
    armL: g => { g.color(0x2f6a4a).limb(0, 0, 0, 0.04, -0.3, 0.1, 0.1, 0.09, 6); g.color(0x4a3a2c).limb(0.04, -0.3, 0.1, 0.02, -0.34, 0.5, 0.08, 0.07, 5);
      g.color(0x7a5230).torus(0.62, 0.04, 4, 12, 2.3, 0.02, -0.34, 0.08, PI / 2, 0, PI / 2 - 1.15); g.color(0x5affa0, 2).limb(0.02 - 0.565, -0.34, 0.335, 0.02 + 0.565, -0.34, 0.335, 0.012, 0.012, 3); },
    armR: g => { g.color(0x2f6a4a).limb(0, 0, 0, -0.06, -0.3, 0.02, 0.1, 0.09, 6); g.color(0x4a3a2c).limb(-0.06, -0.3, 0.02, 0.0, -0.34, 0.3, 0.08, 0.07, 5); g.color(0xcfd8e0, 0.4).limb(0.0, -0.34, 0.3, 0.3, -0.34, 0.95, 0.018, 0.018, 3); },
    back: g => { g.color(0x25563c).box(0.62, 1.05, 0.05, 0, -0.52, -0.06); g.color(0x6a4a2e).cyl(0.11, 0.09, 0.6, 6, 0.14, -0.2, -0.14, 0, 0, -0.5); g.color(0xe8f0e0, 0.5).box(0.14, 0.14, 0.04, 0.32, 0.12, -0.14, 0, 0, -0.5).box(0.04, 0.14, 0.14, 0.26, 0.1, -0.14, 0, 0, -0.5); }
  },
  necro: {
    accent: [0.4, 1.0, 0.6], hip: 0.74, sh: 0.38, shY: 0.54, neck: 0.68, legX: 0.12, atk: 'raise',
    leg: g => { g.color(0x1c1626).box(0.2, 0.62, 0.22, 0, -0.31, 0); g.color(0x120e18).box(0.2, 0.12, 0.32, 0, -0.68, 0.05); },
    torso: g => { g.color(0x2c2238).cyl(0.26, 0.52, 0.84, 8, 0, -0.28, 0); g.color(0x362a46).cyl(0.28, 0.32, 0.62, 8, 0, 0.36, 0); g.color(0x5aff9a, 0.8).cyl(0.53, 0.53, 0.05, 8, 0, -0.66, 0).box(0.07, 0.9, 0.04, 0, 0.1, 0.3);
      g.color(BONE).box(0.42, 0.06, 0.06, 0, 0.5, 0.28).box(0.36, 0.06, 0.06, 0, 0.38, 0.29).box(0.3, 0.06, 0.06, 0, 0.26, 0.3);
      for (const s of [1, -1]) { g.color(BONE).sph(0.19, s * 0.38, 0.6, 0, 1.1, 0.8, 1.1).cone(0.07, 0.34, 4, s * 0.48, 0.8, 0, 0, 0, -s * 0.7); } },
    head: g => { g.color(0x1c1626).sph(0.26, 0, 0.22, -0.05, 1, 1, 1.05, 7, 5).cone(0.2, 0.44, 6, 0, 0.36, -0.26, -1.0); g.color(0xe8e2cc).sph(0.2, 0, 0.2, 0.08, 1, 1.05, 1).box(0.16, 0.12, 0.12, 0, 0.04, 0.18);
      g.color(0x5aff9a, 3.6).box(0.08, 0.07, 0.04, 0.08, 0.22, 0.27).box(0.08, 0.07, 0.04, -0.08, 0.22, 0.27); g.color(0xbfb89c).cone(0.06, 0.3, 4, 0.2, 0.46, 0.02, 0.3, 0, -0.6).cone(0.06, 0.3, 4, -0.2, 0.46, 0.02, 0.3, 0, 0.6); },
    armL: g => { g.color(0x362a46).limb(0, 0, 0, 0.06, -0.46, 0.14, 0.1, 0.15, 6); g.color(BONE).box(0.1, 0.12, 0.12, 0.07, -0.52, 0.18); g.color(0x5aff9a, 3.2).ico(0.11, 0.08, -0.48, 0.36); },
    armR: g => { g.color(0x362a46).limb(0, 0, 0, -0.06, -0.46, 0.12, 0.1, 0.15, 6); g.color(BONE).box(0.1, 0.12, 0.12, -0.07, -0.52, 0.15);
      g.color(0x2a2030).limb(-0.08, -1.22, 0.2, -0.08, 0.95, 0.2, 0.042, 0.036, 5); g.color(0x8a90a0, 0.3).torus(0.5, 0.06, 4, 10, 1.7, -0.08, 0.5, 0.2, 0, -PI / 2, 0.15); g.color(0x5aff9a, 2.6).torus(0.56, 0.028, 3, 10, 1.7, -0.08, 0.5, 0.2, 0, -PI / 2, 0.15); g.color(BONE).sph(0.09, -0.08, 0.98, 0.2); },
    back: g => { g.color(0x241a30).box(0.3, 1.0, 0.05, 0.2, -0.5, -0.06, 0, 0, 0.06).box(0.3, 0.86, 0.05, -0.2, -0.43, -0.06, 0, 0, -0.06).box(0.24, 1.1, 0.05, 0, -0.55, -0.08); }
  },
  berserker: {
    accent: [1.0, 0.35, 0.2], hip: 0.8, sh: 0.5, shY: 0.6, neck: 0.72, legX: 0.18, atk: 'chop',
    leg: g => { g.color(0xc88a5a).limb(0, 0, 0, 0, -0.44, 0, 0.14, 0.11, 6); g.color(0x5a4636).box(0.26, 0.36, 0.28, 0, -0.6, 0).box(0.26, 0.1, 0.4, 0, -0.75, 0.06); g.color(0x8a7a66).box(0.28, 0.08, 0.3, 0, -0.44, 0); },
    torso: g => { g.color(0xc88a5a).box(0.78, 0.66, 0.44, 0, 0.38, 0); g.color(0x3a2c22).box(0.1, 0.8, 0.46, 0.12, 0.38, 0, 0, 0, 0.75).box(0.1, 0.8, 0.46, -0.12, 0.38, 0, 0, 0, -0.75); g.color(0xb02a1c, 0.5).box(0.2, 0.06, 0.03, 0.2, 0.5, 0.23, 0, 0, 0.4).box(0.2, 0.06, 0.03, -0.2, 0.5, 0.23, 0, 0, -0.4);
      g.color(0x6a5a48).cyl(0.42, 0.5, 0.36, 7, 0, -0.06, 0); g.color(0x3a2c22).box(0.84, 0.1, 0.48, 0, 0.1, 0); g.color(0xe0b040, 0.6).box(0.18, 0.14, 0.04, 0, 0.1, 0.25);
      for (const s of [1, -1]) { g.color(0x8a7a66).ico(0.26, s * 0.46, 0.72, -0.04, 1.2, 0.8, 1.2).ico(0.2, s * 0.3, 0.76, -0.2); } g.color(0x7a6a58).ico(0.24, 0, 0.72, -0.24, 1.6, 0.8, 1); },
    head: g => { g.color(0xc88a5a).sph(0.23, 0, 0.2, 0.02); g.color(0xd8401c, 0.45).box(0.26, 0.24, 0.12, 0, 0.04, 0.17).box(0.1, 0.2, 0.5, 0, 0.44, -0.04, -0.2).box(0.09, 0.16, 0.3, 0, 0.34, -0.3, -0.9); g.color(0x4a4e58).cyl(0.245, 0.245, 0.08, 8, 0, 0.3, 0);
      g.color(0xe8e0c8).limb(0.22, 0.3, 0, 0.42, 0.52, 0.06, 0.07, 0.02, 4).limb(-0.22, 0.3, 0, -0.42, 0.52, 0.06, 0.07, 0.02, 4); g.color(0x161010).box(0.07, 0.04, 0.04, 0.09, 0.23, 0.22).box(0.07, 0.04, 0.04, -0.09, 0.23, 0.22); },
    armL: g => berserkArm(g, 1), armR: g => berserkArm(g, -1),
    back: g => { g.color(0x6a5a48).box(0.7, 0.6, 0.06, 0, -0.3, -0.08); g.color(0x8a7a66).box(0.5, 0.3, 0.07, 0, -0.66, -0.08); }
  }
};
function berserkArm(g, s) {
  g.color(0xc88a5a).limb(0, 0, 0, s * 0.05, -0.34, 0.04, 0.15, 0.13, 6).limb(s * 0.05, -0.34, 0.04, s * 0.06, -0.62, 0.2, 0.12, 0.11, 6); g.color(0x3a2c22).box(0.27, 0.16, 0.27, s * 0.055, -0.5, 0.13, 0.5);
  g.color(0x6a4a2e).limb(s * 0.07, -0.66, -0.06, s * 0.07, -0.6, 0.85, 0.04, 0.04, 5);
  g.color(0xb8c2cc, 0.3).box(0.05, 0.5, 0.36, s * 0.07, -0.56, 0.72).box(0.05, 0.66, 0.16, s * 0.07, -0.56, 0.6); g.color(0xff5a3a, 1.8).box(0.03, 0.56, 0.05, s * 0.07, -0.56, 0.92);
}
function makeHeroRig(id, mat, xray) {
  const d = HERO_DEFS[id] || HERO_DEFS.knight;
  const root = new THREE.Group(), geos = [];
  const mk = (fn, parent, x, y, z, arg) => { const g = GB(); fn(g, arg); const geo = g.build(); geos.push(geo); const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = true; m.renderOrder = 2; parent.add(m); if (xray) { const xm = new THREE.Mesh(geo, xray); xm.renderOrder = 9; xm.userData.xray = true; m.add(xm); } return m; };
  const hips = new THREE.Group(); hips.position.y = d.hip; root.add(hips);
  const torso = mk(d.torso, hips, 0, 0, 0);
  const head = mk(d.head, torso, 0, d.neck, 0);
  const armL = mk(d.armL, torso, d.sh, d.shY, 0), armR = mk(d.armR, torso, -d.sh, d.shY, 0);
  const back = d.back ? mk(d.back, torso, 0, d.shY + 0.06, -0.2) : null;
  const legL = mk(d.leg, root, d.legX, d.hip, 0, 1), legR = mk(d.leg, root, -d.legX, d.hip, 0, -1);
  const rig = { id, def: d, root, hips, torso, head, armL, armR, legL, legR, back, geos, phase: 0, atk: 0, atkSide: 1, run: 0, deathT: 0, ghostGeo: null };
  // merged running-pose silhouette for dash after-images
  legL.rotation.x = -0.7; legR.rotation.x = 0.6; hips.rotation.x = 0.45; armL.rotation.x = 0.6; armR.rotation.x = -0.5;
  root.updateMatrixWorld(true);
  const gb = GB(); root.traverse(o => { if (o.isMesh && !o.userData.xray) gb.merge(o.geometry, o.matrixWorld); });
  rig.ghostGeo = gb.build();
  legL.rotation.x = legR.rotation.x = hips.rotation.x = armL.rotation.x = armR.rotation.x = 0;
  return rig;
}
/* st: {speed, moving, dash (0..1 or 0), t, dt, dead (0..1), idleOnly} */
function animateHero(rig, st) {
  const { hips, torso, head, armL, armR, legL, legR, back, def } = rig, dt = st.dt, t = st.t;
  const k = 1 - Math.exp(-dt * 14);
  const run = st.moving ? sat(st.speed / 3.2) : 0;
  rig.run += (run - rig.run) * k;
  rig.phase += dt * (5.5 + st.speed * 1.25) * (0.25 + rig.run);
  const r = rig.run, s = Math.sin(rig.phase), c = Math.cos(rig.phase), dash = st.dash > 0 ? 1 : 0;
  const breathe = Math.sin(t * 2.1);
  let lL = s * 0.85 * r, lR = -s * 0.85 * r, aL = -s * 0.6 * r + 0.06 * breathe * (1 - r), aR = s * 0.5 * r - 0.06 * breathe * (1 - r);
  let lean = 0.14 * r, twist = 0, aLz = 0.08, aRz = -0.08, headX = 0;
  let bobY = Math.abs(c) * 0.07 * r + breathe * 0.012 * (1 - r);
  if (dash) { lean = 0.62; lL = -0.9; lR = 0.7; aL = 0.9; aR = 0.9; bobY = -0.08; headX = -0.3; }
  rig.atk = Math.max(0, rig.atk - dt / 0.3);
  if (rig.atk > 0 && !dash) {
    const a = rig.atk, sw = Math.sin((1 - a) * PI), wind = a * a;
    switch (def.atk) {
      case 'slash': aR = lerp(aR, -2.3 * wind + 0.5 * (1 - a), 0.95); aRz = -0.2 - sw * 0.9; twist = (a - 0.5) * 1.3 * rig.atkSide; break;
      case 'cast': aR = lerp(aR, -1.15 - sw * 0.5, 0.9); aL = lerp(aL, -0.8 * sw, 0.8); lean -= 0.08 * sw; break;
      case 'shoot': aL = lerp(aL, -1.45, 0.95); aR = lerp(aR, -1.3 + 0.8 * a, 0.95); twist = 0.25 * sw; break;
      case 'raise': aR = lerp(aR, -1.5 * sw - 0.3, 0.9); aL = lerp(aL, -1.9 * sw, 0.9); lean -= 0.15 * sw; headX = -0.2 * sw; break;
      default: if (rig.atkSide > 0) aR = lerp(aR, -2.4 * wind + 0.7 * (1 - a), 0.95); else aL = lerp(aL, -2.4 * wind + 0.7 * (1 - a), 0.95); twist = (a - 0.5) * 0.9 * rig.atkSide;
    }
  }
  legL.rotation.x += (lL - legL.rotation.x) * k * 1.4; legR.rotation.x += (lR - legR.rotation.x) * k * 1.4;
  armL.rotation.x += (aL - armL.rotation.x) * k * 1.6; armR.rotation.x += (aR - armR.rotation.x) * k * 1.6;
  armL.rotation.z += (aLz - armL.rotation.z) * k; armR.rotation.z += (aRz - armR.rotation.z) * k;
  hips.rotation.x += (lean - hips.rotation.x) * k; torso.rotation.y += (twist - torso.rotation.y) * k * 1.5;
  hips.position.y = def.hip + bobY; torso.scale.y = 1 + breathe * 0.015 * (1 - r);
  head.rotation.x += (headX - head.rotation.x) * k; head.rotation.y = Math.sin(t * 0.7) * 0.12 * (1 - r) - torso.rotation.y * 0.6;
  if (back) back.rotation.x = 0.12 + r * 0.55 + dash * 0.5 + Math.sin(t * 5 + 1) * 0.06 * (0.3 + r);
}

/* ---------------------------------------------------------------------------------------------
 * Bosses: unique articulated rigs. animate(rig, anim, animT, t, dt, moving)
 * ------------------------------------------------------------------------------------------- */
function bossNode(rig, parent, x, y, z, fn) {
  let o;
  if (fn) { const g = GB(); fn(g); const geo = g.build(); rig.geos.push(geo); o = new THREE.Mesh(geo, rig.mat); o.castShadow = true; } else o = new THREE.Group();
  o.position.set(x, y, z); parent.add(o); return o;
}
const BOSS_DEFS = {
  boss_bonelord: {
    h: 2.5, sh: 0.9, col: [0.7, 0.35, 1.0],
    build(rig) {
      const N = (p, x, y, z, fn) => bossNode(rig, p, x, y, z, fn), root = rig.root, n = rig.n;
      const leg = g => { g.color(BONE).limb(0, 0, 0, 0, -0.5, 0.04, 0.085, 0.07, 6).limb(0, -0.5, 0.04, 0, -0.98, 0, 0.07, 0.06, 6).sph(0.1, 0, -0.5, 0.05); g.color(0x3a3440).box(0.2, 0.3, 0.24, 0, -0.84, 0).box(0.2, 0.1, 0.38, 0, -0.97, 0.07); };
      n.legL = N(root, 0.2, 1.02, 0, leg); n.legR = N(root, -0.2, 1.02, 0, leg);
      n.hips = N(root, 0, 1.02, 0, g => { g.color(BONE).box(0.52, 0.18, 0.26, 0, 0, 0); g.color(0x5a1420).box(0.36, 0.5, 0.04, 0, -0.3, 0.14).box(0.4, 0.44, 0.04, 0, -0.26, -0.14); g.color(0xd8b84a, 0.6).box(0.56, 0.07, 0.3, 0, 0.08, 0); });
      n.torso = N(n.hips, 0, 0.1, 0, g => { g.color(BONE).cyl(0.06, 0.07, 0.86, 5, 0, 0.42, -0.04);
        g.color(BONE_D); for (let i = 0; i < 4; i++) g.box(0.62 - i * 0.05, 0.085, 0.36 - i * 0.02, 0, 0.78 - i * 0.14, 0);
        g.color(0xb060ff, 3).ico(0.14, 0, 0.56, 0); g.color(BONE).box(0.9, 0.12, 0.24, 0, 0.9, 0);
        g.color(0x3a3440).ico(0.28, 0.5, 0.96, 0, 1.2, 0.8, 1.1).cone(0.08, 0.4, 4, 0.6, 1.2, 0, 0, 0, -0.6).cone(0.07, 0.3, 4, 0.42, 1.22, -0.1, -0.3, 0, -0.1); g.color(BONE).sph(0.15, -0.5, 0.92, 0); });
      n.head = N(n.torso, 0, 1.02, 0, g => { g.color(0xe8e2cc).sph(0.27, 0, 0.22, 0.03, 1, 1, 1.08, 7, 5).box(0.26, 0.14, 0.24, 0, 0.0, 0.09); g.color(0x1a1420).box(0.2, 0.03, 0.2, 0, -0.01, 0.12);
        g.color(0xc070ff, 3.6).box(0.09, 0.08, 0.05, 0.1, 0.24, 0.27).box(0.09, 0.08, 0.05, -0.1, 0.24, 0.27);
        g.color(0xe8c040, 1.0).cyl(0.26, 0.24, 0.1, 8, 0, 0.42, 0); for (let i = 0; i < 6; i++) { const a = i / 6 * TAU; g.cone(0.055, 0.24, 4, Math.cos(a) * 0.23, 0.56, Math.sin(a) * 0.23); } g.color(0xff4a6a, 2.6).oct(0.05, 0, 0.44, 0.26); });
      n.cape = N(n.torso, 0, 0.92, -0.2, g => { g.color(0x5a1420).box(0.34, 1.5, 0.05, 0.3, -0.75, 0, 0, 0, 0.05).box(0.34, 1.3, 0.05, -0.3, -0.65, 0, 0, 0, -0.05).box(0.3, 1.62, 0.05, 0, -0.81, -0.03); g.color(0x3a0c14).box(0.94, 0.14, 0.07, 0, -0.04, 0); });
      n.armR = N(n.torso, -0.52, 0.9, 0, g => g.color(BONE).limb(0, 0, 0, 0, -0.52, 0, 0.075, 0.065, 6).sph(0.09, 0, -0.52, 0));
      n.foreR = N(n.armR, 0, -0.52, 0, g => { g.color(BONE).limb(0, 0, 0, 0, -0.48, 0.02, 0.065, 0.055, 6); g.color(0x3a3440).box(0.2, 0.16, 0.2, 0, -0.5, 0.03); });
      n.sword = N(n.foreR, 0, -0.52, 0.04, g => { g.color(0x3a3440).box(0.08, 0.08, 0.5, 0, 0, -0.06); g.color(0xd8b84a, 0.6).box(0.56, 0.1, 0.1, 0, 0, 0.22).oct(0.09, 0, 0, -0.36);
        g.color(0x8a90a8, 0.25).box(0.24, 0.05, 1.9, 0, 0, 1.2); g.color(0xb060ff, 2.8).box(0.06, 0.07, 1.6, 0, 0, 1.12); g.color(0x8a90a8, 0.25).cone(0.17, 0.3, 4, 0, 0, 2.3, PI / 2, 0, PI / 4); });
      n.armL = N(n.torso, 0.52, 0.9, 0, g => g.color(BONE).limb(0, 0, 0, 0, -0.52, 0, 0.075, 0.065, 6).sph(0.09, 0, -0.52, 0));
      n.foreL = N(n.armL, 0, -0.52, 0, g => { g.color(BONE).limb(0, 0, 0, 0, -0.46, 0.02, 0.065, 0.05, 6); for (let i = -1; i <= 1; i++) g.limb(i * 0.05, -0.46, 0.02, i * 0.09, -0.66, 0.1, 0.025, 0.012, 3); g.color(0xb060ff, 2.4).ico(0.08, 0, -0.56, 0.12); });
    },
    animate(rig, an, aT, t, dt, mv) {
      const n = rig.n, R = rig.R, w = Math.sin(t * 4.2), mvk = mv ? 1 : 0.25;
      let legA = w * 0.5 * mvk, hipX = 0.05, torY = Math.sin(t * 2.1) * 0.08, torX = 0, headX = 0, aRx = 0.25, aRz = -0.2, fRx = -1.2, swX = -0.5, swY = 0, aLx = -w * 0.3 * mvk, aLz = 0.15, fLx = -0.3, cape = 0.15 + 0.1 * Math.sin(t * 3), y = 0;
      if (an === 'windup') { const p = smooth(aT / 0.5); torY = 0.9 * p; aRx = -2.6 * p; aRz = -0.5 * p; fRx = -0.6; swX = -0.3; torX = -0.1 * p; }
      else if (an === 'attack') { const p = smooth(aT / 0.28); torY = lerp(0.9, -1.0, p); aRx = -1.35; aRz = -1.1; fRx = -0.25; swX = 0; swY = lerp(0.6, -0.5, p); torX = 0.22; legA = 0.3; cape = 0.7; }
      else if (an === 'cast') { aLx = -1.7 + 0.1 * Math.sin(t * 9); fLx = -0.5; aRx = 0.5; fRx = -0.3; swX = 1.3; torX = -0.1; headX = -0.2; }
      else if (an === 'charge') { hipX = 0.5; legA = Math.sin(t * 11) * 0.8; aRx = -0.6; fRx = -1.0; swX = 0.2; cape = 0.9; }
      else if (an === 'summon') { const p = smooth(aT / 0.4); aLx = -2.7 * p; aRx = -2.5 * p; fRx = -0.3; fLx = -0.3; swX = -1.2; headX = -0.5 * p; torX = -0.2 * p; cape = 0.5 + 0.2 * Math.sin(t * 12); aLz = 0.5; aRz = -0.5; }
      else if (an === 'stun') { torX = 0.6; headX = 0.5 + 0.1 * Math.sin(t * 7); aRx = 0.3; fRx = -0.1; swX = 0.6; aLx = 0.3; hipX = 0.15; torY = Math.sin(t * 5) * 0.1; legA = 0; y = -0.12; }
      R(n.legL, legA, 0, 0); R(n.legR, -legA, 0, 0); R(n.hips, hipX, 0, 0); R(n.torso, torX, torY, 0); R(n.head, headX, -torY * 0.5, 0);
      R(n.armR, aRx, 0, aRz); R(n.foreR, fRx, 0, 0); R(n.sword, swX, swY, 0); R(n.armL, aLx, 0, aLz); R(n.foreL, fLx, 0, 0); R(n.cape, cape, 0, 0);
      n.hips.position.y = 1.02 + y + Math.abs(Math.cos(t * 4.2)) * 0.05 * mvk;
    }
  },
  boss_broodmother: {
    h: 1.5, sh: 1.5, col: [0.5, 1.0, 0.3],
    build(rig) {
      const N = (p, x, y, z, fn) => bossNode(rig, p, x, y, z, fn), n = rig.n;
      n.body = N(rig.root, 0, 0.72, 0, g => { g.color(0x2a1f33).sph(0.4, 0, 0, 0.1, 1.15, 0.75, 1.25, 7, 5); g.color(0x3d2c4a).sph(0.3, 0, 0.06, 0.52, 1, 0.8, 1);
        g.color(0xff2a3a, 3.6); for (const [x, y, z, s] of [[0.1, 0.16, 0.76, 0.07], [-0.1, 0.16, 0.76, 0.07], [0.2, 0.14, 0.66, 0.05], [-0.2, 0.14, 0.66, 0.05], [0.07, 0.26, 0.66, 0.045], [-0.07, 0.26, 0.66, 0.045]]) g.ico(s, x, y, z);
        g.color(0x6a4a8a).cone(0.08, 0.3, 4, 0.2, 0.24, 0.0, -0.3, 0, -0.3).cone(0.08, 0.3, 4, -0.2, 0.24, 0.0, -0.3, 0, 0.3).cone(0.09, 0.34, 4, 0, 0.3, -0.16, -0.4); });
      n.fangL = N(n.body, 0.12, -0.04, 0.76, g => g.color(0xe8e0c8).cone(0.06, 0.34, 4, 0, -0.12, 0.06, PI - 0.4)); n.fangR = N(n.body, -0.12, -0.04, 0.76, g => g.color(0xe8e0c8).cone(0.06, 0.34, 4, 0, -0.12, 0.06, PI - 0.4));
      n.abdomen = N(n.body, 0, 0.06, -0.3, g => { g.color(0x241a2e).sph(0.66, 0, 0.12, -0.7, 1, 0.85, 1.3, 8, 6);
        g.color(0x7dff5a, 1.6).oct(0.16, 0, 0.66, -0.5, 1, 0.35, 1.8).oct(0.13, 0, 0.62, -1.0, 1.8, 0.35, 1); g.color(0x9dff6a, 1.3); for (const [x, z] of [[0.36, -0.4], [-0.36, -0.4], [0.42, -0.9], [-0.42, -0.9], [0.24, -1.3], [-0.24, -1.3]]) g.ico(0.1, x, 0.46, z);
        g.color(0x3d2c4a).cone(0.14, 0.4, 5, 0, 0.05, -1.62, -PI / 2 - 0.2); });
      const spread = [0.85, 0.3, -0.25, -0.8]; n.legs = [];
      for (const s of [1, -1]) for (let i = 0; i < 4; i++) {
        const up = N(n.body, s * 0.34, -0.04, 0.3 - i * 0.2, g => { g.color(0x3a2d48).limb(0, 0, 0, s * 0.8, 0.62, 0, 0.09, 0.07, 5).sph(0.1, s * 0.8, 0.62, 0); });
        const lo = N(up, s * 0.8, 0.62, 0, g => { g.color(0x2a1f33).limb(0, 0, 0, s * 0.62, -1.3, 0, 0.07, 0.025, 5); g.color(0x7dff5a, 1.5).box(0.06, 0.1, 0.1, s * 0.18, -0.4, 0); });
        up.castShadow = lo.castShadow = false; n.legs.push({ up, lo, s, base: -s * spread[i], ph: (i % 2 ? 0 : PI) + (s > 0 ? 0 : PI), front: i === 0 });
      }
    },
    animate(rig, an, aT, t, dt, mv) {
      const n = rig.n, R = rig.R; let sp = mv ? 7 : 2, amp = mv ? 0.3 : 0.06, bodyX = 0, bodyY = 0.72 + Math.sin(t * 2.2) * 0.03, abX = Math.sin(t * 1.8) * 0.05, abS = 1 + Math.sin(t * 2.5) * 0.02, front = 0, splay = 0, fang = 0.1 * Math.sin(t * 5);
      if (an === 'windup') { const p = smooth(aT / 0.45); bodyX = -0.45 * p; front = -1.0 * p; bodyY += 0.2 * p; fang = 0.5; }
      else if (an === 'attack') { const p = smooth(aT / 0.2); bodyX = lerp(-0.45, 0.3, p); front = lerp(-1.0, 0.5, p); fang = -0.3; }
      else if (an === 'cast') { abX = -0.7 + Math.sin(t * 16) * 0.05; abS = 1.06 + Math.sin(t * 14) * 0.05; bodyX = -0.2; }
      else if (an === 'summon') { abX = 0.45 + Math.sin(t * 22) * 0.07; abS = 1.1 + Math.sin(t * 18) * 0.06; bodyX = 0.15; bodyY -= 0.1; }
      else if (an === 'charge') { sp = 15; amp = 0.42; bodyY -= 0.1; bodyX = 0.1; }
      else if (an === 'stun') { bodyY = 0.36; splay = 0.5; amp = 0.03; bodyX = 0.05; fang = 0.4; }
      R(n.body, bodyX, 0, 0); n.body.position.y += (bodyY - n.body.position.y) * rig.k; R(n.abdomen, abX, 0, 0); n.abdomen.scale.setScalar(abS);
      R(n.fangL, fang, 0, -0.2 - fang * 0.4); R(n.fangR, fang, 0, 0.2 + fang * 0.4);
      for (const L of n.legs) {
        const sw = Math.sin(t * sp + L.ph), lift = Math.max(0, Math.cos(t * sp + L.ph));
        R(L.up, 0, L.base + sw * amp * L.s * -1, L.s * (lift * amp * 0.9 - splay * 0.5 + (L.front ? -front * 0.9 : 0) + (bodyY < 0.6 ? 0.25 : 0)));
        R(L.lo, 0, 0, L.s * (splay * 0.8 + (L.front ? front * 0.5 : 0) - (bodyY < 0.6 ? 0.25 : 0)));
      }
    }
  },
  boss_pyrelord: {
    h: 2.6, sh: 1.2, col: [1.0, 0.45, 0.1],
    build(rig) {
      const N = (p, x, y, z, fn) => bossNode(rig, p, x, y, z, fn), n = rig.n;
      const leg = g => { g.color(0x2e2426).box(0.38, 0.7, 0.44, 0, -0.35, 0); g.color(0xff5a14, 2.6).box(0.06, 0.4, 0.03, 0.05, -0.3, 0.225, 0, 0, 0.3); g.color(0x3d3032).box(0.44, 0.16, 0.6, 0, -0.68, 0.08); };
      n.legL = N(rig.root, 0.34, 0.76, 0, leg); n.legR = N(rig.root, -0.34, 0.76, 0, leg);
      n.hips = N(rig.root, 0, 0.76, 0, g => { g.color(0x2e2426).box(0.95, 0.3, 0.6, 0, 0.05, 0); g.color(0x4a3a36).box(0.4, 0.36, 0.06, 0, -0.16, 0.32); });
      n.torso = N(n.hips, 0, 0.16, 0, g => { g.color(0x33282a).box(1.3, 0.95, 0.8, 0, 0.58, 0); g.color(0x3d3032).box(1.0, 0.4, 0.7, 0, 0.14, 0);
        g.color(0xff5a14, 3).box(0.07, 0.62, 0.04, 0.12, 0.6, 0.41, 0, 0, 0.6).box(0.07, 0.62, 0.04, -0.12, 0.6, 0.41, 0, 0, -0.6).box(0.06, 0.34, 0.04, 0.36, 0.42, 0.41, 0, 0, -0.3).box(0.06, 0.34, 0.04, -0.36, 0.42, 0.41, 0, 0, 0.3); g.color(0xffc040, 4).ico(0.15, 0, 0.62, 0.38);
        for (const s of [1, -1]) { g.color(0x3d3032).ico(0.48, s * 0.84, 1.0, 0, 1, 0.85, 1); g.color(0xff7a1a, 2.6).cone(0.14, 0.5, 5, s * 0.84, 1.52, 0).cone(0.1, 0.38, 4, s * 1.04, 1.4, -0.14, 0, 0, -s * 0.4).cone(0.1, 0.36, 4, s * 0.66, 1.42, 0.14, 0, 0, s * 0.2); }
        g.color(0x241c1e).cone(0.16, 0.6, 4, 0.3, 1.0, -0.46, -0.9).cone(0.18, 0.7, 4, 0, 0.8, -0.5, -1.0).cone(0.16, 0.6, 4, -0.3, 1.0, -0.46, -0.9); });
      n.head = N(n.torso, 0, 1.08, 0.08, g => { g.color(0x2e2426).box(0.46, 0.42, 0.46, 0, 0.2, 0).box(0.36, 0.16, 0.3, 0, -0.02, 0.14); g.color(0xffd040, 4).box(0.11, 0.07, 0.04, 0.11, 0.26, 0.24, 0, 0, 0.3).box(0.11, 0.07, 0.04, -0.11, 0.26, 0.24, 0, 0, -0.3); g.color(0xff7a1a, 3).box(0.24, 0.06, 0.04, 0, 0.04, 0.3);
        for (const s of [1, -1]) { g.color(0x1a1416).limb(s * 0.2, 0.36, 0, s * 0.56, 0.56, 0.06, 0.11, 0.08, 5).limb(s * 0.56, 0.56, 0.06, s * 0.66, 0.96, 0.3, 0.08, 0.02, 5); }
        g.color(0xff7a1a, 2.4).cone(0.12, 0.46, 4, 0, 0.6, -0.14, -0.4).cone(0.1, 0.36, 4, 0.14, 0.52, -0.22, -0.6).cone(0.1, 0.36, 4, -0.14, 0.52, -0.22, -0.6); });
      const arm = g => { g.color(0x33282a).limb(0, 0, 0, 0, -0.62, 0, 0.23, 0.19, 6); g.color(0xff5a14, 2.6).box(0.05, 0.36, 0.03, 0, -0.32, 0.2, 0, 0, 0.3); };
      const fore = g => { g.color(0x3d3032).limb(0, 0, 0, 0, -0.56, 0.03, 0.2, 0.22, 6).ico(0.34, 0, -0.76, 0.05); g.color(0xff7a1a, 3).box(0.34, 0.07, 0.05, 0, -0.74, 0.36).box(0.07, 0.3, 0.05, 0, -0.5, 0.22); };
      n.armL = N(n.torso, 0.9, 0.9, 0, arm); n.foreL = N(n.armL, 0, -0.62, 0, fore); n.armR = N(n.torso, -0.9, 0.9, 0, arm); n.foreR = N(n.armR, 0, -0.62, 0, fore);
    },
    animate(rig, an, aT, t, dt, mv) {
      const n = rig.n, R = rig.R, w = Math.sin(t * 3.4), mvk = mv ? 1 : 0.2;
      let legA = w * 0.45 * mvk, hipX = 0.08, torX = 0.05 + Math.sin(t * 1.7) * 0.03, torY = w * 0.12 * mvk, headX = 0, aL = -w * 0.4 * mvk, aR = w * 0.4 * mvk, aLz = 0.25, aRz = -0.25, fL = -0.35, fR = -0.35, y = 0;
      if (an === 'windup') { const p = smooth(aT / 0.5); aL = aR = -2.9 * p; fL = fR = -0.4; torX = -0.3 * p; headX = -0.3 * p; aLz = 0.1; aRz = -0.1; }
      else if (an === 'attack') { const p = smooth(aT / 0.18); aL = aR = lerp(-2.9, -0.55, p); fL = fR = -0.2; torX = lerp(-0.3, 0.6, p); y = -0.1 * p; legA = 0; }
      else if (an === 'cast') { aL = aR = -1.0; aLz = 1.3; aRz = -1.3; fL = fR = -0.9; torX = -0.3; headX = -0.55 + 0.05 * Math.sin(t * 20); }
      else if (an === 'charge') { hipX = 0.55; headX = 0.5; aL = aR = 0.9; fL = fR = -0.3; legA = Math.sin(t * 12) * 0.75; }
      else if (an === 'summon') { const p = smooth(aT / 0.4); aR = -3.0 * p; fR = -0.2; aL = 0.2; torX = -0.15; headX = -0.3; }
      else if (an === 'stun') { hipX = 0.3; torX = 0.5; headX = 0.4; aL = aR = 0.2; fL = fR = -0.1; y = -0.2; legA = 0; torY = Math.sin(t * 6) * 0.06; }
      R(n.legL, legA, 0, 0); R(n.legR, -legA, 0, 0); R(n.hips, hipX, 0, 0); R(n.torso, torX, torY, 0); R(n.head, headX, -torY, 0);
      R(n.armL, aL, 0, aLz); R(n.armR, aR, 0, aRz); R(n.foreL, fL, 0, 0); R(n.foreR, fR, 0, 0);
      n.hips.position.y = 0.76 + y + Math.abs(Math.cos(t * 3.4)) * 0.07 * mvk;
    }
  },
  boss_frostlich: {
    h: 2.6, sh: 0.9, col: [0.4, 0.8, 1.0], fly: 0.5,
    build(rig) {
      const N = (p, x, y, z, fn) => bossNode(rig, p, x, y, z, fn), n = rig.n;
      n.fl = N(rig.root, 0, 0.5, 0);
      n.robe = N(n.fl, 0, 1.2, 0, g => { g.color(0x1a2440).cyl(0.34, 0.62, 1.2, 9, 0, -0.6, 0); g.color(0x8fd8ff, 0.9).cyl(0.63, 0.63, 0.05, 9, 0, -1.18, 0).box(0.08, 1.1, 0.04, 0, -0.6, 0.5, -0.24);
        g.color(0x141c34); for (let i = 0; i < 7; i++) { const a = i / 7 * TAU; g.box(0.26, 0.5 + (i % 3) * 0.14, 0.04, Math.cos(a) * 0.56, -1.4 - (i % 3) * 0.06, Math.sin(a) * 0.56, 0, -a + PI / 2, 0); } });
      n.torso = N(n.fl, 0, 1.2, 0, g => { g.color(0x222e52).box(0.74, 0.56, 0.42, 0, 0.3, 0); g.color(BONE_D).box(0.4, 0.06, 0.05, 0, 0.42, 0.22).box(0.34, 0.06, 0.05, 0, 0.3, 0.22).box(0.28, 0.06, 0.05, 0, 0.18, 0.22); g.color(0xbff0ff, 1.8).ico(0.1, 0, 0.3, 0.2);
        for (const s of [1, -1]) { g.color(0xa8e0ff, 0.35).oct(0.2, s * 0.5, 0.62, 0, 1, 1.9, 1, 0, 0, -s * 0.7).oct(0.13, s * 0.36, 0.72, -0.1, 1, 1.8, 1, 0, 0, -s * 0.3); } g.color(0x141c34).cone(0.4, 0.5, 6, 0, 0.7, -0.14, -0.3); });
      n.head = N(n.torso, 0, 0.66, 0.02, g => { g.color(0xe8eef0).sph(0.23, 0, 0.2, 0.04, 1, 1.05, 1.05, 7, 5).box(0.2, 0.12, 0.2, 0, 0.02, 0.1); g.color(0x8ff0ff, 3).box(0.08, 0.07, 0.04, 0.09, 0.22, 0.26).box(0.08, 0.07, 0.04, -0.09, 0.22, 0.26);
        g.color(0xbfeaff, 0.6); for (let i = 0; i < 5; i++) { const a = (i - 2) * 0.5; g.oct(0.07, Math.sin(a) * 0.24, 0.52 + (i === 2 ? 0.14 : 0) - Math.abs(i - 2) * 0.03, 0.02 + Math.cos(a) * 0.1 - 0.1, 1, i === 2 ? 4.2 : 3, 1, 0, 0, -a * 0.5); } });
      const sleeve = s => g => { g.color(0x222e52).limb(0, 0, 0, s * 0.08, -0.5, 0.1, 0.11, 0.17, 6); };
      n.armR = N(n.torso, -0.42, 0.46, 0, sleeve(-1)); n.armL = N(n.torso, 0.42, 0.46, 0, sleeve(1));
      n.handL = N(n.armL, 0.08, -0.5, 0.1, g => { g.color(BONE).box(0.1, 0.16, 0.1, 0, -0.06, 0.02); for (let i = -1; i <= 1; i++) g.limb(i * 0.04, -0.12, 0.02, i * 0.08, -0.3, 0.08, 0.02, 0.01, 3); g.color(0xbff0ff, 1.8).ico(0.12, 0, -0.34, 0.2, 1, 1, 1, 1); });
      n.staff = N(n.armR, -0.08, -0.52, 0.12, g => { g.color(BONE).box(0.1, 0.16, 0.1, 0, 0, 0); g.color(0x2a3450).limb(0, -1.3, 0.06, 0, 1.05, 0.06, 0.04, 0.04, 5);
        g.color(0xa8e8ff, 1.5).oct(0.2, 0, 1.36, 0.06, 1, 1.9, 1); g.color(0xd8f4ff, 0.6).oct(0.1, 0.2, 1.2, 0.06, 1, 2, 1, 0, 0, -0.6).oct(0.1, -0.2, 1.2, 0.06, 1, 2, 1, 0, 0, 0.6).oct(0.08, 0, 1.14, 0.26, 1, 2, 1, 0.6); });
      n.shards = []; for (let i = 0; i < 5; i++) n.shards.push(N(rig.root, 0, 1.2, 0, g => g.color(0x9fd8ff, 0.5).oct(0.13, 0, 0, 0, 0.7, 2.2, 0.7)));
    },
    animate(rig, an, aT, t, dt, mv) {
      const n = rig.n, R = rig.R; let fy = 0.5 + Math.sin(t * 1.6) * 0.14, lean = mv ? 0.14 : 0.03, torX = 0, headX = 0, aR = -0.35, aRz = -0.15, aL = -0.25 + Math.sin(t * 1.3) * 0.1, aLz = 0.2, stf = 0.3, orbR = 1.25, orbS = 1.2, orbY = 0;
      if (an === 'windup') { const p = smooth(aT / 0.45); aR = -1.2 * p; aL = -1.2 * p; aRz = 0.5 * p; aLz = -0.5 * p; torX = 0.2 * p; orbR = 0.7; orbS = 4; }
      else if (an === 'attack') { const p = smooth(aT / 0.2); aR = -1.75; stf = lerp(0.6, 1.5, p); aL = -0.2; torX = 0.25; lean = 0.25; orbR = 1.5; }
      else if (an === 'cast') { aR = -2.7; aRz = -0.3; stf = -0.15 + Math.sin(t * 14) * 0.04; aL = -1.5; aLz = 0.6; torX = -0.15; headX = -0.3; fy += 0.2; orbS = 3; }
      else if (an === 'summon') { aR = -1.6; aRz = -1.2; aL = -1.6; aLz = 1.2; stf = -0.4; headX = -0.4; fy += 0.3; orbR = 2.0; orbS = 5; }
      else if (an === 'charge') { lean = 0.55; aR = 0.5; aL = 0.5; stf = -0.5; orbR = 0.9; orbS = 3; }
      else if (an === 'stun') { fy = 0.15; torX = 0.5; headX = 0.5; aR = 0.2; aL = 0.2; stf = 0.9; orbR = 1.3; orbS = 0.2; orbY = -0.9; }
      n.fl.position.y += (fy - n.fl.position.y) * rig.k; R(n.fl, lean, 0, 0); R(n.torso, torX, Math.sin(t * 0.9) * 0.08, 0); R(n.head, headX, 0, 0);
      R(n.armR, aR, 0, aRz); R(n.armL, aL, 0, aLz); R(n.staff, stf - aR * 0.55, 0, 0); n.robe.rotation.x = -lean * 0.5 + Math.sin(t * 2.3) * 0.04; n.robe.rotation.z = Math.sin(t * 1.7) * 0.04;
      rig.orbR += (orbR - rig.orbR) * rig.k * 0.5; rig.orbA += dt * orbS; rig.orbY += (orbY - rig.orbY) * rig.k * 0.5;
      for (let i = 0; i < n.shards.length; i++) { const a = rig.orbA + i / n.shards.length * TAU, s = n.shards[i]; s.position.set(Math.cos(a) * rig.orbR, 1.5 + rig.orbY + Math.sin(t * 2 + i) * 0.2, Math.sin(a) * rig.orbR); s.rotation.set(0.4, a, 0.3); }
    }
  }
};
function makeBossRig(type, mat) {
  const def = BOSS_DEFS[type]; if (!def) return null;
  const rig = { type, def, mat, root: new THREE.Group(), n: {}, geos: [], k: 0.2, orbR: 1.2, orbA: 0, orbY: 0, t: 0, id: -1, seen: 0 };
  rig.R = (o, x, y, z) => { const r = o.rotation, k = rig.k; r.x += (x - r.x) * k; r.y += (y - r.y) * k; r.z += (z - r.z) * k; };
  def.build(rig);
  return rig;
}

/* ---------------------------------------------------------------------------------------------
 * Stage palettes (linear colour)
 * ------------------------------------------------------------------------------------------- */
const STAGES = {
  graveyard: {
    fog: [0.010, 0.020, 0.026], fogNear: 9.5, fogFar: 27, fogMax: 0.93, sky: [0.115, 0.185, 0.215], gnd: [0.035, 0.05, 0.055], key: [0.2, 0.33, 0.38],
    hero: [1.02, 0.72, 0.43], heroR: 12.5, rim: [0.4, 0.75, 0.8], lava: [0, 0, 0], gfx: [0, 0, 0, 1], aurora: [0, 0, 0], tile: 13,
    mote: { col: [0.55, 1.0, 0.7, 0.75], vel: [0.25, 0.03, 0.15, 0.9], size: 0.13, h: 5 }, card: [0.2, 0.34, 0.36, 0.11], drift: [0.5, 0.22],
    props: ['tomb', 'deadtree', 'lantern'], decalTint: 1.0, vig: 0.62
  },
  catacombs: {
    fog: [0.010, 0.016, 0.009], fogNear: 9.5, fogFar: 27, fogMax: 0.94, sky: [0.125, 0.14, 0.11], gnd: [0.04, 0.045, 0.035], key: [0.17, 0.2, 0.13],
    hero: [1.0, 0.8, 0.5], heroR: 12.5, rim: [0.5, 0.72, 0.35], lava: [0, 0, 0], gfx: [0, 0, 0, 1], aurora: [0, 0, 0], tile: 12,
    mote: { col: [0.8, 0.95, 0.5, 0.45], vel: [0.08, -0.04, 0.05, 0.5], size: 0.09, h: 5 }, card: [0.14, 0.22, 0.09, 0.1], drift: [0.25, 0.12],
    props: ['pillar', 'rubble', 'brazier'], decalTint: 1.0, vig: 0.66
  },
  inferno: {
    fog: [0.028, 0.007, 0.004], fogNear: 9.5, fogFar: 28, fogMax: 0.9, sky: [0.2, 0.085, 0.06], gnd: [0.14, 0.035, 0.012], key: [0.4, 0.15, 0.06],
    hero: [1.0, 0.74, 0.5], heroR: 12.5, rim: [1.0, 0.42, 0.14], lava: [1.5, 0.32, 0.04], gfx: [0.72, 0.28, 0, 0.72], aurora: [0, 0, 0], tile: 14,
    mote: { col: [1.0, 0.45, 0.1, 1.0], vel: [0.35, 1.1, -0.15, 0.6], size: 0.11, h: 9 }, card: [0.3, 0.07, 0.03, 0.12], drift: [0.4, -0.2],
    props: ['spike', 'basalt', 'lavavent'], decalTint: 1.0, vig: 0.6
  },
  frostkeep: {
    fog: [0.012, 0.024, 0.045], fogNear: 9.5, fogFar: 28, fogMax: 0.92, sky: [0.075, 0.11, 0.18], gnd: [0.035, 0.05, 0.085], key: [0.11, 0.15, 0.25],
    hero: [0.6, 0.5, 0.4], heroR: 13, rim: [0.5, 0.75, 1.0], lava: [1.0, 1.25, 1.7], gfx: [0.6, 0.4, 1, 0.85], aurora: [0.03, 0.2, 0.14], tile: 13,
    mote: { col: [0.8, 0.88, 1.0, 0.6], vel: [-0.9, -1.7, 0.6, 0.4], size: 0.12, h: 10 }, card: [0.5, 0.62, 0.8, 0.06], drift: [-0.9, 0.4],
    props: ['icecrystal', 'statue', 'pine'], decalTint: 1.0, vig: 0.55
  }
};
const KCOL = {
  phys: [1.0, 0.94, 0.82], steel: [0.8, 0.9, 1.0], fire: [1.0, 0.5, 0.12], frost: [0.5, 0.85, 1.0], light: [1.0, 0.94, 0.5], poison: [0.45, 1.0, 0.3],
  holy: [1.0, 0.84, 0.4], dark: [0.7, 0.35, 1.0], bone: [0.9, 0.88, 0.75], meteor: [1.0, 0.45, 0.1], blood: [1.0, 0.15, 0.2], arcane: [0.75, 0.5, 1.0]
};
const kcol = k => KCOL[k] || KCOL.phys;
const AFFIX_COL = { swift: [1.0, 0.9, 0.25], burning: [1.0, 0.45, 0.1], frozen: [0.35, 0.85, 1.0], vampiric: [0.95, 0.1, 0.2], shielded: [0.7, 0.84, 1.0], splitting: [0.7, 0.3, 1.0] };
const ELITE_DEFAULT = [1.0, 0.75, 0.3];
const QUALITY = [
  { ratio: 1.0, bloom: false, shadow: false, particles: 260, motes: 0, cards: 0, decals: 0, sprites: 900 },
  { ratio: 1.25, bloom: false, shadow: false, particles: 520, motes: 90, cards: 6, decals: 0.5, sprites: 1500 },
  { ratio: 1.5, bloom: true, shadow: false, particles: 900, motes: 170, cards: 10, decals: 1, sprites: 2200 },
  { ratio: 2.0, bloom: true, shadow: true, particles: 1400, motes: 260, cards: 14, decals: 1, sprites: 2800 }
];

/* generic instanced batch with custom per-instance attributes (immediate mode: refilled every frame) */
function makeBatch(base, attrs, cap, material, renderOrder = 0) {
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = base.index; geo.setAttribute('position', base.attributes.position);
  if (base.attributes.uv) geo.setAttribute('uv', base.attributes.uv);
  if (base.attributes.normal) geo.setAttribute('normal', base.attributes.normal);
  const b = { geo, cap, n: 0, list: [], material };
  for (const name in attrs) {
    const arr = new Float32Array(cap * attrs[name]), at = new THREE.InstancedBufferAttribute(arr, attrs[name]);
    at.setUsage(THREE.DynamicDrawUsage); geo.setAttribute(name, at); b[name] = arr; b.list.push(at);
  }
  geo.instanceCount = 0;
  b.mesh = new THREE.Mesh(geo, material); b.mesh.frustumCulled = false; b.mesh.renderOrder = renderOrder; b.mesh.visible = false;
  b.commit = () => {
    geo.instanceCount = b.n; b.mesh.visible = b.n > 0;
    if (b.n > 0) for (const at of b.list) { at.clearUpdateRanges(); at.addUpdateRange(0, b.n * at.itemSize); at.needsUpdate = true; }
  };
  b.dispose = () => { geo.dispose(); };
  return b;
}
/* instanced lit characters / props: InstancedMesh + aFx/aTint */
function makeCharBatch(geo, material, cap, meta, fx = true) {
  const mesh = new THREE.InstancedMesh(geo, material, cap);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); mesh.frustumCulled = false; mesh.count = 0; mesh.visible = false;
  const b = { mesh, geo, m: mesh.instanceMatrix.array, n: 0, cap, meta: meta || {}, fx: null, tint: null, fxA: null, tintA: null };
  if (fx) {
    b.fx = new Float32Array(cap * 4); b.tint = new Float32Array(cap * 4);
    b.fxA = new THREE.InstancedBufferAttribute(b.fx, 4); b.tintA = new THREE.InstancedBufferAttribute(b.tint, 4);
    b.fxA.setUsage(THREE.DynamicDrawUsage); b.tintA.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aFx', b.fxA); geo.setAttribute('aTint', b.tintA);
  }
  b.commit = () => {
    mesh.count = b.n; mesh.visible = b.n > 0;
    if (b.n > 0) {
      const im = mesh.instanceMatrix; im.clearUpdateRanges(); im.addUpdateRange(0, b.n * 16); im.needsUpdate = true;
      if (b.fxA) { b.fxA.clearUpdateRanges(); b.fxA.addUpdateRange(0, b.n * 4); b.fxA.needsUpdate = true; b.tintA.clearUpdateRanges(); b.tintA.addUpdateRange(0, b.n * 4); b.tintA.needsUpdate = true; }
    }
  };
  b.dispose = () => { mesh.dispose(); geo.dispose(); };
  return b;
}
function putChar(b, x, y, z, rot, sx, sy, sz, lean, phase, pose, flash, fade, tr, tg, tb, ta) {
  if (b.n >= b.cap) return;
  const i = b.n++, o = i * 16, m = b.m, c = Math.cos(rot), s = Math.sin(rot), cl = Math.cos(lean), sl = Math.sin(lean);
  m[o] = c * sx; m[o + 1] = 0; m[o + 2] = -s * sx; m[o + 3] = 0;
  m[o + 4] = s * sl * sy; m[o + 5] = cl * sy; m[o + 6] = c * sl * sy; m[o + 7] = 0;
  m[o + 8] = s * cl * sz; m[o + 9] = -sl * sz; m[o + 10] = c * cl * sz; m[o + 11] = 0;
  m[o + 12] = x; m[o + 13] = y; m[o + 14] = z; m[o + 15] = 1;
  if (b.fx) { const q = i * 4, f = b.fx, t = b.tint; f[q] = phase; f[q + 1] = pose; f[q + 2] = flash; f[q + 3] = fade; t[q] = tr; t[q + 1] = tg; t[q + 2] = tb; t[q + 3] = ta; }
}

/* =============================================================================================
 * createView
 * =========================================================================================== */
export function createView(opts = {}) {
  const canvas = opts.canvas;
  const lowEnd = !!opts.lowEnd;
  const KG = (typeof window !== 'undefined' && window.KG) || null;
  const QKEY = 'abyss:qualityAuto';      // the governor's own result; explicit setQuality() calls are the shell's to persist
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: !lowEnd, alpha: false, stencil: true, powerPreference: 'high-performance' });
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.12;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = false; renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.info.autoReset = false;
  const maxAniso = Math.min(4, renderer.capabilities.getMaxAnisotropy());
  const scene = new THREE.Scene(); scene.background = new THREE.Color(0x020406);
  const camera = new THREE.PerspectiveCamera(34, 1, 2, 300);
  const disposables = [];
  const keep = o => { disposables.push(o); return o; };

  /* ---- shared uniforms ---- */
  const V3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z), V4 = (x = 0, y = 0, z = 0, w = 0) => new THREE.Vector4(x, y, z, w);
  const U = {
    uTime: { value: 0 }, uHero: { value: V3() }, uHeroLight: { value: V4(1, 0.8, 0.5, 14) }, uAmbSky: { value: V3() }, uAmbGnd: { value: V3() },
    uKeyDir: { value: V3(-0.42, 0.8, 0.43).normalize() }, uKeyCol: { value: V3() }, uFogCol: { value: V3() }, uFog: { value: V4(12, 30, 0.9, 0.55) },
    uPL: { value: [V4(), V4(), V4(), V4(), V4(), V4()] }, uPLC: { value: [V3(), V3(), V3(), V3(), V3(), V3()] },
    uRimCol: { value: V3() }, uHeroScr: { value: V4(0, 0, 60, 0) }
  };
  for (let i = 0; i < 6; i++) U.uPL.value[i].w = 1;
  const litMats = [];
  function makeLit(o = {}) {
    const defines = {};
    if (o.rig) defines.RIG = 1; if (o.inst) defines.INST = 1; if (o.occlude) defines.OCCLUDE = 1; if (o.double) defines.DOUBLE_SIDED = 1;
    const m = new THREE.ShaderMaterial({
      defines, vertexShader: LIT_VS, fragmentShader: LIT_FS,
      uniforms: Object.assign({}, U, { uFx: { value: V4(0, 0, 0, 1) }, uTint: { value: V4() }, uDim: { value: new THREE.Vector2(o.dim === undefined ? 1 : o.dim, o.self || 0) }, uRimK: { value: o.rim === undefined ? 0.55 : o.rim }, uEmiK: { value: o.emi === undefined ? 1 : o.emi }, uAlpha: { value: o.alpha === undefined ? 1 : o.alpha } }),
      transparent: !!o.transparent, side: o.double ? THREE.DoubleSide : THREE.FrontSide
    });
    litMats.push(m); return keep(m);
  }
  const PREMULT = { transparent: true, depthWrite: false, blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor, blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor };
  const matEnemy = makeLit({ rig: true, inst: true, rim: 0.5, dim: 0.62 });
  const matEnemyGhost = makeLit({ rig: true, inst: true, rim: 0.6, alpha: 0.72, transparent: true, dim: 0.62 });
  const matProp = makeLit({ occlude: true, rim: 0.35 });
  const matSmall = makeLit({ inst: true, rim: 0.5, emi: 1.15 });          // projectiles, pickups, shrines
  const matHero = makeLit({ rim: 0.8, emi: 1.0, self: 0.2 });
  matHero.stencilWrite = true; matHero.stencilRef = 1; matHero.stencilFunc = THREE.AlwaysStencilFunc; matHero.stencilZPass = THREE.ReplaceStencilOp;
  const matXray = keep(new THREE.ShaderMaterial(Object.assign({ vertexShader: XRAY_VS, fragmentShader: XRAY_FS, uniforms: { uXray: { value: V4(1, 1, 1, 0.5) } } }, PREMULT)));
  matXray.depthFunc = THREE.GreaterDepth; matXray.stencilWrite = true; matXray.stencilWriteMask = 0; matXray.stencilRef = 1; matXray.stencilFunc = THREE.NotEqualStencilFunc;
  const matAlly = makeLit({ rig: true, inst: true, rim: 1.0, emi: 1.25 });
  const matMenu = makeLit({ rim: 0.4, dim: 0.78 });

  /* ---- quality ---- */
  let quality = 2, cssW = 300, cssH = 300, baseDpr = 1, bufW = 300, bufH = 300, Q = QUALITY[2];
  const deviceQ = lowEnd ? 1 : (Math.min(canvas.clientWidth || (typeof innerWidth === 'number' ? innerWidth : 800), canvas.clientHeight || (typeof innerHeight === 'number' ? innerHeight : 800)) < 560 ? 2 : 3);
  let storedAuto = null;
  { const g = KG && KG.store ? KG.store.get(QKEY, null) : null; if (typeof g === 'number' && g >= 0 && g <= 3) storedAuto = Math.round(g); }
  const storeAuto = q => { storedAuto = q; if (KG && KG.store) { try { KG.store.set(QKEY, q); } catch (e) { /* ignore */ } } };
  // auto mode starts one level above what the governor last settled on (never above the device default),
  // so one slow session does not pin the game to a low level forever
  const autoStartQuality = () => (storedAuto === null ? deviceQ : Math.min(deviceQ, storedAuto + 1));
  quality = autoStartQuality();
  Q = QUALITY[quality];

  /* ---- textures ---- */
  const spriteTex = keep(makeSpriteAtlas()); spriteTex.flipY = false;
  const textAtlas = makeTextAtlas(); textAtlas.tex.flipY = false; keep(textAtlas.tex);

  /* ---- ground ---- */
  const groundMat = keep(new THREE.ShaderMaterial({
    vertexShader: GROUND_VS, fragmentShader: GROUND_FS,
    uniforms: Object.assign({}, U, { uMap: { value: null }, uTile: { value: 12 }, uGOrigin: { value: V3() }, uLava: { value: V3() }, uGroundFx: { value: V4(0, 0, 0, 1) }, uAurora: { value: V3() } })
  }));
  const groundGeo = keep(new THREE.PlaneGeometry(260, 260).rotateX(-PI / 2));
  const ground = new THREE.Mesh(groundGeo, groundMat); ground.frustumCulled = false; ground.renderOrder = -10; scene.add(ground);
  const quadXZ = keep(new THREE.PlaneGeometry(2, 2).rotateX(-PI / 2));
  const quadXY = keep(new THREE.PlaneGeometry(1, 1));
  const quadLine = keep(new THREE.PlaneGeometry(1, 1).translate(0.5, 0, 0));

  /* ---- batches ---- */
  const decalMat = keep(new THREE.ShaderMaterial({ vertexShader: DECAL_VS, fragmentShader: DECAL_FS, uniforms: Object.assign({}, U, { uMap: { value: null }, uCells: { value: new THREE.Vector2(4, 2) } }), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }));
  const decals = makeBatch(quadXZ, { aD: 4, aE: 4 }, 900, decalMat, -9); scene.add(decals.mesh);
  const shadowMat = keep(new THREE.ShaderMaterial({ vertexShader: SHADOW_VS, fragmentShader: SHADOW_FS, transparent: true, depthWrite: false }));
  const shadows = makeBatch(quadXZ, { aS: 4 }, 1100, shadowMat, -8); scene.add(shadows.mesh);
  const gfxMat = keep(new THREE.ShaderMaterial(Object.assign({ vertexShader: GFX_VS, fragmentShader: GFX_FS, uniforms: { uTime: U.uTime } }, PREMULT)));
  const gfx = makeBatch(quadXZ, { aPos: 4, aScl: 4, aCol: 4, aPar: 4 }, 520, gfxMat, -6); scene.add(gfx.mesh);
  const spriteMat = keep(new THREE.ShaderMaterial(Object.assign({ vertexShader: SPRITE_VS, fragmentShader: SPRITE_FS, uniforms: { uMap: { value: spriteTex } } }, PREMULT)));
  const sprites = makeBatch(quadXY, { aPos: 4, aCol: 4, aMisc: 4 }, 3000, spriteMat, 6); scene.add(sprites.mesh);
  const lineMat = keep(new THREE.ShaderMaterial(Object.assign({ vertexShader: LINE_VS, fragmentShader: LINE_FS, side: THREE.DoubleSide }, PREMULT)));
  const lines = makeBatch(quadLine, { aA: 4, aB: 4, aCol: 4 }, 900, lineMat, 5); scene.add(lines.mesh);
  const textMat = keep(new THREE.ShaderMaterial({ vertexShader: TEXT_VS, fragmentShader: TEXT_FS, uniforms: { uMap: { value: textAtlas.tex } }, transparent: true, depthWrite: false, depthTest: false }));
  const texts = makeBatch(quadXY, { aPos: 4, aRect: 4, aCol: 4, aV: 2 }, 640, textMat, 20); scene.add(texts.mesh);
  const overMat = keep(new THREE.ShaderMaterial(Object.assign({ vertexShader: OVER_VS, fragmentShader: OVER_FS, uniforms: { uVig: { value: V4(0.55, 1.25, 0.6, 0) }, uHurt: { value: V4(0.9, 0.05, 0.03, 0) }, uFlash: { value: V4(1, 1, 1, 0) }, uAspect: { value: 1 } }, depthTest: false }, PREMULT)));
  const overlay = new THREE.Mesh(keep(new THREE.PlaneGeometry(2, 2)), overMat); overlay.frustumCulled = false; overlay.renderOrder = 50; scene.add(overlay);

  function gpush(x, y, z, rot, sx, sz, mode, t, r, g, b, a, p1 = 0, p2 = 0, p3 = 0, seed = 0) {
    if (gfx.n >= gfx.cap) return; const o = gfx.n++ * 4;
    const P = gfx.aPos, S = gfx.aScl, C = gfx.aCol, R = gfx.aPar;
    P[o] = x; P[o + 1] = y; P[o + 2] = z; P[o + 3] = rot; S[o] = sx; S[o + 1] = sz; S[o + 2] = mode; S[o + 3] = t;
    C[o] = r; C[o + 1] = g; C[o + 2] = b; C[o + 3] = a; R[o] = p1; R[o + 1] = p2; R[o + 2] = p3; R[o + 3] = seed;
  }
  let spriteCap = Q.sprites;
  function spush(x, y, z, size, r, g, b, a, cell, rot = 0, add = 1, aspect = 1) {
    if (sprites.n >= spriteCap) return; const o = sprites.n++ * 4;
    const P = sprites.aPos, C = sprites.aCol, M = sprites.aMisc;
    P[o] = x; P[o + 1] = y; P[o + 2] = z; P[o + 3] = size; C[o] = r; C[o + 1] = g; C[o + 2] = b; C[o + 3] = a; M[o] = cell; M[o + 1] = rot; M[o + 2] = add; M[o + 3] = aspect;
  }
  function lpush(x1, y1, z1, x2, y2, z2, w, r, g, b, a, mode = 0) {
    if (lines.n >= lines.cap) return; const o = lines.n++ * 4;
    const A = lines.aA, B = lines.aB, C = lines.aCol;
    A[o] = x1; A[o + 1] = y1; A[o + 2] = z1; A[o + 3] = w; B[o] = x2; B[o + 1] = y2; B[o + 2] = z2; B[o + 3] = mode; C[o] = r; C[o + 1] = g; C[o + 2] = b; C[o + 3] = a;
  }
  function shpush(x, z, r, a) { if (shadows.n >= shadows.cap) return; const o = shadows.n++ * 4, S = shadows.aS; S[o] = x; S[o + 1] = z; S[o + 2] = r; S[o + 3] = a; }

  /* ---- character batches ---- */
  const enemyBatches = new Map(), allyBatches = new Map(), projBatches = new Map(), pickupBatches = new Map(), propBatches = new Map();
  const charList = [];      // every per-frame character batch (plain array: no iterator garbage in the frame loop)
  for (const type in ENEMY_DEFS) {
    const g = GB(), meta = ENEMY_DEFS[type](g), geo = keep(g.build(true));
    const b = makeCharBatch(geo, meta.alpha ? matEnemyGhost : matEnemy, type === 'unknown' ? 200 : 640, meta);
    if (meta.alpha) b.mesh.renderOrder = 1;
    enemyBatches.set(type, b); charList.push(b); scene.add(b.mesh);
  }
  function lazyBatch(map, defs, key, mat, cap, rigged) {
    let b = map.get(key);
    if (!b) {
      const def = defs[key] || defs.unknown, g = GB(); let meta;
      if (typeof def === 'function') meta = def(g); else { def.build(g); meta = def; }
      b = makeCharBatch(keep(g.build(rigged)), mat, cap, meta); map.set(key, b); charList.push(b); scene.add(b.mesh);
    }
    return b;
  }
  const chestBase = makeCharBatch(keep(buildChest(false)), matSmall, 24, {}); scene.add(chestBase.mesh);
  const chestLid = makeCharBatch(keep(buildChest(true)), matSmall, 24, {}); scene.add(chestLid.mesh);
  const shrineBatch = makeCharBatch(keep(buildShrine()), matSmall, 16, {}); scene.add(shrineBatch.mesh);
  charList.push(chestBase, chestLid, shrineBatch);
  const meteorBatch = makeCharBatch(keep((() => { const g = GB(); g.color(0x2a1c1a).ico(0.9, 0, 0, 0, 1, 0.9, 1.1, 1); g.color(0xff7a1a, 3).ico(0.5, 0.5, 0.2, 0.3).ico(0.42, -0.5, -0.3, 0.2).ico(0.4, 0.1, 0.5, -0.5).ico(0.36, -0.2, -0.5, -0.5); return g.build(); })()), matSmall, 24, {}); scene.add(meteorBatch.mesh); charList.push(meteorBatch);
  // shield bubbles + dash ghosts
  const ghostMat = keep(new THREE.ShaderMaterial(Object.assign({ vertexShader: GHOST_VS, fragmentShader: GHOST_FS }, PREMULT)));
  const bubbleMat = keep(new THREE.ShaderMaterial(Object.assign({ vertexShader: GHOST_VS, fragmentShader: BUBBLE_FS, uniforms: { uTime: U.uTime } }, PREMULT)));
  function makeGhostBatch(geo, mat, cap) {
    const mesh = new THREE.InstancedMesh(geo, mat, cap); mesh.frustumCulled = false; mesh.count = 0; mesh.visible = false; mesh.renderOrder = 3;
    const g = new Float32Array(cap * 4), at = new THREE.InstancedBufferAttribute(g, 4); at.setUsage(THREE.DynamicDrawUsage); geo.setAttribute('aG', at);
    const b = { mesh, m: mesh.instanceMatrix.array, n: 0, cap, fx: null, g, at };
    b.commit = () => { mesh.count = b.n; mesh.visible = b.n > 0; if (b.n) { mesh.instanceMatrix.needsUpdate = true; at.needsUpdate = true; } };
    return b;
  }
  const bubbles = makeGhostBatch(keep(new THREE.IcosahedronGeometry(1, 2)), bubbleMat, 32); scene.add(bubbles.mesh);
  let ghosts = null;

  /* ---- ambient motes + fog cards ---- */
  const moteGeo = keep(new THREE.BufferGeometry());
  { const N = 260, a = new Float32Array(N * 4), R = rng(4242); for (let i = 0; i < a.length; i++) a[i] = R(); moteGeo.setAttribute('aSeed', new THREE.BufferAttribute(a, 4)); moteGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3)); }
  const moteMat = keep(new THREE.ShaderMaterial(Object.assign({ vertexShader: MOTE_VS, fragmentShader: MOTE_FS, uniforms: { uCenter: { value: V3() }, uTime: U.uTime, uVel: { value: V4() }, uBox: { value: V4(46, 6, 64, 0.1) }, uPx: { value: 500 }, uMoteCol: { value: V4(1, 1, 1, 1) } } }, PREMULT)));
  const motes = new THREE.Points(moteGeo, moteMat); motes.frustumCulled = false; motes.renderOrder = 4; scene.add(motes);
  const cardGeo = keep(new THREE.InstancedBufferGeometry()); cardGeo.index = quadXZ.index; cardGeo.setAttribute('position', quadXZ.attributes.position);
  { const N = 14, a = new Float32Array(N * 4), R = rng(999); for (let i = 0; i < a.length; i++) a[i] = R(); cardGeo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(a, 4)); cardGeo.instanceCount = N; }
  const cardMat = keep(new THREE.ShaderMaterial(Object.assign({ vertexShader: FOGCARD_VS, fragmentShader: FOGCARD_FS, uniforms: { uCenter: moteMat.uniforms.uCenter, uTime: U.uTime, uBox: { value: V4(64, 1, 76, 9) }, uDrift: { value: new THREE.Vector2(0.4, 0.2) }, uFogCard: { value: V4(0.2, 0.3, 0.3, 0.2) }, uHero: U.uHero } }, PREMULT)));
  const cards = new THREE.Mesh(cardGeo, cardMat); cards.frustumCulled = false; cards.renderOrder = 2; scene.add(cards);

  /* ---- real shadows (top quality only): one directional light + a ShadowMaterial catcher ---- */
  const sun = new THREE.DirectionalLight(0xffffff, 1); sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024); sun.shadow.camera.near = 1; sun.shadow.camera.far = 60;
  { const c = sun.shadow.camera; c.left = -11; c.right = 11; c.top = 11; c.bottom = -11; c.updateProjectionMatrix(); }
  sun.shadow.bias = -0.002; sun.shadow.normalBias = 0.03;
  scene.add(sun); scene.add(sun.target);
  const catcherMat = keep(new THREE.ShadowMaterial({ opacity: 0.42, transparent: true, depthWrite: false }));
  const catcher = new THREE.Mesh(keep(new THREE.PlaneGeometry(26, 26).rotateX(-PI / 2)), catcherMat); catcher.receiveShadow = true; catcher.position.y = 0.03; catcher.renderOrder = -7; scene.add(catcher);

  /* ---- post ---- */
  let composer = null, bloom = null, sceneCalls = 0, sceneTris = 0;
  function buildComposer() {
    const rt = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, stencilBuffer: true, samples: (opts.msaa !== false && !lowEnd && (window.devicePixelRatio || 1) < 1.5) ? 4 : 0 });
    composer = new EffectComposer(renderer, rt);
    const rp = new RenderPass(scene, camera), orig = rp.render.bind(rp);
    rp.render = (...a) => { orig(...a); sceneCalls = renderer.info.render.calls; sceneTris = renderer.info.render.triangles; };
    composer.addPass(rp);
    bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.42, 0.5, 1.0);
    composer.addPass(bloom); composer.addPass(new OutputPass());
  }

  /* ---- camera ---- */
  const PITCH = 57 * PI / 180, SINP = Math.sin(PITCH), COSP = Math.cos(PITCH), BASE_FOV = 34;
  const cam = { tx: 0, tz: 0, lx: 0, lz: 0, dist: 40, shake: 0, punch: 0, sx: 0, sz: 0, init: false, fov: BASE_FOV };
  const ext = { halfW: 10, halfH: 12, top: 12, bottom: 8, nearHalfW: 9, farHalfW: 11 }, extOut = Object.assign({}, ext);
  function fitCamera() {
    const aspect = cssW / Math.max(1, cssH), th = Math.tan(BASE_FOV * PI / 360);
    cam.dist = Math.max(9.2 / (aspect * th), clamp(8.4 + (cssH - 400) * 0.006, 8.4, 10.6) * SINP / th);
    camera.aspect = aspect; camera.fov = BASE_FOV; camera.updateProjectionMatrix();
    // visible ground trapezoid relative to the look target (analytic)
    const H = cam.dist * SINP, half = BASE_FOV * PI / 360;
    const zc = H / Math.tan(PITCH), zTop = H / Math.tan(Math.max(0.05, PITCH - half)), zBot = H / Math.tan(PITCH + half);
    const dTop = Math.hypot(H, zTop), dBot = Math.hypot(H, zBot);
    ext.top = zTop - zc; ext.bottom = zc - zBot;
    ext.farHalfW = dTop * Math.cos(half) * th * aspect / 1; ext.nearHalfW = dBot * Math.cos(half) * th * aspect;
    ext.halfW = ext.farHalfW + 1.6; ext.halfH = Math.max(ext.top, ext.bottom) + 1.6;
    extOut.halfW = ext.halfW; extOut.halfH = ext.halfH; extOut.top = ext.top; extOut.bottom = ext.bottom; extOut.nearHalfW = ext.nearHalfW; extOut.farHalfW = ext.farHalfW;     // + look-ahead margin: anything outside this rect around the hero is off-screen
    moteMat.uniforms.uPx.value = bufH / (2 * th);
    overMat.uniforms.uAspect.value = aspect;
  }

  /* ---- state ---- */
  let time = 0, frame = 0, mode = 'game', lost = false, disposed = false;
  let stageId = null, S = STAGES.graveyard, groundTex = null, decalTex = null;
  const stageTex = new Map();
  let hero = null, heroId = null;
  const heroRigs = new Map();
  const heroPos = { x: 0, z: 0, rot: 0 };
  let hurtPulse = 0, deathFade = 0, flashA = 0, dbgCam = null, simPaused = false;
  const view = { showDamageNumbers: true, shakeScale: 1 };
  let autoQ = true;
  const menuFocus = { x: 0.5, y: 0.5, tx: 0.5, ty: 0.5, on: false, ox: 0, oy: 0, w: 0, h: 0, snap: true };
  const EMPTY = [];
  const DECAL_PICK = [0, 1, 2, 3, 5, 6, 0, 3, 6, 5, 2, 0, 3, 6, 4, 7], DECAL_SIZE = [1.3, 0.7, 0.75, 1.5, 0.8, 1.2, 1.0, 1.0];
  const _v = new THREE.Vector3(), _c1 = new THREE.Color();

  /* ---- props / decals ---- */
  let obstaclesNear = typeof opts.obstaclesNear === 'function' ? opts.obstaclesNear : null;
  const propQ = { x: Infinity, z: Infinity, list: [], dx: Infinity, dz: Infinity };
  if (!obstaclesNear && opts.core !== false) {
    const url = new URL('./core.js', import.meta.url).href;
    import(/* @vite-ignore */ url).then(m => { if (m && typeof m.obstaclesNear === 'function') { obstaclesNear = m.obstaclesNear; propQ.x = Infinity; } }).catch(() => {});
  }
  function refreshProps(hx, hz, custom) {
    propQ.x = hx; propQ.z = hz; propQ.list.length = 0;
    for (const b of propBatches.values()) b.n = 0;
    let list = custom;
    if (!list) {
      list = EMPTY;
      if (obstaclesNear) { try { list = obstaclesNear(stageId, hx, hz, Math.min(48, Math.max(ext.halfW, ext.halfH) + 6)) || EMPTY; } catch (e) { list = EMPTY; } }
    }
    for (let i = 0; i < list.length; i++) {
      const o = list[i]; if (!o) continue;
      const def = PROP_DEFS[o.kind] || PROP_DEFS.rock;
      let sd = typeof o.seed === 'number' ? o.seed : (o.x * 73.1 + o.z * 19.7);
      sd = (sd > 0 && sd < 1) ? Math.floor(sd * 1e6) : Math.floor(sd);
      const vi = def.variants.length > 1 ? Math.floor(hash1(sd + 5) * def.variants.length) : 0, key = (PROP_DEFS[o.kind] ? o.kind : 'rock') + ':' + vi;
      let b = propBatches.get(key);
      if (!b) { const g = GB(); def.variants[vi](g); b = makeCharBatch(keep(g.build()), matProp, 220, def, false); propBatches.set(key, b); scene.add(b.mesh); }
      const sc = clamp(num(o.r, def.r) / def.r, 0.6, 2.4) * (0.92 + 0.2 * hash1(sd + 1));
      const rot = def.face ? (hash1(sd + 2) - 0.5) * 0.9 : hash1(sd + 2) * TAU, lean = def.light ? 0 : (hash1(sd + 3) - 0.5) * 0.14;
      putChar(b, o.x, 0, o.z, rot, sc, sc * (0.92 + 0.18 * hash1(sd + 4)), sc, lean, 0, 0, 0, 1, 0, 0, 0, 0);
      const rec = { x: o.x, z: o.z, sh: def.shadow * sc, def, seed: hash1(sd + 9) * 100, lx: o.x, ly: 0, lz: o.z, sc };
      if (def.light) { const c = Math.cos(rot), s = Math.sin(rot); rec.lx = o.x + def.light.x * c * sc; rec.lz = o.z - def.light.x * s * sc; rec.ly = def.light.y * sc; }
      propQ.list.push(rec);
    }
    for (const b of propBatches.values()) b.commit();
  }
  function refreshDecals(hx, hz) {
    propQ.dx = hx; propQ.dz = hz; decals.n = 0;
    const dens = Q.decals;
    if (dens > 0) {
      const C = 4, rx = Math.min(44, ext.halfW + 8), rzT = Math.min(52, ext.top + 10), rzB = Math.min(40, ext.bottom + 10);
      const x0 = Math.floor((hx - rx) / C), x1 = Math.floor((hx + rx) / C), z0 = Math.floor((hz - rzT) / C), z1 = Math.floor((hz + rzB) / C);
      const D = decals.aD, E = decals.aE, sk = stageId.length * 131;
      for (let cz = z0; cz <= z1; cz++) for (let cx = x0; cx <= x1; cx++) {
        const h = hash2(cx + sk, cz - sk);
        if (h > 0.62 * dens || decals.n >= decals.cap) continue;
        const o = decals.n++ * 4, h2 = hash2(cx * 3 + 11, cz * 7 + 5), h3 = hash2(cx * 5 + 3, cz * 3 + 17), cell = DECAL_PICK[Math.floor(h3 * DECAL_PICK.length) % DECAL_PICK.length];
        D[o] = (cx + 0.15 + h2 * 0.7) * C; D[o + 1] = (cz + 0.15 + h3 * 0.7) * C; D[o + 2] = h * 37; D[o + 3] = (0.6 + h2 * 0.8) * DECAL_SIZE[cell];
        E[o] = cell % 4; E[o + 1] = Math.floor(cell / 4); E[o + 2] = 0.85 + h2 * 0.3; E[o + 3] = 0.7 + h3 * 0.3;
      }
    }
    decals.commit();
  }

  /* ---- stage ---- */
  function setStage(id) {
    if (!STAGES[id]) id = 'graveyard';
    if (id === stageId) return;
    stageId = id; S = STAGES[id];
    let tx2 = stageTex.get(id);          // generated once per stage, then cached (stage select flips between them)
    if (!tx2) { const g = paintGround(id, lowEnd ? 256 : 512); g.anisotropy = maxAniso; const d = makeDecalAtlas(id); d.flipY = false; d.needsUpdate = true; tx2 = { g, d }; stageTex.set(id, tx2); }
    groundTex = tx2.g; decalTex = tx2.d;
    const gu = groundMat.uniforms;
    gu.uMap.value = groundTex; gu.uTile.value = S.tile; gu.uLava.value.fromArray(S.lava); gu.uGroundFx.value.fromArray(S.gfx); gu.uAurora.value.fromArray(S.aurora);
    decalMat.uniforms.uMap.value = decalTex;
    U.uAmbSky.value.fromArray(S.sky); U.uAmbGnd.value.fromArray(S.gnd); U.uKeyCol.value.fromArray(S.key); U.uFogCol.value.fromArray(S.fog);
    U.uFog.value.set(S.fogNear, S.fogFar, S.fogMax, 0.5); U.uHeroLight.value.set(S.hero[0], S.hero[1], S.hero[2], S.heroR); U.uRimCol.value.fromArray(S.rim);
    scene.background.setRGB(S.fog[0], S.fog[1], S.fog[2]);
    const mu = moteMat.uniforms; mu.uVel.value.fromArray(S.mote.vel); mu.uMoteCol.value.fromArray(S.mote.col); mu.uBox.value.set(48, S.mote.h, 66, S.mote.size);
    cardMat.uniforms.uFogCard.value.fromArray(S.card); cardMat.uniforms.uDrift.value.set(S.drift[0], S.drift[1]);
    overMat.uniforms.uVig.value.set(0.5, 1.2, S.vig, 0);
    for (const b of propBatches.values()) { b.n = 0; b.commit(); }
    propQ.x = Infinity; propQ.dx = Infinity;
  }
  function setHero(id) {
    if (!HERO_DEFS[id]) id = 'knight';
    if (id === heroId) return;
    if (hero) scene.remove(hero.root);
    hero = heroRigs.get(id);
    if (!hero) { hero = makeHeroRig(id, matHero, matXray); heroRigs.set(id, hero); hero.root.scale.setScalar(HERO_VIS); }
    heroId = id; scene.add(hero.root); hero.deathT = 0;
    if (ghosts) { scene.remove(ghosts.mesh); ghosts.mesh.dispose(); }
    ghosts = makeGhostBatch(hero.ghostGeo, ghostMat, 10); scene.add(ghosts.mesh);
  }

  /* ---- particles ---- */
  const PC = 1400, PF = 19;
  const pa = []; for (let i = 0; i < PF; i++) pa.push(new Float32Array(PC));
  const [ppx, ppy, ppz, pvx, pvy, pvz, plife, pmax, psz, psz2, pr, pg, pb, pcell, padd, pgrav, pdrag, prot, pspin] = pa;
  let pn = 0, pcur = 0;
  function emit(x, y, z, vx, vy, vz, life, size, size2, r, g, b, cell, add = 1, grav = 0, drag = 0, spin = 0) {
    let i; const cap = Q.particles;
    if (pn < cap) i = pn++; else { pcur = (pcur + 1) % cap; i = pcur; }
    ppx[i] = x; ppy[i] = y; ppz[i] = z; pvx[i] = vx; pvy[i] = vy; pvz[i] = vz; plife[i] = life; pmax[i] = life; psz[i] = size; psz2[i] = size2;
    pr[i] = r; pg[i] = g; pb[i] = b; pcell[i] = cell; padd[i] = add; pgrav[i] = grav; pdrag[i] = drag; prot[i] = Math.random() * TAU; pspin[i] = spin;
  }
  function updateParticles(dt) {
    if (pn > Q.particles) pn = Q.particles;
    for (let i = 0; i < pn;) {
      plife[i] -= dt;
      if (plife[i] <= 0) { pn--; if (i !== pn) for (let k = 0; k < PF; k++) pa[k][i] = pa[k][pn]; continue; }
      const dr = 1 - pdrag[i] * dt;
      pvx[i] *= dr; pvz[i] *= dr; pvy[i] = pvy[i] * dr - pgrav[i] * dt;
      ppx[i] += pvx[i] * dt; ppy[i] += pvy[i] * dt; ppz[i] += pvz[i] * dt;
      if (ppy[i] < 0.04) { ppy[i] = 0.04; pvy[i] *= -0.35; pvx[i] *= 0.6; pvz[i] *= 0.6; }
      prot[i] += pspin[i] * dt;
      const k = plife[i] / pmax[i], a = k < 0.35 ? k / 0.35 : 1;
      spush(ppx[i], ppy[i], ppz[i], lerp(psz2[i], psz[i], k), pr[i], pg[i], pb[i], a, pcell[i], prot[i], padd[i], 1);
      i++;
    }
  }
  const rnd = (a = 1) => (Math.random() - 0.5) * 2 * a;
  function burst(n, x, y, z, speed, up, life, size, col, cell, add = 1, grav = 0, drag = 1.5, spin = 0, size2 = 0) {
    n = Math.max(1, Math.round(n * (0.4 + 0.6 * Q.particles / 1400)));
    for (let i = 0; i < n; i++) {
      const a = Math.random() * TAU, s = speed * (0.35 + Math.random() * 0.65);
      emit(x + rnd(0.15), y + rnd(0.15), z + rnd(0.15), Math.cos(a) * s, up * (0.4 + Math.random() * 0.8), Math.sin(a) * s, life * (0.6 + Math.random() * 0.6), size * (0.7 + Math.random() * 0.6), size2, col[0], col[1], col[2], cell, add, grav, drag, spin ? rnd(spin) : 0);
    }
  }

  /* ---- timed fx pool ---- */
  const FXN = 200, fxs = []; for (let i = 0; i < FXN; i++) fxs.push({ on: false, type: 0, t: 0, life: 1, x: 0, y: 0, z: 0, x2: 0, y2: 0, z2: 0, r: 1, g: 1, b: 1, a: 1, s0: 0, s1: 1, p1: 0, p2: 0, seed: 0, rot: 0 });
  let fxCur = 0;
  const FX = { RING: 0, DISC: 1, SCORCH: 2, RUNE: 3, SLASH: 4, BEAM: 5, BOLT: 6, GLOW: 7, CHEST: 8, PILLAR: 9, IMPLODE: 10 };
  function fx(type, x, y, z, life, col, s0, s1, a = 1, p1 = 0, p2 = 0) {
    let f = null;
    for (let k = 0; k < FXN; k++) { fxCur = (fxCur + 1) % FXN; if (!fxs[fxCur].on) { f = fxs[fxCur]; break; } }
    if (!f) { fxCur = (fxCur + 1) % FXN; f = fxs[fxCur]; }
    f.on = true; f.type = type; f.t = 0; f.life = life; f.x = x; f.y = y; f.z = z; f.r = col[0]; f.g = col[1]; f.b = col[2]; f.a = a; f.s0 = s0; f.s1 = s1; f.p1 = p1; f.p2 = p2; f.seed = Math.random() * 100; f.rot = 0;
    return f;
  }
  function bolt(x1, y1, z1, x2, y2, z2, w, r, g, b, a, seed, jit) {
    const dx = x2 - x1, dy = y2 - y1, dz = z2 - z1, len = Math.hypot(dx, dy, dz), n = clamp(Math.ceil(len / 1.1), 2, 12);
    const st = Math.floor(time * 28);
    let px = x1, py = y1, pz = z1;
    for (let i = 1; i <= n; i++) {
      const k = i / n; let qx = x1 + dx * k, qy = y1 + dy * k, qz = z1 + dz * k;
      if (i < n) { const j = jit * Math.sin(k * PI); qx += (hash2(seed + i, st) - 0.5) * 2 * j; qz += (hash2(seed + i + 31, st) - 0.5) * 2 * j; qy += (hash2(seed + i + 67, st) - 0.5) * j; }
      lpush(px, py, pz, qx, qy, qz, w, r, g, b, a, 1);
      px = qx; py = qy; pz = qz;
    }
  }
  function updateFx(dt) {
    for (let i = 0; i < FXN; i++) {
      const f = fxs[i]; if (!f.on) continue;
      f.t += dt; const k = f.t / f.life;
      if (k >= 1) { f.on = false; continue; }
      const e = easeOut(k), fade = 1 - k;
      switch (f.type) {
        case FX.RING: { const R = f.s1; gpush(f.x, f.y, f.z, 0, R, R, 0, 0, f.r, f.g, f.b, f.a * fade * fade, lerp(f.s0 / R, 0.96, e), f.p1 || 0.08, f.p2); break; }
        case FX.IMPLODE: { const R = f.s0; gpush(f.x, f.y, f.z, 0, R, R, 0, 0, f.r, f.g, f.b, f.a * sat(k * 3) * fade, lerp(0.96, f.s1 / R, e), 0.07, 0); break; }
        case FX.DISC: { const R = lerp(f.s0, f.s1, e); gpush(f.x, f.y, f.z, 0, R, R, 1, 0, f.r, f.g, f.b, f.a * fade * fade, f.p1 || 1.4, 0, f.p2); break; }
        case FX.SCORCH: gpush(f.x, 0.025, f.z, f.seed, f.s0, f.s0, 8, 0, f.r, f.g, f.b, f.a * sat(fade * 3.5), Math.max(0, 1 - f.t / 1.6), 0, 0, f.seed); break;
        case FX.RUNE: gpush(f.x, f.y, f.z, f.seed, f.s0, f.s0, 10, f.p2 ? sat(k * 1.15) : 0, f.r, f.g, f.b, f.a * sat(k * 6) * sat(fade * 4), f.p1, 0, 0.25, f.seed); break;
        case FX.SLASH: gpush(f.x, f.y, f.z, f.rot, f.s0, f.s0, 11, k, f.r, f.g, f.b, f.a, f.p1, 0, 0, f.seed); break;
        case FX.BEAM: lpush(f.x, f.y, f.z, f.x2, f.y2, f.z2, f.s0 * (1 - k * 0.6), f.r, f.g, f.b, f.a * fade, 2); break;
        case FX.PILLAR: lpush(f.x, 0, f.z, f.x, f.s1 * (0.35 + 0.65 * e), f.z, f.s0 * (1 - k * 0.5), f.r, f.g, f.b, f.a * sat(fade * 2.2), 3); break;
        case FX.BOLT: bolt(f.x, f.y, f.z, f.x2, f.y2, f.z2, f.s0, f.r, f.g, f.b, f.a * (0.4 + 0.6 * fade), f.seed, f.p1); break;
        case FX.GLOW: spush(f.x, f.y, f.z, lerp(f.s0, f.s1, e), f.r, f.g, f.b, f.a * fade * fade, SP.GLOW, 0, 1, 1); break;
        case FX.CHEST: {
          const open = smooth(k * 4), sink = k > 0.75 ? (k - 0.75) * 4 : 0, y = -sink * 0.6, c = Math.cos(f.rot), s = Math.sin(f.rot);
          putChar(chestBase, f.x, y, f.z, f.rot, 1.2, 1.2, 1.2, 0, 0, 0, 0, 1 - sink, 0, 0, 0, 0);
          putChar(chestLid, f.x - s * 0.36, y + 0.53, f.z - c * 0.36, f.rot, 1.2, 1.2, 1.2, -1.9 * open, 0, 0, 0, 1 - sink, 0, 0, 0, 0);
          lpush(f.x, 0.5, f.z, f.x, 0.5 + 7 * open, f.z, 1.6, 1.0, 0.82, 0.35, 0.9 * (1 - k), 3);
          spush(f.x, 0.8, f.z, 2.6, 1.0, 0.8, 0.3, 0.7 * (1 - k), SP.GLOW);
          break;
        }
      }
    }
  }

  /* ---- floating numbers / text ---- */
  const TN = 110, tx = [];
  for (let i = 0; i < TN; i++) tx.push({ on: false, x: 0, y: 0, z: 0, t: 0, life: 1, size: 1, r: 1, g: 1, b: 1, n: 0, d: new Int8Array(8), row: -1, w: 1, vx: 0, crit: 0 });
  let txCur = 0, liveTexts = 0;
  function allocText() { for (let k = 0; k < TN; k++) { txCur = (txCur + 1) % TN; if (!tx[txCur].on) return tx[txCur]; } txCur = (txCur + 1) % TN; return tx[txCur]; }
  function spawnNumber(x, z, val, col, crit, prefix) {
    const t = allocText(); let v = Math.round(Math.abs(val)), n = 0; const d = t.d;
    let suffixK = false; if (v >= 100000) { v = Math.round(v / 1000); suffixK = true; }
    const s = String(v);
    if (prefix) d[n++] = GLYPHS.indexOf(prefix);
    for (let i = 0; i < s.length && n < 7; i++) d[n++] = s.charCodeAt(i) - 48;
    if (suffixK && n < 8) d[n++] = 10;
    if (crit && n < 8) d[n++] = 13;
    t.on = true; t.n = n; t.row = -1; t.x = x + rnd(0.35); t.y = 1.7; t.z = z + rnd(0.2); t.t = 0; t.life = crit ? 0.95 : 0.7; t.crit = crit ? 1 : 0;
    t.size = crit ? 1.45 : 1; t.r = col[0]; t.g = col[1]; t.b = col[2]; t.vx = rnd(0.6);
  }
  function spawnText(x, z, str, col) {
    str = String(str).slice(0, 14); const A = textAtlas; let row = -1;
    for (let i = 0; i < A.rows.length; i++) if (A.rows[i] && A.rows[i].s === str) { row = i; break; }
    if (row < 0) {
      row = A.next; A.next = (A.next + 1) % 6;
      const g = A.g, y = 128 + row * 64;
      g.clearRect(0, y, 512, 64); g.font = `900 40px ${TEXT_FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.lineJoin = 'round';
      g.strokeStyle = '#000'; g.lineWidth = 8; g.strokeText(str, 256, y + 33, 500); g.fillStyle = '#fff'; g.fillText(str, 256, y + 33, 500);
      A.rows[row] = { s: str, w: Math.min(500, g.measureText(str).width + 14) }; A.tex.needsUpdate = true;
      for (let i = 0; i < TN; i++) if (tx[i].on && tx[i].row === row) tx[i].on = false;
    }
    const t = allocText();
    t.on = true; t.n = 0; t.row = row; t.w = A.rows[row].w; t.x = x; t.y = 2.3; t.z = z; t.t = 0; t.life = 1.3; t.size = 1.25; t.crit = 0; t.vx = 0;
    t.r = col[0]; t.g = col[1]; t.b = col[2];
  }
  function parseColor(c, out) {
    out[0] = out[1] = out[2] = 1;
    if (Array.isArray(c)) { out[0] = num(c[0], 1); out[1] = num(c[1], 1); out[2] = num(c[2], 1); return out; }
    if (typeof c === 'number' && c === c) _c1.setHex(c & 0xffffff);
    else if (typeof c === 'string' && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(c)) _c1.set(c);
    else if (typeof c === 'string' && (/^(rgb|hsl)a?\([\d\s.,%/-]+\)$/i.test(c) || THREE.Color.NAMES[c.toLowerCase()] !== undefined)) { try { _c1.set(c); } catch (e) { return out; } }
    else if (c && c.isColor) _c1.copy(c);
    else return out;
    out[0] = _c1.r; out[1] = _c1.g; out[2] = _c1.b; return out;
  }
  function updateTexts(dt) {
    const unit = (2 * cam.dist * Math.tan(BASE_FOV * PI / 360)) / Math.max(200, cssH);       // world units per css px at the hero
    const base = clamp(Math.min(cssW, cssH) * 0.044, 15, 26) * unit, ADV = 0.56;
    const P = texts.aPos, Rr = texts.aRect, C = texts.aCol, Vv = texts.aV;
    liveTexts = 0;
    for (let i = 0; i < TN; i++) {
      const t = tx[i]; if (!t.on) continue;
      liveTexts++;
      t.t += dt; const k = t.t / t.life;
      if (k >= 1) { t.on = false; continue; }
      const pop = 1 + (t.crit ? 0.9 : 0.45) * Math.max(0, 1 - t.t * 7), h = base * t.size * pop, a = k > 0.65 ? (1 - k) / 0.35 : 1;
      const y = t.y + (1 - (1 - k) * (1 - k)) * 1.5, x = t.x + t.vx * k;
      if (t.row >= 0) {
        if (texts.n >= texts.cap) break; const o = texts.n++ * 4, o2 = (texts.n - 1) * 2, wq = t.w / 64, yp = 128 + t.row * 64;
        P[o] = x; P[o + 1] = y; P[o + 2] = t.z; P[o + 3] = h; Rr[o] = -wq / 2; Rr[o + 1] = wq; Rr[o + 2] = (256 - t.w / 2) / 512; Rr[o + 3] = (256 + t.w / 2) / 512;
        C[o] = t.r; C[o + 1] = t.g; C[o + 2] = t.b; C[o + 3] = a; Vv[o2] = (yp + 64) / 512; Vv[o2 + 1] = yp / 512;
      } else {
        for (let j = 0; j < t.n; j++) {
          if (texts.n >= texts.cap) break; const gl = t.d[j]; if (gl < 0) continue;
          const o = texts.n++ * 4, o2 = (texts.n - 1) * 2, col = gl % 8, row = gl >> 3;
          P[o] = x; P[o + 1] = y; P[o + 2] = t.z; P[o + 3] = h; Rr[o] = (j - (t.n - 1) / 2) * ADV - 0.5; Rr[o + 1] = 1; Rr[o + 2] = col / 8; Rr[o + 3] = (col + 1) / 8;
          C[o] = t.r; C[o + 1] = t.g; C[o + 2] = t.b; C[o + 3] = a; Vv[o2] = (row + 1) / 8; Vv[o2 + 1] = row / 8;
        }
      }
    }
  }

  /* ---- corpses (dissolving copies of killed enemies) + dash after-images ---- */
  const CN = 56, corpses = []; for (let i = 0; i < CN; i++) corpses.push({ on: false, b: null, x: 0, z: 0, y: 0, rot: 0, sc: 1, t: 0 });
  let corpseCur = 0;
  const GN = 10, gh = []; for (let i = 0; i < GN; i++) gh.push({ on: false, x: 0, z: 0, rot: 0, t: 0 });
  let ghCur = 0, ghTimer = 0, ghPrevX = 0, ghPrevZ = 0;

  /* ---- bosses ---- */
  const bossRigs = new Map(), bossPool = {}, bossList = [];
  function getBossRig(e) {
    let rig = bossRigs.get(e.id);
    if (!rig) {
      const pool = bossPool[e.type] || (bossPool[e.type] = []);
      rig = pool.pop();
      if (!rig) { if (bossList.length >= 8) return null; rig = makeBossRig(e.type, makeLit({ rim: 0.9, emi: 1.25 })); }
      rig.id = e.id; rig.t = 0; bossRigs.set(e.id, rig); bossList.push(rig); scene.add(rig.root);
    }
    rig.seen = frame; return rig;
  }

  /* ---- camera update ---- */
  function shake(a) { cam.shake = Math.min(1.6, Math.max(cam.shake, num(a, 0.3))); }
  function flash(color, amount) { const u = overMat.uniforms.uFlash.value, c = parseColor(color, [1, 1, 1]); u.x = c[0]; u.y = c[1]; u.z = c[2]; flashA = Math.max(flashA, clamp(num(amount, 0.3), 0, 1)); }
  function updateCamera(dt, px, pz, mx, mz) {
    const k = 1 - Math.exp(-dt * 3.2);
    cam.lx += (mx * 1.5 - cam.lx) * k; cam.lz += (mz * 1.5 - cam.lz) * k;
    const gx = px + cam.lx, gz = pz + cam.lz;
    if (!cam.init || Math.abs(gx - cam.tx) + Math.abs(gz - cam.tz) > 40) { cam.tx = gx; cam.tz = gz; cam.init = true; }
    const kf = 1 - Math.exp(-dt * 9);
    cam.tx += (gx - cam.tx) * kf; cam.tz += (gz - cam.tz) * kf;
    cam.shake = Math.max(0, cam.shake - dt * 2.6); cam.punch += (0 - cam.punch) * (1 - Math.exp(-dt * 7));
    const ss = clamp(num(view.shakeScale, 1), 0, 3), sh = cam.shake * cam.shake * 0.5 * ss;
    cam.sx = Math.sin(time * 71) * sh + Math.sin(time * 113) * sh * 0.5; cam.sz = Math.cos(time * 83) * sh;
    const fov = BASE_FOV + cam.punch * Math.min(1, ss);
    if (Math.abs(fov - camera.fov) > 0.01) { camera.fov = fov; camera.updateProjectionMatrix(); }
    camera.position.set(cam.tx + cam.sx, cam.dist * SINP, cam.tz + cam.dist * COSP + cam.sz);
    camera.lookAt(cam.tx + cam.sx, 0, cam.tz + cam.sz);
    if (dbgCam) { camera.position.set(dbgCam.x, dbgCam.y, dbgCam.z); camera.lookAt(dbgCam.tx, dbgCam.ty, dbgCam.tz); if (dbgCam.fov && camera.fov !== dbgCam.fov) { camera.fov = dbgCam.fov; camera.updateProjectionMatrix(); } }
    camera.updateMatrixWorld();
  }

  /* ---- static world dressing drawn every frame: prop shadows, lights, flames ---- */
  const lightSel = [null, null, null, null, null, null], lightD = new Float32Array(6);
  function drawProps(hx, hz, extraLight) {
    const L = propQ.list; let nl = 0;
    for (let i = 0; i < 6; i++) { lightSel[i] = null; lightD[i] = 1e9; }
    if (extraLight) { lightSel[0] = extraLight; lightD[0] = -1; nl = 1; }
    for (let i = 0; i < L.length; i++) {
      const p = L[i], dx = p.x - hx, dz = p.z - hz, d2 = dx * dx + dz * dz;
      if (d2 > 1700) continue;
      shpush(p.x, p.z, p.sh, 0.5);
      const def = p.def;
      if (def.light) {
        // keep the 6 nearest lights
        let j = 5; if (d2 < lightD[5]) { while (j > 0 && lightD[j - 1] > d2) { lightD[j] = lightD[j - 1]; lightSel[j] = lightSel[j - 1]; j--; } lightD[j] = d2; lightSel[j] = p; }
        const fl = 0.85 + 0.15 * Math.sin(time * 9 + p.seed) * Math.sin(time * 5.3 + p.seed * 2), c = def.light.col;
        spush(p.lx, p.ly, p.lz, def.glow * 2.2 * p.sc, c[0], c[1], c[2], 0.3 * fl, SP.GLOW);
        if (def.flame) {
          const f = def.flame, fc = f.col, s = f.s * p.sc;
          for (let k = 0; k < 3; k++) {
            const ph = time * (2.2 + k * 0.7) + p.seed + k * 2.1, u = ph - Math.floor(ph);
            spush(p.x + Math.sin(ph * 3 + k) * 0.08 * s, f.y * p.sc + u * 0.75 * s, p.z + 0.02 * k, s * (0.95 - u * 0.55), fc[0] * 1.15, fc[1] * 1.15, fc[2] * 1.15, (1 - u) * 0.9, SP.FLAME, Math.sin(ph * 5) * 0.2, 1, 1.25);
          }
          if (Q.particles > 300 && ((frame + i * 7) % 23) === 0 && d2 < 600) emit(p.x + rnd(0.2), f.y * p.sc + 0.3, p.z + rnd(0.2), rnd(0.4), 1.2 + Math.random(), rnd(0.4), 0.9 + Math.random() * 0.6, 0.12, 0.02, fc[0] * 1.5, fc[1] * 1.5, fc[2] * 1.5, SP.SPARK, 1, -0.3, 0.6);
        }
      }
    }
    for (let i = 0; i < 6; i++) {
      const p = lightSel[i], pl = U.uPL.value[i], pc = U.uPLC.value[i];
      if (!p) { pl.set(0, -100, 0, 1); pc.set(0, 0, 0); continue; }
      const li = p.def.light, fl = 0.86 + 0.14 * Math.sin(time * 9 + p.seed) * Math.sin(time * 5.3 + p.seed * 2);
      const w = (lightD[i] < 0 ? 1 : sat((1500 - lightD[i]) / 500)) * li.k * fl;
      pl.set(p.lx, p.ly + 0.4, p.lz, li.r * p.sc); pc.set(li.col[0] * w, li.col[1] * w, li.col[2] * w);
    }
  }

  /* ---- hero ---- */
  const heroSt = { speed: 0, moving: false, dash: 0, t: 0, dt: 0 };
  function drawHero(pl, dt) {
    if (!hero) return;
    const r = hero.root, alive = pl.alive !== false;
    heroSt.speed = num(pl.speed, 0); heroSt.moving = !!(pl.moveX || pl.moveZ) && alive && !simPaused; heroSt.dash = num(pl.dashing, 0); heroSt.t = time; heroSt.dt = dt;
    animateHero(hero, heroSt);
    if (!alive) hero.deathT = Math.min(1, hero.deathT + dt / 0.9); else hero.deathT = Math.max(0, hero.deathT - dt * 4);
    const d = hero.deathT, fall = smooth(d * 1.6);
    r.position.set(pl.x, -0.25 * smooth(d * 1.2 - 0.3), pl.z); r.rotation.set(-fall * 1.45, num(pl.rot, 0), 0, 'YXZ');
    const fxU = matHero.uniforms.uFx.value, tU = matHero.uniforms.uTint.value, hurt = sat(num(pl.hurt, 0));
    fxU.z = hurt * 0.75; fxU.w = d > 0.45 ? 1 - (d - 0.45) / 0.55 * 0.999 : 1;
    const inv = num(pl.invuln, 0) > 0 && !heroSt.dash;
    tU.set(1, 0.25, 0.2, hurt * 0.6);
    matHero.uniforms.uAlpha.value = 1; r.visible = !(inv && (frame & 3) === 0 && hurt < 0.05) && d < 0.999;
    const ac = hero.def.accent;
    if (!Q.shadow) shpush(pl.x, pl.z, 0.72, 0.62 * (1 - d)); else shpush(pl.x, pl.z, 0.6, 0.3 * (1 - d));
    // readable hero marker: soft warm pool + thin class-coloured ring
    gpush(pl.x, 0.045, pl.z, 0, 2.3, 2.3, 1, 0, 1.0, 0.86, 0.62, 0.2 * (1 - d), 1.3, 0, 0);
    gpush(pl.x, 0.05, pl.z, 0, 1.3, 1.3, 14, 0, ac[0], ac[1], ac[2], (0.9 + 0.1 * Math.sin(time * 3)) * (1 - d), 0.7, 0.1, 0);
    spush(pl.x, 1.1, pl.z, 3.6, ac[0], ac[1], ac[2], 0.2 * (1 - d), SP.GLOW);
    matXray.uniforms.uXray.value.set(ac[0], ac[1], ac[2], 0.75 * (1 - d));
    if (alive) lpush(pl.x, 2.3, pl.z, pl.x, 10.5, pl.z, 1.3, ac[0], ac[1], ac[2], 0.2, 3);          // faint shaft of light: finds the hero in a crowd
    if (pl.shield > 0 && alive) { putGhost(bubbles, pl.x, 1.0, pl.z, 0, 1.2, 0.45, 0.7, 1.0, 0.16 + 0.04 * Math.sin(time * 4)); gpush(pl.x, 0.052, pl.z, 0, 1.75, 1.75, 14, 0, 0.5, 0.78, 1.0, 0.55, 0.2, 0.04, 0); }
    // dash after-images
    if (heroSt.dash > 0 && dt > 0) {
      // one ghost per 0.03 s of travel; on slow frames fill in the path since the last frame (max 3) so the trail does not thin out
      const dx = pl.x - ghPrevX, dz = pl.z - ghPrevZ, far = Math.abs(dx) + Math.abs(dz) > 8;
      const n = far ? 1 : clamp(Math.round(dt / 0.03), 1, 3);
      ghTimer -= dt;
      if (ghTimer <= 0) { ghTimer = 0.03; for (let k = 1; k <= n; k++) { ghCur = (ghCur + 1) % GN; const g = gh[ghCur], u = k / n; g.on = true; g.x = far ? pl.x : ghPrevX + dx * u; g.z = far ? pl.z : ghPrevZ + dz * u; g.rot = num(pl.rot, 0); g.t = (1 - u) * Math.min(dt, 0.1); } }
    } else if (heroSt.dash <= 0) ghTimer = 0;
    ghPrevX = pl.x; ghPrevZ = pl.z;
    for (let i = 0; i < GN; i++) {
      const g = gh[i]; if (!g.on) continue; g.t += dt; if (g.t > 0.32) { g.on = false; continue; }
      const a = (1 - g.t / 0.32); putGhost(ghosts, g.x, 0, g.z, g.rot, HERO_VIS, ac[0], ac[1], ac[2], a * a * 0.8);
    }
  }
  function putGhost(b, x, y, z, rot, sc, r, g, bl, a) {
    if (!b || b.n >= b.cap) return; const i = b.n;
    putChar(b, x, y, z, rot, sc, sc, sc, 0, 0, 0, 0, 1, 0, 0, 0, 0);
    const o = i * 4; b.g[o] = r; b.g[o + 1] = g; b.g[o + 2] = bl; b.g[o + 3] = a;
  }

  /* ---- events ---- */
  const ALLY_C1 = [0.4, 0.8, 1.0], ALLY_C2 = [0.35, 1.0, 0.7], CRIT_COL = [1.0, 0.86, 0.2], SMOKE_D = [0.07, 0.065, 0.075], SMOKE_E = [0.09, 0.08, 0.08], DUST = [0.2, 0.19, 0.18], RING_D = [0.8, 0.8, 0.75];
  const BOMB_C = [1, 0.92, 0.75];
  const _tc = [1, 1, 1], WHITE = [1, 1, 1], GOLD = [1.0, 0.82, 0.35], RED = [1.0, 0.25, 0.2], ASH = [0.16, 0.15, 0.17], EMBER = [1.0, 0.5, 0.12], GREEN = [0.4, 1.0, 0.5];
  const PICK_COL = { xp_s: [0.3, 0.65, 1.0], xp_m: [0.3, 1.0, 0.6], xp_l: [1.0, 0.3, 0.35], gold: [1.0, 0.8, 0.25], heart: [1.0, 0.3, 0.4], magnet: [0.5, 0.75, 1.0], bomb: [1.0, 0.8, 0.5], chest: GOLD };
  let sparkBudget = 0, pickBudget = 0;
  function hitSparks(x, z, kind, big) {
    const c = kcol(kind), y = 0.9, n = big ? 5 : 3;
    switch (kind) {
      case 'fire': burst(n, x, y, z, 1.6, 2.2, 0.45, 0.22, c, SP.SPARK, 1, -1.5, 1.5); break;
      case 'frost': burst(n, x, y, z, 3.2, 1.5, 0.4, 0.2, c, SP.SHARD, 1, 6, 2, 8); break;
      case 'light': burst(n - 1, x, y, z, 4.5, 1, 0.22, 0.3, c, SP.GLINT, 1, 0, 4, 6); break;
      case 'poison': burst(n - 1, x, y, z, 1.2, 1.6, 0.55, 0.2, c, SP.BUBBLE, 0.8, -0.8, 1.5); break;
      case 'holy': burst(n - 1, x, y, z, 1.5, 2.4, 0.5, 0.26, c, SP.PLUS, 1, -0.5, 2, 3); break;
      case 'dark': burst(n - 1, x, y, z, 1.6, 1.4, 0.5, 0.4, c, SP.SMOKE, 0.7, -0.5, 2, 2); break;
      default: burst(n, x, y, z, 5, 2, 0.2, 0.2, c, SP.SPARK, 1, 9, 3);
    }
    if (big) spush(x, y, z, 1.5, c[0], c[1], c[2], 0.8, SP.GLINT, time * 3);
  }
  function killFx(e, x, z) {
    const sc = num(e.scale, 1), boss = !!e.boss, elite = !!e.elite;
    const n = boss ? 40 : elite ? 12 : 5;
    burst(n, x, 0.8 * sc, z, 2.2 + sc, 2.5, 0.75, 0.3 * Math.min(2.5, sc), ASH, SP.ASH, 0, 2.5, 1.8, 6);
    burst(Math.ceil(n * 0.8), x, 0.7 * sc, z, 1.6 + sc * 0.6, 2.6, 0.8, 0.16, EMBER, SP.SPARK, 1, -1.2, 1.2);
    if (Q.particles > 300) burst(boss ? 8 : 1, x, 0.6 * sc, z, 0.6, 1.2, 0.8, 0.9 * Math.min(2.5, sc), SMOKE_D, SP.SMOKE, 0, -0.4, 1.5, 1, 1.6 * Math.min(2.5, sc));
    const b = enemyBatches.get(e.enemy);
    if (b && !boss) { corpseCur = (corpseCur + 1) % CN; const c = corpses[corpseCur]; c.on = true; c.b = b; c.x = x; c.z = z; c.rot = num(e.rot, 0); c.sc = sc * VIS; c.t = 0; c.y = b.meta.fly ? b.meta.fly * sc * VIS : 0; }
    if (elite || boss) {
      const col = boss ? ((BOSS_DEFS[e.enemy] && BOSS_DEFS[e.enemy].col) || GOLD) : ELITE_DEFAULT;
      fx(FX.RING, x, 0.08, z, 0.6, col, 0.3, boss ? 14 : 4.5, 1, 0.1); fx(FX.DISC, x, 0.07, z, 0.5, col, 1, boss ? 9 : 3.4, 0.8);
      fx(FX.PILLAR, x, 0, z, boss ? 1.6 : 0.6, col, boss ? 4 : 1.4, boss ? 16 : 7, 1);
      if (boss) {
        for (let i = 0; i < 3; i++) { const f = fx(FX.RING, x, 0.08, z, 0.9 + i * 0.35, i ? WHITE : col, 0.5, 10 + i * 7, 0.9, 0.06); }
        burst(50, x, 1.5, z, 9, 6, 1.4, 0.3, col, SP.GLINT, 1, 3, 1.2, 5); burst(30, x, 1, z, 6, 5, 1.6, 0.5, ASH, SP.CHUNK, 0, 9, 0.8, 8);
        fx(FX.SCORCH, x, 0, z, 9, [0, 0, 0], 5 * Math.min(2, sc / 3), 0, 0.9); shake(1.3); flash(WHITE, 0.4); cam.punch = 5;
      } else shake(0.35);
    }
  }
  function handleEvents(events, state) {
    const pl = state.player || heroPos, px = num(pl.x, 0), pz = num(pl.z, 0);
    let nums = 0; sparkBudget = Math.round(6 + 14 * Q.particles / 1400); pickBudget = 8;
    let banner = false, bannerX = 0, bannerZ = 0;        // position of a boss arrival / evolution in this batch
    const numCap = 7;
    for (let i = 0; i < events.length; i++) {
      const e = events[i]; if (!e || typeof e !== 'object') continue;
      const ex = num(e.x, px), ez = num(e.z, pz);        // events without a (finite) position happen at the hero
      switch (e.type) {
        case 'hit': {
          const onP = e.target === 'p';
          if (sparkBudget > 0 || e.crit) { sparkBudget--; hitSparks(ex, ez, e.kind, e.crit || onP); }
          if (view.showDamageNumbers && e.dmg > 0 && ((nums < numCap && liveTexts < 44) || (e.crit && nums < 16) || onP)) {
            nums++; const kc = kcol(e.kind);
            if (onP) spawnNumber(ex, ez, e.dmg, RED, false, '-');
            else if (e.crit) spawnNumber(ex, ez, e.dmg, CRIT_COL, true);
            else { _tc[0] = 0.6 + 0.4 * kc[0]; _tc[1] = 0.6 + 0.4 * kc[1]; _tc[2] = 0.6 + 0.4 * kc[2]; spawnNumber(ex, ez, e.dmg, _tc, false); }
          }
          break;
        }
        case 'kill': killFx(e, ex, ez); break;
        case 'cast': if (hero && hero.atk < 0.35) { hero.atk = 1; hero.atkSide = -hero.atkSide; } break;
        case 'slash': {
          const c = e.kind === 'holy' ? KCOL.holy : e.kind === 'steel' ? KCOL.steel : kcol(e.kind), R = num(e.range, 2.5), arc = num(e.arc, 2);
          const f = fx(FX.SLASH, ex, 1.0, ez, arc > 6 ? 0.36 : 0.24, c, R, R, 1, arc); f.rot = num(e.rot, 0);
          if (e.kind === 'holy') { fx(FX.RING, ex, 0.07, ez, 0.4, c, R * 0.3, R * 1.05, 0.8, 0.07); burst(8, ex, 1, ez, R * 2.2, 1.5, 0.4, 0.26, c, SP.PLUS, 1, 0, 3, 3); }
          else if (Q.particles > 300) { const a = num(e.rot, 0); for (let k = 0; k < 3; k++) { const aa = a + rnd(arc * 0.4); emit(ex + Math.sin(aa) * R * 0.8, 1, ez + Math.cos(aa) * R * 0.8, Math.sin(aa) * 4, 1, Math.cos(aa) * 4, 0.2, 0.2, 0, c[0], c[1], c[2], SP.SPARK, 1, 4, 3); } }
          break;
        }
        case 'chain': {
          const pts = e.points; if (!Array.isArray(pts) || pts.length < 2) break; const c = kcol(e.kind || 'light');
          for (let k = 0; k < pts.length - 1 && k < 16; k++) {
            const a = pts[k], b = pts[k + 1]; if (!a || !b || !(a.x === a.x) || !(b.x === b.x) || !(a.z === a.z) || !(b.z === b.z) || a.x === undefined || b.x === undefined) continue;
            const f = fx(FX.BOLT, a.x, 1.1, a.z, 0.2, c, 0.24, 0, 0.85, 0.5); f.x2 = b.x; f.y2 = 1.0; f.z2 = b.z;
            fx(FX.GLOW, b.x, 1, b.z, 0.22, c, 1.6, 0.6, 0.9);
            if (sparkBudget-- > 0) burst(2, b.x, 1, b.z, 4, 1, 0.2, 0.26, c, SP.GLINT, 1, 0, 4, 6);
          }
          break;
        }
        case 'explode': {
          const R = num(e.r, 2), k = e.kind, c = kcol(k);
          fx(FX.DISC, ex, 0.08, ez, 0.32, c, R * 0.5, R * 1.25, 1.0, 1.1); fx(FX.RING, ex, 0.09, ez, 0.36, c, R * 0.2, R, 1, 0.1);
          fx(FX.GLOW, ex, 0.9, ez, 0.28, c, R * 1.4, R * 2.8, 0.75);
          if (k === 'poison') burst(6 + R * 2, ex, 0.5, ez, R * 2, 2.5, 0.6, 0.3, c, SP.DROP, 0.8, 8, 1.5);
          else if (k === 'frost') { burst(6 + R * 2, ex, 0.6, ez, R * 2.5, 2, 0.5, 0.3, c, SP.SHARD, 1, 7, 2, 8); }
          else { burst(5 + R * 3, ex, 0.6, ez, R * 2.2, 3, 0.55, 0.26, c, SP.SPARK, 1, 5, 2); if (Q.particles > 300) burst(2 + R, ex, 0.8, ez, R * 0.8, 1.5, 0.7, R * 0.7, SMOKE_E, SP.SMOKE, 0, -0.6, 1.5, 1, R * 1.3);
            if (k === 'fire' || k === 'meteor' || !k) fx(FX.SCORCH, ex, 0, ez, 5, c, R * 0.85, 0, 0.8); }
          shake(Math.min(0.5, 0.08 + R * 0.05));
          break;
        }
        case 'nova': {
          const R = num(e.r, 4), c = kcol(e.kind);
          fx(FX.RING, ex, 0.1, ez, 0.5, c, R * 0.1, R, 1, 0.16, 0.15); fx(FX.RING, ex, 0.1, ez, 0.62, WHITE, R * 0.05, R * 0.92, 0.5, 0.05);
          fx(FX.DISC, ex, 0.08, ez, 0.45, c, R * 0.4, R, 0.5, 0.6);
          const n = Math.round((8 + R * 2) * (0.4 + 0.6 * Q.particles / 1400));
          for (let k = 0; k < n; k++) { const a = k / n * TAU + rnd(0.2), s = R * 2.1; emit(ex, 0.5, ez, Math.cos(a) * s, 0.6, Math.sin(a) * s, 0.45, 0.3, 0.05, c[0], c[1], c[2], e.kind === 'frost' ? SP.SNOW : SP.SPARK, 1, 0, 1.2, 4); }
          shake(0.15);
          break;
        }
        case 'strike': {
          const R = num(e.r, 2), c = kcol(e.kind);
          if (e.kind === 'meteor') {
            fx(FX.DISC, ex, 0.08, ez, 0.5, [1, 0.6, 0.2], R * 0.6, R * 1.7, 1.3, 0.9); fx(FX.RING, ex, 0.09, ez, 0.5, c, R * 0.3, R * 1.5, 1, 0.12); fx(FX.RING, ex, 0.09, ez, 0.75, [1, 0.85, 0.5], R * 0.2, R * 2.2, 0.5, 0.05);
            fx(FX.GLOW, ex, 1.2, ez, 0.4, c, R * 2, R * 4.5, 1); fx(FX.PILLAR, ex, 0, ez, 0.45, c, R * 1.3, 7, 0.8);
            burst(14 + R * 4, ex, 0.6, ez, R * 3, 6, 0.9, 0.3, c, SP.SPARK, 1, 9, 1.2); burst(8, ex, 0.6, ez, R * 2, 5, 1.0, 0.4, [0.2, 0.15, 0.14], SP.CHUNK, 0, 12, 0.8, 9);
            if (Q.particles > 300) burst(5, ex, 1, ez, R, 2, 1.1, R, [0.1, 0.08, 0.07], SP.SMOKE, 0, -0.8, 1.2, 1, R * 1.8);
            fx(FX.SCORCH, ex, 0, ez, 7, c, R * 1.1, 0, 0.9); shake(0.7); cam.punch = Math.max(cam.punch, 1.6);
          } else {
            const f = fx(FX.BOLT, ex + rnd(2.5), 17, ez - 3, 0.24, c, 0.75, 0, 1, 0.9); f.x2 = ex; f.y2 = 0; f.z2 = ez;
            const f2 = fx(FX.BOLT, ex + rnd(1.5), 9, ez - 1.5, 0.16, WHITE, 0.3, 0, 0.8, 1.4); f2.x2 = ex + rnd(1); f2.y2 = 0; f2.z2 = ez + rnd(1);
            fx(FX.DISC, ex, 0.08, ez, 0.3, c, R * 0.5, R * 1.3, 1.1, 1.0); fx(FX.RING, ex, 0.09, ez, 0.32, c, R * 0.2, R, 0.9, 0.07); fx(FX.GLOW, ex, 0.8, ez, 0.22, c, R * 2, R * 3.2, 0.9);
            burst(6 + R * 2, ex, 0.4, ez, R * 3, 3, 0.3, 0.26, c, SP.GLINT, 1, 6, 3, 6); fx(FX.SCORCH, ex, 0, ez, 3.5, c, R * 0.55, 0, 0.6); shake(0.28);
          }
          break;
        }
        case 'spawn': {
          const bd = BOSS_DEFS[e.enemy];
          if (bd || (typeof e.enemy === 'string' && e.enemy.indexOf('boss_') === 0)) { banner = true; bannerX = ex; bannerZ = ez; }
          if (bd) {
            const c = bd.col; fx(FX.RUNE, ex, 0.06, ez, 2.4, c, 7, 0, 0.75, 2, 1);
            for (let k = 0; k < 3; k++) { const f = fx(FX.PILLAR, ex + rnd(2.5), 0, ez + rnd(2.5), 1.1 + k * 0.25, c, 1.8, 18, 0.5); }
            fx(FX.RING, ex, 0.08, ez, 1.0, c, 1, 13, 0.9, 0.08); fx(FX.RING, ex, 0.08, ez, 1.5, c, 0.5, 20, 0.4, 0.04); fx(FX.DISC, ex, 0.07, ez, 1.2, c, 2, 9, 0.35, 0.8);
            burst(40, ex, 0.5, ez, 5, 7, 1.5, 0.3, c, SP.SPARK, 1, 3, 0.8); burst(12, ex, 0.5, ez, 3, 3, 1.6, 1.6, [0.06, 0.05, 0.07], SP.SMOKE, 0, -0.5, 1, 1, 3);
            shake(1.0); flash(c, 0.16); cam.punch = 4;
          } else {
            const c = AFFIX_COL[e.affix] || ELITE_DEFAULT; fx(FX.RUNE, ex, 0.06, ez, 0.9, c, 1.8, 0, 0.9, 1, 1); fx(FX.PILLAR, ex, 0, ez, 0.7, c, 1.5, 8, 0.8);
            fx(FX.RING, ex, 0.08, ez, 0.5, c, 0.3, 3.2, 0.8, 0.07); burst(8, ex, 0.4, ez, 2, 3, 0.7, 0.24, c, SP.SPARK, 1, 2, 1);
          }
          break;
        }
        case 'bossPhase': {
          let bx = px, bz = pz, c = GOLD; const en = state.enemies || EMPTY;
          for (let k = 0; k < en.length; k++) if (en[k] && en[k].boss) { bx = en[k].x; bz = en[k].z; if (BOSS_DEFS[en[k].type]) c = BOSS_DEFS[en[k].type].col; break; }
          for (let k = 0; k < 3; k++) fx(FX.RING, bx, 0.09, bz, 0.8 + k * 0.3, k === 1 ? WHITE : c, 1, 12 + k * 6, 1, 0.09 - k * 0.02);
          fx(FX.DISC, bx, 0.08, bz, 0.7, c, 2, 11, 0.9, 0.7); fx(FX.GLOW, bx, 2, bz, 0.6, c, 6, 16, 0.8);
          burst(36, bx, 1.5, bz, 10, 4, 1.0, 0.3, c, SP.SPARK, 1, 2, 1.5); shake(0.9); flash(c, 0.28); cam.punch = 3;
          break;
        }
        case 'dash': {
          const a = num(e.rot, 0), sx = Math.sin(a), sz = Math.cos(a), ac = hero ? hero.def.accent : WHITE;
          fx(FX.RING, ex, 0.07, ez, 0.35, RING_D, 0.3, 1.8, 0.5, 0.1);
          burst(6, ex, 0.25, ez, 2.2, 0.8, 0.45, 0.5, DUST, SP.SMOKE, 0.15, -0.3, 2.5, 1, 1.0);
          for (let k = -1; k <= 1; k++) { const f = fx(FX.BEAM, ex - sx * 0.3 + sz * k * 0.3, 0.9, ez - sz * 0.3 - sx * k * 0.3, 0.25, ac, 0.3, 0, 0.7); f.x2 = f.x - sx * 2.6; f.y2 = 0.9; f.z2 = f.z - sz * 2.6; }
          break;
        }
        case 'pickup': {
          const k = e.kind, c = PICK_COL[k] || WHITE;
          if (k === 'chest') { const f = fx(FX.CHEST, ex, 0, ez, 1.5, GOLD, 1, 1); f.rot = 0; fx(FX.RING, ex, 0.08, ez, 0.7, GOLD, 0.4, 5, 1, 0.08); burst(18, ex, 0.9, ez, 3, 6, 1.0, 0.24, GOLD, SP.DOT, 1, 12, 0.6); burst(14, ex, 1, ez, 2, 4, 0.9, 0.36, [1, 0.95, 0.7], SP.GLINT, 1, 0, 1.5, 4); shake(0.2); }
          else if (k === 'bomb') { fx(FX.DISC, ex, 0.09, ez, 0.6, BOMB_C, 2, 22, 0.7, 0.6); fx(FX.RING, ex, 0.09, ez, 0.6, WHITE, 1, 20, 1, 0.07); fx(FX.RING, ex, 0.09, ez, 0.8, [1, 0.6, 0.2], 0.5, 16, 0.8, 0.12); burst(30, ex, 1, ez, 14, 4, 0.7, 0.3, [1, 0.7, 0.3], SP.SPARK, 1, 3, 1.5); shake(0.8); flash(BOMB_C, 0.3); }
          else if (k === 'magnet') { fx(FX.IMPLODE, px, 0.08, pz, 0.6, c, 14, 1, 0.9); fx(FX.IMPLODE, px, 0.08, pz, 0.8, c, 9, 0.5, 0.6); burst(10, px, 1, pz, 3, 2, 0.5, 0.3, c, SP.GLINT, 1, 0, 2, 4); }
          else if (k === 'heart') { burst(8, px, 1, pz, 1.4, 2.6, 0.8, 0.32, c, SP.PLUS, 1, -0.6, 1.5, 2); fx(FX.RING, px, 0.08, pz, 0.45, c, 0.3, 2.2, 0.8, 0.08); }
          else if (pickBudget-- > 0) { emit(px + rnd(0.3), 1.0 + rnd(0.3), pz + rnd(0.3), rnd(0.8), 2.0, rnd(0.8), 0.4, k === 'xp_l' ? 0.5 : 0.32, 0.05, c[0], c[1], c[2], SP.GLINT, 1, 0, 2, 5); }
          break;
        }
        case 'levelup': {
          fx(FX.PILLAR, px, 0, pz, 1.0, [1, 0.9, 0.55], 3.2, 16, 1); fx(FX.PILLAR, px, 0, pz, 0.7, WHITE, 1.2, 18, 0.9);
          fx(FX.RING, px, 0.08, pz, 0.7, GOLD, 0.4, 7, 1, 0.09); fx(FX.RING, px, 0.08, pz, 1.0, WHITE, 0.2, 11, 0.5, 0.04); fx(FX.RUNE, px, 0.07, pz, 1.1, GOLD, 2.4, 0, 0.9, 3, 0);
          const n = Math.round(22 * (0.4 + 0.6 * Q.particles / 1400));
          for (let k = 0; k < n; k++) { const a = k / n * TAU * 2, r = 0.5 + (k % 5) * 0.25; emit(px + Math.cos(a) * r, 0.2 + rnd(0.2), pz + Math.sin(a) * r, -Math.sin(a) * 1.5, 3 + Math.random() * 3, Math.cos(a) * 1.5, 0.9 + Math.random() * 0.4, 0.34, 0.04, 1, 0.88, 0.5, SP.GLINT, 1, -1, 0.6, 5); }
          cam.punch = -2.2; flash(GOLD, 0.16);
          break;
        }
        case 'heal': {
          burst(7, px, 0.8, pz, 1.2, 2.4, 0.8, 0.3, GREEN, SP.PLUS, 1, -0.5, 1.5, 2);
          if (view.showDamageNumbers && e.amount >= 1) spawnNumber(px, pz - 0.3, e.amount, GREEN, false, '+');
          break;
        }
        case 'shrine': {
          const c = SHRINE_COL[e.kind] || GOLD;
          fx(FX.PILLAR, ex, 0, ez, 1.1, c, 3, 15, 1); fx(FX.RING, ex, 0.08, ez, 0.7, c, 0.5, 7, 1, 0.09); fx(FX.RING, ex, 0.08, ez, 1.0, WHITE, 0.3, 10, 0.5, 0.04);
          burst(16, ex, 1.5, ez, 3.5, 4, 1.0, 0.4, c, SP.RUNE, 1, -0.5, 1.5, 3); burst(10, px, 1, pz, 1.5, 3, 0.8, 0.3, c, SP.GLINT, 1, -1, 1.5, 4);
          flash(c, 0.18); shake(0.25);
          break;
        }
        case 'evolve': {
          banner = true; bannerX = px; bannerZ = pz;
          fx(FX.PILLAR, px, 0, pz, 1.5, [1, 0.85, 0.4], 5, 22, 1); fx(FX.PILLAR, px, 0, pz, 1.1, WHITE, 1.6, 22, 1);
          for (let k = 0; k < 3; k++) fx(FX.RING, px, 0.08, pz, 0.7 + k * 0.3, k === 1 ? WHITE : GOLD, 0.4, 8 + k * 5, 1, 0.1 - k * 0.025);
          fx(FX.RUNE, px, 0.07, pz, 1.8, GOLD, 4, 0, 1, 4, 0); fx(FX.GLOW, px, 1.2, pz, 0.8, GOLD, 4, 10, 0.45);
          const n = Math.round(44 * (0.4 + 0.6 * Q.particles / 1400));
          for (let k = 0; k < n; k++) { const a = k / n * TAU * 3, r = 0.6 + k / n * 2.4; emit(px + Math.cos(a) * r, 0.3, pz + Math.sin(a) * r, -Math.sin(a) * 3, 2 + k / n * 5, Math.cos(a) * 3, 1.2, 0.4, 0.05, 1, 0.8 + 0.2 * Math.random(), 0.35, k % 3 ? SP.GLINT : SP.RUNE, 1, -1, 0.5, 4); }
          flash(GOLD, 0.22); shake(0.45); cam.punch = -3;
          break;
        }
        case 'hurt': hurtPulse = Math.min(1, Math.max(hurtPulse, 0.55 + num(e.dmg, 5) / Math.max(1, num(pl.maxHp, 100)) * 2)); shake(0.28); burst(4, px, 1, pz, 3, 2, 0.3, 0.24, RED, SP.SPARK, 1, 6, 2); break;
        case 'death': burst(26, px, 0.9, pz, 3, 3, 1.3, 0.34, ASH, SP.ASH, 0, 1.5, 1.2, 5); burst(16, px, 0.9, pz, 2, 3.5, 1.4, 0.2, EMBER, SP.SPARK, 1, -1, 1); fx(FX.RING, px, 0.08, pz, 0.9, RED, 0.4, 7, 0.9, 0.08); hurtPulse = 1; deathFade = 1; shake(0.7); break;
        case 'win': {
          for (let k = 0; k < 6; k++) { const a = k / 6 * TAU; fx(FX.PILLAR, px + Math.cos(a) * 3.5, 0, pz + Math.sin(a) * 3.5, 1.6 + k * 0.1, GOLD, 1.6, 20, 0.9); }
          fx(FX.PILLAR, px, 0, pz, 2.0, WHITE, 4, 24, 1); fx(FX.RING, px, 0.08, pz, 1.2, GOLD, 0.5, 16, 1, 0.08); fx(FX.RUNE, px, 0.07, pz, 2.4, GOLD, 5, 0, 1, 2, 0);
          burst(50, px, 1.5, pz, 7, 8, 1.8, 0.4, GOLD, SP.GLINT, 1, 4, 0.8, 5); flash(GOLD, 0.4);
          break;
        }
        case 'text':
          if (banner && Math.abs(ex - bannerX) + Math.abs(ez - bannerZ) < 0.75) break;      // 「…降臨」/「…覺醒」: the shell's DOM banner covers these
          if (e.text !== undefined && e.text !== null && e.text !== '') spawnText(ex, ez, e.text, parseColor(e.color, _tc));
          break;
        default: break;
      }
    }
  }

  /* ---- enemies ---- */
  const UNKNOWN_META = enemyBatches.get('unknown').meta;
  function drawEnemies(en, dt) {
    const ember = Q.particles > 300;
    for (let i = 0; i < en.length; i++) {
      const e = en[i]; if (!e) continue;
      const type = e.type, id = e.id | 0, scl = num(e.scale, 1), age = num(e.age, 9), anim = e.anim, aT = num(e.animT, 0);
      let tr = 0, tg = 0, tb = 0, ta = 0;
      if (e.frozen > 0) { tr = 0.3; tg = 0.62; tb = 0.95; ta = 1.0; }
      else if (e.burning > 0) { tr = 1.0; tg = 0.42; tb = 0.08; ta = 0.5 + 0.15 * Math.sin(time * 14 + id); }
      else if (e.poisoned > 0) { tr = 0.35; tg = 1.0; tb = 0.25; ta = 0.55; }
      else if (e.slowed > 0) { tr = 0.5; tg = 0.7; tb = 1.0; ta = 0.35; }
      const flash = sat(num(e.flash, 0));
      if (BOSS_DEFS[type]) {
        const rig = getBossRig(e);
        if (rig) {
          const def = rig.def, sc = scl < 1.2 ? scl * 2.2 : scl, clone = !e.boss;
          rig.mat.transparent = clone; rig.mat.uniforms.uAlpha.value = clone ? 0.5 : 1;
          rig.k = 1 - Math.exp(-dt * 11); rig.t += e.frozen > 0 ? 0 : dt;
          def.animate(rig, anim, aT, rig.t, e.frozen > 0 ? 0 : dt, anim === 'walk' || anim === 'charge' || !anim);
          const rise = smooth(Math.min(1, age / 1.4));
          rig.root.position.set(e.x, def.fly ? (1 - rise) * 4.5 : -(1 - rise) * def.h * sc * 0.85, e.z); rig.root.rotation.y = num(e.rot, 0); rig.root.scale.setScalar(sc * (def.fly ? 0.4 + 0.6 * rise : 1));
          const u = rig.mat.uniforms; u.uFx.value.z = flash; u.uTint.value.set(tr, tg, tb, ta * 0.7); u.uEmiK.value = 1.0 + (anim === 'windup' || anim === 'cast' || anim === 'summon' ? 0.45 + 0.3 * Math.sin(time * 16) : 0);
          shpush(e.x, e.z, def.sh * sc * 1.1, Q.shadow ? 0.3 : 0.6 * rise);
          const c = def.col; gpush(e.x, 0.05, e.z, 0, def.sh * sc * 1.55, def.sh * sc * 1.55, 14, 0, c[0], c[1], c[2], 0.55 * rise, 0.5, 0.04, 0); gpush(e.x, 0.048, e.z, 0, def.sh * sc * 2.0, def.sh * sc * 2.0, 1, 0, c[0], c[1], c[2], 0.16 * rise, 1.0, 0, 0.3);
          spush(e.x, def.h * sc * 0.55, e.z, def.h * sc * 2.4, c[0], c[1], c[2], 0.13, SP.GLOW);
          if (age < 1.4 && ember && (frame & 1)) emit(e.x + rnd(def.sh * sc), 0.2, e.z + rnd(def.sh * sc), rnd(1), 3 + Math.random() * 3, rnd(1), 0.8, 0.3, 0.04, c[0], c[1], c[2], SP.SPARK, 1, -1, 0.5);
          continue;
        }
      }
      const b = enemyBatches.get(type) || enemyBatches.get('unknown'), mt = b.meta, sc = scl * VIS, frozen = e.frozen > 0;
      const stun = anim === 'stun';
      let phase = (frozen || stun) ? id * 1.7 : age * mt.freq + id * 1.7, pose = 0, lean = 0, y = 0, sx = sc, sy = sc, fade = 1;
      if (anim === 'attack') pose = Math.sin(Math.min(1, aT * 3.5) * PI) * 0.9 + 0.25;
      else if (anim === 'cast' || anim === 'summon') pose = Math.min(1, aT * 6) * (0.85 + 0.15 * Math.sin(time * 18));
      else if (anim === 'windup') { pose = Math.min(1, aT * 4) * 0.7; lean = -0.12; }
      else if (anim === 'charge') { lean = mt.lean || 0.25; phase = age * mt.freq * 1.8 + id; pose = 0.5; }
      else if (stun) lean = 0.25 + Math.sin(time * 9 + id) * 0.06;
      if (mt.gallop && !frozen) lean += Math.sin(phase) * mt.gallop;
      if (mt.sway && !frozen) lean += Math.sin(phase * 0.5) * mt.sway * 0.5 + 0.05;
      const flying = mt.fly !== undefined;
      if (flying) y = (mt.fly + (frozen ? 0 : Math.sin(time * 2.4 + id * 0.9) * mt.flyBob)) * sc; else if (!frozen) y = Math.abs(Math.sin(phase)) * mt.bob * sc;
      if (!flying && e.flying && b.meta === UNKNOWN_META) y += 1.1 * sc;        // unknown flying types still hover
      if (mt.pulse) { const wu = anim === 'windup' ? 1 : 0, s = 1 + Math.sin(time * (wu ? 26 : 5) + id) * 0.05 * (1 + wu * 1.6) + wu * Math.min(0.35, aT * 0.5) * mt.pulse; sx = sc * s; sy = sc * (2 - s) * (1 + wu * 0.1); }
      const sp = anim === 'spawn' ? Math.min(1, aT / 0.55) : Math.min(1, age / 0.45);
      if (sp < 1) { const k = smooth(sp); if (flying) { sx *= k; sy *= k; } else { y -= (1 - k) * mt.h * sc * 0.92; if (ember && ((frame + id) & 3) === 0) emit(e.x + rnd(0.3), 0.1, e.z + rnd(0.3), rnd(0.8), 1 + Math.random(), rnd(0.8), 0.4, 0.3, 0.6, 0.12, 0.11, 0.1, SP.SMOKE, 0.1, -0.2, 2); } }
      putChar(b, e.x, y, e.z, num(e.rot, 0), sx, sy, sx, lean, phase, pose, flash, fade, tr, tg, tb, ta);
      shpush(e.x, e.z, mt.sh * sc * (flying ? 0.85 : 1), flying ? 0.34 : 0.5);
      if (e.elite) {
        const c = AFFIX_COL[e.affix] || ELITE_DEFAULT, R = Math.max(num(e.r, 0.5) * 1.5, mt.sh * sc * 1.45);
        gpush(e.x, 0.05, e.z, 0, R * 1.16, R * 1.16, 14, 0, c[0], c[1], c[2], 0.7, 0.35, 0.06, 0); gpush(e.x, 0.048, e.z, 0, R * 1.4, R * 1.4, 1, 0, c[0], c[1], c[2], 0.11, 1.0, 0, 0.18);
        spush(e.x, y + mt.h * sc * 0.5, e.z, mt.h * sc * 1.6, c[0], c[1], c[2], 0.07, SP.GLOW);
        if (e.affix === 'shielded') putGhost(bubbles, e.x, y + mt.h * sc * 0.5, e.z, 0, Math.max(mt.h * sc * 0.58, R * 0.75), 0.8, 0.9, 1.0, 0.28);
        if (ember && ((frame + id * 3) % 9) === 0) emit(e.x + rnd(R * 0.7), 0.15, e.z + rnd(R * 0.7), 0, 1.5 + Math.random(), 0, 0.7, 0.22, 0.02, c[0], c[1], c[2], SP.SPARK, 1, -0.5, 0.5);
      }
      if (ember && ta > 0 && ((frame + id * 5) % 11) === 0) {
        if (e.burning > 0 && !frozen) emit(e.x + rnd(0.3), y + mt.h * sc * 0.6, e.z + rnd(0.3), rnd(0.4), 1.8, rnd(0.4), 0.5, 0.3, 0.05, 1, 0.5, 0.1, SP.FLAME, 1, -1, 1);
        else if (e.poisoned > 0 && !frozen) emit(e.x + rnd(0.3), y + mt.h * sc * 0.7, e.z + rnd(0.3), rnd(0.3), 1.0, rnd(0.3), 0.6, 0.18, 0.1, 0.4, 1, 0.3, SP.BUBBLE, 0.8, -0.3, 1);
        else if (frozen) emit(e.x + rnd(0.4), y + mt.h * sc * 0.6, e.z + rnd(0.4), 0, -0.5, 0, 0.6, 0.2, 0.05, 0.7, 0.9, 1, SP.SNOW, 1, 0, 1, 3);
      }
    }
    // dissolving corpses
    for (let i = 0; i < CN; i++) {
      const c = corpses[i]; if (!c.on) continue;
      c.t += dt; const k = c.t / 0.55; if (k >= 1) { c.on = false; continue; }
      putChar(c.b, c.x, c.y - k * 0.25, c.z, c.rot, c.sc * (1 + k * 0.08), c.sc * (1 - k * 0.25), c.sc * (1 + k * 0.08), 0.15 * k, 0, 0, 0.5 * (1 - k * 3), 1 - k, 0.03, 0.03, 0.035, 0.85);
    }
    // retire boss rigs whose enemy is gone
    for (let i = bossList.length - 1; i >= 0; i--) { const rig = bossList[i]; if (rig.seen !== frame) { scene.remove(rig.root); bossRigs.delete(rig.id); bossList.splice(i, 1); (bossPool[rig.type] || (bossPool[rig.type] = [])).push(rig); } }
  }

  function drawAllies(al) {
    for (let i = 0; i < al.length; i++) {
      const a = al[i]; if (!a) continue;
      const key = ALLY_DEFS[a.type] ? a.type : 'unknown', b = lazyBatch(allyBatches, ALLY_DEFS, key, matAlly, 96, true), mt = b.meta, id = a.id | 0, sc = VIS * 0.95;
      const aT = num(a.animT, 0), moving = a.anim === 'walk' || !a.anim;
      const phase = moving ? time * mt.freq + id * 1.3 : id * 1.3 + Math.sin(time * 2 + id) * 0.2;
      const pose = (a.anim === 'attack' || a.anim === 'cast') ? Math.sin(Math.min(1, aT * 4) * PI) * 0.9 + 0.2 : 0;
      const y = mt.fly !== undefined ? (mt.fly + Math.sin(time * 2.2 + id) * mt.flyBob) * sc : (moving ? Math.abs(Math.sin(phase)) * mt.bob * sc : 0);
      const sp = a.anim === 'spawn' ? smooth(Math.min(1, aT / 0.5)) : 1;
      putChar(b, a.x, y - (1 - sp) * mt.h * sc, a.z, num(a.rot, 0), sc, sc, sc, 0, phase, pose, 0, 1, 0, 0, 0, 0);
      shpush(a.x, a.z, mt.sh * sc, 0.45);
      const c = a.type === 'lich' ? ALLY_C2 : ALLY_C1;
      gpush(a.x, 0.05, a.z, 0, 0.64, 0.64, 14, 0, c[0], c[1], c[2], 0.32, 0.2, 0.09, 0);
      if (a.type === 'lich') spush(a.x - Math.cos(num(a.rot, 0)) * 0.5 * sc, y + 2.04 * sc, a.z + Math.sin(num(a.rot, 0)) * 0.5 * sc, 1.1, 0.3, 1.0, 0.7, 0.6, SP.GLOW);
    }
  }

  function drawProjectiles(pr) {
    const ember = Q.particles > 300;
    for (let i = 0; i < pr.length; i++) {
      const p = pr[i]; if (!p) continue;
      const key = PROJ_DEFS[p.kind] ? p.kind : 'unknown', b = lazyBatch(projBatches, PROJ_DEFS, key, matSmall, 400, false), d = b.meta;
      const id = p.id | 0, age = num(p.age, 0), y = num(p.y, 1), vx = num(p.vx, 0), vz = num(p.vz, 0), spd = Math.hypot(vx, vz);
      const sc = clamp(num(p.r, d.s || 0.3) / (d.s || 0.3), 0.75, 2.2) * 1.1;
      const rot = d.spin ? age * d.spin + id : (typeof p.rot === 'number' ? p.rot : Math.atan2(vx, vz));
      putChar(b, p.x, y, p.z, rot, sc, sc, sc, d.tumble ? age * d.tumble : 0, 0, 0, 0, 1, 0, 0, 0, 0);
      if (shadows.n < 900) shpush(p.x, p.z, 0.3 * sc, 0.28);
      if (d.streak && spd > 0.6) {
        const s = d.streak, ux = vx / spd, uz = vz / spd, len = s[3] * sc * Math.min(1, age * 8 + 0.2);
        lpush(p.x - ux * len, y, p.z - uz * len, p.x + ux * 0.1, y, p.z + uz * 0.1, s[4] * sc, s[0], s[1], s[2], 0.9, 0);
        if (d.wisp) { const w = Math.sin(time * 11 + id) * 0.35, nx = -uz, nz = ux; lpush(p.x - ux * len * 1.3 + nx * w, y, p.z - uz * len * 1.3 + nz * w, p.x - ux * 0.2, y, p.z - uz * 0.2, s[4] * sc * 0.6, s[0], s[1], s[2], 0.6, 0); lpush(p.x - ux * len * 1.1 - nx * w, y, p.z - uz * len * 1.1 - nz * w, p.x - ux * 0.2, y, p.z - uz * 0.2, s[4] * sc * 0.5, s[0], s[1], s[2], 0.5, 0); }
      }
      if (d.glow) { const g = d.glow; spush(p.x, y, p.z, g[3] * sc, g[0], g[1], g[2], 0.55, SP.GLOW); if (d.hostile) spush(p.x, y, p.z, g[3] * sc * 0.8 * (1 + 0.15 * Math.sin(time * 14 + id)), 1, 0.25, 0.15, 0.9, SP.RING); }
      if (d.ring) { const g = d.ring; gpush(p.x, y, p.z, 0, g[3] * sc * 1.25, g[3] * sc * 1.25, 0, 0, g[0], g[1], g[2], 0.32, 0.8, 0.07, 0); }
      if (d.ember && ember && ((frame + id) & 3) === 0) emit(p.x + rnd(0.1), y + rnd(0.1), p.z + rnd(0.1), rnd(0.6) - vx * 0.1, 0.6 + Math.random(), rnd(0.6) - vz * 0.1, 0.35, 0.2, 0.02, 1, 0.55, 0.12, SP.SPARK, 1, -1, 1);
    }
  }

  const ZC = {
    poison: [0.35, 1.0, 0.22], plague: [0.75, 0.95, 0.2], e_poison: [0.65, 0.3, 0.9], fire: [1.0, 0.5, 0.12], e_fire: [1.0, 0.22, 0.08], frost: [0.45, 0.82, 1.0], blizzard: [0.6, 0.85, 1.0],
    web: [0.92, 0.95, 0.88], arrowrain: [0.6, 1.0, 0.7], lightning_mark: [1.0, 0.92, 0.45], meteor_mark: [1.0, 0.42, 0.1], telegraph_circle: [1.0, 0.16, 0.1], telegraph_line: [1.0, 0.16, 0.1]
  };
  function drawZones(zs) {
    const ember = Q.particles > 300;
    for (let i = 0; i < zs.length; i++) {
      const z = zs[i]; if (!z) continue;
      const k = z.kind, id = z.id | 0, R = num(z.r, 2), age = num(z.age, 0), life = Math.max(0.01, num(z.life, 1)), t = sat(age / life);
      const hostile = z.owner === 'e';
      const a = sat(age / 0.25) * sat((life - age) / 0.3), c = ZC[k] || (hostile ? ZC.telegraph_circle : KCOL.arcane), seed = id * 1.37;
      switch (k) {
        case 'telegraph_circle': gpush(z.x, 0.06, z.z, 0, R, R, 2, t, c[0], c[1], c[2], sat(age / 0.12), 0, 0, 0, seed); break;
        case 'telegraph_line': {
          const len = num(z.len, R * 2), w = num(z.width, 1.2), an = num(z.angle, 0), sx = Math.sin(an), sz = Math.cos(an);
          gpush(z.x + sx * len * 0.5, 0.06, z.z + sz * len * 0.5, an, w * 0.5, len * 0.5, 3, t, c[0], c[1], c[2], sat(age / 0.12), 0, 0, 0, seed); break;
        }
        case 'poison': case 'plague': case 'e_poison': {
          gpush(z.x, 0.05, z.z, 0, R * 1.06, R * 1.06, 4, 0, c[0], c[1], c[2], a * 0.8, 0, 0, 0, seed);
          if (hostile) gpush(z.x, 0.055, z.z, 0, R, R, 0, 0, 1, 0.2, 0.15, a * 0.6, 0.95, 0.035, 0);
          if (k === 'plague') for (let j = 0; j < 5; j++) { const an = time * 0.35 + j * 1.257 + seed, rr = R * (0.25 + 0.45 * hash1(id + j)); spush(z.x + Math.cos(an) * rr, 1.0 + 0.4 * Math.sin(time + j), z.z + Math.sin(an) * rr, R * 1.25, c[0] * 0.5, c[1] * 0.55, c[2] * 0.3, a * 0.3, SP.SMOKE, an, 0.45); }
          if (ember && ((frame + id * 3) % 7) === 0) { const an = Math.random() * TAU, rr = Math.sqrt(Math.random()) * R * 0.9; emit(z.x + Math.cos(an) * rr, 0.1, z.z + Math.sin(an) * rr, 0, 0.9 + Math.random(), 0, 0.7, 0.24, 0.1, c[0], c[1], c[2], SP.BUBBLE, 0.8, -0.2, 0.5); }
          break;
        }
        case 'fire': case 'e_fire': {
          gpush(z.x, 0.05, z.z, 0, R * 1.08, R * 1.08, 5, 0, c[0], c[1], c[2], a, 0, 0, 0, seed);
          if (hostile) gpush(z.x, 0.055, z.z, 0, R, R, 0, 0, 1, 0.1, 0.05, a * 0.7, 0.95, 0.035, 0);
          const n = Math.min(7, Math.max(2, Math.round(R * 1.6)));
          for (let j = 0; j < n; j++) { const ph = time * (1.6 + hash1(id + j) * 1.2) + j * 1.7, u = ph - Math.floor(ph), st = Math.floor(ph), an = hash2(id + j, st) * TAU, rr = Math.sqrt(hash2(id + j + 9, st)) * R * 0.8; spush(z.x + Math.cos(an) * rr, 0.25 + u * 0.9, z.z + Math.sin(an) * rr, (1.0 - u * 0.5) * Math.min(1.3, 0.6 + R * 0.25), c[0] * 1.5, c[1] * 1.5, c[2] * 1.5, a * (1 - u) * 0.9, SP.FLAME, 0, 1, 1.3); }
          if (ember && ((frame + id * 3) % 9) === 0) emit(z.x + rnd(R * 0.7), 0.4, z.z + rnd(R * 0.7), rnd(0.5), 1.6 + Math.random(), rnd(0.5), 0.7, 0.16, 0.02, 1, 0.55, 0.15, SP.SPARK, 1, -0.6, 0.6);
          break;
        }
        case 'frost': gpush(z.x, 0.05, z.z, 0, R, R, 6, 0, c[0], c[1], c[2], a * 0.9, 0, 0, 0, seed); if (hostile) gpush(z.x, 0.055, z.z, 0, R, R, 0, 0, 1, 0.2, 0.2, a * 0.6, 0.95, 0.035, 0); if (ember && ((frame + id * 3) % 13) === 0) emit(z.x + rnd(R * 0.7), 0.2, z.z + rnd(R * 0.7), 0, 0.6, 0, 0.8, 0.24, 0.05, 0.8, 0.95, 1, SP.SNOW, 1, 0, 1, 2); break;
        case 'blizzard': {
          gpush(z.x, 0.05, z.z, 0, R, R, 12, 0, c[0], c[1], c[2], a, 0, 0, 0, seed); if (hostile) gpush(z.x, 0.055, z.z, 0, R, R, 0, 0, 1, 0.2, 0.2, a * 0.6, 0.95, 0.035, 0);
          const n = Q.particles > 600 ? 3 : Q.particles > 300 ? 2 : 1;
          for (let j = 0; j < n; j++) { const an = Math.random() * TAU, rr = Math.sqrt(Math.random()) * R; emit(z.x + Math.cos(an) * rr, 1.5 + Math.random() * 2.5, z.z + Math.sin(an) * rr, -Math.sin(an) * 5 - 3, -3.5, Math.cos(an) * 5 + 1, 0.55, 0.26, 0.1, 0.85, 0.95, 1, j ? SP.SPARK : SP.SNOW, 1, 0, 0.4, 5); }
          for (let j = 0; j < 3; j++) { const an = time * (0.8 + j * 0.3) + j * 2.1 + seed; spush(z.x + Math.cos(an) * R * 0.5, 1.6, z.z + Math.sin(an) * R * 0.5, R * 1.3, 0.55, 0.7, 0.85, a * 0.16, SP.SMOKE, an, 0.7); }
          break;
        }
        case 'arrowrain': {
          gpush(z.x, 0.05, z.z, 0, R, R, 13, 0, c[0], c[1], c[2], a, 0, 0, 0, seed);
          const n = Math.min(18, Math.max(5, Math.round(R * 4)));
          for (let j = 0; j < n; j++) {
            const ph = time * 2.6 + hash1(id * 7 + j) * 5, u = ph - Math.floor(ph), st = Math.floor(ph), an = hash2(id + j, st) * TAU, rr = Math.sqrt(hash2(id + j + 5, st)) * R * 0.92;
            const ax = z.x + Math.cos(an) * rr, az = z.z + Math.sin(an) * rr;
            if (u < 0.8) { const h = (1 - u / 0.8) * 11; lpush(ax + 0.5 + h * 0.12, h + 1.8, az - h * 0.1, ax + h * 0.12, h, az - h * 0.1, 0.16, 0.8, 1.0, 0.85, a * 0.95, 0); }
            else { const q = (u - 0.8) / 0.2; lpush(ax + 0.12, 0.9, az, ax, 0, az, 0.09, 0.7, 0.9, 0.75, a * (1 - q), 1); gpush(ax, 0.06, az, 0, 0.5, 0.5, 0, 0, c[0], c[1], c[2], a * (1 - q) * 0.7, 0.3 + q * 0.6, 0.12, 0); }
          }
          break;
        }
        case 'lightning_mark': {
          gpush(z.x, 0.06, z.z, seed, R, R, 10, t, c[0], c[1], c[2], sat(age / 0.15), 3, 0, 0.1, seed);
          if (t > 0.5) bolt(z.x + rnd(R * 0.6), 0.1, z.z + rnd(R * 0.6), z.x + rnd(R * 0.6), 0.5 + Math.random(), z.z + rnd(R * 0.6), 0.1, c[0], c[1], c[2], 0.7 * t, id, 0.3);
          break;
        }
        case 'meteor_mark': {
          gpush(z.x, 0.06, z.z, seed, R, R, 10, t, c[0], c[1], c[2], sat(age / 0.15), 1, 0, 0.15, seed); gpush(z.x, 0.062, z.z, 0, R, R, 2, t, c[0], c[1], c[2], 0.55 * sat(age / 0.15), 0, 0, 0, seed);
          const p = 1 - t, ms = Math.min(1.5, 0.5 + R * 0.28), mx = z.x + p * 9, my = 0.8 + p * 34, mz = z.z - p * 5;
          if (p < 0.7) {
            putChar(meteorBatch, mx, my, mz, time * 4 + id, ms, ms, ms, time * 3, 0, 0, 0, 1, 0, 0, 0, 0);
            lpush(mx + 2.3, my + 8.7, mz - 1.3, mx, my, mz, ms * 2.6, 1.0, 0.45, 0.1, 0.95, 0); lpush(mx + 1.2, my + 4.5, mz - 0.7, mx, my, mz, ms * 1.4, 1.0, 0.9, 0.5, 0.9, 0);
            spush(mx, my, mz, ms * 5, 1.0, 0.5, 0.15, 0.7, SP.GLOW); shpush(z.x, z.z, R * (1 - p) * 0.9 + 0.3, 0.55 * (1 - p));
            if (ember && (frame & 1)) emit(mx + rnd(0.4), my + rnd(0.4), mz + rnd(0.4), 1 + rnd(1), 2, rnd(1), 0.5, 0.5, 0.05, 1, 0.5, 0.12, SP.SPARK, 1, 0, 1);
          }
          break;
        }
        case 'web': gpush(z.x, 0.05, z.z, seed, R, R, 7, 0, c[0], c[1], c[2], a * 0.85, 0, 0, 0, seed); break;
        default: gpush(z.x, 0.05, z.z, 0, R, R, 1, 0, c[0], c[1], c[2], a * 0.35, 0.6, 0, 0.15); gpush(z.x, 0.055, z.z, 0, R, R, 0, 0, c[0], c[1], c[2], a * 0.8, 0.95, 0.04, 0);
      }
    }
  }

  function drawPickups(ps) {
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i]; if (!p) continue;
      const id = p.id | 0, age = num(p.age, 1);
      if (p.kind === 'chest') {
        const bob = Math.abs(Math.sin(time * 2.2 + id)) * 0.06, sIn = smooth(Math.min(1, age * 3));
        putChar(chestBase, p.x, bob, p.z, 0, 1.2 * sIn, 1.2 * sIn, 1.2 * sIn, 0, 0, 0, 0, 1, 0, 0, 0, 0);
        putChar(chestLid, p.x, bob + 0.53 * sIn, p.z - 0.36 * sIn, 0, 1.2 * sIn, 1.2 * sIn, 1.2 * sIn, -0.06 - 0.05 * Math.sin(time * 5 + id), 0, 0, 0, 1, 0, 0, 0, 0);
        shpush(p.x, p.z, 0.9, 0.5); spush(p.x, 0.7, p.z, 3.2, 1.0, 0.78, 0.3, 0.32 + 0.1 * Math.sin(time * 3), SP.GLOW);
        lpush(p.x, 0.4, p.z, p.x, 6.5, p.z, 1.3, 1.0, 0.8, 0.35, 0.28, 3);
        gpush(p.x, 0.05, p.z, 0, 1.55, 1.55, 14, 0, 1.0, 0.8, 0.3, 0.6, 0.5, 0.07, 0);
        spush(p.x + Math.sin(time * 1.7 + id) * 0.5, 1.1 + 0.3 * Math.sin(time * 2.3), p.z + 0.1, 0.5 * Math.max(0, Math.sin(time * 4 + id)), 1, 0.95, 0.7, 1, SP.GLINT, time);
        continue;
      }
      const key = PICKUP_DEFS[p.kind] ? p.kind : 'unknown', b = lazyBatch(pickupBatches, PICKUP_DEFS, key, matSmall, key.charCodeAt(0) === 120 ? 700 : 160, false), d = b.meta;
      const sIn = Math.min(1, age * 4 + 0.2), y = d.y + Math.sin(time * 3 + id * 1.3) * 0.08 + (age < 0.3 ? Math.sin(age / 0.3 * PI) * 0.5 : 0), g = d.glow;
      const sc = (p.magnet ? 0.85 : 1.1) * sIn * (d.sc || 1);
      putChar(b, p.x, y, p.z, d.spin ? time * d.spin + id : Math.sin(time * 2 + id) * 0.25, sc, sc, sc, d.tilt || 0, 0, 0, 0, 1, 0, 0, 0, 0);
      if (shadows.n < 950) shpush(p.x, p.z, 0.26, 0.3);
      spush(p.x, y, p.z, g[3] * (p.magnet ? 1.3 : 1), g[0], g[1], g[2], 0.42, SP.GLOW);
      const tw = Math.sin(time * 2.6 + id * 1.31); if (tw > 0.9) spush(p.x + 0.08, y + 0.14, p.z, (tw - 0.9) * 6 * g[3], 1, 1, 1, 0.9, SP.GLINT, time * 0.7);
    }
  }
  function drawShrines(sh, px, pz) {
    for (let i = 0; i < sh.length; i++) {
      const s = sh[i]; if (!s) continue;
      const c = SHRINE_COL[s.kind] || GOLD, used = !!s.used, id = s.id | 0, pulse = 0.75 + 0.25 * Math.sin(time * 2.5 + id);
      const near = !used && (s.progress > 0 || Math.hypot(px - s.x, pz - s.z) < 2.6);
      putChar(shrineBatch, s.x, 0, s.z, 0, 1.15, 1.15, 1.15, 0, 0, 0, 0, 1, c[0], c[1], c[2], used ? -0.1 : -(0.9 + (near ? 0.9 : 0)) * pulse);
      shpush(s.x, s.z, 1.3, 0.5);
      if (!used) {
        const prog = sat(num(s.progress, 0));
        gpush(s.x, 0.05, s.z, time * (near ? 1.4 : 0.25), 2.3, 2.3, 10, prog, c[0], c[1], c[2], (0.5 + prog * 0.4) * pulse, 2, 0, 0.12, id);
        if (prog > 0) gpush(s.x, 0.055, s.z, 0, 2.3, 2.3, 0, 0, c[0], c[1], c[2], 0.9, prog * 0.95, 0.05, 0);
        spush(s.x, 2.9, s.z, 2.6, c[0], c[1], c[2], 0.5 * pulse, SP.GLOW); lpush(s.x, 2.6, s.z, s.x, 9, s.z, 0.9, c[0], c[1], c[2], 0.25 * pulse, 3);
        if (near && (frame & 3) === 0) emit(s.x + rnd(1.6), 0.2, s.z + rnd(1.6), 0, 2 + Math.random() * 2, 0, 0.8, 0.26, 0.03, c[0], c[1], c[2], SP.RUNE, 1, -0.5, 0.4, 2);
      }
    }
  }

  /* ---- menu backdrop: ruined altar + campfire ---- */
  const menu = { group: new THREE.Group(), geo: null, t: 0, flourish: 4, propsFor: null };
  const FIRE = { x: 1.62, y: 0.45, z: 0.95 };
  const menuFire = { lx: FIRE.x, ly: FIRE.y + 0.7, lz: FIRE.z, seed: 3, sc: 1, def: { light: { col: [1.0, 0.55, 0.2], k: 1.15, r: 10 } } };
  {
    const g = GB(), R = rng(88);
    g.color(0x565b62).cyl(2.9, 3.25, 0.22, 12, 0, 0.11, 0); g.color(0x686d74).cyl(2.15, 2.4, 0.2, 12, 0, 0.32, 0); g.color(0x7a8087).cyl(1.2, 1.38, 0.18, 8, 0, 0.5, 0);
    g.color(0xffc070, 0.5).torus(1.75, 0.035, 3, 24, TAU, 0, 0.425, 0, PI / 2);
    for (let i = 0; i < 8; i++) { const a = i / 8 * TAU + 0.2; g.color(0xffc070, 0.6).box(0.2, 0.02, 0.07, Math.cos(a) * 1.75, 0.43, Math.sin(a) * 1.75, 0, -a, 0); }
    for (const [x, z, h, ry] of [[-2.25, -1.5, 3.3, 0.2], [2.35, -1.45, 1.5, -0.3], [0.1, -2.7, 2.4, 0.1], [-2.6, 0.9, 0.9, 0.5]]) {
      g.color(0x62676e).box(0.95, 0.26, 0.95, x, 0.33, z, 0, ry, 0); g.color(0x767c84).cyl(0.33, 0.37, h, 8, x, 0.46 + h / 2, z);
      g.color(0x858b93).cone(0.34, 0.45, 5, x + 0.04, 0.46 + h + 0.18, z, 0.25, ry, 0.12); g.color(0x5d6269).cyl(0.39, 0.39, 0.1, 8, x, 0.46 + h * 0.5, z);
    }
    g.color(0x767c84).cyl(0.33, 0.33, 1.5, 8, 2.9, 0.36, 0.6, PI / 2, 0.5, 0);
    for (let i = 0; i < 12; i++) { const a = R() * TAU, d = 2.6 + R() * 1.6, s = 0.18 + R() * 0.3; g.color(i % 2 ? 0x6a6f76 : 0x54595f).box(s * 1.4, s, s, Math.cos(a) * d, s * 0.45, Math.sin(a) * d - 0.3, R(), R() * 3, R()); }
    for (let i = 0; i < 8; i++) { const a = i / 8 * TAU; g.color(0x4a4e55).ico(0.16, FIRE.x + Math.cos(a) * 0.46, FIRE.y - 0.14, FIRE.z + Math.sin(a) * 0.46, 1, 0.8, 1, 0, R(), R()); }
    g.color(0x3a2a20).limb(FIRE.x - 0.35, FIRE.y - 0.2, FIRE.z - 0.2, FIRE.x + 0.3, FIRE.y + 0.1, FIRE.z + 0.2, 0.07, 0.06, 5).limb(FIRE.x + 0.35, FIRE.y - 0.2, FIRE.z - 0.2, FIRE.x - 0.3, FIRE.y + 0.1, FIRE.z + 0.2, 0.07, 0.06, 5).limb(FIRE.x, FIRE.y - 0.2, FIRE.z + 0.4, FIRE.x, FIRE.y + 0.12, FIRE.z - 0.3, 0.07, 0.06, 5);
    g.color(0xff8a2a, 3).ico(0.18, FIRE.x, FIRE.y - 0.08, FIRE.z).ico(0.12, FIRE.x + 0.16, FIRE.y - 0.12, FIRE.z + 0.1);
    menu.geo = keep(g.build());
    const m = new THREE.Mesh(menu.geo, matMenu); m.frustumCulled = false; menu.group.add(m); menu.group.visible = false; scene.add(menu.group);
  }
  function menuProps() {
    const out = [], kinds = S.props;
    const spots = [[-5.5, -3.5], [5.8, -4.2], [-8.5, -7.5], [1.5, -8.5], [8.5, -9.5], [-4.2, -11.5], [-10.5, -1.5], [10.8, -1.2], [4.8, -13], [-9.5, -14], [-6.8, 2.6], [7.2, 2.9], [0.5, -16], [13, -7]];
    for (let i = 0; i < spots.length; i++) { const k = kinds[i % kinds.length], d = PROP_DEFS[k]; out.push({ x: spots[i][0], z: spots[i][1], r: d.r * (1 + (i % 4) * 0.12), kind: k, seed: i * 977 + stageId.length * 31 }); }
    return out;
  }

  /* ---- frame plumbing ---- */
  function beginFrame() {
    gfx.n = sprites.n = lines.n = shadows.n = texts.n = 0; bubbles.n = 0; if (ghosts) ghosts.n = 0;
    for (let i = 0; i < charList.length; i++) charList[i].n = 0;
    renderer.info.reset();
  }
  const perf = { last: 0, n: 0, sum: 0, cool: 3, fps: 0, stable: 0 };
  let totalCalls = 0, totalTris = 0;
  function endFrame(dt, cx, cz, hx, hz) {
    U.uTime.value = time;
    ground.position.set(cx, 0, cz);
    const P = S.tile * 8; groundMat.uniforms.uGOrigin.value.set(((cx % P) + P) % P, ((cz % P) + P) % P, 0);
    moteMat.uniforms.uCenter.value.set(cx, 0, cz - (ext.top - ext.bottom) * 0.5);
    motes.visible = Q.motes > 0; moteGeo.setDrawRange(0, Q.motes); cards.visible = Q.cards > 0; cardGeo.instanceCount = Q.cards;
    hurtPulse = Math.max(deathFade * 0.7, hurtPulse - dt * 1.7); flashA = Math.max(0, flashA - dt * 2.4);
    overMat.uniforms.uHurt.value.w = hurtPulse; overMat.uniforms.uFlash.value.w = flashA;
    if (Q.shadow) {
      const kd = U.uKeyDir.value; sun.position.set(hx + kd.x * 30, kd.y * 30, hz + kd.z * 30); sun.target.position.set(hx, 0, hz); sun.target.updateMatrixWorld();
      catcher.position.set(hx, 0.03, hz);
    }
    _v.set(hx, 1.0, hz).project(camera);
    U.uHeroScr.value.set((_v.x * 0.5 + 0.5) * bufW, (_v.y * 0.5 + 0.5) * bufH, bufH * 0.075, 0);
    gfx.commit(); sprites.commit(); lines.commit(); shadows.commit(); texts.commit(); bubbles.commit(); if (ghosts) ghosts.commit();
    for (let i = 0; i < charList.length; i++) charList[i].commit();
    if (Q.bloom && composer) composer.render();
    else { renderer.render(scene, camera); sceneCalls = renderer.info.render.calls; sceneTris = renderer.info.render.triangles; }
    totalCalls = renderer.info.render.calls; totalTris = renderer.info.render.triangles;
    // adaptive quality: step down when the real frame time stays above ~24 ms
    const now = performance.now(), real = perf.last ? (now - perf.last) / 1000 : 0; perf.last = now;
    if (real > 0 && real < 0.5) perf.fps += (1 / real - perf.fps) * 0.05;
    if (!autoQ || real <= 0 || real > 1.5 || (typeof document !== 'undefined' && document.hidden)) return;      // > 1.5 s: came back from the background
    perf.cool -= real; if (perf.cool > 0) return;
    perf.sum += Math.min(real, 0.25); perf.n++;                                                             // very slow frames still count (clamped)
    if (perf.n >= 50) {
      if (quality > 0 && perf.sum / perf.n > 1 / 42) { applyQuality(quality - 1); storeAuto(quality); perf.cool = 2; perf.stable = 0; }
      else if (++perf.stable === 12 && storedAuto !== quality) storeAuto(quality);      // held this level for ~600 frames: remember it
      perf.n = 0; perf.sum = 0;
    }
  }
  const DEFAULT_PL = { x: 0, z: 0, rot: 0, moveX: 0, moveZ: 0, speed: 0, hp: 1, maxHp: 1, alive: true, auraR: 0 };

  function render(state, events, dt) {
    if (lost || disposed || !state) return;
    if (mode !== 'game') setMode('game');
    if (menuFocus.on) { camera.clearViewOffset(); menuFocus.on = false; }
    if (!stageId) setStage(state.stage || 'graveyard');
    if (!hero) setHero((state.player && state.player.hero) || 'knight');
    dt = clamp(num(dt, 0.016), 0, 0.1); time += dt; frame++;
    beginFrame();
    const pl = state.player || DEFAULT_PL, px = num(pl.x, 0), pz = num(pl.z, 0);
    heroPos.x = px; heroPos.z = pz; simPaused = state.phase === 'levelup' || state.phase === 'chest' || dt === 0;
    if (pl.alive !== false) deathFade = Math.max(0, deathFade - dt);
    updateCamera(dt, px, pz, num(pl.moveX, 0), num(pl.moveZ, 0));
    U.uHero.value.set(px, 0, pz); U.uHeroLight.value.set(S.hero[0], S.hero[1], S.hero[2], S.heroR);
    if (Math.abs(px - propQ.x) + Math.abs(pz - propQ.z) > 5) refreshProps(px, pz);
    if (Math.abs(px - propQ.dx) + Math.abs(pz - propQ.dz) > 6) refreshDecals(px, pz);
    drawProps(px, pz, null);
    if (events && events.length) { try { handleEvents(events, state); } catch (e) { if (view.debug) view.debug.lastError = e; } }
    drawHero(pl, dt);
    if (pl.auraR > 0) { const fire = pl.auraKind === 'fire', c = fire ? KCOL.fire : kcol(pl.auraKind || 'holy'), R = pl.auraR; gpush(px, 0.055, pz, 0, R, R, 9, 0, c[0], c[1], c[2], fire ? 0.55 : 0.4, fire ? 1 : 0, 0, 0, 0);
      if (Q.particles > 300 && (frame & 3) === 0) { const a = Math.random() * TAU; emit(px + Math.cos(a) * R * 0.95, 0.15, pz + Math.sin(a) * R * 0.95, 0, 1.4 + Math.random(), 0, 0.6, 0.24, 0.03, c[0], c[1], c[2], fire ? SP.FLAME : SP.PLUS, 1, -0.4, 0.5); } }
    if (pl.hp > 0 && pl.maxHp > 0 && pl.hp / pl.maxHp < 0.3 && pl.alive !== false) hurtPulse = Math.max(hurtPulse, 0.22 + 0.1 * Math.sin(time * 5));
    const bf = state.buffs;                       // active shrine buffs (CONTRACT-ADDENDUM): small motes orbiting the hero
    if (bf && bf.length && pl.alive !== false) for (let i = 0; i < bf.length && i < 6; i++) {
      const b = bf[i], c = b && SHRINE_COL[b.kind]; if (!c) continue;
      const k = sat(num(b.t, 1) / 1.5);          // two motes per buff on opposite sides, each with a short fading tail
      for (let j = 0; j < 2; j++) for (let q = 0; q < 3; q++) {
        const a = time * 2.6 + i * PI / bf.length + j * PI - q * 0.22, my = 1.25 + 0.3 * Math.sin(time * 3 + i + j * 2), mx = px + Math.cos(a) * 1.3, mz = pz + Math.sin(a) * 1.3;
        if (q === 0) spush(mx, my, mz, 0.8 * k, c[0], c[1], c[2], 1, SP.GLINT, time * 2);
        spush(mx, my, mz, (0.75 - q * 0.17) * k, c[0], c[1], c[2], 0.5 - q * 0.14, SP.GLOW);
      }
    }
    drawEnemies(state.enemies || EMPTY, dt);
    drawAllies(state.allies || EMPTY);
    drawProjectiles(state.projectiles || EMPTY);
    drawZones(state.zones || EMPTY);
    drawPickups(state.pickups || EMPTY);
    drawShrines(state.shrines || EMPTY, px, pz);
    updateFx(dt); updateParticles(dt); updateTexts(dt);
    endFrame(dt, cam.tx, cam.tz, px, pz);
  }
  function renderMenu(dt) {
    if (lost || disposed) return;
    if (mode !== 'menu') setMode('menu');
    if (!stageId) setStage('graveyard');
    if (!hero) setHero('knight');
    dt = clamp(num(dt, 0.016), 0, 0.1); time += dt; frame++; menu.t += dt;
    beginFrame();
    if (menu.propsFor !== stageId) { menu.propsFor = stageId; refreshProps(0, 0, menuProps()); refreshDecals(0, -6); }
    const aspect = cssW / Math.max(1, cssH), th = Math.tan(BASE_FOV * PI / 360), D = clamp(3.1 / (aspect * th), 8.5, 21), a = Math.sin(menu.t * 0.13) * 0.42 + 0.12, el = 0.36;
    if (camera.fov !== BASE_FOV) { camera.fov = BASE_FOV; camera.updateProjectionMatrix(); }
    // menu focus: ease the framing so the hero sits at the requested screen fraction (projection shift, so bloom / resize stay correct)
    const mf = menuFocus, mk = mf.snap ? 1 : 1 - Math.exp(-dt / 0.13); mf.snap = false;
    mf.x += (mf.tx - mf.x) * mk; mf.y += (mf.ty - mf.y) * mk;
    const offC = sat(Math.hypot(mf.x - 0.5, mf.y - 0.5) * 5);          // off-centre: aim at the hero's mid-body instead of the altar
    const lookY = lerp(aspect < 1 ? 0.75 : 1.35, 1.8, offC);
    camera.position.set(Math.sin(a) * D * Math.cos(el), 1.3 + D * Math.sin(el) + (lookY - (aspect < 1 ? 0.75 : 1.35)) * 0.5, Math.cos(a) * D * Math.cos(el)); camera.lookAt(0, lookY, 0);
    const mox = Math.round((0.5 - mf.x) * cssW * 4) / 4, moy = Math.round((0.5 - mf.y) * cssH * 4) / 4;
    if (Math.abs(mox) < 0.25 && Math.abs(moy) < 0.25) { if (mf.on) { camera.clearViewOffset(); mf.on = false; } }
    else if (!mf.on || mox !== mf.ox || moy !== mf.oy || cssW !== mf.w || cssH !== mf.h) { camera.setViewOffset(cssW, cssH, mox, moy, cssW, cssH); mf.on = true; mf.ox = mox; mf.oy = moy; mf.w = cssW; mf.h = cssH; }
    if (dbgCam) { camera.position.set(dbgCam.x, dbgCam.y, dbgCam.z); camera.lookAt(dbgCam.tx, dbgCam.ty, dbgCam.tz); }
    camera.updateMatrixWorld();
    U.uHero.value.set(0, 0, 0); heroPos.x = 0; heroPos.z = 0;
    U.uHeroLight.value.set(S.hero[0] * 0.42, S.hero[1] * 0.42, S.hero[2] * 0.42, 10);
    drawProps(0, 0, menuFire);
    // campfire
    const fl = 0.8 + 0.2 * Math.sin(time * 11) * Math.sin(time * 6.3);
    for (let k = 0; k < 6; k++) { const ph = time * (1.5 + k * 0.4) + k * 1.9, u = ph - Math.floor(ph); spush(FIRE.x + Math.sin(ph * 3 + k) * 0.1, FIRE.y + 0.1 + u * 1.0, FIRE.z + 0.03 * k, 1.1 - u * 0.7, 1.3, 0.42 - u * 0.22, 0.06, (1 - u) * 0.6, SP.FLAME, Math.sin(ph * 4) * 0.2, 0.7, 1.3); }
    spush(FIRE.x, FIRE.y + 0.5, FIRE.z, 3.6, 1.0, 0.5, 0.18, 0.28 * fl, SP.GLOW);
    if ((frame % 5) === 0) emit(FIRE.x + rnd(0.15), FIRE.y + 0.4, FIRE.z + rnd(0.15), rnd(0.5), 1.4 + Math.random() * 1.4, rnd(0.5), 1.0 + Math.random(), 0.11, 0.02, 1.6, 0.8, 0.25, SP.SPARK, 1, -0.2, 0.4);
    gpush(FIRE.x, 0.24, FIRE.z, 0, 3.2, 3.2, 1, 0, 1.0, 0.5, 0.15, 0.1 * fl, 1.5, 0, 0);
    // hero on the altar
    menu.flourish -= dt; if (menu.flourish <= 0) { menu.flourish = 5 + Math.random() * 4; hero.atk = 1; hero.atkSide = -hero.atkSide; }
    heroSt.speed = 0; heroSt.moving = false; heroSt.dash = 0; heroSt.t = time; heroSt.dt = dt; animateHero(hero, heroSt); hero.deathT = 0;
    hero.root.visible = true; hero.root.position.set(0, 0.59, 0); hero.root.rotation.set(0, 0.3 + Math.sin(menu.t * 0.4) * 0.12, 0);
    matHero.uniforms.uFx.value.set(0, 0, 0, 1); matHero.uniforms.uTint.value.set(0, 0, 0, 0);
    const ac = hero.def.accent; gpush(0, 0.6, 0, time * 0.2, 1.2, 1.2, 10, 0, ac[0], ac[1], ac[2], 0.3, 1, 0, 0, 1);
    if (!Q.shadow) shpush(0, 0, 0.01, 0);
    updateFx(dt); updateParticles(dt); updateTexts(dt);
    hurtPulse = 0; deathFade = 0;
    endFrame(dt, 0, -4, 0, 0);
  }

  /* ---- public API ---- */
  function applySize() {
    const ratio = Math.max(0.5, Math.min(baseDpr, Q.ratio));
    renderer.setPixelRatio(ratio); renderer.setSize(cssW, cssH, false);
    bufW = Math.floor(cssW * ratio); bufH = Math.floor(cssH * ratio);
    if (Q.bloom && !composer) buildComposer();
    if (composer) { composer.setPixelRatio(ratio); composer.setSize(cssW, cssH); }
    fitCamera();
  }
  function setQuality(q) { applyQuality(q); perf.n = 0; perf.sum = 0; perf.stable = 0; perf.cool = 2; }      // explicit choice: never persisted here
  function applyQuality(q) {
    q = clamp(Math.round(num(q, 2)), 0, 3);
    quality = q; Q = QUALITY[q]; spriteCap = Q.sprites;
    const sh = Q.shadow;
    if (renderer.shadowMap.enabled !== sh) { renderer.shadowMap.enabled = sh; catcherMat.needsUpdate = true; }
    sun.visible = sh; catcher.visible = sh;
    applySize(); propQ.dx = Infinity; menu.propsFor = mode === 'menu' ? null : menu.propsFor;
  }
  function resize(w, h, dpr) {
    cssW = Math.max(1, Math.round(num(w, 300))); cssH = Math.max(1, Math.round(num(h, 300)));
    baseDpr = Math.max(0.5, num(dpr, (typeof window !== 'undefined' && window.devicePixelRatio) || 1));
    applySize(); propQ.x = Infinity; propQ.dx = Infinity;
  }
  function setMode(m) {
    m = m === 'menu' ? 'menu' : 'game';
    if (m === mode && (m === 'game' || menu.group.visible)) return;
    mode = m; menu.group.visible = m === 'menu';
    pn = 0; for (let i = 0; i < FXN; i++) fxs[i].on = false; for (let i = 0; i < TN; i++) tx[i].on = false; for (let i = 0; i < CN; i++) corpses[i].on = false; for (let i = 0; i < GN; i++) gh[i].on = false;
    for (let i = 0; i < bossList.length; i++) { const rig = bossList[i]; scene.remove(rig.root); (bossPool[rig.type] || (bossPool[rig.type] = [])).push(rig); } bossRigs.clear(); bossList.length = 0;
    hurtPulse = 0; deathFade = 0; flashA = 0; cam.init = false; cam.shake = 0; cam.punch = 0; cam.lx = cam.lz = 0;
    menuFocus.snap = true; if (menuFocus.on) { camera.clearViewOffset(); menuFocus.on = false; }
    propQ.x = Infinity; propQ.dx = Infinity; menu.propsFor = null;
    if (hero) { hero.deathT = 0; hero.root.visible = true; hero.root.rotation.set(0, 0, 0); }
    if (m === 'game') U.uPL.value[0].set(0, -100, 0, 1);
  }
  function getViewExtents() { return extOut; }
  /* menu mode only: put the hero at this fraction of the screen (0..1, origin top-left); eases over ~0.4 s */
  function setMenuFocus(fx, fy) { menuFocus.tx = clamp(num(fx, 0.5), 0.05, 0.95); menuFocus.ty = clamp(num(fy, 0.5), 0.05, 0.95); }
  function worldToScreen(x, y, z) { _v.set(num(x, 0), num(y, 0), num(z, 0)).project(camera); return { x: (_v.x * 0.5 + 0.5) * cssW, y: (-_v.y * 0.5 + 0.5) * cssH }; }

  const onLost = e => { e.preventDefault(); lost = true; };
  const onRestored = () => { lost = false; perf.last = 0; perf.cool = 3; if (groundTex) groundTex.needsUpdate = true; };
  canvas.addEventListener('webglcontextlost', onLost, false); canvas.addEventListener('webglcontextrestored', onRestored, false);

  function dispose() {
    if (disposed) return; disposed = true;
    canvas.removeEventListener('webglcontextlost', onLost, false); canvas.removeEventListener('webglcontextrestored', onRestored, false);
    for (const d of disposables) { try { d.dispose(); } catch (e) { /* ignore */ } }
    for (const m of [enemyBatches, allyBatches, projBatches, pickupBatches, propBatches]) { for (const b of m.values()) b.mesh.dispose(); m.clear(); }
    for (const b of [decals, shadows, gfx, sprites, lines, texts]) b.dispose();
    for (const r of heroRigs.values()) { for (const g of r.geos) g.dispose(); r.ghostGeo.dispose(); }
    const allBoss = bossList.slice(); for (const k in bossPool) allBoss.push(...bossPool[k]);
    for (const r of allBoss) for (const g of r.geos) g.dispose();
    for (const t of stageTex.values()) { t.g.dispose(); t.d.dispose(); } stageTex.clear();
    if (sun.shadow && sun.shadow.map) sun.shadow.map.dispose();
    if (composer) { try { bloom.dispose(); composer.dispose(); } catch (e) { /* ignore */ } }
    scene.clear(); renderer.dispose();
  }

  Object.defineProperty(view, 'autoQuality', {
    enumerable: true, get: () => autoQ,
    set: v => { v = !!v; if (v && !autoQ) { autoQ = true; applyQuality(autoStartQuality()); perf.n = 0; perf.sum = 0; perf.stable = 0; perf.cool = 3; } else autoQ = v; }
  });
  Object.assign(view, {
    resize, setStage, setHero, setMode, setMenuFocus, render, renderMenu, getViewExtents, worldToScreen,
    setQuality, getQuality: () => quality, shake, flash, dispose,
    debug: {
      stats: () => {
        let enemies = 0; for (const b of enemyBatches.values()) enemies += b.n;
        return { calls: sceneCalls, triangles: sceneTris, totalCalls, totalTriangles: totalTris, enemies, sprites: sprites.n, particles: pn, lines: lines.n, gfx: gfx.n, shadows: shadows.n, texts: texts.n, decals: decals.n, props: propQ.list.length, bosses: bossList.length, quality, fps: Math.round(perf.fps), programs: renderer.info.programs ? renderer.info.programs.length : 0, geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures, buffer: [bufW, bufH] };
      },
      setCamera: c => { dbgCam = c || null; if (!c) { camera.fov = BASE_FOV; camera.updateProjectionMatrix(); } },
      triCounts: () => { const o = {}; for (const [k, b] of enemyBatches) o[k] = b.geo.userData.tris; for (const [k, r] of heroRigs) o['hero_' + k] = r.geos.reduce((s, g) => s + g.userData.tris, 0); return o; },
      lastError: null, renderer, scene, camera
    }
  });
  setStage(opts.stage || 'graveyard'); setHero(opts.hero || 'knight');
  applyQuality(quality);
  resize(canvas.clientWidth || 300, canvas.clientHeight || 300, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
  return view;
}

/* ══════════════════════════════════════════════════════════
   Lens

   A small post chain that reproduces the prismatic glare of a
   dirty anamorphic lens: bright areas are smeared along a few
   fixed axes with the colours pulled apart along the smear, then
   composited back over a chromatically split, softened frame.

   Order: render → bloom → streaks → tone map.
   Everything before the final pass stays in linear HDR.
   ══════════════════════════════════════════════════════════ */

import { EffectComposer }  from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass }      from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass }      from 'three/addons/postprocessing/OutputPass.js';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

const VERT = `
varying vec2 vUv;
void main(){
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

/* Keep only what is bright enough to flare. */
const BRIGHT_FRAG = `
uniform sampler2D tDiffuse;
uniform float uThreshold;
uniform float uKnee;
varying vec2 vUv;
void main(){
  vec3 c = texture2D(tDiffuse, vUv).rgb;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float w = smoothstep(uThreshold, uThreshold + uKnee, l);
  gl_FragColor = vec4(c * w, 1.0);
}`;

/* One symmetric smear along a single axis, with the spectrum
   walking outward from the source so the spike goes rainbow. */
const STREAK_FRAG = `
uniform sampler2D tDiffuse;
uniform vec2  uDir;
uniform float uStep;
uniform float uDecay;
uniform float uDispersion;
varying vec2 vUv;

const int N = 14;

void main(){
  vec3 sum = vec3(0.0);
  float wsum = 0.0;
  for(int i = 0; i < N; i++){
    float f = float(i);
    float t = f / float(N - 1);
    vec2  off = uDir * uStep * f;
    float w = pow(uDecay, f);
    vec3 spectrum = 0.5 + 0.5 * cos(6.28318 * (vec3(0.00, 0.33, 0.67) + t * 0.85));
    vec3 tint = mix(vec3(1.0), spectrum * 1.6, uDispersion);
    sum += (texture2D(tDiffuse, vUv + off).rgb + texture2D(tDiffuse, vUv - off).rgb) * w * tint;
    wsum += w * 2.0;
  }
  gl_FragColor = vec4(sum / max(wsum, 1e-4), 1.0);
}`;

const ADD_FRAG = `
uniform sampler2D tDiffuse;
varying vec2 vUv;
void main(){ gl_FragColor = vec4(texture2D(tDiffuse, vUv).rgb, 1.0); }`;

/* Chromatic split, barrel, edge softening, vignette, plus the streaks. */
const COMPOSITE_FRAG = `
uniform sampler2D tDiffuse;
uniform sampler2D tStreak;
uniform float uStreak;
uniform float uChroma;
uniform float uBlur;
uniform float uVignette;
uniform float uBarrel;
uniform float uHalo;
varying vec2 vUv;

vec3 split(vec2 uv, float amt){
  vec2 d = uv - 0.5;
  vec3 c;
  c.r = texture2D(tDiffuse, 0.5 + d * (1.0 - amt)).r;
  c.g = texture2D(tDiffuse, uv).g;
  c.b = texture2D(tDiffuse, 0.5 + d * (1.0 + amt)).b;
  return c;
}

void main(){
  vec2 d  = vUv - 0.5;
  float r2 = dot(d, d);
  vec2 uv = vUv + d * r2 * uBarrel;

  float amt = uChroma * (0.25 + r2 * 3.0);
  vec3 col = split(uv, amt);

  if(uBlur > 0.001){
    float b = uBlur * r2 * 0.045;
    vec3 acc = col * 2.0;
    acc += split(uv + vec2( b, 0.0), amt);
    acc += split(uv + vec2(-b, 0.0), amt);
    acc += split(uv + vec2(0.0,  b), amt);
    acc += split(uv + vec2(0.0, -b), amt);
    col = acc / 6.0;
  }

  vec3 streak = texture2D(tStreak, vUv).rgb;
  col += streak * uStreak;
  col += streak * uHalo * (0.35 + r2);          // soft bloom-bleed toward the edges

  float v = smoothstep(1.05, 0.12, r2 * 2.0);
  col *= mix(1.0, v, uVignette);

  gl_FragColor = vec4(col, texture2D(tDiffuse, vUv).a);
}`;

class PrismStreakPass extends Pass {
  constructor(THREE, width, height) {
    super();
    this.THREE = THREE;
    this.axes = 3;
    this.strength = 0.0;
    this.length1 = 1.0;

    const opt = { type: THREE.HalfFloatType, depthBuffer: false, stencilBuffer: false };
    const w = Math.max(1, Math.floor(width / 4));
    const h = Math.max(1, Math.floor(height / 4));
    this.rtBright = new THREE.WebGLRenderTarget(w, h, opt);
    this.rtA      = new THREE.WebGLRenderTarget(w, h, opt);
    this.rtB      = new THREE.WebGLRenderTarget(w, h, opt);
    this.rtAcc    = new THREE.WebGLRenderTarget(w, h, opt);

    const mk = (frag, uniforms, blending) => new THREE.ShaderMaterial({
      uniforms, vertexShader: VERT, fragmentShader: frag,
      depthTest: false, depthWrite: false,
      blending: blending ?? THREE.NoBlending
    });

    this.brightMat = mk(BRIGHT_FRAG, {
      tDiffuse: { value: null }, uThreshold: { value: 0.9 }, uKnee: { value: 0.55 }
    });
    this.streakMat = mk(STREAK_FRAG, {
      tDiffuse: { value: null }, uDir: { value: new THREE.Vector2(1, 0) },
      uStep: { value: 0.004 }, uDecay: { value: 0.88 }, uDispersion: { value: 0.7 }
    });
    this.addMat = mk(ADD_FRAG, { tDiffuse: { value: null } }, THREE.AdditiveBlending);
    this.compMat = mk(COMPOSITE_FRAG, {
      tDiffuse: { value: null }, tStreak: { value: null },
      uStreak: { value: 0.6 }, uChroma: { value: 0.004 }, uBlur: { value: 0.4 },
      uVignette: { value: 0.35 }, uBarrel: { value: 0.03 }, uHalo: { value: 0.15 }
    });

    this.quad = new FullScreenQuad(this.compMat);
    this.setSize(width, height);
  }

  setSize(width, height) {
    const w = Math.max(1, Math.floor(width / 4));
    const h = Math.max(1, Math.floor(height / 4));
    this.rtBright.setSize(w, h);
    this.rtA.setSize(w, h);
    this.rtB.setSize(w, h);
    this.rtAcc.setSize(w, h);
    this.aspect = width / Math.max(height, 1);
  }

  blit(renderer, material, target, clearFirst) {
    this.quad.material = material;
    renderer.setRenderTarget(target);
    if (clearFirst) renderer.clear(true, false, false);
    this.quad.render(renderer);
  }

  render(renderer, writeBuffer, readBuffer) {
    // FullScreenQuad goes through renderer.render(), which auto-clears.
    // The streak buffer is accumulated additively, so that has to be off.
    const autoClearWas = renderer.autoClear;
    const clearColorWas = renderer.getClearColor(this._c || (this._c = new this.THREE.Color()));
    const clearAlphaWas = renderer.getClearAlpha();
    renderer.autoClear = false;
    renderer.setClearColor(0x000000, 0);

    if (this.strength <= 0.001) {
      this.compMat.uniforms.tDiffuse.value = readBuffer.texture;
      this.compMat.uniforms.tStreak.value = this.rtAcc.texture;
      this.compMat.uniforms.uStreak.value = 0;
      renderer.setRenderTarget(this.rtAcc);
      renderer.clear(true, false, false);
    } else {
      this.brightMat.uniforms.tDiffuse.value = readBuffer.texture;
      this.blit(renderer, this.brightMat, this.rtBright, true);

      renderer.setRenderTarget(this.rtAcc);
      renderer.clear(true, false, false);

      const stepBase = 1.0 / this.rtBright.height;
      for (let a = 0; a < this.axes; a++) {
        const ang = (Math.PI * a) / this.axes + Math.PI / 12;
        this.streakMat.uniforms.uDir.value.set(Math.cos(ang) / this.aspect, Math.sin(ang));

        this.streakMat.uniforms.uStep.value = stepBase * this.length1;
        this.streakMat.uniforms.tDiffuse.value = this.rtBright.texture;
        this.blit(renderer, this.streakMat, this.rtA, true);

        this.streakMat.uniforms.uStep.value = stepBase * this.length1 * 6.0;
        this.streakMat.uniforms.tDiffuse.value = this.rtA.texture;
        this.blit(renderer, this.streakMat, this.rtB, true);

        this.addMat.uniforms.tDiffuse.value = this.rtB.texture;
        this.blit(renderer, this.addMat, this.rtAcc, false);   // accumulate
      }

      this.compMat.uniforms.tDiffuse.value = readBuffer.texture;
      this.compMat.uniforms.tStreak.value = this.rtAcc.texture;
      this.compMat.uniforms.uStreak.value = this.strength / Math.sqrt(this.axes);
    }

    renderer.setClearColor(clearColorWas, clearAlphaWas);
    renderer.autoClear = autoClearWas;

    this.quad.material = this.compMat;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);
  }

  dispose() {
    [this.rtBright, this.rtA, this.rtB, this.rtAcc].forEach(t => t.dispose());
    [this.brightMat, this.streakMat, this.addMat, this.compMat].forEach(m => m.dispose());
    this.quad.dispose();
  }
}

/* ── presets ─────────────────────────────────────────────── */
export const LENS_PRESETS = {
  off:      { label: 'Off' },
  clean:    { label: 'Clean glass',
              bloom: 0.16, radius: 0.5, threshold: 1.25,
              streak: 0.12, length: 0.7, dispersion: 0.25, axes: 2,
              chroma: 0.0012, blur: 0.10, vignette: 0.18, barrel: 0.005, halo: 0.04 },
  cinematic:{ label: 'Cinematic',
              bloom: 0.34, radius: 0.7, threshold: 1.05,
              streak: 0.45, length: 1.0, dispersion: 0.55, axes: 2,
              chroma: 0.0035, blur: 0.35, vignette: 0.38, barrel: 0.018, halo: 0.10 },
  anamorph: { label: 'Anamorphic',
              bloom: 0.42, radius: 0.85, threshold: 1.00,
              streak: 0.85, length: 1.6, dispersion: 0.75, axes: 1,
              chroma: 0.005, blur: 0.40, vignette: 0.42, barrel: 0.022, halo: 0.16 },
  pursuit:  { label: 'Pursuit',
              bloom: 0.70, radius: 0.95, threshold: 0.85,
              streak: 1.35, length: 1.5, dispersion: 0.95, axes: 3,
              chroma: 0.011, blur: 0.85, vignette: 0.55, barrel: 0.045, halo: 0.30 },
  overdrive:{ label: 'Overdrive',
              bloom: 1.05, radius: 1.0, threshold: 0.62,
              streak: 2.1, length: 2.2, dispersion: 1.0, axes: 4,
              chroma: 0.019, blur: 1.3, vignette: 0.62, barrel: 0.07, halo: 0.45 }
};

/**
 * Build the chain. `getCamera` is a function because the app swaps
 * between a perspective and an orthographic camera at runtime.
 */
export function createLens(THREE, renderer, scene, getCamera) {
  const size = renderer.getSize(new THREE.Vector2());

  const target = new THREE.WebGLRenderTarget(size.x, size.y, {
    type: THREE.HalfFloatType,
    samples: 4                       // keep MSAA once rendering goes off-screen
  });

  const composer = new EffectComposer(renderer, target);
  composer.setPixelRatio(renderer.getPixelRatio());

  const renderPass = new RenderPass(scene, getCamera());
  const bloomPass  = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.5, 0.7, 0.85);
  const prismPass  = new PrismStreakPass(THREE, size.x, size.y);
  const outputPass = new OutputPass();

  composer.addPass(renderPass);
  composer.addPass(bloomPass);
  composer.addPass(prismPass);
  composer.addPass(outputPass);

  const state = { preset: 'off', amount: 1, enabled: false };

  function apply(presetId, amount) {
    state.preset = presetId;
    state.amount = amount;
    const p = LENS_PRESETS[presetId];
    state.enabled = !!p && presetId !== 'off' && amount > 0.001;
    if (!state.enabled) return;

    const k = amount;
    bloomPass.strength  = p.bloom * k;
    bloomPass.radius    = p.radius;
    bloomPass.threshold = p.threshold;

    prismPass.strength  = p.streak * k;
    prismPass.length1   = p.length;
    prismPass.axes      = p.axes;
    prismPass.streakMat.uniforms.uDispersion.value = p.dispersion;
    prismPass.brightMat.uniforms.uThreshold.value  = p.threshold;

    const u = prismPass.compMat.uniforms;
    u.uChroma.value   = p.chroma * k;
    u.uBlur.value     = p.blur * k;
    u.uVignette.value = p.vignette * Math.min(1, k);
    u.uBarrel.value   = p.barrel * k;
    u.uHalo.value     = p.halo * k;
  }

  return {
    get enabled() { return state.enabled; },
    get preset()  { return state.preset; },
    apply,
    setCamera(cam) { renderPass.camera = cam; },
    setSize(w, h, pixelRatio) {
      composer.setPixelRatio(pixelRatio ?? renderer.getPixelRatio());
      composer.setSize(w, h);
      bloomPass.setSize(w, h);
      prismPass.setSize(w * (pixelRatio ?? 1), h * (pixelRatio ?? 1));
    },
    render() { renderPass.camera = getCamera(); composer.render(); },
    dispose() { prismPass.dispose(); bloomPass.dispose(); composer.dispose(); target.dispose(); }
  };
}

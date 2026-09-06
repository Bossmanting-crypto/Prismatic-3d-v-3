/* ══════════════════════════════════════════════════════════
   Atmosphere

   A field of slowly drifting, defocused motes around the model.
   All of the movement happens in the vertex shader, so the CPU
   only writes two uniforms per frame no matter how many there are.
   ══════════════════════════════════════════════════════════ */

/* A defocused highlight: soft core, brighter rim, feathered edge —
   the shape a real out-of-focus point light takes. */
function makeBokehTexture(THREE) {
  const S = 128;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  const r = S / 2;

  const grad = g.createRadialGradient(r, r, 0, r, r, r);
  grad.addColorStop(0.00, 'rgba(255,255,255,0.75)');
  grad.addColorStop(0.42, 'rgba(255,255,255,0.42)');
  grad.addColorStop(0.74, 'rgba(255,255,255,0.30)');
  grad.addColorStop(0.88, 'rgba(255,255,255,0.16)');
  grad.addColorStop(1.00, 'rgba(255,255,255,0.00)');
  g.fillStyle = grad;
  g.beginPath(); g.arc(r, r, r, 0, Math.PI * 2); g.fill();

  // the rim that makes it read as defocused rather than as a blob
  g.globalCompositeOperation = 'lighter';
  g.strokeStyle = 'rgba(255,255,255,0.20)';
  g.lineWidth = S * 0.055;
  g.beginPath(); g.arc(r, r, r * 0.80, 0, Math.PI * 2); g.stroke();

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

const VERT = `
attribute float aSize;
attribute float aAlpha;
attribute float aPhase;
uniform float uTime;
uniform float uHeight;
uniform float uScale;
uniform float uSway;
varying float vAlpha;
varying float vTint;

void main(){
  vec3 p = position;

  float speed = 0.035 + 0.075 * fract(aPhase * 7.13);
  p.y = mod(p.y + uTime * speed * uHeight + uHeight * 0.5, uHeight) - uHeight * 0.5;

  float ph = aPhase * 6.28318;
  p.x += sin(uTime * 0.24 + ph) * uHeight * uSway;
  p.z += cos(uTime * 0.19 + ph * 1.7) * uHeight * uSway;

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_PointSize = aSize * uScale / max(-mv.z, 0.0001);
  gl_PointSize = clamp(gl_PointSize, 1.0, 220.0);

  // fade in and out as a mote crosses the top and bottom of the volume
  float edge = 1.0 - smoothstep(0.32, 0.5, abs(p.y) / uHeight);
  vAlpha = aAlpha * edge;
  vTint  = fract(aPhase * 3.77);

  gl_Position = projectionMatrix * mv;
}`;

const FRAG = `
uniform sampler2D uMap;
uniform float uOpacity;
uniform vec3 uWarm;
uniform vec3 uCool;
varying float vAlpha;
varying float vTint;

void main(){
  vec4 t = texture2D(uMap, gl_PointCoord);
  vec3 c = mix(uWarm, uCool, smoothstep(0.25, 0.85, vTint));
  gl_FragColor = vec4(c * t.a * vAlpha * uOpacity, t.a * vAlpha * uOpacity);
}`;

export function createAtmosphere(THREE, { count = 720 } = {}) {
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(count * 3);
  const size = new Float32Array(count);
  const alpha = new Float32Array(count);
  const phase = new Float32Array(count);

  for (let i = 0; i < count; i++) {
    // a flattened cylinder around the model reads better than a cube:
    // motes cluster near eye level instead of piling up overhead
    const a = Math.random() * Math.PI * 2;
    const rad = Math.pow(Math.random(), 0.55) * 3.4 + 0.35;
    pos[i * 3]     = Math.cos(a) * rad;
    pos[i * 3 + 1] = (Math.random() - 0.5) * 2.6;
    pos[i * 3 + 2] = Math.sin(a) * rad;

    const near = Math.random();
    size[i]  = 0.006 + Math.pow(near, 2.4) * 0.075;   // a few large, defocused ones
    alpha[i] = 0.16 + (1.0 - near) * 0.55;
    phase[i] = Math.random();
  }

  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aSize',  new THREE.BufferAttribute(size, 1));
  geo.setAttribute('aAlpha', new THREE.BufferAttribute(alpha, 1));
  geo.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 6);

  const map = makeBokehTexture(THREE);

  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uMap:     { value: map },
      uTime:    { value: 0 },
      uHeight:  { value: 2.6 },
      uScale:   { value: 300 },
      uSway:    { value: 0.02 },
      uOpacity: { value: 0 },
      uWarm:    { value: new THREE.Color(0xffd9a8).convertSRGBToLinear() },
      uCool:    { value: new THREE.Color(0xbfd8ff).convertSRGBToLinear() }
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending
  });

  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  points.renderOrder = 5;
  points.visible = false;

  let t = 0;

  return {
    object: points,

    /* Size the volume to whatever model is on stage. */
    setScale(radius) {
      const r = Math.max(radius, 1e-3);
      points.scale.setScalar(r * 1.5);
      points.position.y = r * 0.55;
      mat.uniforms.uSway.value = 0.02;
    },

    setOpacity(v) {
      mat.uniforms.uOpacity.value = v;
      points.visible = v > 0.002;
    },

    setPalette(warmHex, coolHex) {
      mat.uniforms.uWarm.value.setHex(warmHex).convertSRGBToLinear();
      mat.uniforms.uCool.value.setHex(coolHex).convertSRGBToLinear();
    },

    /* uScale converts a world-space radius into pixels for gl_PointSize. */
    update(dt, viewportHeight, camera) {
      if (!points.visible) return;
      t += dt;
      mat.uniforms.uTime.value = t;
      const fov = camera.isPerspectiveCamera ? camera.fov : 50;
      mat.uniforms.uScale.value =
        (viewportHeight * 0.5) / Math.tan(THREE.MathUtils.degToRad(fov) / 2);
    },

    dispose() { geo.dispose(); mat.dispose(); map.dispose(); }
  };
}

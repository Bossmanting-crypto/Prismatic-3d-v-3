
import * as THREE from 'three';
import { OrbitControls }   from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader }      from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader }     from 'three/addons/loaders/DRACOLoader.js';
import { KTX2Loader }      from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder }  from 'three/addons/libs/meshopt_decoder.module.js';
import { OBJLoader }       from 'three/addons/loaders/OBJLoader.js';
import { MTLLoader }       from 'three/addons/loaders/MTLLoader.js';
import { FBXLoader }       from 'three/addons/loaders/FBXLoader.js';
import { STLLoader }       from 'three/addons/loaders/STLLoader.js';
import { PLYLoader }       from 'three/addons/loaders/PLYLoader.js';
import { ThreeMFLoader }   from 'three/addons/loaders/3MFLoader.js';
import { ColladaLoader }   from 'three/addons/loaders/ColladaLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { GLTFExporter }    from 'three/addons/exporters/GLTFExporter.js';
import { OBJExporter }     from 'three/addons/exporters/OBJExporter.js';
import { STLExporter }     from 'three/addons/exporters/STLExporter.js';
import { PLYExporter }     from 'three/addons/exporters/PLYExporter.js';
import { makePadTexture, makeSkyTexture } from './hud-pad.js';
import { createLens, LENS_PRESETS } from './lens.js';
import { createAtmosphere } from './atmosphere.js';

const CDN   = './vendor/three/examples/jsm/';
const native = window.prism || null;
const $     = s => document.querySelector(s);
const $$    = s => [...document.querySelectorAll(s)];
const view  = $('#view');
const overlay = $('#overlay');

/* ══════════════════════════════════════════════════════════
   Renderer, scene, cameras
   ══════════════════════════════════════════════════════════ */
const renderer = new THREE.WebGLRenderer({ antialias:true, alpha:true, powerPreference:'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(view.clientWidth, view.clientHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.info.autoReset = false;   // the lens chain renders many passes per frame
view.appendChild(renderer.domElement);

const scene = new THREE.Scene();

const pCam = new THREE.PerspectiveCamera(50, 1, 0.01, 1000);
pCam.position.set(3, 2.2, 4);
pCam.lookAt(0, 0.5, 0);
const oCam = new THREE.OrthographicCamera(-1, 1, 1, -1, -1000, 1000);
oCam.position.copy(pCam.position);
let camera = pCam;

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.075;
controls.screenSpacePanning = true;
controls.maxPolarAngle = Math.PI;
controls.mouseButtons = {
  LEFT: THREE.MOUSE.ROTATE,
  MIDDLE: THREE.MOUSE.DOLLY,
  RIGHT: THREE.MOUSE.PAN
};
renderer.domElement.addEventListener('contextmenu', e => e.preventDefault());

/* environment lighting */
const pmrem = new THREE.PMREMGenerator(renderer);
pmrem.compileEquirectangularShader();
const envRT = pmrem.fromScene(new RoomEnvironment(), 0.04);
scene.environment = envRT.texture;

/* lights */
const hemi = new THREE.HemisphereLight(0xdfe6f2, 0x2a2d33, 0.55);
scene.add(hemi);
const key = new THREE.DirectionalLight(0xffffff, 2.1);
key.position.set(4, 7, 5);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.bias = -0.0005;
key.shadow.normalBias = 0.02;
scene.add(key);
const fill = new THREE.DirectionalLight(0xc8d6ff, 0.5);
fill.position.set(-5, 2.5, -4);
scene.add(fill);
const rim = new THREE.DirectionalLight(0xbcd4ff, 1.4);
rim.position.set(-3, 3.5, -6);
scene.add(rim);

/* helpers */
const grid = new THREE.GridHelper(10, 20, 0x4d5661, 0x2c3138);
grid.material.transparent = true;
grid.material.opacity = 0.75;
scene.add(grid);

const axes = new THREE.AxesHelper(1);
axes.visible = false;
scene.add(axes);

const shadowPlane = new THREE.Mesh(
  new THREE.PlaneGeometry(1, 1),
  new THREE.ShadowMaterial({ opacity: 0.28 })
);
shadowPlane.rotation.x = -Math.PI / 2;
shadowPlane.receiveShadow = true;
scene.add(shadowPlane);

const lens = createLens(THREE, renderer, scene, () => camera);

const atmo = createAtmosphere(THREE, { count: 760 });
scene.add(atmo.object);

const modelGroup = new THREE.Group();
scene.add(modelGroup);

const measureGroup = new THREE.Group();
measureGroup.renderOrder = 999;
scene.add(measureGroup);

const wireGroup = new THREE.Group();
scene.add(wireGroup);

/* ══════════════════════════════════════════════════════════
   State
   ══════════════════════════════════════════════════════════ */
const S = {
  root: null,
  fileName: '—',
  bytes: 0,
  box: new THREE.Box3(),
  size: new THREE.Vector3(1,1,1),
  center: new THREE.Vector3(),
  radius: 1,
  meshes: [],
  origMats: new Map(),
  mixer: null,
  clips: [],
  action: null,
  playing: false,
  nav: 'orbit',
  measuring: false,
  pending: null,
  measures: [],
  selected: null,
  spin: false,
  views: [],
  callouts: [],
  annotating: false,
  activeCallout: null,
  activeView: null,
  modelKey: null,
  pendingKey: null,
  stats: { meshes:0, tris:0, verts:0, mats:0, tex:0, area:0, volume:0 },
  clock: new THREE.Clock()
};

const UNIT = { m:1, cm:0.01, mm:0.001, in:0.0254, ft:0.3048 };
const unitFactor = () => UNIT[$('#unitModel').value] / UNIT[$('#unitShow').value];
const unitLabel  = () => $('#unitShow').value;

function fmtLen(raw, digits){
  const v = raw * unitFactor();
  const d = digits ?? (Math.abs(v) >= 1000 ? 0 : Math.abs(v) >= 100 ? 1 : Math.abs(v) >= 1 ? 2 : 4);
  return v.toLocaleString(undefined,{ minimumFractionDigits:d, maximumFractionDigits:d }) + ' ' + unitLabel();
}
function fmtNum(n){ return n.toLocaleString(); }
function fmtBytes(b){
  if(!b) return '—';
  const u = ['B','KB','MB','GB']; let i = 0, v = b;
  while(v >= 1024 && i < u.length-1){ v /= 1024; i++; }
  return v.toFixed(v < 10 && i > 0 ? 1 : 0) + ' ' + u[i];
}

/* ══════════════════════════════════════════════════════════
   Toasts, status, progress
   ══════════════════════════════════════════════════════════ */
function toast(title, detail, kind){
  const el = document.createElement('div');
  el.className = 'toast' + (kind ? ' ' + kind : '');
  el.innerHTML = '<div class="t"></div>' + (detail ? '<div class="d"></div>' : '');
  el.firstChild.textContent = title;
  if(detail) el.lastChild.textContent = detail;
  $('#toasts').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s';
                     setTimeout(() => el.remove(), 320); }, kind === 'err' ? 7000 : 3600);
  return el;
}
const status = t => $('#fStatus').textContent = t;
function progress(p){
  const b = $('#bar');
  if(p == null){ b.style.width = '0'; return; }
  b.style.width = Math.max(3, Math.min(100, p*100)) + '%';
  if(p >= 1) setTimeout(() => { b.style.width = '0'; }, 320);
}
let hintTimer;
function hint(msg){
  const h = $('#hint');
  if(!msg){ h.classList.remove('show'); return; }
  h.textContent = msg; h.classList.add('show');
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => h.classList.remove('show'), 4200);
}

/* ══════════════════════════════════════════════════════════
   Loading manager — resolves sibling files by basename
   ══════════════════════════════════════════════════════════ */
const manager = new THREE.LoadingManager();
const blobs = new Map();      // lowercase basename -> object URL
const liveURLs = [];

manager.setURLModifier(url => {
  if(url.startsWith('blob:') || url.startsWith('data:')) return url;
  const clean = decodeURIComponent(url.split('?')[0].split('#')[0]);
  const base = clean.split(/[\\/]/).pop().toLowerCase();
  if(blobs.has(base)) return blobs.get(base);
  // try a looser match (some exporters mangle paths)
  for(const [k,v] of blobs) if(k.endsWith(base) || base.endsWith(k)) return v;
  return url;
});
manager.onProgress = (u, a, t) => progress(t ? a/t : null);

const draco = new DRACOLoader().setDecoderPath(CDN + 'libs/draco/gltf/');
const ktx2  = new KTX2Loader().setTranscoderPath(CDN + 'libs/basis/').detectSupport(renderer);

const gltfLoader = new GLTFLoader(manager)
  .setDRACOLoader(draco).setKTX2Loader(ktx2).setMeshoptDecoder(MeshoptDecoder);

function clearBlobs(){
  liveURLs.forEach(u => URL.revokeObjectURL(u));
  liveURLs.length = 0;
  blobs.clear();
}
function registerFiles(files){
  clearBlobs();
  for(const f of files){
    const u = URL.createObjectURL(f);
    liveURLs.push(u);
    blobs.set((f.webkitRelativePath || f.name).split(/[\\/]/).pop().toLowerCase(), u);
  }
}

/* ══════════════════════════════════════════════════════════
   File intake
   ══════════════════════════════════════════════════════════ */
const MODEL_EXT = ['glb','gltf','obj','fbx','stl','ply','3mf','dae'];
const extOf = n => n.split('.').pop().toLowerCase();

async function handleFiles(fileList, preferName){
  const files = [...fileList].filter(f => f.size !== 0 || f.name.includes('.'));
  if(!files.length) return;
  registerFiles(files);

  const models = files.filter(f => MODEL_EXT.includes(extOf(f.name)));
  if(!models.length){
    toast('No model found', 'Include a file ending in ' + MODEL_EXT.join(', ') + '.', 'err');
    return;
  }
  // use the named model when we know it, otherwise the largest
  let chosen = null;
  if(preferName) chosen = models.find(f => f.name.toLowerCase() === preferName.toLowerCase());
  if(!chosen){ models.sort((a,b) => b.size - a.size); chosen = models[0]; }
  await loadModel(chosen, files);
}

async function loadModel(file, siblings){
  const ext = extOf(file.name);
  status('Loading ' + file.name);
  progress(0.05);
  const url = blobs.get(file.name.toLowerCase()) || URL.createObjectURL(file);

  try{
    let root = null, animations = [];

    if(ext === 'glb' || ext === 'gltf'){
      const g = await gltfLoader.loadAsync(url);
      root = g.scene || g.scenes[0];
      animations = g.animations || [];

    }else if(ext === 'obj'){
      const objLoader = new OBJLoader(manager);
      const mtl = siblings.find(f => extOf(f.name) === 'mtl');
      if(mtl){
        try{
          const mats = await new MTLLoader(manager).loadAsync(blobs.get(mtl.name.toLowerCase()));
          mats.preload();
          objLoader.setMaterials(mats);
        }catch(e){ toast('Material file skipped', mtl.name + ' could not be parsed.', 'err'); }
      }
      root = await objLoader.loadAsync(url);

    }else if(ext === 'fbx'){
      root = await new FBXLoader(manager).loadAsync(url);
      animations = root.animations || [];

    }else if(ext === 'stl'){
      const geo = await new STLLoader(manager).loadAsync(url);
      root = geoToMesh(geo, file.name);

    }else if(ext === 'ply'){
      const geo = await new PLYLoader(manager).loadAsync(url);
      root = geoToMesh(geo, file.name);

    }else if(ext === '3mf'){
      root = await new ThreeMFLoader(manager).loadAsync(url);

    }else if(ext === 'dae'){
      const c = await new ColladaLoader(manager).loadAsync(url);
      root = c.scene;
      animations = c.animations || [];
    }

    if(!root) throw new Error('Nothing to display in this file.');
    adopt(root, animations, file);
    progress(1);
    status('Loaded ' + file.name);
    toast('Model loaded', file.name + ' — ' + fmtNum(S.stats.tris) + ' triangles.', 'ok');

  }catch(err){
    console.error(err);
    progress(1);
    status('Load failed');
    toast('Could not open ' + file.name,
          (err && err.message ? err.message : 'Unsupported or damaged file.') +
          ' If it references textures, drop the whole folder instead.', 'err');
  }
}

function geoToMesh(geo, name){
  if(!geo.attributes.normal) geo.computeVertexNormals();
  const hasColor = !!geo.attributes.color;
  const mat = new THREE.MeshStandardMaterial({
    color: hasColor ? 0xffffff : 0xb9c0ca,
    vertexColors: hasColor,
    metalness: 0.05,
    roughness: 0.62,
    flatShading: !geo.attributes.normal
  });
  const m = new THREE.Mesh(geo, mat);
  m.name = name.replace(/\.[^.]+$/, '');
  return m;
}

/* ══════════════════════════════════════════════════════════
   Adopting a loaded scene
   ══════════════════════════════════════════════════════════ */
function disposeTree(obj){
  obj.traverse(o => {
    if(o.geometry) o.geometry.dispose();
    const mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
    for(const m of mats){
      for(const k in m){
        const v = m[k];
        if(v && v.isTexture) v.dispose();
      }
      m.dispose();
    }
  });
}

function adopt(root, animations, file){
  // tear down previous
  if(S.root){
    modelGroup.remove(S.root);
    disposeTree(S.root);
    if(S.mixer){ S.mixer.stopAllAction(); S.mixer.uncacheRoot(S.root); }
  }
  clearMeasures();
  wireGroup.clear();
  S.origMats.clear();
  S.meshes = [];
  S.selected = null;

  S.root = root;
  S.fileName = file ? file.name : 'Sample scene';
  S.modelKey = S.pendingKey || (file ? file.name + ':' + file.size : 'sample-scene');
  S.pendingKey = null;
  S.bytes = file ? file.size : 0;
  modelGroup.add(root);

  // gather
  const matSet = new Set(), texSet = new Set();
  let tris = 0, verts = 0, area = 0, volume = 0;

  root.updateMatrixWorld(true);
  root.traverse(o => {
    if(o.isMesh || o.isPoints || o.isLine){
      o.castShadow = o.receiveShadow = !!o.isMesh;
      if(o.isMesh){
        S.meshes.push(o);
        const g = o.geometry;
        if(g && g.attributes.position){
          const n = g.attributes.position.count;
          verts += n;
          const t = g.index ? g.index.count/3 : n/3;
          tris += t;
          const m = measureGeometry(g, o.matrixWorld);
          area += m.area; volume += m.volume;
        }
      }
      const mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
      mats.forEach(m => {
        matSet.add(m);
        for(const k in m){ const v = m[k]; if(v && v.isTexture) texSet.add(v); }
      });
      if(o.isMesh) S.origMats.set(o, o.material);
    }
  });

  S.stats = { meshes:S.meshes.length, tris:Math.round(tris), verts, mats:matSet.size, tex:texSet.size,
              area, volume:Math.abs(volume) };

  // centre on origin, sit on the grid
  const box = new THREE.Box3().setFromObject(root);
  if(box.isEmpty()) throw new Error('The file contains no visible geometry.');
  const size = box.getSize(new THREE.Vector3());
  const ctr  = box.getCenter(new THREE.Vector3());
  root.position.sub(new THREE.Vector3(ctr.x, box.min.y, ctr.z));

  root.updateMatrixWorld(true);
  S.box = new THREE.Box3().setFromObject(root);
  S.size = S.box.getSize(new THREE.Vector3());
  S.center = S.box.getCenter(new THREE.Vector3());
  S.radius = Math.max(S.size.length() * 0.5, 1e-4);

  layoutHelpers();
  applyMaterialOptions();
  applyShading();
  setupAnimations(animations || root.animations || []);
  buildTree();
  refreshInfo();
  buildPad();
  initCallouts();
  applyStage();
  frameView('iso', false);
  initViews();

  $('#empty').hidden = true;
  $('#header').hidden = false;
  $('#hud-bl').hidden = false;
  ['#btnFit','#btnMeasure','#btnAnnotate','#btnShot','#btnExport'].forEach(s => $(s).disabled = false);
}

/* per-geometry surface area + signed volume, in world space */
function measureGeometry(geo, matrixWorld){
  const pos = geo.attributes.position;
  if(!pos) return { area:0, volume:0 };
  const idx = geo.index;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const ab = new THREE.Vector3(), ac = new THREE.Vector3(), cr = new THREE.Vector3();
  const count = idx ? idx.count : pos.count;
  const LIMIT = 3_000_000;                       // guard against pathological meshes
  let area = 0, vol = 0;
  for(let i = 0; i + 2 < Math.min(count, LIMIT); i += 3){
    const i0 = idx ? idx.getX(i)   : i;
    const i1 = idx ? idx.getX(i+1) : i+1;
    const i2 = idx ? idx.getX(i+2) : i+2;
    a.fromBufferAttribute(pos, i0).applyMatrix4(matrixWorld);
    b.fromBufferAttribute(pos, i1).applyMatrix4(matrixWorld);
    c.fromBufferAttribute(pos, i2).applyMatrix4(matrixWorld);
    ab.subVectors(b, a); ac.subVectors(c, a);
    area += cr.crossVectors(ab, ac).length() * 0.5;
    vol  += a.dot(cr.crossVectors(b, c)) / 6;
  }
  return { area, volume: vol };
}

function layoutHelpers(){
  const span = Math.max(S.size.x, S.size.z, S.radius) * 3;
  const step = Math.pow(10, Math.floor(Math.log10(span / 10)));
  const divisions = Math.max(4, Math.min(80, Math.round(span / step)));
  grid.geometry.dispose();
  const g = new THREE.GridHelper(span, divisions, 0x4d5661, 0x2c3138);
  grid.geometry = g.geometry;
  g.material.dispose();
  grid.position.y = 0;

  shadowPlane.scale.set(span, span, 1);
  axes.scale.setScalar(S.radius * 0.9);

  const padR = Math.max(S.size.x, S.size.z) * 0.68 + S.radius * 0.10;
  const padT = padR * 0.035;
  padBase.scale.set(padR, padT, padR);
  padBase.position.y = -padT / 2;      // top face sits exactly on the ground plane
  padHud.scale.setScalar(padR);
  padHud.position.y = S.radius * 0.0016;
  atmo.setScale(S.radius);

  key.position.set(S.radius*3, S.radius*5, S.radius*3.4);
  const d = S.radius * 4;
  const cam = key.shadow.camera;
  cam.left = -d; cam.right = d; cam.top = d; cam.bottom = -d;
  cam.near = 0.01; cam.far = S.radius * 20;
  cam.updateProjectionMatrix();

  pCam.near = Math.max(S.radius / 1000, 0.001);
  pCam.far  = S.radius * 200;
  pCam.updateProjectionMatrix();
  oCam.near = -S.radius * 100;
  oCam.far  =  S.radius * 100;
  controls.maxDistance = S.radius * 60;
  controls.minDistance = S.radius / 200;
}

/* ══════════════════════════════════════════════════════════
   Materials & shading modes
   ══════════════════════════════════════════════════════════ */
const clayMat = new THREE.MeshStandardMaterial({ color:0xcfd4da, roughness:0.78, metalness:0.0 });
const normMat = new THREE.MeshNormalMaterial({ flatShading:false });
let uvMat = null;
function getUVMat(){
  if(uvMat) return uvMat;
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const x = c.getContext('2d');
  for(let i=0;i<8;i++) for(let j=0;j<8;j++){
    x.fillStyle = (i+j)%2 ? '#5b636e' : '#d8dde3';
    x.fillRect(i*32, j*32, 32, 32);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  uvMat = new THREE.MeshStandardMaterial({ map:tex, roughness:0.85, metalness:0 });
  return uvMat;
}

function applyMaterialOptions(){
  const dbl  = $('#cDouble').checked;
  const flat = $('#cFlat').checked;
  const envI = parseFloat($('#envInt').value);
  S.origMats.forEach((mat, mesh) => {
    const list = Array.isArray(mat) ? mat : [mat];
    list.forEach(m => {
      if(!m) return;
      if(m.userData._side === undefined) m.userData._side = m.side;
      m.side = dbl ? THREE.DoubleSide : m.userData._side;
      if(m.flatShading !== flat){ m.flatShading = flat; m.needsUpdate = true; }
      if('envMapIntensity' in m) m.envMapIntensity = envI;
    });
  });
}

function applyShading(){
  const mode = $('#shading').value;
  wireGroup.children.forEach(c => { c.geometry.dispose(); });
  if(wireGroup.children[0]) wireGroup.children[0].material.dispose();
  wireGroup.clear();

  S.origMats.forEach((orig, mesh) => {
    const list = Array.isArray(orig) ? orig : [orig];
    if(mode === 'shaded' || mode === 'both'){
      mesh.material = orig;
      list.forEach(m => m && (m.wireframe = false));
    }else if(mode === 'wire'){
      mesh.material = orig;
      list.forEach(m => m && (m.wireframe = true));
    }else if(mode === 'clay'){
      list.forEach(m => m && (m.wireframe = false));
      mesh.material = clayMat;
    }else if(mode === 'normals'){
      list.forEach(m => m && (m.wireframe = false));
      mesh.material = normMat;
    }else if(mode === 'uv'){
      list.forEach(m => m && (m.wireframe = false));
      mesh.material = getUVMat();
    }
  });

  if(mode === 'both'){
    let budget = 900_000;
    const lineMat = new THREE.LineBasicMaterial({ color:0x161a1f, transparent:true, opacity:0.55 });
    for(const mesh of S.meshes){
      const g = mesh.geometry;
      if(!g || !g.attributes.position) continue;
      const tris = g.index ? g.index.count/3 : g.attributes.position.count/3;
      if(budget - tris < 0){ hint('Wireframe overlay stops after 900k triangles — use plain wireframe for the rest.'); break; }
      budget -= tris;
      const seg = new THREE.LineSegments(new THREE.WireframeGeometry(g), lineMat);
      mesh.updateWorldMatrix(true, false);
      seg.matrixAutoUpdate = false;
      seg.matrix.copy(mesh.matrixWorld);
      seg.userData.src = mesh;
      wireGroup.add(seg);
    }
  }
  applyMaterialOptions();
}

/* ══════════════════════════════════════════════════════════
   Animation
   ══════════════════════════════════════════════════════════ */
function setupAnimations(clips){
  S.clips = clips || [];
  S.mixer = null; S.action = null; S.playing = false;
  const sec = $('#secAnim');
  if(!S.clips.length){ sec.hidden = true; return; }
  sec.hidden = false;
  sec.open = true;
  $('#animTally').textContent = S.clips.length + (S.clips.length === 1 ? ' clip' : ' clips');
  S.mixer = new THREE.AnimationMixer(S.root);
  const sel = $('#clipSel');
  sel.innerHTML = '';
  S.clips.forEach((c, i) => {
    const o = document.createElement('option');
    o.value = i;
    o.textContent = (c.name || ('Clip ' + (i+1))) + ' · ' + c.duration.toFixed(2) + ' s';
    sel.appendChild(o);
  });
  playClip(0);
  setPlaying(true);
}
function playClip(i){
  if(!S.mixer || !S.clips[i]) return;
  if(S.action) S.action.stop();
  S.action = S.mixer.clipAction(S.clips[i]);
  S.action.loop = $('#cLoop').checked ? THREE.LoopRepeat : THREE.LoopOnce;
  S.action.clampWhenFinished = true;
  S.action.reset().play();
  S.action.paused = !S.playing;
}
function setPlaying(v){
  S.playing = v;
  if(S.action) S.action.paused = !v;
  $('#btnPlay').textContent = v ? '❚❚' : '▶';
}

/* ══════════════════════════════════════════════════════════
   Camera framing & views
   ══════════════════════════════════════════════════════════ */
const DIRS = {
  front:[0,0,1], back:[0,0,-1], left:[-1,0,0], right:[1,0,0],
  top:[0,1,0.0001], bottom:[0,-1,0.0001], iso:[1,0.72,1], fit:null
};
function frameView(which, animate = true){
  if(!S.root) return;
  const dir = DIRS[which] || null;
  const target = S.center.clone();
  const dist = fitDistance();

  let pos;
  if(dir){
    pos = new THREE.Vector3(...dir).normalize().multiplyScalar(dist).add(target);
  }else{
    pos = camera.position.clone().sub(controls.target).normalize().multiplyScalar(dist).add(target);
  }
  if(camera === oCam){ oCam.zoom = 1; updateOrtho(dist); }

  if(animate){ tweenCamera(pos, target); }
  else{ camera.position.copy(pos); controls.target.copy(target); controls.update(); }
}
function fitDistance(){
  if(camera === oCam) return S.radius * 3;
  const fov = THREE.MathUtils.degToRad(pCam.fov);
  const aspect = Math.max(pCam.aspect, 0.001);
  const vert = S.radius / Math.sin(fov/2);
  const horiz = S.radius / Math.sin(Math.atan(Math.tan(fov/2)*aspect));
  return Math.max(vert, horiz) * 1.12;
}
function updateOrtho(dist){
  const a = view.clientWidth / Math.max(view.clientHeight,1);
  const h = (dist ?? S.radius*3) * 0.55;
  oCam.left = -h*a; oCam.right = h*a; oCam.top = h; oCam.bottom = -h;
  oCam.updateProjectionMatrix();
}
let tween = null;
function tweenCamera(pos, target, seconds = 0.45){
  if(walk.on) setNav('orbit');
  tween = { from:camera.position.clone(), to:pos.clone(),
            tf:controls.target.clone(), tt:target.clone(), t:0,
            dur: Math.max(0.001, seconds) };
}
function stepTween(dt){
  if(!tween) return;
  tween.t = Math.min(1, tween.t + dt/tween.dur);
  const e = tween.t < 0.5 ? 4*tween.t**3 : 1 - Math.pow(-2*tween.t+2, 3)/2;
  camera.position.lerpVectors(tween.from, tween.to, e);
  controls.target.lerpVectors(tween.tf, tween.tt, e);
  if(tween.t >= 1) tween = null;
}

function setProjection(kind){
  const old = camera;
  camera = kind === 'ortho' ? oCam : pCam;
  camera.position.copy(old.position);
  camera.up.copy(old.up);
  controls.object = camera;
  lens.setCamera(camera);
  if(kind === 'ortho') updateOrtho(camera.position.distanceTo(controls.target));
  else pCam.updateProjectionMatrix();
  controls.update();
  $('#fovRow').hidden = kind === 'ortho';
  resize();
}

/* ══════════════════════════════════════════════════════════
   Walk (first-person) navigation
   ══════════════════════════════════════════════════════════ */
const walk = {
  on:false, locked:false,
  euler:new THREE.Euler(0,0,0,'YXZ'),
  keys:Object.create(null),
  vel:new THREE.Vector3()
};
function setNav(mode){
  S.nav = mode;
  $$('#navSeg button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.nav === mode)));
  $('#fTool').textContent = mode === 'fps' ? 'Walk' : 'Orbit';
  updateHeaderMode();
  if(mode === 'fps'){
    if($('#proj').value === 'ortho'){ $('#proj').value = 'persp'; setProjection('persp'); }
    controls.enabled = false;
    walk.on = true;
    walk.euler.setFromQuaternion(camera.quaternion);
    $('#navNote').textContent = 'Click the viewport to take the cursor. W A S D to move, E and Q for up and down, Shift to sprint, Esc to release.';
    hint('Click the viewport to look around · Esc releases the cursor');
  }else{
    walk.on = false;
    if(document.pointerLockElement) document.exitPointerLock();
    controls.enabled = true;
    controls.target.copy(
      camera.position.clone().add(new THREE.Vector3(0,0,-1).applyQuaternion(camera.quaternion).multiplyScalar(S.radius || 1))
    );
    controls.update();
    $('#navNote').textContent = 'Drag to orbit, right-drag to pan, scroll to zoom. Double-click a surface to re-centre on it.';
  }
}
renderer.domElement.addEventListener('click', () => {
  if(walk.on && !walk.locked && !S.measuring) renderer.domElement.requestPointerLock();
});
document.addEventListener('pointerlockchange', () => {
  walk.locked = document.pointerLockElement === renderer.domElement;
});
document.addEventListener('mousemove', e => {
  if(!walk.locked) return;
  walk.euler.y -= e.movementX * 0.0022;
  walk.euler.x -= e.movementY * 0.0022;
  walk.euler.x = Math.max(-Math.PI/2 + 0.02, Math.min(Math.PI/2 - 0.02, walk.euler.x));
  camera.quaternion.setFromEuler(walk.euler);
});
function stepWalk(dt){
  if(!walk.on) return;
  const k = walk.keys;
  const base = parseFloat($('#walkSpeed').value) * Math.max(S.radius, 0.5) * 0.55;
  const speed = base * (k['shift'] ? 3 : 1);
  const dir = new THREE.Vector3(
    (k['d']?1:0) - (k['a']?1:0),
    (k['e']?1:0) - (k['q']?1:0),
    (k['s']?1:0) - (k['w']?1:0)
  );
  if(dir.lengthSq() === 0){ walk.vel.multiplyScalar(Math.max(0, 1 - dt*12)); }
  else{
    dir.normalize();
    const fwd = new THREE.Vector3(0,0,-1).applyQuaternion(camera.quaternion);
    const rgt = new THREE.Vector3(1,0,0).applyQuaternion(camera.quaternion);
    const up  = new THREE.Vector3(0,1,0);
    const wish = new THREE.Vector3()
      .addScaledVector(rgt, dir.x).addScaledVector(up, dir.y).addScaledVector(fwd, -dir.z)
      .normalize().multiplyScalar(speed);
    walk.vel.lerp(wish, Math.min(1, dt*10));
  }
  camera.position.addScaledVector(walk.vel, dt);
}
addEventListener('keydown', e => {
  const tag = (e.target.tagName || '').toLowerCase();
  if(tag === 'input' || tag === 'select' || tag === 'textarea') return;
  const k = e.key.toLowerCase();
  walk.keys[k] = true;
  if(k === 'shift') walk.keys['shift'] = true;

  if(k === 'f'){ frameView('fit'); }
  else if(k === 'm'){ toggleMeasure(); }
  else if(k === 'a' && !e.ctrlKey && !walk.on){ toggleAnnotate(); }
  else if(k === 'z'){ const s = $('#shading'); s.value = s.value === 'wire' ? 'shaded' : 'wire'; applyShading(); }
  else if(k === 'p'){ e.preventDefault(); screenshot(); }
  else if(k === '?' || (k === '/' && e.shiftKey)){ $('#help').classList.toggle('on'); }
  else if(k === 'escape'){
    $('#help').classList.remove('on');
    closePop();
    if(S.measuring) toggleMeasure();
    if(S.annotating) toggleAnnotate(false);
  }
  else if(k === ' '){ if(S.action){ e.preventDefault(); setPlaying(!S.playing); } }
  else if(k === 'b' && !e.ctrlKey){ cycleStage(); }
  else if(k === 'l' && !e.ctrlKey){ cycleLens(); }
  else if(e.ctrlKey && k === 'd'){ e.preventDefault(); captureView(); }
  else if(e.shiftKey && /^Digit[1-6]$/.test(e.code)){
    frameView(['front','back','left','right','top','bottom'][+e.code.slice(5) - 1]);
  }
  else if(!e.ctrlKey && !e.altKey && VIEW_KEYS.includes(k)){
    const v = S.views[VIEW_KEYS.indexOf(k)];
    if(v) flyToView(v);
  }
});
addEventListener('keyup', e => { walk.keys[e.key.toLowerCase()] = false; });
addEventListener('blur', () => { walk.keys = Object.create(null); });

/* ══════════════════════════════════════════════════════════
   Measuring
   ══════════════════════════════════════════════════════════ */
const ray = new THREE.Raycaster();
const ndc = new THREE.Vector2();

function toggleMeasure(force){
  const v = force ?? !S.measuring;
  S.measuring = v;
  $('#btnMeasure').classList.toggle('measuring', v);
  $('#btnMeasure2').textContent = v ? 'Stop measuring' : 'Start measuring';
  $('#btnMeasure2').classList.toggle('measuring', v);
  $('#fTool').textContent = v ? 'Measure' : (S.nav === 'fps' ? 'Walk' : 'Orbit');
  renderer.domElement.style.cursor = v ? 'crosshair' : '';
  if(v){
    if(walk.locked) document.exitPointerLock();
    hint('Click a surface to drop the first point · Shift snaps to the nearest vertex');
  }else{
    if(S.pending){ measureGroup.remove(S.pending.dot); S.pending = null; }
    hint(null);
  }
}

function pick(ev){
  const r = renderer.domElement.getBoundingClientRect();
  ndc.x = ((ev.clientX - r.left) / r.width) * 2 - 1;
  ndc.y = -((ev.clientY - r.top) / r.height) * 2 + 1;
  ray.setFromCamera(ndc, camera);
  const hits = ray.intersectObjects(S.meshes, false);
  return hits.length ? hits[0] : null;
}

function snapToVertex(hit){
  const g = hit.object.geometry, pos = g.attributes.position;
  if(!pos || !hit.face) return hit.point.clone();
  const cand = [hit.face.a, hit.face.b, hit.face.c];
  let best = null, bd = Infinity;
  const v = new THREE.Vector3();
  for(const i of cand){
    v.fromBufferAttribute(pos, i).applyMatrix4(hit.object.matrixWorld);
    const d = v.distanceTo(hit.point);
    if(d < bd){ bd = d; best = v.clone(); }
  }
  return best || hit.point.clone();
}

function makeDot(p){
  const m = new THREE.Mesh(
    new THREE.SphereGeometry(S.radius * 0.012, 16, 12),
    new THREE.MeshBasicMaterial({ color:0xf0b429, depthTest:false })
  );
  m.position.copy(p);
  m.renderOrder = 1000;
  measureGroup.add(m);
  return m;
}

renderer.domElement.addEventListener('pointerdown', ev => {
  if(!S.measuring || ev.button !== 0) return;
  const hit = pick(ev);
  if(!hit){ hint('No surface under the cursor there.'); return; }
  const p = (ev.shiftKey || $('#cSnap').checked) ? snapToVertex(hit) : hit.point.clone();

  if(!S.pending){
    S.pending = { p, dot: makeDot(p) };
    hint('Now click the second point.');
  }else{
    const a = S.pending.p, b = p;
    const dot2 = makeDot(b);
    const geo = new THREE.BufferGeometry().setFromPoints([a, b]);
    const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color:0xf0b429, depthTest:false }));
    line.renderOrder = 1000;
    measureGroup.add(line);

    const label = document.createElement('div');
    label.className = 'mlabel';
    overlay.appendChild(label);

    const rec = { a, b, dots:[S.pending.dot, dot2], line, label, mid:a.clone().add(b).multiplyScalar(0.5) };
    S.measures.push(rec);
    S.pending = null;
    renderMeasureList();
    hint('Segment added — click again to start another.');
  }
});

function renderMeasureList(){
  const box = $('#mlist');
  box.innerHTML = '';
  S.measures.forEach((m, i) => {
    const row = document.createElement('div');
    row.className = 'mrow';
    const n = document.createElement('span'); n.textContent = 'Segment ' + (i+1);
    const v = document.createElement('span'); v.className = 'v'; v.textContent = fmtLen(m.a.distanceTo(m.b));
    const x = document.createElement('button'); x.textContent = '×'; x.title = 'Remove';
    x.onclick = () => { removeMeasure(i); };
    row.append(n, v, x);
    box.appendChild(row);
  });
  $('#measTally').textContent = S.measures.length ? S.measures.length + ' segments' : '';
  updateLabels();
}
function removeMeasure(i){
  const m = S.measures[i];
  if(!m) return;
  m.dots.forEach(d => { measureGroup.remove(d); d.geometry.dispose(); d.material.dispose(); });
  measureGroup.remove(m.line); m.line.geometry.dispose(); m.line.material.dispose();
  m.label.remove();
  S.measures.splice(i,1);
  renderMeasureList();
}
function clearMeasures(){
  while(S.measures.length) removeMeasure(S.measures.length-1);
  if(S.pending){ measureGroup.remove(S.pending.dot); S.pending = null; }
}
function updateLabels(){
  const w = view.clientWidth, h = view.clientHeight;
  const v = new THREE.Vector3();
  for(const m of S.measures){
    v.copy(m.mid).project(camera);
    const vis = v.z < 1;
    m.label.style.display = vis ? '' : 'none';
    if(!vis) continue;
    m.label.style.left = ((v.x*0.5+0.5)*w) + 'px';
    m.label.style.top  = ((-v.y*0.5+0.5)*h) + 'px';
    m.label.textContent = fmtLen(m.a.distanceTo(m.b));
  }
}

/* double-click re-centres orbit pivot */
renderer.domElement.addEventListener('dblclick', ev => {
  if(S.measuring || walk.on) return;
  const hit = pick(ev);
  if(!hit) return;
  tweenCamera(camera.position.clone(), hit.point.clone());
});

/* ══════════════════════════════════════════════════════════
   Scene tree
   ══════════════════════════════════════════════════════════ */
function buildTree(){
  const box = $('#tree');
  box.innerHTML = '';
  let count = 0;
  const walkTree = (obj, depth) => {
    if(obj === S.root && obj.children.length === 1 && !obj.isMesh){
      return walkTree(obj.children[0], depth);
    }
    count++;
    const row = document.createElement('div');
    row.className = 'node';
    row.style.paddingLeft = (4 + depth*12) + 'px';

    const eye = document.createElement('span');
    eye.className = 'eye';
    eye.textContent = obj.visible ? '◉' : '○';
    eye.onclick = e => {
      e.stopPropagation();
      obj.visible = !obj.visible;
      eye.textContent = obj.visible ? '◉' : '○';
      row.classList.toggle('hidden', !obj.visible);
      syncWireVisibility();
    };

    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = obj.name || (obj.isMesh ? 'Mesh' : obj.type);

    const ty = document.createElement('span');
    ty.className = 'ty';
    if(obj.isMesh && obj.geometry?.attributes.position){
      const g = obj.geometry;
      ty.textContent = fmtNum(Math.round(g.index ? g.index.count/3 : g.attributes.position.count/3));
    }else ty.textContent = obj.type.replace('Object3D','Group');

    row.append(eye, nm, ty);
    row.onclick = () => {
      $$('#tree .node').forEach(n => n.classList.remove('sel'));
      row.classList.add('sel');
      S.selected = obj;
      const b = new THREE.Box3().setFromObject(obj);
      if(!b.isEmpty()){
        const c = b.getCenter(new THREE.Vector3());
        const r = Math.max(b.getSize(new THREE.Vector3()).length()*0.5, S.radius*0.02);
        const dir = camera.position.clone().sub(controls.target).normalize();
        tweenCamera(c.clone().add(dir.multiplyScalar(r*3.2)), c);
      }
    };
    box.appendChild(row);
    if(count < 400) obj.children.forEach(c => walkTree(c, depth+1));
  };
  if(S.root) walkTree(S.root, 0);
  $('#treeTally').textContent = count + ' nodes';
}
function syncWireVisibility(){
  wireGroup.children.forEach(seg => {
    const src = seg.userData.src;
    let vis = true, o = src;
    while(o && o !== scene){ if(!o.visible){ vis = false; break; } o = o.parent; }
    seg.visible = vis;
  });
}

/* ══════════════════════════════════════════════════════════
   Info panel
   ══════════════════════════════════════════════════════════ */
function refreshInfo(){
  const s = S.stats;
  const dot = S.fileName.lastIndexOf('.');
  const stem = dot > 0 ? S.fileName.slice(0, dot) : S.fileName;
  const ext  = dot > 0 ? S.fileName.slice(dot + 1).toUpperCase() : 'MODEL';
  $('#hEyebrow').textContent = ext + ' \u00b7 ' + fmtNum(s.meshes) + (s.meshes === 1 ? ' mesh \u00b7 ' : ' meshes \u00b7 ') + fmtNum(s.tris) + ' triangles';
  $('#hudName').textContent = stem;
  updateHeaderMode();
  $('#iFile').textContent   = S.fileName;
  $('#iMeshes').textContent = fmtNum(s.meshes);
  $('#iTris').textContent   = fmtNum(s.tris);
  $('#iVerts').textContent  = fmtNum(s.verts);
  $('#iMats').textContent   = fmtNum(s.mats);
  $('#iTex').textContent    = fmtNum(s.tex);
  $('#iSize').textContent   = fmtBytes(S.bytes);
  refreshDims();
  if(native) native.setTitle(S.root ? S.fileName : '');
}
function refreshDims(){
  if(!S.root) return;
  const f = unitFactor(), u = unitLabel();
  $('#dimX').textContent = fmtLen(S.size.x);
  $('#dimY').textContent = fmtLen(S.size.y);
  $('#dimZ').textContent = fmtLen(S.size.z);
  $('#dimD').textContent = fmtLen(S.size.length());
  const a = S.stats.area * f * f;
  const v = S.stats.volume * f * f * f;
  $('#dimA').textContent = a.toLocaleString(undefined,{maximumFractionDigits:2}) + ' ' + u + '²';
  $('#dimV').textContent = v.toLocaleString(undefined,{maximumFractionDigits:2}) + ' ' + u + '³';
  $('#hudDims').textContent = fmtLen(S.size.x,1) + ' × ' + fmtLen(S.size.y,1) + ' × ' + fmtLen(S.size.z,1);
  updateLabels();
  renderMeasureList();
}

/* ══════════════════════════════════════════════════════════
   Screenshot
   ══════════════════════════════════════════════════════════ */
async function screenshot(){
  if(!S.root){ toast('Nothing to capture', 'Load a model first.', 'err'); return; }
  const scale = parseInt($('#shotScale').value, 10);
  const alpha = $('#cShotAlpha').checked;
  const clean = $('#cShotClean').checked;

  const w = view.clientWidth, h = view.clientHeight;
  const oldBG = scene.background, oldAlpha = renderer.getClearAlpha();
  const oldPR = renderer.getPixelRatio();
  const shown = { grid:grid.visible, axes:axes.visible, shadow:shadowPlane.visible,
                  meas:measureGroup.visible, pad:padHud.visible };
  const markersWere = $('#cMarkers').checked;

  if(alpha){ scene.background = null; renderer.setClearAlpha(0); }
  if(clean){
    grid.visible = false; axes.visible = false; shadowPlane.visible = false;
    measureGroup.visible = false; padHud.visible = false;
    if(markersWere){ $('#cMarkers').checked = false; updateMarkers(); }
  }

  renderer.setPixelRatio(scale);
  renderer.setSize(w, h, false);
  if(camera === pCam){ pCam.aspect = w/h; pCam.updateProjectionMatrix(); }

  // The lens chain writes an opaque frame, so a transparent plate
  // has to bypass it.
  const useLens = lens.enabled && !alpha;
  if(useLens){ lens.setSize(w, h, scale); lens.render(); }
  else renderer.render(scene, camera);

  const url = renderer.domElement.toDataURL('image/png');

  renderer.setPixelRatio(oldPR);
  scene.background = oldBG; renderer.setClearAlpha(oldAlpha);
  grid.visible = shown.grid; axes.visible = shown.axes;
  shadowPlane.visible = shown.shadow; measureGroup.visible = shown.meas;
  padHud.visible = shown.pad;
  if(markersWere){ $('#cMarkers').checked = true; updateMarkers(); }
  resize();

  const name = S.fileName.replace(/\.[^.]+$/, '') + '-' + stamp() + '.png';

  // labels live in the DOM, so paint them onto the readback
  const finalURL = await paintCallouts(url, w, h, scale);

  const bin = atob(finalURL.split(',')[1]);
  const bytes = new Uint8Array(bin.length);
  for(let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

  if(native){
    saveBlob(bytes, 'image/png', name).then(res => {
      if(res && res.saved) toast('Screenshot saved', res.name + ' — ' + (w*scale) + ' × ' + (h*scale) + ' px.', 'ok');
    });
  }else{
    download(finalURL, name);
    toast('Screenshot saved', name + ' — ' + (w*scale) + ' × ' + (h*scale) + ' px.', 'ok');
  }
}
function stamp(){
  const d = new Date(), p = n => String(n).padStart(2,'0');
  return d.getFullYear() + p(d.getMonth()+1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}
function download(url, name){
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  if(url.startsWith('blob:')) setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function toBytes(data){
  if(typeof data === 'string') return new TextEncoder().encode(data);
  if(data instanceof ArrayBuffer) return new Uint8Array(data);
  if(ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return new Uint8Array(data);
}

const FILTERS = {
  png:  [{ name:'PNG image', extensions:['png'] }],
  glb:  [{ name:'Binary glTF', extensions:['glb'] }],
  gltf: [{ name:'glTF', extensions:['gltf'] }],
  obj:  [{ name:'Wavefront OBJ', extensions:['obj'] }],
  stl:  [{ name:'Stereolithography', extensions:['stl'] }],
  ply:  [{ name:'Polygon file', extensions:['ply'] }]
};

/* Native Save dialog on the desktop, browser download otherwise. */
async function saveBlob(data, mime, name){
  const kind = name.split('.').pop().toLowerCase();
  if(native){
    try{
      const res = await native.save({
        defaultName: name,
        filters: (FILTERS[kind] || []).concat([{ name:'All files', extensions:['*'] }]),
        data: toBytes(data)
      });
      if(res && res.saved){
        const t = toast('Saved', res.name, 'ok');
        lastSavedPath = res.filePath;
        return res;
      }
      return null;
    }catch(err){
      toast('Could not write the file', err.message || String(err), 'err');
      return null;
    }
  }
  download(URL.createObjectURL(new Blob([data], { type:mime })), name);
  return { saved:true, name };
}
let lastSavedPath = null;

/* ══════════════════════════════════════════════════════════
   Export / conversion
   ══════════════════════════════════════════════════════════ */
async function exportModel(){
  if(!S.root) return;
  const fmt = $('#expFmt').value;
  const base = S.fileName.replace(/\.[^.]+$/, '');
  const onlyVisible = $('#cExpVisible').checked;
  const withAnim = $('#cExpAnim').checked;

  // restore original materials so display modes never leak into the file
  const modeWas = $('#shading').value;
  if(modeWas !== 'shaded'){ $('#shading').value = 'shaded'; applyShading(); }

  status('Converting to ' + fmt.toUpperCase());
  try{
    if(fmt === 'glb' || fmt === 'gltf'){
      const exp = new GLTFExporter();
      const opts = { binary: fmt === 'glb', onlyVisible, animations: withAnim ? S.clips : [], maxTextureSize: 4096 };
      const out = await new Promise((res, rej) => exp.parse(S.root, res, rej, opts));
      if(fmt === 'glb') saveBlob(out, 'model/gltf-binary', base + '.glb');
      else saveBlob(JSON.stringify(out, null, 2), 'model/gltf+json', base + '.gltf');

    }else if(fmt === 'obj'){
      saveBlob(new OBJExporter().parse(S.root), 'text/plain', base + '.obj');

    }else if(fmt === 'stl' || fmt === 'stla'){
      const bin = fmt === 'stl';
      const out = new STLExporter().parse(S.root, { binary: bin });
      saveBlob(out, bin ? 'model/stl' : 'text/plain', base + '.stl');

    }else if(fmt === 'ply' || fmt === 'plya'){
      const bin = fmt === 'ply';
      const out = await new Promise(res => {
        const r = new PLYExporter().parse(S.root, res, { binary: bin });
        if(r != null) res(r);
      });
      saveBlob(out, 'application/octet-stream', base + '.ply');
    }
    status('Saved ' + base);
    toast('Converted', base + '.' + fmt.replace('a','') + ' saved to your downloads.', 'ok');
  }catch(err){
    console.error(err);
    status('Export failed');
    toast('Conversion failed', err.message || 'This scene could not be written in that format.', 'err');
  }finally{
    if(modeWas !== 'shaded'){ $('#shading').value = modeWas; applyShading(); }
  }
}

/* ══════════════════════════════════════════════════════════
   Sample scene
   ══════════════════════════════════════════════════════════ */
function demoScene(){
  const g = new THREE.Group();
  g.name = 'Sample assembly';

  const base = new THREE.Mesh(
    new THREE.CylinderGeometry(0.62, 0.72, 0.16, 64),
    new THREE.MeshStandardMaterial({ color:0x3d434c, metalness:0.85, roughness:0.32 })
  );
  base.name = 'Base plate'; base.position.y = 0.08;

  const column = new THREE.Mesh(
    new THREE.CylinderGeometry(0.09, 0.11, 1.05, 48),
    new THREE.MeshStandardMaterial({ color:0xb0b7c1, metalness:0.95, roughness:0.18 })
  );
  column.name = 'Column'; column.position.y = 0.68;

  const knot = new THREE.Mesh(
    new THREE.TorusKnotGeometry(0.34, 0.105, 220, 32),
    new THREE.MeshStandardMaterial({ color:0xf0b429, metalness:0.35, roughness:0.22, envMapIntensity:1.2 })
  );
  knot.name = 'Torus knot'; knot.position.y = 1.5;

  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(0.55, 0.022, 24, 128),
    new THREE.MeshStandardMaterial({ color:0x6c9ef8, metalness:0.6, roughness:0.25 })
  );
  ring.name = 'Guide ring'; ring.position.y = 1.5; ring.rotation.x = Math.PI/2;

  g.add(base, column, knot, ring);
  g.traverse(o => { if(o.isMesh){ o.castShadow = true; o.receiveShadow = true; } });

  const track = new THREE.QuaternionKeyframeTrack(
    knot.uuid + '.quaternion',
    [0, 2, 4],
    [ ...new THREE.Quaternion().toArray(),
      ...new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0), Math.PI).toArray(),
      ...new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0), Math.PI*2).toArray() ]
  );
  const clip = new THREE.AnimationClip('Knot spin', 4, [track]);

  adopt(g, [clip], null);
  $('#unitModel').value = 'm'; $('#unitShow').value = 'cm';
  refreshDims();
  toast('Sample scene loaded', 'A small assembly with one animated part, for trying the tools.', 'ok');
}

/* ══════════════════════════════════════════════════════════
   Drag & drop (files and folders)
   ══════════════════════════════════════════════════════════ */
let dragDepth = 0;
['dragenter','dragover'].forEach(t => view.addEventListener(t, e => {
  e.preventDefault();
  if(t === 'dragenter') dragDepth++;
  $('#drop').classList.add('on');
}));
['dragleave','drop'].forEach(t => view.addEventListener(t, e => {
  e.preventDefault();
  if(t === 'dragleave') dragDepth = Math.max(0, dragDepth-1);
  else dragDepth = 0;
  if(dragDepth === 0) $('#drop').classList.remove('on');
}));
view.addEventListener('drop', async e => {
  e.preventDefault();

  // On the desktop a dropped item is a real path. Reading it through the
  // main process picks up the .bin and texture files sitting beside it,
  // which a plain drop of one file would leave behind.
  if(native){
    const dropped = [...e.dataTransfer.files];
    const paths = dropped.map(f => native.pathFor(f)).filter(Boolean);
    const model = paths.find(p => MODEL_EXT.includes(extOf(p)));
    if(model){ openPath(model); return; }
    if(paths.length){
      toast('Not a model file', 'Drop a ' + MODEL_EXT.join(', ') + ' file, or the folder holding one.', 'err');
      return;
    }
  }

  const items = e.dataTransfer.items;
  let files = [];
  if(items && items.length && items[0].webkitGetAsEntry){
    const entries = [...items].map(i => i.webkitGetAsEntry()).filter(Boolean);
    for(const en of entries) files.push(...await readEntry(en));
  }else{
    files = [...e.dataTransfer.files];
  }
  handleFiles(files);
});
function readEntry(entry, path = ''){
  return new Promise(resolve => {
    if(entry.isFile){
      entry.file(f => { try{ Object.defineProperty(f, 'webkitRelativePath', { value: path + f.name }); }catch(_){}
                        resolve([f]); }, () => resolve([]));
    }else if(entry.isDirectory){
      const reader = entry.createReader();
      const all = [];
      const readBatch = () => reader.readEntries(async batch => {
        if(!batch.length){
          const nested = await Promise.all(all.map(e2 => readEntry(e2, path + entry.name + '/')));
          resolve(nested.flat());
          return;
        }
        all.push(...batch);
        readBatch();
      }, () => resolve([]));
      readBatch();
    }else resolve([]);
  });
}

/* ══════════════════════════════════════════════════════════
   Wiring
   ══════════════════════════════════════════════════════════ */
$('#filePick').addEventListener('change', e => { handleFiles(e.target.files); e.target.value = ''; });
$('#btnOpen').onclick = $('#btnOpen2').onclick = () => native ? native.openDialog() : $('#filePick').click();
$('#btnDemo').onclick = demoScene;
$('#btnFit').onclick = () => frameView('fit');
$('#btnMeasure').onclick = $('#btnMeasure2').onclick = () => toggleMeasure();
$('#btnUndoM').onclick = () => removeMeasure(S.measures.length-1);
$('#btnClearM').onclick = clearMeasures;
$('#btnShot').onclick = $('#btnShot2').onclick = screenshot;
$('#btnExport').onclick = exportModel;
$('#btnHelp').onclick = () => $('#help').classList.add('on');
$('#btnHelpClose').onclick = () => $('#help').classList.remove('on');
$('#help').addEventListener('click', e => { if(e.target.id === 'help') $('#help').classList.remove('on'); });
$('#railToggle').onclick = () => $('#rail').classList.toggle('open');

$$('#navSeg button').forEach(b => b.onclick = () => setNav(b.dataset.nav));
$$('[data-view]').forEach(b => b.onclick = () => frameView(b.dataset.view));

$('#shading').onchange = () => { applyShading(); updateHeaderMode(); };
$('#envPreset').onchange = () => {
  const preset = ENVS[$('#envPreset').value];
  if(preset && preset.ground) $('#groundMode').value = preset.ground;
  applyStage();
};
$('#groundMode').onchange = applyStage;
$('#bgColor').oninput = applyStage;
$('#cVignette').onchange = applyStage;
$('#cParticles').onchange = applyStage;
$('#cRays').onchange = applyStage;
$('#cFog').onchange = applyStage;
$('#expo').oninput = applyStage;
$('#envInt').oninput = applyMaterialOptions;
$('#tone').onchange = e => {
  renderer.toneMapping = {
    aces:THREE.ACESFilmicToneMapping, cineon:THREE.CineonToneMapping,
    reinhard:THREE.ReinhardToneMapping, linear:THREE.LinearToneMapping, none:THREE.NoToneMapping
  }[e.target.value];
  S.origMats.forEach(m => (Array.isArray(m)?m:[m]).forEach(x => x && (x.needsUpdate = true)));
};
$('#cAxes').onchange   = e => axes.visible = e.target.checked;
$('#cShadow').onchange = e => { renderer.shadowMap.enabled = e.target.checked; applyStage(); };
$('#cLights').onchange = applyStage;
$('#cDouble').onchange = applyMaterialOptions;
$('#cFlat').onchange   = applyMaterialOptions;
$('#cSpin').onchange   = e => S.spin = e.target.checked;

$('#proj').onchange = e => setProjection(e.target.value);
$('#fov').oninput = e => { pCam.fov = parseFloat(e.target.value); pCam.updateProjectionMatrix(); };

$('#unitModel').onchange = refreshDims;
$('#unitShow').onchange = refreshDims;

$('#clipSel').onchange = e => playClip(parseInt(e.target.value,10));
$('#btnPlay').onclick = () => setPlaying(!S.playing);
$('#btnStop').onclick = () => { if(S.action){ S.action.reset(); S.mixer.setTime(0); setPlaying(false); } };
$('#cLoop').onchange = () => { if(S.action) S.action.loop = $('#cLoop').checked ? THREE.LoopRepeat : THREE.LoopOnce; };
$('#animSpeed').oninput = e => { if(S.mixer) S.mixer.timeScale = parseFloat(e.target.value); };
let scrubbing = false;
$('#scrub').addEventListener('pointerdown', () => scrubbing = true);
addEventListener('pointerup', () => scrubbing = false);
$('#scrub').oninput = e => {
  if(!S.action || !S.mixer) return;
  const dur = S.action.getClip().duration;
  S.mixer.setTime((parseInt(e.target.value,10)/1000) * dur);
};

$('#btnShowAll').onclick = () => {
  if(!S.root) return;
  S.root.traverse(o => o.visible = true);
  buildTree(); syncWireVisibility();
};
$('#btnIsolate').onclick = () => {
  if(!S.root || !S.selected) { toast('Pick something first', 'Select a node in the tree, then isolate it.'); return; }
  const keep = new Set();
  S.selected.traverse(o => keep.add(o));
  let p = S.selected.parent;
  while(p && p !== scene){ keep.add(p); p = p.parent; }
  S.root.traverse(o => o.visible = keep.has(o));
  buildTree(); syncWireVisibility();
};

/* ══════════════════════════════════════════════════════════
   Resize & render loop
   ══════════════════════════════════════════════════════════ */
function resize(){
  const w = view.clientWidth, h = Math.max(view.clientHeight, 1);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(w, h, false);
  pCam.aspect = w/h;
  pCam.updateProjectionMatrix();
  lens.setSize(w, h, Math.min(window.devicePixelRatio, 2));
  if(camera === oCam) updateOrtho(camera.position.distanceTo(controls.target));
}
new ResizeObserver(resize).observe(view);
resize();

let fpsAcc = 0, fpsFrames = 0;
renderer.setAnimationLoop(() => {
  const dt = Math.min(S.clock.getDelta(), 0.1);

  stepTween(dt);
  stepWalk(dt);
  if(S.spin && !walk.on && S.root){ modelGroup.rotation.y += dt * 0.35; }
  if(controls.enabled) controls.update();
  if(S.mixer && S.playing) S.mixer.update(dt);

  if(S.mixer && S.action){
    const clip = S.action.getClip();
    const t = S.action.time % (clip.duration || 1);
    $('#animTime').textContent = t.toFixed(2) + ' / ' + clip.duration.toFixed(2) + ' s';
    if(!scrubbing) $('#scrub').value = Math.round((t / (clip.duration || 1)) * 1000);
  }

  atmo.update(dt, view.clientHeight, camera);
  renderer.info.reset();
  if(lens.enabled) lens.render(); else renderer.render(scene, camera);
  if(S.measures.length) updateLabels();
  if(S.views.length) updateMarkers();
  if(S.callouts.length) updateCallouts(dt);

  fpsAcc += dt; fpsFrames++;
  if(fpsAcc >= 0.5){
    $('#fFps').textContent = Math.round(fpsFrames / fpsAcc);
    $('#fCalls').textContent = renderer.info.render.calls;
    $('#fTris').textContent = fmtNum(renderer.info.render.triangles);
    fpsAcc = 0; fpsFrames = 0;
  }
});

/* boot */
setNav('orbit');
status('Ready — drop a model to begin');

window.addEventListener('error', e => {
  console.error(e.error || e.message);
});
window.addEventListener('unhandledrejection', e => {
  console.error(e.reason);
});


/* ══════════════════════════════════════════════════════════
   Desktop integration — paths, menus, window title
   ══════════════════════════════════════════════════════════ */
async function openPath(p){
  if(!native) return;
  const short = p.split(/[\\/]/).pop();
  S.pendingKey = p;
  status('Reading ' + short);
  progress(0.04);
  try{
    const bundle = await native.readModel(p);

    // The shell hands back streamable URLs rather than bytes, so the
    // loaders read straight off disk and a large scene is never copied.
    clearBlobs();
    for(const f of bundle.files) blobs.set(f.name.toLowerCase(), f.url);

    const siblings = bundle.files.map(f => ({ name: f.name, size: 0 }));
    await loadModel({ name: bundle.model, size: bundle.size }, siblings);
    refreshRecent();
  }catch(err){
    progress(1);
    status('Could not read ' + short);
    toast('Could not read ' + short, err.message || 'The file may be locked, missing, or in a format Prism does not read.', 'err');
  }
}

function closeModel(){
  if(!S.root) return;
  clearMeasures();
  modelGroup.remove(S.root);
  disposeTree(S.root);
  if(S.mixer){ S.mixer.stopAllAction(); S.mixer.uncacheRoot(S.root); }
  wireGroup.clear();
  S.root = null; S.meshes = []; S.origMats.clear(); S.selected = null;
  S.mixer = null; S.action = null; S.clips = [];
  S.stats = { meshes:0, tris:0, verts:0, mats:0, tex:0, area:0, volume:0 };
  $('#secAnim').hidden = true;
  $('#tree').innerHTML = ''; $('#treeTally').textContent = '';
  $('#empty').hidden = false;
  $('#header').hidden = true; $('#hud-bl').hidden = true;
  $('#views').hidden = true;
  S.views = []; S.activeView = null; renderViews();
  S.callouts = []; renderCallouts();
  ['#btnFit','#btnMeasure','#btnAnnotate','#btnShot','#btnExport'].forEach(sel => $(sel).disabled = true);
  ['#iFile','#iMeshes','#iTris','#iVerts','#iMats','#iTex','#iSize',
   '#dimX','#dimY','#dimZ','#dimD','#dimA','#dimV'].forEach(sel => $(sel).textContent = '—');
  toggleMeasure(false);
  if(native) native.setTitle('');
  status('Ready');
  refreshRecent();
}

/* Recently opened models, shown on the empty screen */
async function refreshRecent(){
  if(!native) return;
  const host = $('#recent');
  if(!host) return;
  let list = [];
  try{ list = await native.recent(); }catch{ /* ignore */ }
  host.innerHTML = '';
  if(!list.length || S.root){ host.hidden = true; return; }
  host.hidden = false;
  const h = document.createElement('div');
  h.className = 'recent-head';
  h.textContent = 'Recently opened';
  host.appendChild(h);
  list.slice(0, 5).forEach(r => {
    const b = document.createElement('button');
    b.className = 'recent-row';
    b.innerHTML = '<span class="rn"></span><span class="rd"></span>';
    b.firstChild.textContent = r.name;
    b.lastChild.textContent = r.dir;
    b.title = r.path;
    b.onclick = () => openPath(r.path);
    host.appendChild(b);
  });
}

if(native){
  native.onOpenPath(p => openPath(p));

  window.addEventListener('prism-drop-rejected', () => {
    toast('Not a model file', 'Drop a ' + MODEL_EXT.join(', ') + ' file, or the folder holding one.', 'err');
  });

  native.onCommand(({ id, value }) => {
    switch(id){
      case 'shading':
        $('#shading').value = value; applyShading(); break;
      case 'view':
        frameView(value); break;
      case 'nav':
        setNav(value); break;
      case 'proj':
        $('#proj').value = value; setProjection(value); break;
      case 'toggle': {
        const el = $('#' + value);
        if(el){ el.checked = !el.checked; el.dispatchEvent(new Event('change')); }
        break;
      }
      case 'toggle-panel': {
        const rail = $('#rail');
        rail.style.display = rail.style.display === 'none' ? '' : 'none';
        resize();
        break;
      }
      case 'env':
        $('#envPreset').value = value;
        $('#groundMode').value = ENVS[value].ground;
        buildPad(); applyStage();
        break;
      case 'ground':
        $('#groundMode').value = value; applyStage(); break;
      case 'cycle-stage':   cycleStage(); break;
      case 'lens':
        $('#lensPreset').value = value; applyLens(); break;
      case 'cycle-lens':    cycleLens(); break;
      case 'add-view':      captureView(); break;
      case 'add-part-view': captureForPart(); break;
      case 'std-views':     standardViews(); break;
      case 'annotate':      toggleAnnotate(); break;
      case 'clear-labels':  $('#btnClearCallouts').click(); break;
      case 'measure':       toggleMeasure(); break;
      case 'clear-measure': clearMeasures(); break;
      case 'show-all':      $('#btnShowAll').click(); break;
      case 'screenshot':    screenshot(); break;
      case 'export':
        if(!S.root){ toast('Nothing to convert', 'Open a model first.', 'err'); break; }
        $('#expFmt').value = value; exportModel(); break;
      case 'close-model':   closeModel(); break;
      case 'help':          $('#help').classList.toggle('on'); break;
    }
  });

  refreshRecent();
  status('Ready — open a model, or drop one here');
}

/* ══════════════════════════════════════════════════════════
   The stage

   Each preset is a complete lighting and backdrop rig rather
   than a background colour: sky gradient, light intensities and
   colours, exposure, fog and how the ground is treated.
   ══════════════════════════════════════════════════════════ */
const ENVS = {
  atmos: {
    label: 'Atmosphere', ground: 'shadow',
    sky: [['#05070b', 0], ['#090d13', 0.40], ['#151b24', 0.50], ['#080a0e', 0.62], ['#040507', 1]],
    exposure: 1.05, env: 0.85, vignette: 0.62, tint: '226,232,240',
    hemi: [0x8fa8c8, 0x0a0c10, 0.38],
    key:  [0xfff1de, 2.20], fill: [0x6f8ec0, 0.52], rim: [0xcfe0ff, 2.05],
    fog:  ['#05070a', 2.8, 14],
    floor: 0x0b0e12,
    particles: 1.0, rays: 0.9, warm: [0xffd9a8, 0xbfd8ff]
  },
  hangar: {
    label: 'Hangar deck', ground: 'pad',
    sky: [['#07090c', 0], ['#0c0f14', 0.43], ['#181c23', 0.5], ['#0b0d11', 0.58], ['#08090c', 1]],
    exposure: 1.05, env: 1.00, vignette: 0.55, tint: '226,232,240',
    hemi: [0x9fb4d0, 0x0c0e12, 0.45],
    key:  [0xffffff, 2.40], fill: [0x6f8ec0, 0.60], rim: [0xbcd4ff, 2.20],
    fog:  ['#0a0c0f', 2.6, 13],
    floor: 0x0e1116,
    particles: 0.45, rays: 0.35, warm: [0xffdcb0, 0xc9dcff]
  },
  void: {
    label: 'Black void', ground: 'shadow',
    sky: '#000000',
    exposure: 1.00, env: 1.05, vignette: 0.70, tint: '226,232,240',
    hemi: [0xffffff, 0x000000, 0.10],
    key:  [0xffffff, 2.40], fill: [0xaac4ff, 0.55], rim: [0xffffff, 2.60],
    fog: null, floor: 0x0a0b0d,
    particles: 0.55, rays: 0.0, warm: [0xffe7c4, 0xcfe0ff]
  },
  studio: {
    label: 'Studio sweep', ground: 'shadow',
    sky: [['#3d434c', 0], ['#2c313a', 0.52], ['#191d24', 1]],
    exposure: 1.00, env: 1.05, vignette: 0.25, tint: '226,232,240',
    hemi: [0xdfe6f2, 0x2a2d33, 0.55],
    key:  [0xffffff, 2.10], fill: [0xc8d6ff, 0.60], rim: [0xffffff, 0.95],
    fog: null, floor: 0x22262c,
    particles: 0.0, rays: 0.0
  },
  blueprint: {
    label: 'Blueprint', ground: 'grid',
    sky: [['#040a14', 0], ['#07101d', 0.5], ['#03070e', 1]],
    exposure: 1.12, env: 0.50, vignette: 0.50, tint: '150,200,255',
    hemi: [0x7fb4ff, 0x03060c, 0.50],
    key:  [0xdcecff, 1.75], fill: [0x4f8fe0, 0.60], rim: [0x8fd4ff, 1.90],
    fog:  ['#03070e', 2.4, 14],
    grid: [0x2f6fa8, 0x143049], floor: 0x081019,
    particles: 0.35, rays: 0.0, warm: [0x9fd0ff, 0xd8ecff]
  },
  dusk: {
    label: 'Dusk horizon', ground: 'pad',
    sky: [['#090c16', 0], ['#241d2e', 0.40], ['#5f3f2c', 0.49], ['#1a1310', 0.56], ['#0a0908', 1]],
    exposure: 1.15, env: 0.90, vignette: 0.50, tint: '240,214,190',
    hemi: [0xffc79a, 0x1a1410, 0.35],
    key:  [0xffd2a1, 2.30], fill: [0x6f8ec0, 0.30], rim: [0xffb070, 2.70],
    fog:  ['#150f0c', 2.6, 13],
    floor: 0x120f0c,
    particles: 0.8, rays: 0.55, warm: [0xffc487, 0xffe3c0]
  },
  overcast: {
    label: 'Overcast', ground: 'shadow',
    sky: [['#ccd4de', 0], ['#b0bac6', 0.5], ['#8b96a2', 1]],
    exposure: 0.92, env: 1.30, vignette: 0.12, tint: '38,46,58', light: true,
    hemi: [0xffffff, 0x9aa5b1, 0.90],
    key:  [0xffffff, 1.45], fill: [0xffffff, 0.75], rim: [0xffffff, 0.55],
    fog: null,
    grid: [0x8e99a6, 0xb4bec9], floor: 0xa9b3bf,
    particles: 0.0, rays: 0.0
  },
  envmap: {
    label: 'Environment map', ground: 'shadow',
    sky: 'env',
    exposure: 1.00, env: 1.10, vignette: 0.20, tint: '226,232,240',
    hemi: [0xffffff, 0x808080, 0.20],
    key:  [0xffffff, 1.60], fill: [0xffffff, 0.40], rim: [0xffffff, 0.80],
    fog: null, floor: 0x2a2f36,
    particles: 0.0, rays: 0.0
  },
  custom: {
    label: 'Flat colour', ground: 'grid',
    sky: 'custom',
    exposure: 1.00, env: 1.00, vignette: 0.20, tint: '226,232,240',
    hemi: [0xdfe6f2, 0x2a2d33, 0.55],
    key:  [0xffffff, 2.10], fill: [0xc8d6ff, 0.55], rim: [0xffffff, 1.00],
    fog: null, floor: 0x22262c,
    particles: 0.0, rays: 0.0
  }
};

/* the instrument deck: a dark disc plus a drawn overlay */
const padBase = new THREE.Mesh(
  new THREE.CylinderGeometry(1, 1, 1, 160, 1),
  new THREE.MeshStandardMaterial({
    color: 0x0e1116, roughness: 0.97, metalness: 0.0, envMapIntensity: 0.18
  })
);
padBase.receiveShadow = true;
padBase.renderOrder = -2;

const padHud = new THREE.Mesh(
  new THREE.CircleGeometry(1, 160),
  new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, opacity: 0.9 })
);
padHud.rotation.x = -Math.PI / 2;
padHud.renderOrder = -1;

scene.add(padBase, padHud);

let skyTex = null;

function buildPad(){
  const preset = ENVS[$('#envPreset').value] || ENVS.hangar;
  const dot = S.fileName.lastIndexOf('.');
  const title = (dot > 0 ? S.fileName.slice(0, dot) : S.fileName).slice(0, 22);
  const sub = `${fmtNum(S.stats.tris)} triangles · ${fmtNum(S.stats.meshes)} meshes · ${fmtLen(S.size.length(), 2)}`;

  if(padHud.material.map) padHud.material.map.dispose();
  padHud.material.map = makePadTexture(THREE, { title, sub, tint: preset.tint, bold: preset.light ? 1.5 : 1 });
  padHud.material.needsUpdate = true;
}

function applyStage(){
  const id = $('#envPreset').value;
  const p  = ENVS[id] || ENVS.hangar;
  const ground = $('#groundMode').value;

  $('#bgColorRow').hidden = id !== 'custom';

  /* backdrop */
  if(skyTex){ skyTex.dispose(); skyTex = null; }
  if(p.sky === 'env'){
    scene.background = envRT.texture;
    renderer.setClearAlpha(1);
  }else if(p.sky === 'custom'){
    scene.background = new THREE.Color($('#bgColor').value);
    renderer.setClearAlpha(1);
  }else if(typeof p.sky === 'string'){
    scene.background = new THREE.Color(p.sky);
    renderer.setClearAlpha(1);
  }else{
    skyTex = makeSkyTexture(THREE, p.sky);
    scene.background = skyTex;
    renderer.setClearAlpha(1);
  }

  /* light rig */
  hemi.color.setHex(p.hemi[0]); hemi.groundColor.setHex(p.hemi[1]);
  const lit = $('#cLights').checked;
  hemi.intensity = lit ? p.hemi[2] : p.hemi[2] * 0.4;
  key.color.setHex(p.key[0]);   key.intensity  = lit ? p.key[1]  : 0;
  fill.color.setHex(p.fill[0]); fill.intensity = lit ? p.fill[1] : 0;
  rim.color.setHex(p.rim[0]);   rim.intensity  = lit ? p.rim[1]  : 0;
  if(S.root){
    rim.position.set(-S.radius * 2.4, S.radius * 2.6, -S.radius * 4.2);
  }

  renderer.toneMappingExposure = parseFloat($('#expo').value) * p.exposure;
  $('#envInt').value = p.env;
  applyMaterialOptions();

  /* fog pulls the far edge of the deck into the dark */
  if(p.fog && $('#cFog').checked && S.root){
    scene.fog = new THREE.Fog(new THREE.Color(p.fog[0]), S.radius * p.fog[1], S.radius * p.fog[2]);
  }else{
    scene.fog = null;
  }

  /* ground treatment */
  const shadowOn = $('#cShadow').checked;
  padBase.visible = ground === 'pad';
  padHud.visible  = ground === 'pad';
  grid.visible    = ground === 'grid';
  shadowPlane.visible = shadowOn && (ground === 'grid' || ground === 'shadow');
  padBase.material.color.setHex(p.floor);
  padBase.material.envMapIntensity = p.light ? 0.9 : 0.18;

  if(p.grid){
    grid.material.color.setHex(p.grid[0]);
    grid.material.opacity = 0.8;
  }else{
    grid.material.color.setHex(0x4d5661);
    grid.material.opacity = 0.75;
  }

  $('#vignette').classList.toggle('on', $('#cVignette').checked && p.vignette > 0.05);
  $('#vignette').style.opacity = $('#cVignette').checked ? p.vignette : 0;

  document.documentElement.style.setProperty('--void', p.light ? '#aab4c0' : '#15171b');
  document.body.classList.toggle('lit', !!p.light);

  const motes = $('#cParticles').checked ? (p.particles ?? 0) : 0;
  atmo.setOpacity(motes);
  if(p.warm) atmo.setPalette(p.warm[0], p.warm[1]);
  $('#rays').classList.toggle('on', $('#cRays').checked && (p.rays ?? 0) > 0.01);
  $('#rays').style.opacity = $('#cRays').checked ? (p.rays ?? 0) : 0;
  if(padHud.material.map === null && S.root) buildPad();
}

function cycleStage(){
  const ids = Object.keys(ENVS);
  const i = ids.indexOf($('#envPreset').value);
  const next = ids[(i + 1) % ids.length];
  $('#envPreset').value = next;
  $('#groundMode').value = ENVS[next].ground;
  buildPad();
  applyStage();
  hint('Stage: ' + ENVS[next].label);
}

function updateHeaderMode(){
  const shade = $('#shading');
  $('#sMode').textContent  = S.nav === 'fps' ? 'Walk' : 'Orbit';
  $('#sShade').textContent = shade.options[shade.selectedIndex].textContent;
  $('#sView').textContent  = S.activeView ? S.activeView.name : 'Free orbit';
  $('#hudDims').textContent = S.root
    ? fmtLen(S.size.x, 1) + ' × ' + fmtLen(S.size.y, 1) + ' × ' + fmtLen(S.size.z, 1)
    : '—';
}

/* ══════════════════════════════════════════════════════════
   Views — named camera bookmarks, optionally tied to a part

   A view stores where the camera stood and what it looked at.
   When it is tied to an object the marker follows that object,
   so the annotation stays put if the part moves under animation.
   ══════════════════════════════════════════════════════════ */
const VIEW_KEYS = ['1','2','3','4','5','6','7','8','9','0','-','='];
let viewSeq = 0;

const STANDARD = [
  ['Hero',         [ 1.00, 0.62,  1.15]],
  ['Rear quarter', [-1.05, 0.48, -0.95]],
  ['Side profile', [ 1.60, 0.10,  0.02]],
  ['Front',        [ 0.00, 0.12,  1.60]],
  ['Rear',         [ 0.00, 0.12, -1.60]],
  ['Top',          [ 0.00, 1.60,  0.02]],
  ['Bottom',       [ 0.00,-1.60,  0.02]]
];

function makeView(name, pos, tgt, part){
  return {
    id: 'v' + (++viewSeq),
    name: (name || 'View ' + (S.views.length + 1)).slice(0, 28),
    pos: pos.toArray(),
    tgt: tgt.toArray(),
    part: part || null
  };
}

function standardViews(){
  if(!S.root) return;
  const d = fitDistance();
  S.views = STANDARD.map(([name, dir]) => {
    const v = new THREE.Vector3(...dir).normalize().multiplyScalar(d).add(S.center);
    return makeView(name, v, S.center.clone(), null);
  });
  S.activeView = null;
  renderViews();
  saveViews();
}

/* Frame one object from outside the model, so the part is
   isolated against the backdrop rather than buried in geometry. */
function viewForObject(obj, name){
  const box = new THREE.Box3().setFromObject(obj);
  if(box.isEmpty()) return null;
  const c = box.getCenter(new THREE.Vector3());
  const r = Math.max(box.getSize(new THREE.Vector3()).length() * 0.5, S.radius * 0.03);

  let dir = c.clone().sub(S.center);
  if(dir.lengthSq() < 1e-9) dir.set(0.62, 0.40, 0.90);
  dir.normalize();
  dir.y = Math.max(dir.y, 0.22);
  dir.normalize();

  const pos = c.clone().addScaledVector(dir, r * 3.1);
  return makeView(name || obj.name || 'Part', pos, c, obj.name || null);
}

function captureView(name){
  if(!S.root){ toast('Nothing to save', 'Open a model first.', 'err'); return; }
  if(S.views.length >= 12){ toast('Twelve is the limit', 'Remove a view before adding another — the list is bound to twelve keys.', 'err'); return; }
  const input = $('#viewName');
  const label = (name || input.value || '').trim() || 'View ' + (S.views.length + 1);
  const v = makeView(label, camera.position.clone(), controls.target.clone(), null);
  S.views.push(v);
  input.value = '';
  S.activeView = v;
  renderViews();
  saveViews();
  toast('View saved', label + ' — press ' + VIEW_KEYS[S.views.length - 1] + ' to come back to it.', 'ok');
}

function captureForPart(){
  if(!S.selected){ toast('Pick a part first', 'Choose something in the scene tree, then save a view of it.', 'err'); return; }
  if(S.views.length >= 12){ toast('Twelve is the limit', 'Remove a view before adding another.', 'err'); return; }
  const name = ($('#viewName').value || '').trim() || S.selected.name || 'Part';
  const v = viewForObject(S.selected, name);
  if(!v){ toast('That part has no geometry', 'Pick a mesh rather than an empty group.', 'err'); return; }
  S.views.push(v);
  $('#viewName').value = '';
  renderViews();
  saveViews();
  flyToView(v);
}

function flyToView(v){
  if(!v || !S.root) return;
  S.activeView = v;

  let tgt = new THREE.Vector3().fromArray(v.tgt);
  let pos = new THREE.Vector3().fromArray(v.pos);

  // A linked part may have moved since the view was saved.
  if(v.part){
    const obj = S.root.getObjectByName(v.part);
    if(obj){
      const box = new THREE.Box3().setFromObject(obj);
      if(!box.isEmpty()){
        const c = box.getCenter(new THREE.Vector3());
        pos.add(c.clone().sub(tgt));
        tgt = c;
      }
    }
  }

  if($('#proj').value === 'ortho'){ oCam.zoom = 1; updateOrtho(pos.distanceTo(tgt)); }
  tweenCamera(pos, tgt, parseFloat($('#flyTime').value));
  renderViews();
  updateHeaderMode();
}

/* ── markers pinned into the scene ── */
const markerLayer = document.createElement('div');
markerLayer.style.cssText = 'position:absolute;inset:0;pointer-events:none';
overlay.appendChild(markerLayer);

function rebuildMarkers(){
  markerLayer.innerHTML = '';
  S.views.forEach((v, i) => {
    if(!v.part) return;
    const b = document.createElement('button');
    b.className = 'amark';
    b.innerHTML = '<span class="ring"></span><span class="at"></span>';
    b.lastChild.textContent = v.name;
    b.title = 'Go to ' + v.name + '  (' + VIEW_KEYS[i] + ')';
    b.onclick = () => flyToView(v);
    b.style.display = 'none';
    v._el = b;
    markerLayer.appendChild(b);
  });
}

function updateMarkers(){
  const show = $('#cMarkers').checked;
  markerLayer.style.display = show ? '' : 'none';
  if(!show || !S.root) return;

  const w = view.clientWidth, h = view.clientHeight;
  const p = new THREE.Vector3();

  for(const v of S.views){
    if(!v._el) continue;
    let point = null;
    if(v.part){
      const obj = S.root.getObjectByName(v.part);
      if(obj && obj.visible){
        const box = new THREE.Box3().setFromObject(obj);
        if(!box.isEmpty()) point = box.getCenter(new THREE.Vector3());
      }
    }
    if(!point){ v._el.style.display = 'none'; continue; }

    p.copy(point).project(camera);
    if(p.z > 1 || p.x < -1.15 || p.x > 1.15 || p.y < -1.15 || p.y > 1.15){
      v._el.style.display = 'none';
      continue;
    }
    v._el.style.display = '';
    v._el.style.left = ((p.x * 0.5 + 0.5) * w) + 'px';
    v._el.style.top  = ((-p.y * 0.5 + 0.5) * h) + 'px';
    v._el.classList.toggle('near', S.activeView === v);
  }
}

/* ── the two lists: floating panel and rail editor ── */
function renderViews(){
  const panel = $('#views');
  panel.innerHTML = '';
  const showPanel = $('#cViewPanel').checked && S.views.length > 0 && !!S.root;
  panel.hidden = !showPanel;

  if(showPanel){
    const h = document.createElement('div');
    h.className = 'vh';
    h.textContent = 'Views';
    panel.appendChild(h);

    S.views.forEach((v, i) => {
      const b = document.createElement('button');
      b.className = 'vrow';
      b.setAttribute('aria-current', String(S.activeView === v));
      b.innerHTML = '<span class="vk"></span><span class="vn"></span>';
      b.children[0].textContent = VIEW_KEYS[i];
      b.children[1].textContent = v.name;
      if(v.part){
        const d = document.createElement('span');
        d.className = 'vp';
        d.title = 'Tied to ' + v.part;
        b.appendChild(d);
      }
      b.onclick = () => flyToView(v);
      panel.appendChild(b);
    });
  }

  const list = $('#viewList');
  list.innerHTML = '';
  S.views.forEach((v, i) => {
    const row = document.createElement('div');
    row.className = 'vitem';

    const k = document.createElement('span');
    k.className = 'vkey'; k.textContent = VIEW_KEYS[i];

    const nm = document.createElement('input');
    nm.className = 'vname'; nm.value = v.name; nm.maxLength = 28;
    nm.onchange = () => { v.name = nm.value.trim() || v.name; nm.value = v.name; renderViews(); saveViews(); };

    row.append(k, nm);

    if(v.part){
      const tag = document.createElement('span');
      tag.className = 'part'; tag.textContent = 'part'; tag.title = 'Tied to ' + v.part;
      row.appendChild(tag);
    }

    const go = document.createElement('button');
    go.textContent = '▸'; go.title = 'Go to this view';
    go.onclick = () => flyToView(v);

    const up = document.createElement('button');
    up.textContent = '⤒'; up.title = 'Replace with the current camera';
    up.onclick = () => {
      v.pos = camera.position.toArray();
      v.tgt = controls.target.toArray();
      saveViews();
      toast('View updated', v.name + ' now points where you are standing.', 'ok');
    };

    const del = document.createElement('button');
    del.className = 'del'; del.textContent = '×'; del.title = 'Remove';
    del.onclick = () => {
      if(S.activeView === v) S.activeView = null;
      S.views.splice(i, 1);
      renderViews(); saveViews();
    };

    row.append(go, up, del);
    list.appendChild(row);
  });

  $('#viewTally').textContent = S.views.length ? S.views.length + ' saved' : '';
  rebuildMarkers();
  updateMarkers();
  updateHeaderMode();
}

/* ── persistence, keyed by the model on disk ── */
async function saveViews(){
  if(!native || !S.modelKey) return;
  const plain = S.views.map(v => ({ id:v.id, name:v.name, pos:v.pos, tgt:v.tgt, part:v.part }));
  try{ await native.setViews(S.modelKey, plain); }catch(err){ console.warn('views not saved', err); }
}

async function initViews(){
  S.views = [];
  S.activeView = null;
  let saved = null;
  if(native && S.modelKey){
    try{ saved = await native.getViews(S.modelKey); }catch{ saved = null; }
  }
  if(saved && saved.length){
    S.views = saved.slice(0, 12);
    viewSeq = S.views.length;
    renderViews();
    status('Loaded ' + S.fileName + ' · ' + S.views.length + ' saved views');
  }else{
    standardViews();
  }
}

/* ── wiring ── */
$('#btnCapture').onclick = () => captureView();
$('#viewName').addEventListener('keydown', e => {
  if(e.key === 'Enter'){ e.preventDefault(); captureView(); }
  e.stopPropagation();
});
$('#btnCapturePart').onclick = captureForPart;
$('#btnStdViews').onclick = standardViews;
$('#btnClearViews').onclick = () => {
  S.views = []; S.activeView = null;
  renderViews(); saveViews();
};
$('#cViewPanel').onchange = renderViews;
$('#cMarkers').onchange = () => { updateMarkers(); };

/* Once the camera is driven by hand the named view no longer applies. */
controls.addEventListener('start', () => {
  if(S.activeView){ S.activeView = null; renderViews(); }
});

/* ── lens ── */
function applyLens(){
  const id = $('#lensPreset').value;
  const amt = parseFloat($('#lensAmount').value);
  lens.apply(id, amt);
  $('#lensAmountRow').hidden = id === 'off';
  const label = LENS_PRESETS[id] ? LENS_PRESETS[id].label : 'Off';
  $('#sLens').textContent = id === 'off' ? 'None' : label;
  $('#fLens').textContent = id === 'off' ? 'Lens off' : 'Lens ' + label.toLowerCase();
}
function cycleLens(){
  const ids = Object.keys(LENS_PRESETS);
  const next = ids[(ids.indexOf($('#lensPreset').value) + 1) % ids.length];
  $('#lensPreset').value = next;
  applyLens();
  hint('Lens: ' + (LENS_PRESETS[next].label));
}
$('#lensPreset').onchange = applyLens;
$('#lensAmount').oninput = applyLens;

/* ── stage boot ── */
$('#groundMode').value = ENVS[$('#envPreset').value].ground;
applyStage();
applyLens();
renderViews();

/* ══════════════════════════════════════════════════════════
   Callouts — leader-line labels in the encyclopaedia style

   Each one anchors to a world point (and the object under it, so
   it survives animation and hiding). The label floats at an offset
   the reader can drag; a two-segment leader joins the two, which is
   what makes a diagram legible: the line does the pointing, the box
   never covers the thing it names.
   ══════════════════════════════════════════════════════════ */
const SVG_NS = 'http://www.w3.org/2000/svg';
const leaders = $('#leaders');
const calloutLayer = document.createElement('div');
calloutLayer.style.cssText = 'position:absolute;inset:0;pointer-events:none';
overlay.appendChild(calloutLayer);

let calloutSeq = 0;
let occludeTick = 0;
const _v = new THREE.Vector3();

function svg(tag, attrs){
  const el = document.createElementNS(SVG_NS, tag);
  for(const k in attrs) el.setAttribute(k, attrs[k]);
  return el;
}

function toggleAnnotate(force){
  const v = force ?? !S.annotating;
  S.annotating = v;
  if(v && S.measuring) toggleMeasure(false);
  $('#btnAnnotate').classList.toggle('annotating', v);
  $('#btnAnnotate2').textContent = v ? 'Stop labelling' : 'Start labelling';
  $('#btnAnnotate2').classList.toggle('annotating', v);
  $('#fTool').textContent = v ? 'Annotate' : (S.nav === 'fps' ? 'Walk' : 'Orbit');
  renderer.domElement.style.cursor = v ? 'crosshair' : '';
  if(v){
    if(walk.locked) document.exitPointerLock();
    hint('Click a surface to drop a label · Esc when you are done');
  }else hint(null);
}

/* Fan the default offsets out from the model centre so a run of
   labels does not stack on top of itself. */
function defaultOffset(screenX, screenY){
  const w = view.clientWidth, h = view.clientHeight;
  const dx = screenX - w * 0.5, dy = screenY - h * 0.5;
  const right = dx >= 0;
  const spread = (S.callouts.length % 5) - 2;
  return [
    (right ? 1 : -1) * (0.13 + Math.abs(dy) / h * 0.05) * w / h,
    (spread * 0.075) + (dy < 0 ? -0.06 : 0.06)
  ];
}

function addCallout(point, object, screenX, screenY){
  const c = {
    id: 'c' + (++calloutSeq),
    name: (object && object.name) ? object.name : 'Label ' + (S.callouts.length + 1),
    body: '',
    point: point.toArray(),
    part: object && object.name ? object.name : null,
    off: defaultOffset(screenX, screenY)
  };
  S.callouts.push(c);
  renderCallouts();
  saveCallouts();
  openPop(c, true);
  return c;
}

function buildCalloutDom(c){
  const el = document.createElement('div');
  el.className = 'cl';
  el.innerHTML = '<span class="cl-t"></span>';
  el.firstChild.textContent = c.name;
  el.style.pointerEvents = 'auto';
  el.title = 'Drag to move · click to open';

  if(c.body && c.body.trim()){
    const i = document.createElement('span');
    i.className = 'cl-i'; i.textContent = 'i';
    el.appendChild(i);
  }

  // drag to reposition; a click that never moved opens the note
  let drag = null;
  el.addEventListener('pointerdown', ev => {
    if(ev.button !== 0) return;
    ev.stopPropagation();
    // capture can fail for synthetic or already-released pointers
    try{ el.setPointerCapture(ev.pointerId); }catch(_){}
    drag = { x: ev.clientX, y: ev.clientY, off: c.off.slice(), moved: false };
    el.classList.add('dragging');
  });
  el.addEventListener('pointermove', ev => {
    if(!drag) return;
    const h = Math.max(view.clientHeight, 1);
    const dx = (ev.clientX - drag.x) / h;
    const dy = (ev.clientY - drag.y) / h;
    if(Math.abs(ev.clientX - drag.x) + Math.abs(ev.clientY - drag.y) > 3) drag.moved = true;
    c.off = [drag.off[0] + dx, drag.off[1] + dy];
  });
  el.addEventListener('pointerup', ev => {
    if(!drag) return;
    el.classList.remove('dragging');
    const moved = drag.moved;
    drag = null;
    if(moved) saveCallouts(); else openPop(c);
  });

  const g = svg('g', {});
  const poly = svg('polyline', {});
  const halo = svg('circle', { class: 'halo', r: 5.5 });
  const hub  = svg('circle', { class: 'hub',  r: 2.4 });
  g.append(poly, halo, hub);

  c._el = el; c._g = g; c._poly = poly; c._halo = halo; c._hub = hub;
  calloutLayer.appendChild(el);
  leaders.appendChild(g);
}

function renderCallouts(){
  calloutLayer.innerHTML = '';
  leaders.innerHTML = '';
  S.callouts.forEach(buildCalloutDom);

  const list = $('#calloutList');
  list.innerHTML = '';
  S.callouts.forEach((c, i) => {
    const row = document.createElement('div');
    row.className = 'vitem';

    const k = document.createElement('span');
    k.className = 'vkey'; k.textContent = String(i + 1);

    const nm = document.createElement('input');
    nm.className = 'vname'; nm.value = c.name; nm.maxLength = 48;
    nm.onchange = () => { c.name = nm.value.trim() || c.name; nm.value = c.name; renderCallouts(); saveCallouts(); };

    row.append(k, nm);

    if(c.body && c.body.trim()){
      const t = document.createElement('span');
      t.className = 'part'; t.textContent = 'note';
      row.appendChild(t);
    }

    const open = document.createElement('button');
    open.textContent = '▸'; open.title = 'Open note';
    open.onclick = () => { flyToCallout(c); openPop(c); };

    const del = document.createElement('button');
    del.className = 'del'; del.textContent = '×'; del.title = 'Remove';
    del.onclick = () => removeCallout(c);

    row.append(open, del);
    list.appendChild(row);
  });

  $('#calloutTally').textContent = S.callouts.length ? S.callouts.length + ' labels' : '';
  updateCallouts(0);
}

function removeCallout(c){
  const i = S.callouts.indexOf(c);
  if(i < 0) return;
  if(S.activeCallout === c) closePop();
  S.callouts.splice(i, 1);
  renderCallouts();
  saveCallouts();
}

function calloutPoint(c){
  const p = new THREE.Vector3().fromArray(c.point);
  if(c.part && S.root){
    const obj = S.root.getObjectByName(c.part);
    if(obj){
      if(!obj.visible) return null;
      // follow the part if it has been moved since the label was placed
      if(c._local === undefined){
        obj.updateWorldMatrix(true, false);
        c._local = p.clone().applyMatrix4(new THREE.Matrix4().copy(obj.matrixWorld).invert());
        c._obj = obj;
      }
      obj.updateWorldMatrix(true, false);
      return c._local.clone().applyMatrix4(obj.matrixWorld);
    }
  }
  return p;
}

/* Lay out every leader for this frame. */
function updateCallouts(dt){
  const show = $('#cLeaders').checked && !!S.root;
  calloutLayer.style.display = show ? '' : 'none';
  leaders.style.display = show ? '' : 'none';
  if(!show) return;

  const w = view.clientWidth, h = view.clientHeight;
  leaders.setAttribute('viewBox', `0 0 ${w} ${h}`);
  leaders.setAttribute('width', w);
  leaders.setAttribute('height', h);

  const doOcclude = $('#cOcclude').checked;
  occludeTick++;
  const testOcclusion = doOcclude && occludeTick % 8 === 0 && S.meshes.length > 0;

  for(const c of S.callouts){
    const world = calloutPoint(c);
    if(!world){ c._el.style.display = 'none'; c._g.style.display = 'none'; continue; }

    _v.copy(world).project(camera);
    if(_v.z > 1){ c._el.style.display = 'none'; c._g.style.display = 'none'; continue; }

    const ax = (_v.x * 0.5 + 0.5) * w;
    const ay = (-_v.y * 0.5 + 0.5) * h;
    const lx = ax + c.off[0] * h;
    const ly = ay + c.off[1] * h;
    const right = c.off[0] >= 0;

    c._el.style.display = '';
    c._g.style.display = '';
    c._el.classList.toggle('right', right);
    c._el.classList.toggle('left', !right);
    c._el.style.left = lx + 'px';
    c._el.style.top  = ly + 'px';

    // two segments: a diagonal run out from the anchor, then a short
    // horizontal shoulder into the edge of the label
    const pad = 6;
    const attachX = right ? lx - pad : lx + pad;
    const elbowX  = right ? attachX - 22 : attachX + 22;
    c._poly.setAttribute('points', `${ax},${ay} ${elbowX},${ly} ${attachX},${ly}`);
    c._halo.setAttribute('cx', ax); c._halo.setAttribute('cy', ay);
    c._hub.setAttribute('cx', ax);  c._hub.setAttribute('cy', ay);

    if(testOcclusion){
      ray.set(camera.position, world.clone().sub(camera.position).normalize());
      const hits = ray.intersectObjects(S.meshes, false);
      const dist = camera.position.distanceTo(world);
      const hidden = hits.length > 0 && hits[0].distance < dist - S.radius * 0.012;
      c._el.classList.toggle('occluded', hidden);
      c._g.classList.toggle('dim', hidden);
    }
  }

  if(S.activeCallout) positionPop(S.activeCallout);
}

function flyToCallout(c){
  const world = calloutPoint(c);
  if(!world) return;
  const dir = camera.position.clone().sub(controls.target).normalize();
  const r = S.radius * 0.55;
  tweenCamera(world.clone().add(dir.multiplyScalar(r * 2.4)), world, parseFloat($('#flyTime').value));
}

/* ── the note popover ── */
const pop = $('#calloutPop');
let popEditing = false;

function openPop(c, startEditing){
  S.activeCallout = c;
  popEditing = !!startEditing;
  pop.hidden = false;
  syncPop();
  positionPop(c);
  if(popEditing) setTimeout(() => $('#cpTitleEdit').select(), 30);
}

function syncPop(){
  const c = S.activeCallout;
  if(!c) return;
  $('#cpTitle').hidden = popEditing;
  $('#cpBody').hidden = popEditing;
  $('#cpTitleEdit').hidden = !popEditing;
  $('#cpBodyEdit').hidden = !popEditing;
  $('#cpEdit').textContent = popEditing ? 'Save' : 'Edit';

  $('#cpTitle').textContent = c.name;
  const has = c.body && c.body.trim();
  $('#cpBody').textContent = has ? c.body : 'No note yet. Choose Edit to describe this part.';
  $('#cpBody').classList.toggle('empty', !has);
  $('#cpTitleEdit').value = c.name;
  $('#cpBodyEdit').value = c.body || '';
}

function positionPop(c){
  if(pop.hidden || !c._el || c._el.style.display === 'none') return;
  const r = c._el.getBoundingClientRect();
  const host = view.getBoundingClientRect();
  const w = pop.offsetWidth || 320, h = pop.offsetHeight || 200;

  // keep clear of the side panel, which floats over the same area
  const rail = $('#rail');
  const railW = (rail && rail.style.display !== 'none' && rail.offsetWidth)
    ? rail.offsetWidth + 24 : 0;
  const rightLimit = host.width - railW;

  const lx = r.left - host.left;
  let x = c.off[0] >= 0 ? lx + r.width + 12 : lx - w - 12;
  if(x + w > rightLimit) x = lx - w - 12;      // flip to the other side
  if(x < 10) x = Math.min(lx + r.width + 12, rightLimit - w - 10);

  let y = r.top - host.top + r.height / 2 - h / 2;
  x = Math.max(10, Math.min(host.width - w - 10, x));
  y = Math.max(10, Math.min(host.height - h - 10, y));
  pop.style.left = x + 'px';
  pop.style.top = y + 'px';
}

function closePop(){
  if(popEditing) commitPop();
  pop.hidden = true;
  S.activeCallout = null;
  popEditing = false;
}

function commitPop(){
  const c = S.activeCallout;
  if(!c) return;
  c.name = $('#cpTitleEdit').value.trim() || c.name;
  c.body = $('#cpBodyEdit').value;
  popEditing = false;
  renderCallouts();
  saveCallouts();
  syncPop();
}

$('#cpClose').onclick = closePop;
$('#cpEdit').onclick = () => { if(popEditing) commitPop(); else { popEditing = true; syncPop(); $('#cpBodyEdit').focus(); } };
$('#cpDelete').onclick = () => { const c = S.activeCallout; closePop(); if(c) removeCallout(c); };
$('#cpFly').onclick = () => { if(S.activeCallout) flyToCallout(S.activeCallout); };
pop.addEventListener('pointerdown', e => e.stopPropagation());
['#cpTitleEdit','#cpBodyEdit'].forEach(sel => $(sel).addEventListener('keydown', e => {
  e.stopPropagation();
  if(e.key === 'Escape'){ popEditing = false; syncPop(); }
  if(e.key === 'Enter' && (e.ctrlKey || sel === '#cpTitleEdit')){ e.preventDefault(); commitPop(); }
}));

/* ── placing ── */
renderer.domElement.addEventListener('pointerdown', ev => {
  if(!S.annotating || ev.button !== 0) return;
  const hit = pick(ev);
  if(!hit){ hint('No surface under the cursor there.'); return; }
  const r = renderer.domElement.getBoundingClientRect();
  addCallout(hit.point.clone(), hit.object, ev.clientX - r.left, ev.clientY - r.top);
});

/* ── persistence ── */
async function saveCallouts(){
  if(!native || !S.modelKey) return;
  const plain = S.callouts.map(c => ({ id:c.id, name:c.name, body:c.body, point:c.point, part:c.part, off:c.off }));
  try{ await native.setCallouts(S.modelKey, plain); }catch(err){ console.warn('labels not saved', err); }
}

async function initCallouts(){
  closePop();
  S.callouts = [];
  let saved = null;
  if(native && S.modelKey){
    try{ saved = await native.getCallouts(S.modelKey); }catch{ saved = null; }
  }
  if(saved && saved.length){
    S.callouts = saved;
    calloutSeq = saved.length;
  }
  renderCallouts();
}

$('#btnAnnotate').onclick = $('#btnAnnotate2').onclick = () => toggleAnnotate();
$('#btnClearCallouts').onclick = () => { closePop(); S.callouts = []; renderCallouts(); saveCallouts(); };
$('#cLeaders').onchange = () => updateCallouts(0);
$('#cOcclude').onchange = () => {
  if(!$('#cOcclude').checked)
    S.callouts.forEach(c => { c._el && c._el.classList.remove('occluded'); c._g && c._g.classList.remove('dim'); });
};

/* ── draw the labels into exported images ──
   The labels are HTML, so they are absent from a WebGL readback.
   Re-drawing them onto a 2D canvas is what makes an annotated
   screenshot usable outside the app. */
/* The light shafts are a screen-space DOM layer, so they are absent
   from a WebGL readback too. Redraw them the same way. */
function paintRays(g, w, h){
  const layer = $('#rays');
  const op = parseFloat(layer.style.opacity || '0');
  if(!layer.classList.contains('on') || op < 0.02) return;

  g.save();
  g.globalCompositeOperation = 'screen';   // matches the CSS layer's blend mode
  g.globalAlpha = op;

  const glow = g.createRadialGradient(w * 0.25, -h * 0.06, 0, w * 0.25, -h * 0.06, w * 0.34);
  glow.addColorStop(0, 'rgba(255,240,214,0.34)');
  glow.addColorStop(1, 'rgba(255,240,214,0)');
  g.fillStyle = glow;
  g.fillRect(0, 0, w, h);

  const beams = [[0.14, 0.15, 15, 34, 1], [0.24, 0.06, 12, 16, 0.85], [0.05, 0.26, 19, 60, 0.55]];
  for(const [left, wid, deg, blur, a] of beams){
    g.save();
    g.globalAlpha = op * a;
    g.filter = `blur(${blur}px)`;
    g.translate(w * left, -h * 0.24);
    g.rotate(deg * Math.PI / 180);
    const lg = g.createLinearGradient(0, 0, 0, h * 1.4);
    lg.addColorStop(0.00, 'rgba(255,242,222,0.30)');
    lg.addColorStop(0.34, 'rgba(255,236,208,0.13)');
    lg.addColorStop(0.62, 'rgba(255,228,196,0.04)');
    lg.addColorStop(1.00, 'rgba(255,220,190,0)');
    g.fillStyle = lg;
    g.fillRect(-w * wid / 2, 0, w * wid, h * 1.4);
    g.restore();
  }
  g.restore();
}

function paintCallouts(baseURL, w, h, scale){
  const wantLabels = $('#cShotLabels').checked && S.callouts.length && $('#cLeaders').checked;
  const wantRays = $('#rays').classList.contains('on') && parseFloat($('#rays').style.opacity || '0') > 0.02;

  return new Promise(resolve => {
    if(!wantLabels && !wantRays) return resolve(baseURL);

    const img = new Image();
    img.onload = () => {
      const cv = document.createElement('canvas');
      cv.width = w * scale; cv.height = h * scale;
      const g = cv.getContext('2d');
      g.drawImage(img, 0, 0, cv.width, cv.height);
      g.scale(scale, scale);

      paintRays(g, w, h);
      if(!wantLabels){ resolve(cv.toDataURL('image/png')); return; }

      g.font = '500 11px ui-sans-serif, system-ui, "Segoe UI", sans-serif';
      g.textBaseline = 'middle';
      g.lineJoin = 'round';

      for(const c of S.callouts){
        if(!c._el || c._el.style.display === 'none') continue;
        const world = calloutPoint(c);
        if(!world) continue;
        _v.copy(world).project(camera);
        if(_v.z > 1) continue;

        const ax = (_v.x * 0.5 + 0.5) * w;
        const ay = (-_v.y * 0.5 + 0.5) * h;
        const lx = ax + c.off[0] * h;
        const ly = ay + c.off[1] * h;
        const right = c.off[0] >= 0;

        const text = c.name.toUpperCase();
        const tw = g.measureText(text).width;
        const bw = tw + 20, bh = 24;
        const bx = right ? lx : lx - bw;
        const attachX = right ? lx - 6 : lx + 6;
        const elbowX  = right ? attachX - 22 : attachX + 22;

        g.strokeStyle = 'rgba(232,238,246,.8)';
        g.lineWidth = 1.15;
        g.beginPath();
        g.moveTo(ax, ay); g.lineTo(elbowX, ly); g.lineTo(attachX, ly);
        g.stroke();

        g.beginPath(); g.arc(ax, ay, 5.5, 0, Math.PI * 2);
        g.strokeStyle = 'rgba(232,238,246,.45)'; g.stroke();
        g.beginPath(); g.arc(ax, ay, 2.4, 0, Math.PI * 2);
        g.fillStyle = '#e8eef6'; g.fill();

        const by = ly - bh / 2;
        g.fillStyle = 'rgba(18,21,26,.80)';
        g.strokeStyle = 'rgba(255,255,255,.16)';
        g.lineWidth = 1;
        if(g.roundRect){ g.beginPath(); g.roundRect(bx, by, bw, bh, 7); g.fill(); g.stroke(); }
        else { g.fillRect(bx, by, bw, bh); g.strokeRect(bx, by, bw, bh); }

        g.fillStyle = '#e6eaf0';
        g.fillText(text, bx + 10, ly + 0.5);
      }
      resolve(cv.toDataURL('image/png'));
    };
    img.onerror = () => resolve(baseURL);
    img.src = baseURL;
  });
}

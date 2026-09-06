/* ══════════════════════════════════════════════════════════
   Procedural textures for the stage

   The ground pad and the sky gradients are drawn to canvases
   rather than shipped as images, so they adapt to whatever
   model is loaded and cost nothing to distribute.
   ══════════════════════════════════════════════════════════ */

const FACE = '"Segoe UI", Arial, Helvetica, sans-serif';

/* Lay text along a circular arc, one glyph at a time.

   `inward` flips the glyphs to face the centre and sweeps the arc
   the other way round, which is what the lower half of a dial needs
   in order to read left-to-right instead of upside down. */
function arcText(g, text, cx, cy, radius, centreAngle, size, weight, color, tracking = 0.34, inward = false) {
  g.save();
  g.fillStyle = color;
  g.font = `${weight} ${size}px ${FACE}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';

  const chars = [...text];
  const widths = chars.map(c => g.measureText(c).width + size * tracking);
  const totalAngle = widths.reduce((a, b) => a + b, 0) / radius;

  let a = inward ? centreAngle + totalAngle / 2 : centreAngle - totalAngle / 2;

  for (let i = 0; i < chars.length; i++) {
    const step = widths[i] / radius;
    const mid = inward ? a - step / 2 : a + step / 2;

    g.save();
    g.translate(cx + Math.cos(mid) * radius, cy + Math.sin(mid) * radius);
    g.rotate(mid + (inward ? -Math.PI / 2 : Math.PI / 2));
    g.fillText(chars[i], 0, 0);
    g.restore();

    a += inward ? -step : step;
  }
  g.restore();
}

/* A small target reticle with a caption, the kind that litters
   survey drawings and HUD overlays. */
function reticle(g, x, y, r, label, color) {
  g.save();
  g.strokeStyle = color;
  g.lineWidth = 2;
  g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.stroke();
  g.beginPath();
  g.moveTo(x - r * 1.7, y); g.lineTo(x + r * 1.7, y);
  g.moveTo(x, y - r * 1.7); g.lineTo(x, y + r * 1.7);
  g.stroke();
  if (label) {
    g.fillStyle = color;
    g.font = `400 ${r * 0.72}px ${FACE}`;
    g.textAlign = 'left';
    g.textBaseline = 'bottom';
    g.fillText(label, x + r * 1.9, y - r * 0.4);
  }
  g.restore();
}

/**
 * The circular deck the model stands on: heading ring, tick marks,
 * concentric guides and curved titling.
 */
export function makePadTexture(THREE, {
  size  = 2048,
  title = '',
  sub   = '',
  tint  = '226,232,240',
  bold  = 1
} = {}) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const cx = size / 2, cy = size / 2;
  const R  = size * 0.482;
  const ink = a => `rgba(${tint},${Math.min(1, a * bold)})`;

  g.clearRect(0, 0, size, size);
  g.lineCap = 'butt';

  /* ── outer rim: the one genuinely bright element ── */
  g.strokeStyle = ink(0.80);
  g.lineWidth = size * 0.0026;
  g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.stroke();

  g.strokeStyle = ink(0.26);
  g.lineWidth = size * 0.0012;
  g.beginPath(); g.arc(cx, cy, R * 0.962, 0, Math.PI * 2); g.stroke();

  /* ── heading ticks around the bearing ring ── */
  for (let deg = 0; deg < 360; deg += 5) {
    const major = deg % 30 === 0;
    const mid   = deg % 15 === 0;
    const len   = major ? 0.030 : mid ? 0.018 : 0.010;
    const a = THREE.MathUtils.degToRad(deg - 90);
    const r0 = R * 0.962, r1 = R * (0.962 - len);
    g.strokeStyle = ink(major ? 0.68 : mid ? 0.42 : 0.24);
    g.lineWidth = size * (major ? 0.0022 : 0.0013);
    g.beginPath();
    g.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
    g.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
    g.stroke();
  }

  /* ── three-digit bearings, upright to the rim ── */
  g.font = `400 ${size * 0.0255}px ${FACE}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = ink(0.62);
  for (let deg = 0; deg < 360; deg += 30) {
    const a = THREE.MathUtils.degToRad(deg - 90);
    const r = R * 0.926;
    g.save();
    g.translate(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    g.rotate(a + Math.PI / 2);
    g.fillText(String(deg).padStart(3, '0'), 0, 0);
    g.restore();
  }

  /* ── curved titling on the upper arc ── */
  if (title) arcText(g, title.toUpperCase(), cx, cy, R * 0.845, -Math.PI / 2, size * 0.040, 250, ink(0.44), 0.40, false);
  if (sub)   arcText(g, sub.toUpperCase(),   cx, cy, R * 0.848,  Math.PI / 2, size * 0.0165, 400, ink(0.26), 0.55, true);

  /* ── inner guide circles ── */
  [0.665, 0.455, 0.235].forEach((f, i) => {
    g.strokeStyle = ink(i === 0 ? 0.20 : 0.14);
    g.lineWidth = size * 0.0010;
    g.beginPath(); g.arc(cx, cy, R * f, 0, Math.PI * 2); g.stroke();
  });

  /* ── crosshair through the deck ── */
  g.strokeStyle = ink(0.17);
  g.lineWidth = size * 0.0011;
  g.beginPath();
  g.moveTo(cx, cy - R * 0.962); g.lineTo(cx, cy + R * 0.962);
  g.moveTo(cx - R * 0.962, cy); g.lineTo(cx + R * 0.962, cy);
  g.stroke();

  /* ── survey marks ── */
  reticle(g, cx + R * 0.40, cy - R * 0.24, size * 0.017, 'A1', ink(0.38));
  reticle(g, cx - R * 0.40, cy - R * 0.24, size * 0.017, 'A2', ink(0.38));
  reticle(g, cx,            cy + R * 0.52, size * 0.014, 'DATUM', ink(0.34));

  g.font = `400 ${size * 0.0145}px ${FACE}`;
  g.fillStyle = ink(0.34);
  g.textAlign = 'left';
  g.fillText('SCALE 1:1', cx - R * 0.60, cy + R * 0.34);
  g.textAlign = 'right';
  g.fillText('REF 000 / TRUE', cx + R * 0.60, cy + R * 0.34);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}

/**
 * A vertical gradient used as an equirectangular sky. Stops run from
 * straight up (0) to straight down (1).
 */
export function makeSkyTexture(THREE, stops) {
  const c = document.createElement('canvas');
  c.width = 16; c.height = 512;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, 512);
  stops.forEach(([color, at]) => grad.addColorStop(at, color));
  g.fillStyle = grad;
  g.fillRect(0, 0, 16, 512);

  const tex = new THREE.CanvasTexture(c);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

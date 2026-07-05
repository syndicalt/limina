// ---------------------------------------------------------------------------
// village-materials — the PURE, shared PROCEDURAL MATERIAL FACTORY for the
// settlement: every surface (ashlar stone, oak timber, thatch, slate, terracotta,
// daub plaster, rammed EARTH, cobble) is painted IN CODE from the design palette
// (canvas2d → sRGB CanvasTexture albedo + a sobel-derived normal map), no image
// files, no deps.
//
//   const mats = makeMaterials(THREE, direction, rng);   // → { stone, timber, …, earth, cobble, scaled, jitter }
//
// Like village-layout.mjs (layout) and village-geometry.mjs (ground geometry), this
// is a SHARED BRAIN both consumers run so there is ONE material system and no drift:
//   • tools/preview/assets/village.mjs (preview) dresses its authored building +
//     ground meshes with these materials.
//   • js/src/skills/village.ts (engine skill) dresses its lane + ground pads +
//     focal courtyard with the SAME earth/cobble materials (the buildings come from
//     baked GLBs, but the ground must match the preview's cobbled/earthen look).
//
// THREE is PASSED IN (not imported) so the module is agnostic to WHICH three build
// the caller uses — the preview's node_modules three.module and the engine's bundled
// three/webgpu are different instances, and a bare `import "three"` would double-bundle
// / mix instances. Everything else (canvas2d, palette math) is dependency-free.
//
// DETERMINISTIC: all randomness comes from the injected `rng` stream — no Math.random /
// Date — so the same (palette, mood, seed) always paints the same surfaces.
// ---------------------------------------------------------------------------

const R = (rng, a, b) => a + (b - a) * rng();

// ------------------------------------------------------- procedural textures
const TEX = 256;
function makeCanvas(n = TEX) {
  if (typeof document !== "undefined") {
    const c = document.createElement("canvas");
    c.width = c.height = n;
    return c;
  }
  return new OffscreenCanvas(n, n);
}
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const css = (c) =>
  `rgb(${Math.round(clamp01(c.r) * 255)},${Math.round(clamp01(c.g) * 255)},${Math.round(clamp01(c.b) * 255)})`;
const shade = (c, l) => c.clone().multiplyScalar(l);
const vary = (rng, c, dl, ds = 0.03, dh = 0.008) =>
  c.clone().offsetHSL(R(rng, -dh, dh), R(rng, -ds, ds), R(rng, -dl, dl));

// Albedo canvases are tagged SRGBColorSpace — the STANDARD, portable colorspace. Normal/
// data maps pass srgb=false (NoColorSpace). (See the note in village.mjs history: this is what
// makes the preview and a re-imported baked GLB agree.)
function canvasTexture(THREE, canvas, repeatX = 1, repeatY = repeatX, srgb = false) {
  const t = new THREE.CanvasTexture(canvas);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeatX, repeatY);
  t.anisotropy = 4;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  return t;
}

// Cheap sobel over the albedo's luminance → tangent-space normal map.
function normalFromCanvas(canvas, strength = 1.2) {
  const n = canvas.width;
  const src = canvas.getContext("2d").getImageData(0, 0, n, n).data;
  const lum = (x, y) => {
    const i = ((((y % n) + n) % n) * n + (((x % n) + n) % n)) * 4;
    return (src[i] * 0.299 + src[i + 1] * 0.587 + src[i + 2] * 0.114) / 255;
  };
  const out = makeCanvas(n);
  const octx = out.getContext("2d");
  const img = octx.createImageData(n, n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const dx = (lum(x + 1, y) - lum(x - 1, y)) * strength;
      const dy = (lum(x, y + 1) - lum(x, y - 1)) * strength;
      const inv = 1 / Math.hypot(dx, dy, 1);
      const o = (y * n + x) * 4;
      img.data[o] = (-dx * inv * 0.5 + 0.5) * 255;
      img.data[o + 1] = (dy * inv * 0.5 + 0.5) * 255;
      img.data[o + 2] = (inv * 0.5 + 0.5) * 255;
      img.data[o + 3] = 255;
    }
  }
  octx.putImageData(img, 0, 0);
  return out;
}

// -- paint functions: (ctx, n, base Color, rng) → draws one tile ------

// Coursed stone: ashlar blocks over recessed mortar, per-block tone shifts.
function paintAshlar(ctx, n, base, rng) {
  ctx.fillStyle = css(shade(base, 0.52));
  ctx.fillRect(0, 0, n, n);
  const courses = 7, ch = n / courses;
  for (let r = 0; r < courses; r++) {
    let x = r % 2 ? -ch * 0.9 : 0; // running bond offset
    while (x < n) {
      const bw = ch * R(rng, 1.5, 2.3);
      ctx.fillStyle = css(vary(rng, base, 0.06, 0.04));
      ctx.fillRect(x + 1.5, r * ch + 1.5, bw - 3, ch - 3);
      x += bw;
    }
  }
  ctx.globalAlpha = 0.16; // pitting
  for (let i = 0; i < 320; i++) {
    ctx.fillStyle = rng() < 0.5 ? css(shade(base, 0.6)) : css(shade(base, 1.18));
    ctx.fillRect(rng() * n, rng() * n, R(rng, 1, 2.6), R(rng, 1, 2.6));
  }
  ctx.globalAlpha = 1;
}

// Thatch: layered courses with a shadowed step, thousands of leaning strands.
function paintThatch(ctx, n, base, rng) {
  ctx.fillStyle = css(shade(base, 0.88));
  ctx.fillRect(0, 0, n, n);
  const courses = 5, cw = n / courses;
  for (let i = 0; i < 2200; i++) {
    const x = rng() * n, y = rng() * n, len = R(rng, 7, 20), lean = R(rng, -2.5, 2.5);
    ctx.lineWidth = R(rng, 0.7, 1.7);
    ctx.strokeStyle = css(vary(rng, base, 0.22, 0.06));
    ctx.globalAlpha = 0.55;
    for (const [ox, oy] of [[0, 0], [-n, 0], [0, -n]]) { // wrap the seam
      ctx.beginPath();
      ctx.moveTo(x + ox, y + oy);
      ctx.lineTo(x + len + ox, y + lean + oy);
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 0.38; // course shadow lines (perpendicular to the strands)
  ctx.fillStyle = css(shade(base, 0.4));
  for (let r = 0; r < courses; r++) ctx.fillRect((r + 1) * cw - 4.5, 0, 4.5, n);
  ctx.globalAlpha = 1;
}

// Daub/limewash plaster: soft mottled blotches + fine grit, never clean-flat.
function paintPlaster(ctx, n, base, rng) {
  ctx.fillStyle = css(base);
  ctx.fillRect(0, 0, n, n);
  for (let i = 0; i < 150; i++) {
    ctx.fillStyle = css(vary(rng, base, 0.05, 0.02));
    ctx.globalAlpha = 0.14;
    ctx.beginPath();
    ctx.arc(rng() * n, rng() * n, R(rng, 7, 30), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 0.1;
  for (let i = 0; i < 420; i++) {
    ctx.fillStyle = rng() < 0.5 ? css(shade(base, 0.7)) : css(shade(base, 1.15));
    ctx.fillRect(rng() * n, rng() * n, R(rng, 1, 2.2), R(rng, 1, 2.2));
  }
  ctx.globalAlpha = 1;
}

// Oak boards: vertical planks, tone-shifted, wavy grain, dark joints, knots.
function paintOak(ctx, n, base, rng) {
  const planks = 6, pw = n / planks;
  for (let p = 0; p < planks; p++) {
    ctx.fillStyle = css(vary(rng, base, 0.07, 0.05));
    ctx.fillRect(p * pw, 0, pw, n);
    ctx.globalAlpha = 0.28; // grain
    for (let gLine = 0; gLine < 7; gLine++) {
      const gx = p * pw + R(rng, 2, pw - 2), wob = R(rng, -3, 3);
      ctx.strokeStyle = css(shade(base, R(rng, 0.55, 0.8)));
      ctx.lineWidth = R(rng, 0.6, 1.4);
      ctx.beginPath();
      ctx.moveTo(gx, 0);
      ctx.quadraticCurveTo(gx + wob, n / 2, gx, n);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    if (rng() < 0.5) { // a knot
      ctx.fillStyle = css(shade(base, 0.5));
      ctx.beginPath();
      ctx.ellipse(p * pw + pw / 2, rng() * n, R(rng, 2, 4), R(rng, 3, 6), 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = css(shade(base, 0.42)); // joint
    ctx.fillRect(p * pw, 0, 1.8, n);
  }
}

// Terracotta: staggered tile courses, scalloped shadow at each course foot.
function paintTiles(ctx, n, base, rng) {
  ctx.fillStyle = css(shade(base, 0.7));
  ctx.fillRect(0, 0, n, n);
  const courses = 6, ch = n / courses, tw = n / 8;
  for (let r = 0; r < courses; r++) {
    const off = (r % 2) * tw * 0.5;
    for (let tIdx = -1; tIdx < 9; tIdx++) {
      ctx.fillStyle = css(vary(rng, base, 0.07, 0.05, 0.012));
      ctx.fillRect(tIdx * tw + off + 1, r * ch, tw - 2, ch - 2.5);
    }
    ctx.globalAlpha = 0.4; // scalloped course shadow
    ctx.fillStyle = css(shade(base, 0.4));
    for (let tIdx = -1; tIdx < 9; tIdx++) {
      ctx.beginPath();
      ctx.arc(tIdx * tw + off + tw / 2, (r + 1) * ch - 2, tw / 2.2, 0, Math.PI);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
}

// Slate: thin staggered rectangular shingles, cool tone shifts.
function paintSlate(ctx, n, base, rng) {
  ctx.fillStyle = css(shade(base, 0.55));
  ctx.fillRect(0, 0, n, n);
  const courses = 7, ch = n / courses, sw = n / 6;
  for (let r = 0; r < courses; r++) {
    const off = (r % 2) * sw * 0.5;
    for (let sIdx = -1; sIdx < 7; sIdx++) {
      ctx.fillStyle = css(vary(rng, base, 0.06, 0.03));
      ctx.fillRect(sIdx * sw + off + 1, r * ch + 1, sw - 2, ch - 2);
    }
  }
}

// Packed earth: a trodden dirt lane — broad damp/dry patches, fine grit, and embedded
// pebbles drawn with a shadow foot + lit top so the sobel normal map reads real relief.
function paintEarth(ctx, n, base, rng) {
  ctx.fillStyle = css(base);
  ctx.fillRect(0, 0, n, n);
  // broad damp/dry patches — big tonal areas so the lane isn't a flat wash
  for (let i = 0; i < 60; i++) {
    ctx.globalAlpha = 0.16;
    ctx.fillStyle = css(vary(rng, base, 0.11, 0.05));
    ctx.beginPath();
    ctx.ellipse(rng() * n, rng() * n, R(rng, 14, 46), R(rng, 10, 34), rng() * 3, 0, Math.PI * 2);
    ctx.fill();
  }
  // fine grit speckle
  ctx.globalAlpha = 0.22;
  for (let i = 0; i < 900; i++) {
    ctx.fillStyle = css(shade(base, R(rng, 0.5, 1.35)));
    ctx.fillRect(rng() * n, rng() * n, R(rng, 0.6, 1.6), R(rng, 0.6, 1.6));
  }
  // embedded pebbles: shadow foot → stone → highlight (gives the normal map a bump per stone)
  ctx.globalAlpha = 1;
  for (let i = 0; i < 90; i++) {
    const x = rng() * n, y = rng() * n, rr = R(rng, 1.6, 4.2);
    ctx.fillStyle = css(shade(base, 0.4));
    ctx.beginPath(); ctx.ellipse(x, y + rr * 0.5, rr, rr * 0.7, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = css(vary(rng, shade(base, 1.15), 0.06, 0.05));
    ctx.beginPath(); ctx.ellipse(x, y, rr, rr * 0.7, 0, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = css(shade(base, 1.5));
    ctx.beginPath(); ctx.ellipse(x - rr * 0.25, y - rr * 0.2, rr * 0.4, rr * 0.28, 0, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 1;
  }
}

// Gravel: dense angular stones of varied grey/tan over a dark bedding, each with a shadow
// foot + highlight so the normal map reads a crunchy, high-frequency crushed-stone surface.
function paintGravel(ctx, n, base, rng) {
  ctx.fillStyle = css(shade(base, 0.5));
  ctx.fillRect(0, 0, n, n);
  for (let i = 0; i < 1400; i++) {
    const x = rng() * n, y = rng() * n, rr = R(rng, 1.4, 3.6);
    const tone = R(rng, 0.68, 1.45);
    // shadow foot
    ctx.globalAlpha = 0.7;
    ctx.fillStyle = css(shade(base, 0.34));
    ctx.beginPath(); ctx.ellipse(x + rr * 0.2, y + rr * 0.3, rr * 1.05, rr * 0.85, rng() * 3, 0, Math.PI * 2); ctx.fill();
    // angular stone (irregular polygon)
    ctx.globalAlpha = 1;
    ctx.fillStyle = css(vary(rng, shade(base, tone), 0.05, 0.06, 0.02));
    const sides = 5 + ((rng() * 3) | 0);
    ctx.beginPath();
    for (let s = 0; s < sides; s++) {
      const a = (s / sides) * Math.PI * 2 + rng() * 0.4;
      const rad = rr * (0.72 + rng() * 0.42);
      const px = x + Math.cos(a) * rad, py = y + Math.sin(a) * rad * 0.85;
      s === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
    }
    ctx.closePath(); ctx.fill();
    // lit facet
    ctx.globalAlpha = 0.4;
    ctx.fillStyle = css(shade(base, tone * 1.5));
    ctx.beginPath(); ctx.ellipse(x - rr * 0.25, y - rr * 0.25, rr * 0.4, rr * 0.3, 0, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 1;
  }
}

// Cobbles: domed rounded setts over dark mortar — a shadow foot + a bright dome highlight
// per sett so the normal map lifts each stone into a real cobbled crown.
function paintCobble(ctx, n, base, rng) {
  ctx.fillStyle = css(shade(base, 0.32)); // dark mortar bedding
  ctx.fillRect(0, 0, n, n);
  const rows = 8, rh = n / rows;
  for (let r = 0; r < rows; r++) {
    let x = (r % 2) * rh * 0.55;
    while (x < n + rh) {
      const rw = rh * R(rng, 0.85, 1.25);
      const cx = x, cy = r * rh + rh / 2, a = rw / 2 - 1.2, b = rh / 2 - 1.4;
      ctx.fillStyle = css(shade(base, 0.22)); // shadow foot
      ctx.beginPath(); ctx.ellipse(cx, cy + 1.5, a + 1, b + 1, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = css(vary(rng, base, 0.09, 0.05, 0.015)); // sett
      ctx.beginPath(); ctx.ellipse(cx, cy, a, b, 0, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 0.45; // domed highlight
      ctx.fillStyle = css(shade(base, 1.4));
      ctx.beginPath(); ctx.ellipse(cx - a * 0.28, cy - b * 0.3, a * 0.42, b * 0.4, 0, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 1;
      x += rw;
    }
  }
}

// ---------------------------------------------------------------- materials
// Every material is minted from direction.palette (role → hex) and painted procedurally;
// mood strings flavor the finish. Fallback chains keep unknown palettes usable. THREE is
// injected so the module works under either consumer's three build.
export function makeMaterials(THREE, direction, rng) {
  const pal = direction?.palette ?? {};
  const mood = String(direction?.mood ?? "").toLowerCase();
  const weathered = /weather|worn|aged|lived|grim|rust|decay/.test(mood);

  const col = (...roles) => {
    for (const r of roles) if (pal[r]) return new THREE.Color(pal[r]);
    return new THREE.Color(0x8f8a80); // neutral last resort
  };

  const mk = (paint, baseColor, { repeat = 1, repeatY, rough = 0.9, normal = 1.2 } = {}) => {
    const base = baseColor.clone();
    if (weathered) base.multiplyScalar(0.93);
    const c = makeCanvas();
    paint(c.getContext("2d"), c.width, base, rng);
    return new THREE.MeshStandardMaterial({
      map: canvasTexture(THREE, c, repeat, repeatY ?? repeat, true),            // albedo → sRGB
      normalMap: canvasTexture(THREE, normalFromCanvas(c, normal), repeat, repeatY ?? repeat, false), // normals → linear
      roughness: weathered ? Math.max(rough, 0.85) : rough,
      metalness: 0.0,
    });
  };
  const plain = (c, roughness) =>
    new THREE.MeshStandardMaterial({ color: weathered ? shade(c, 0.93) : c, roughness, metalness: 0 });

  const timberC = col("timber", "trim", "stone");
  const mats = {
    stone: mk(paintAshlar, col("stone", "slate", "plaster"), { repeat: 2.2, rough: 0.92, normal: 1.7 }),
    timber: mk(paintOak, timberC, { repeat: 1.6, rough: 0.8, normal: 1.1 }),
    timberDark: mk(paintOak, shade(timberC, 0.68), { repeat: 1.6, rough: 0.85, normal: 1.1 }),
    plaster: mk(paintPlaster, col("plaster", "stone"), { repeat: 1, rough: 0.85, normal: 0.7 }),
    thatch: mk(paintThatch, col("thatch", "timber"), { repeat: 0.32, rough: 1.0, normal: 1.5 }),
    slate: mk(paintSlate, col("slate", "stone", "trim"), { repeat: 0.4, rough: 0.75, normal: 1.2 }),
    terracotta: mk(paintTiles, col("terracotta", "slate", "thatch"), { repeat: 0.3, rough: 0.8, normal: 1.5 }),
    trim: plain(col("trim", "timber"), 0.8),
    opening: plain(shade(col("trim", "slate"), 0.3), 0.95),
    earth: mk(paintEarth, col("timber", "trim").lerp(col("trim", "stone"), 0.45).lerp(new THREE.Color(0xffffff), 0.18), { repeat: 0.3, rough: 1.0, normal: 1.4 }),
    gravel: mk(paintGravel, col("stone", "slate").lerp(col("timber", "trim"), 0.28).lerp(new THREE.Color(0xffffff), 0.06), { repeat: 0.6, rough: 1.0, normal: 1.9 }),
    cobble: mk(paintCobble, shade(col("stone", "trim").lerp(timberC, 0.35), 0.92), { repeat: 0.32, rough: 0.9, normal: 2.0 }),
  };

  const scaledCache = new Map();
  mats.scaled = (name, rx, ry = rx) => {
    const key = `${name}:${rx}:${ry}`;
    if (scaledCache.has(key)) return scaledCache.get(key);
    const src = mats[name];
    const m = src.clone();
    for (const slot of ["map", "normalMap"]) {
      if (src[slot]) {
        m[slot] = src[slot].clone();
        m[slot].repeat.set(rx, ry);
        m[slot].needsUpdate = true;
      }
    }
    scaledCache.set(key, m);
    return m;
  };

  mats.jitter = (base, amt = 0.05) => {
    const m = base.clone();
    const hsl = { h: 0, s: 0, l: 0 };
    m.color.getHSL(hsl);
    m.color.setHSL(
      hsl.h + R(rng, -amt, amt) * 0.03,
      Math.max(0, hsl.s + R(rng, -amt, amt) * 0.2),
      THREE.MathUtils.clamp(hsl.l + R(rng, -amt, amt) * 0.12, 0.7, 1)
    );
    return m;
  };
  return mats;
}

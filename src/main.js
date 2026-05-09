// The Jean Sfeir Rain Machine™  — immersive edition

const FONTS = [
  "'Playfair Display', serif",
  "'Playfair Display', serif",
  "'Bebas Neue', cursive",
  "'Space Mono', monospace",
  "'Dancing Script', cursive",
  "'Abril Fatface', cursive",
  "'Courier Prime', monospace",
];

// Warm close / neutral mid / cool far color sets
const COLORS_WARM    = ['#ffffff','#ffffff','#ffffff','#fff4e0','#ff2d78','#ff6b35','#ffef00'];
const COLORS_NEUTRAL = ['#ffffff','#ffffff','#ffffff','#ffffff','#00ffcc','#c084fc','#ff2d78'];
const COLORS_COOL    = ['#ddeeff','#cce8ff','#aad4f5','#ffffff','#ffffff'];

// Depth tiers — close = big/bright/fast, far = small/dim/slow
const TIERS = [
  { weight: 0.18, size: [60, 170], speed: [3.5, 7],  opacity: [0.75, 1.0],  colors: COLORS_WARM,    glow: 28 },
  { weight: 0.52, size: [18, 62],  speed: [5,   13], opacity: [0.30, 0.88], colors: COLORS_NEUTRAL, glow: 14 },
  { weight: 0.30, size: [7,  22],  speed: [9,   20], opacity: [0.08, 0.38], colors: COLORS_COOL,    glow: 5  },
];

const NAMES = [
  'Jean Sfeir',
  'JEAN SFEIR',
  'jean sfeir',
  'J E A N  S F E I R',
  'Jean\nSfeir',
  'jEaN sFeiR',
  '— Jean Sfeir —',
  'jean. sfeir.',
  'JEAN\nSFEIR',
  'Jean Sfeir.',
];

const container  = document.getElementById('rain-container');
const hint       = document.getElementById('hint');
let clickCount   = 0;
let interacted   = false;
let isFlipped    = false;
let spawnDelay   = 210;
let introRunning = true;

// ─── Utilities ────────────────────────────────────────────────────────────────
const rng  = (a, b) => Math.random() * (b - a) + a;
const pick = arr => arr[Math.floor(Math.random() * arr.length)];

function pickTier() {
  const r = Math.random();
  let acc = 0;
  for (const t of TIERS) { acc += t.weight; if (r < acc) return t; }
  return TIERS[1];
}

// ─── Ripple ───────────────────────────────────────────────────────────────────
function ripple(cx, cy) {
  const el = document.createElement('div');
  el.className = 'ripple';
  Object.assign(el.style, { left: `${cx}px`, top: `${cy}px`, width: '4px', height: '4px' });
  document.body.appendChild(el);
  gsap.to(el, {
    scale: rng(28, 48), opacity: 0,
    duration: rng(0.7, 1.1), ease: 'power2.out',
    onComplete: () => el.remove(),
  });
  // second faint ring, slightly delayed
  const el2 = el.cloneNode();
  document.body.appendChild(el2);
  Object.assign(el2.style, { borderColor: 'rgba(255,255,255,0.22)' });
  gsap.to(el2, {
    scale: rng(18, 32), opacity: 0,
    duration: rng(1.0, 1.5), delay: 0.12, ease: 'power1.out',
    onComplete: () => el2.remove(),
  });
}

// ─── Ghost afterglow ──────────────────────────────────────────────────────────
function ghost(el) {
  const clone = el.cloneNode(true);
  const rect  = el.getBoundingClientRect();
  Object.assign(clone.style, {
    position:      'fixed',
    left:          `${rect.left}px`,
    top:           `${rect.top}px`,
    pointerEvents: 'none',
    zIndex:        8,
    opacity:       0.35,
    filter:        `blur(4px) brightness(2)`,
    transform:     'none',
  });
  document.body.appendChild(clone);
  gsap.to(clone, { opacity: 0, scale: 1.4, duration: 0.9, ease: 'power2.out', onComplete: () => clone.remove() });
}

// ─── Raindrop ─────────────────────────────────────────────────────────────────
function createDrop(opts = {}) {
  const tier    = opts.tier    ?? pickTier();
  const fontSize= opts.size    ?? rng(...tier.size);
  const x       = opts.x      ?? rng(-3, 97);
  const rot     = opts.rot    ?? rng(-48, 48);
  const color   = opts.color  ?? pick(tier.colors);
  const font    = opts.font   ?? pick(FONTS);
  const text    = opts.text   ?? pick(NAMES);
  const opacity = opts.opacity?? rng(...tier.opacity);
  const speed   = opts.speed  ?? rng(...tier.speed);

  const el = document.createElement('div');
  el.className = 'drop';
  el.textContent = text;
  Object.assign(el.style, {
    left:       `${x}vw`,
    fontFamily: font,
    fontSize:   `${fontSize}px`,
    color,
    opacity,
    rotate:     `${rot}deg`,
    textShadow: `0 0 ${tier.glow}px ${color}66, 0 0 ${tier.glow * 2}px ${color}22`,
  });
  container.appendChild(el);

  const dest = window.innerHeight + 380;
  const r    = Math.random();

  if (r < 0.08) {
    // full spin
    gsap.to(el, {
      y: dest,
      rotate: rot + rng(540, 1440) * (Math.random() < .5 ? 1 : -1),
      duration: speed, ease: 'none', onComplete: () => el.remove(),
    });
  } else if (r < 0.17) {
    // bounce & settle
    gsap.to(el, {
      y: window.innerHeight - fontSize * 1.3,
      duration: speed * 0.55, ease: 'bounce.out',
      onComplete: () => gsap.to(el, {
        opacity: 0, y: `+=${rng(15, 55)}`,
        duration: rng(1.5, 4), delay: rng(0.4, 3),
        onComplete: () => el.remove(),
      }),
    });
  } else if (r < 0.24) {
    // sine drift
    gsap.to(el, { y: dest, opacity: 0, duration: speed * 2.2, ease: 'sine.inOut', onComplete: () => el.remove() });
    gsap.to(el, { x: `+=${rng(50, 140)}`, duration: rng(0.35, 0.8), repeat: Math.ceil(speed * 3.5), yoyo: true, ease: 'sine.inOut' });
  } else if (r < 0.29) {
    // grow as it falls
    gsap.to(el, { y: dest, scale: rng(2, 3.5), opacity: 0, duration: speed * 1.6, ease: 'power1.in', onComplete: () => el.remove() });
  } else {
    gsap.to(el, { y: dest, duration: speed, ease: 'power1.in', onComplete: () => el.remove() });
  }

  // hover
  el.addEventListener('mouseenter', () => {
    gsap.to(el, { scale: rng(1.5, 2.8), duration: 0.16, ease: 'back.out(2)',
      onStart: () => { el.style.filter = `brightness(1.8) drop-shadow(0 0 14px ${color})`; }
    });
  });
  el.addEventListener('mouseleave', () => {
    ghost(el);
    gsap.to(el, { scale: 1, duration: 0.28, ease: 'power2.out',
      onComplete: () => { el.style.filter = ''; }
    });
  });

  el.addEventListener('click', e => {
    e.stopPropagation();
    handleInteraction();
    explode(el);
    clickCount++;
    checkMilestone();
  });

  return el;
}

// ─── Explosion ────────────────────────────────────────────────────────────────
function explode(el) {
  const rect  = el.getBoundingClientRect();
  const chars = [...el.textContent].filter(c => c.trim());
  const size  = parseFloat(el.style.fontSize);
  el.remove();

  chars.forEach((ch, i) => {
    const s = document.createElement('div');
    s.textContent = ch;
    Object.assign(s.style, {
      position:   'fixed',
      left:       `${rect.left + i * (size * 0.6)}px`,
      top:        `${rect.top}px`,
      fontFamily: el.style.fontFamily,
      fontSize:   `${size}px`,
      color:      pick([...COLORS_WARM, ...COLORS_NEUTRAL]),
      pointerEvents: 'none',
      zIndex:     500,
    });
    document.body.appendChild(s);
    gsap.to(s, {
      x: rng(-320, 320), y: rng(-400, 140),
      rotation: rng(-900, 900), opacity: 0,
      scale: rng(0.1, 2.8),
      duration: rng(0.8, 1.7), ease: 'power3.out',
      onComplete: () => s.remove(),
    });
  });
}

// ─── Click burst ──────────────────────────────────────────────────────────────
function burstAt(cx, cy, count = 10) {
  for (let i = 0; i < count; i++) {
    const el = document.createElement('div');
    el.textContent = pick(['Jean Sfeir', 'JEAN', 'SFEIR', 'J!', 'lol', '✦', ':)']);
    Object.assign(el.style, {
      position:   'fixed',
      left:       `${cx}px`, top: `${cy}px`,
      fontFamily: pick(FONTS),
      fontSize:   `${rng(13, 44)}px`,
      color:      pick(COLORS_WARM),
      pointerEvents: 'none', zIndex: 400, whiteSpace: 'nowrap',
    });
    document.body.appendChild(el);
    const angle = (i / count) * Math.PI * 2 + rng(0, 0.5);
    const dist  = rng(90, 230);
    gsap.fromTo(el,
      { x: 0, y: 0, opacity: 1, scale: 0 },
      { x: Math.cos(angle) * dist, y: Math.sin(angle) * dist,
        opacity: 0, scale: rng(0.4, 2.2), rotation: rng(-540, 540),
        duration: rng(0.55, 1.1), ease: 'power2.out',
        onComplete: () => el.remove() }
    );
  }
}

// ─── Screen shake ─────────────────────────────────────────────────────────────
function shake(v = 10) {
  gsap.to('#app', {
    keyframes: [
      { x: -v,      y: -v*.5,   duration: 0.04 },
      { x:  v,      y:  v*.5,   duration: 0.04 },
      { x: -v*.7,   y:  v*.3,   duration: 0.04 },
      { x:  v*.5,   y: -v*.4,   duration: 0.04 },
      { x: -v*.25,  y:  v*.2,   duration: 0.04 },
      { x: 0, y: 0, duration: 0.04 },
    ],
  });
}

// ─── Toast ────────────────────────────────────────────────────────────────────
function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  gsap.fromTo(t,
    { y: 40, opacity: 0, scale: 0.55 },
    { y: 0, opacity: 1, scale: 1, duration: 0.32, ease: 'back.out(2.5)',
      onComplete: () => gsap.to(t, {
        opacity: 0, y: -22, duration: 0.4, delay: 1.9,
        onComplete: () => t.remove(),
      }),
    }
  );
}

// ─── Milestones ───────────────────────────────────────────────────────────────
function checkMilestone() {
  if (clickCount === 7)  toast('ok you can stop');
  if (clickCount === 8)  toast('i said stop');
  if (clickCount === 9)  toast('...');
  if (clickCount === 15) {
    isFlipped = !isFlipped;
    document.body.classList.toggle('flipped', isFlipped);
    toast(isFlipped ? 'upside down mode' : 'back to normal');
    shake(12);
  }
  if (clickCount === 25) {
    document.body.classList.add('disco');
    toast('DISCO MODE');
    setTimeout(() => { document.body.classList.remove('disco'); toast('disco over :('); }, 6000);
  }
  if (clickCount > 0 && clickCount % 40 === 0) chaosMode();
}

function chaosMode() {
  toast('C  H  A  O  S');
  shake(20);
  spawnDelay = 15;
  for (let i = 0; i < 70; i++) setTimeout(createDrop, i * 25);
  setTimeout(() => { spawnDelay = 210; }, 5000);
}

// ─── Interaction state ────────────────────────────────────────────────────────
function handleInteraction() {
  if (interacted) return;
  interacted = true;
  gsap.to(hint, { opacity: 0, duration: 0.8 });
}

document.addEventListener('click', e => {
  if (e.target.classList.contains('drop')) return;
  handleInteraction();
  ripple(e.clientX, e.clientY);
  shake(6);
  burstAt(e.clientX, e.clientY);
});

// ─── Konami ───────────────────────────────────────────────────────────────────
const KONAMI = ['ArrowUp','ArrowUp','ArrowDown','ArrowDown','ArrowLeft','ArrowRight','ArrowLeft','ArrowRight','b','a'];
let kSeq = [];
document.addEventListener('keydown', e => {
  kSeq.push(e.key);
  if (kSeq.length > 10) kSeq.shift();
  if (JSON.stringify(kSeq) === JSON.stringify(KONAMI)) {
    chaosMode();
    document.body.classList.add('disco');
    toast('🏆 YOU FOUND IT');
    setTimeout(() => document.body.classList.remove('disco'), 9000);
  }
});

// ─── Opening sequence ─────────────────────────────────────────────────────────
function intro() {
  const cx = 50; // vw center
  const bursts = 12;

  for (let i = 0; i < bursts; i++) {
    setTimeout(() => {
      const angle  = (i / bursts) * Math.PI * 2;
      const radius = rng(10, 35); // vw
      const el     = createDrop({
        tier:    TIERS[0],
        x:       cx + Math.cos(angle) * radius,
        size:    rng(28, 80),
        opacity: rng(0.6, 1),
        speed:   rng(5, 11),
        rot:     rng(-30, 30),
      });
      // start from center and drift outward
      gsap.fromTo(el,
        { x: `${(cx - (cx + Math.cos(angle) * radius)) * window.innerWidth / 100}px`, opacity: 0, scale: 0.2 },
        { x: 0, opacity: parseFloat(el.style.opacity), scale: 1, duration: 0.9, ease: 'power2.out' }
      );
    }, i * 140);
  }

  setTimeout(() => { introRunning = false; }, bursts * 140 + 1200);
}

// ─── Rain loop ────────────────────────────────────────────────────────────────
function scheduleNext() {
  setTimeout(() => {
    createDrop();
    scheduleNext();
  }, spawnDelay + rng(-80, 140));
}

intro();

// fill screen after intro
setTimeout(() => {
  for (let i = 0; i < 20; i++) setTimeout(createDrop, i * 110);
  scheduleNext();
}, 2400);

// Special: one huge atmospheric ghost every 22s
setInterval(() => {
  createDrop({
    tier:    TIERS[2],
    size:    rng(140, 240),
    text:    'Jean Sfeir',
    font:    pick(["'Playfair Display', serif", "'Abril Fatface', cursive"]),
    color:   pick(['#ffffff', '#ddeeff']),
    opacity: rng(0.04, 0.14),
    speed:   rng(20, 35),
    rot:     rng(-6, 6),
  });
}, 22000);

// Special: tight cluster of tiny names every 16s
setInterval(() => {
  const cx = rng(8, 82);
  for (let i = 0; i < 14; i++) {
    setTimeout(() => createDrop({
      tier:    TIERS[2],
      x:       cx + rng(-5, 5),
      size:    rng(7, 13),
      opacity: rng(0.45, 0.9),
      speed:   rng(2, 5.5),
    }), i * 70);
  }
}, 16000);

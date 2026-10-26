#!/usr/bin/env node
// Draws the app icons and renders them to PNG with headless Chrome.
//
// One design for the whole family: a close-up of the Statue of Liberty's
// raised torch, with the app's own site icon as the flame. Everything is drawn
// on Android's 108x108 adaptive-icon grid; the launcher crops that to a shape
// roughly 72 units across, so the flame, torch and fist sit inside a circle of
// radius ~34 around the centre and only the rays and the sleeve run past it.
//
// Writes, per variant, into assets/icons/<variant>/:
//   icon.png        1024px, full square with background (legacy launchers)
//   foreground.png  1024px, transparent adaptive-icon foreground
//   monochrome.png  1024px, white silhouette for Android 13+ themed icons
// app.config.ts points each variant at these and sets its background colour.
//
// Usage: node scripts/make-icons.mjs   (needs google-chrome on PATH)
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SIZE = 1024;

// Background colours; app.config.ts uses the same values for the adaptive icon.
export const ICON_BACKGROUNDS = {
  youtube: '#FDECEA',
  instagram: '#FDE7F3',
  telegram: '#DCEFFB',
};

const PATINA = { light: '#6DBBA8', mid: '#4E9C8C', dark: '#3E8273', deep: '#2F6B5E' };
const GOLD = { light: '#F7D35A', mid: '#E2B12F', dark: '#B8891C' };

// The flame sits centred on (54, 37).
const FLAMES = {
  telegram: {
    color: (
      '<circle cx="54" cy="37" r="14" fill="#2AABEE"/>' +
      '<polygon points="43.5,37.6 63.5,29.4 59.8,46.6 54.4,42.1" fill="#fff"/>' +
      '<polygon points="54.4,42.1 51.7,46.6 52.2,41.2 60.8,32.1" fill="#CFE3F3"/>'
    ),
    shape: '<circle cx="54" cy="37" r="14"/>',
    glyph: '<polygon points="43.5,37.6 63.5,29.4 59.8,46.6 54.4,42.1"/>',
  },
  youtube: {
    color: (
      '<rect x="39" y="27" width="30" height="21" rx="6.5" fill="#FF0033"/>' +
      '<polygon points="50.5,32 50.5,43 60,37.5" fill="#fff"/>'
    ),
    shape: '<rect x="39" y="27" width="30" height="21" rx="6.5"/>',
    glyph: '<polygon points="50.5,32 50.5,43 60,37.5"/>',
  },
  instagram: {
    color: (
      '<rect x="41" y="24" width="26" height="26" rx="7.5" fill="#E1306C"/>' +
      '<rect x="45.5" y="28.5" width="17" height="17" rx="5" fill="none" stroke="#fff" stroke-width="2.4"/>' +
      '<circle cx="54" cy="37" r="4.2" fill="none" stroke="#fff" stroke-width="2.4"/>' +
      '<circle cx="59.6" cy="31.6" r="1.3" fill="#fff"/>'
    ),
    shape: '<rect x="41" y="24" width="26" height="26" rx="7.5"/>',
    glyph: (
      '<rect x="45.5" y="28.5" width="17" height="17" rx="5" fill="none" stroke="#000" stroke-width="2.4"/>' +
      '<circle cx="54" cy="37" r="4.2" fill="none" stroke="#000" stroke-width="2.4"/>' +
      '<circle cx="59.6" cy="31.6" r="1.3"/>'
    ),
  },
};

// Light rays around the flame, on the upper half only.
function rays(fill) {
  let out = '';
  for (const a of [-72, -40, -10, 20, 50]) {
    out += `<rect x="53" y="14" width="2.6" height="6" rx="1.3" fill="${fill}" transform="rotate(${a + 10} 54 37)"/>`;
  }
  return out;
}

// Raised arm in robe sleeve, fist, gilded torch. `c` picks colours, so the
// same geometry gives the colour art and the one-colour silhouette.
function torch(c) {
  return (
    // sleeve: the robe falls away from the wrist towards the bottom right
    `<path d="M45 74 C50 84 52 96 52 110 L94 110 C86 96 76 84 66 72 Z" fill="${c.mid}"/>` +
    `<path d="M58 78 C62 88 66 98 68 110 L76 110 C72 98 67 88 62 77 Z" fill="${c.dark}"/>` +
    `<path d="M66 72 C74 82 82 94 90 110 L94 110 C86 96 76 84 66 72 Z" fill="${c.deep}"/>` +
    `<path d="M47 79 C51 88 53 98 54 110 L57 110 C56 98 54 88 50 78 Z" fill="${c.light}"/>` +
    // cuff
    `<path d="M43 72 Q55 68 68 71 L67 77 Q55 74 45 78 Z" fill="${c.dark}"/>` +
    // fist around the handle, with finger lines
    `<rect x="45" y="61" width="19" height="13" rx="5" fill="${c.light}"/>` +
    `<path d="M49.5 62 v11 M54 62 v11 M58.5 62 v11" stroke="${c.mid}" stroke-width="1.2"/>` +
    // handle and gilded cup
    `<rect x="50" y="56" width="9" height="6" fill="${c.dark}"/>` +
    `<path d="M41.5 52 L66.5 52 L60 58 L48 58 Z" fill="${c.gold}"/>` +
    `<path d="M45.5 55 L62.5 55 L60 58 L48 58 Z" fill="${c.goldDark}"/>` +
    `<rect x="39" y="49" width="30" height="4" rx="2" fill="${c.goldLight}"/>`
  );
}

const COLOR = { ...PATINA, gold: GOLD.mid, goldDark: GOLD.dark, goldLight: GOLD.light };
const WHITE = Object.fromEntries(Object.keys(COLOR).map((k) => [k, '#fff']));

// The art is drawn a little high for its own bounds; this centres it in the
// launcher's crop. viewBox: the whole 108 canvas for adaptive layers, or only
// the middle 72 a launcher actually shows, for the full legacy icon.
const SHIFT = '<g transform="translate(0 5)">';
const FULL_CANVAS = '0 0 108 108';
const LAUNCHER_CROP = '18 18 72 72';

function svg(body, viewBox = FULL_CANVAS) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" width="${SIZE}" height="${SIZE}">${body}</svg>`;
}

function foreground(variant) {
  return svg(SHIFT + rays(GOLD.light) + torch(COLOR) + FLAMES[variant].color + '</g>');
}

function fullIcon(variant) {
  return svg(
    `<rect width="108" height="108" fill="${ICON_BACKGROUNDS[variant]}"/>` +
      SHIFT + rays(GOLD.light) + torch(COLOR) + FLAMES[variant].color + '</g>',
    LAUNCHER_CROP
  );
}

// One colour. The fist's finger lines and the flame's glyph are cut out, so
// the shapes still read when everything is the same white.
function monochrome(variant) {
  const f = FLAMES[variant];
  return svg(
    '<defs><mask id="m" maskUnits="userSpaceOnUse" x="0" y="0" width="108" height="108">' +
      '<rect width="108" height="108" fill="#fff"/>' +
      `<g fill="#000">${f.glyph}</g>` +
      '<path d="M49.5 62 v11 M54 62 v11 M58.5 62 v11" stroke="#000" stroke-width="1.2"/>' +
      '<path d="M43 72 Q55 68 68 71" fill="none" stroke="#000" stroke-width="1.2"/>' +
      '<rect x="41" y="53" width="26" height="1.4" fill="#000"/>' +
    '</mask></defs>' +
    `${SHIFT}<g mask="url(#m)" fill="#fff">${rays('#fff')}${torch(WHITE)}${f.shape}</g></g>`
  );
}

function render(svgText, out, work) {
  const html = join(work, 'icon.html');
  writeFileSync(
    html,
    `<html><body style="margin:0;background:transparent">${svgText}</body></html>`
  );
  execFileSync(
    'google-chrome',
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--hide-scrollbars',
      '--default-background-color=00000000',
      `--window-size=${SIZE},${SIZE}`,
      `--screenshot=${out}`,
      'file://' + html,
    ],
    { stdio: 'ignore' }
  );
}

const work = mkdtempSync(join(tmpdir(), 'icons-'));
try {
  for (const variant of Object.keys(FLAMES)) {
    const dir = join(ROOT, 'assets/icons', variant);
    mkdirSync(dir, { recursive: true });
    render(fullIcon(variant), join(dir, 'icon.png'), work);
    render(foreground(variant), join(dir, 'foreground.png'), work);
    render(monochrome(variant), join(dir, 'monochrome.png'), work);
    console.log('wrote assets/icons/' + variant);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

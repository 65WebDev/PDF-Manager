/**
 * Rebuild src-tauri/icons/icon.ico (and key PNGs) from a crisp geometric master.
 * Small sizes use classic BMP DIBs inside the ICO — Windows Explorer / shortcuts
 * often keep showing a stale or blank icon when the ICO only contains PNG frames.
 *
 * Also writes icons/pdf-manager-icon-v017.ico (versioned sidecar for NSIS cache-bust).
 *
 * Usage: node scripts/rebuild-windows-icon.mjs
 * Requires: system Python with Pillow (`pip install pillow`).
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const py = `
from PIL import Image, ImageDraw, ImageFont, ImageFilter
from pathlib import Path
import struct, io

root = Path(${JSON.stringify(path.join(root, 'src-tauri/icons'))})
app_png = Path(${JSON.stringify(path.join(root, 'src-tauri/app-icon.png'))})

def draw_master(size=1024):
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    blue, blue_dark = (20, 121, 230, 255), (0, 61, 128, 255)
    radius = int(size * 0.22)
    mask = Image.new('L', (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    grad = Image.new('RGBA', (size, size))
    gd = ImageDraw.Draw(grad)
    for y in range(size):
        t = y / max(1, size - 1)
        gd.line([(0, y), (size, y)], fill=(
            int(blue[0]*(1-t)+blue_dark[0]*t),
            int(blue[1]*(1-t)+blue_dark[1]*t),
            int(blue[2]*(1-t)+blue_dark[2]*t), 255))
    img.paste(grad, (0, 0), mask)
    d = ImageDraw.Draw(img)
    s = size / 42.0
    d.rounded_rectangle([20*s, 9*s, 32*s, 24*s], radius=max(1, int(1.5*s)), fill=(255,255,255,82))
    # Bottom ends inside the red badge so rx corners don't reveal white fringe
    d.rounded_rectangle([13.5*s, 8*s, 31.5*s, 26*s], radius=max(1, int(1.5*s)), fill=(255,255,255,255))
    d.polygon([(27*s, 8*s), (33*s, 14*s), (27*s, 14*s)], fill=(188, 220, 255, 255))
    d.rounded_rectangle([17*s, 17*s, 29*s, 18.6*s], radius=max(1, int(0.8*s)), fill=(159, 184, 214, 255))
    # Re-paint blue under the badge box BEFORE red, so rounded-corner AA
    # blends with blue (not leftover white page pixels → white fringe).
    badge = [9*s, 21*s, 33*s, 34*s]
    pad = max(2, int(0.6 * s))
    # Expand left/right/bottom only — keep white page intact above the badge.
    scrub = [badge[0]-pad, badge[1], badge[2]+pad, badge[3]+pad]
    sx0, sy0 = max(0, int(scrub[0])), max(0, int(scrub[1]))
    sx1, sy1 = min(size, int(scrub[2])+1), min(size, int(scrub[3])+1)
    region = grad.crop((sx0, sy0, sx1, sy1))
    img.paste(region, (sx0, sy0))
    d.rounded_rectangle(badge, radius=max(2, int(2*s)), fill=(224, 52, 43, 255))
    try:
        font = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', max(10, int(10.5*s)))
    except Exception:
        font = ImageFont.load_default()
    bbox = d.textbbox((0, 0), 'PDF', font=font)
    tw, th = bbox[2]-bbox[0], bbox[3]-bbox[1]
    d.text(((9*s+33*s)/2 - tw/2, (21*s+34*s)/2 - th/2), 'PDF', fill=(255,255,255,255), font=font)
    return img

def sharpen_resize(src, size):
    hi = src if src.size[0] >= size * 3 else src.resize((size*4, size*4), Image.Resampling.LANCZOS)
    out = hi.resize((size, size), Image.Resampling.LANCZOS)
    return out.filter(ImageFilter.UnsharpMask(
        radius=0.8 if size <= 32 else 1.2,
        percent=160 if size <= 32 else 120,
        threshold=1))

def png_bytes(img):
    buf = io.BytesIO(); img.save(buf, format='PNG'); return buf.getvalue()

def bmp_dib_bytes(img):
    w, h = img.size
    r, g, b, a = img.split()
    xor = bytearray()
    for y in range(h - 1, -1, -1):
        for x in range(w):
            xor += bytes((b.getpixel((x, y)), g.getpixel((x, y)), r.getpixel((x, y)), a.getpixel((x, y))))
    row_bytes = ((w + 31) // 32) * 4
    header = struct.pack('<IIIHHIIIIII', 40, w, h * 2, 1, 32, 0, len(xor), 0, 0, 0, 0)
    return header + xor + bytes(row_bytes * h)

master = draw_master(1024)
master.save(app_png)
sizes = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256]
entries = []
for s in sizes:
    img = sharpen_resize(master, s)
    if s in (32, 64, 128): img.save(root / f'{s}x{s}.png')
    if s == 256: img.save(root / '128x128@2x.png')
    entries.append((s, png_bytes(img) if s >= 256 else bmp_dib_bytes(img)))
master.resize((512, 512), Image.Resampling.LANCZOS).save(root / 'icon.png')
header = struct.pack('<HHH', 0, 1, len(entries))
offset = 6 + 16 * len(entries)
dir_entries = b''; blobs = b''
for s, payload in entries:
    wb = 0 if s >= 256 else s
    dir_entries += struct.pack('<BBBBHHII', wb, wb, 0, 0, 1, 32, len(payload), offset)
    blobs += payload; offset += len(payload)
ico = header + dir_entries + blobs
(root / 'icon.ico').write_bytes(ico)
(root / 'pdf-manager-icon-v017.ico').write_bytes(ico)
print('ok', root / 'icon.ico', len(ico))
`;

const r = spawnSync('python3', ['-c', py], { cwd: root, encoding: 'utf8' });
if (r.status !== 0) {
  console.error(r.stderr || r.stdout || 'python3 failed (need Pillow: pip install pillow)');
  process.exit(r.status || 1);
}
process.stdout.write(r.stdout || '');

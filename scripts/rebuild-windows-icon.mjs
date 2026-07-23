/**
 * Rebuild src-tauri/icons/icon.ico (and key PNGs) from src-tauri/app-icon.png.
 * Small sizes use classic BMP DIBs inside the ICO — Windows Explorer / shortcuts
 * often keep showing a stale or blank icon when the ICO only contains PNG frames.
 *
 * Usage: node scripts/rebuild-windows-icon.mjs
 * Requires: npm i -D sharp   OR   system Python with Pillow (auto-fallback).
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const py = `
from PIL import Image
from pathlib import Path
import struct, io
root = Path(${JSON.stringify(path.join(root, 'src-tauri/icons'))})
base = Image.open(${JSON.stringify(path.join(root, 'src-tauri/app-icon.png'))}).convert('RGBA')
sizes = [16, 24, 32, 48, 64, 128, 256]

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
    and_mask = bytes(row_bytes * h)
    header = struct.pack('<IIIHHIIIIII', 40, w, h * 2, 1, 32, 0, len(xor), 0, 0, 0, 0)
    return header + xor + and_mask

entries = []
for s in sizes:
    img = base.resize((s, s), Image.Resampling.LANCZOS)
    if s in (32, 64, 128): img.save(root / f'{s}x{s}.png')
    if s == 256: img.save(root / '128x128@2x.png')
    payload = png_bytes(img) if s >= 256 else bmp_dib_bytes(img)
    entries.append((s, payload))
base.resize((512, 512), Image.Resampling.LANCZOS).save(root / 'icon.png')
count = len(entries)
header = struct.pack('<HHH', 0, 1, count)
offset = 6 + 16 * count
dir_entries = b''; blobs = b''
for s, payload in entries:
    wb = 0 if s >= 256 else s; hb = wb
    dir_entries += struct.pack('<BBBBHHII', wb, hb, 0, 0, 1, 32, len(payload), offset)
    blobs += payload; offset += len(payload)
(root / 'icon.ico').write_bytes(header + dir_entries + blobs)
print('ok', root / 'icon.ico')
`;

const r = spawnSync('python3', ['-c', py], { cwd: root, encoding: 'utf8' });
if (r.status !== 0) {
  console.error(r.stderr || r.stdout || 'python3 failed (need Pillow: pip install pillow)');
  process.exit(r.status || 1);
}
process.stdout.write(r.stdout || '');

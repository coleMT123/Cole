#!/usr/bin/env python3
import struct, zlib, math

def make_png(size, bg, fg):
    w, h = size, size
    img = []
    cx, cy, r = w//2, h//2, w//2
    for y in range(h):
        row = []
        for x in range(w):
            dx, dy = x - cx, y - cy
            dist = math.sqrt(dx*dx + dy*dy)
            if dist <= r:
                t = 1 - (dist / r)
                r2 = int(bg[0] + (fg[0] - bg[0]) * t)
                g2 = int(bg[1] + (fg[1] - bg[1]) * t)
                b2 = int(bg[2] + (fg[2] - bg[2]) * t)
                row.extend([r2, g2, b2, 255])
            else:
                row.extend([15, 15, 15, 0])
        img.append(bytes(row))

    def chunk(name, data):
        c = zlib.crc32(name + data) & 0xffffffff
        return struct.pack('>I', len(data)) + name + data + struct.pack('>I', c)

    raw = b''.join(b'\x00' + row for row in img)
    png = b'\x89PNG\r\n\x1a\n'
    png += chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0))
    png += chunk(b'IDAT', zlib.compress(raw, 9))
    png += chunk(b'IEND', b'')
    return png

for size, name in [(192, 'icon-192.png'), (512, 'icon-512.png')]:
    with open(name, 'wb') as f:
        f.write(make_png(size, (15, 15, 15), (245, 158, 11)))
    print(f'Created {name}')

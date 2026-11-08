#!/usr/bin/env python3
"""Render G-code toolpath as a 3D tube STL, optionally merged with a model STL (ASCII or binary)."""
import sys, math, struct

def parse_gcode(path):
    x = y = z = 0.0
    moves = []
    with open(path) as f:
        for line in f:
            line = line.split(';')[0].split('(')[0].strip()
            if not line: continue
            parts = line.split()
            g = None; nx=x; ny=y; nz=z; i=0.0; j=0.0
            for p in parts:
                u = p.upper()
                if u.startswith('G'):
                    try: g = int(float(u[1:]))
                    except ValueError: pass
                elif u.startswith('X'): nx = float(u[1:])
                elif u.startswith('Y'): ny = float(u[1:])
                elif u.startswith('Z'): nz = float(u[1:])
                elif u.startswith('I'): i = float(u[1:])
                elif u.startswith('J'): j = float(u[1:])
            if g in (0, 1, 2, 3):
                moves.append((g, x, y, z, nx, ny, nz, i, j))
                x, y, z = nx, ny, nz
    return moves

def to_polyline(moves):
    pts = [(0.0, 0.0, 0.0)]
    for g, x, y, z, nx, ny, nz, i, j in moves:
        if g in (0, 1):
            pts.append((nx, ny, nz))
        else:
            cx = x + i; cy = y + j
            r = math.hypot(x - cx, y - cy)
            if r < 1e-9:
                pts.append((nx, ny, nz)); continue
            a0 = math.atan2(y - cy, x - cx)
            a1 = math.atan2(ny - cy, nx - cx)
            if g == 3:
                while a1 <= a0: a1 += 2*math.pi
                sweep = a1 - a0
            else:
                while a1 >= a0: a1 -= 2*math.pi
                sweep = a1 - a0
            n = max(8, int(abs(sweep) / (math.pi/24)) + 1)
            for k in range(1, n+1):
                t = k / n
                a = a0 + sweep * t
                pts.append((cx + r*math.cos(a), cy + r*math.sin(a), z + (nz-z)*t))
    return pts

def _norm(v):
    L = math.sqrt(sum(c*c for c in v))
    return tuple(c/L for c in v) if L > 1e-12 else (0.0, 0.0, 1.0)

def tube_triangles(pts, radius=2.0, sides=12):
    tris = []
    for p1, p2 in zip(pts, pts[1:]):
        if math.dist(p1, p2) < 1e-9: continue
        d = _norm((p2[0]-p1[0], p2[1]-p1[1], p2[2]-p1[2]))
        if abs(d[2]) < 0.9:
            u = _norm((-d[1], d[0], 0.0))
        else:
            u = _norm((0.0, -d[2], d[1]))
        v = (d[1]*u[2]-d[2]*u[1], d[2]*u[0]-d[0]*u[2], d[0]*u[1]-d[1]*u[0])
        r1 = []; r2 = []
        for k in range(sides):
            a = 2*math.pi*k/sides
            ox = math.cos(a)*u[0] + math.sin(a)*v[0]
            oy = math.cos(a)*u[1] + math.sin(a)*v[1]
            oz = math.cos(a)*u[2] + math.sin(a)*v[2]
            r1.append((p1[0]+radius*ox, p1[1]+radius*oy, p1[2]+radius*oz))
            r2.append((p2[0]+radius*ox, p2[1]+radius*oy, p2[2]+radius*oz))
        for k in range(sides):
            k2 = (k+1) % sides
            tris.append((r1[k], r1[k2], r2[k]))
            tris.append((r1[k2], r2[k2], r2[k]))
    return tris

def read_stl_triangles(path):
    with open(path, 'rb') as f:
        head = f.read(5)
    f = open(path, 'rb'); head = f.read(80); f.close()
    # binary STL: 80-byte header + uint32 count + 50-byte triangles
    with open(path, 'rb') as fh:
        fh.seek(80)
        n = struct.unpack('<I', fh.read(4))[0]
        if n * 50 + 84 <= __import__('os').path.getsize(path):
            tris = []
            for _ in range(n):
                d = fh.read(50)
                vals = struct.unpack('<12fH', d[0:50])
                tris.append(((vals[3], vals[4], vals[5]), (vals[6], vals[7], vals[8]), (vals[9], vals[10], vals[11])))
            return tris
    # ASCII fallback
    tris = []
    cur = []
    for line in open(path):
        line = line.strip()
        if line.startswith('vertex'):
            cur.append(tuple(float(x) for x in line.split()[1:4]))
            if len(cur) == 3:
                tris.append(tuple(cur)); cur = []
    return tris

def write_stl(tris, path):
    with open(path, 'w') as f:
        f.write('solid toolpath\n')
        for a, b, c in tris:
            f.write('  facet normal 0 0 0\n    outer loop\n')
            for p in (a, b, c):
                f.write('      vertex %.6f %.6f %.6f\n' % p)
            f.write('    endloop\n  endfacet\n')
        f.write('endsolid toolpath\n')

def main():
    gcode = sys.argv[1]
    out = sys.argv[2]
    model = sys.argv[3] if len(sys.argv) > 3 else None
    radius = float(sys.argv[4]) if len(sys.argv) > 4 else 2.0
    pts = to_polyline(parse_gcode(gcode))
    tris = tube_triangles(pts, radius=radius)
    if model:
        tris = tris + read_stl_triangles(model)
    write_stl(tris, out)
    print("toolpath points=%d  triangles=%d%s  -> %s" % (len(pts), len(tris), ("  (merged %s)" % model) if model else "", out))

if __name__ == '__main__':
    main()

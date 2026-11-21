#!/usr/bin/env python3
"""Compute the stock-minus-part boolean difference (material to remove) between a
blank/stock model and the finished part model, and tessellate the result for the
qizhouCNC_CAM model viewport overlay.

Inputs (env or argv):
  CAM_STOCK   - path to the blank/stock STEP/BREP/IGES model
  CAM_PART    - path to the finished part STEP/BREP/IGES model
  CAM_DIFF_OUT- output JSON path

Output JSON:
  {
    "ok": true,
    "volume": float (mm^3),
    "bounds": {"min":[x,y,z], "max":[x,y,z]},
    "faces": [ {id, vertices, triangles, center, area, geometry} ],
    "edges": [ {id, points, shapeKey} ],
    "faceCount": int, "edgeCount": int
  }
The boolean is STOCK - PART = material to remove (待加工去除的材料).
"""
import os, sys, json
import FreeCAD, Part

def _r(v, nd=5):
    return round(float(v), nd)

def _pt(v):
    return [round(float(v.x), 5), round(float(v.y), 5), round(float(v.z), 5)]

def _axis(f):
    a = f.Surface.Axis
    ax = (_r(a.x), _r(a.y), _r(a.z))
    neg = tuple(-c for c in ax)
    return list(ax if ax <= neg else neg)

def _face_geometry(f):
    s = f.Surface
    t = type(s).__name__
    geom = {"type": t}
    try:
        if t == 'Cylinder':
            geom["radius"] = _r(s.Radius, 4)
            geom["axis"] = _axis(f)
        elif t == 'Cone':
            geom["radius"] = _r(s.Radius, 4)
            geom["axis"] = _axis(f)
            geom["semiAngle"] = _r(s.SemiAngle, 4)
        elif t == 'Sphere':
            geom["radius"] = _r(s.Radius, 4)
        elif t == 'Toroid':
            geom["radius"] = _r(s.MinorRadius, 4)
            geom["majorRadius"] = _r(s.MajorRadius, 4)
            geom["axis"] = _axis(f)
    except Exception:
        pass
    return geom

def _face_shape_key(f):
    s = f.Surface
    t = type(s).__name__
    try:
        if t == 'Cylinder':
            return 'cyl:r%.4f' % _r(s.Radius, 4)
        if t == 'Cone':
            return 'cone:r%.4f:a%.4f' % (_r(s.Radius, 4), _r(s.SemiAngle, 4))
        if t == 'Sphere':
            return 'sph:r%.4f' % _r(s.Radius, 4)
        if t == 'Toroid':
            return 'tor:R%.4f:r%.4f' % (_r(s.MajorRadius, 4), _r(s.MinorRadius, 4))
        if t == 'Plane':
            perim = sum(float(w.Length) for w in f.Wires)
            return 'plane:p%.3f:a%.3f' % (_r(perim, 3), _r(f.Area, 3))
    except Exception:
        pass
    return None

def _edge_shape_key(e):
    try:
        c = e.Curve
    except Exception:
        return None
    if c is None:
        return None
    t = type(c).__name__
    try:
        if t == 'Circle':
            return 'circle:r%.4f' % _r(c.Radius, 4)
        if t == 'Line':
            return 'line:l%.3f' % _r(e.Length, 3)
        return 'edge:%s' % t
    except Exception:
        return None

def tessellate_shape(shape, tol=0.2):
    """Tessellate a FreeCAD shape into faces + edges (simplified; no periodic merging needed)."""
    faces = []
    fid = 1
    for f in shape.Faces:
        try:
            verts, tris = f.tessellate(tol)
        except Exception:
            try:
                verts, tris = f.tessellate(tol * 4)
            except Exception:
                continue
        if not tris:
            continue
        try:
            c = f.CenterOfMass
            center = [round(float(c.x), 5), round(float(c.y), 5), round(float(c.z), 5)]
        except Exception:
            center = [0.0, 0.0, 0.0]
        try:
            area = float(f.Area)
        except Exception:
            area = 0.0
        faces.append({
            "id": fid,
            "vertices": [_pt(v) for v in verts],
            "triangles": [[int(t[0]), int(t[1]), int(t[2])] for t in tris],
            "center": center,
            "area": round(area, 3),
            "shapeKey": _face_shape_key(f),
            "geometry": _face_geometry(f),
        })
        fid += 1

    edges = []
    eid = 1
    for e in shape.Edges:
        try:
            pts = e.discretize(Deflection=max(tol, 0.2))
        except Exception:
            try:
                pts = e.discretize(Number=16)
            except Exception:
                continue
        if not pts or len(pts) < 2:
            continue
        edges.append({"id": eid, "points": [_pt(p) for p in pts], "shapeKey": _edge_shape_key(e)})
        eid += 1
    return faces, edges

def run(stock_path, part_path, out_path, tol=0.2):
    stock = Part.read(stock_path)
    part = Part.read(part_path)
    if stock is None or part is None:
        raise RuntimeError("Could not read stock or part model")
    # 毛坯 - 成品 = 待去除材料
    diff = stock.cut(part)
    if diff is None or diff.Volume <= 0 or diff.isNull():
        # 可能两者完全重合或顺序反了，返回空结果（体积 0）
        bb = stock.BoundBox
        out = {
            "ok": True,
            "empty": True,
            "volume": 0.0,
            "bounds": {"min": [bb.XMin, bb.YMin, bb.ZMin], "max": [bb.XMax, bb.YMax, bb.ZMax]},
            "faces": [], "edges": [], "faceCount": 0, "edgeCount": 0,
        }
        with open(out_path, "w") as fh:
            json.dump(out, fh)
        print("DIFF_OK volume=0 empty")
        return
    faces, edges = tessellate_shape(diff, tol)
    bb = diff.BoundBox
    out = {
        "ok": True,
        "empty": False,
        "volume": round(float(diff.Volume), 3),
        "bounds": {"min": [bb.XMin, bb.YMin, bb.ZMin], "max": [bb.XMax, bb.YMax, bb.ZMax]},
        "faces": faces,
        "edges": edges,
        "faceCount": len(faces),
        "edgeCount": len(edges),
    }
    with open(out_path, "w") as fh:
        json.dump(out, fh)
    print("DIFF_OK volume=%.3f faces=%d edges=%d" % (out["volume"], len(faces), len(edges)))

stock_path = os.environ.get("CAM_STOCK")
part_path = os.environ.get("CAM_PART")
out_path = os.environ.get("CAM_DIFF_OUT")
if not stock_path or not part_path:
    stock_path = sys.argv[1] if len(sys.argv) > 1 else None
    part_path = sys.argv[2] if len(sys.argv) > 2 else None
    out_path = sys.argv[3] if len(sys.argv) > 3 else None
if not stock_path or not part_path or not out_path:
    print("usage: CAM_STOCK=... CAM_PART=... CAM_DIFF_OUT=... freecadcmd stock_diff.py")
    sys.exit(2)
run(stock_path, part_path, out_path)

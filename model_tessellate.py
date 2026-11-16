#!/usr/bin/env python3
"""Tessellate a STEP/BREP/IGES model into renderable faces + edges JSON.

Reuses the FreeCAD dependency already required by qizhouCNC_CAM: each solid
face is tessellated into its own triangle list (so the client can pick faces),
and every edge is discretized into a polyline (so the client can pick edges).

Two distinct per-element keys are emitted:
- a position-aware "merge key" (internal) — merges periodic surfaces split at
  their seam (half cylinder/cone/sphere/torus) and half-circle edges back into
  one pickable element. It MUST include position so two parallel holes never
  merge (v1.3.15 fix).
- a position-INVARIANT "shapeKey" (emitted to the client) — groups faces/edges
  that are the same FEATURE (e.g. four holes of the same diameter, or several
  equal-size slots). The client uses it to offer "检测到 N 个相同特征，是否一起标注".

Output JSON is written to <out_path> so stdout stays clean.
"""
import os, sys, json
import FreeCAD, Part


def _r(v, nd=5):
    """Round a float for a stable identity key."""
    return round(float(v), nd)


def _pt(v):
    return [round(float(v.x), 5), round(float(v.y), 5), round(float(v.z), 5)]


def _vec3(v):
    return (_r(v.x), _r(v.y), _r(v.z))


def _axis(f):
    """Axis as a normalized 3-tuple, tolerant of the two half-surface axis directions
    sometimes being negated relative to each other (still the same line)."""
    a = f.Surface.Axis
    ax = _vec3(a)
    # canonicalize sign so +z and -z count as the same axis line
    neg = tuple(-c for c in ax)
    return ax if ax <= neg else neg


# ---- position-aware merge keys (used only internally, to rejoin seam splits) ----

def _surface_key(f):
    """Identity of a periodic surface INCLUDING its position.

    Returns None for non-periodic surfaces (planes etc.), which are never merged.
    """
    s = f.Surface
    t = type(s).__name__
    try:
        if t == 'Cylinder':
            return ('cyl', _vec3(s.Center), _axis(f), _r(s.Radius))
        if t == 'Cone':
            return ('cone', _vec3(s.Center), _vec3(s.Apex), _axis(f), _r(s.SemiAngle))
        if t == 'Sphere':
            return ('sph', _vec3(s.Center), _r(s.Radius))
        if t == 'Toroid':
            return ('tor', _vec3(s.Center), _axis(f), _r(s.MajorRadius), _r(s.MinorRadius))
    except Exception:
        return None
    return None


def _circle_key(e):
    """Identity of a circle edge INCLUDING its position, or None."""
    try:
        c = e.Curve
    except Exception:
        return None
    if c is None or not isinstance(c, Part.Circle):
        return None
    try:
        return (_vec3(c.Center), _axis(e), _r(c.Radius))
    except Exception:
        return None


# ---- position-INVARIANT shape keys (emitted; group identical features) ----

def _face_shape_key(f):
    """A position-independent signature of a face's FEATURE type.

    Two faces with the same shapeKey are "the same feature" (same size/shape),
    just at a different location — e.g. two 8mm drilled holes, or two equal
    pockets. Periodic surfaces key on their dimension params; planar faces key
    on perimeter + area (a reasonable same-size/same-shape signature).
    """
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
    """A position-independent signature of an edge's FEATURE type."""
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


def _discretize_full_circle(curve, tol):
    """Discretize a full circle curve as one closed loop (first == last)."""
    try:
        edge = curve.toShape()  # full Edge (360 degrees)
        pts = edge.discretize(Deflection=max(tol, 0.2))
    except Exception:
        try:
            pts = edge.discretize(Number=64)
        except Exception:
            return None
    if not pts or len(pts) < 3:
        return None
    return [_pt(p) for p in pts] + [_pt(pts[0])]


def run(model_path, out_path, tol=0.1):
    shape = Part.read(model_path)
    if shape is None:
        raise RuntimeError("Could not read model: " + model_path)

    # ---- 1) tessellate every face, remembering merge key + shape key ----
    raw_faces = []
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
        raw_faces.append((_surface_key(f), {
            "vertices": [_pt(v) for v in verts],
            "triangles": [[int(t[0]), int(t[1]), int(t[2])] for t in tris],
            "center": center,
            "area": round(area, 3),
            "shapeKey": _face_shape_key(f),
        }))

    # ---- 2) merge identical periodic faces (split cylinder/cone/sphere/torus) ----
    buckets = {}
    order = []
    for key, fd in raw_faces:
        if key is None:
            order.append(('solo', fd))
            continue
        if key not in buckets:
            buckets[key] = []
            order.append(('group', key))
        buckets[key].append(fd)

    faces = []
    fid = 1
    for kind, payload in order:
        if kind == 'solo':
            faces.append({"id": fid, **payload})
            fid += 1
            continue
        group = buckets[payload]
        if len(group) == 1:
            faces.append({"id": fid, **group[0]})
            fid += 1
            continue
        vertices = []
        triangles = []
        total_area = 0.0
        wcenter = [0.0, 0.0, 0.0]
        shape_key = group[0].get("shapeKey")
        for g in group:
            off = len(vertices)
            vertices.extend(g["vertices"])
            for t in g["triangles"]:
                triangles.append([t[0] + off, t[1] + off, t[2] + off])
            a = max(0.0, g["area"])
            total_area += a
            wcenter[0] += g["center"][0] * a
            wcenter[1] += g["center"][1] * a
            wcenter[2] += g["center"][2] * a
        if total_area > 0:
            wcenter = [round(wcenter[0] / total_area, 5), round(wcenter[1] / total_area, 5), round(wcenter[2] / total_area, 5)]
        else:
            wcenter = group[0]["center"]
        faces.append({
            "id": fid,
            "vertices": vertices,
            "triangles": triangles,
            "center": wcenter,
            "area": round(total_area, 3),
            "shapeKey": shape_key,
        })
        fid += 1

    # ---- 3) discretize every edge, remembering merge key + shape key ----
    raw_edges = []
    for e in shape.Edges:
        key = _circle_key(e)
        try:
            pts = e.discretize(Deflection=max(tol, 0.2))
        except Exception:
            try:
                pts = e.discretize(Number=16)
            except Exception:
                continue
        if not pts or len(pts) < 2:
            continue
        raw_edges.append((key, [_pt(p) for p in pts], _edge_shape_key(e)))

    # ---- 4) merge identical circle edges (split semicircles) into one loop ----
    ebuckets = {}
    eorder = []
    for key, pts, skey in raw_edges:
        if key is None:
            eorder.append(('solo', pts, skey))
            continue
        if key not in ebuckets:
            ebuckets[key] = []
            eorder.append(('circle', key))
        ebuckets[key].append((pts, skey))

    edges = []
    eid = 1
    for kind, payload, *rest in eorder:
        if kind == 'solo':
            edges.append({"id": eid, "points": payload, "shapeKey": rest[0]})
            eid += 1
            continue
        group = ebuckets[payload]
        skey = group[0][1]
        if len(group) == 1:
            edges.append({"id": eid, "points": group[0][0], "shapeKey": skey})
            eid += 1
            continue
        curve = None
        for e in shape.Edges:
            if _circle_key(e) == payload:
                curve = e.Curve
                break
        merged = _discretize_full_circle(curve, tol) if curve is not None else None
        if merged is None:
            merged = []
            for pts, _ in group:
                for p in pts:
                    if not merged or merged[-1] != p:
                        merged.append(p)
        edges.append({"id": eid, "points": merged, "shapeKey": skey})
        eid += 1

    bb = shape.BoundBox
    out = {
        "ok": True,
        "file": model_path,
        "bounds": {"min": [bb.XMin, bb.YMin, bb.ZMin], "max": [bb.XMax, bb.YMax, bb.ZMax]},
        "faces": faces,
        "edges": edges,
        "faceCount": len(faces),
        "edgeCount": len(edges),
    }
    with open(out_path, "w") as fh:
        json.dump(out, fh)
    print("MODEL_OK faces=%d edges=%d" % (len(faces), len(edges)))


# Top-level (NOT under `if __name__ == "__main__"`): freecadcmd execs this file
# without setting __name__ to "__main__", so a guarded block would never run.
model_path = os.environ.get("CAM_MODEL")
out_path = os.environ.get("CAM_MODEL_OUT")
tol = float(os.environ.get("CAM_TESS_TOL", "0.1"))
if not model_path or not out_path:
    model_path = sys.argv[1] if len(sys.argv) > 1 else None
    out_path = sys.argv[2] if len(sys.argv) > 2 else None
if not model_path or not out_path:
    print("usage: CAM_MODEL=... CAM_MODEL_OUT=... freecadcmd model_tessellate.py")
    sys.exit(2)
run(model_path, out_path, tol)

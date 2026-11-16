#!/usr/bin/env python3
"""Tessellate a STEP/BREP/IGES model into renderable faces + edges JSON.

Reuses the FreeCAD dependency already required by qizhouCNC_CAM: each solid
face is tessellated into its own triangle list (so the client can pick faces),
and every edge is discretized into a polyline (so the client can pick edges).

Compatibility fixes for picking (v1.3.14):
- A full cylinder / cone / sphere / torus surface is often exported by CAD
  kernels as TWO half surfaces (split at the periodic seam), so clicking the
  inner/outer round wall felt like "it splits into two halves". Identical
  periodic faces are merged back into one pickable face.
- A full circle edge is likewise often split into two semicircle edges; they
  are merged back into one closed loop so double-clicking a round edge selects
  the whole circle.

Output JSON is written to <out_path> so stdout stays clean.
"""
import os, sys, json, math
import FreeCAD, Part


def _r(v, nd=5):
    """Round a float for a stable identity key."""
    return round(float(v), nd)


def _pt(v):
    return [round(float(v.x), 5), round(float(v.y), 5), round(float(v.z), 5)]


def _surface_key(f):
    """Stable identity key for periodic surfaces (cylinder/cone/sphere/torus).

    Returns None for non-periodic surfaces (planes etc.), which are never merged.
    """
    s = f.Surface
    t = type(s).__name__
    try:
        if t == 'Cylinder':
            ax = s.Axis
            return ('cyl', _r(ax.x), _r(ax.y), _r(ax.z), _r(s.Radius))
        if t == 'Cone':
            ax = s.Axis
            return ('cone', _r(ax.x), _r(ax.y), _r(ax.z), _r(s.SemiAngle))
        if t == 'Sphere':
            c = s.Center
            return ('sph', _r(c.x), _r(c.y), _r(c.z), _r(s.Radius))
        if t == 'Toroid':
            ax = s.Axis
            return ('tor', _r(ax.x), _r(ax.y), _r(ax.z), _r(s.MajorRadius), _r(s.MinorRadius))
    except Exception:
        return None
    return None


def _circle_key(e):
    """Stable identity key for circular edges, or None."""
    try:
        c = e.Curve
        if not isinstance(c, Part.Circle):
            return None
        ct = c.Center
        ax = c.Axis
        return (_r(ct.x), _r(ct.y), _r(ct.z), _r(ax.x), _r(ax.y), _r(ax.z), _r(c.Radius))
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
    # ensure closed: repeat first point at the end
    return [_pt(p) for p in pts] + [_pt(pts[0])]


def run(model_path, out_path, tol=0.1):
    shape = Part.read(model_path)
    if shape is None:
        raise RuntimeError("Could not read model: " + model_path)

    # ---- 1) tessellate every face, remembering its surface identity ----
    raw_faces = []  # (surface_key, face_dict)
    for i, f in enumerate(shape.Faces):
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
        }))

    # ---- 2) merge identical periodic faces (split cylinder/cone/sphere/torus) ----
    # Only merge when >1 face shares a periodic identity (a genuine split);
    # a single face is left untouched.
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
        # merge several half-surfaces into one face
        vertices = []
        triangles = []
        total_area = 0.0
        wcenter = [0.0, 0.0, 0.0]
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
        })
        fid += 1

    # ---- 3) discretize every edge, remembering its circle identity ----
    raw_edges = []  # (circle_key, points)
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
        raw_edges.append((key, [_pt(p) for p in pts]))

    # ---- 4) merge identical circle edges (split semicircles) into one loop ----
    ebuckets = {}
    eorder = []
    for key, pts in raw_edges:
        if key is None:
            eorder.append(('solo', pts))
            continue
        if key not in ebuckets:
            ebuckets[key] = []
            eorder.append(('circle', key))
        ebuckets[key].append(pts)

    edges = []
    eid = 1
    for kind, payload in eorder:
        if kind == 'solo':
            edges.append({"id": eid, "points": payload})
            eid += 1
            continue
        group = ebuckets[payload]
        if len(group) == 1:
            edges.append({"id": eid, "points": group[0]})
            eid += 1
            continue
        # re-discretize as one full circle using the first member's curve
        curve = None
        for e in shape.Edges:
            if _circle_key(e) == payload:
                curve = e.Curve
                break
        merged = _discretize_full_circle(curve, tol) if curve is not None else None
        if merged is None:
            # fallback: concatenate the half loops (dedup endpoints)
            merged = []
            for pts in group:
                for p in pts:
                    if not merged or merged[-1] != p:
                        merged.append(p)
        edges.append({"id": eid, "points": merged})
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

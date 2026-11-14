#!/usr/bin/env python3
"""Tessellate a STEP/BREP/IGES model into renderable faces + edges JSON.

Reuses the FreeCAD dependency already required by qizhouCNC_CAM: each solid
face is tessellated into its own triangle list (so the client can pick faces),
and every edge is discretized into a polyline (so the client can pick edges).
Output JSON is written to <out_path> so stdout stays clean.
"""
import os, sys, json
import FreeCAD, Part

def _pt(v):
    return [round(float(v.x), 5), round(float(v.y), 5), round(float(v.z), 5)]

def run(model_path, out_path, tol=0.1):
    shape = Part.read(model_path)
    if shape is None:
        raise RuntimeError("Could not read model: " + model_path)

    faces = []
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
        faces.append({
            "id": i + 1,
            "vertices": [_pt(v) for v in verts],
            "triangles": [[int(t[0]), int(t[1]), int(t[2])] for t in tris],
            "center": center,
            "area": round(area, 3),
        })

    edges = []
    for j, e in enumerate(shape.Edges):
        try:
            pts = e.discretize(Deflection=max(tol, 0.2))
        except Exception:
            try:
                pts = e.discretize(Number=16)
            except Exception:
                continue
        if not pts or len(pts) < 2:
            continue
        edges.append({"id": j + 1, "points": [_pt(p) for p in pts]})

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

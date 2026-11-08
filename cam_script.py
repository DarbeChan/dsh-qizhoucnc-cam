import os, FreeCAD, Part
import Path
import Path.Main.Job as JobMod
import Path.Op.Profile as ProfileMod
from Path.Post.Processor import PostProcessorFactory

model_path = os.environ["CAM_MODEL"]
out_path = os.environ["CAM_OUT"]
step_down = float(os.environ.get("CAM_STEPDOWN", "2"))
final_depth = float(os.environ.get("CAM_FINALDEPTH", "6"))
post = os.environ.get("CAM_POST", "grbl")

doc = FreeCAD.newDocument("CamJob")
shape = Part.read(model_path)
if shape is None:
    raise RuntimeError("Could not read model: " + model_path)
model = doc.addObject("Part::Feature", "Model")
model.Shape = shape
doc.recompute()

faces = model.Shape.Faces
best = None
for i, f in enumerate(faces, 1):
    try:
        if f.Surface.isPlanar():
            a = f.Area
            if best is None or a > best[0]:
                best = (a, i)
    except Exception:
        pass
if best is None:
    raise RuntimeError("No planar face found for a profile toolpath.")

face_name = "Face%d" % best[1]

job = JobMod.Create("Job", [model], None)
op = ProfileMod.Create("Profile", parentJob=job)
op.Base = [(model, face_name)]
doc.recompute()

proc = PostProcessorFactory.get_post_processor(job, post)
sections = proc.export()
gcode = "\n".join((gc or "") for _, gc in sections)
open(out_path, "w").write(gcode)
print("CAM_OK lines=%d face=%s" % (len(gcode.splitlines()), face_name))

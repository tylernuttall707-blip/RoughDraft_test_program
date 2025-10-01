# CAD Dimension Reader (GitHub Pages)


A static, browser‑only tool that loads **STL** and **STEP (.stp/.step)** files, renders them in 3D, and reports **axis‑aligned bounding‑box dimensions** in both **mm** and **inches**. It gracefully rejects **SolidWorks .SLDPRT** (export to STEP or STL first).


## Features
- Drag‑and‑drop multi‑file loader
- 3D preview with orbit controls and translucent bounding box
- STL unit selector (STL has no intrinsic units)
- STEP parsing fully in the browser via OpenCascade (WASM)
- Dimensions in **mm** and **inches** with configurable decimals
- Mesh analysis for sheet-metal style parts: outer edge perimeter, hole counts/diameters, and bend angle statistics


## Sheet-metal style measurements

The mesh analyser walks every edge of the triangulated model and looks for
non-manifold boundaries. The longest closed boundary loop is reported as the
outer perimeter, while any additional closed loops are treated as holes and
summarised with their approximate diameters and perimeters. Open boundary
chains are also measured so you can see how much trim exists on an unfolded
panel. Bend angles are detected by comparing the normals of triangles that
share an edge; the histogram highlights common bend values, which helps when
checking a formed part against a flat pattern. Because all of the lengths are
computed from the boundary loops in model space, they represent the edge
lengths you would measure on a 2D blank before it is bent.

## File structure

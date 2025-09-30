# CAD Dimension Reader (GitHub Pages)


A static, browser‑only tool that loads **STL** and **STEP (.stp/.step)** files, renders them in 3D, and reports **axis‑aligned bounding‑box dimensions** in both **mm** and **inches**. It gracefully rejects **SolidWorks .SLDPRT** (export to STEP or STL first).


## Features
- Drag‑and‑drop multi‑file loader
- 3D preview with orbit controls and translucent bounding box
- STL unit selector (STL has no intrinsic units)
- STEP parsing fully in the browser via OpenCascade (WASM)
- Dimensions in **mm** and **inches** with configurable decimals


## File structure

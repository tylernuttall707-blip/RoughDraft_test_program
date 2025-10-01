// Three.js via CDN modules (ESM) and helpers from the examples directory.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';

const viewerEl = document.getElementById('viewer');
const resultsEl = document.getElementById('results');
const precisionEl = document.getElementById('precision');
const loading = document.getElementById('loading');
const dropEl = document.getElementById('drop');
const fileInput = document.getElementById('fileInput');
const stlUnitEl = document.getElementById('stlUnit');

let viewerManager = null;
const models = [];

let occtModulePromise = null;

const unitToMillimeter = {
  mm: 1,
  cm: 10,
  m: 1000,
  in: 25.4,
  ft: 304.8,
};

const PLANAR_ANGLE_THRESHOLD_DEG = 8;
const LOOP_AXIS_IGNORE_TOLERANCE = 1e-3;

function initViewer() {
  if (!viewerManager) {
    viewerManager = new ViewerManager(viewerEl);
  }
  viewerManager.initialize();
}

function attachUiHandlers() {
  if (dropEl) {
    dropEl.addEventListener('dragover', (event) => {
      event.preventDefault();
      dropEl.classList.add('drag');
    });

    dropEl.addEventListener('dragleave', () => {
      dropEl.classList.remove('drag');
    });

    dropEl.addEventListener('drop', (event) => {
      event.preventDefault();
      dropEl.classList.remove('drag');
      const transfer = event.dataTransfer;
      if (transfer && transfer.files) {
        handleFiles(transfer.files);
      }
    });
  }

  if (fileInput) {
    fileInput.addEventListener('change', (event) => {
      const { files } = event.target;
      if (files && files.length > 0) {
        handleFiles(files);
      }
      fileInput.value = '';
    });
  }
}

async function handleFiles(fileList) {
  for (const file of fileList) {
    const name = file.name || 'file';
    const lower = name.toLowerCase();
    const card = addCard(name, '<div class="muted small">Processing…</div>');
    card.classList.add('pending');

    let viewport = null;

    try {
      if (loading) {
        loading.classList.add('show');
      }
      if (lower.endsWith('.stl')) {
        viewport = viewerManager.createViewport(name);
        await loadStl(file, card, viewport);
      } else if (lower.endsWith('.step') || lower.endsWith('.stp')) {
        viewport = viewerManager.createViewport(name);
        await loadStep(file, card, viewport);
      } else {
        updateCardBody(card, '<div class="warn">Unsupported file type.</div>');
      }
    } catch (error) {
      console.error('Failed to process file.', error);
      updateCardBody(card, `<div class="warn">Failed to load: ${error.message || error}</div>`);
      if (viewport) {
        viewerManager.removeViewport(viewport);
      }
    } finally {
      card.classList.remove('pending');
      if (loading) {
        loading.classList.remove('show');
      }
    }
  }
}

async function loadStl(file, card, viewport) {
  if (!viewport) {
    throw new Error('A viewer window could not be created for this STL file.');
  }

  const arrayBuffer = await file.arrayBuffer();
  const loader = new STLLoader();
  const geometry = loader.parse(arrayBuffer);

  const material = new THREE.MeshStandardMaterial({
    color: 0x9fb5ff,
    metalness: 0.1,
    roughness: 0.75,
  });

  geometry.computeVertexNormals();

  const mesh = new THREE.Mesh(geometry, material);
  const group = new THREE.Group();
  group.add(mesh);

  const positionAttr = geometry.getAttribute('position');
  const positions = positionAttr && positionAttr.array;
  if (!positions) {
    throw new Error('STL geometry missing vertex positions.');
  }

  const unit = (stlUnitEl && stlUnitEl.value) || 'mm';
  const toMillimeter = Object.prototype.hasOwnProperty.call(unitToMillimeter, unit)
    ? unitToMillimeter[unit]
    : 1;

  mesh.scale.setScalar(toMillimeter);

  const bounds = computeBoundsFromPositions(positions);
  bounds.min.multiplyScalar(toMillimeter);
  bounds.max.multiplyScalar(toMillimeter);

  const dims = dimsFromBounds(bounds);
  const analysis = analyzeModel(group);

  const name = `${file.name}`;
  const precisionValue = precisionEl && precisionEl.value !== undefined ? precisionEl.value : '3';
  const decimals = parseInt(precisionValue, 10) || 3;
  const bodyHtml = [
    `<div class="ok">Loaded STL (${unit} → mm).</div>`,
    formatDims(dims, decimals),
    formatAnalysis(analysis, decimals),
  ].join('');
  const targetCard = card || addCard(name, bodyHtml);
  updateCardBody(targetCard, bodyHtml);
  targetCard.classList.remove('pending');

  viewport.setTitle(name);
  viewport.setModel(group, bounds.clone());

  const model = { name, group, bounds: bounds.clone(), unit: unit || 'mm', kind: 'stl', viewport, card: targetCard };
  targetCard.addEventListener('click', () => viewport.focus());
  models.push(model);
  return targetCard;
}

async function loadStep(file, card, viewport) {
  if (!file) {
    throw new Error('A file must be provided to loadStep.');
  }
  if (!viewport) {
    throw new Error('A viewer window could not be created for this STEP file.');
  }

  const occt = await ensureOcctModule();
  const uint8 = new Uint8Array(await file.arrayBuffer());
  const params = {
    linearUnit: 'millimeter',
    linearDeflectionType: 'bounding_box_ratio',
    linearDeflection: 0.001,
    angularDeflection: 0.5,
  };
  const result = occt.ReadStepFile(uint8, params);
  if (!result || !result.success) {
    throw new Error('STEP import failed.');
  }

  const group = new THREE.Group();
  let bounds = null;
  for (const meshResult of result.meshes) {
    const attr = meshResult && meshResult.attributes;
    const positionAttr = attr && attr.position;
    const posSrc = (positionAttr && positionAttr.array)
      || meshResult.position
      || meshResult.positions
      || meshResult.vertices;
    if (!posSrc) continue;

    const posArray = posSrc.BYTES_PER_ELEMENT ? posSrc : new Float32Array(posSrc);

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(posArray, 3));

    const indexAttr = meshResult.index && meshResult.index.array ? meshResult.index.array : null;
    const idxSrc = indexAttr || meshResult.indices || meshResult.index;
    if (idxSrc) {
      const indexArray = idxSrc.length > 65535 ? new Uint32Array(idxSrc) : new Uint16Array(idxSrc);
      geometry.setIndex(new THREE.BufferAttribute(indexArray, 1));
    }
    geometry.computeVertexNormals();

    const colorObj = (meshResult.color && meshResult.color.length === 3)
      ? new THREE.Color(meshResult.color[0], meshResult.color[1], meshResult.color[2])
      : new THREE.Color(0x3c8bff);
    const material = new THREE.MeshStandardMaterial({
      color: colorObj,
      metalness: 0.05,
      roughness: 0.6,
    });
    const mesh = new THREE.Mesh(geometry, material);
    group.add(mesh);

    const meshBounds = computeBoundsFromPositions(posArray);
    bounds = bounds ? bounds.union(meshBounds) : meshBounds.clone();
  }

  if (!bounds) {
    throw new Error('No geometry produced from STEP.');
  }

  const dimsMm = dimsFromBounds(bounds);
  const analysis = analyzeModel(group);

  const name = `${file.name}`;
  const precisionValue = precisionEl && precisionEl.value !== undefined ? precisionEl.value : '3';
  const decimals = parseInt(precisionValue, 10) || 3;
  const bodyHtml = [
    '<div class="ok">Loaded STEP (converted → mm).</div>',
    formatDims(dimsMm, decimals),
    formatAnalysis(analysis, decimals),
  ].join('');
  const targetCard = card || addCard(name, bodyHtml);
  updateCardBody(targetCard, bodyHtml);
  targetCard.classList.remove('pending');

  viewport.setTitle(name);
  viewport.setModel(group, bounds.clone());

  const model = { name, group, bounds: bounds.clone(), unit: 'mm', kind: 'step', viewport, card: targetCard };
  targetCard.addEventListener('click', () => viewport.focus());
  models.push(model);
  return targetCard;
}

async function ensureOcctModule() {
  if (occtModulePromise) {
    return occtModulePromise;
  }

  const occtGlobal = window.occt;
  if (occtGlobal && typeof occtGlobal.ReadStepFile === 'function') {
    occtModulePromise = Promise.resolve(occtGlobal);
    return occtModulePromise;
  }

  const factory = window.occtimportjs;
  if (typeof factory === 'function') {
    occtModulePromise = factory().then((module) => {
      if (module && typeof module.ReadStepFile === 'function') {
        window.occt = module;
        return module;
      }
      throw new Error('STEP loader returned an invalid module.');
    });
    return occtModulePromise;
  }

  occtModulePromise = new Promise((resolve, reject) => {
    const start = performance.now();
    const timeoutMs = 15000;

    const tryResolve = () => {
      const readyGlobal = window.occt;
      if (readyGlobal && typeof readyGlobal.ReadStepFile === 'function') {
        resolve(readyGlobal);
        return;
      }

      const readyFactory = window.occtimportjs;
      if (typeof readyFactory === 'function') {
        Promise.resolve(readyFactory())
          .then((module) => {
            if (module && typeof module.ReadStepFile === 'function') {
              window.occt = module;
              resolve(module);
            } else {
              reject(new Error('STEP loader returned an invalid module.'));
            }
          })
          .catch(reject);
        return;
      }

      if (performance.now() - start > timeoutMs) {
        reject(new Error('STEP loader failed to initialize.'));
        return;
      }

      requestAnimationFrame(tryResolve);
    };

    tryResolve();
  });

  return occtModulePromise;
}

function computeBoundsFromPositions(positions) {
  const bounds = new THREE.Box3();
  const temp = new THREE.Vector3();
  for (let i = 0; i < positions.length; i += 3) {
    temp.set(positions[i], positions[i + 1], positions[i + 2]);
    bounds.expandByPoint(temp);
  }
  return bounds;
}

function dimsFromBounds(bounds) {
  const size = new THREE.Vector3();
  bounds.getSize(size);
  return {
    mm: size.clone(),
    inch: size.clone().multiplyScalar(0.0393700787),
  };
}

function analyzeModel(group) {
  if (!group) {
    return createEmptyAnalysis();
  }

  group.updateMatrixWorld(true);

  const perMesh = [];
  group.traverse((child) => {
    if (child && child.isMesh && child.geometry) {
      const result = analyzeGeometry(child.geometry, child.matrixWorld);
      if (result) {
        perMesh.push(result);
      }
    }
  });

  if (!perMesh.length) {
    return createEmptyAnalysis();
  }

  return mergeAnalyses(perMesh);
}

function createEmptyAnalysis() {
  return {
    loops: [],
    holes: [],
    openLoops: [],
    outerPerimeterMm: null,
    totalBoundaryMm: 0,
    bend: {
      totalEdges: 0,
      candidateEdges: 0,
      bendCount: 0,
      sum: 0,
      min: null,
      max: null,
      histogram: new Map(),
    },
  };
}

function analyzeGeometry(geometry, matrixWorld) {
  const positionAttr = geometry.getAttribute('position');
  if (!positionAttr) {
    return null;
  }

  const indexAttr = geometry.getIndex();
  const matrix = matrixWorld || new THREE.Matrix4();

  const uniqueVertices = [];
  const vertexMap = new Map();
  const originalToUnique = new Array(positionAttr.count);
  const tolerance = 1e-4;
  const tempVec = new THREE.Vector3();
  const keyBuffer = new Array(3);

  for (let i = 0; i < positionAttr.count; i += 1) {
    tempVec.set(positionAttr.getX(i), positionAttr.getY(i), positionAttr.getZ(i));
    tempVec.applyMatrix4(matrix);
    keyBuffer[0] = Math.round(tempVec.x / tolerance);
    keyBuffer[1] = Math.round(tempVec.y / tolerance);
    keyBuffer[2] = Math.round(tempVec.z / tolerance);
    const key = keyBuffer.join('|');
    let uniqueIndex = vertexMap.get(key);
    if (uniqueIndex === undefined) {
      uniqueIndex = uniqueVertices.length;
      vertexMap.set(key, uniqueIndex);
      uniqueVertices.push(tempVec.clone());
    }
    originalToUnique[i] = uniqueIndex;
  }

  const getEdgeKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

  const faceNormals = [];
  const faceCentroids = [];
  const edges = new Map();
  const addEdge = (a, b, faceIdx) => {
    const key = getEdgeKey(a, b);
    let edge = edges.get(key);
    if (!edge) {
      const length = uniqueVertices[a].distanceTo(uniqueVertices[b]);
      edge = { a, b, length, faces: [] };
      edges.set(key, edge);
    }
    edge.faces.push(faceIdx);
  };

  const addFace = (aIdx, bIdx, cIdx, faceIdx) => {
    const a = uniqueVertices[aIdx];
    const b = uniqueVertices[bIdx];
    const c = uniqueVertices[cIdx];
    if (!a || !b || !c) {
      return;
    }
    const ab = new THREE.Vector3().subVectors(b, a);
    const ac = new THREE.Vector3().subVectors(c, a);
    const normal = new THREE.Vector3().crossVectors(ab, ac);
    if (normal.lengthSq() > 0) {
      normal.normalize();
    }
    faceNormals[faceIdx] = normal;
    const centroid = new THREE.Vector3().addVectors(a, b).add(c).multiplyScalar(1 / 3);
    faceCentroids[faceIdx] = centroid;
    addEdge(aIdx, bIdx, faceIdx);
    addEdge(bIdx, cIdx, faceIdx);
    addEdge(cIdx, aIdx, faceIdx);
  };

  if (indexAttr) {
    const array = indexAttr.array;
    for (let i = 0, faceIdx = 0; i < indexAttr.count; i += 3, faceIdx += 1) {
      const a = originalToUnique[array[i]];
      const b = originalToUnique[array[i + 1]];
      const c = originalToUnique[array[i + 2]];
      if (a === undefined || b === undefined || c === undefined) {
        continue;
      }
      addFace(a, b, c, faceIdx);
    }
  } else {
    for (let i = 0, faceIdx = 0; i < positionAttr.count; i += 3, faceIdx += 1) {
      const a = originalToUnique[i];
      const b = originalToUnique[i + 1];
      const c = originalToUnique[i + 2];
      if (a === undefined || b === undefined || c === undefined) {
        continue;
      }
      addFace(a, b, c, faceIdx);
    }
  }

  const bounds = new THREE.Box3();
  if (uniqueVertices.length) {
    bounds.setFromPoints(uniqueVertices);
  }
  const boundsSize = new THREE.Vector3();
  bounds.getSize(boundsSize);
  const scale = boundsSize.length() || 1;
  const planeOffsetTolerance = Math.max(scale * 1e-4, 1e-4);
  const planarDotThreshold = Math.cos(THREE.MathUtils.degToRad(PLANAR_ANGLE_THRESHOLD_DEG));

  const faceNeighbors = Array.from({ length: faceNormals.length }, () => new Set());
  edges.forEach((edge) => {
    if (edge.faces.length >= 2) {
      for (let i = 0; i < edge.faces.length; i += 1) {
        for (let j = i + 1; j < edge.faces.length; j += 1) {
          const aFace = edge.faces[i];
          const bFace = edge.faces[j];
          if (faceNeighbors[aFace]) faceNeighbors[aFace].add(bFace);
          if (faceNeighbors[bFace]) faceNeighbors[bFace].add(aFace);
        }
      }
    }
  });

  const facePatch = new Array(faceNormals.length).fill(-1);
  const patches = [];

  for (let faceIdx = 0; faceIdx < faceNormals.length; faceIdx += 1) {
    if (facePatch[faceIdx] !== -1) {
      continue;
    }
    const normal = faceNormals[faceIdx];
    const centroid = faceCentroids[faceIdx];
    if (!normal || normal.lengthSq() === 0 || !centroid) {
      continue;
    }

    const patchId = patches.length;
    const patch = {
      faces: [faceIdx],
      normal: normal.clone().normalize(),
      normalSum: normal.clone(),
      planePointSum: centroid.clone(),
      planeConstant: normal.clone().normalize().dot(centroid),
      count: 1,
    };
    patches.push(patch);
    facePatch[faceIdx] = patchId;

    const queue = [faceIdx];
    while (queue.length) {
      const currentFace = queue.pop();
      const neighbors = faceNeighbors[currentFace];
      if (!neighbors) {
        continue;
      }
      neighbors.forEach((neighborIdx) => {
        if (facePatch[neighborIdx] !== -1) {
          return;
        }
        const neighborNormal = faceNormals[neighborIdx];
        const neighborCentroid = faceCentroids[neighborIdx];
        if (!neighborNormal || neighborNormal.lengthSq() === 0 || !neighborCentroid) {
          return;
        }
        const dot = patch.normal.dot(neighborNormal);
        if (dot < planarDotThreshold) {
          return;
        }
        const distance = Math.abs(patch.normal.dot(neighborCentroid) - patch.planeConstant);
        if (distance > planeOffsetTolerance) {
          return;
        }

        facePatch[neighborIdx] = patchId;
        patch.faces.push(neighborIdx);
        queue.push(neighborIdx);
        patch.normalSum.add(neighborNormal);
        patch.planePointSum.add(neighborCentroid);
        patch.count += 1;
        patch.normal = patch.normalSum.clone().normalize();
        const avgPoint = patch.planePointSum.clone().multiplyScalar(1 / patch.count);
        patch.planeConstant = patch.normal.dot(avgPoint);
      });
    }
  }

  const patchEdges = new Map();
  const ensurePatchEdges = (patchId) => {
    if (!patchEdges.has(patchId)) {
      patchEdges.set(patchId, []);
    }
    return patchEdges.get(patchId);
  };

  edges.forEach((edge) => {
    const { faces } = edge;
    if (!faces.length) {
      return;
    }

    const patchesForEdge = new Set();
    for (const faceIdx of faces) {
      const assigned = facePatch[faceIdx];
      if (assigned !== undefined && assigned !== -1) {
        patchesForEdge.add(assigned);
      }
    }

    if (faces.length === 1) {
      const onlyPatch = facePatch[faces[0]];
      if (onlyPatch !== undefined && onlyPatch !== -1) {
        ensurePatchEdges(onlyPatch).push(edge);
      }
      return;
    }

    const patchesArray = Array.from(patchesForEdge);
    if (patchesArray.length <= 1) {
      if (patchesArray.length === 1 && faces.length === 1) {
        ensurePatchEdges(patchesArray[0]).push(edge);
      }
      return;
    }

    patchesArray.forEach((patchId) => {
      ensurePatchEdges(patchId).push(edge);
    });
  });

  const loops = [];

  patchEdges.forEach((edgeList) => {
    if (!edgeList.length) {
      return;
    }
    const adjacency = new Map();
    const visitedEdges = new Set();
    const addNeighbor = (from, to) => {
      if (!adjacency.has(from)) {
        adjacency.set(from, new Set());
      }
      adjacency.get(from).add(to);
    };

    edgeList.forEach((edge) => {
      addNeighbor(edge.a, edge.b);
      addNeighbor(edge.b, edge.a);
    });

    const findNextNeighbor = (current, prev) => {
      const neighbors = adjacency.get(current);
      if (!neighbors) {
        return null;
      }
      for (const neighbor of neighbors) {
        if (neighbor === prev) continue;
        const key = getEdgeKey(current, neighbor);
        if (visitedEdges.has(key)) {
          continue;
        }
        return neighbor;
      }
      return null;
    };

    for (const edge of edgeList) {
      const initialKey = getEdgeKey(edge.a, edge.b);
      if (visitedEdges.has(initialKey)) {
        continue;
      }
      const loop = [edge.a];
      let current = edge.a;
      let next = edge.b;
      let closed = false;
      let guard = 0;
      const guardLimit = edgeList.length * 4;
      while (next !== null && guard < guardLimit) {
        guard += 1;
        loop.push(next);
        const stepKey = getEdgeKey(current, next);
        visitedEdges.add(stepKey);
        if (next === loop[0]) {
          closed = true;
          break;
        }
        const candidate = findNextNeighbor(next, current);
        if (candidate === null) {
          break;
        }
        current = next;
        next = candidate;
      }
      loops.push({
        vertices: loop,
        closed,
      });
    }
  });

  const loopSummaries = loops.map((loop) => summarizeLoop(loop, uniqueVertices));
  const uniqueLoopSummaries = dedupeClosedLoops(loopSummaries);
  const totalBoundaryMm = uniqueLoopSummaries.reduce((sum, entry) => sum + entry.lengthMm, 0);

  const bendStats = summarizeBends(edges, faceNormals);

  return {
    loops: uniqueLoopSummaries,
    totalBoundaryMm,
    bend: bendStats,
  };
}

function summarizeLoop(loop, vertices) {
  const points = loop.closed ? loop.vertices.slice(0, -1) : loop.vertices.slice();
  const ordered = loop.vertices;
  let length = 0;
  const boundsMin = new THREE.Vector3(Infinity, Infinity, Infinity);
  const boundsMax = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
  for (let i = 0; i < ordered.length - 1; i += 1) {
    const start = vertices[ordered[i]];
    const end = vertices[ordered[i + 1]];
    if (start && end) {
      length += start.distanceTo(end);
    }
  }

  let maxDistSq = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = vertices[points[i]];
    if (!a) continue;
    boundsMin.min(a);
    boundsMax.max(a);
    for (let j = i + 1; j < points.length; j += 1) {
      const b = vertices[points[j]];
      if (!b) continue;
      const distSq = a.distanceToSquared(b);
      if (distSq > maxDistSq) {
        maxDistSq = distSq;
      }
    }
  }

  const approxDiameterMm = Math.sqrt(Math.max(maxDistSq, 0));

  let centroid = null;
  let axisToIgnore = null;
  if (loop.closed && points.length) {
    centroid = new THREE.Vector3();
    for (const index of points) {
      const vertex = vertices[index];
      if (vertex) {
        centroid.add(vertex);
      }
    }
    centroid.multiplyScalar(1 / points.length);

    const extent = new THREE.Vector3().subVectors(boundsMax, boundsMin);
    const axes = [
      { axis: 'x', value: extent.x },
      { axis: 'y', value: extent.y },
      { axis: 'z', value: extent.z },
    ].sort((a, b) => a.value - b.value);
    if (axes.length) {
      const secondAxis = axes[1];
      const firstAxis = axes[0];
      let nextValue = 0;
      if (secondAxis && secondAxis.value !== undefined) {
        nextValue = secondAxis.value;
      } else if (firstAxis && firstAxis.value !== undefined) {
        nextValue = firstAxis.value;
      }
      if (firstAxis && firstAxis.value !== undefined) {
        if (firstAxis.value <= LOOP_AXIS_IGNORE_TOLERANCE || firstAxis.value <= nextValue * 0.2) {
          axisToIgnore = firstAxis.axis;
        }
      }
    }
  }

  return {
    closed: loop.closed,
    lengthMm: length,
    approxDiameterMm,
    vertexCount: points.length,
    centroid,
    axisToIgnore,
  };
}

function dedupeClosedLoops(loopSummaries) {
  if (!loopSummaries.length) {
    return loopSummaries;
  }

  const tolerance = 1e-3;
  const quantize = (value) => Math.round(value / tolerance);
  const seen = new Map();
  const unique = [];

  for (const summary of loopSummaries) {
    if (!summary.closed || !summary.centroid) {
      unique.push(summary);
      continue;
    }

    const { centroid, lengthMm, vertexCount, approxDiameterMm, axisToIgnore } = summary;
    const centroidKey = [
      axisToIgnore === 'x' ? '_' : quantize(centroid.x),
      axisToIgnore === 'y' ? '_' : quantize(centroid.y),
      axisToIgnore === 'z' ? '_' : quantize(centroid.z),
    ].join('|');
    const diameterKey = Number.isFinite(approxDiameterMm) ? quantize(approxDiameterMm) : 'nan';
    const key = `${centroidKey}|${quantize(lengthMm)}|${vertexCount}|${diameterKey}`;
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, summary);
      unique.push(summary);
      continue;
    }

    if (existing.centroid && centroid) {
      existing.centroid = existing.centroid.clone().add(centroid).multiplyScalar(0.5);
    }
    existing.lengthMm = (existing.lengthMm + lengthMm) / 2;
    existing.approxDiameterMm = Number.isFinite(existing.approxDiameterMm) && Number.isFinite(approxDiameterMm)
      ? (existing.approxDiameterMm + approxDiameterMm) / 2
      : existing.approxDiameterMm;
    const existingCount = existing.vertexCount != null ? existing.vertexCount : 0;
    const newCount = vertexCount != null ? vertexCount : 0;
    existing.vertexCount = Math.max(existingCount, newCount);
    if (!existing.axisToIgnore && axisToIgnore) {
      existing.axisToIgnore = axisToIgnore;
    }
  }

  return unique;
}

function summarizeBends(edges, faceNormals) {
  let candidateEdges = 0;
  let bendCount = 0;
  let sum = 0;
  let min = null;
  let max = null;
  const histogram = new Map();

  edges.forEach((edge) => {
    if (edge.faces.length === 2) {
      candidateEdges += 1;
      const normalA = faceNormals[edge.faces[0]];
      const normalB = faceNormals[edge.faces[1]];
      if (!normalA || !normalB) {
        return;
      }
      const dot = THREE.MathUtils.clamp(normalA.dot(normalB), -1, 1);
      const angleDeg = THREE.MathUtils.radToDeg(Math.acos(dot));
      if (!Number.isFinite(angleDeg)) {
        return;
      }
      if (angleDeg > 1) {
        bendCount += 1;
        sum += angleDeg;
        min = min === null ? angleDeg : Math.min(min, angleDeg);
        max = max === null ? angleDeg : Math.max(max, angleDeg);
        const rounded = Math.round(angleDeg);
        const previous = histogram.has(rounded) ? histogram.get(rounded) : 0;
        histogram.set(rounded, previous + 1);
      }
    }
  });

  return {
    totalEdges: edges.size,
    candidateEdges,
    bendCount,
    sum,
    min,
    max,
    histogram,
  };
}

function mergeAnalyses(meshAnalyses) {
  const combined = createEmptyAnalysis();

  for (const analysis of meshAnalyses) {
    combined.loops.push(...analysis.loops);

    combined.bend.totalEdges += analysis.bend.totalEdges;
    combined.bend.candidateEdges += analysis.bend.candidateEdges;
    combined.bend.bendCount += analysis.bend.bendCount;
    combined.bend.sum += analysis.bend.sum;
    if (analysis.bend.min !== null) {
      combined.bend.min = combined.bend.min === null
        ? analysis.bend.min
        : Math.min(combined.bend.min, analysis.bend.min);
    }
    if (analysis.bend.max !== null) {
      combined.bend.max = combined.bend.max === null
        ? analysis.bend.max
        : Math.max(combined.bend.max, analysis.bend.max);
    }
    analysis.bend.histogram.forEach((count, key) => {
      const existingCount = combined.bend.histogram.has(key) ? combined.bend.histogram.get(key) : 0;
      combined.bend.histogram.set(key, existingCount + count);
    });
  }

  combined.loops = dedupeClosedLoops(combined.loops);
  combined.totalBoundaryMm = combined.loops.reduce((sum, entry) => sum + entry.lengthMm, 0);

  const closedLoops = combined.loops.filter((loop) => loop.closed).sort((a, b) => b.lengthMm - a.lengthMm);
  const openLoops = combined.loops.filter((loop) => !loop.closed);
  combined.outerPerimeterMm = closedLoops.length ? closedLoops[0].lengthMm : null;
  combined.holes = closedLoops.length > 1 ? closedLoops.slice(1) : [];
  combined.openLoops = openLoops;

  return combined;
}

function formatAnalysis(analysis, decimals) {
  if (!analysis) {
    return '';
  }

  const places = Number.isFinite(decimals) ? Math.max(0, decimals) : 2;
  const formatMm = (value) => (value === null || value === undefined
    ? '—'
    : `${value.toFixed(places)} mm`);
  const anglePlaces = Math.min(2, places);

  const sections = [];

  if (analysis.outerPerimeterMm !== null) {
    sections.push(`
      <div class="metric">
        <div class="metric-label">Edge perimeter</div>
        <div class="metric-value">${formatMm(analysis.outerPerimeterMm)}</div>
      </div>
    `);
  } else if (analysis.totalBoundaryMm > 0) {
    sections.push(`
      <div class="metric">
        <div class="metric-label">Edge perimeter</div>
        <div class="metric-value">No closed boundary detected</div>
      </div>
    `);
  } else {
    sections.push(`
      <div class="metric">
        <div class="metric-label">Edge perimeter</div>
        <div class="metric-value">Model is watertight</div>
      </div>
    `);
  }

  if (analysis.holes.length) {
    const holeItems = analysis.holes.slice(0, 5).map((hole, index) => `
        <li>Hole ${index + 1}: Ø ${formatMm(hole.approxDiameterMm)}
          <span class="metric-sub">(perimeter ${formatMm(hole.lengthMm)}, ${hole.vertexCount} edges)</span>
        </li>
      `).join('');
    const more = analysis.holes.length > 5 ? `<li class="metric-sub">…${analysis.holes.length - 5} more</li>` : '';
    sections.push(`
      <div class="metric">
        <div class="metric-label">Holes</div>
        <div class="metric-value">${analysis.holes.length}</div>
        <ul class="metric-list">${holeItems}${more}</ul>
      </div>
    `);
  } else {
    sections.push(`
      <div class="metric">
        <div class="metric-label">Holes</div>
        <div class="metric-value">0</div>
      </div>
    `);
  }

  if (analysis.openLoops.length) {
    const openLength = analysis.openLoops.reduce((sum, loop) => sum + loop.lengthMm, 0);
    sections.push(`
      <div class="metric">
        <div class="metric-label">Open edges</div>
        <div class="metric-value">${formatMm(openLength)}</div>
        <div class="metric-sub">${analysis.openLoops.length} open chains</div>
      </div>
    `);
  }

  const bend = analysis.bend;
  if (bend && bend.candidateEdges > 0) {
    let bendSummary = '<div class="metric-sub">No bends detected</div>';
    if (bend.bendCount > 0) {
      const average = bend.sum / bend.bendCount;
      const minText = bend.min !== null && bend.min !== undefined ? bend.min.toFixed(anglePlaces) : '—';
      const maxText = bend.max !== null && bend.max !== undefined ? bend.max.toFixed(anglePlaces) : '—';
      bendSummary = `
        <div class="metric-sub">${bend.bendCount} of ${bend.candidateEdges} shared edges</div>
        <div class="metric-sub">avg ${average.toFixed(anglePlaces)}°, range ${minText}° – ${maxText}°</div>
      `;
    }

    const histEntries = Array.from(bend.histogram.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([angle, count]) => `<li>${angle}° – ${count}</li>`)
      .join('');
    const histHtml = histEntries ? `<ul class="metric-list">${histEntries}</ul>` : '';

    sections.push(`
      <div class="metric">
        <div class="metric-label">Bend angles</div>
        <div class="metric-value">${bend.bendCount}</div>
        ${bendSummary}
        ${histHtml}
      </div>
    `);
  }

  return `<div class="metrics">${sections.join('')}</div>`;
}

function createBoundingBoxHelper(bounds) {
  const size = new THREE.Vector3();
  bounds.getSize(size);
  const center = new THREE.Vector3();
  bounds.getCenter(center);

  const geometry = new THREE.BoxGeometry(
    Math.max(size.x, 1e-6),
    Math.max(size.y, 1e-6),
    Math.max(size.z, 1e-6),
  );
  const edges = new THREE.EdgesGeometry(geometry);
  const material = new THREE.LineBasicMaterial({ color: 0x7aa2ff, transparent: true, opacity: 0.3 });
  const helper = new THREE.LineSegments(edges, material);
  helper.position.copy(center);
  return helper;
}

function formatDims(dims, decimals) {
  const mm = dims.mm;
  const inch = dims.inch;
  const places = Number.isFinite(decimals) ? Math.max(decimals, 0) : 3;
  const mmText = `${mm.x.toFixed(places)} × ${mm.y.toFixed(places)} × ${mm.z.toFixed(places)} mm`;
  const inchText = `${inch.x.toFixed(places)} × ${inch.y.toFixed(places)} × ${inch.z.toFixed(places)} in`;
  return `<div class="dim">${mmText}<br><small>${inchText}</small></div>`;
}

function addCard(name, bodyHtml) {
  const card = document.createElement('div');
  card.className = 'card';
  const title = document.createElement('h3');
  title.textContent = name;
  const body = document.createElement('div');
  body.className = 'card-body';
  body.innerHTML = bodyHtml;
  card.append(title, body);
  if (resultsEl) {
    resultsEl.prepend(card);
  }
  return card;
}

function updateCardBody(card, bodyHtml) {
  if (!card) return;
  const body = card.querySelector('.card-body');
  if (body) {
    body.innerHTML = bodyHtml;
  }
}

class ViewerManager {
  constructor(container) {
    this.container = container;
    this.viewports = new Set();
    this.handleResize = this.handleResize.bind(this);

    if (this.container) {
      const existingHint = this.container.querySelector('.viewer-empty');
      if (existingHint) {
        this.emptyHint = existingHint;
      } else {
        this.emptyHint = this.createEmptyHint();
        this.container.appendChild(this.emptyHint);
      }
    }

    window.addEventListener('resize', this.handleResize);
  }

  initialize() {
    this.updateEmptyState();
    this.handleResize();
  }

  createEmptyHint() {
    const hint = document.createElement('div');
    hint.className = 'viewer-empty';
    hint.textContent = 'Load a file to open it in its own window.';
    return hint;
  }

  createViewport(title) {
    if (!this.container) {
      throw new Error('Viewer container missing.');
    }
    const viewport = new ModelViewport(this.container, title);
    this.viewports.add(viewport);
    this.updateEmptyState();
    viewport.handleResize();
    return viewport;
  }

  removeViewport(viewport) {
    if (!viewport || !this.viewports.has(viewport)) {
      return;
    }
    this.viewports.delete(viewport);
    viewport.dispose();
    this.updateEmptyState();
  }

  updateEmptyState() {
    if (!this.emptyHint) {
      return;
    }
    this.emptyHint.style.display = this.viewports.size ? 'none' : 'flex';
  }

  handleResize() {
    this.viewports.forEach((viewport) => viewport.handleResize());
  }
}

class ModelViewport {
  constructor(parent, title) {
    this.parent = parent;
    this.root = document.createElement('section');
    this.root.className = 'viewer-window';
    this.titleEl = document.createElement('div');
    this.titleEl.className = 'viewer-window-title';
    this.titleEl.textContent = title;
    this.canvasHost = document.createElement('div');
    this.canvasHost.className = 'viewer-canvas';
    this.root.append(this.titleEl, this.canvasHost);
    parent.appendChild(this.root);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio || 1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.canvasHost.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0b1020);

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 5000);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;

    const hemisphere = new THREE.HemisphereLight(0xffffff, 0x1b1f3a, 0.6);
    this.scene.add(hemisphere);

    const dir1 = new THREE.DirectionalLight(0xffffff, 0.8);
    dir1.position.set(1, 1.25, 1.5);
    this.scene.add(dir1);

    const dir2 = new THREE.DirectionalLight(0x9fb5ff, 0.5);
    dir2.position.set(-1.5, -0.8, -1.25);
    this.scene.add(dir2);

    this.animate = this.animate.bind(this);
    this.animationId = requestAnimationFrame(this.animate);
  }

  setTitle(name) {
    this.titleEl.textContent = name;
  }

  setModel(group, bounds) {
    if (this.currentGroup) {
      this.scene.remove(this.currentGroup);
    }
    if (this.helper) {
      if (this.helper.geometry) {
        this.helper.geometry.dispose();
      }
      if (this.helper.material) {
        this.helper.material.dispose();
      }
      this.scene.remove(this.helper);
      this.helper = null;
    }

    this.currentGroup = group;
    this.scene.add(group);
    this.bounds = bounds.clone();
    this.helper = createBoundingBoxHelper(this.bounds);
    this.scene.add(this.helper);
    this.frame(this.bounds);
    this.handleResize();
  }

  frame(bounds) {
    const center = new THREE.Vector3();
    const size = new THREE.Vector3();
    bounds.getCenter(center);
    bounds.getSize(size);

    const maxDim = Math.max(size.x, size.y, size.z);
    const radius = maxDim * 1.35 + 1;
    const offset = new THREE.Vector3(1.2, 0.9, 1.1).normalize().multiplyScalar(radius);

    this.controls.target.copy(center);
    this.camera.position.copy(center).add(offset);
    this.camera.near = Math.max(radius / 100, 0.1);
    this.camera.far = radius * 20 + radius;
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }

  handleResize() {
    if (!this.renderer || !this.canvasHost) {
      return;
    }
    const width = Math.max(this.canvasHost.clientWidth || this.canvasHost.offsetWidth || 0, 1);
    const height = Math.max(this.canvasHost.clientHeight || this.canvasHost.offsetHeight || Math.round(width * 0.75), 1);
    this.renderer.setSize(width, height);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  animate() {
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    if (!this.disposed) {
      this.animationId = requestAnimationFrame(this.animate);
    }
  }

  focus() {
    this.root.scrollIntoView({ behavior: 'smooth', block: 'center' });
    this.root.classList.add('viewer-window--active');
    window.setTimeout(() => {
      this.root.classList.remove('viewer-window--active');
    }, 600);
  }

  dispose() {
    this.disposed = true;
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
    }
    this.controls.dispose();
    this.renderer.dispose();
    if (this.currentGroup) {
      this.scene.remove(this.currentGroup);
      this.currentGroup = null;
    }
    if (this.helper) {
      if (this.helper.geometry) {
        this.helper.geometry.dispose();
      }
      if (this.helper.material) {
        this.helper.material.dispose();
      }
    }
    this.root.remove();
  }
}

initViewer();
attachUiHandlers();

export {
  models,
  precisionEl,
  loading,
  loadStep,
  loadStl,
  handleFiles,
  initViewer,
};

// Three.js via CDN modules (ESM) and helpers from the examples directory.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { loadStl } from './readers/stlReader.js';
import { loadDxf } from './readers/dxfReader.js';
import { loadStep } from './readers/stepReader.js';

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

const PLANAR_ANGLE_THRESHOLD_DEG = 3;
const CIRCULARITY_THRESHOLD = 0.80;
const VERTEX_MERGE_TOLERANCE = 1e-5;
const BEND_ANGLE_TOLERANCE_DEG = 3;

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
      const readerOptions = {
        stlUnitEl,
        precisionEl,
        addCard,
        updateCardBody,
        computeBoundsFromPositions,
        computeBoundsFromGroup,
        dimsFromBounds,
        analyzeSheetMetal,
        formatDims,
        formatLaserCutAnalysis,
        models,
        ensureOcctModule,
      };
      if (lower.endsWith('.stl')) {
        viewport = viewerManager.createViewport(name);
        await loadStl(file, card, viewport, readerOptions);
      } else if (lower.endsWith('.step') || lower.endsWith('.stp')) {
        viewport = viewerManager.createViewport(name);
        await loadStep(file, card, viewport, readerOptions);
      } else if (lower.endsWith('.dxf')) {
        viewport = viewerManager.createViewport(name);
        await loadDxf(file, card, viewport, readerOptions);
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

function computeBoundsFromGroup(group) {
  if (!group || typeof group.traverse !== 'function') {
    return null;
  }

  const bounds = new THREE.Box3();
  const temp = new THREE.Box3();
  let hasGeometry = false;

  group.updateMatrixWorld(true);
  group.traverse((child) => {
    if (!child || !child.isObject3D) {
      return;
    }
    const { geometry } = child;
    if (!geometry) {
      return;
    }
    if (!geometry.boundingBox) {
      geometry.computeBoundingBox();
    }
    if (!geometry.boundingBox) {
      return;
    }

    temp.copy(geometry.boundingBox);
    temp.applyMatrix4(child.matrixWorld);
    if (!hasGeometry) {
      bounds.copy(temp);
      hasGeometry = true;
    } else {
      bounds.union(temp);
    }
  });

  return hasGeometry ? bounds : null;
}

function dimsFromBounds(bounds) {
  const size = new THREE.Vector3();
  bounds.getSize(size);
  return {
    mm: size.clone(),
    inch: size.clone().multiplyScalar(0.0393700787),
  };
}

function analyzeSheetMetal(group, metadata = null) {
  if (!group) {
    return createEmptyAnalysis();
  }

  group.updateMatrixWorld(true);

  // For DXF files with metadata, use entity-aware analysis
  if (metadata && metadata.kind === 'dxf') {
    return analyzeDxfEntities(group, metadata);
  }

  const perMesh = [];
  group.traverse((child) => {
    if (!child || !child.isObject3D || !child.geometry) {
      return;
    }

    if (child.isMesh) {
      const result = analyzeGeometry(child.geometry, child.matrixWorld);
      if (result) {
        perMesh.push(result);
      }
    } else if (child.isLine) {
      const isClosed = child.type === 'LineLoop';
      const result = analyzeLineGeometry(child.geometry, child.matrixWorld, isClosed);
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

function analyzeDxfEntities(group, metadata) {
  const analysis = createEmptyAnalysis();
  const allLoops = [];
  let totalLength = 0;

  group.traverse((child) => {
    if (!child || !child.geometry) return;

    const isClosed = child.type === 'LineLoop';
    const geometry = child.geometry;
    const positionAttr = geometry.getAttribute('position');
    if (!positionAttr) return;

    const matrix = child.matrixWorld || new THREE.Matrix4();
    const points = [];
    const temp = new THREE.Vector3();

    for (let i = 0; i < positionAttr.count; i += 1) {
      temp.set(positionAttr.getX(i), positionAttr.getY(i), positionAttr.getZ(i));
      temp.applyMatrix4(matrix);
      points.push(temp.clone());
    }

    if (points.length < 2) return;

    // Calculate loop properties
    let length = 0;
    for (let i = 0; i < points.length - 1; i += 1) {
      length += points[i].distanceTo(points[i + 1]);
    }

    // For closed loops, check if we need to close the loop
    let vertices = points;
    if (isClosed && points.length > 2) {
      const first = points[0];
      const last = points[points.length - 1];
      if (first.distanceTo(last) > VERTEX_MERGE_TOLERANCE) {
        vertices = [...points, points[0].clone()];
        length += last.distanceTo(first);
      }
    }

    if (!isClosed || length < 0.01) {
      if (!isClosed && length > 0.01) {
        analysis.openLoops.push({
          closed: false,
          lengthMm: length,
          approxDiameterMm: 0,
          vertexCount: points.length,
          centroid: null,
          circularity: 0,
        });
        totalLength += length;
      }
      return;
    }

    // Calculate circularity for closed loops
    let centroid = new THREE.Vector3();
    let maxDistSq = 0;

    for (let i = 0; i < points.length; i += 1) {
      centroid.add(points[i]);
      for (let j = i + 1; j < points.length; j += 1) {
        const distSq = points[i].distanceToSquared(points[j]);
        if (distSq > maxDistSq) maxDistSq = distSq;
      }
    }

    if (points.length) {
      centroid.multiplyScalar(1 / points.length);
    }

    const approxDiameterMm = Math.sqrt(Math.max(maxDistSq, 0));

    // Enhanced circularity calculation
    let circularity = 0;
    if (points.length >= 4) {
      const perimeterBasedRadius = length / (2 * Math.PI);
      let avgDistanceFromCentroid = 0;

      for (const point of points) {
        avgDistanceFromCentroid += point.distanceTo(centroid);
      }
      avgDistanceFromCentroid /= points.length;

      let distanceVariance = 0;
      for (const point of points) {
        const dist = point.distanceTo(centroid);
        distanceVariance += Math.pow(dist - avgDistanceFromCentroid, 2);
      }
      distanceVariance /= points.length;
      const stdDev = Math.sqrt(distanceVariance);

      const coefficientOfVariation = avgDistanceFromCentroid > 0 ? stdDev / avgDistanceFromCentroid : 1;
      circularity = Math.max(0, 1 - coefficientOfVariation * 5);

      const radiusRatio = avgDistanceFromCentroid > 0
        ? Math.min(perimeterBasedRadius, avgDistanceFromCentroid) / Math.max(perimeterBasedRadius, avgDistanceFromCentroid)
        : 0;
      circularity = (circularity + radiusRatio) / 2;

      // Boost circularity for entities with many segments (likely from CIRCLE entities)
      if (points.length >= 32) {
        circularity = Math.max(circularity, 0.85);
      }
    }

    allLoops.push({
      closed: true,
      lengthMm: length,
      approxDiameterMm,
      vertexCount: points.length,
      centroid,
      circularity,
    });
    totalLength += length;
  });

  // Deduplicate closed loops
  const uniqueLoops = dedupeClosedLoops(allLoops.filter(l => l.closed));
  const openLoops = allLoops.filter(l => !l.closed);

  // Sort by perimeter length (largest first)
  uniqueLoops.sort((a, b) => b.lengthMm - a.lengthMm);

  // The largest loop is likely the outer perimeter
  if (uniqueLoops.length > 0) {
    analysis.outerPerimeterMm = uniqueLoops[0].lengthMm;
    analysis.holes = uniqueLoops.slice(1);
  }

  analysis.loops = [...uniqueLoops, ...openLoops];
  analysis.openLoops = openLoops;
  analysis.totalCutLengthMm = totalLength;
  analysis.flatPattern = {
    isLikelyFlat: true,
    dominantPlane: 'Z',
    largestPatchRatio: 1,
    aspectRatio: 0,
  };

  return analysis;
}

function createEmptyBendStats() {
  return {
    totalEdges: 0,
    candidateEdges: 0,
    bendCount: 0,
    sum: 0,
    min: null,
    max: null,
    histogram: new Map(),
  };
}

function createEmptyAnalysis() {
  return {
    loops: [],
    holes: [],
    openLoops: [],
    outerPerimeterMm: null,
    totalCutLengthMm: 0,
    bend: createEmptyBendStats(),
    flatPattern: {
      isLikelyFlat: false,
      dominantPlane: null,
      largestPatchRatio: null,
      aspectRatio: null,
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
  const tolerance = VERTEX_MERGE_TOLERANCE;
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
  const totalCutLengthMm = uniqueLoopSummaries.reduce((sum, entry) => sum + entry.lengthMm, 0);

  const bendStats = summarizeBends(edges, faceNormals);

  const flatPattern = analyzeFlatPattern(patches, boundsSize);

  return {
    loops: uniqueLoopSummaries,
    totalCutLengthMm,
    bend: bendStats,
    flatPattern,
  };
}

function analyzeFlatPattern(patches, boundsSize) {
  if (!patches.length) {
    return { isLikelyFlat: false, dominantPlane: null };
  }

  const largestPatch = patches.reduce((max, patch) =>
    patch.faces.length > max.faces.length ? patch : max
  , patches[0]);

  const totalFaces = patches.reduce((sum, p) => sum + p.faces.length, 0);
  const largestPatchRatio = largestPatch.faces.length / totalFaces;

  const smallestDim = Math.min(boundsSize.x, boundsSize.y, boundsSize.z);
  const largestDim = Math.max(boundsSize.x, boundsSize.y, boundsSize.z);
  const aspectRatio = largestDim / (smallestDim || 1);

  const isLikelyFlat = largestPatchRatio > 0.6 && aspectRatio > 5;

  let dominantAxis = null;
  if (isLikelyFlat) {
    const normal = largestPatch.normal;
    const absNormal = new THREE.Vector3(Math.abs(normal.x), Math.abs(normal.y), Math.abs(normal.z));
    if (absNormal.x > absNormal.y && absNormal.x > absNormal.z) dominantAxis = 'X';
    else if (absNormal.y > absNormal.x && absNormal.y > absNormal.z) dominantAxis = 'Y';
    else dominantAxis = 'Z';
  }

  return {
    isLikelyFlat,
    dominantPlane: dominantAxis,
    largestPatchRatio,
    aspectRatio,
  };
}

function analyzeLineGeometry(geometry, matrixWorld, isClosedHint = false) {
  const positionAttr = geometry.getAttribute('position');
  if (!positionAttr) {
    return null;
  }

  const matrix = matrixWorld || new THREE.Matrix4();
  const points = [];
  const temp = new THREE.Vector3();
  for (let i = 0; i < positionAttr.count; i += 1) {
    temp.set(positionAttr.getX(i), positionAttr.getY(i), positionAttr.getZ(i));
    temp.applyMatrix4(matrix);
    points.push(temp.clone());
  }

  if (points.length < 2) {
    return null;
  }

  let closed = Boolean(isClosedHint);
  const first = points[0];
  const last = points[points.length - 1];
  const closureTolerance = VERTEX_MERGE_TOLERANCE * 10;
  if (!closed && points.length > 2 && first.distanceTo(last) <= closureTolerance) {
    closed = true;
  }

  if (closed && points.length > 1 && first.distanceTo(last) <= closureTolerance) {
    points.pop();
  }

  if (closed && points.length < 3) {
    return null;
  }

  const vertices = points.map((point) => point.clone());
  const indices = vertices.map((_, index) => index);
  if (closed) {
    indices.push(0);
  }

  const loop = { vertices: indices, closed };
  const summary = summarizeLoop(loop, vertices);
  if (!summary) {
    return null;
  }

  const deduped = dedupeClosedLoops([summary]);
  const totalCutLengthMm = deduped.reduce((sum, entry) => sum + entry.lengthMm, 0);

  return {
    loops: deduped,
    totalCutLengthMm,
    bend: createEmptyBendStats(),
    flatPattern: {
      isLikelyFlat: true,
      dominantPlane: 'Z',
      largestPatchRatio: 1,
      aspectRatio: 0,
    },
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
  let centroid = new THREE.Vector3();
  for (let i = 0; i < points.length; i += 1) {
    const a = vertices[points[i]];
    if (!a) continue;
    boundsMin.min(a);
    boundsMax.max(a);
    centroid.add(a);
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
  if (points.length) {
    centroid.multiplyScalar(1 / points.length);
  }

  let circularity = 0;

  if (loop.closed && points.length >= 4) {
    const perimeterBasedRadius = length / (2 * Math.PI);
    let avgDistanceFromCentroid = 0;
    let validPoints = 0;

    for (const index of points) {
      const vertex = vertices[index];
      if (vertex) {
        avgDistanceFromCentroid += vertex.distanceTo(centroid);
        validPoints++;
      }
    }

    if (validPoints > 0) {
      avgDistanceFromCentroid /= validPoints;

      let distanceVariance = 0;
      for (const index of points) {
        const vertex = vertices[index];
        if (vertex) {
          const dist = vertex.distanceTo(centroid);
          distanceVariance += Math.pow(dist - avgDistanceFromCentroid, 2);
        }
      }
      distanceVariance /= validPoints;
      const stdDev = Math.sqrt(distanceVariance);

      const coefficientOfVariation = avgDistanceFromCentroid > 0 ? stdDev / avgDistanceFromCentroid : 1;
      circularity = Math.max(0, 1 - coefficientOfVariation * 5);

      const radiusRatio = avgDistanceFromCentroid > 0
        ? Math.min(perimeterBasedRadius, avgDistanceFromCentroid) / Math.max(perimeterBasedRadius, avgDistanceFromCentroid)
        : 0;
      circularity = (circularity + radiusRatio) / 2;
    }
  }

  return {
    closed: loop.closed,
    lengthMm: length,
    approxDiameterMm,
    vertexCount: points.length,
    centroid: loop.closed ? centroid : null,
    circularity,
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

    const { centroid, lengthMm, vertexCount, approxDiameterMm } = summary;
    const centroidKey = [
      quantize(centroid.x),
      quantize(centroid.y),
      quantize(centroid.z),
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
    existing.circularity = (existing.circularity + summary.circularity) / 2;
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

        const rounded = Math.round(angleDeg / BEND_ANGLE_TOLERANCE_DEG) * BEND_ANGLE_TOLERANCE_DEG;
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

    if (analysis.flatPattern && analysis.flatPattern.isLikelyFlat) {
      combined.flatPattern = analysis.flatPattern;
    }
  }

  combined.loops = dedupeClosedLoops(combined.loops);
  combined.totalCutLengthMm = combined.loops.reduce((sum, entry) => sum + entry.lengthMm, 0);

  const closedLoops = combined.loops.filter((loop) => loop.closed).sort((a, b) => b.lengthMm - a.lengthMm);
  const openLoops = combined.loops.filter((loop) => !loop.closed);
  combined.outerPerimeterMm = closedLoops.length ? closedLoops[0].lengthMm : null;
  combined.holes = closedLoops.length > 1 ? closedLoops.slice(1) : [];
  combined.openLoops = openLoops;

  return combined;
}

function formatLaserCutAnalysis(analysis, decimals) {
  if (!analysis) {
    return '';
  }

  const places = Number.isFinite(decimals) ? Math.max(0, decimals) : 2;
  const formatMm = (value) => (value === null || value === undefined
    ? '—'
    : `${value.toFixed(places)} mm`);
  const formatIn = (value) => (value === null || value === undefined
    ? '—'
    : `${(value * 0.0393700787).toFixed(places)} in`);
  const anglePlaces = Math.min(2, places);

  const sections = [];

  if (analysis.flatPattern && analysis.flatPattern.isLikelyFlat) {
    sections.push(`
      <div class="metric flat-pattern-detected">
        <div class="metric-label">⚡ Flat pattern detected</div>
        <div class="metric-sub">Ready for laser cutting (${analysis.flatPattern.largestPatchRatio ? (analysis.flatPattern.largestPatchRatio * 100).toFixed(0) : '?'}% planar)</div>
      </div>
    `);
  } else if (analysis.bend && analysis.bend.bendCount > 0) {
    sections.push(`
      <div class="metric formed-part-warning">
        <div class="metric-label">⚠️ Formed part detected</div>
        <div class="metric-sub">This is a 3D bent part - measurements are approximate</div>
        <div class="metric-sub">Export flat pattern from CAD for accurate laser cut data</div>
      </div>
    `);
  }

  if (analysis.totalCutLengthMm > 0) {
    const totalInches = analysis.totalCutLengthMm * 0.0393700787;
    sections.push(`
      <div class="metric highlight">
        <div class="metric-label">🔪 Total Cut Length</div>
        <div class="metric-value">${formatMm(analysis.totalCutLengthMm)}</div>
        <div class="metric-sub">${formatIn(analysis.totalCutLengthMm)} • ${(totalInches / 12).toFixed(2)} feet</div>
      </div>
    `);
  }

  if (analysis.outerPerimeterMm !== null) {
    sections.push(`
      <div class="metric">
        <div class="metric-label">Outer Perimeter</div>
        <div class="metric-value">${formatMm(analysis.outerPerimeterMm)}</div>
        <div class="metric-sub">${formatIn(analysis.outerPerimeterMm)}</div>
      </div>
    `);
  }

  if (analysis.holes.length) {
    const circularHoles = analysis.holes.filter((h) => h.circularity >= CIRCULARITY_THRESHOLD);
    const nonCircularHoles = analysis.holes.filter((h) => h.circularity < CIRCULARITY_THRESHOLD);

    const totalHolePerimeter = analysis.holes.reduce((sum, h) => sum + h.lengthMm, 0);

    const holeItems = analysis.holes.slice(0, 8).map((hole, index) => {
      const isCircular = hole.circularity >= CIRCULARITY_THRESHOLD;
      const shape = isCircular ? '●' : '▢';
      const radius = hole.approxDiameterMm / 2;
      const diameter = hole.approxDiameterMm;

      if (isCircular) {
        return `
          <li>${shape} Hole ${index + 1}: Ø${diameter.toFixed(places)}mm (${(diameter * 0.0393700787).toFixed(places)}in)
            <span class="metric-sub">R${radius.toFixed(places)}mm • ${(hole.circularity * 100).toFixed(0)}% circular</span>
          </li>
        `;
      }
      return `
        <li>${shape} Feature ${index + 1}: ${formatMm(hole.lengthMm)} perimeter
          <span class="metric-sub">~${formatMm(hole.approxDiameterMm)} max span • slot/rectangle</span>
        </li>
      `;
    }).join('');
    const more = analysis.holes.length > 8 ? `<li class="metric-sub">…${analysis.holes.length - 8} more features</li>` : '';

    const summary = circularHoles.length > 0 && nonCircularHoles.length > 0
      ? `${circularHoles.length} round, ${nonCircularHoles.length} slots/features`
      : circularHoles.length > 0
        ? `${circularHoles.length} round holes`
        : `${nonCircularHoles.length} slots/features`;

    sections.push(`
      <div class="metric">
        <div class="metric-label">Holes & Features</div>
        <div class="metric-value">${analysis.holes.length} total</div>
        <div class="metric-sub">${summary}</div>
        <div class="metric-sub">Internal cuts: ${formatMm(totalHolePerimeter)}</div>
        <ul class="metric-list">${holeItems}${more}</ul>
      </div>
    `);
  } else {
    sections.push(`
      <div class="metric">
        <div class="metric-label">Holes & Features</div>
        <div class="metric-value">None detected</div>
      </div>
    `);
  }

  if (analysis.openLoops.length) {
    const openLength = analysis.openLoops.reduce((sum, loop) => sum + loop.lengthMm, 0);
    sections.push(`
      <div class="metric">
        <div class="metric-label">⚠️ Open/Incomplete Edges</div>
        <div class="metric-value">${formatMm(openLength)}</div>
        <div class="metric-sub">${analysis.openLoops.length} open chains (check model integrity)</div>
      </div>
    `);
  }

  const bend = analysis.bend;
  if (bend && bend.bendCount > 0) {
    const average = bend.sum / bend.bendCount;
    const minText = bend.min !== null && bend.min !== undefined ? bend.min.toFixed(anglePlaces) : '—';
    const maxText = bend.max !== null && bend.max !== undefined ? bend.max.toFixed(anglePlaces) : '—';

    const commonAngles = [90, 45, 30, 135, 120, 60, 180];
    const detectedCommon = [];
    commonAngles.forEach((targetAngle) => {
      let count = 0;
      bend.histogram.forEach((c, angle) => {
        if (Math.abs(angle - targetAngle) <= BEND_ANGLE_TOLERANCE_DEG) {
          count += c;
        }
      });
      if (count > 0) {
        detectedCommon.push(`${targetAngle}° (×${count})`);
      }
    });

    const histEntries = Array.from(bend.histogram.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([angle, count]) => {
        const isCommon = commonAngles.some((a) => Math.abs(angle - a) <= BEND_ANGLE_TOLERANCE_DEG);
        const marker = isCommon ? '★' : '';
        return `<li>${marker} ${angle}° – ${count} edge${count > 1 ? 's' : ''}</li>`;
      })
      .join('');

    sections.push(`
      <div class="metric">
        <div class="metric-label">Bend Information</div>
        <div class="metric-value">${bend.bendCount} bends detected</div>
        <div class="metric-sub">avg ${average.toFixed(anglePlaces)}°, range ${minText}° – ${maxText}°</div>
        ${detectedCommon.length ? `<div class="metric-sub">Common angles: ${detectedCommon.join(', ')}</div>` : ''}
        <ul class="metric-list">${histEntries}</ul>
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

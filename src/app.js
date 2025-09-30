// Three.js via CDN modules (ESM) and helpers from the examples directory.
import * as THREE from 'https://unpkg.com/three@0.160.0/build/three.module.js';
import { OrbitControls } from 'https://unpkg.com/three@0.160.0/examples/jsm/controls/OrbitControls.js';
import { STLLoader } from 'https://unpkg.com/three@0.160.0/examples/jsm/loaders/STLLoader.js';

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b1020);

const renderer = new THREE.WebGLRenderer({ antialias: true });
const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 5000);
const controls = new OrbitControls(camera, renderer.domElement);

const viewerEl = document.getElementById('viewer');
const resultsEl = document.getElementById('results');
const precisionEl = document.getElementById('precision');
const loading = document.getElementById('loading');
const dropEl = document.getElementById('drop');
const fileInput = document.getElementById('fileInput');
const stlUnitEl = document.getElementById('stlUnit');

const models = [];

let occtModulePromise = null;

const unitToMillimeter = {
  mm: 1,
  cm: 10,
  m: 1000,
  in: 25.4,
  ft: 304.8,
};

initViewer();
attachUiHandlers();

function initViewer() {
  renderer.setPixelRatio(window.devicePixelRatio || 1);
  const initialWidth = viewerEl.clientWidth || viewerEl.offsetWidth || 1;
  const initialHeight = viewerEl.clientHeight || viewerEl.offsetHeight || 1;
  renderer.setSize(initialWidth, initialHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  viewerEl.appendChild(renderer.domElement);

  camera.aspect = initialWidth / initialHeight;
  camera.position.set(180, 120, 180);
  camera.lookAt(0, 0, 0);
  camera.updateProjectionMatrix();

  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.target.set(0, 0, 0);
  controls.update();

  const hemisphere = new THREE.HemisphereLight(0xffffff, 0x1b1f3a, 0.6);
  scene.add(hemisphere);

  const dir1 = new THREE.DirectionalLight(0xffffff, 0.8);
  dir1.position.set(1, 1.25, 1.5);
  scene.add(dir1);

  const dir2 = new THREE.DirectionalLight(0x9fb5ff, 0.5);
  dir2.position.set(-1.5, -0.8, -1.25);
  scene.add(dir2);

  window.addEventListener('resize', onWindowResize);
  animate();
}

function onWindowResize() {
  const width = viewerEl.clientWidth || viewerEl.offsetWidth || 1;
  const height = viewerEl.clientHeight || viewerEl.offsetHeight || 1;
  renderer.setSize(width, height);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
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
      if (event.dataTransfer?.files) {
        handleFiles(event.dataTransfer.files);
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
    const card = addCard(name, '<div class=\"muted small\">Processing…</div>');
    card.classList.add('pending');
    try {
      loading?.classList.add('show');
      if (lower.endsWith('.stl')) {
        await loadStl(file, card);
      } else if (lower.endsWith('.step') || lower.endsWith('.stp')) {
        await loadStep(file, card);
      } else {
        updateCardBody(card, '<div class=\"warn\">Unsupported file type.</div>');
      }
    } catch (error) {
      console.error('Failed to process file.', error);
      updateCardBody(card, `<div class=\"warn\">Failed to load: ${error.message || error}</div>`);
    } finally {
      card.classList.remove('pending');
      loading?.classList.remove('show');
    }
  }
}

async function loadStl(file, card) {
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

  const positions = geometry.getAttribute('position')?.array;
  if (!positions) {
    throw new Error('STL geometry missing vertex positions.');
  }

  const unit = stlUnitEl?.value || 'mm';
  const toMillimeter = unitToMillimeter[unit] ?? 1;

  mesh.scale.setScalar(toMillimeter);

  const bounds = computeBoundsFromPositions(positions);
  bounds.min.multiplyScalar(toMillimeter);
  bounds.max.multiplyScalar(toMillimeter);

  scene.add(group);

  const dims = dimsFromBounds(bounds);
  const helper = addBoundingBoxHelper(bounds);

  const name = `${file.name}`;
  const decimals = parseInt(precisionEl?.value ?? '3', 10) || 3;
  const bodyHtml = `<div class=\"ok\">Loaded STL (${unit} → mm).</div>${formatDims(dims, decimals)}`;
  const targetCard = card ?? addCard(name, bodyHtml);
  updateCardBody(targetCard, bodyHtml);
  targetCard.classList.remove('pending');
  const model = { name, group, bounds, unit: unit || 'mm', kind: 'stl', helper };

  targetCard.addEventListener('click', () => {
    activateModel(model);
  });

  models.push(model);
  activateModel(model);
  return targetCard;
}

async function loadStep(file, card) {
  if (!file) {
    throw new Error('A file must be provided to loadStep.');
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
    const posSrc = meshResult?.attributes?.position?.array
      ?? meshResult.position
      ?? meshResult.positions
      ?? meshResult.vertices;
    if (!posSrc) continue;

    const posArray = posSrc.BYTES_PER_ELEMENT ? posSrc : new Float32Array(posSrc);

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(posArray, 3));

    const idxSrc = meshResult.index?.array ?? meshResult.indices ?? meshResult.index;
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
    bounds = bounds ? bounds.union(meshBounds) : meshBounds;
  }

  if (!bounds) {
    throw new Error('No geometry produced from STEP.');
  }

  scene.add(group);
  const dimsMm = dimsFromBounds(bounds);
  const helper = addBoundingBoxHelper(bounds);

  const name = `${file.name}`;
  const decimals = parseInt(precisionEl?.value ?? '3', 10) || 3;
  const bodyHtml = `<div class=\"ok\">Loaded STEP (converted → mm).</div>${formatDims(dimsMm, decimals)}`;
  const targetCard = card ?? addCard(name, bodyHtml);
  updateCardBody(targetCard, bodyHtml);
  targetCard.classList.remove('pending');
  const model = { name, group, bounds, unit: 'mm', kind: 'step', helper };

  targetCard.addEventListener('click', () => {
    activateModel(model);
  });

  models.push(model);
  activateModel(model);
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

function activateModel(model) {
  models.forEach((m) => {
    if (m.helper) {
      m.helper.material.opacity = m === model ? 0.9 : 0.25;
      m.helper.material.transparent = true;
      m.helper.visible = true;
    }
  });
  centerAndFrame(model.bounds);
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

function addBoundingBoxHelper(bounds) {
  const size = new THREE.Vector3();
  bounds.getSize(size);
  const center = new THREE.Vector3();
  bounds.getCenter(center);

  const geometry = new THREE.BoxGeometry(size.x, size.y, size.z);
  const edges = new THREE.EdgesGeometry(geometry);
  const material = new THREE.LineBasicMaterial({ color: 0x7aa2ff, transparent: true, opacity: 0.25 });
  const helper = new THREE.LineSegments(edges, material);
  helper.position.copy(center);
  scene.add(helper);
  return helper;
}

function centerAndFrame(bounds) {
  const center = new THREE.Vector3();
  const size = new THREE.Vector3();
  bounds.getCenter(center);
  bounds.getSize(size);

  const maxDim = Math.max(size.x, size.y, size.z);
  const radius = maxDim * 1.35 + 1;
  const offset = new THREE.Vector3(1.2, 0.9, 1.1).normalize().multiplyScalar(radius);

  controls.target.copy(center);
  camera.position.copy(center).add(offset);
  camera.near = Math.max(radius / 100, 0.1);
  camera.far = radius * 20 + radius;
  camera.updateProjectionMatrix();
  controls.update();
}

function formatDims(dims, decimals) {
  const mm = dims.mm;
  const inch = dims.inch;
  const places = Number.isFinite(decimals) ? Math.max(decimals, 0) : 3;
  const mmText = `${mm.x.toFixed(places)} × ${mm.y.toFixed(places)} × ${mm.z.toFixed(places)} mm`;
  const inchText = `${inch.x.toFixed(places)} × ${inch.y.toFixed(places)} × ${inch.z.toFixed(places)} in`;
  return `<div class=\"dim\">${mmText}<br><small>${inchText}</small></div>`;
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
  resultsEl?.prepend(card);
  return card;
}

function updateCardBody(card, bodyHtml) {
  if (!card) return;
  const body = card.querySelector('.card-body');
  if (body) {
    body.innerHTML = bodyHtml;
  }
}

export {
  scene,
  models,
  precisionEl,
  loading,
  loadStep,
  loadStl,
  handleFiles,
  initViewer,
};

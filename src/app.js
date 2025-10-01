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

const viewerManager = new ViewerManager(viewerEl);
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
    const card = addCard(name, '<div class="muted small">Processing…</div>');
    card.classList.add('pending');

    let viewport = null;

    try {
      loading?.classList.add('show');
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
      loading?.classList.remove('show');
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

  const dims = dimsFromBounds(bounds);

  const name = `${file.name}`;
  const decimals = parseInt(precisionEl?.value ?? '3', 10) || 3;
  const bodyHtml = `<div class="ok">Loaded STL (${unit} → mm).</div>${formatDims(dims, decimals)}`;
  const targetCard = card ?? addCard(name, bodyHtml);
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
    bounds = bounds ? bounds.union(meshBounds) : meshBounds.clone();
  }

  if (!bounds) {
    throw new Error('No geometry produced from STEP.');
  }

  const dimsMm = dimsFromBounds(bounds);

  const name = `${file.name}`;
  const decimals = parseInt(precisionEl?.value ?? '3', 10) || 3;
  const bodyHtml = `<div class="ok">Loaded STEP (converted → mm).</div>${formatDims(dimsMm, decimals)}`;
  const targetCard = card ?? addCard(name, bodyHtml);
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

export {
  models,
  precisionEl,
  loading,
  loadStep,
  loadStl,
  handleFiles,
  initViewer,
};

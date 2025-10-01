import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';

const unitToMillimeter = {
  mm: 1,
  cm: 10,
  m: 1000,
  in: 25.4,
  ft: 304.8,
};

export async function loadStl(file, card, viewport, options = {}) {
  if (!file) {
    throw new Error('A file must be provided to loadStl.');
  }
  if (!viewport) {
    throw new Error('A viewer window could not be created for this STL file.');
  }
  const {
    stlUnitEl,
    precisionEl,
    addCard,
    updateCardBody,
    computeBoundsFromPositions,
    dimsFromBounds,
    analyzeSheetMetal,
    formatDims,
    formatLaserCutAnalysis,
    models,
  } = options;

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
  const analysis = analyzeSheetMetal(group);

  const name = `${file.name}`;
  const precisionValue = precisionEl && precisionEl.value !== undefined ? precisionEl.value : '3';
  const decimals = parseInt(precisionValue, 10) || 3;
  const bodyHtml = [
    `<div class="ok">Loaded STL (${unit} → mm).</div>`,
    formatDims(dims, decimals),
    formatLaserCutAnalysis(analysis, decimals),
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

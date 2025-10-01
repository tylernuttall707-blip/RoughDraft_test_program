import * as THREE from 'three';

export async function loadStep(file, card, viewport, options = {}) {
  if (!file) {
    throw new Error('A file must be provided to loadStep.');
  }
  if (!viewport) {
    throw new Error('A viewer window could not be created for this STEP file.');
  }

  const {
    ensureOcctModule,
    precisionEl,
    addCard,
    updateCardBody,
    dimsFromBounds,
    analyzeSheetMetal,
    formatDims,
    formatLaserCutAnalysis,
    computeBoundsFromPositions,
    models,
  } = options;

  const occt = await ensureOcctModule();
  const uint8 = new Uint8Array(await file.arrayBuffer());
  const params = {
    linearUnit: 'millimeter',
    linearDeflectionType: 'bounding_box_ratio',
    linearDeflection: 0.00005,
    angularDeflection: 0.05,
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
  const analysis = analyzeSheetMetal(group);

  const name = `${file.name}`;
  const precisionValue = precisionEl && precisionEl.value !== undefined ? precisionEl.value : '3';
  const decimals = parseInt(precisionValue, 10) || 3;
  const bodyHtml = [
    '<div class="ok">Loaded STEP (converted → mm).</div>',
    formatDims(dimsMm, decimals),
    formatLaserCutAnalysis(analysis, decimals),
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

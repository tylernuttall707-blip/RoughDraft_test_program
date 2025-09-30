// Three.js via CDN modules
import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.156/build/three.module.js';
const scene = new THREE.Scene();
const models = [];
const precisionEl = document.getElementById('precision');
const loading = document.getElementById('loading');

async function loadStep(file) {
  if (!file) {
    throw new Error('A file must be provided to loadStep.');
  }

  try {
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
    for (const m of result.meshes) {
      // Build a BufferGeometry from OCCT result, with fallbacks for field names
      const posSrc = (m.attributes && m.attributes.position && m.attributes.position.array)
        ? m.attributes.position.array
        : (m.position || m.positions || m.vertices);
      if (!posSrc) continue;
      const pos = posSrc.BYTES_PER_ELEMENT ? new Float32Array(posSrc) : new Float32Array(posSrc);

      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));

      const idxSrc = (m.index && m.index.array) ? m.index.array : (m.indices || m.index);
      if (idxSrc) {
        const typed = (idxSrc.length > 65535) ? new Uint32Array(idxSrc) : new Uint16Array(idxSrc);
        geo.setIndex(new THREE.BufferAttribute(typed, 1));
      }
      geo.computeVertexNormals();

      const colorObj = (m.color && m.color.length === 3)
        ? new THREE.Color(m.color[0], m.color[1], m.color[2])
        : new THREE.Color(0x3c8bff);
      const mat = new THREE.MeshStandardMaterial({ color: colorObj, metalness: 0.05, roughness: 0.6 });
      const mesh = new THREE.Mesh(geo, mat);
      group.add(mesh);

      const bb = computeBoundsFromPositions(pos);
      bounds = bounds ? bounds.union(bb) : bb;
    }

    if (!bounds) {
      throw new Error('No geometry produced from STEP.');
    }

    scene.add(group);
    const dimsMm = dimsFromBounds(bounds);
    const boxHelper = addBoundingBoxHelper(bounds);

    const name = `${file.name}`;
    const prec = parseInt(precisionEl.value, 10) || 3;
    const card = addCard(name, `<div class=\"ok\">Loaded STEP (converted → mm).</div>${formatDims(dimsMm, prec)}`);
    card.addEventListener('click', () => { centerAndFrame(bounds); });
    centerAndFrame(bounds);

    models.push({ name, group, bounds, unit: 'mm', kind: 'step', helper: boxHelper });
  } catch (err) {
    console.error('Failed to import STEP file.', err);
    const displayName = (file && file.name) ? `${file.name}` : 'STEP file';
    addCard(displayName, `<div class=\"warn\">Failed to load STEP: ${err.message || err}</div>`);
  } finally {
    if (loading) {
      loading.classList.remove('show');
    }
  }
}

export { scene, models, precisionEl, loading, loadStep };

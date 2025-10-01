import { DXFLoader } from '../loaders/DXFLoader.js';

export async function loadDxf(file, card, viewport, options = {}) {
  if (!file) {
    throw new Error('A file must be provided to loadDxf.');
  }
  if (!viewport) {
    throw new Error('A viewer window could not be created for this DXF file.');
  }

  const {
    precisionEl,
    addCard,
    updateCardBody,
    computeBoundsFromGroup,
    dimsFromBounds,
    analyzeSheetMetal,
    formatDims,
    formatLaserCutAnalysis,
    models,
  } = options;

  const text = await file.text();
  const loader = new DXFLoader();
  const group = loader.parse(text);

  if (!group) {
    throw new Error('DXF loader produced no geometry.');
  }

  const bounds = computeBoundsFromGroup(group);
  if (!bounds) {
    throw new Error('DXF file contained no drawable entities.');
  }

  const dimsMm = dimsFromBounds(bounds);
  const analysis = analyzeSheetMetal(group);

  const name = `${file.name}`;
  const precisionValue = precisionEl && precisionEl.value !== undefined ? precisionEl.value : '3';
  const decimals = parseInt(precisionValue, 10) || 3;
  const bodyHtml = [
    '<div class="ok">Loaded DXF (flat pattern, units assumed mm).</div>',
    formatDims(dimsMm, decimals),
    formatLaserCutAnalysis(analysis, decimals),
  ].join('');
  const targetCard = card || addCard(name, bodyHtml);
  updateCardBody(targetCard, bodyHtml);
  targetCard.classList.remove('pending');

  viewport.setTitle(name);
  viewport.setModel(group, bounds.clone());

  const model = { name, group, bounds: bounds.clone(), unit: 'mm', kind: 'dxf', viewport, card: targetCard };
  targetCard.addEventListener('click', () => viewport.focus());
  models.push(model);
  return targetCard;
}

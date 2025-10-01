import * as THREE from 'three';
import { DXFLoader } from '../loaders/DXFLoader.js';

// DXF unit codes to millimeter conversion
const DXF_UNITS_TO_MM = {
  0: 1,      // Unitless (assume mm)
  1: 25.4,   // Inches
  2: 304.8,  // Feet
  3: 1609344, // Miles
  4: 1,      // Millimeters
  5: 10,     // Centimeters
  6: 1000,   // Meters
  7: 1000000, // Kilometers
  8: 0.0254, // Microinches
  9: 0.0000254, // Mils
  10: 914.4, // Yards
  11: 0.00001, // Angstroms
  12: 0.000001, // Nanometers
  13: 0.001, // Microns
  14: 10000000, // Decimeters
  15: 100000000, // Decameters
  16: 100000000000, // Hectometers
  17: 1000000000000000, // Gigameters
  18: 149597870700000, // Astronomical units
  19: 9460730472580800000, // Light years
  20: 30856775814671900000, // Parsecs
};

function getUnitName(unitCode) {
  const names = {
    0: 'unitless (assumed mm)',
    1: 'inches',
    2: 'feet',
    3: 'miles',
    4: 'millimeters',
    5: 'centimeters',
    6: 'meters',
    7: 'kilometers',
    8: 'microinches',
    9: 'mils',
    10: 'yards',
    11: 'angstroms',
    12: 'nanometers',
    13: 'microns',
    14: 'decimeters',
    15: 'decameters',
    16: 'hectometers',
    17: 'gigameters',
    18: 'astronomical units',
    19: 'light years',
    20: 'parsecs',
  };
  return names[unitCode] || 'unknown';
}

function formatEntityCounts(entityCounts) {
  if (!entityCounts || Object.keys(entityCounts).length === 0) {
    return '';
  }

  const entries = Object.entries(entityCounts)
    .sort((a, b) => b[1] - a[1]) // Sort by count descending
    .slice(0, 8) // Top 8 entity types
    .map(([type, count]) => {
      const icon = getEntityIcon(type);
      return `<li>${icon} ${type}: ${count}</li>`;
    })
    .join('');

  const total = Object.values(entityCounts).reduce((sum, count) => sum + count, 0);
  const remaining = Object.keys(entityCounts).length - 8;
  const more = remaining > 0 ? `<li class="metric-sub">+ ${remaining} more types</li>` : '';

  return `
    <div class="metric">
      <div class="metric-label">📊 Entity Summary</div>
      <div class="metric-value">${total} total entities</div>
      <ul class="metric-list">${entries}${more}</ul>
    </div>
  `;
}

function getEntityIcon(type) {
  const icons = {
    'LINE': '━',
    'LWPOLYLINE': '〰',
    'POLYLINE': '〰',
    'CIRCLE': '○',
    'ARC': '⌒',
    'ELLIPSE': '⬭',
    'SPLINE': '∿',
    'POINT': '•',
    '3DFACE': '▲',
    'INSERT': '⊞',
    'TEXT': 'T',
    'MTEXT': 'T',
    'DIMENSION': '↔',
  };
  return icons[type] || '▪';
}

function formatFileInfo(metadata, fileName, unitScale, sourceUnit) {
  const sections = [];

  // File info section
  sections.push(`
    <div class="metric">
      <div class="metric-label">📄 File Information</div>
      <div class="metric-value">${fileName}</div>
      <div class="metric-sub">Source units: ${sourceUnit}</div>
      ${unitScale !== 1 ? `<div class="metric-sub">Scale factor: ${unitScale}× to mm</div>` : ''}
      ${metadata.layerCount > 0 ? `<div class="metric-sub">Layers: ${metadata.layerCount}</div>` : ''}
    </div>
  `);

  return sections.join('');
}

function validateDxfGeometry(group, metadata) {
  const warnings = [];

  // Check if file is empty
  if (!group.children.length) {
    warnings.push('⚠️ No geometry found in file');
  }

  // Check for suspicious bounds
  if (metadata.bounds) {
    const size = new THREE.Vector3();
    metadata.bounds.getSize(size);
    const maxDim = Math.max(size.x, size.y, size.z);
    const minDim = Math.min(size.x, size.y, size.z);

    if (maxDim > 1000000) {
      warnings.push('⚠️ Very large geometry detected - check units');
    }

    if (maxDim < 0.001) {
      warnings.push('⚠️ Very small geometry detected - check units');
    }

    if (minDim === 0 && maxDim > 0) {
      warnings.push('✓ True 2D flat pattern detected');
    }
  }

  // Check for unusual entity types
  if (metadata.entityCounts) {
    const hasBlocks = metadata.entityCounts['INSERT'] > 0;
    const hasText = (metadata.entityCounts['TEXT'] || 0) + (metadata.entityCounts['MTEXT'] || 0) > 0;
    const has3D = metadata.entityCounts['3DFACE'] > 0;

    if (hasBlocks) {
      warnings.push(`ℹ️ Contains ${metadata.entityCounts['INSERT']} block instances`);
    }

    if (hasText) {
      const textCount = (metadata.entityCounts['TEXT'] || 0) + (metadata.entityCounts['MTEXT'] || 0);
      warnings.push(`ℹ️ Contains ${textCount} text annotations (shown as points)`);
    }

    if (has3D) {
      warnings.push('⚠️ Contains 3D faces - may not be a flat pattern');
    }
  }

  if (warnings.length === 0) {
    return '';
  }

  const warningItems = warnings.map(w => `<li>${w}</li>`).join('');
  return `
    <div class="metric">
      <div class="metric-label">ℹ️ File Analysis</div>
      <ul class="metric-list">${warningItems}</ul>
    </div>
  `;
}

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
  const loader = new DXFLoader({
    circleSegments: 64,
    arcSegmentAngle: 5, // More segments for smoother arcs
  });
  
  const group = loader.parse(text);

  if (!group) {
    throw new Error('DXF loader produced no geometry.');
  }

  const metadata = loader.getMetadata();
  const bounds = computeBoundsFromGroup(group);
  if (!bounds) {
    throw new Error('DXF file contained no drawable entities.');
  }

  // Determine unit conversion
  let unitCode = 0; // Default to unitless/mm
  if (metadata.units === 'unknown' || metadata.units === null) {
    unitCode = 0;
  } else if (typeof metadata.units === 'number') {
    unitCode = metadata.units;
  } else {
    unitCode = parseInt(metadata.units, 10) || 0;
  }

  const unitScale = DXF_UNITS_TO_MM[unitCode] || 1;
  const sourceUnit = getUnitName(unitCode);

  // Apply unit scaling if needed
  if (unitScale !== 1) {
    group.scale.setScalar(unitScale);
    bounds.min.multiplyScalar(unitScale);
    bounds.max.multiplyScalar(unitScale);
  }

  const dimsMm = dimsFromBounds(bounds);
  const analysis = analyzeSheetMetal(group, metadata);

  const name = `${file.name}`;
  const precisionValue = precisionEl && precisionEl.value !== undefined ? precisionEl.value : '3';
  const decimals = parseInt(precisionValue, 10) || 3;

  // Build comprehensive output
  const bodyParts = [
    '<div class="ok">Loaded DXF successfully.</div>',
    formatFileInfo(metadata, name, unitScale, sourceUnit),
    formatDims(dimsMm, decimals),
    formatEntityCounts(metadata.entityCounts),
    validateDxfGeometry(group, metadata),
    formatLaserCutAnalysis(analysis, decimals),
  ];

  const bodyHtml = bodyParts.filter(part => part).join('');
  const targetCard = card || addCard(name, bodyHtml);
  updateCardBody(targetCard, bodyHtml);
  targetCard.classList.remove('pending');

  viewport.setTitle(name);
  viewport.setModel(group, bounds.clone());

  const model = { 
    name, 
    group, 
    bounds: bounds.clone(), 
    unit: sourceUnit, 
    unitScale,
    kind: 'dxf', 
    viewport, 
    card: targetCard,
    metadata,
  };
  targetCard.addEventListener('click', () => viewport.focus());
  models.push(model);
  return targetCard;
}

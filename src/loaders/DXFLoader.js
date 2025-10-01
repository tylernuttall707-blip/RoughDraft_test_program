import * as THREE from 'three';

const DEFAULT_COLOR = 0x3f83f8;
const DEFAULT_LINE_WIDTH = 1;
const DEFAULT_ARC_SEGMENT_DEG = 10;
const ACI_COLOR_MAP = {
  1: 0xff0000, 2: 0xffff00, 3: 0x00ff00, 4: 0x00ffff,
  5: 0x0000ff, 6: 0xff00ff, 7: 0xffffff, 8: 0x808080, 9: 0xc0c0c0,
};

function parsePairs(text) {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n');
  const pairs = [];
  for (let i = 0; i < lines.length;) {
    const codeLine = lines[i];
    if (codeLine === undefined) break;
    const codeTrimmed = codeLine.trim();
    i += 1;
    if (codeTrimmed === '') continue;
    const valueLine = lines[i];
    if (valueLine === undefined) break;
    i += 1;
    const code = parseInt(codeTrimmed, 10);
    if (Number.isNaN(code)) continue;
    pairs.push({ code, value: valueLine });
  }
  return pairs;
}

function getNumber(list, code, index = 0, fallback = 0) {
  const arr = list.get(code);
  if (!arr || index >= arr.length) return fallback;
  const value = parseFloat(arr[index]);
  return Number.isFinite(value) ? value : fallback;
}

function getInteger(list, code, index = 0, fallback = null) {
  const arr = list.get(code);
  if (!arr || index >= arr.length) return fallback;
  const value = parseInt(arr[index], 10);
  return Number.isNaN(value) ? fallback : value;
}

function getString(list, code, index = 0, fallback = null) {
  const arr = list.get(code);
  if (!arr || index >= arr.length) return fallback;
  return arr[index] != null ? String(arr[index]).trim() : fallback;
}

function positionsFromVectors(points) {
  const array = new Float32Array(points.length * 3);
  for (let i = 0; i < points.length; i += 1) {
    const p = points[i];
    array[i * 3] = p.x;
    array[i * 3 + 1] = p.y;
    array[i * 3 + 2] = p.z;
  }
  return array;
}

function createMaterialKey(color, type) {
  return `${type}:${color.toString(16)}`;
}

export class DXFLoader {
  constructor(options = {}) {
    this.options = {
      defaultColor: DEFAULT_COLOR,
      circleSegments: options.circleSegments || 64,
      arcSegmentAngle: options.arcSegmentAngle || DEFAULT_ARC_SEGMENT_DEG,
      defaultLineWidth: options.defaultLineWidth || DEFAULT_LINE_WIDTH,
    };
    this._materialCache = new Map();
    this.metadata = {
      units: null,
      bounds: null,
      layerCount: 0,
      entityCounts: {},
    };
  }

  parse(text) {
    if (typeof text !== 'string') {
      throw new Error('DXFLoader.parse requires a DXF file as a string.');
    }
    const pairs = parsePairs(text);
    if (!pairs.length) {
      throw new Error('DXFLoader: the provided file does not contain any DXF data.');
    }

    const group = new THREE.Group();
    const state = {
      layers: new Map(),
      blocks: new Map(),
      header: {},
    };

    this._parseSections(pairs, group, state);

    if (!group.children.length) {
      throw new Error('DXF file contained no supported entities.');
    }

    // Compute metadata
    const bounds = new THREE.Box3().setFromObject(group);
    this.metadata.bounds = bounds;
    this.metadata.layerCount = state.layers.size;
    this.metadata.units = state.header.$INSUNITS || 'unknown';

    return group;
  }

  _parseSections(pairs, group, state) {
    let i = 0;
    while (i < pairs.length) {
      const pair = pairs[i];
      if (pair.code === 0 && pair.value.trim().toUpperCase() === 'SECTION') {
        const namePair = pairs[i + 1];
        const sectionName = namePair && namePair.code === 2 ? namePair.value.trim().toUpperCase() : '';
        if (sectionName === 'HEADER') {
          i = this._parseHeader(pairs, i + 2, state);
        } else if (sectionName === 'TABLES') {
          i = this._parseTables(pairs, i + 2, state);
        } else if (sectionName === 'BLOCKS') {
          i = this._parseBlocks(pairs, i + 2, state);
        } else if (sectionName === 'ENTITIES') {
          i = this._parseEntities(pairs, i + 2, group, state);
        } else {
          i = this._skipSection(pairs, i + 2);
        }
      } else {
        i += 1;
      }
    }
  }

  _parseHeader(pairs, index, state) {
    let i = index;
    let currentVar = null;
    while (i < pairs.length) {
      const pair = pairs[i];
      if (pair.code === 0 && pair.value.trim().toUpperCase() === 'ENDSEC') {
        return i + 1;
      }
      if (pair.code === 9) {
        currentVar = pair.value.trim();
      } else if (currentVar && pair.code === 70) {
        // Common integer header variable
        state.header[currentVar] = parseInt(pair.value, 10);
      } else if (currentVar && pair.code === 40) {
        // Common float header variable
        state.header[currentVar] = parseFloat(pair.value);
      }
      i += 1;
    }
    return i;
  }

  _skipSection(pairs, index) {
    let i = index;
    while (i < pairs.length) {
      const pair = pairs[i];
      if (pair.code === 0 && pair.value.trim().toUpperCase() === 'ENDSEC') {
        return i + 1;
      }
      i += 1;
    }
    return i;
  }

  _parseTables(pairs, index, state) {
    let i = index;
    while (i < pairs.length) {
      const pair = pairs[i];
      if (pair.code === 0) {
        const value = pair.value.trim().toUpperCase();
        if (value === 'ENDSEC') {
          return i + 1;
        }
        if (value === 'TABLE') {
          const namePair = pairs[i + 1];
          const tableName = namePair && namePair.code === 2 ? namePair.value.trim().toUpperCase() : '';
          if (tableName === 'LAYER') {
            i = this._parseLayerTable(pairs, i + 2, state);
            continue;
          }
        }
      }
      i += 1;
    }
    return i;
  }

  _parseLayerTable(pairs, index, state) {
    let i = index;
    while (i < pairs.length) {
      const pair = pairs[i];
      if (pair.code === 0) {
        const value = pair.value.trim().toUpperCase();
        if (value === 'ENDTAB') {
          return i + 1;
        }
        if (value === 'LAYER') {
          const { data, next } = this._collectEntityData(pairs, i + 1);
          const name = getString(data, 2, 0, null);
          let color = null;
          const trueColor = getInteger(data, 420, 0, null);
          if (trueColor != null) {
            color = trueColor;
          } else {
            const aci = getInteger(data, 62, 0, null);
            if (aci != null) {
              const mapped = this._aciToHex(aci);
              if (mapped != null) {
                color = mapped;
              }
            }
          }
          if (name) {
            state.layers.set(name, color != null ? color : this.options.defaultColor);
          }
          i = next;
          continue;
        }
      }
      i += 1;
    }
    return i;
  }

  _parseBlocks(pairs, index, state) {
    let i = index;
    while (i < pairs.length) {
      const pair = pairs[i];
      if (pair.code === 0) {
        const value = pair.value.trim().toUpperCase();
        if (value === 'ENDSEC') {
          return i + 1;
        }
        if (value === 'BLOCK') {
          const { data, next } = this._collectEntityData(pairs, i + 1);
          const blockName = getString(data, 2, 0, null);
          if (blockName) {
            const blockGroup = new THREE.Group();
            blockGroup.name = blockName;
            i = this._parseBlockEntities(pairs, next, blockGroup, state);
            state.blocks.set(blockName, blockGroup);
            continue;
          }
        }
      }
      i += 1;
    }
    return i;
  }

  _parseBlockEntities(pairs, index, group, state) {
    let i = index;
    while (i < pairs.length) {
      const pair = pairs[i];
      if (pair.code === 0) {
        const type = pair.value.trim().toUpperCase();
        if (type === 'ENDBLK') {
          return i + 1;
        }
        i = this._parseEntity(pairs, i, group, state);
      } else {
        i += 1;
      }
    }
    return i;
  }

  _parseEntities(pairs, index, group, state) {
    let i = index;
    while (i < pairs.length) {
      const pair = pairs[i];
      if (pair.code !== 0) {
        i += 1;
        continue;
      }
      const type = pair.value.trim().toUpperCase();
      if (type === 'ENDSEC') {
        return i + 1;
      }
      i = this._parseEntity(pairs, i, group, state);
    }
    return i;
  }

  _parseEntity(pairs, index, group, state) {
    const pair = pairs[index];
    const type = pair.value.trim().toUpperCase();
    
    // Track entity counts
    this.metadata.entityCounts[type] = (this.metadata.entityCounts[type] || 0) + 1;

    if (type === 'LINE') {
      const { object, next } = this._parseLine(pairs, index + 1, state);
      if (object) group.add(object);
      return next;
    }
    if (type === 'LWPOLYLINE') {
      const { object, next } = this._parseLwPolyline(pairs, index + 1, state);
      if (object) group.add(object);
      return next;
    }
    if (type === 'POLYLINE') {
      const { object, next } = this._parsePolyline(pairs, index + 1, state);
      if (object) group.add(object);
      return next;
    }
    if (type === 'CIRCLE') {
      const { object, next } = this._parseCircle(pairs, index + 1, state);
      if (object) group.add(object);
      return next;
    }
    if (type === 'ARC') {
      const { object, next } = this._parseArc(pairs, index + 1, state);
      if (object) group.add(object);
      return next;
    }
    if (type === 'ELLIPSE') {
      const { object, next } = this._parseEllipse(pairs, index + 1, state);
      if (object) group.add(object);
      return next;
    }
    if (type === 'SPLINE') {
      const { object, next } = this._parseSpline(pairs, index + 1, state);
      if (object) group.add(object);
      return next;
    }
    if (type === 'POINT') {
      const { object, next } = this._parsePoint(pairs, index + 1, state);
      if (object) group.add(object);
      return next;
    }
    if (type === '3DFACE') {
      const { object, next } = this._parse3dFace(pairs, index + 1, state);
      if (object) group.add(object);
      return next;
    }
    if (type === 'INSERT') {
      const { object, next } = this._parseInsert(pairs, index + 1, state);
      if (object) group.add(object);
      return next;
    }
    if (type === 'TEXT' || type === 'MTEXT') {
      const { object, next } = this._parseText(pairs, index + 1, state);
      if (object) group.add(object);
      return next;
    }
    if (type === 'DIMENSION') {
      const { object, next } = this._parseDimension(pairs, index + 1, state);
      if (object) group.add(object);
      return next;
    }
    
    // Skip unsupported entity
    const { next } = this._collectEntityData(pairs, index + 1);
    return next;
  }

  _parseLine(pairs, index, state) {
    const { data, next } = this._collectEntityData(pairs, index);
    const start = new THREE.Vector3(
      getNumber(data, 10, 0, 0),
      getNumber(data, 20, 0, 0),
      getNumber(data, 30, 0, 0)
    );
    const end = new THREE.Vector3(
      getNumber(data, 11, 0, 0),
      getNumber(data, 21, 0, 0),
      getNumber(data, 31, 0, 0)
    );
    if (start.equals(end)) {
      return { object: null, next };
    }
    const color = this._resolveColor(data, state);
    const line = this._createLine([start, end], false, color);
    this._applyLayerToObject(line, data, state);
    return { object: line, next };
  }

  _parseLwPolyline(pairs, index, state) {
    const { data, next } = this._collectEntityData(pairs, index);
    const vertices = [];
    const xs = data.get(10) || [];
    const ys = data.get(20) || [];
    const zs = data.get(30) || [];
    const bulges = data.get(42) || [];
    const elevation = getNumber(data, 38, 0, 0);

    for (let i = 0; i < xs.length; i += 1) {
      const x = parseFloat(xs[i]);
      const y = parseFloat(ys[i] || '0');
      const z = parseFloat(zs[i] || elevation);
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
        continue;
      }
      vertices.push(new THREE.Vector3(x, y, z));
      const bulge = parseFloat(bulges[i] || '0');
      if (Number.isFinite(bulge) && Math.abs(bulge) > 1e-6) {
        const start = vertices[vertices.length - 2];
        const end = vertices[vertices.length - 1];
        if (start && end) {
          const arcPoints = this._bulgeToArc(start, end, bulge);
          vertices.splice(vertices.length - 1, 1, ...arcPoints);
        }
      }
    }
    if (!vertices.length) {
      return { object: null, next };
    }
    const flag = getInteger(data, 70, 0, 0);
    const closed = (flag & 1) === 1;
    const color = this._resolveColor(data, state);
    const line = this._createLine(vertices, closed, color);
    this._applyLayerToObject(line, data, state);
    return { object: line, next };
  }

  _parsePolyline(pairs, index, state) {
    const base = this._collectEntityData(pairs, index);
    let i = base.next;
    const vertices = [];
    let closed = false;
    const flag = getInteger(base.data, 70, 0, 0);
    if ((flag & 1) === 1) closed = true;
    const elevation = getNumber(base.data, 30, 0, 0);

    while (i < pairs.length) {
      const pair = pairs[i];
      if (pair.code !== 0) {
        i += 1;
        continue;
      }
      const type = pair.value.trim().toUpperCase();
      if (type === 'VERTEX') {
        const { data, next } = this._collectEntityData(pairs, i + 1);
        const x = getNumber(data, 10, 0, NaN);
        const y = getNumber(data, 20, 0, NaN);
        const z = getNumber(data, 30, 0, elevation);
        if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
          vertices.push(new THREE.Vector3(x, y, z));
        }
        i = next;
        continue;
      }
      if (type === 'SEQEND') {
        const skip = this._collectEntityData(pairs, i + 1);
        i = skip.next;
        break;
      }
      break;
    }
    if (!vertices.length) {
      return { object: null, next: i };
    }
    const color = this._resolveColor(base.data, state);
    const line = this._createLine(vertices, closed, color);
    this._applyLayerToObject(line, base.data, state);
    return { object: line, next: i };
  }

  _parseCircle(pairs, index, state) {
    const { data, next } = this._collectEntityData(pairs, index);
    const center = new THREE.Vector3(
      getNumber(data, 10, 0, 0),
      getNumber(data, 20, 0, 0),
      getNumber(data, 30, 0, 0)
    );
    const radius = getNumber(data, 40, 0, 0);
    if (radius <= 0) {
      return { object: null, next };
    }
    const segments = Math.max(16, this.options.circleSegments);
    const points = [];
    for (let i = 0; i < segments; i += 1) {
      const angle = (i / segments) * Math.PI * 2;
      const x = center.x + radius * Math.cos(angle);
      const y = center.y + radius * Math.sin(angle);
      points.push(new THREE.Vector3(x, y, center.z));
    }
    const color = this._resolveColor(data, state);
    const line = this._createLine(points, true, color);
    this._applyLayerToObject(line, data, state);
    return { object: line, next };
  }

  _parseArc(pairs, index, state) {
    const { data, next } = this._collectEntityData(pairs, index);
    const center = new THREE.Vector3(
      getNumber(data, 10, 0, 0),
      getNumber(data, 20, 0, 0),
      getNumber(data, 30, 0, 0)
    );
    const radius = getNumber(data, 40, 0, 0);
    const startAngleDeg = getNumber(data, 50, 0, 0);
    const endAngleDeg = getNumber(data, 51, 0, 0);
    if (radius <= 0) {
      return { object: null, next };
    }
    const startRad = THREE.MathUtils.degToRad(startAngleDeg);
    const endRad = THREE.MathUtils.degToRad(endAngleDeg);
    let sweep = endRad - startRad;
    if (sweep <= 0) sweep += Math.PI * 2;
    const segmentAngle = THREE.MathUtils.degToRad(this.options.arcSegmentAngle);
    const steps = Math.max(8, Math.ceil(sweep / segmentAngle));
    const points = [];
    for (let step = 0; step <= steps; step += 1) {
      const t = startRad + (sweep * step) / steps;
      const x = center.x + radius * Math.cos(t);
      const y = center.y + radius * Math.sin(t);
      points.push(new THREE.Vector3(x, y, center.z));
    }
    const color = this._resolveColor(data, state);
    const line = this._createLine(points, false, color);
    this._applyLayerToObject(line, data, state);
    return { object: line, next };
  }

  _parseEllipse(pairs, index, state) {
    const { data, next } = this._collectEntityData(pairs, index);
    const center = new THREE.Vector3(
      getNumber(data, 10, 0, 0),
      getNumber(data, 20, 0, 0),
      getNumber(data, 30, 0, 0)
    );
    const majorAxis = new THREE.Vector3(
      getNumber(data, 11, 0, 0),
      getNumber(data, 21, 0, 0),
      getNumber(data, 31, 0, 0)
    );
    const ratio = getNumber(data, 40, 0, 1);
    const startParam = getNumber(data, 41, 0, 0);
    const endParam = getNumber(data, 42, 0, Math.PI * 2);

    const majorRadius = majorAxis.length();
    const minorRadius = majorRadius * ratio;
    if (majorRadius <= 0 || minorRadius <= 0) {
      return { object: null, next };
    }

    const angle = Math.atan2(majorAxis.y, majorAxis.x);
    const segments = Math.max(32, this.options.circleSegments);
    const points = [];
    let sweep = endParam - startParam;
    if (sweep < 0) sweep += Math.PI * 2;
    const steps = Math.max(16, Math.ceil((sweep / (Math.PI * 2)) * segments));

    for (let i = 0; i <= steps; i += 1) {
      const t = startParam + (sweep * i) / steps;
      const x = majorRadius * Math.cos(t);
      const y = minorRadius * Math.sin(t);
      const rotX = x * Math.cos(angle) - y * Math.sin(angle);
      const rotY = x * Math.sin(angle) + y * Math.cos(angle);
      points.push(new THREE.Vector3(center.x + rotX, center.y + rotY, center.z));
    }

    const closed = Math.abs(sweep - Math.PI * 2) < 0.01;
    const color = this._resolveColor(data, state);
    const line = this._createLine(points, closed, color);
    this._applyLayerToObject(line, data, state);
    return { object: line, next };
  }

  _parseSpline(pairs, index, state) {
    const { data, next } = this._collectEntityData(pairs, index);
    const xs = data.get(10) || [];
    const ys = data.get(20) || [];
    const zs = data.get(30) || [];
    const controlPoints = [];
    
    for (let i = 0; i < xs.length; i += 1) {
      const x = parseFloat(xs[i]);
      const y = parseFloat(ys[i] || '0');
      const z = parseFloat(zs[i] || '0');
      if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
        controlPoints.push(new THREE.Vector3(x, y, z));
      }
    }

    if (controlPoints.length < 2) {
      return { object: null, next };
    }

    // Simple linear approximation for splines
    const flag = getInteger(data, 70, 0, 0);
    const closed = (flag & 1) === 1;
    const color = this._resolveColor(data, state);
    const line = this._createLine(controlPoints, closed, color);
    this._applyLayerToObject(line, data, state);
    return { object: line, next };
  }

  _parsePoint(pairs, index, state) {
    const { data, next } = this._collectEntityData(pairs, index);
    const point = new THREE.Vector3(
      getNumber(data, 10, 0, NaN),
      getNumber(data, 20, 0, NaN),
      getNumber(data, 30, 0, 0)
    );
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || !Number.isFinite(point.z)) {
      return { object: null, next };
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positionsFromVectors([point]), 3));
    geometry.computeBoundingBox();
    const color = this._resolveColor(data, state);
    const key = createMaterialKey(color, 'points');
    let material = this._materialCache.get(key);
    if (!material) {
      material = new THREE.PointsMaterial({ size: 1.5, color });
      this._materialCache.set(key, material);
    }
    const points = new THREE.Points(geometry, material);
    this._applyLayerToObject(points, data, state);
    return { object: points, next };
  }

  _parse3dFace(pairs, index, state) {
    const { data, next } = this._collectEntityData(pairs, index);
    const v1 = new THREE.Vector3(
      getNumber(data, 10, 0, NaN),
      getNumber(data, 20, 0, NaN),
      getNumber(data, 30, 0, NaN)
    );
    const v2 = new THREE.Vector3(
      getNumber(data, 11, 0, NaN),
      getNumber(data, 21, 0, NaN),
      getNumber(data, 31, 0, NaN)
    );
    const v3 = new THREE.Vector3(
      getNumber(data, 12, 0, NaN),
      getNumber(data, 22, 0, NaN),
      getNumber(data, 32, 0, NaN)
    );
    const v4 = new THREE.Vector3(
      getNumber(data, 13, 0, NaN),
      getNumber(data, 23, 0, NaN),
      getNumber(data, 33, 0, NaN)
    );
    const vertices = [v1, v2, v3, v4].filter((v) => Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z));
    if (vertices.length < 3) {
      return { object: null, next };
    }
    const color = this._resolveColor(data, state);
    const geometry = new THREE.BufferGeometry();
    const triangles = [];
    triangles.push(v1, v2, v3);
    if (!v4.equals(v3) && !v4.equals(v2)) {
      triangles.push(v1, v3, v4);
    }
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positionsFromVectors(triangles), 3));
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    const key = createMaterialKey(color, 'mesh');
    let material = this._materialCache.get(key);
    if (!material) {
      material = new THREE.MeshStandardMaterial({ color, metalness: 0.05, roughness: 0.65, side: THREE.DoubleSide });
      this._materialCache.set(key, material);
    }
    const mesh = new THREE.Mesh(geometry, material);
    this._applyLayerToObject(mesh, data, state);
    return { object: mesh, next };
  }

  _parseInsert(pairs, index, state) {
    const { data, next } = this._collectEntityData(pairs, index);
    const blockName = getString(data, 2, 0, null);
    if (!blockName || !state.blocks.has(blockName)) {
      return { object: null, next };
    }

    const block = state.blocks.get(blockName);
    const instance = block.clone();
    
    const x = getNumber(data, 10, 0, 0);
    const y = getNumber(data, 20, 0, 0);
    const z = getNumber(data, 30, 0, 0);
    instance.position.set(x, y, z);

    const scaleX = getNumber(data, 41, 0, 1);
    const scaleY = getNumber(data, 42, 0, 1);
    const scaleZ = getNumber(data, 43, 0, 1);
    instance.scale.set(scaleX, scaleY, scaleZ);

    const rotation = getNumber(data, 50, 0, 0);
    instance.rotation.z = THREE.MathUtils.degToRad(rotation);

    this._applyLayerToObject(instance, data, state);
    return { object: instance, next };
  }

  _parseText(pairs, index, state) {
    const { data, next } = this._collectEntityData(pairs, index);
    const text = getString(data, 1, 0, '');
    const x = getNumber(data, 10, 0, 0);
    const y = getNumber(data, 20, 0, 0);
    const z = getNumber(data, 30, 0, 0);
    const height = getNumber(data, 40, 0, 1);

    // Create a small marker for text position
    const geometry = new THREE.BufferGeometry();
    const position = new THREE.Vector3(x, y, z);
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positionsFromVectors([position]), 3));
    geometry.computeBoundingBox();
    
    const color = this._resolveColor(data, state);
    const key = createMaterialKey(color, 'points');
    let material = this._materialCache.get(key);
    if (!material) {
      material = new THREE.PointsMaterial({ size: 2.5, color });
      this._materialCache.set(key, material);
    }
    const points = new THREE.Points(geometry, material);
    points.userData = { type: 'TEXT', content: text, height };
    this._applyLayerToObject(points, data, state);
    return { object: points, next };
  }

  _parseDimension(pairs, index, state) {
    const { data, next } = this._collectEntityData(pairs, index);
    
    // Get dimension line points
    const x13 = getNumber(data, 13, 0, NaN);
    const y13 = getNumber(data, 23, 0, NaN);
    const z13 = getNumber(data, 33, 0, 0);
    const x14 = getNumber(data, 14, 0, NaN);
    const y14 = getNumber(data, 24, 0, NaN);
    const z14 = getNumber(data, 34, 0, 0);

    if (!Number.isFinite(x13) || !Number.isFinite(y13) || !Number.isFinite(x14) || !Number.isFinite(y14)) {
      return { object: null, next };
    }

    const start = new THREE.Vector3(x13, y13, z13);
    const end = new THREE.Vector3(x14, y14, z14);
    
    const color = this._resolveColor(data, state);
    const line = this._createLine([start, end], false, color);
    line.userData = { type: 'DIMENSION' };
    this._applyLayerToObject(line, data, state);
    return { object: line, next };
  }

  _collectEntityData(pairs, index) {
    const data = new Map();
    let i = index;
    while (i < pairs.length) {
      const pair = pairs[i];
      if (pair.code === 0) break;
      if (!data.has(pair.code)) {
        data.set(pair.code, []);
      }
      data.get(pair.code).push(pair.value);
      i += 1;
    }
    return { data, next: i };
  }

  _createLine(points, closed, color) {
    if (closed && points.length > 1 && !points[0].equals(points[points.length - 1])) {
      points.push(points[0].clone());
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positionsFromVectors(points), 3));
    geometry.computeBoundingBox();
    const key = createMaterialKey(color, 'line');
    let material = this._materialCache.get(key);
    if (!material) {
      material = new THREE.LineBasicMaterial({ color, linewidth: this.options.defaultLineWidth });
      this._materialCache.set(key, material);
    }
    const line = closed ? new THREE.LineLoop(geometry, material) : new THREE.Line(geometry, material);
    return line;
  }

  _bulgeToArc(start, end, bulge) {
    const chord = new THREE.Vector2(end.x - start.x, end.y - start.y);
    const chordLength = chord.length();
    if (chordLength === 0) return [end.clone()];
    
    const sagitta = (bulge * chordLength) / 2;
    const radius = ((chordLength / 2) ** 2 + sagitta ** 2) / (2 * Math.abs(sagitta));
    const centerOffset = Math.sqrt(Math.max(radius ** 2 - (chordLength / 2) ** 2, 0));
    const chordMid = new THREE.Vector2((start.x + end.x) / 2, (start.y + end.y) / 2);
    const perp = new THREE.Vector2(-chord.y, chord.x).normalize();
    const center = chordMid.clone().addScaledVector(perp, sagitta >= 0 ? centerOffset : -centerOffset);
    const startAngle = Math.atan2(start.y - center.y, start.x - center.x);
    let endAngle = Math.atan2(end.y - center.y, end.x - center.x);
    let sweep = endAngle - startAngle;
    if (bulge > 0 && sweep < 0) {
      sweep += Math.PI * 2;
    } else if (bulge < 0 && sweep > 0) {
      sweep -= Math.PI * 2;
    }
    const segmentAngle = THREE.MathUtils.degToRad(this.options.arcSegmentAngle);
    const steps = Math.max(4, Math.ceil(Math.abs(sweep) / segmentAngle));
    const points = [];
    for (let step = 1; step <= steps; step += 1) {
      const angle = startAngle + (sweep * step) / steps;
      const x = center.x + radius * Math.cos(angle);
      const y = center.y + radius * Math.sin(angle);
      points.push(new THREE.Vector3(x, y, start.z));
    }
    return points;
  }

  _resolveColor(data, state) {
    const trueColor = getInteger(data, 420, 0, null);
    if (trueColor != null) return trueColor;
    
    const aci = getInteger(data, 62, 0, null);
    if (aci != null) {
      const mapped = this._aciToHex(aci);
      if (mapped != null) return mapped;
    }
    
    const layer = getString(data, 8, 0, null);
    if (layer && state.layers.has(layer)) {
      return state.layers.get(layer);
    }
    
    return this.options.defaultColor;
  }

  _applyLayerToObject(object, data, state) {
    const layerName = getString(data, 8, 0, null);
    if (layerName) {
      object.userData.layer = layerName;
    }
  }

  _aciToHex(aci) {
    if (!Number.isInteger(aci)) return null;
    if (aci === 0 || aci === 256) return null;
    if (ACI_COLOR_MAP[aci]) return ACI_COLOR_MAP[aci];
    
    // Handle grayscale colors (250-255)
    if (aci >= 250 && aci <= 255) {
      const gray = Math.round(((aci - 250) / 5) * 255);
      return (gray << 16) | (gray << 8) | gray;
    }
    
    // Handle full ACI color table (10-249)
    if (aci >= 10 && aci <= 249) {
      return this._computeAciColor(aci);
    }
    
    return null;
  }

  _computeAciColor(aci) {
    // Simplified ACI color computation
    // Full implementation would use the complete AutoCAD color table
    const row = Math.floor((aci - 10) / 10);
    const col = (aci - 10) % 10;
    
    const hue = (col / 10) * 360;
    const sat = row < 2 ? 0.5 : 1.0;
    const val = 1.0 - (row / 24) * 0.5;
    
    // HSV to RGB conversion
    const c = val * sat;
    const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
    const m = val - c;
    
    let r = 0, g = 0, b = 0;
    if (hue < 60) { r = c; g = x; b = 0; }
    else if (hue < 120) { r = x; g = c; b = 0; }
    else if (hue < 180) { r = 0; g = c; b = x; }
    else if (hue < 240) { r = 0; g = x; b = c; }
    else if (hue < 300) { r = x; g = 0; b = c; }
    else { r = c; g = 0; b = x; }
    
    const rInt = Math.round((r + m) * 255);
    const gInt = Math.round((g + m) * 255);
    const bInt = Math.round((b + m) * 255);
    
    return (rInt << 16) | (gInt << 8) | bInt;
  }

  getMetadata() {
    return this.metadata;
  }
}

export default DXFLoader;

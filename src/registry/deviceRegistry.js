// Device registry: which devices may send data, how their payloads are decoded,
// and how each channel's raw values become engineering units.

const crypto = require('crypto');
const { badRequest, notFound, conflict, unauthorized, forbidden } = require('../errors');
const { BINARY_TYPES } = require('../ingestion/decoders');

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const FORMATS = ['json', 'csv', 'binary'];
const STATUSES = ['active', 'disabled'];

const hashKey = key => crypto.createHash('sha256').update(key).digest('hex');

function newApiKey() {
  const key = `sk_dev_${crypto.randomBytes(24).toString('base64url')}`;
  return { key, hash: hashKey(key), hint: `...${key.slice(-4)}` };
}

function checkId(value, what) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    throw badRequest(`${what} must be 1-64 characters: letters, digits, _ . : - (starting with a letter or digit)`);
  }
}

const optNumber = (v, what) => {
  if (v === undefined || v === null) return v;
  if (typeof v !== 'number' || !Number.isFinite(v)) throw badRequest(`${what} must be a number`);
  return v;
};

function validateChannel(c) {
  if (!c || typeof c !== 'object') throw badRequest('Channel must be an object');
  checkId(c.channel, 'channel');
  if (c.unit !== undefined && typeof c.unit !== 'string') throw badRequest('unit must be a string');
  optNumber(c.scale, 'scale'); optNumber(c.offset, 'offset');
  optNumber(c.minValid, 'minValid'); optNumber(c.maxValid, 'maxValid');
  if (c.scale === 0) throw badRequest('scale cannot be 0');
  if (c.minValid != null && c.maxValid != null && c.minValid > c.maxValid) throw badRequest('minValid must be <= maxValid');
  return {
    channel: c.channel, name: c.name, unit: c.unit ?? '', scale: c.scale ?? 1, offset: c.offset ?? 0,
    minValid: c.minValid ?? null, maxValid: c.maxValid ?? null
  };
}

// { timestamp?: { type }, fields: [{ channel, type }], littleEndian? }
function validateLayout(layout) {
  if (layout === null || layout === undefined) return null;
  if (!layout || !Array.isArray(layout.fields) || !layout.fields.length) {
    throw badRequest('binaryLayout.fields must be a non-empty array of { channel, type }');
  }
  const types = Object.keys(BINARY_TYPES).join(', ');
  layout.fields.forEach(f => {
    checkId(f.channel, 'binaryLayout field channel');
    if (!BINARY_TYPES[f.type]) throw badRequest(`Unknown binary type "${f.type}". Use one of: ${types}`);
  });
  if (layout.timestamp) {
    if (!['uint32be', 'uint32le'].includes(layout.timestamp.type)) {
      throw badRequest('binaryLayout.timestamp.type must be uint32be or uint32le (epoch seconds)');
    }
  }
  return { timestamp: layout.timestamp ? { type: layout.timestamp.type } : null, fields: layout.fields.map(f => ({ channel: f.channel, type: f.type })) };
}

function createDeviceRegistry({ devices }) {
  function mustGet(id) {
    const device = devices.get(id);
    if (!device) throw notFound(`Device "${id}" not found`);
    return device;
  }

  function withChannels(device) {
    return device && { ...device, channels: devices.channels(device.id) };
  }

  function normaliseCommon(input, isCreate) {
    const out = {};
    if (isCreate || input.name !== undefined) {
      if (typeof input.name !== 'string' || !input.name.trim()) throw badRequest('name is required');
      out.name = input.name.trim();
    }
    for (const k of ['type', 'location']) {
      if (input[k] !== undefined && input[k] !== null && typeof input[k] !== 'string') throw badRequest(`${k} must be a string`);
      out[k] = input[k];
    }
    if (input.status !== undefined) {
      if (!STATUSES.includes(input.status)) throw badRequest(`status must be one of: ${STATUSES.join(', ')}`);
      out.status = input.status;
    }
    if (input.payloadFormat !== undefined) {
      if (!FORMATS.includes(input.payloadFormat)) throw badRequest(`payloadFormat must be one of: ${FORMATS.join(', ')}`);
      out.payloadFormat = input.payloadFormat;
    }
    if (input.binaryLayout !== undefined) out.binaryLayout = validateLayout(input.binaryLayout);
    if (input.autoChannels !== undefined) out.autoChannels = Boolean(input.autoChannels);
    if (input.metadata !== undefined) {
      if (input.metadata !== null && (typeof input.metadata !== 'object' || Array.isArray(input.metadata))) {
        throw badRequest('metadata must be an object');
      }
      out.metadata = input.metadata;
    }
    return out;
  }

  return {
    /** @returns {{ device, apiKey }}  apiKey is returned only here and on rotateKey — it is stored hashed. */
    create(input = {}) {
      checkId(input.id, 'id');
      if (devices.get(input.id)) throw conflict(`Device "${input.id}" already exists`);
      const fields = normaliseCommon(input, true);
      if (fields.payloadFormat === 'binary' && !fields.binaryLayout) {
        throw badRequest('binaryLayout is required when payloadFormat is "binary"');
      }
      const channels = (input.channels || []).map(validateChannel);
      const key = newApiKey();

      devices.insert({ id: input.id, ...fields, apiKeyHash: key.hash, apiKeyHint: key.hint });
      channels.forEach(c => devices.upsertChannel({ deviceId: input.id, ...c }));
      // Channels named in a binary layout must exist so their scale/unit can be applied
      (fields.binaryLayout?.fields || []).forEach(f => {
        if (!devices.channel(input.id, f.channel)) devices.upsertChannel({ deviceId: input.id, channel: f.channel });
      });
      return { device: withChannels(devices.get(input.id)), apiKey: key.key };
    },

    get: id => withChannels(mustGet(id)),
    list: () => devices.list(),

    update(id, input = {}) {
      const current = mustGet(id);
      if (input.id !== undefined && input.id !== id) throw badRequest('Device id cannot be changed');
      const fields = normaliseCommon(input, false);
      const format = fields.payloadFormat ?? current.payloadFormat;
      const layout = fields.binaryLayout !== undefined ? fields.binaryLayout : current.binaryLayout;
      if (format === 'binary' && !layout) throw badRequest('binaryLayout is required when payloadFormat is "binary"');
      devices.update(id, fields);
      (fields.binaryLayout?.fields || []).forEach(f => {
        if (!devices.channel(id, f.channel)) devices.upsertChannel({ deviceId: id, channel: f.channel });
      });
      return withChannels(devices.get(id));
    },

    remove(id) {
      mustGet(id);
      devices.remove(id);
    },

    rotateKey(id) {
      mustGet(id);
      const key = newApiKey();
      devices.update(id, { apiKeyHash: key.hash, apiKeyHint: key.hint });
      return { device: devices.get(id), apiKey: key.key };
    },

    setChannel(deviceId, input) {
      mustGet(deviceId);
      return devices.upsertChannel({ deviceId, ...validateChannel(input) });
    },

    removeChannel(deviceId, channel) {
      mustGet(deviceId);
      const layout = devices.get(deviceId).binaryLayout;
      if (layout?.fields.some(f => f.channel === channel)) {
        throw conflict(`Channel "${channel}" is used by the device's binaryLayout; update the layout first`);
      }
      if (!devices.removeChannel(deviceId, channel)) throw notFound(`Channel "${channel}" not found`);
    },

    /** Resolves an API key to an active device, or throws 401/403. */
    authenticate(apiKey) {
      if (typeof apiKey !== 'string' || !apiKey.startsWith('sk_dev_')) throw unauthorized();
      const device = devices.getByKeyHash(hashKey(apiKey));
      if (!device) throw unauthorized();
      if (device.status !== 'active') throw forbidden(`Device "${device.id}" is disabled`);
      return device;
    },

    channels: deviceId => devices.channels(deviceId)
  };
}

module.exports = { createDeviceRegistry, hashKey };

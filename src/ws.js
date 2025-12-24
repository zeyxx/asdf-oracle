/**
 * Native WebSocket Server
 *
 * RFC 6455 implementation using Node.js 22 native APIs.
 * Zero dependencies - handles upgrade, framing, ping/pong.
 */

import { createHash } from 'crypto';
import { validateApiKey } from './db.js';
import { log } from './utils.js';

// WebSocket magic GUID (RFC 6455)
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

// Frame opcodes
const OPCODE = {
  CONTINUATION: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xA,
};

// Configuration
const HEARTBEAT_INTERVAL = 30000; // 30s ping interval
const HEARTBEAT_TIMEOUT = 60000;  // 60s without pong = disconnect
const MAX_CONNECTIONS_PER_KEY = 5;

// Client tracking
const clients = new Map(); // socket -> { key, tier, connectedAt, lastPong, buffer }
const keyConnections = new Map(); // apiKey -> Set<socket>

let heartbeatTimer = null;

/**
 * Handle HTTP upgrade to WebSocket
 * Route: /ws?key=API_KEY
 */
export async function handleUpgrade(req, socket, head) {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // Only handle /ws path
  if (url.pathname !== '/ws') {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }

  // Extract and validate API key
  const apiKey = url.searchParams.get('key');
  if (!apiKey) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\nAPI key required: /ws?key=YOUR_KEY');
    socket.destroy();
    return;
  }

  const keyMeta = await validateApiKey(apiKey);
  if (!keyMeta) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\nInvalid API key');
    socket.destroy();
    return;
  }

  // Check connection limit per key
  const existingConnections = keyConnections.get(apiKey) || new Set();
  if (existingConnections.size >= MAX_CONNECTIONS_PER_KEY) {
    socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\nMax connections per key reached');
    socket.destroy();
    return;
  }

  // Validate WebSocket headers
  const wsKey = req.headers['sec-websocket-key'];
  const upgrade = req.headers['upgrade'];

  if (!wsKey || upgrade?.toLowerCase() !== 'websocket') {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\nInvalid WebSocket request');
    socket.destroy();
    return;
  }

  // Generate accept key (SHA-1 hash of key + GUID, base64 encoded)
  const acceptKey = createHash('sha1')
    .update(wsKey + WS_GUID)
    .digest('base64');

  // Send upgrade response
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${acceptKey}`,
    '',
    '',
  ].join('\r\n'));

  // Track client
  const clientMeta = {
    key: apiKey,
    tier: keyMeta.tier,
    name: keyMeta.name,
    connectedAt: Date.now(),
    lastPong: Date.now(),
    buffer: Buffer.alloc(0),
  };

  clients.set(socket, clientMeta);

  // Track per-key connections
  if (!keyConnections.has(apiKey)) {
    keyConnections.set(apiKey, new Set());
  }
  keyConnections.get(apiKey).add(socket);

  log('INFO', `[WS] Client connected: ${keyMeta.name || 'unnamed'} (${keyMeta.tier})`);

  // Send welcome message
  send(socket, 'connected', {
    message: 'K-Metric Oracle WebSocket',
    tier: keyMeta.tier,
    events: ['k', 'holder:new', 'holder:exit', 'tx', 'status'],
  });

  // Create bound handlers for cleanup
  const onData = (data) => handleData(socket, data);
  const onClose = () => {
    cleanup();
    handleClose(socket);
  };
  const onError = (err) => {
    log('ERROR', `[WS] Socket error: ${err.message}`);
    cleanup();
    handleClose(socket);
  };

  // Cleanup function to remove listeners
  const cleanup = () => {
    socket.removeListener('data', onData);
    socket.removeListener('close', onClose);
    socket.removeListener('error', onError);
  };

  // Handle incoming data
  socket.on('data', onData);

  // Handle disconnect
  socket.on('close', onClose);
  socket.on('error', onError);

  // Start heartbeat if not running
  startHeartbeat();
}

/**
 * Handle incoming WebSocket data
 */
function handleData(socket, data) {
  const client = clients.get(socket);
  if (!client) return;

  // Append to buffer for fragmented frames
  client.buffer = Buffer.concat([client.buffer, data]);

  // Process complete frames
  while (client.buffer.length >= 2) {
    const frame = decodeFrame(client.buffer);
    if (!frame) break; // Incomplete frame

    // Remove processed bytes from buffer
    client.buffer = client.buffer.slice(frame.totalLength);

    // Handle by opcode
    switch (frame.opcode) {
      case OPCODE.TEXT:
        handleMessage(socket, frame.payload.toString('utf8'));
        break;
      case OPCODE.PING:
        sendPong(socket, frame.payload);
        break;
      case OPCODE.PONG:
        client.lastPong = Date.now();
        break;
      case OPCODE.CLOSE:
        socket.end();
        break;
    }
  }
}

/**
 * Handle text message from client
 */
function handleMessage(socket, message) {
  try {
    const data = JSON.parse(message);

    // Handle subscription management (future feature)
    if (data.action === 'ping') {
      send(socket, 'pong', { ts: Date.now() });
    }
  } catch (e) {
    // Ignore invalid JSON
  }
}

/**
 * Handle client disconnect
 */
function handleClose(socket) {
  const client = clients.get(socket);
  if (!client) return;

  // Remove from tracking
  clients.delete(socket);

  // Remove from per-key tracking
  const keyConns = keyConnections.get(client.key);
  if (keyConns) {
    keyConns.delete(socket);
    if (keyConns.size === 0) {
      keyConnections.delete(client.key);
    }
  }

  log('INFO', `[WS] Client disconnected: ${client.name || 'unnamed'}`);

  // Stop heartbeat if no clients
  if (clients.size === 0 && heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

/**
 * Decode WebSocket frame (RFC 6455)
 */
function decodeFrame(buffer) {
  if (buffer.length < 2) return null;

  const firstByte = buffer[0];
  const secondByte = buffer[1];

  const fin = (firstByte & 0x80) !== 0;
  const opcode = firstByte & 0x0F;
  const masked = (secondByte & 0x80) !== 0;
  let payloadLength = secondByte & 0x7F;

  let offset = 2;

  // Extended payload length
  if (payloadLength === 126) {
    if (buffer.length < 4) return null;
    payloadLength = buffer.readUInt16BE(2);
    offset = 4;
  } else if (payloadLength === 127) {
    if (buffer.length < 10) return null;
    // For simplicity, assume payload fits in 32 bits
    payloadLength = buffer.readUInt32BE(6);
    offset = 10;
  }

  // Masking key (client frames are always masked)
  let maskingKey = null;
  if (masked) {
    if (buffer.length < offset + 4) return null;
    maskingKey = buffer.slice(offset, offset + 4);
    offset += 4;
  }

  // Check if we have full payload
  if (buffer.length < offset + payloadLength) return null;

  // Extract and unmask payload
  let payload = buffer.slice(offset, offset + payloadLength);
  if (masked && maskingKey) {
    payload = Buffer.from(payload); // Copy to avoid modifying original
    for (let i = 0; i < payload.length; i++) {
      payload[i] ^= maskingKey[i % 4];
    }
  }

  return {
    fin,
    opcode,
    payload,
    totalLength: offset + payloadLength,
  };
}

/**
 * Encode WebSocket frame (RFC 6455)
 * Server frames are NOT masked
 */
function encodeFrame(payload, opcode = OPCODE.TEXT) {
  const payloadBuffer = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
  const payloadLength = payloadBuffer.length;

  let header;
  if (payloadLength < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | opcode; // FIN + opcode
    header[1] = payloadLength;
  } else if (payloadLength < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(payloadLength, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payloadLength), 2);
  }

  return Buffer.concat([header, payloadBuffer]);
}

/**
 * Send message to a single client
 */
export function send(socket, event, data) {
  if (!clients.has(socket)) return;

  try {
    const message = JSON.stringify({ event, data, ts: Date.now() });
    const frame = encodeFrame(message);
    socket.write(frame);
  } catch (e) {
    log('ERROR', `[WS] Send error: ${e.message}`);
  }
}

/**
 * Send pong response
 */
function sendPong(socket, payload) {
  try {
    const frame = encodeFrame(payload, OPCODE.PONG);
    socket.write(frame);
  } catch (e) {
    // Ignore
  }
}

/**
 * Send ping to client
 */
function sendPing(socket) {
  try {
    const frame = encodeFrame('', OPCODE.PING);
    socket.write(frame);
  } catch (e) {
    // Ignore
  }
}

/**
 * Broadcast message to all connected clients
 */
export function broadcast(event, data) {
  if (clients.size === 0) return;

  const message = JSON.stringify({ event, data, ts: Date.now() });
  const frame = encodeFrame(message);

  let sent = 0;
  for (const [socket] of clients) {
    try {
      socket.write(frame);
      sent++;
    } catch (e) {
      // Client likely disconnected
    }
  }

  if (sent > 0) {
    log('INFO', `[WS] Broadcast '${event}' to ${sent} clients`);
  }
}

/**
 * Broadcast to specific tier or higher
 */
export function broadcastToTier(event, data, minTier) {
  const tierOrder = ['public', 'free', 'standard', 'premium', 'internal'];
  const minIndex = tierOrder.indexOf(minTier);

  const message = JSON.stringify({ event, data, ts: Date.now() });
  const frame = encodeFrame(message);

  for (const [socket, meta] of clients) {
    const clientIndex = tierOrder.indexOf(meta.tier);
    if (clientIndex >= minIndex) {
      try {
        socket.write(frame);
      } catch (e) {
        // Ignore
      }
    }
  }
}

/**
 * Start heartbeat timer
 */
function startHeartbeat() {
  if (heartbeatTimer) return;

  heartbeatTimer = setInterval(() => {
    const now = Date.now();

    for (const [socket, meta] of clients) {
      // Check for timeout
      if (now - meta.lastPong > HEARTBEAT_TIMEOUT) {
        log('WARN', `[WS] Client timeout: ${meta.name || 'unnamed'}`);
        // RFC 6455: Send close frame before destroying
        try {
          const frame = encodeFrame('', OPCODE.CLOSE);
          socket.write(frame);
          // Give client 100ms to receive close frame
          setTimeout(() => {
            socket.destroy();
            handleClose(socket);
          }, 100);
        } catch {
          socket.destroy();
          handleClose(socket);
        }
        continue;
      }

      // Send ping
      sendPing(socket);
    }
  }, HEARTBEAT_INTERVAL);
}

/**
 * Get WebSocket server stats
 */
export function getStats() {
  const tierCounts = {};
  for (const [, meta] of clients) {
    tierCounts[meta.tier] = (tierCounts[meta.tier] || 0) + 1;
  }

  return {
    total_connections: clients.size,
    unique_keys: keyConnections.size,
    by_tier: tierCounts,
  };
}

/**
 * Close all connections (for shutdown)
 */
export function closeAll() {
  for (const [socket] of clients) {
    try {
      // Send close frame
      const frame = encodeFrame('', OPCODE.CLOSE);
      socket.write(frame);
      socket.end();
    } catch (e) {
      socket.destroy();
    }
  }
  clients.clear();
  keyConnections.clear();

  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

export default {
  handleUpgrade,
  broadcast,
  broadcastToTier,
  send,
  getStats,
  closeAll,
};

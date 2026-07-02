#!/usr/bin/env node
'use strict';

/**
 * Local WebSocket proxy for Postman testing.
 *
 * Postman connects to ws://localhost:8787 (no auth headers).
 * This proxy signs a fresh Kalshi handshake on each connection.
 *
 * Usage:
 *   npm run kalshi:ws-proxy
 *   Postman URL: ws://localhost:8787
 */

const path = require('path');
const http = require('http');
const WebSocket = require('ws');

require('dotenv').config({ path: path.join(__dirname, '..', 'backend', '.env') });

const { buildWsAuthHeaders } = require('../backend/lib/kalshi-client');
const { KALSHI } = require('../backend/config/providers');

const PORT = Number(process.env.KALSHI_WS_PROXY_PORT || 8787);

function relay(client, upstream) {
  client.on('message', (data) => {
    if (upstream.readyState === WebSocket.OPEN) {
      upstream.send(data);
    }
  });

  upstream.on('message', (data) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  });

  client.on('close', () => upstream.close());
  upstream.on('close', () => client.close());

  client.on('error', (err) => {
    console.error('[kalshi-ws-proxy] client error:', err.message);
    upstream.close();
  });

  upstream.on('error', (err) => {
    console.error('[kalshi-ws-proxy] kalshi error:', err.message);
    client.close();
  });
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end(
    [
      'Kalshi WebSocket proxy is running.',
      '',
      'Postman WebSocket URL:',
      `  ws://localhost:${PORT}`,
      '',
      'No Kalshi auth headers needed in Postman.',
      'This proxy signs a fresh handshake on each connect.',
      '',
      `Upstream: ${KALSHI.wsUrl}`,
    ].join('\n')
  );
});

const wss = new WebSocket.Server({ server });

wss.on('connection', (clientWs, req) => {
  const headers = buildWsAuthHeaders();
  console.log(
    `[kalshi-ws-proxy] client connected from ${req.socket.remoteAddress} — opening Kalshi WS`
  );

  const upstream = new WebSocket(KALSHI.wsUrl, { headers });
  console.log(`[kalshi-ws-proxy] connecting to API: ${KALSHI.wsUrl}`);

  upstream.on('open', () => {
    console.log(`[kalshi-ws-proxy] WebSocket connected — API: ${KALSHI.wsUrl}`);
    relay(clientWs, upstream);
  });

  upstream.on('unexpected-response', (_req, res) => {
    let body = '';
    res.on('data', (chunk) => {
      body += chunk;
    });
    res.on('end', () => {
      console.error(
        `[kalshi-ws-proxy] WebSocket failed — API: ${KALSHI.wsUrl} status=${res.statusCode} ${body}`
      );
      clientWs.close(1011, `Kalshi auth failed: ${res.statusCode}`);
    });
  });

  upstream.on('error', (err) => {
    console.error(`[kalshi-ws-proxy] WebSocket error — API: ${KALSHI.wsUrl}:`, err.message);
    clientWs.close(1011, err.message);
  });
});

server.listen(PORT, () => {
  console.log(`[kalshi-ws-proxy] listening on ws://localhost:${PORT}`);
  console.log('[kalshi-ws-proxy] Postman: New WebSocket → ws://localhost:8787');
  console.log(`[kalshi-ws-proxy] upstream: ${KALSHI.wsUrl}`);
});

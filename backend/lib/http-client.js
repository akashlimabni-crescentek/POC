'use strict';

const { HTTP_TIMEOUT_MS, HTTP_MAX_RETRIES } = require('../config/intervals');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitter(ms) {
  return ms + Math.floor(Math.random() * ms * 0.2);
}

function parseRetryAfterMs(response) {
  const header = response.headers.get('retry-after');
  if (!header) return null;
  const seconds = Number(header);
  if (!Number.isNaN(seconds)) return seconds * 1000;
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return null;
}

/**
 * fetch with AbortController timeout, retries, and 429 backoff + jitter.
 */
async function fetchWithRetry(url, options = {}) {
  const {
    timeoutMs = HTTP_TIMEOUT_MS,
    maxRetries = HTTP_MAX_RETRIES,
    ...fetchOptions
  } = options;

  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        ...fetchOptions,
        signal: controller.signal,
      });

      if (response.status === 429 && attempt < maxRetries) {
        const retryAfter = parseRetryAfterMs(response) ?? (attempt + 1) * 2000;
        console.warn(
          `[http-client] 429 ${url} — retrying in ${retryAfter}ms (attempt ${attempt + 1})`
        );
        await sleep(jitter(retryAfter));
        continue;
      }

      if (response.status >= 500 && attempt < maxRetries) {
        const backoff = jitter((attempt + 1) * 500);
        console.warn(
          `[http-client] ${response.status} ${url} — retrying in ${backoff}ms (attempt ${attempt + 1})`
        );
        await sleep(backoff);
        continue;
      }

      return response;
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries) {
        const backoff = jitter((attempt + 1) * 500);
        console.warn(
          `[http-client] ${url} failed: ${err.message} — retrying in ${backoff}ms`
        );
        await sleep(backoff);
        continue;
      }
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError ?? new Error(`[http-client] ${url} failed after ${maxRetries + 1} attempts`);
}

module.exports = { fetchWithRetry, sleep };

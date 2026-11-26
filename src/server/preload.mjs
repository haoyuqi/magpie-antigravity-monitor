/*
 * Copyright (C) 2026 haoyuqi and contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * Generates `/preload.js` served to the dashboard UI.
 *
 * Reads the per-process token from `<meta name="usage-monitor-token">`,
 * provides `window.sidecar.fetch()` using relative `./` paths for `magpie web`
 * subpath proxy compatibility, and applies theme/tokens passed from `page/boot.js`.
 */
export function renderPreloadScript() {
  return `(() => {
  const TOKEN_HEADER = 'X-Usage-Monitor-Token';

  function readToken() {
    const meta = document.querySelector('meta[name="usage-monitor-token"]');
    return meta ? String(meta.getAttribute('content') || '').trim() : '';
  }

  function toRelativePath(rawPath) {
    const clean = String(rawPath || '').trim();
    if (!clean) return './';
    if (clean.startsWith('./') || clean.startsWith('../')) return clean;
    return './' + clean.replace(/^\\/+/, '');
  }

  function decodeBase64Utf8(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
      bytes[i] = bin.charCodeAt(i);
    }
    return new TextDecoder().decode(bytes);
  }

  function applyMagpieBootParams() {
    const boot = { theme: '', lang: '', tokens: {} };
    try {
      const params = new URLSearchParams(window.location.search || '');
      const theme = String(params.get('theme') || '').trim().toLowerCase();
      if (theme === 'dark' || theme === 'light') {
        boot.theme = theme;
        document.documentElement.dataset.theme = theme;
        document.documentElement.style.colorScheme = theme;
      }
      const lang = String(params.get('lang') || '').trim();
      if (lang) {
        boot.lang = lang;
      }
      const rawTokens = String(params.get('tokens') || '').trim();
      if (rawTokens) {
        const parsed = JSON.parse(decodeBase64Utf8(rawTokens));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const rootStyle = document.documentElement.style;
          for (const [key, value] of Object.entries(parsed)) {
            if (!/^--[a-z0-9-]+$/i.test(key)) continue;
            const valStr = String(value ?? '').trim();
            if (!valStr || /[;{}]/.test(valStr)) continue;
            boot.tokens[key] = valStr;
            rootStyle.setProperty(key, valStr);
          }
        }
      }
    } catch {
      // Ignore malformed boot query params and keep default styles
    }
    window.__MAGPIE_MONITOR_BOOT__ = boot;
  }

  applyMagpieBootParams();

  window.sidecar = Object.freeze({
    fetch(path, init = {}) {
      const token = readToken();
      const headers = new Headers(init.headers || {});
      if (token) {
        headers.set(TOKEN_HEADER, token);
      }
      if (typeof init.body === 'string' && !headers.has('Content-Type')) {
        headers.set('Content-Type', 'application/json');
      }
      return window.fetch(toRelativePath(path), {
        ...init,
        headers,
      });
    },
  });
})();
`;
}

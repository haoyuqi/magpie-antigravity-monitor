/*
 * Sandboxed Magpie page launcher.
 *
 * Runs under `sandbox="allow-scripts"` and `connect-src 'none'`:
 * never calls fetch/XHR/WebSocket/localStorage/cookie, and navigates directly
 * to the proxied `magpie.service` URL or local `127.0.0.1:<port>` service.
 */
(async () => {
  const DEFAULT_PORT = 18787;
  let port = DEFAULT_PORT;
  let theme = '';
  let lang = '';
  let tokens = null;
  let service = '';

  try {
    const ready = await window.magpie?.ready;
    if (ready) {
      if (typeof ready.dark === 'boolean') theme = ready.dark ? 'dark' : 'light';
      if (typeof ready.lang === 'string' && ready.lang.trim()) lang = ready.lang.trim();
      if (ready.tokens && typeof ready.tokens === 'object') tokens = ready.tokens;
    }
  } catch {
    // Fall back to default theme if bridge is unavailable
  }

  try {
    const s = window.magpie?.service;
    if (typeof s === 'string' && /^https?:\/\//i.test(s)) {
      service = s;
    }
  } catch {
    // Older Magpie hosts do not expose magpie.service
  }

  try {
    const opts = await window.magpie?.options?.get?.();
    const optPort = Number(opts?.port);
    if (Number.isInteger(optPort) && optPort > 0 && optPort <= 65535) {
      port = optPort;
    }
  } catch {
    // Fall back to DEFAULT_PORT
  }

  const params = new URLSearchParams();
  if (theme) params.set('theme', theme);
  if (lang) params.set('lang', lang);

  const slimTokens = {};
  for (const [k, v] of Object.entries(tokens || {})) {
    const clean = String(v ?? '').trim();
    if (clean) slimTokens[k] = clean;
  }
  if (Object.keys(slimTokens).length > 0) {
    try {
      const bytes = new TextEncoder().encode(JSON.stringify(slimTokens));
      let bin = '';
      for (let i = 0; i < bytes.length; i++) {
        bin += String.fromCharCode(bytes[i]);
      }
      params.set('tokens', btoa(bin));
    } catch {
      // Proceed with theme only if token encoding fails
    }
  }

  function armTimeout(targetPort) {
    setTimeout(() => {
      const said = document.getElementById('said');
      if (!said) return;
      said.textContent = `Local monitor service is not running (127.0.0.1:${targetPort}).`;
      if (document.getElementById('boot-retry')) return;
      const btn = document.createElement('button');
      btn.id = 'boot-retry';
      btn.type = 'button';
      btn.textContent = 'Retry';
      btn.addEventListener('click', () => {
        location.reload();
      });
      said.parentNode.appendChild(btn);
    }, 5000);
  }

  const query = params.toString();
  if (service) {
    const sep = service.includes('?') ? '&' : '?';
    armTimeout(port);
    location.replace(query ? `${service}${sep}${query}` : service);
    return;
  }

  const target = query
    ? `http://127.0.0.1:${port}/?${query}`
    : `http://127.0.0.1:${port}/`;

  if (!isLoopbackHost(location.hostname)) {
    showRemoteInstructions(port, target);
    return;
  }

  armTimeout(port);
  location.replace(target);
})();

function isLoopbackHost(host) {
  const clean = String(host || '')
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  return (
    clean === '' ||
    clean === 'localhost' ||
    clean.endsWith('.localhost') ||
    clean === '::1' ||
    /^127\./.test(clean)
  );
}

function showRemoteInstructions(port, target) {
  const said = document.getElementById('said');
  if (!said) return;
  const host = String(location.hostname || '').replace(/^\[|\]$/g, '') || 'your-host';
  said.textContent = '';
  const appendParagraph = (text) => {
    const p = document.createElement('p');
    p.textContent = text;
    said.appendChild(p);
    return p;
  };
  appendParagraph(
    `The monitor service listens on 127.0.0.1:${port} on the Magpie host and is not directly reachable from this browser.`
  );
  appendParagraph('Open an SSH port forward on this machine, then click Continue:');
  const code = appendParagraph(`ssh -N -L ${port}:127.0.0.1:${port} <user>@${host}`);
  code.style.fontFamily = 'ui-monospace, Menlo, Consolas, monospace';
  code.style.userSelect = 'all';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = 'Continue';
  btn.addEventListener('click', () => {
    location.replace(target);
  });
  said.appendChild(btn);
}

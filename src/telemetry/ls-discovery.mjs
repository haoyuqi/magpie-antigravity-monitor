/* Ported from yuhuan-dev/antigravity-usage-monitor (GPL-3.0) with Magpie read-only import paths. */
/**
 * @fileoverview Auto-discovery for Antigravity Hub / Language Server local daemon files and processes.
 *
 * Compatible with Antigravity 2.0, Antigravity IDE, headless `agy` CLI, and `agy remote-control serve`:
 * 1. Prefer reading `~/.gemini/<product>/daemon/hub_*.json` (cross-platform, zero external command dependencies, millisecond lookup for `httpPort` + `csrfToken`);
 * 2. Fall back to enumerating the current user's `agy` / `antigravity-cli` / `language_server` processes;
 * 3. On minimal headless Linux environments, prefer resolving listening ports via `/proc/<pid>/fd` + `/proc/net/tcp{,6}` and `ss -H -lntp` without strictly depending on `lsof`;
 * 4. Verify via a live `GetUserStatus` handshake before writing `lsRuntimeEndpoint`.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DAEMON_DIRS, lsRuntimeEndpoint, setLsRuntimeEndpoint } from '../runtime/paths.mjs';

const LS_DISC_COOLDOWN_MS = 4000;

const lsDiscoveryState = {
  inFlight: null,
  lastAttemptMs: 0,
};

let lsDiscoveryOverride = null;

/**
 * Sets or clears discovery overrides (e.g. `daemonDirs`, `execCmdFn`, `isPidAliveFn`)
 * so tests can isolate `ensureLsEndpointDiscovered()` from host directories and processes.
 *
 * @param {object|null} override
 */
export function setLsDiscoveryOverride(override) {
  lsDiscoveryOverride = override && typeof override === 'object' ? { ...override } : null;
}

function defaultIsLsPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  if (typeof process?.kill !== 'function') return true;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

/**
 * Extracts the port number and CSRF token from an `agy` (`--hub` / `remote-control` / CLI) or `language_server` command-line string.
 *
 * @param {string} commandLine
 * @returns {{ hubPort: number|null, csrfToken: string, isHub: boolean, isLanguageServer: boolean }}
 */
export function parseLsArgsFromCommandLine(commandLine) {
  const cmd = String(commandLine || '').trim();
  if (!cmd) {
    return { hubPort: null, csrfToken: '', isHub: false, isLanguageServer: false };
  }
  const isAgyBinary = /(?:^|[\s/\\"'])(?:agy|antigravity-cli)(?:\.exe)?(?:["'\s]|$)/i.test(cmd);
  const isHub = isAgyBinary && /(?:--hub\b|\bremote-control\b|--csrf[-_]token\b)/i.test(cmd);
  const isLanguageServer = /language_server/i.test(cmd);

  let hubPort = null;
  const portMatch = cmd.match(
    /--(?:hub[-_]port|http[-_]port|https[-_]server[-_]port|server[-_]port)(?:=|\s+)["']?(\d{1,5})["']?(?=\s|$)/i
  );
  if (portMatch) {
    const num = Number(portMatch[1]);
    if (Number.isInteger(num) && num > 0 && num <= 65535) {
      hubPort = num;
    }
  }

  let csrfToken = '';
  const csrfMatch = cmd.match(/--csrf[-_]token(?:=|\s+)(?:"([^"]+)"|'([^']+)'|([^\s"']+))/i);
  if (csrfMatch) {
    csrfToken = String(csrfMatch[1] || csrfMatch[2] || csrfMatch[3] || '').trim();
  }

  return {
    hubPort,
    csrfToken,
    isHub,
    isLanguageServer,
  };
}

/**
 * Parses Linux `/proc/net/tcp` or `/proc/net/tcp6` content to extract local ports in `0A` (LISTEN) state for the given socket inode set.
 *
 * @param {string} tcpTableText
 * @param {Set<string>} socketInodes
 * @returns {number[]}
 */
export function parseLinuxProcNetTcpPorts(tcpTableText, socketInodes) {
  if (!tcpTableText || !(socketInodes instanceof Set) || socketInodes.size === 0) {
    return [];
  }
  const ports = new Set();
  for (const rawLine of String(tcpTableText).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || /^sl\b/i.test(line)) continue;
    const cols = line.split(/\s+/);
    if (cols.length < 10) continue;
    const localAddr = cols[1] || '';
    const stateHex = (cols[3] || '').toUpperCase();
    const inode = cols[9] || '';
    if (stateHex !== '0A' || !socketInodes.has(inode)) continue;
    const colonIdx = localAddr.lastIndexOf(':');
    if (colonIdx < 0) continue;
    const port = Number.parseInt(localAddr.slice(colonIdx + 1), 16);
    if (Number.isInteger(port) && port > 0 && port <= 65535) {
      ports.add(port);
    }
  }
  return Array.from(ports);
}

/**
 * Parses Linux `ss -H -lntp` output to extract listening ports belonging to the target `pid`.
 *
 * @param {string} ssOutput
 * @param {number} pid
 * @returns {number[]}
 */
export function parseSsListeningPorts(ssOutput, pid) {
  if (!ssOutput || !Number.isInteger(pid) || pid <= 0) return [];
  const pidTokenRe = new RegExp(`\\bpid=${pid}\\b`);
  const ports = new Set();
  for (const rawLine of String(ssOutput).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || !pidTokenRe.test(line)) continue;
    const cols = line.split(/\s+/);
    const localCol = cols[3] || '';
    const m = localCol.match(/:(\d{1,5})$/);
    if (m) {
      const p = Number(m[1]);
      if (Number.isInteger(p) && p > 0 && p <= 65535) ports.add(p);
    }
  }
  return Array.from(ports);
}

async function readLinuxProcListeningPorts(pid, customProcFs = null) {
  try {
    const fsMod = customProcFs || (await import('node:fs'));
    const readlinkFn = fsMod.readlinkSync || fsMod.default?.readlinkSync;
    const readdirFn = fsMod.readdirSync || fsMod.default?.readdirSync || readdirSync;
    const readFileFn = fsMod.readFileSync || fsMod.default?.readFileSync || readFileSync;
    const existsFn = fsMod.existsSync || fsMod.default?.existsSync || existsSync;
    if (typeof readlinkFn !== 'function') return [];

    const fdDir = `/proc/${pid}/fd`;
    if (!existsFn(fdDir)) return [];
    const socketInodes = new Set();
    for (const fdName of readdirFn(fdDir)) {
      try {
        const target = String(readlinkFn(`${fdDir}/${fdName}`) || '');
        const m = target.match(/^socket:\[(\d+)\]$/);
        if (m) socketInodes.add(m[1]);
      } catch {
        // Ignore transiently closed fd
      }
    }
    if (socketInodes.size === 0) return [];

    const ports = new Set();
    for (const netFile of [`/proc/${pid}/net/tcp`, `/proc/${pid}/net/tcp6`, '/proc/net/tcp', '/proc/net/tcp6']) {
      if (!existsFn(netFile)) continue;
      try {
        const raw = String(readFileFn(netFile, 'utf8') || '');
        for (const p of parseLinuxProcNetTcpPorts(raw, socketInodes)) {
          ports.add(p);
        }
      } catch {
        // Ignore unreadable proc network table
      }
    }
    return Array.from(ports);
  } catch {
    return [];
  }
}

function readHubDaemonCandidates(daemonDirs, preferredPids, isPidAliveFn) {
  const candidates = [];
  const seenKeys = new Set();
  for (const dir of Array.isArray(daemonDirs) ? daemonDirs : []) {
    if (!dir || !existsSync(dir)) continue;
    let names = [];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!/^hub_.*\.json$/i.test(name)) continue;
      const fullPath = join(dir, name);
      try {
        const st = statSync(fullPath);
        const parsed = JSON.parse(readFileSync(fullPath, 'utf8'));
        const csrfToken = String(parsed?.csrfToken || parsed?.csrf_token || '').trim();
        if (!csrfToken) continue;
        const pid = Number(parsed?.pid) || 0;
        if (pid > 0 && !isPidAliveFn(pid)) continue;
        const httpPort = Number(parsed?.httpPort || parsed?.port) || 0;
        const httpsPort = Number(parsed?.httpsPort) || 0;
        const targets = [];
        if (Number.isInteger(httpPort) && httpPort > 0 && httpPort <= 65535) {
          targets.push({ port: httpPort, protos: ['http', 'https'] });
        }
        if (
          Number.isInteger(httpsPort) &&
          httpsPort > 0 &&
          httpsPort <= 65535 &&
          httpsPort !== httpPort
        ) {
          targets.push({ port: httpsPort, protos: ['https', 'http'] });
        }
        if (targets.length === 0) continue;
        const dedupKey = `${pid}:${httpPort}:${httpsPort}:${csrfToken}`;
        if (seenKeys.has(dedupKey)) continue;
        seenKeys.add(dedupKey);
        const priority = preferredPids.has(pid) ? 115 : 95;
        candidates.push({
          pid,
          priority,
          mtimeMs: Number(st?.mtimeMs || 0),
          csrfToken,
          targets,
        });
      } catch {
        // Ignore corrupted or mid-replacement daemon files
      }
    }
  }
  candidates.sort((a, b) => b.priority - a.priority || b.mtimeMs - a.mtimeMs || b.pid - a.pid);
  return candidates;
}

async function execLsDiscoveryCmd(file, args, timeoutMs = 5000) {
  const cpMod = await import('node:child_process');
  const execFileFn = cpMod.execFile || cpMod.default?.execFile;
  if (typeof execFileFn !== 'function') {
    throw new Error('child_process.execFile unavailable');
  }
  return new Promise((resolve, reject) => {
    execFileFn(
      file,
      args,
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(String(stdout || ''));
      }
    );
  });
}

function readLinuxProcCandidates(procFs = null) {
  const exists = procFs?.existsSync || existsSync;
  const readdir = procFs?.readdirSync || readdirSync;
  const readFile = procFs?.readFileSync || readFileSync;
  if (!exists('/proc')) return [];
  const results = [];
  try {
    for (const entry of readdir('/proc')) {
      if (!/^\d+$/.test(entry)) continue;
      const pid = Number(entry);
      try {
        const rawCmd = readFile(`/proc/${pid}/cmdline`, 'utf8');
        if (!rawCmd) continue;
        const commandLine = rawCmd.replace(/\0+/g, ' ').trim();
        if (!/agy|antigravity-cli|language_server/i.test(commandLine)) continue;
        let ppid = 0;
        try {
          const statRaw = readFile(`/proc/${pid}/stat`, 'utf8');
          const afterComm = statRaw.slice(statRaw.lastIndexOf(')') + 1).trim();
          const parts = afterComm.split(/\s+/);
          ppid = Number(parts[1]) || 0;
        } catch {
          // Ignore single-process stat read failures
        }
        results.push({ pid, ppid, commandLine });
      } catch {
        // Ignore transient exiting processes
      }
    }
  } catch {
    return [];
  }
  return results;
}

async function listCandidateOsProcesses(platform, execCmdFn, procFs = null) {
  if (platform === 'win32') {
    const psScript =
      "Get-CimInstance Win32_Process -Filter \"Name LIKE 'agy%' OR Name LIKE 'antigravity-cli%' OR Name LIKE 'language_server%'\" | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress";
    const out = await execCmdFn('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      psScript,
    ]);
    const trimmed = out.trim();
    if (!trimmed) return [];
    const parsed = JSON.parse(trimmed);
    const items = Array.isArray(parsed) ? parsed : [parsed];
    return items
      .filter((it) => it && typeof it === 'object')
      .map((it) => ({
        pid: Number(it.ProcessId) || 0,
        ppid: Number(it.ParentProcessId) || 0,
        commandLine: String(it.CommandLine || ''),
      }));
  }

  if (platform === 'linux') {
    const procList = readLinuxProcCandidates(procFs);
    if (procList.length > 0) return procList;
  }

  const psArgs =
    platform === 'darwin' ? ['-ax', '-o', 'pid=,ppid=,command='] : ['-ax', '-o', 'pid=,ppid=,args='];
  const out = await execCmdFn('ps', psArgs);
  const results = [];
  for (const line of out.split(/\r?\n/)) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    if (!m) continue;
    const cmdLine = m[3];
    if (!/agy|antigravity-cli|language_server/i.test(cmdLine)) continue;
    results.push({
      pid: Number(m[1]) || 0,
      ppid: Number(m[2]) || 0,
      commandLine: cmdLine,
    });
  }
  return results;
}

async function findListeningPortsForPid(pid, platform, execCmdFn, procFs = null) {
  if (!Number.isInteger(pid) || pid <= 0) return [];
  if (platform === 'win32') {
    try {
      const out = await execCmdFn('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Get-NetTCPConnection -OwningProcess ${pid} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalPort | ConvertTo-Json -Compress`,
      ]);
      const trimmed = out.trim();
      if (!trimmed) return [];
      const parsed = JSON.parse(trimmed);
      const rawPorts = Array.isArray(parsed) ? parsed : [parsed];
      return Array.from(
        new Set(
          rawPorts
            .map(Number)
            .filter((p) => Number.isInteger(p) && p > 0 && p <= 65535)
        )
      );
    } catch {
      return [];
    }
  }

  if (platform === 'linux') {
    const procPorts = await readLinuxProcListeningPorts(pid, procFs);
    if (procPorts.length > 0) return procPorts;
    try {
      const ssOut = await execCmdFn('ss', ['-H', '-lntp']);
      const ssPorts = parseSsListeningPorts(ssOut, pid);
      if (ssPorts.length > 0) return ssPorts;
    } catch {
      // Fall back to lsof when ss is unavailable or permission is restricted
    }
  }

  try {
    const out = await execCmdFn('lsof', ['-Pan', '-p', String(pid), '-iTCP', '-sTCP:LISTEN']);
    const ports = new Set();
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(/:(\d{1,5})\s+\(LISTEN\)/i);
      if (m) {
        const p = Number(m[1]);
        if (p > 0 && p <= 65535) ports.add(p);
      }
    }
    return Array.from(ports);
  } catch {
    return [];
  }
}

async function probeLsCandidate(port, csrfToken, fetchFn, protos = ['http', 'https']) {
  for (const proto of protos) {
    try {
      const addr = `127.0.0.1:${port}`;
      const baseUrl = `${proto}://${addr}`;
      const res = await fetchFn(
        `${baseUrl}/exa.language_server_pb.LanguageServerService/GetUserStatus`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-codeium-csrf-token': csrfToken,
          },
          body: '{}',
          redirect: 'error',
          signal: AbortSignal.timeout(1500),
        }
      );
      if (res?.ok) {
        return { addr: proto === 'https' ? `https://${addr}` : addr, baseUrl, csrfToken };
      }
    } catch {
      // Continue trying the next candidate protocol or port
    }
  }
  return null;
}

/**
 * Automatically probes and handshake-verifies the locally running Antigravity Hub / Language Server RPC endpoint.
 *
 * @param {{
 *   ppid?: number,
 *   ancestorPids?: number[],
 *   platform?: string,
 *   daemonDirs?: string[],
 *   isPidAliveFn?: (pid: number) => boolean,
 *   procFs?: object|null,
 *   execCmdFn?: (file: string, args: string[]) => Promise<string>,
 *   fetchFn?: typeof fetch
 * }} [options]
 * @returns {Promise<{ addr: string, baseUrl: string, csrfToken: string, pid: number } | null>}
 */
export async function discoverAntigravityLsEndpoint(options = {}) {
  const {
    ppid = Number(process?.ppid || 0),
    ancestorPids = [],
    platform = process?.platform || 'win32',
    daemonDirs = options.execCmdFn ? [] : DAEMON_DIRS,
    isPidAliveFn = defaultIsLsPidAlive,
    procFs = null,
    listProcessesFn = null,
    execCmdFn = execLsDiscoveryCmd,
    fetchFn = typeof fetch === 'function' ? fetch : null,
  } = options;

  if (typeof fetchFn !== 'function') return null;

  const preferredPids = new Set(
    [ppid, ...(Array.isArray(ancestorPids) ? ancestorPids : [])]
      .map(Number)
      .filter((n) => Number.isInteger(n) && n > 0)
  );

  // 1. Prefer probing ~/.gemini/<product>/daemon/hub_*.json daemon endpoint descriptor files (zero external process overhead)
  const daemonCandidates = readHubDaemonCandidates(daemonDirs, preferredPids, isPidAliveFn);
  const probedDaemonKeys = new Set();
  for (const cand of daemonCandidates) {
    for (const target of cand.targets) {
      probedDaemonKeys.add(`${target.port}:${cand.csrfToken}`);
      const verified = await probeLsCandidate(target.port, cand.csrfToken, fetchFn, target.protos);
      if (verified) {
        return { ...verified, pid: cand.pid };
      }
    }
  }

  // 2. Fall back to enumerating OS processes and resolving listening ports
  let rawProcs = [];
  try {
    rawProcs =
      typeof listProcessesFn === 'function'
        ? await listProcessesFn(platform)
        : await listCandidateOsProcesses(platform, execCmdFn, procFs);
  } catch {
    return null;
  }
  if (!rawProcs.length) return null;

  const parsedCandidates = [];
  for (const proc of rawProcs) {
    const info = parseLsArgsFromCommandLine(proc.commandLine);
    if (!info.csrfToken || (!info.isHub && !info.isLanguageServer)) continue;
    let priority = 50;
    if (preferredPids.has(proc.pid)) {
      priority = 100;
    } else if (preferredPids.has(proc.ppid)) {
      priority = 90;
    } else if (info.isHub && info.hubPort) {
      priority = 80;
    }
    parsedCandidates.push({
      pid: proc.pid,
      priority,
      hubPort: info.hubPort,
      csrfToken: info.csrfToken,
    });
  }

  parsedCandidates.sort((a, b) => b.priority - a.priority || b.pid - a.pid);

  for (const cand of parsedCandidates) {
    const ports = cand.hubPort
      ? [cand.hubPort]
      : await findListeningPortsForPid(cand.pid, platform, execCmdFn, procFs);
    for (const port of ports) {
      if (probedDaemonKeys.has(`${port}:${cand.csrfToken}`)) continue;
      const verified = await probeLsCandidate(port, cand.csrfToken, fetchFn);
      if (verified) {
        return { ...verified, pid: cand.pid };
      }
    }
  }
  return null;
}

/**
 * Ensures `lsRuntimeEndpoint` is ready (with concurrency deduplication, failure cooldown, and dynamic endpoint reconnection).
 *
 * @param {{ force?: boolean, respectCooldown?: boolean, ancestorPids?: number[] }} [options]
 * @returns {Promise<boolean>}
 */
export async function ensureLsEndpointDiscovered({
  force = false,
  respectCooldown = false,
  ancestorPids = [],
} = {}) {
  if (lsRuntimeEndpoint.addr === 'test.invalid') {
    return false;
  }
  if (!force && lsRuntimeEndpoint.baseUrl && (lsRuntimeEndpoint.csrfToken || !lsRuntimeEndpoint.isDynamic)) {
    return true;
  }
  if (lsDiscoveryState.inFlight) {
    return lsDiscoveryState.inFlight;
  }
  const now = Date.now();
  if (
    (!force || respectCooldown) &&
    lsDiscoveryState.lastAttemptMs > 0 &&
    now - lsDiscoveryState.lastAttemptMs < LS_DISC_COOLDOWN_MS
  ) {
    return Boolean(lsRuntimeEndpoint.baseUrl);
  }

  const envHintPids = String(process?.env?.USAGE_MONITOR_HOST_PPID || '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);

  lsDiscoveryState.lastAttemptMs = now;
  lsDiscoveryState.inFlight = (async () => {
    try {
      const found = await discoverAntigravityLsEndpoint({
        ...(lsDiscoveryOverride || {}),
        ancestorPids: [...envHintPids, ...ancestorPids],
      });
      if (found && found.addr && found.csrfToken) {
        setLsRuntimeEndpoint(found.addr, found.csrfToken, { isDynamic: true });
        return true;
      }
      return Boolean(lsRuntimeEndpoint.baseUrl);
    } finally {
      lsDiscoveryState.inFlight = null;
    }
  })();

  return lsDiscoveryState.inFlight;
}

const LOCAL_HUB_PORTS_TTL_MS = 4000;
const localHubPortsCache = {
  ts: 0,
  key: '',
  value: null,
};

/**
 * Collects the set of loopback ports occupied by active local Hub / Language Server instances (including `httpPort`, `httpsPort`, and current `lsRuntimeEndpoint`),
 * without skipping alive `hub_*.json` files missing `csrfToken`, so `window-bridge.mjs` can accurately distinguish local windows from SSH remote windows.
 *
 * @param {{ daemonDirs?: string[], isPidAliveFn?: (pid: number) => boolean, force?: boolean }} [options]
 * @returns {{ allPorts: Set<number>, httpPorts: Set<number>, httpsPorts: Set<number>, csrfTokens: Set<string> }}
 */
export function getLocalHubPorts({
  daemonDirs = DAEMON_DIRS,
  isPidAliveFn = defaultIsLsPidAlive,
  force = false,
} = {}) {
  const dirs = Array.isArray(daemonDirs) ? daemonDirs : [];
  const cacheKey = `${dirs.join('|')}::${lsRuntimeEndpoint.baseUrl || ''}::${lsRuntimeEndpoint.csrfToken || ''}`;
  const now = Date.now();
  if (
    !force &&
    localHubPortsCache.value &&
    localHubPortsCache.key === cacheKey &&
    now - localHubPortsCache.ts < LOCAL_HUB_PORTS_TTL_MS
  ) {
    return localHubPortsCache.value;
  }

  const allPorts = new Set();
  const httpPorts = new Set();
  const httpsPorts = new Set();
  const csrfTokens = new Set();

  if (lsRuntimeEndpoint.csrfToken) {
    csrfTokens.add(String(lsRuntimeEndpoint.csrfToken).trim());
  }
  if (lsRuntimeEndpoint.baseUrl) {
    try {
      const parsed = new URL(lsRuntimeEndpoint.baseUrl);
      const port = Number(parsed.port || 0);
      if (Number.isInteger(port) && port > 0 && port <= 65535) {
        allPorts.add(port);
        if (parsed.protocol === 'https:') httpsPorts.add(port);
        else httpPorts.add(port);
      }
    } catch {
      // Ignore invalid URL
    }
  }

  for (const dir of dirs) {
    if (!dir || !existsSync(dir)) continue;
    let names = [];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!/^hub_.*\.json$/i.test(name)) continue;
      const fullPath = join(dir, name);
      try {
        const parsed = JSON.parse(readFileSync(fullPath, 'utf8'));
        const pid = Number(parsed?.pid) || 0;
        if (pid > 0 && !isPidAliveFn(pid)) continue;
        const csrf = String(parsed?.csrfToken || parsed?.csrf_token || '').trim();
        if (csrf) csrfTokens.add(csrf);
        const hPort = Number(parsed?.httpPort || parsed?.port) || 0;
        const sPort = Number(parsed?.httpsPort) || 0;
        if (Number.isInteger(hPort) && hPort > 0 && hPort <= 65535) {
          allPorts.add(hPort);
          httpPorts.add(hPort);
        }
        if (Number.isInteger(sPort) && sPort > 0 && sPort <= 65535) {
          allPorts.add(sPort);
          httpsPorts.add(sPort);
        }
      } catch {
        // Ignore corrupted or transient daemon files
      }
    }
  }

  const snapshot = { allPorts, httpPorts, httpsPorts, csrfTokens };
  localHubPortsCache.ts = now;
  localHubPortsCache.key = cacheKey;
  localHubPortsCache.value = snapshot;
  return snapshot;
}



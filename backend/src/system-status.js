'use strict';

const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cpuTimes() {
  return os.cpus().reduce((acc, cpu) => {
    const total = Object.values(cpu.times).reduce((sum, value) => sum + value, 0);
    acc.idle += cpu.times.idle;
    acc.total += total;
    return acc;
  }, { idle: 0, total: 0 });
}

async function cpuPercent() {
  const first = cpuTimes();
  await sleep(120);
  const second = cpuTimes();
  const total = second.total - first.total;
  const idle = second.idle - first.idle;
  return total > 0 ? Math.max(0, Math.min(100, ((total - idle) / total) * 100)) : 0;
}

function temperatureC() {
  const candidates = [
    '/sys/class/thermal/thermal_zone0/temp',
    '/sys/devices/virtual/thermal/thermal_zone0/temp'
  ];
  for (const file of candidates) {
    try {
      const value = Number(fs.readFileSync(file, 'utf8').trim());
      if (Number.isFinite(value)) return value > 1000 ? value / 1000 : value;
    } catch (_error) {}
  }
  return null;
}

function diskInfo() {
  try {
    const output = execFileSync('df', ['-kP', '/'], { encoding: 'utf8', timeout: 2000 });
    const line = output.trim().split(/\r?\n/).pop();
    const parts = line.trim().split(/\s+/);
    const total = Number(parts[1]) * 1024;
    const used = Number(parts[2]) * 1024;
    const free = Number(parts[3]) * 1024;
    return { total, used, free, percent: total > 0 ? (used / total) * 100 : 0 };
  } catch (_error) {
    return { total: 0, used: 0, free: 0, percent: 0 };
  }
}

function addresses() {
  const result = [];
  for (const [name, entries] of Object.entries(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) result.push({ name, address: entry.address });
    }
  }
  return result;
}

async function systemStatus(extra = {}) {
  const totalMemory = os.totalmem();
  const freeMemory = os.freemem();
  const processMemory = process.memoryUsage();
  return {
    hostname: os.hostname(),
    platform: `${os.platform()} ${os.release()}`,
    architecture: os.arch(),
    nodeVersion: process.version,
    uptimeSeconds: os.uptime(),
    processUptimeSeconds: process.uptime(),
    loadAverage: os.loadavg(),
    cpuPercent: await cpuPercent(),
    cpuTemperatureC: temperatureC(),
    memory: {
      total: totalMemory,
      used: totalMemory - freeMemory,
      free: freeMemory,
      percent: totalMemory > 0 ? ((totalMemory - freeMemory) / totalMemory) * 100 : 0
    },
    processMemory: {
      rss: processMemory.rss,
      heapUsed: processMemory.heapUsed
    },
    disk: diskInfo(),
    addresses: addresses(),
    time: new Date().toISOString(),
    ...extra
  };
}

module.exports = { systemStatus };

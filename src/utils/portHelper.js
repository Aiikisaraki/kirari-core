// src/utils/portHelper.js
const net = require("net");

/**
 * 检查端口是否可用
 * @param {number} port 
 * @param {string} host 绑定网卡，默认 127.0.0.1（回环）
 * @returns {Promise<boolean>}
 */
function isPortAvailable(port, host = '127.0.0.1') {
    return new Promise((resolve) => {
        const testServer = net.createServer();
        testServer.once('error', (err) => {
            resolve(false);
        });
        testServer.once('listening', () => {
            testServer.close(() => resolve(true));
        });
        testServer.listen(port, host);
    });
}

/**
 * 寻找第一个可用的端口
 * @param {number} startPort 
 * @param {number[]} candidates 
 * @param {string} [host] 探测所用的绑定网卡；缺省时沿用 HOST 环境变量，再退 127.0.0.1
 * @returns {Promise<number|null>}
 */
async function findAvailablePort(startPort, candidates = [], host) {
    const ports = [startPort, ...candidates].filter(p => p);
    const bindHost = host || process.env.HOST || '127.0.0.1';
    for (const port of ports) {
        if (await isPortAvailable(port, bindHost)) {
            return port;
        }
        console.log(`⚠️ Port ${port} is in use, trying next...`);
    }
    return null;
}

module.exports = { isPortAvailable, findAvailablePort };

// src/utils/portHelper.js
const net = require("net");

/**
 * 检查端口是否可用
 * @param {number} port 
 * @returns {Promise<boolean>}
 */
function isPortAvailable(port) {
    return new Promise((resolve) => {
        const testServer = net.createServer();
        testServer.once('error', (err) => {
            resolve(false);
        });
        testServer.once('listening', () => {
            testServer.close(() => resolve(true));
        });
        testServer.listen(port, '127.0.0.1');
    });
}

/**
 * 寻找第一个可用的端口
 * @param {number} startPort 
 * @param {number[]} candidates 
 * @returns {Promise<number|null>}
 */
async function findAvailablePort(startPort, candidates = []) {
    const ports = [startPort, ...candidates].filter(p => p);
    for (const port of ports) {
        if (await isPortAvailable(port)) {
            return port;
        }
        console.log(`⚠️ Port ${port} is in use, trying next...`);
    }
    return null;
}

module.exports = { isPortAvailable, findAvailablePort };

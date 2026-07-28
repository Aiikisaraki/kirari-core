const crypto = require('crypto');

// 会话令牌：无状态 HMAC 签名，避免服务端存会话。格式 payload.signature（base64url）。
const SECRET = process.env.SESSION_SECRET || 'kirari-dev-session-secret';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 天

function signSession(uid) {
    const payload = Buffer.from(
        JSON.stringify({ uid, exp: Date.now() + SESSION_TTL_MS }),
    ).toString('base64url');
    const signature = crypto
        .createHmac('sha256', SECRET)
        .update(payload)
        .digest('base64url');
    return `${payload}.${signature}`;
}

function verifySession(token) {
    if (typeof token !== 'string' || !token.includes('.')) return null;
    const [payload, signature] = token.split('.');
    if (!payload || !signature) return null;
    const expected = crypto
        .createHmac('sha256', SECRET)
        .update(payload)
        .digest('base64url');
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    try {
        const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
        if (!data.exp || data.exp < Date.now()) return null;
        return data.uid;
    } catch {
        return null;
    }
}

module.exports = { signSession, verifySession };

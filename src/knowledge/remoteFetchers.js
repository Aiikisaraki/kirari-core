// src/knowledge/remoteFetchers.js
// 远程知识源抓取（Node 版，对应桌宠版 src/knowledge/remoteKnowledgeFetchers.ts）。
// 支持 mediawiki / markdown / html / rss 四种来源；检索时实时抓取，不落本地副本。
//
// 为什么核心版也要一份：私人知识库现在两端共用同一份 knowledge.json（用户拍板：
// 核心版自动接管桌宠版数据），远程源定义也在那个文件里，核心版必须能自己抓。
const http = require('http');
const https = require('https');
const { URL } = require('url');

function fetchText(url, signal, timeout = 3000) {
    return new Promise((resolve, reject) => {
        let u;
        try {
            u = new URL(url);
        } catch {
            return reject(new Error('地址格式不对'));
        }
        if (!['http:', 'https:'].includes(u.protocol)) return reject(new Error('只支持 http/https'));
        const mod = u.protocol === 'https:' ? https : http;
        const req = mod.get(
            u,
            { headers: { 'User-Agent': 'kirari-core/1.0 (knowledge fetcher)', Accept: '*/*' } },
            (res) => {
                // 跟随一次重定向就够（多数源是 301 到规范地址）
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    res.resume();
                    return fetchText(new URL(res.headers.location, u).toString(), signal, timeout).then(resolve, reject);
                }
                if (res.statusCode !== 200) {
                    res.resume();
                    return reject(new Error(`HTTP ${res.statusCode}`));
                }
                let body = '';
                res.setEncoding('utf-8');
                res.on('data', (c) => {
                    body += c;
                    if (body.length > 2_000_000) {
                        req.destroy(new Error('内容过大'));
                    }
                });
                res.on('end', () => resolve(body));
            },
        );
        req.setTimeout(timeout, () => req.destroy(new Error('超时')));
        req.on('error', reject);
        if (signal) {
            signal.addEventListener('abort', () => req.destroy(new Error('aborted')), { once: true });
        }
    });
}

function fetchJson(url, signal, timeout = 3000) {
    return fetchText(url, signal, timeout).then((t) => JSON.parse(t));
}

/** MediaWiki API（action=query&list=search）。url 传 api.php 地址。 */
async function fetchMediaWiki(apiUrl, query, maxResults, signal) {
    const u = new URL(apiUrl);
    u.searchParams.set('action', 'query');
    u.searchParams.set('list', 'search');
    u.searchParams.set('srsearch', query);
    u.searchParams.set('srlimit', String(Math.max(1, maxResults)));
    u.searchParams.set('format', 'json');
    const data = await fetchJson(u.toString(), signal);
    const hits = data?.query?.search || [];
    return hits.map((h) => ({
        text: `${h.title}\n${String(h.snippet || '').replace(/<[^>]+>/g, '')}`,
        url: `${u.origin}${u.pathname.replace(/\/api\.php$/, '')}/${encodeURIComponent(h.title)}`,
    }));
}

/** 纯 markdown 页面：按查询词切出相关段落。 */
async function fetchMarkdown(url, query, maxResults, signal) {
    const text = await fetchText(url, signal);
    const terms = query.split(/\s+/).filter(Boolean).slice(0, 6);
    const blocks = text.split(/\n\s*\n/);
    const hits = blocks
        .map((b, i) => ({ b, i }))
        .filter(({ b }) => terms.some((t) => b.includes(t)))
        .slice(0, maxResults);
    return hits.map(({ b, i }) => ({ text: b.trim().slice(0, 800), url: `${url}#L${i + 1}` }));
}

/** HTML 页面：去标签后按段落匹配。 */
async function fetchHtml(url, query, maxResults, signal) {
    const raw = await fetchText(url, signal);
    const stripped = raw
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, '\n')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>');
    const terms = query.split(/\s+/).filter(Boolean).slice(0, 6);
    const blocks = stripped.split(/\n\s*\n/).map((b) => b.replace(/\s+/g, ' ').trim()).filter((b) => b.length > 20);
    return blocks.filter((b) => terms.some((t) => b.includes(t))).slice(0, maxResults).map((b) => ({ text: b.slice(0, 800), url }));
}

/** RSS/Atom：取标题+摘要匹配的条目。 */
async function fetchRss(url, query, maxResults, signal) {
    const xml = await fetchText(url, signal);
    const terms = query.split(/\s+/).filter(Boolean).slice(0, 6);
    const items = [];
    const itemRe = /<(?:item|entry)[\s\S]*?<\/\s*(?:item|entry)>/gi;
    let m;
    while ((m = itemRe.exec(xml)) && items.length < maxResults * 3) {
        const block = m[0];
        const title = (block.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
        const desc = (block.match(/<(?:description|summary)[^>]*>([\s\S]*?)<\/(?:description|summary)>/i) || [])[1] || '';
        const link = (block.match(/<link[^>]*href="([^"]+)"/i) || block.match(/<link[^>]*>([\s\S]*?)<\/link>/i) || [])[1] || url;
        const plain = `${title} ${desc}`.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        if (terms.some((t) => plain.includes(t))) {
            items.push({ text: plain.slice(0, 800), url: link.trim() });
        }
        if (items.length >= maxResults) break;
    }
    return items;
}

/**
 * 统一抓取入口。任何失败都吞掉返回 []（检索不该被单个坏源拖垮）。
 * @returns {Promise<Array<{text:string, url:string}>>}
 */
async function fetchRemoteKnowledge(url, sourceType, query, maxResults = 2, timeout = 3000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
        switch (sourceType) {
            case 'mediawiki':
                return await fetchMediaWiki(url, query, maxResults, controller.signal);
            case 'markdown':
                return await fetchMarkdown(url, query, maxResults, controller.signal);
            case 'rss':
                return await fetchRss(url, query, maxResults, controller.signal);
            case 'html':
            default:
                return await fetchHtml(url, query, maxResults, controller.signal);
        }
    } catch (e) {
        if (e?.name === 'AbortError' || e?.message === 'aborted') {
            console.warn(`[remote-kb] 抓取超时: ${url}`);
        } else {
            console.warn(`[remote-kb] 抓取失败 ${url}:`, e?.message || e);
        }
        return [];
    } finally {
        clearTimeout(timer);
    }
}

module.exports = { fetchRemoteKnowledge };

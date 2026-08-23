// src/knowledge/sources/MediaWikiSource.js
// 参考适配器：MediaWiki 类百科（萌娘百科等）。免注册、公开读 API、国内直连。
// 检索 = generator=search + prop=extracts（取 intro 正文），HTML 剥离为纯文本。
//
// 这是"免注册可直接调用"源的标准范本（Tier A）。接入其他 MediaWiki 站点
// （如维基百科中文版、Bangumi 等）只需在清单里换 endpoint，无需改代码。

const BaseSource = require('../BaseSource');

/** 剥离 MediaWiki 返回的 HTML/实体，转为可读纯文本 */
function stripHtml(s) {
  if (!s) return '';
  return String(s)
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#?\w+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

class MediaWikiSource extends BaseSource {
  /**
   * @param {string} query
   * @param {Object} [opts]
   * @returns {Promise<import('../types').RetrievedPassage[]>}
   */
  async retrieve(query, opts = {}) {
    const limit = this.options.limit || opts.limit || 3;
    const endpoint = this.def.endpoint;
    if (!endpoint) return [];
    const url =
      `${endpoint}?action=query&generator=search&gsrsearch=${encodeURIComponent(query)}` +
      `&gsrlimit=${limit}&prop=extracts&exintro=1&explaintext=1&exlimit=max&format=json`;
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'kirari-pet/0.1 (knowledge-retrieval)' },
      });
      if (!res.ok) return [];
      const data = await res.json();
      const pages = data?.query?.pages ? Object.values(data.query.pages) : [];
      const out = [];
      for (const p of pages) {
        const text = stripHtml(p.extract || p.snippet || '');
        if (!text) continue;
        out.push({
          text,
          source: this.name,
          url: p.fullurl || p.canonicalurl || undefined,
          // MediaWiki 搜索结果带 index（0 起），转成降序分数，越靠前越相关
          score: typeof p.index === 'number' ? 1 / (p.index + 1) : 0.5,
          tier: this.tier,
          priority: this.priority,
        });
      }
      return out;
    } catch {
      // 网络/解析异常 → 自愈为"无结果"，不向上抛
      return [];
    }
  }
}

module.exports = MediaWikiSource;

// src/knowledge/sources/RestApiSource.js
// 通用免注册 REST 源适配器（Tier A）。通过 def.options.parser 选择具体解析器，
// 一个文件覆盖多个"免注册、可直接调用"的权威 API，避免每个源各写一套。
//
// 当前支持：pubchem(化学) / pubmed(医学生理) / musicbrainz(音乐)。
// 新增源只需在 PARSERS 里加一项（url + extract），无需改注册表/类型。
//
// 设计约定（同其他源）：任何网络/解析异常都返回 []，不向上抛，上层已兜底。

const BaseSource = require('../BaseSource');

const UA = 'kirari-pet/0.1 (knowledge-retrieval; contact: user-agent)';

/**
 * 各解析器契约：
 *  - url(query): 返回首个请求 URL
 *  - extract(query, data, fetchFn): 返回纯文本片段或 null。
 *    data 为已 JSON.parse 的结果（解析失败则为原始文本字符串）。
 *    fetchFn(extraUrl) 可选，用于需要第二步请求（如 PubMed esearch→efetch）。
 */
const PARSERS = {
  pubchem: {
    url: (q) =>
      `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/${encodeURIComponent(q)}/property/MolecularFormula,IsomericSMILES,IUPACName/JSON`,
    extract: (_q, data) => {
      const p = data?.PropertyTable?.Properties?.[0];
      if (!p) return null;
      const parts = [];
      if (p.IUPACName) parts.push(`IUPAC 名称：${p.IUPACName}`);
      if (p.MolecularFormula) parts.push(`分子式：${p.MolecularFormula}`);
      if (p.IsomericSMILES) parts.push(`SMILES：${p.IsomericSMILES}`);
      return parts.length ? parts.join('；') : null;
    },
  },

  pubmed: {
    url: (q) =>
      `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${encodeURIComponent(q)}&retmode=json&retmax=3`,
    // 两步：esearch 拿 pmids → efetch 拿摘要文本
    extract: async (q, data, fetchFn) => {
      const ids = data?.esearchresult?.idlist;
      if (!Array.isArray(ids) || !ids.length) return null;
      const text = await fetchFn(
        `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=${ids.join(',')}&rettype=abstract&retmode=text`,
      );
      // efetch 返回的是原始摘要文本（含 PMID / Author / Abstract），截取前 ~600 字
      if (!text || !text.trim()) return null;
      return text.replace(/\s+/g, ' ').trim().slice(0, 600);
    },
  },

  musicbrainz: {
    url: (q) =>
      `https://musicbrainz.org/ws/2/recording?query=${encodeURIComponent(q)}&fmt=json&limit=3`,
    extract: (_q, data) => {
      const recs = data?.recordings;
      if (!Array.isArray(recs) || !recs.length) return null;
      const top = recs[0];
      const title = top.title || '';
      const artists = Array.isArray(top['artist-credit'])
        ? top['artist-credit'].map((a) => a?.name).filter(Boolean).join('、')
        : '';
      const date = top.releases?.[0]?.date || top['first-release-date'] || '';
      const bits = [];
      if (title) bits.push(`曲目：${title}`);
      if (artists) bits.push(`艺术家：${artists}`);
      if (date) bits.push(`首发：${date}`);
      return bits.length ? bits.join('；') : null;
    },
  },
};

class RestApiSource extends BaseSource {
  /**
   * @param {string} query
   * @param {Object} [opts]
   * @returns {Promise<import('../types').RetrievedPassage[]>}
   */
  async retrieve(query, opts = {}) {
    const parser = PARSERS[this.def.parser];
    if (!parser || !query || !query.trim()) return [];
    try {
      const res = await fetch(parser.url(query), {
        headers: { 'User-Agent': UA, Accept: 'application/json' },
      });
      if (!res.ok) return [];
      const raw = await res.text();
      let data = raw;
      try {
        data = JSON.parse(raw);
      } catch {
        /* 保留原始文本（pubmed efetch 返回纯文本） */
      }
      const text = await parser.extract(query, data, async (u) => {
        try {
          const r2 = await fetch(u, { headers: { 'User-Agent': UA } });
          return r2.ok ? await r2.text() : '';
        } catch {
          return '';
        }
      });
      if (!text) return [];
      return [
        {
          text,
          source: this.name,
          score: 0.6,
          tier: this.tier,
          priority: this.priority,
        },
      ];
    } catch {
      return [];
    }
  }
}

module.exports = RestApiSource;

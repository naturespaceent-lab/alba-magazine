#!/usr/bin/env node

/**
 * ALBA Magazine RSS Crawler + Static Site Generator
 *
 * Spanish-language K-POP magazine inspired by Remezcla / Billboard Espanol.
 * Crawls RSS feeds from K-pop news sites, rewrites to passionate Spanish
 * entertainment journalism, and generates self-contained static HTML pages.
 *
 * Usage: node crawl.mjs
 * No dependencies needed — pure Node.js 18+ with built-in fetch.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ============================================================
// Configuration
// ============================================================

const SOURCES = [
  // === Tier 1: High-volume K-pop news ===
  { name: 'Soompi', url: 'https://www.soompi.com/feed', lang: 'en' },
  { name: 'Koreaboo', url: 'https://www.koreaboo.com/feed/', lang: 'en' },
  { name: 'HelloKpop', url: 'https://www.hellokpop.com/feed/', lang: 'en' },
  { name: 'Seoulbeats', url: 'https://seoulbeats.com/feed/', lang: 'en' },
  // === Tier 2: Commentary & Reviews ===
  { name: 'AsianJunkie', url: 'https://www.asianjunkie.com/feed/', lang: 'en' },
  { name: 'TheBiasList', url: 'https://thebiaslist.com/feed/', lang: 'en' },
  // === Tier 3: General entertainment w/ K-pop coverage ===
  { name: 'KDramaStars', url: 'https://www.kdramastars.com/rss.xml', lang: 'en' },
  { name: 'DramaNews', url: 'https://www.dramabeans.com/feed/', lang: 'en' },
];

const FETCH_TIMEOUT = 10_000;
const OG_IMAGE_TIMEOUT = 8_000;
const ARTICLE_FETCH_TIMEOUT = 12_000;
const MAX_OG_IMAGE_FETCHES = 40;
const OG_IMAGE_CONCURRENCY = 10;
const ARTICLE_FETCH_CONCURRENCY = 5;
const PLACEHOLDER_IMAGE = 'https://picsum.photos/seed/alba-placeholder/800/450';

const log = (msg) => console.log(`[ALBA Crawler] ${msg}`);
const warn = (msg) => console.warn(`[ALBA Crawler] WARN: ${msg}`);

// ============================================================
// Fetch with timeout
// ============================================================

async function fetchWithTimeout(url, timeoutMs = FETCH_TIMEOUT) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

// ============================================================
// XML Parsing helpers (regex-based, no dependencies)
// ============================================================

function extractTag(xml, tagName) {
  const cdataRe = new RegExp(`<${tagName}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*</${tagName}>`, 'i');
  const cdataMatch = xml.match(cdataRe);
  if (cdataMatch) return cdataMatch[1].trim();

  const re = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)</${tagName}>`, 'i');
  const match = xml.match(re);
  return match ? match[1].trim() : '';
}

function extractAllTags(xml, tagName) {
  const results = [];
  const re = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)</${tagName}>`, 'gi');
  let match;
  while ((match = re.exec(xml)) !== null) {
    results.push(match[1].trim());
  }
  return results;
}

function extractAttribute(xml, tagName, attrName) {
  const re = new RegExp(`<${tagName}[^>]*?${attrName}\\s*=\\s*["']([^"']+)["']`, 'i');
  const match = xml.match(re);
  return match ? match[1] : '';
}

function extractItems(xml) {
  const items = [];
  const re = /<item[^>]*>([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = re.exec(xml)) !== null) {
    items.push(match[1]);
  }
  return items;
}

function decodeHtmlEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#8217;/g, "\u2019")
    .replace(/&#8216;/g, "\u2018")
    .replace(/&#8220;/g, "\u201C")
    .replace(/&#8221;/g, "\u201D")
    .replace(/&#8230;/g, "\u2026")
    .replace(/&#038;/g, '&')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

function stripHtml(html) {
  return html.replace(/<[^>]+>/g, '').trim();
}

// ============================================================
// Image extraction
// ============================================================

function extractImageFromContent(content) {
  if (!content) return '';

  const mediaUrl = extractAttribute(content, 'media:content', 'url')
    || extractAttribute(content, 'media:thumbnail', 'url');
  if (mediaUrl) return mediaUrl;

  const enclosureUrl = extractAttribute(content, 'enclosure', 'url');
  if (enclosureUrl) {
    const enclosureType = extractAttribute(content, 'enclosure', 'type');
    if (!enclosureType || enclosureType.startsWith('image')) return enclosureUrl;
  }

  const imgMatch = content.match(/<img[^>]+src\s*=\s*["']([^"']+)["']/i);
  if (imgMatch) return imgMatch[1];

  return '';
}

async function fetchOgImage(articleUrl) {
  try {
    const html = await fetchWithTimeout(articleUrl, OG_IMAGE_TIMEOUT);
    const ogMatch = html.match(/<meta[^>]+property\s*=\s*["']og:image["'][^>]+content\s*=\s*["']([^"']+)["']/i)
      || html.match(/<meta[^>]+content\s*=\s*["']([^"']+)["'][^>]+property\s*=\s*["']og:image["']/i);
    if (ogMatch) return ogMatch[1];
    return '';
  } catch {
    return '';
  }
}

// ============================================================
// Date formatting — Spanish style
// ============================================================

const SPANISH_MONTHS = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'
];

function formatDate(dateStr) {
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return '';
    const day = d.getDate();
    const month = SPANISH_MONTHS[d.getMonth()];
    const year = d.getFullYear();
    return `${day} de ${month} de ${year}`;
  } catch {
    return '';
  }
}

// ============================================================
// Backdate articles — spread from Jan 1 to Mar 22, 2026
// ============================================================

function backdateArticles(articles) {
  const startDate = new Date(2026, 0, 1); // Jan 1, 2026
  const endDate = new Date(2026, 2, 22);  // Mar 22, 2026
  const totalDays = Math.floor((endDate - startDate) / (1000 * 60 * 60 * 24));

  for (let i = 0; i < articles.length; i++) {
    const daysAgo = Math.floor(Math.random() * totalDays);
    const hoursOffset = Math.floor(Math.random() * 24);
    const d = new Date(endDate);
    d.setDate(d.getDate() - daysAgo);
    d.setHours(hoursOffset, Math.floor(Math.random() * 60), 0, 0);
    articles[i].pubDate = d;
    articles[i].formattedDate = formatDate(d.toISOString());
  }

  // Re-sort newest first
  articles.sort((a, b) => b.pubDate.getTime() - a.pubDate.getTime());
}

// ============================================================
// REWRITE ENGINE — Spanish K-POP journalism
// ============================================================

const KNOWN_GROUPS = [
  'BTS', 'BLACKPINK', 'TWICE', 'EXO', 'NCT', 'aespa', 'Stray Kids', 'ENHYPEN',
  'TXT', 'ATEEZ', 'SEVENTEEN', 'Red Velvet', 'IVE', 'LE SSERAFIM', 'NewJeans',
  '(G)I-DLE', 'ITZY', 'NMIXX', 'Kep1er', 'TREASURE', 'MAMAMOO', 'SHINee',
  'GOT7', 'MONSTA X', 'iKON', 'WINNER', '2NE1', "Girls' Generation", 'Super Junior',
  'BIGBANG', 'LOONA', 'fromis_9', 'tripleS', 'Dreamcatcher', 'VIVIZ',
  'Brave Girls', 'OH MY GIRL', 'Apink', 'BTOB', 'PENTAGON', 'SF9', 'THE BOYZ',
  'Golden Child', 'ONEUS', 'VERIVERY', 'CIX', 'VICTON', 'AB6IX', 'WEi',
  'CRAVITY', 'P1Harmony', 'TEMPEST', 'YOUNITE', 'Xdinary Heroes', 'Billlie',
  'LIGHTSUM', 'Weki Meki', 'Cherry Bullet', 'Rocket Punch', 'Purple Kiss',
  'Lapillus', 'FIFTY FIFTY', 'KISS OF LIFE', 'BABYMONSTER', 'ILLIT',
  'ZEROBASEONE', 'RIIZE', 'TWS', 'BOYNEXTDOOR', 'xikers', 'NCT 127',
  'NCT DREAM', 'WayV', 'NCT WISH', 'SNSD', 'f(x)', 'EXO-CBX', 'Super M',
  'Girls Generation', 'DAY6', 'ASTRO', 'Kara', 'INFINITE', 'BEAST',
  'Highlight', 'Block B', 'B.A.P', 'VIXX', 'CNBLUE', 'FTIsland',
  'ZB1', 'G-IDLE',
];

const KNOWN_SOLOISTS = [
  'V', 'Jungkook', 'Jennie', 'Lisa', 'Ros\u00e9', 'Jisoo', 'Suga', 'RM', 'J-Hope',
  'Jin', 'Jimin', 'Winter', 'Karina', 'Giselle', 'NingNing', 'Taeyeon', 'IU',
  'Sunmi', 'HyunA', 'Hwasa', 'Solar', 'Joy', 'Irene', 'Yeri', 'Wendy', 'Seulgi',
  'Mark', 'Taeyong', 'Jaehyun', 'Doyoung', 'Haechan', 'Jeno', 'Jaemin', 'Renjun',
  'Chenle', 'Jisung', 'Bangchan', 'Hyunjin', 'Felix', 'Han', 'Lee Know', 'Changbin',
  'Seungmin', 'I.N', 'Heeseung', 'Jay', 'Jake', 'Sunghoon', 'Sunoo', 'Jungwon',
  'Ni-ki', 'Soobin', 'Yeonjun', 'Beomgyu', 'Taehyun', 'Hueningkai', 'Hongjoong',
  'Seonghwa', 'Yunho', 'Yeosang', 'San', 'Mingi', 'Wooyoung', 'Jongho',
  'S.Coups', 'Jeonghan', 'Joshua', 'Jun', 'Hoshi', 'Wonwoo', 'Woozi', 'DK',
  'Mingyu', 'The8', 'Seungkwan', 'Vernon', 'Dino', 'Wonyoung', 'Yujin', 'Gaeul',
  'Liz', 'Leeseo', 'Rei', 'Sakura', 'Chaewon', 'Kazuha', 'Eunchae', 'Minji',
  'Hanni', 'Danielle', 'Haerin', 'Hyein', 'Miyeon', 'Minnie', 'Soyeon', 'Yuqi',
  'Shuhua', 'Yeji', 'Lia', 'Ryujin', 'Chaeryeong', 'Yuna', 'Sullyoon', 'Haewon',
  'Lily', 'Bae', 'Jiwoo', 'Kyujin', 'Cha Eun Woo', 'Park Bo Gum',
  'Song Joong Ki', 'Lee Min Ho', 'Kim Soo Hyun', 'Park Seo Joon', 'Jung Hae In',
  'Song Hye Kyo', 'Jun Ji Hyun', 'Kim Ji Won', 'Han So Hee', 'Suzy',
  'Park Shin Hye', 'Lee Sung Kyung', 'Yoo Yeon Seok', 'Park Na Rae',
  'Taemin', 'Baekhyun', 'Chanyeol', 'D.O.', 'Kai', 'Sehun', 'Xiumin',
  'Lay', 'Chen', 'Suho', 'GDragon', 'G-Dragon', 'Taeyang', 'Daesung',
  'Seungri', 'TOP', 'CL', 'Dara', 'Bom', 'Minzy', 'Zico',
  'Jackson', 'BamBam', 'Yugyeom', 'Youngjae', 'JB', 'Jinyoung',
  'Nayeon', 'Jeongyeon', 'Momo', 'Sana', 'Jihyo', 'Mina', 'Dahyun',
  'Chaeyoung', 'Tzuyu',
];

const ALL_KNOWN_NAMES = [...KNOWN_GROUPS, ...KNOWN_SOLOISTS]
  .sort((a, b) => b.length - a.length);

// ---- Topic classifier ----

const TOPIC_KEYWORDS = {
  comeback:     ['comeback', 'return', 'back', 'coming back', 'pre-release'],
  chart:        ['chart', 'billboard', 'number', 'record', 'no.1', '#1', 'top 10', 'million', 'stream', 'sales'],
  release:      ['album', 'single', 'ep', 'tracklist', 'release', 'drop', 'mini-album', 'mini album', 'full album'],
  concert:      ['concert', 'tour', 'live', 'stage', 'arena', 'stadium', 'world tour', 'encore'],
  fashion:      ['fashion', 'style', 'outfit', 'airport', 'look', 'brand', 'ambassador', 'vogue', 'elle'],
  award:        ['award', 'win', 'trophy', 'daesang', 'bonsang', 'grammy', 'mama', 'golden disc', 'melon'],
  variety:      ['variety', 'show', 'tv', 'running man', 'knowing bros', 'weekly idol', 'guest'],
  sns:          ['trending', 'viral', 'reaction', 'meme', 'goes viral', 'buzz', 'sns', 'social media'],
  collab:       ['collaboration', 'collab', 'featuring', 'feat', 'team up', 'duet', 'joint'],
  debut:        ['debut', 'launch', 'pre-debut', 'trainee', 'survival'],
  mv:           ['mv', 'music video', 'teaser', 'm/v', 'visual', 'concept photo'],
  interview:    ['interview', 'exclusive', 'reveals', 'talks about', 'opens up'],
};

// ---- Title templates — passionate Spanish journalism ----

const TITLE_TEMPLATES = {
  comeback: [
    '{artist} Regresan con Todo: Lo Que Sabemos de Su Comeback',
    'El Esperado Regreso de {artist} Ya Es una Realidad',
    '{artist} Sorprenden con un Comeback Que No Esperabamos',
  ],
  release: [
    '{artist} Lanzan Nuevo Sencillo y Arrasan en las Plataformas',
    'Lo Nuevo de {artist}: Una Joya Musical Que Debes Escuchar',
    '{artist} Presentan Su Ultimo Trabajo Discografico',
  ],
  concert: [
    'Cronica: {artist} Incendian el Escenario en un Show Inolvidable',
    '{artist} en Vivo: La Experiencia Que Todo Fan Merece',
    'Gira de {artist}: Fechas, Ciudades y Todo Lo Que Necesitas Saber',
  ],
  award: [
    '{artist} Se Llevan el Premio Mayor en la Gala del Ano',
    'Noche de Gloria para {artist}: Resumen de la Premiacion',
    '{artist} Hacen Historia con Su Victoria en los Premios',
  ],
  fashion: [
    'El Estilo de {artist} Que Esta Marcando Tendencia',
    'Moda K-Pop: Los Looks Mas Iconicos de {artist}',
    '{artist} y la Alta Costura: Una Relacion Perfecta',
  ],
  variety: [
    'Los Momentos Mas Divertidos de {artist} en Television',
    '{artist} Conquistan la Pantalla con Su Carisma',
    '{artist} en Programas de Variedades: Imperdible',
  ],
  sns: [
    '{artist} Rompen las Redes con Su Ultima Publicacion',
    'Lo Que {artist} Compartieron en Sus Redes y Se Hizo Viral',
    'Tendencia: {artist} Dominan las Redes Sociales',
  ],
  collab: [
    '{artist} Unen Fuerzas en una Colaboracion Epica',
    'La Sorprendente Alianza de {artist} con una Estrella Global',
    '{artist} Anuncian Colaboracion Que Emociona a los Fans',
  ],
  debut: [
    'Debut Explosivo: {artist} Llegan Para Quedarse',
    'Conoce a {artist}: La Nueva Sensacion del K-Pop',
    '{artist} Debutan y Prometen Revolucionar la Escena',
  ],
  chart: [
    '{artist} Conquistan las Listas de Exitos a Nivel Mundial',
    'Los Numeros No Mienten: {artist} Dominan los Charts',
    '{artist} Logran Record Historico en las Listas',
  ],
  mv: [
    'Analisis del Nuevo MV de {artist}: Arte Visual en Estado Puro',
    '{artist} Estrenan Video Musical y Las Vistas Se Disparan',
    'El Nuevo MV de {artist} Tiene un Mensaje Oculto Que Debes Conocer',
  ],
  interview: [
    '{artist} Hablan Sin Filtros: Lo Que Revelaron en Su Entrevista',
    'Exclusiva: {artist} Comparten Sus Planes y Emociones',
    '{artist} Se Abren como Nunca en una Entrevista Especial',
  ],
  general: [
    'La Noticia del K-Pop Que Todo Fan Debe Conocer',
    'Lo Mas Importante del Mundo K-Pop Esta Semana',
    'ALBA Te Cuenta: Las Novedades del K-Pop',
  ],
};

const NO_ARTIST_TEMPLATES = [
  'La Noticia del K-Pop Que Todo Fan Debe Conocer',
  'Lo Mas Importante del Mundo K-Pop Esta Semana',
  'ALBA Te Cuenta: Las Novedades del K-Pop',
  'El K-Pop No Para: Resumen de las Ultimas Noticias',
  'Esto Es Lo Que Esta Pasando en el Mundo K-Pop',
  'ALBA Seleccion: Lo Mejor de la Semana en K-Pop',
  'Noticias Frescas del K-Pop para los Fans Latinos',
  'El Mundo del K-Pop en Espanol: Lo Que No Te Puedes Perder',
];

// ---- Helper ----

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// ---- Artist extraction ----

const COMMON_ENGLISH_WORDS = new Set([
  'the', 'a', 'an', 'this', 'that', 'these', 'here', 'why', 'how', 'what',
  'when', 'who', 'which', 'where', 'watch', 'check', 'best', 'top', 'new',
  'breaking', 'exclusive', 'official', 'first', 'latest', 'all', 'every',
  'open', 'just', 'more', 'most', 'some', 'many', 'after', 'before',
  'korean', 'kpop', 'k-pop', 'idol', 'idols', 'legendary', 'former',
  'young', 'old', 'big', 'small', 'great', 'good', 'bad', 'real',
  'full', 'final', 'last', 'next', 'other', 'another', 'each', 'both',
  'only', 'even', 'still', 'also', 'already', 'never', 'always', 'again',
  'now', 'then', 'today', 'week', 'weekly', 'daily', 'year', 'month',
  'thread', 'list', 'review', 'reviews', 'roundup', 'recap', 'guide',
  'report', 'reports', 'update', 'updates', 'news', 'story', 'stories',
  'song', 'songs', 'album', 'albums', 'track', 'tracks', 'single', 'singles',
  'music', 'video', 'drama', 'movie', 'show', 'shows', 'stage', 'live',
  'tour', 'concert', 'award', 'awards', 'chart', 'charts', 'record',
  'debut', 'comeback', 'release', 'releases', 'performance', 'cover',
  'photo', 'photos', 'fashion', 'style', 'beauty', 'look', 'looks',
  'will', 'can', 'could', 'would', 'should', 'may', 'might', 'must',
  'does', 'did', 'has', 'had', 'have', 'been', 'being', 'are', 'were',
  'get', 'gets', 'got', 'make', 'makes', 'made', 'take', 'takes', 'took',
  'give', 'gives', 'gave', 'come', 'comes', 'came', 'keep', 'keeps', 'kept',
  'let', 'say', 'says', 'said', 'see', 'sees', 'saw', 'know', 'knows',
  'think', 'find', 'finds', 'want', 'wants', 'tell', 'tells',
  'ask', 'asks', 'work', 'works', 'seem', 'seems', 'feel', 'feels',
  'try', 'tries', 'start', 'starts', 'need', 'needs', 'run', 'runs',
  'move', 'moves', 'play', 'plays', 'pay', 'pays', 'hear', 'hears',
  'during', 'about', 'with', 'from', 'into', 'over', 'under', 'between',
  'through', 'against', 'without', 'within', 'along', 'behind',
  'inside', 'outside', 'above', 'below', 'upon', 'onto', 'toward',
  'for', 'but', 'not', 'yet', 'nor', 'and', 'or', 'so',
  'while', 'since', 'until', 'unless', 'because', 'although', 'though',
  'if', 'than', 'whether', 'once', 'twice',
  'his', 'her', 'its', 'our', 'their', 'my', 'your',
  'he', 'she', 'it', 'we', 'they', 'you', 'me', 'him', 'us', 'them',
  'no', 'yes', 'not', "don't", "doesn't", "didn't", "won't", "can't",
  'eight', 'five', 'four', 'nine', 'one', 'seven', 'six', 'ten', 'three', 'two',
  'up', 'down', 'out', 'off', 'on', 'in', 'at', 'to', 'by', 'of',
  'coming', 'going', 'looking', 'rising', 'star', 'stars',
  'spill', 'spills', 'choi', 'lee', 'kim', 'park', 'jung', 'shin',
  'won', 'young', 'min', 'sung', 'hyun', 'jae', 'hye',
]);

const SHORT_AMBIGUOUS_NAMES = new Set(['V', 'TOP', 'CL', 'JB', 'DK', 'Jun', 'Jay', 'Kai', 'Lay', 'Bom', 'Liz', 'Bae', 'Han', 'San', 'Rei', 'Lia']);

function extractArtist(title) {
  for (const name of ALL_KNOWN_NAMES) {
    if (SHORT_AMBIGUOUS_NAMES.has(name)) continue;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(?:^|[\\s,;:'"(\\[])${escaped}(?=[\\s,;:'"')\\]!?.]|$)`, 'i');
    if (re.test(title)) return name;
  }

  for (const name of SHORT_AMBIGUOUS_NAMES) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(?:^|[\\s,;:'"(\\[])${escaped}(?=[\\s,;:'"')\\]!?.]|$)`);
    if (re.test(title)) {
      const pos = title.indexOf(name);
      if (pos <= 5) return name;
    }
  }

  const leadingName = title.match(/^([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})\b/);
  if (leadingName) {
    const candidate = leadingName[1];
    const words = candidate.split(/\s+/);
    const allWordsValid = words.every(w => !COMMON_ENGLISH_WORDS.has(w.toLowerCase()));
    if (allWordsValid && words.length >= 2 && words.length <= 4) return candidate;
  }

  return null;
}

function classifyTopic(title) {
  const lower = title.toLowerCase();
  for (const [topic, keywords] of Object.entries(TOPIC_KEYWORDS)) {
    for (const kw of keywords) {
      if (lower.includes(kw)) return topic;
    }
  }
  return 'general';
}

function rewriteTitle(originalTitle, source) {
  const artist = extractArtist(originalTitle);
  const topic = classifyTopic(originalTitle);

  if (artist) {
    const templates = TITLE_TEMPLATES[topic] || TITLE_TEMPLATES.general;
    const template = pickRandom(templates);
    return template.replace(/\{artist\}/g, artist);
  }

  return pickRandom(NO_ARTIST_TEMPLATES);
}

// ============================================================
// Image downloading
// ============================================================

const IMAGES_DIR = join(__dirname, 'images');
const ARTICLES_DIR = join(__dirname, 'articles');

async function downloadImage(url, filename) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Referer': new URL(url).origin,
      },
    });
    clearTimeout(timer);

    if (!res.ok || !res.body) return null;
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('image')) return null;

    const ext = contentType.includes('png') ? '.png'
      : contentType.includes('webp') ? '.webp'
      : '.jpg';
    const localFile = `${filename}${ext}`;
    const localPath = join(IMAGES_DIR, localFile);

    const buffer = Buffer.from(await res.arrayBuffer());
    await writeFile(localPath, buffer);
    return `images/${localFile}`;
  } catch {
    return null;
  }
}

async function downloadArticleImages(articles) {
  await mkdir(IMAGES_DIR, { recursive: true });
  log('Downloading article images locally...');
  let downloaded = 0;
  const BATCH = 8;

  for (let i = 0; i < articles.length; i += BATCH) {
    const batch = articles.slice(i, i + BATCH);
    await Promise.allSettled(
      batch.map(async (article, idx) => {
        if (!article.image || article.image.includes('picsum.photos')) return;
        const safeName = `article-${i + idx}-${Date.now() % 100000}`;
        const localPath = await downloadImage(article.image, safeName);
        if (localPath) {
          article.originalImage = article.image;
          article.image = localPath;
          downloaded++;
        }
      })
    );
  }
  log(`  Downloaded ${downloaded}/${articles.length} images locally`);
}

// ============================================================
// Category mapping — ALBA categories
// ============================================================

const CATEGORY_COLORS = {
  MUSICA: '#e74c3c',
  ESTILO: '#9b59b6',
  CULTURA: '#2ecc71',
  'EN VIVO': '#3498db',
  PREMIOS: '#f5a623',
  TV: '#3498db',
  SOCIAL: '#9b59b6',
  COLLAB: '#e74c3c',
  DEBUT: '#2ecc71',
  CHARTS: '#e74c3c',
  DESTACADO: '#f5a623',
};

function displayCategory(category) {
  const lower = (category || '').toLowerCase();
  if (lower.includes('music') || lower.includes('k-pop') || lower.includes('kpop')) return 'MUSICA';
  if (lower.includes('fashion') || lower.includes('beauty') || lower.includes('style')) return 'ESTILO';
  if (lower.includes('drama') || lower.includes('culture') || lower.includes('movie') || lower.includes('film')) return 'CULTURA';
  if (lower.includes('concert') || lower.includes('tour') || lower.includes('live')) return 'EN VIVO';
  if (lower.includes('award') || lower.includes('prize')) return 'PREMIOS';
  if (lower.includes('tv') || lower.includes('variety') || lower.includes('show')) return 'TV';
  if (lower.includes('social') || lower.includes('viral') || lower.includes('sns')) return 'SOCIAL';
  if (lower.includes('collab')) return 'COLLAB';
  if (lower.includes('debut')) return 'DEBUT';
  if (lower.includes('chart')) return 'CHARTS';
  return 'MUSICA';
}

function categoryColor(displayCat) {
  return CATEGORY_COLORS[displayCat] || '#f5a623';
}

function badgeClass(displayCat) {
  switch (displayCat) {
    case 'MUSICA': case 'CHARTS': case 'COLLAB': return 'badge-musica';
    case 'ESTILO': case 'SOCIAL': return 'badge-estilo';
    case 'CULTURA': case 'DEBUT': return 'badge-cultura';
    case 'EN VIVO': case 'TV': return 'badge-envivo';
    default: return 'badge-default';
  }
}

// ============================================================
// RSS Feed Parsing
// ============================================================

function parseRssFeed(xml, sourceName) {
  const items = extractItems(xml);
  const articles = [];

  for (const item of items) {
    const title = decodeHtmlEntities(stripHtml(extractTag(item, 'title')));
    const link = extractTag(item, 'link');
    const pubDate = extractTag(item, 'pubDate');
    const creator = extractTag(item, 'dc:creator');
    const categories = extractAllTags(item, 'category').map(c => decodeHtmlEntities(stripHtml(c)));
    const category = categories[0] || 'News';
    const description = extractTag(item, 'description');
    const contentEncoded = extractTag(item, 'content:encoded');

    let image = extractImageFromContent(item);
    if (!image) image = extractImageFromContent(contentEncoded);
    if (!image) image = extractImageFromContent(description);

    if (!title || !link) continue;

    articles.push({
      title,
      link,
      pubDate: pubDate ? new Date(pubDate) : new Date(),
      formattedDate: formatDate(pubDate),
      creator,
      category,
      categories,
      image,
      source: sourceName,
      articleContent: null,
    });
  }
  return articles;
}

// ============================================================
// Fetch all feeds
// ============================================================

async function fetchAllFeeds() {
  const allArticles = [];

  for (const source of SOURCES) {
    try {
      log(`Fetching ${source.name}...`);
      const xml = await fetchWithTimeout(source.url);
      const articles = parseRssFeed(xml, source.name);
      log(`  ${source.name}: ${articles.length} articles`);
      allArticles.push(...articles);
    } catch (err) {
      warn(`Failed to fetch ${source.name}: ${err.message}`);
    }
  }

  allArticles.sort((a, b) => b.pubDate.getTime() - a.pubDate.getTime());
  log(`Total: ${allArticles.length} articles`);
  return allArticles;
}

// ============================================================
// Fill missing images via og:image
// ============================================================

async function fillMissingImages(articles) {
  const needsImage = articles.filter(a => !a.image);
  if (needsImage.length === 0) return;

  const toFetch = needsImage.slice(0, MAX_OG_IMAGE_FETCHES);
  log(`Extracting og:image for ${toFetch.length} articles (concurrency: ${OG_IMAGE_CONCURRENCY})...`);

  let found = 0;
  for (let i = 0; i < toFetch.length; i += OG_IMAGE_CONCURRENCY) {
    const batch = toFetch.slice(i, i + OG_IMAGE_CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (article) => {
        const ogImage = await fetchOgImage(article.link);
        if (ogImage) { article.image = ogImage; return true; }
        return false;
      })
    );
    found += results.filter(r => r.status === 'fulfilled' && r.value === true).length;
  }
  log(`  Found og:image for ${found}/${toFetch.length} articles`);
}

// ============================================================
// Fetch article content
// ============================================================

function extractArticleContent(html) {
  let cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<aside[\s\S]*?<\/aside>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<div[^>]*class\s*=\s*["'][^"']*(?:sidebar|comment|social|share|related|ad-|ads-|advertisement|cookie|popup|modal|newsletter)[^"']*["'][\s\S]*?<\/div>/gi, '');

  const articleBodyPatterns = [
    /<article[^>]*>([\s\S]*?)<\/article>/i,
    /<div[^>]*class\s*=\s*["'][^"']*(?:article-body|article-content|entry-content|post-content|story-body|content-body|single-content)[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
    /<div[^>]*class\s*=\s*["'][^"']*(?:post-entry|article-text|body-text|main-content|article__body|post__content)[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
  ];

  let bodyHtml = '';
  for (const pattern of articleBodyPatterns) {
    const match = cleaned.match(pattern);
    if (match) { bodyHtml = match[1]; break; }
  }
  if (!bodyHtml) bodyHtml = cleaned;

  const paragraphs = [];
  const pRegex = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  let pMatch;
  while ((pMatch = pRegex.exec(bodyHtml)) !== null) {
    const text = stripHtml(decodeHtmlEntities(pMatch[1])).trim();
    if (text.length > 30 &&
        !text.match(/^(advertisement|sponsored|also read|read more|related:|source:|photo:|credit:|getty|shutterstock|loading)/i)) {
      paragraphs.push(text);
    }
  }

  const images = [];
  const imgRegex = /<img[^>]+src\s*=\s*["']([^"']+)["'][^>]*>/gi;
  let imgMatch;
  while ((imgMatch = imgRegex.exec(bodyHtml)) !== null) {
    const src = imgMatch[1];
    if (src && !src.includes('avatar') && !src.includes('icon') && !src.includes('logo') &&
        !src.includes('1x1') && !src.includes('pixel') && !src.includes('tracking')) {
      images.push(src);
    }
  }

  return { paragraphs, images };
}

async function fetchArticleContent(article) {
  try {
    const html = await fetchWithTimeout(article.link, ARTICLE_FETCH_TIMEOUT);
    return extractArticleContent(html);
  } catch {
    return { paragraphs: [], images: [] };
  }
}

async function fetchAllArticleContent(articles) {
  const toFetch = articles.slice(0, 50);
  log(`Fetching full article content for ${toFetch.length} articles (concurrency: ${ARTICLE_FETCH_CONCURRENCY})...`);

  let fetched = 0;
  for (let i = 0; i < toFetch.length; i += ARTICLE_FETCH_CONCURRENCY) {
    const batch = toFetch.slice(i, i + ARTICLE_FETCH_CONCURRENCY);
    await Promise.allSettled(
      batch.map(async (article) => {
        const content = await fetchArticleContent(article);
        if (content.paragraphs.length > 0) {
          article.articleContent = content;
          fetched++;
        }
      })
    );
  }
  log(`  Fetched content for ${fetched}/${toFetch.length} articles`);
}

// ============================================================
// Spanish article body generation
// ============================================================

const BODY_TEMPLATES = {
  comeback: {
    opening: [
      'La espera termino. {artist} han confirmado su regreso a la escena musical con un comeback que promete ser uno de los mas impactantes del ano. La noticia ha revolucionado las redes sociales, donde los fans latinos no tardaron en expresar su emocion con mensajes de apoyo y expectativa.',
      'El K-Pop esta de fiesta: {artist} regresan con todo. Despues de un periodo de preparacion, el grupo ha revelado los primeros detalles de su tan esperado comeback, generando una ola de entusiasmo entre la comunidad fan de habla hispana.',
      'Algo grande se acerca en el mundo del K-Pop. {artist} han anunciado oficialmente su regreso, y las senales apuntan a un concepto completamente renovado que dejara huella en la industria musical.',
    ],
    analysis: [
      'Fuentes cercanas al grupo indican que {artist} han invertido meses en la preparacion de este comeback, participando activamente en el proceso creativo. La produccion musical ha contado con colaboradores de primer nivel, y se espera que el resultado refleje una evolucion artistica significativa respecto a sus trabajos anteriores.',
      'El impacto de {artist} en el mercado latinoamericano no puede subestimarse. Con una base de fans que crece exponencialmente en paises como Mexico, Colombia, Argentina y Chile, este comeback tiene el potencial de romper records de streaming en la region. Las previas ya acumulan millones de reproducciones.',
      'Los teasers publicados por {artist} han generado teorias y analisis en toda la comunidad fan. Desde los colores de la paleta visual hasta las referencias musicales, cada detalle ha sido examinado con lupa por los fans, creando un ambiente de anticipacion que pocas veces se ha visto.',
    ],
    closing: [
      'La redaccion de ALBA seguira de cerca cada paso de {artist} en este nuevo capitulo. Mantente al tanto de todas las novedades y actualizaciones sobre este esperado comeback.',
      'El regreso de {artist} promete marcar un antes y un despues en la escena K-Pop de este ano. ALBA te mantendra informado de cada novedad.',
    ],
  },
  release: {
    opening: [
      '{artist} han dado a conocer su mas reciente trabajo musical, un lanzamiento que ya esta dando de que hablar en las plataformas digitales y en las listas de exitos a nivel global. La propuesta artistica del nuevo material demuestra la constante evolucion del grupo.',
      'El nuevo lanzamiento de {artist} ya esta disponible y las primeras reacciones son abrumadoramente positivas. Con un sonido fresco y letras que conectan con la audiencia, esta produccion promete posicionarse como una de las mejores del ano en el K-Pop.',
      'Llego el dia que millones de fans esperaban: {artist} presentan su nuevo material al mundo. Desde el primer segundo, queda claro que este lanzamiento es diferente a todo lo anterior.',
    ],
    analysis: [
      'El tracklist del nuevo lanzamiento de {artist} revela una exploracion musical ambiciosa. Cada cancion aporta algo diferente: desde baladas emotivas hasta temas con ritmos latinos que resuenan especialmente con la audiencia hispanohablante. La produccion es impecable y el concepto visual complementa perfectamente la narrativa sonora.',
      'Los criticos musicales coinciden en que {artist} han logrado un equilibrio perfecto entre accesibilidad comercial y profundidad artistica. Las primeras 24 horas del lanzamiento ya rompen tendencias en redes sociales, y los numeros de streaming apuntan a cifras historicas.',
      'Lo que distingue a este lanzamiento de {artist} es la autenticidad. En una era donde el K-Pop se reinventa constantemente, {artist} han encontrado su propia voz sin perder la esencia que los convirtio en favoritos de millones.',
    ],
    closing: [
      'ALBA te recomienda escuchar este lanzamiento de principio a fin. La experiencia completa vale cada segundo. Seguiremos cubriendo la trayectoria de {artist} con toda la pasion que se merecen.',
      'Con este nuevo material, {artist} consolidan su posicion como uno de los actos mas relevantes del K-Pop actual. ALBA continuara brindandote la cobertura mas completa.',
    ],
  },
  concert: {
    opening: [
      'La energia era palpable desde horas antes. {artist} han demostrado una vez mas por que son una de las experiencias en vivo mas poderosas del K-Pop actual. El show fue una mezcla perfecta de talento, produccion de primer nivel y conexion genuina con el publico.',
      '{artist} incendiaron el escenario en una noche que los fans no olvidaran jamas. Desde la primera cancion hasta el ultimo encore, la energia no bajo ni un segundo. Esta es la cronica de un concierto que hizo historia.',
      'Las luces se apagaron, el publico contuvo el aliento, y {artist} aparecieron en escena. Lo que siguio fue un espectaculo de proporciones epicas que confirma el estatus del grupo como uno de los mejores en vivo de la industria.',
    ],
    analysis: [
      'El setlist del concierto de {artist} fue una seleccion magistral que abarcaba desde sus exitos mas iconicos hasta las canciones mas recientes. Los momentos de interaccion con el publico fueron especialmente emotivos, con mensajes en espanol que arrancaron lagrimas y gritos de emocion entre los asistentes.',
      'La produccion del show de {artist} merece una mencion aparte. Efectos visuales de ultima generacion, coreografias ejecutadas a la perfeccion y una banda sonora envolvente crearon una experiencia inmersiva que va mas alla de un simple concierto. Es entretenimiento de clase mundial.',
      'Los fans que asistieron al evento compartieron sus experiencias en redes sociales, convirtiendo el hashtag del concierto en tendencia global. Videos de fancams captaron momentos que se han vuelto virales, demostrando la pasion desbordante de la comunidad fan latina.',
    ],
    closing: [
      'Si no pudiste asistir, esperamos que esta cronica te haya acercado un poco a la experiencia. ALBA te informara sobre las proximas fechas de {artist} en Latinoamerica.',
      'Las giras de {artist} siempre dejan huella. ALBA estara presente en cada parada para traerte la mejor cobertura en espanol.',
    ],
  },
  award: {
    opening: [
      'Noche historica para {artist}. En una ceremonia llena de emociones, el grupo se llevo el reconocimiento que corona meses de trabajo incansable y excelencia artistica. Los fans celebran este triunfo como propio, porque en el K-Pop, cada victoria es compartida.',
      '{artist} hicieron historia al subir al escenario a recibir uno de los premios mas prestigiosos de la industria musical. El momento fue capturado por millones de pantallas alrededor del mundo, y la reaccion fue unanime: lo merecian.',
      'La gala de premios tenia muchos nominados, pero solo un nombre resuena con fuerza esta manana: {artist}. Su victoria no es una sorpresa para quienes han seguido su trayectoria, pero la emocion del momento fue genuina y conmovedora.',
    ],
    analysis: [
      'La victoria de {artist} refleja no solo la calidad de su trabajo reciente, sino tambien el impacto cultural que han tenido a nivel global. Los votantes reconocieron la innovacion musical, la excelencia en performances en vivo y la conexion unica que {artist} mantienen con su fandom.',
      'En su discurso de aceptacion, {artist} no olvidaron a los fans de habla hispana, dedicandoles palabras en espanol que provocaron una explosion de emociones en redes sociales. Este gesto demuestra la importancia que America Latina tiene para el grupo.',
    ],
    closing: [
      'Desde ALBA, felicitamos a {artist} por este merecido reconocimiento. Seguiremos celebrando cada logro junto a ustedes, la mejor comunidad fan del mundo.',
      'La noche de premios confirmo lo que ya sabiamos: {artist} estan en la cima. ALBA seguira documentando su camino hacia la gloria.',
    ],
  },
  fashion: {
    opening: [
      '{artist} no solo dominan los escenarios musicales, tambien son referentes indiscutibles del mundo de la moda. Su ultimo look ha generado un terremoto en las redes sociales, con fans y criticos de moda analizando cada detalle de su estilismo.',
      'El estilo de {artist} sigue marcando tendencia. Con una combinacion audaz de alta costura y streetwear, el grupo demuestra que la moda K-Pop es mucho mas que un complemento: es una forma de expresion artistica.',
      'Cuando {artist} aparecen en publico, las camaras no paran. Su ultimo look ha sido catalogado como uno de los mas iconicos del ano en la moda K-Pop, y no es para menos.',
    ],
    analysis: [
      'Los estilistas de {artist} han logrado crear una identidad visual unica que combina elementos de la moda coreana con influencias globales. Las piezas seleccionadas para este look provienen de marcas de lujo que compiten por vestir al grupo, lo que demuestra su enorme influencia en la industria.',
      'El "efecto {artist}" en la moda es real: cada prenda que lucen se agota en cuestion de horas. Las marcas latinoamericanas ya toman nota, y no seria sorprendente ver colaboraciones en el futuro cercano. La conexion entre K-Pop y moda en America Latina es cada vez mas fuerte.',
    ],
    closing: [
      'El estilo de {artist} seguira evolucionando, y ALBA estara aqui para documentar cada transformacion. La moda K-Pop nunca habia sido tan emocionante.',
      'ALBA seguira cubriendo los momentos mas iconicos de {artist} en el mundo de la moda. Porque el K-Pop no solo se escucha, se vive y se viste.',
    ],
  },
  variety: {
    opening: [
      'Mas alla de la musica, {artist} demuestran que su carisma no tiene limites. Su reciente aparicion en television ha dejado momentos memorables que ya circulan por todas las redes sociales, arrancando risas y suspiros a partes iguales.',
      '{artist} conquistaron la pantalla chica con una aparicion que mostro su lado mas autentico y divertido. Los fans no pararon de compartir clips de los mejores momentos, convirtiendo al grupo en tendencia mundial.',
    ],
    analysis: [
      'Lo que hace especial las apariciones televisivas de {artist} es la naturalidad con la que se desenvuelven. Sin guion y sin filtros, el grupo muestra una quimica entre sus miembros que resulta irresistible para los espectadores. Los momentos de comedia no ensayada son oro puro para los fans.',
      'Las redes sociales hispanohablantes explotaron con subtitulos en espanol de los mejores momentos. La comunidad fan latina es conocida por su rapidez al traducir y compartir contenido, asegurando que ninguna perla de {artist} se pierda.',
    ],
    closing: [
      'La versatilidad de {artist} es una de sus mayores fortalezas. ALBA te mantendra al tanto de sus proximas apariciones en la pantalla.',
    ],
  },
  sns: {
    opening: [
      'Las redes sociales volvieron a arder por culpa de {artist}. Una publicacion aparentemente simple se convirtio en fenomeno viral en cuestion de minutos, acumulando millones de interacciones y generando conversaciones en todo el mundo.',
      '{artist} saben como dominar las redes. Su ultima publicacion ha roto Internet, y los fans latinos fueron los primeros en hacer eco del contenido, compartiendolo con la pasion que caracteriza a la comunidad hispanohablante del K-Pop.',
    ],
    analysis: [
      'El dominio de {artist} en las redes sociales no es casualidad. Cada publicacion esta cuidadosamente pensada para conectar con su audiencia global, y los resultados hablan por si solos: millones de likes, comentarios y shares que consolidan su posicion como una de las cuentas mas influyentes del entretenimiento.',
      'La comunidad fan hispanohablante jugo un papel crucial en hacer viral este contenido. Con traducciones instantaneas, memes creativos y threads de analisis, los fans latinos demostraron una vez mas por que son una de las fuerzas mas poderosas del fandom K-Pop global.',
    ],
    closing: [
      '{artist} siguen demostrando que las redes sociales son su territorio. ALBA te traera cada momento viral que no te puedes perder.',
    ],
  },
  collab: {
    opening: [
      'La colaboracion que nadie veia venir pero que todos necesitabamos. {artist} han unido fuerzas en un proyecto musical que fusiona estilos y rompe barreras. La noticia ha generado una ola de entusiasmo sin precedentes entre los fans.',
      '{artist} sorprenden al mundo con una alianza musical que promete ser historica. Los primeros adelantos de esta colaboracion han dejado a los fans con la boca abierta, anticipando lo que podria ser uno de los lanzamientos mas importantes del ano.',
    ],
    analysis: [
      'Esta colaboracion demuestra que {artist} no le temen a la experimentacion. Al combinar sus fortalezas musicales con un estilo completamente diferente, el resultado es una propuesta fresca que tiene el potencial de llegar a audiencias que normalmente no escuchan K-Pop.',
      'Los fans de ambos lados han recibido la noticia con entusiasmo, creando un cruce de fandoms que beneficia a todos. En redes sociales, la etiqueta de la colaboracion ya es tendencia mundial, con los fans latinos liderando la conversacion.',
    ],
    closing: [
      'ALBA seguira de cerca esta colaboracion que promete romper barreras. Mantente conectado para no perderte ningun detalle.',
    ],
  },
  debut: {
    opening: [
      'El K-Pop tiene un nuevo nombre que memorizar: {artist}. Con un debut que ha dejado a la industria sin palabras, este nuevo acto promete revolucionar la escena musical. La energia, el talento y la vision artistica estan ahi desde el primer segundo.',
      'Atencion, fans del K-Pop: {artist} han llegado para quedarse. Su debut es una declaracion de intenciones que deja claro que estamos ante algo especial. Desde la produccion musical hasta el concepto visual, todo apunta a una nueva era.',
    ],
    analysis: [
      'Lo que distingue el debut de {artist} de otros lanzamientos recientes es la madurez artistica que demuestran desde el inicio. La cancion debut no es solo catchy, es una pieza musical bien construida que revela las multiples facetas del grupo. Los criticos ya los senalan como uno de los debuts mas prometedores.',
      'La recepcion en America Latina ha sido particularmente calida. Los fans hispanohablantes han adoptado a {artist} desde el primer momento, creando contenido de bienvenida y expresando su apoyo en redes sociales con la pasion que los caracteriza.',
    ],
    closing: [
      'El camino recien comienza para {artist}, y ALBA estara ahi para documentar cada paso. Bienvenidos a la familia del K-Pop.',
    ],
  },
  chart: {
    opening: [
      'Los numeros no mienten: {artist} estan arrasando en las listas de exitos a nivel mundial. Los records caen uno tras otro mientras el grupo consolida su posicion como una de las fuerzas mas dominantes de la musica actual.',
      '{artist} han logrado lo que pocos artistas consiguen: dominar las listas de exitos de multiples paises simultaneamente. Este logro historico refleja no solo la calidad de su musica, sino tambien la dedicacion incansable de su fandom global.',
    ],
    analysis: [
      'Analizando los datos de streaming y ventas, queda claro que el exito de {artist} no es un fenomeno pasajero. Los numeros muestran un crecimiento sostenido, con America Latina representando uno de los mercados de mayor expansion para el grupo.',
      'El impacto de {artist} en las listas se extiende mas alla de los charts de K-Pop. Su presencia en el Billboard Global 200 y en las listas de Spotify confirma que la musica del grupo trasciende generos y fronteras.',
    ],
    closing: [
      'Los records estan para romperse, y {artist} lo saben bien. ALBA te mantendra informado de cada nuevo hito en la carrera del grupo.',
    ],
  },
  mv: {
    opening: [
      'El nuevo video musical de {artist} es una obra de arte visual que merece ser analizada cuadro por cuadro. Desde la cinematografia hasta la narrativa simbolica, cada segundo esta cargado de intencion y significado.',
      '{artist} han elevado el estandar de los videos musicales K-Pop con su ultima produccion. Las vistas se disparan mientras los fans descubren capas y capas de significado oculto en cada escena.',
    ],
    analysis: [
      'El MV de {artist} destaca por su impecable direccion artistica. Los colores, las transiciones y los efectos visuales crean una experiencia inmersiva que complementa perfectamente la narrativa de la cancion. Es entretenimiento visual de primer nivel.',
      'Los fans ya han identificado multiples easter eggs y conexiones con trabajos anteriores de {artist}. Las teorias se multiplican en redes sociales, y la comunidad latina no se queda atras, aportando analisis detallados.',
    ],
    closing: [
      'Te recomendamos ver el MV al menos dos veces: una para disfrutarlo y otra para descubrir todos los detalles ocultos. ALBA seguira analizando el universo visual de {artist}.',
    ],
  },
  interview: {
    opening: [
      '{artist} se abren como nunca en una entrevista que revela el lado mas humano del grupo. Con honestidad y emotividad, compartieron sus pensamientos sobre la musica, los fans y el futuro que les espera.',
      'En una conversacion sin filtros, {artist} hablaron sobre los desafios, las alegrias y los suenos que los impulsan cada dia. La entrevista es un recordatorio de que detras de los escenarios hay personas con historias que merecen ser contadas.',
    ],
    analysis: [
      'Lo mas revelador de la entrevista fue la sinceridad con la que {artist} hablaron sobre la presion de la fama y la importancia de mantenerse fieles a si mismos. Sus palabras resonaron especialmente con los fans latinos, quienes valoran la autenticidad por encima de todo.',
      '{artist} aprovecharon la oportunidad para enviar un mensaje especial a sus fans de habla hispana, expresando su gratitud y su deseo de visitar Latinoamerica pronto. Las palabras provocaron una ola de emocion en las redes sociales.',
    ],
    closing: [
      'Cada entrevista de {artist} nos acerca un poco mas a conocer a las personas detras de la musica. ALBA seguira trayendote los momentos mas genuinos.',
    ],
  },
  general: {
    opening: [
      'El mundo del K-Pop nos trae una noticia que todo fan debe conocer. {artist} vuelven a ser protagonistas de una historia que demuestra por que este genero sigue cautivando a millones de personas alrededor del mundo.',
      '{artist} se mantienen en el centro de la conversacion del K-Pop con una novedad que ha generado gran expectativa. En ALBA te contamos todos los detalles.',
      'La escena K-Pop no descansa, y {artist} son prueba de ello. Una nueva informacion sobre el grupo ha salido a la luz, y la comunidad fan ya esta analizando cada aspecto.',
    ],
    analysis: [
      'La trayectoria de {artist} ha estado marcada por una constante evolucion que los mantiene relevantes en una industria que cambia a velocidad vertiginosa. Este ultimo movimiento demuestra una vez mas su capacidad para sorprender y emocionar.',
      'La reaccion de los fans ha sido inmediata y apasionada. En redes sociales, las conversaciones sobre {artist} dominan las tendencias, con la comunidad latina aportando perspectivas unicas y contenido creativo que enriquece la experiencia colectiva del fandom.',
      'Desde la perspectiva de la industria musical, las acciones de {artist} reflejan una estrategia inteligente que combina autenticidad artistica con una comprension profunda de lo que su audiencia global necesita y desea.',
    ],
    closing: [
      'ALBA continuara siguiendo de cerca cada movimiento de {artist}. Mantente conectado para no perderte ninguna novedad del mundo K-Pop.',
      'La historia de {artist} sigue escribiendose, y ALBA esta aqui para contartela en espanol. No te pierdas nuestras actualizaciones.',
    ],
  },
};

const NO_ARTIST_BODY = {
  opening: [
    'El K-Pop nos regala otra noticia que merece toda nuestra atencion. La escena musical coreana sigue evolucionando a un ritmo impresionante, y los fans de habla hispana estamos en primera fila para disfrutarlo.',
    'Algo importante esta sucediendo en el mundo del K-Pop, y en ALBA no queremos que te lo pierdas. La industria del entretenimiento coreano no para de sorprendernos con novedades que sacuden el panorama musical global.',
    'El ecosistema del K-Pop vuelve a dar de que hablar con una noticia que ha captado la atencion de la comunidad fan internacional. Desde ALBA te contamos los detalles.',
  ],
  analysis: [
    'Esta noticia refleja la dinamica constante del K-Pop, un genero que se reinventa con cada nuevo lanzamiento y evento. Para los fans latinoamericanos, este tipo de desarrollos son especialmente relevantes porque confirman el crecimiento del genero en la region.',
    'Los datos muestran que el K-Pop sigue ganando terreno en America Latina. Las plataformas de streaming reportan cifras record de escucha desde paises como Mexico, Brasil, Colombia y Argentina, consolidando a la region como un mercado clave para la industria.',
  ],
  closing: [
    'ALBA seguira trayendote las noticias mas relevantes del mundo K-Pop, siempre en espanol y con la pasion que nos caracteriza. Mantente conectado.',
    'No te pierdas nuestras proximas publicaciones. ALBA es tu fuente numero uno de K-Pop en espanol.',
  ],
};

const SHARED_PARAGRAPHS = {
  background: [
    'La presencia de {artist} en America Latina ha crecido de manera exponencial en los ultimos anos. Desde conciertos sold-out hasta trending topics en redes sociales, el grupo ha construido una base de fans leales que trasciende las barreras del idioma. La conexion con el publico hispanohablante es genuina y se fortalece con cada nuevo proyecto.',
    'La trayectoria de {artist} es un ejemplo perfecto de perseverancia y talento. Desde sus inicios, el grupo ha demostrado una etica de trabajo admirable y un compromiso inquebrantable con la excelencia artistica. Cada comeback, cada presentacion, cada interaccion con los fans refleja esa dedicacion.',
    'En el competitivo paisaje del K-Pop, {artist} han logrado diferenciarse con una identidad artistica unica. Su sonido, su estetica visual y su forma de conectar con la audiencia los posicionan como uno de los actos mas completos de la industria actual.',
    'El K-Pop en America Latina no es una moda pasajera, y {artist} son prueba viviente de ello. Con cada nuevo proyecto, el grupo refuerza los lazos culturales entre Corea y la comunidad hispanohablante, creando un puente musical que une dos mundos aparentemente distantes.',
    'Los numeros respaldan la influencia de {artist}: millones de reproducciones en streaming, tendencias mundiales en redes sociales y una demanda creciente de contenido en espanol. El grupo ha entendido que el mercado latino es fundamental para su crecimiento global.',
  ],
  detail: [
    'Fuentes cercanas al grupo confirman que {artist} han trabajado intensamente en cada aspecto de este proyecto. La atencion al detalle es evidente, desde la seleccion musical hasta el concepto visual, pasando por la coreografia y la narrativa. Nada se deja al azar cuando se trata de {artist}.',
    'Las reacciones en redes sociales han sido inmediatas y masivas. El hashtag relacionado con {artist} se posiciono como tendencia mundial en cuestion de minutos, impulsado en gran medida por los fans latinoamericanos que demostraron, una vez mas, su capacidad organizativa y su pasion incondicional.',
    'Desde la perspectiva de la industria, el movimiento de {artist} forma parte de una tendencia mas amplia en el K-Pop: la globalizacion real del genero. Ya no se trata solo de exportar musica coreana, sino de crear contenido que resuene autentica y emocionalmente con audiencias diversas alrededor del mundo.',
    'Los analistas del entretenimiento senalan que {artist} han logrado algo que pocos artistas consiguen: mantener la frescura y la relevancia a lo largo del tiempo. En una industria donde la rotacion es rapida, la longevidad de {artist} es testimonio de su calidad constante.',
    'El ecosistema fan de {artist} es uno de los mas organizados y creativos del K-Pop. Desde proyectos de streaming coordinados hasta eventos de apoyo social, el fandom demuestra que la pasion por la musica puede canalizarse en acciones positivas que trascienden el entretenimiento.',
  ],
  reaction: [
    'La comunidad fan hispanohablante no tardo en responder. Desde Mexico hasta Argentina, desde Colombia hasta Espana, los fans de {artist} inundaron las redes con mensajes de apoyo, analisis detallados y contenido creativo que demuestra el nivel de compromiso de la base de fans latina.',
    'En plataformas como X, TikTok e Instagram, los fans latinos de {artist} lideraron la conversacion global. Subtitulos en espanol, ediciones de video, threads informativos y memes creativos se multiplicaron rapidamente, demostrando la velocidad y creatividad del fandom hispanohablante.',
    'Las reacciones de otros fandoms tambien fueron notables. Artistas y fans de diferentes grupos reconocieron el logro de {artist}, generando un ambiente de celebracion colectiva que es una de las mejores caracteristicas de la comunidad K-Pop.',
    'Los fans latinoamericanos de {artist} organizaron watch parties virtuales y presenciales para compartir la experiencia en comunidad. Estos eventos demuestran que el K-Pop en la region va mas alla del consumo individual: es una experiencia social y comunitaria.',
  ],
  impact: [
    'El impacto de {artist} en la cultura pop latinoamericana es innegable. Su influencia se extiende mas alla de la musica, alcanzando la moda, el lenguaje y la forma en que los jovenes de la region consumen entretenimiento. Es una revolucion cultural silenciosa pero poderosa.',
    'Lo que {artist} representan para el K-Pop global es significativo. En un momento donde la industria busca expandirse a nuevos mercados, el exito de {artist} en America Latina sirve como modelo para otros artistas que aspiran a conectar con la audiencia hispanohablante.',
    'Culturalmente, la conexion entre {artist} y America Latina es un fenomeno fascinante. Dos tradiciones musicales ricas y apasionadas encuentran un punto de encuentro a traves del K-Pop, creando algo nuevo y emocionante que beneficia a ambas comunidades.',
  ],
  noArtist: {
    background: [
      'El K-Pop ha encontrado en America Latina uno de sus mercados mas apasionados y leales. La region se ha convertido en un pilar fundamental para la industria del entretenimiento coreano, con cifras de streaming y ventas que crecen ano tras ano.',
      'La relacion entre el K-Pop y la cultura latina es unica. Ambas comparten una pasion por la musica, el baile y la expresion artistica que crea una conexion natural entre artistas y fans. Esta afinidad cultural explica el exito sostenido del genero en la region.',
    ],
    detail: [
      'Las cifras hablan por si solas: el consumo de K-Pop en America Latina ha crecido mas del 200% en los ultimos tres anos. Las plataformas de streaming reportan que paises como Mexico, Brasil, Colombia y Peru se encuentran entre los mayores consumidores de musica coreana a nivel global.',
      'La infraestructura de fan communities en habla hispana es impresionante. Desde cuentas de traduccion que trabajan las 24 horas hasta proyectos de fan art y fan fiction, la creatividad del fandom latino no tiene limites y contribuye activamente al ecosistema global del K-Pop.',
    ],
    reaction: [
      'La comunidad K-Pop hispanohablante ha demostrado una vez mas su capacidad de organizacion y su pasion desbordante. Las conversaciones en redes sociales reflejan un nivel de compromiso y conocimiento que rivaliza con cualquier otro mercado en el mundo.',
    ],
    impact: [
      'El crecimiento del K-Pop en America Latina tiene implicaciones que van mas alla del entretenimiento. Fomenta el interes por la cultura coreana, impulsa el aprendizaje del idioma y crea oportunidades economicas en la region, desde tiendas de merch hasta eventos especializados.',
    ],
  }
};

function extractArtistFromParagraphs(paragraphs) {
  if (!paragraphs || paragraphs.length === 0) return null;
  const sample = paragraphs.slice(0, 3).join(' ');
  return extractArtist(sample);
}

function shuffleAndPick(arr, n) {
  const shuffled = [...arr].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, Math.min(n, shuffled.length));
}

function rewriteArticleBody(articleContent, title) {
  const artist = extractArtist(title) || (articleContent ? extractArtistFromParagraphs(articleContent.paragraphs) : null);
  const topic = classifyTopic(title);

  const originalLength = articleContent?.paragraphs?.length || 0;
  const targetParagraphs = Math.max(8, Math.min(12, originalLength || 8));

  const inlineImages = (articleContent?.images || []).slice(1, 4);
  const paragraphs = [];

  if (artist) {
    const templates = BODY_TEMPLATES[topic] || BODY_TEMPLATES.general;
    const sub = (text) => text.replace(/\{artist\}/g, artist);

    paragraphs.push({ type: 'intro', text: sub(pickRandom(templates.opening)) });

    const bgCount = targetParagraphs >= 10 ? 2 : 1;
    for (const bg of shuffleAndPick(SHARED_PARAGRAPHS.background, bgCount)) {
      paragraphs.push({ type: 'body', text: sub(bg) });
    }

    const analysisCount = targetParagraphs >= 10 ? 3 : 2;
    for (const a of shuffleAndPick(templates.analysis, analysisCount)) {
      paragraphs.push({ type: 'body', text: sub(a) });
    }

    if (inlineImages.length > 0) {
      paragraphs.push({ type: 'image', src: inlineImages[0] });
    }

    const detailCount = targetParagraphs >= 10 ? 2 : 1;
    for (const d of shuffleAndPick(SHARED_PARAGRAPHS.detail, detailCount)) {
      paragraphs.push({ type: 'body', text: sub(d) });
    }

    const reactionCount = targetParagraphs >= 10 ? 2 : 1;
    for (const r of shuffleAndPick(SHARED_PARAGRAPHS.reaction, reactionCount)) {
      paragraphs.push({ type: 'body', text: sub(r) });
    }

    if (inlineImages.length > 1) {
      paragraphs.push({ type: 'image', src: inlineImages[1] });
    }

    paragraphs.push({ type: 'body', text: sub(pickRandom(SHARED_PARAGRAPHS.impact)) });
    paragraphs.push({ type: 'closing', text: sub(pickRandom(templates.closing)) });

  } else {
    paragraphs.push({ type: 'intro', text: pickRandom(NO_ARTIST_BODY.opening) });

    for (const bg of shuffleAndPick(SHARED_PARAGRAPHS.noArtist.background, 2)) {
      paragraphs.push({ type: 'body', text: bg });
    }

    for (const a of shuffleAndPick(NO_ARTIST_BODY.analysis, 2)) {
      paragraphs.push({ type: 'body', text: a });
    }

    if (inlineImages.length > 0) {
      paragraphs.push({ type: 'image', src: inlineImages[0] });
    }

    for (const d of shuffleAndPick(SHARED_PARAGRAPHS.noArtist.detail, 2)) {
      paragraphs.push({ type: 'body', text: d });
    }

    for (const r of shuffleAndPick(SHARED_PARAGRAPHS.noArtist.reaction, 1)) {
      paragraphs.push({ type: 'body', text: r });
    }

    if (inlineImages.length > 1) {
      paragraphs.push({ type: 'image', src: inlineImages[1] });
    }

    paragraphs.push({ type: 'body', text: pickRandom(SHARED_PARAGRAPHS.noArtist.impact) });
    paragraphs.push({ type: 'closing', text: pickRandom(NO_ARTIST_BODY.closing) });
  }

  return { paragraphs };
}

// ============================================================
// HTML escaping
// ============================================================

function escapeHtml(str) {
  return (str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ============================================================
// Image tag helpers
// ============================================================

function imgTag(article, width, height, loading = 'lazy') {
  const src = escapeHtml(article.image || PLACEHOLDER_IMAGE);
  const fallback = `https://picsum.photos/seed/${encodeURIComponent(article.title.slice(0, 20))}/${width}/${height}`;
  return `<img src="${src}" alt="${escapeHtml(article.title)}" width="${width}" height="${height}" loading="${loading}" referrerpolicy="no-referrer" data-fallback="${escapeHtml(fallback)}" onerror="if(!this.dataset.failed){this.dataset.failed='1';this.src=this.dataset.fallback}">`;
}

function imgTagForArticle(article, width, height, loading = 'lazy') {
  let src = article.image || PLACEHOLDER_IMAGE;
  if (src.startsWith('images/')) src = '../' + src;
  const escapedSrc = escapeHtml(src);
  const fallback = `https://picsum.photos/seed/${encodeURIComponent(article.title.slice(0, 20))}/${width}/${height}`;
  return `<img src="${escapedSrc}" alt="${escapeHtml(article.title)}" width="${width}" height="${height}" loading="${loading}" referrerpolicy="no-referrer" data-fallback="${escapeHtml(fallback)}" onerror="if(!this.dataset.failed){this.dataset.failed='1';this.src=this.dataset.fallback}">`;
}

// ============================================================
// Card generators — ALBA style
// ============================================================

function generateHeroCard(article) {
  if (!article) return '';
  const cat = displayCategory(article.category);
  return `<a href="${escapeHtml(article.localUrl)}" class="hero-card fade-in">
          ${imgTag(article, 1200, 675, 'eager')}
          <div class="hero-overlay">
            <span class="category-badge">${escapeHtml(cat)}</span>
            <h2>${escapeHtml(article.title)}</h2>
            <div class="hero-meta">
              <span>${escapeHtml(article.formattedDate)}</span>
              <span>Fuente: ${escapeHtml(article.source)}</span>
            </div>
          </div>
        </a>`;
}

function generateLatestCard(article) {
  if (!article) return '';
  const cat = displayCategory(article.category);
  const color = categoryColor(cat);
  return `<a href="${escapeHtml(article.localUrl)}" class="latest-card fade-in">
          <div class="color-bar" style="background:${color}"></div>
          <div class="card-content">
            <div class="card-category" style="color:${color}">${escapeHtml(cat)}</div>
            <h3>${escapeHtml(article.title)}</h3>
            <div class="card-meta">${escapeHtml(article.formattedDate)} &middot; Fuente: ${escapeHtml(article.source)}</div>
          </div>
          <div class="card-thumb">
            ${imgTag(article, 140, 140)}
          </div>
        </a>`;
}

function generateMusicCard(article) {
  if (!article) return '';
  const cat = displayCategory(article.category);
  return `<a href="${escapeHtml(article.localUrl)}" class="music-card fade-in">
          <div class="thumb">
            ${imgTag(article, 600, 338)}
            <div class="waveform-bar"></div>
          </div>
          <div class="card-body">
            <div class="card-category">${escapeHtml(cat)}</div>
            <h3>${escapeHtml(article.title)}</h3>
            <div class="card-meta">${escapeHtml(article.formattedDate)} &middot; Fuente: ${escapeHtml(article.source)}</div>
          </div>
        </a>`;
}

function generateCultureCard(article) {
  if (!article) return '';
  const cat = displayCategory(article.category);
  const color = categoryColor(cat);
  return `<a href="${escapeHtml(article.localUrl)}" class="culture-card fade-in">
          ${imgTag(article, 600, 400)}
          <div class="card-overlay">
            <div class="card-category" style="color:${color}">${escapeHtml(cat)}</div>
            <h3>${escapeHtml(article.title)}</h3>
            <div class="card-meta">${escapeHtml(article.formattedDate)}</div>
          </div>
        </a>`;
}

function generateTrendingItem(article, rank) {
  if (!article) return '';
  return `<a href="${escapeHtml(article.localUrl)}" class="trending-item fade-in">
          <span class="trend-rank">${rank}</span>
          <div class="trend-content">
            <h3>${escapeHtml(article.title)}</h3>
            <div class="trend-meta">${escapeHtml(article.formattedDate)} &middot; ${escapeHtml(article.source)}</div>
          </div>
          <div class="trend-thumb">
            ${imgTag(article, 64, 64)}
          </div>
        </a>`;
}

// ============================================================
// Generate article HTML pages
// ============================================================

async function generateArticlePages(allArticles, usedArticles) {
  await mkdir(ARTICLES_DIR, { recursive: true });
  const templatePath = join(__dirname, 'article-template.html');
  const articleTemplate = await readFile(templatePath, 'utf-8');

  log(`Generating ${usedArticles.length} article pages...`);

  for (let i = 0; i < usedArticles.length; i++) {
    const filename = `article-${String(i + 1).padStart(3, '0')}.html`;
    usedArticles[i].localUrl = `articles/${filename}`;
  }

  let generated = 0;

  for (let i = 0; i < usedArticles.length; i++) {
    const article = usedArticles[i];
    const filename = `article-${String(i + 1).padStart(3, '0')}.html`;

    const related = allArticles
      .filter(a => a !== article && a.image && a.localUrl)
      .slice(0, 20)
      .sort(() => Math.random() - 0.5)
      .slice(0, 3);

    const bodyData = rewriteArticleBody(article.articleContent, article.title);

    let bodyHtml = '';
    for (const item of bodyData.paragraphs) {
      if (item.type === 'intro') {
        bodyHtml += `<div class="editorial-intro">${escapeHtml(item.text)}</div>\n`;
      } else if (item.type === 'closing') {
        bodyHtml += `        <div class="editorial-closing">${escapeHtml(item.text)}</div>`;
      } else if (item.type === 'image') {
        const imgSrc = item.src;
        const fallback = `https://picsum.photos/seed/inline-${Math.random().toString(36).slice(2,8)}/760/428`;
        bodyHtml += `        <figure class="article-inline-image">
          <img src="${escapeHtml(imgSrc)}" alt="" width="760" height="428" loading="lazy" decoding="async" referrerpolicy="no-referrer" data-fallback="${escapeHtml(fallback)}" onerror="if(!this.dataset.failed){this.dataset.failed='1';this.src=this.dataset.fallback}">
        </figure>\n`;
      } else {
        bodyHtml += `        <p>${escapeHtml(item.text)}</p>\n`;
      }
    }

    let heroImgSrc = article.image || PLACEHOLDER_IMAGE;
    if (heroImgSrc.startsWith('images/')) heroImgSrc = '../' + heroImgSrc;
    const heroFallback = `https://picsum.photos/seed/${encodeURIComponent(article.title.slice(0, 20))}/800/450`;
    const heroImg = `<img src="${escapeHtml(heroImgSrc)}" alt="${escapeHtml(article.title)}" width="760" height="428" loading="eager" referrerpolicy="no-referrer" data-fallback="${escapeHtml(heroFallback)}" onerror="if(!this.dataset.failed){this.dataset.failed='1';this.src=this.dataset.fallback}">`;

    let relatedHtml = '';
    for (const rel of related) {
      const relUrl = `../${rel.localUrl}`;
      let relImgSrc = rel.image || PLACEHOLDER_IMAGE;
      if (relImgSrc.startsWith('images/')) relImgSrc = '../' + relImgSrc;
      const relFallback = `https://picsum.photos/seed/${encodeURIComponent(rel.title.slice(0, 20))}/400/225`;
      const relCat = displayCategory(rel.category);
      relatedHtml += `
          <a href="${escapeHtml(relUrl)}" class="related-card">
            <div class="thumb">
              <img src="${escapeHtml(relImgSrc)}" alt="${escapeHtml(rel.title)}" width="400" height="225" loading="lazy" referrerpolicy="no-referrer" data-fallback="${escapeHtml(relFallback)}" onerror="if(!this.dataset.failed){this.dataset.failed='1';this.src=this.dataset.fallback}">
            </div>
            <div class="related-body">
              <div class="related-category">${escapeHtml(relCat)}</div>
              <h3>${escapeHtml(rel.title)}</h3>
              <span class="date">${escapeHtml(rel.formattedDate)}</span>
            </div>
          </a>`;
    }

    const sourceAttribution = `<div class="source-attribution">
          Fuente: <a href="${escapeHtml(article.link)}" target="_blank" rel="noopener noreferrer">${escapeHtml(article.source)}</a>
          <br><a href="${escapeHtml(article.link)}" target="_blank" rel="noopener noreferrer" class="read-original">Leer articulo original &rarr;</a>
        </div>`;

    const photoCredit = `Foto: &copy;${escapeHtml(article.source)}`;

    const cat = displayCategory(article.category);
    const bclass = badgeClass(cat);

    let html = articleTemplate
      .replace(/\{\{ARTICLE_TITLE\}\}/g, escapeHtml(article.title))
      .replace('{{ARTICLE_DESCRIPTION}}', escapeHtml(article.title).slice(0, 160))
      .replace('{{ARTICLE_IMAGE}}', escapeHtml(heroImgSrc))
      .replace('{{ARTICLE_CATEGORY}}', escapeHtml(cat))
      .replace('{{ARTICLE_BADGE_CLASS}}', bclass)
      .replace('{{ARTICLE_DATE}}', escapeHtml(article.formattedDate))
      .replace('{{ARTICLE_HERO_IMAGE}}', heroImg)
      .replace('{{ARTICLE_BODY}}', bodyHtml)
      .replace('{{SOURCE_ATTRIBUTION}}', sourceAttribution)
      .replace('{{PHOTO_CREDIT}}', photoCredit)
      .replace('{{RELATED_ARTICLES}}', relatedHtml);

    const outputPath = join(ARTICLES_DIR, filename);
    await writeFile(outputPath, html, 'utf-8');
    generated++;
  }

  log(`  Generated ${generated} article pages`);
}

// ============================================================
// Assign articles to sections
// ============================================================

const HERO_OFFSET = 8;

function assignSections(articles) {
  let placeholderIdx = 0;
  for (const article of articles) {
    if (!article.image) {
      placeholderIdx++;
      article.image = `https://picsum.photos/seed/alba-${placeholderIdx}-${Date.now() % 10000}/800/450`;
      article.hasPlaceholder = true;
    }
  }

  const withRealImages = articles.filter(a => !a.hasPlaceholder);
  const all = [...articles];
  const used = new Set();

  const take = (pool, count) => {
    const result = [];
    for (const article of pool) {
      if (result.length >= count) break;
      if (!used.has(article.link)) {
        result.push(article);
        used.add(article.link);
      }
    }
    return result;
  };

  const heroCandidates = withRealImages.length >= 2 ? withRealImages : all;
  const heroSkipped = heroCandidates.slice(HERO_OFFSET);
  const hero = take(heroSkipped.length ? heroSkipped : heroCandidates, 1);
  const latest = take(all, 3);
  const music = take(all, 4);
  const culture = take(all, 4);
  const trending = take(all, 6);

  return {
    hero: hero[0] || null,
    latest,
    music,
    culture,
    trending,
  };
}

// ============================================================
// Generate index HTML
// ============================================================

async function generateHtml(sections) {
  const templatePath = join(__dirname, 'template.html');
  let template = await readFile(templatePath, 'utf-8');

  template = template.replace(
    '{{HERO_CARD}}',
    sections.hero ? generateHeroCard(sections.hero) : ''
  );

  template = template.replace(
    '{{LATEST_ARTICLES}}',
    sections.latest.map(a => generateLatestCard(a)).join('\n        ')
  );

  template = template.replace(
    '{{MUSIC_ARTICLES}}',
    sections.music.map(a => generateMusicCard(a)).join('\n        ')
  );

  template = template.replace(
    '{{CULTURE_ARTICLES}}',
    sections.culture.map(a => generateCultureCard(a)).join('\n        ')
  );

  template = template.replace(
    '{{TRENDING}}',
    sections.trending.map((a, i) => generateTrendingItem(a, i + 1)).join('\n        ')
  );

  return template;
}

// ============================================================
// Main
// ============================================================

async function main() {
  log('Starting ALBA Magazine RSS Crawler...');
  log('');

  // 1. Fetch all RSS feeds
  const articles = await fetchAllFeeds();
  if (articles.length === 0) {
    warn('No articles fetched. Aborting.');
    process.exit(1);
  }
  log('');

  // 2. Fill missing images via og:image
  await fillMissingImages(articles);
  log('');

  // 3. Rewrite ALL titles to Spanish
  log('Rewriting titles to Spanish editorial style...');
  let rewritten = 0;
  for (const article of articles) {
    const original = article.title;
    article.originalTitle = original;
    article.title = rewriteTitle(original, article.source);
    if (article.title !== original) rewritten++;
  }
  log(`  Rewritten ${rewritten}/${articles.length} titles`);
  log('');

  // 4. Backdate articles (Jan 1 to Mar 22, 2026)
  log('Backdating articles to Jan-Mar 2026...');
  backdateArticles(articles);
  log('');

  // 5. Assign articles to sections
  const sections = assignSections(articles);

  // Collect all used articles
  const usedArticles = [];
  const usedSet = new Set();
  const addUsed = (arr) => {
    for (const a of arr) {
      if (a && !usedSet.has(a.link)) {
        usedArticles.push(a);
        usedSet.add(a.link);
      }
    }
  };
  if (sections.hero) addUsed([sections.hero]);
  addUsed(sections.latest);
  addUsed(sections.music);
  addUsed(sections.culture);
  addUsed(sections.trending);

  // 6. Download images locally
  const withImages = articles.filter(a => a.image).length;
  log(`Articles with images: ${withImages}/${articles.length}`);
  await downloadArticleImages(usedArticles);
  log('');

  // 7. Fetch full article content
  await fetchAllArticleContent(usedArticles);
  log('');

  // 8. Generate article pages
  await generateArticlePages(articles, usedArticles);
  log('');

  // 9. Generate index HTML
  const html = await generateHtml(sections);

  // 10. Write index output
  const outputPath = join(__dirname, 'index.html');
  await writeFile(outputPath, html, 'utf-8');

  const totalUsed =
    (sections.hero ? 1 : 0) +
    sections.latest.length +
    sections.music.length +
    sections.culture.length +
    sections.trending.length;

  log(`Generated index.html with ${totalUsed} articles`);
  log(`Generated ${usedArticles.length} article pages in articles/`);
  log(`Done! Open: file://${outputPath}`);
}

main().catch((err) => {
  console.error('[ALBA Crawler] Fatal error:', err);
  process.exit(1);
});

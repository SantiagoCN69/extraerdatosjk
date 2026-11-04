/*
 * Actualización masiva de la colección Firestore `datos-animes` desde JKAnime.
 *
 * Seguridad: este programa usa Firebase Admin SDK. No usa, ni necesita, la
 * configuración web de Firebase. Configure SERVICE_ACCOUNT_PATH o las
 * credenciales por defecto de la aplicación (ADC).
 *
 * Por seguridad DRY_RUN es true de forma predeterminada. Ejecute con
 * DRY_RUN=false solamente después de revisar la salida de una simulación.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const axios = require('axios');
const cheerio = require('cheerio');
const { applicationDefault, cert, getApps, initializeApp } = require('firebase-admin/app');
const { FieldPath, FieldValue, getFirestore } = require('firebase-admin/firestore');
require('dotenv').config();

const BASE_URL = 'https://jkanime.net';
const COLLECTION = process.env.FIRESTORE_COLLECTION || 'datos-animes';
const DRY_RUN = (process.env.DRY_RUN || 'true').trim().toLowerCase() !== 'false';
// metadata: actualización general; servers_recent: últimos N; servers_manual: un enlace.
const MODE = (process.env.MODE || 'metadata').trim().toLowerCase();
const CONCURRENCY = positiveInteger(process.env.CONCURRENCY, 2, 1, 8);
const SERVER_CONCURRENCY = positiveInteger(process.env.SERVER_CONCURRENCY, 1, 1, 3);
const REQUEST_DELAY_MS = positiveInteger(process.env.REQUEST_DELAY_MS, 1500, 0, 60000);
const MAX_RETRIES = positiveInteger(process.env.MAX_RETRIES, 3, 0, 10);
const PAGE_SIZE = positiveInteger(process.env.PAGE_SIZE, 100, 1, 500);
const LATEST_LIMIT = positiveInteger(process.env.LATEST_LIMIT, 10, 1, 100);
const MANUAL_ANIME_ID = (process.env.ANIME_ID || '').trim();
const MANUAL_ANIME_URL = (process.env.ANIME_URL || '').trim();
const ANIME_LIST = (process.env.ANIME_LIST || '').split(',').map(s => s.trim()).filter(Boolean);

// Configuración de proxy tomada de las estrategias del material de referencia.
const PROXY_CONFIG = {
  scraperAPI: process.env.SCRAPER_API_KEY || null,
  zenRows: process.env.ZENROWS_API_KEY || null,
  scrapeOps: process.env.SCRAPEOPS_API_KEY || null,
};
const USE_PROXY = process.env.USE_PROXY === 'true' || process.env.VERCEL === '1' || process.env.RENDER === '1';
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000;
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
  Connection: 'keep-alive',
};

function positiveInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(level, message) {
  console.log(`${new Date().toISOString()} ${level} ${message}`);
}

function safeError(error) {
  return error && error.message ? error.message : String(error);
}

function getCached(url) {
  const item = cache.get(url);
  return item && Date.now() - item.timestamp < CACHE_TTL ? item.data : null;
}

function setCached(url, data) {
  cache.set(url, { data, timestamp: Date.now() });
}

function getProxyUrl(targetUrl) {
  if (PROXY_CONFIG.scraperAPI) {
    return `http://api.scraperapi.com?api_key=${PROXY_CONFIG.scraperAPI}&url=${encodeURIComponent(targetUrl)}&render=true`;
  }
  if (PROXY_CONFIG.zenRows) {
    return `https://api.zenrows.com/v1/?apikey=${PROXY_CONFIG.zenRows}&url=${encodeURIComponent(targetUrl)}&css_selector=&premium_proxy=true`;
  }
  if (PROXY_CONFIG.scrapeOps) {
    return `https://proxy.scrapeops.io/v1/?api_key=${PROXY_CONFIG.scrapeOps}&url=${encodeURIComponent(targetUrl)}&render_js=true`;
  }
  return null;
}

function isBlockedHtml(html) {
  // La ruta AJAX puede devolver JSON ya transformado por axios; eso no es HTML bloqueado.
  // JKAnime puede incluir textos genéricos de Cloudflare/CAPTCHA en una página
  // válida. Por eso solo se rechaza una pantalla de desafío reconocible, no una
  // mera coincidencia de palabras. La validación final sigue en hasUsableDetails.
  if (typeof html !== 'string') return false;
  const normalized = html.toLowerCase();
  const challengeTitle = /<title[^>]*>\s*(just a moment|attention required|access denied)/i.test(html);
  const activeChallenge = /cf-chl-|challenge-platform|checking your browser|verify you are human/i.test(normalized);
  return challengeTitle || (activeChallenge && !/id=["']guardar-anime|data-anime=|render_caps/i.test(html));
}

/** Solicitud con caché, proxy opcional, backoff exponencial y espera educada. */
async function fetchWithCache(url) {
  const cached = getCached(url);
  if (cached) return cached;

  const proxyUrl = USE_PROXY ? getProxyUrl(url) : null;
  if (USE_PROXY && !proxyUrl) log('WARN', `USE_PROXY=true sin proveedor configurado; solicitud directa: ${url}`);

  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      if (attempt > 0) {
        const backoff = Math.min(30000, 1000 * (2 ** (attempt - 1))) + Math.floor(Math.random() * 400);
        log('WARN', `Reintento ${attempt}/${MAX_RETRIES} en ${Math.round(backoff / 1000)} s: ${url}`);
        await sleep(backoff);
      }
      if (REQUEST_DELAY_MS > 0) await sleep(REQUEST_DELAY_MS);

      const response = await axios.get(proxyUrl || url, {
        headers: HEADERS,
        timeout: proxyUrl ? 30000 : 20000,
        maxRedirects: 3,
        validateStatus: (status) => status >= 200 && status < 500,
      });

      if (response.status !== 200 || !response.data || isBlockedHtml(response.data)) {
        const requestError = new Error(`JKAnime respondió HTTP ${response.status}${isBlockedHtml(response.data) ? ' (bloqueo o desafío detectado)' : ''}`);
        // Un 404 no mejorará con tres reintentos; así el fallback de capítulos se activa enseguida.
        requestError.noRetry = response.status >= 400 && response.status < 500 && response.status !== 429;
        throw requestError;
      }
      setCached(url, response.data);
      return response.data;
    } catch (error) {
      lastError = error;
      if (error && error.noRetry) break;
    }
  }
  throw new Error(`No se pudo consultar JKAnime: ${safeError(lastError)}`);
}

function absoluteUrl(value) {
  if (!value || typeof value !== 'string') return null;
  try {
    return new URL(value, BASE_URL).href;
  } catch (_) {
    return null;
  }
}

function getIdFromUrl(value) {
  if (!value || typeof value !== 'string') return '';
  try {
    const parts = new URL(value, BASE_URL).pathname.split('/').filter(Boolean);
    let last = parts.at(-1) || '';
    if (/^\d+(?:\.\d+)?$/.test(last)) last = parts.at(-2) || '';
    // Solo eliminar sufijos numéricos si parece ser un número de episodio (ej: anime-1, anime-2)
    // pero no si es parte del nombre (ej: thunder-3, roblox-3)
    // Si el input no tiene barra, probablemente es un ID directo, no una URL
    if (!value.includes('/')) return value;
    return last.replace(/-\d+$/, '');
  } catch (_) {
    // Si falla el parseo de URL, asumir que es un ID directo
    return value;
  }
}

function textAfterLabel($, labels) {
  let value = null;
  $('li').each((_, element) => {
    if (value) return;
    const text = $(element).text().trim();
    if (labels.some((label) => text.toLowerCase().includes(label))) {
      const child = $(element).find('div').first().text().trim();
      value = child || text.replace(/^.*?:\s*/, '').trim() || null;
    }
  });
  return value;
}

function uniqueEpisodes(episodes) {
  const byNumber = new Map();
  for (const episode of episodes) {
    const number = String(episode.number || '').trim();
    if (!/^\d+(?:\.\d+)?$/.test(number)) continue;
    if (!byNumber.has(number)) byNumber.set(number, { number });
  }
  return [...byNumber.values()]
    .sort((a, b) => Number.parseFloat(a.number) - Number.parseFloat(b.number));
}

function getDeclaredEpisodeTotal($, html) {
  const totals = [];
  $('li').each((_, element) => {
    const text = $(element).text().replace(/\s+/g, ' ').trim();
    if (!/^episodios\s*:/i.test(text)) return;
    for (const match of text.matchAll(/\b(\d{1,4})\b/g)) totals.push(Number.parseInt(match[1], 10));
  });

  // Respaldo si el número está en nodos HTML separados del texto del <li>.
  const stripped = String(html).replace(/<[^>]*>/g, ' ').replace(/&nbsp;/gi, ' ');
  for (const match of stripped.matchAll(/episodios\s*:\s*(\d{1,4})/gi)) totals.push(Number.parseInt(match[1], 10));

  const valid = totals.filter((total) => Number.isInteger(total) && total > 0 && total < 2000);
  return valid.length ? Math.max(...valid) : 0;
}

/**
 * Estrategias de getAnimeDetails del material adjunto: scripts, AJAX interno,
 * enlaces renderizados y generación de emergencia desde el total de episodios.
 */
async function getAnimeDetails(id) {
  try {
    const html = await fetchWithCache(`${BASE_URL}/${id}`);
    const $ = cheerio.load(html);

    // Extraer título - buscar en h3 que contenga el nombre del anime
    let title = id;
    $('h3').each((i, elem) => {
      const text = $(elem).text().trim();
      if (text && text.toLowerCase().includes(id.replace(/-/g, ' '))) {
        title = text;
      }
    });

    // Extraer imagen/portada
    let cover = $('.anime_pic.pc img').attr('src') ||
                $('.mov.mb-3.movpic img').attr('src') ||
                $('img').first().attr('src');

    // Extraer sinopsis
    let synopsis = $('.scroll').text().trim() ||
                    $('.sinopsis').text().trim() ||
                    $('p').first().text().trim();

    // Extraer géneros
    const genres = [];
    $('li').each((i, elem) => {
      const text = $(elem).text().trim();
      if (text.toLowerCase().includes('generos') || text.toLowerCase().includes('géneros')) {
        $(elem).find('a').each((j, link) => {
          const genreText = $(link).text().trim();
          if (genreText && !genres.includes(genreText)) {
            genres.push(genreText);
          }
        });
      }
    });

    if (genres.length === 0) {
      $('.genres a, .genre a').each((i, elem) => {
        const genreText = $(elem).text().trim();
        if (genreText && !genres.includes(genreText)) {
          genres.push(genreText);
        }
      });
    }

    // Extraer estado
    let status = 'Desconocido';
    $('li').each((i, elem) => {
      const text = $(elem).text().trim();
      if (text.toLowerCase().includes('estado')) {
        const statusDiv = $(elem).find('div').first();
        if (statusDiv.length > 0) {
          status = statusDiv.text().trim();
        } else {
          const statusText = text.replace(/estado:\s*/i, '').trim();
          if (statusText) {
            status = statusText;
          }
        }
      }
    });

    if (status === 'Desconocido') {
      status = $('.status').text().trim() ||
               $('.state').text().trim() ||
               'Desconocido';
    }

    // Extraer episodios - Verificación secuencial de URLs
    let episodes = [];
    const maxToCheck = 50;

    for (let i = 1; i <= maxToCheck; i++) {
      try {
        const epUrl = `${BASE_URL}/${id}/${i}/`;
        const response = await fetchWithCache(epUrl);
        if (response && !isBlockedHtml(response)) {
          episodes.push({
            number: i.toString()
          });
        } else {
          break;
        }
      } catch (e) {
        break;
      }
    }

    // Limpiar duplicados y ordenar de menor a mayor
    const uniqueEpisodes = [];
    const seenNumbers = new Set();

    episodes.forEach(ep => {
      if (!seenNumbers.has(ep.number)) {
        seenNumbers.add(ep.number);
        uniqueEpisodes.push(ep);
      }
    });

    const sortedEpisodes = uniqueEpisodes.sort((a, b) => parseFloat(a.number) - parseFloat(b.number));

    return {
      id: id,
      title: title,
      cover: cover ? (cover.startsWith('http') ? cover : BASE_URL + cover) : null,
      synopsis: synopsis || null,
      genres: genres,
      status: status,
      category: null,
      startDate: null,
      episodes: sortedEpisodes,
      relations: [],
      type: null,
      chapter: null,
      url: `${BASE_URL}/${id}`,
      score: null
    };
  } catch (e) {
    log('ERROR', `No se pudo obtener detalles del anime ${id}: ${e.message}`);
    return null;
  }
}
/**
 * Extrae los servidores de un capítulo con la estrategia getEpisodeLinks del
 * material adjunto. Una ausencia de servidores no se considera un dato para
 * borrar: el llamador deja el episodio existente intacto.
 */
async function getEpisodeLinks(url) {
  const html = await fetchWithCache(url);
  const $ = cheerio.load(html);
  const servers = [];

  $('script').each((_, element) => {
    const script = $(element).html() || '';

    // Descargas: var servers = [{ remote: base64, server, size }, ...]
    const serverMatch = script.match(/var\s+servers\s*=\s*(\[[\s\S]*?\]);/);
    if (serverMatch) {
      try {
        const parsed = JSON.parse(serverMatch[1]);
        for (const server of parsed) {
          if (!server || !server.remote) continue;
          try {
            const decodedUrl = Buffer.from(server.remote, 'base64').toString('utf8');
            if (decodedUrl) {
              servers.push({ type: 'download', url: decodedUrl, ...(server.size ? { size: server.size } : {}) });
            }
          } catch (_) {
            // Un remote mal formado se descarta sin invalidar otros servidores.
          }
        }
      } catch (_) {
        // Si la página cambió el formato, se intenta de todos modos la estrategia player.
      }
    }

    // Players: video[0] = '<iframe src="...">'.
    for (const match of script.matchAll(/video\[\d+\]\s*=\s*'([^']+)'/g)) {
      const playerHtml = match[1].replace(/\\"/g, '"').replace(/\\'/g, "'");
      const srcMatch = playerHtml.match(/src=["']([^"']+)["']/i);
      const playerUrl = srcMatch ? srcMatch[1] : null;
      if (playerUrl) servers.push({ type: 'player', url: playerUrl });
    }
  });

  const seen = new Set();
  return servers.filter((server) => {
    const key = String(server.url || '').trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function episodeStorageKey(episode) {
  return `number:${String(episode && episode.number || '')}`;
}

function makeEpisodeLookups(existingEpisodes) {
  const existing = Array.isArray(existingEpisodes) ? existingEpisodes : [];
  const byNumber = new Map();
  for (const episode of existing) {
    if (!episode) continue;
    const number = String(episode.number || '');
    // Conserva la primera coincidencia por número de capítulo
    if (number && !byNumber.has(number)) byNumber.set(number, episode);
  }
  return { existing, byNumber };
}

function findExistingEpisode(lookups, scrapedEpisode) {
  return lookups.byNumber.get(String(scrapedEpisode.number || '')) || null;
}

function mergeEpisodes(existingEpisodes, scrapedEpisodes) {
  const lookups = makeEpisodeLookups(existingEpisodes);
  const matched = new Set();
  const merged = scrapedEpisodes.map((episode) => {
    const previous = findExistingEpisode(lookups, episode);
    if (!previous) return episode;
    matched.add(previous);
    // Se preserva cualquier campo adicional y los servidores existentes.
    return {
      ...previous,
      ...episode,
      ...(Object.prototype.hasOwnProperty.call(previous, 'servidores') ? { servidores: previous.servidores } : {}),
    };
  });
  // También conserva episodios almacenados que JKAnime no haya devuelto esta vez.
  for (const previous of lookups.existing) {
    if (previous && !matched.has(previous)) merged.push(previous);
  }
  return merged.sort((a, b) => Number.parseFloat(a.number) - Number.parseFloat(b.number));
}

function mergeServers(existingServers, foundServers) {
  // Primero se mantienen los objetos existentes tal cual; los nuevos se anexan.
  const result = Array.isArray(existingServers) ? [...existingServers] : [];
  const urls = new Set(result.map((server) => String(server && server.url || '').trim()).filter(Boolean));
  for (const server of foundServers) {
    const url = String(server && server.url || '').trim();
    if (url && !urls.has(url)) {
      result.push(server);
      urls.add(url);
    }
  }
  return result;
}

async function collectServerUpdates(existingEpisodes, scrapedEpisodes, label, animeSlug) {
  const lookups = makeEpisodeLookups(existingEpisodes);
  const updates = new Map();
  const stats = { checked: 0, withServers: 0, withoutServers: 0, newServers: 0, failures: 0 };

  await mapWithConcurrency(scrapedEpisodes, SERVER_CONCURRENCY, async (episode, index) => {
    try {
      stats.checked += 1;
      // Generar URL dinámicamente desde el slug del anime y número de capítulo
      const episodeUrl = `${BASE_URL}/${animeSlug}/${episode.number}/`;
      const found = await getEpisodeLinks(episodeUrl);
      if (found.length === 0) {
        stats.withoutServers += 1;
        log('WARN', `${label} capítulo ${episode.number} (${index + 1}/${scrapedEpisodes.length}): sin servidores; se conserva el estado previo.`);
        return;
      }
      // El número de capítulo enlaza los registros existentes
      const previous = findExistingEpisode(lookups, episode);
      const before = Array.isArray(previous && previous.servidores) ? previous.servidores.length : 0;
      const servers = mergeServers(previous && previous.servidores, found);
      stats.withServers += 1;
      stats.newServers += Math.max(0, servers.length - before);
      // Si ya existía, no se alteran sus demás campos; si es nuevo se añade con number.
      updates.set(previous ? episodeStorageKey(previous) : episodeStorageKey(episode), previous
        ? { ...previous, servidores: servers }
        : { number: episode.number, servidores: servers });
      log('INFO', `${label} capítulo ${episode.number}: ${found.length} detectado(s), ${Math.max(0, servers.length - before)} nuevo(s).`);
    } catch (error) {
      stats.failures += 1;
      log('ERROR', `${label} capítulo ${episode.number}: ${safeError(error)}. Episodio intacto.`);
    }
  });

  if (updates.size === 0) return { episodes: null, stats };
  const merged = lookups.existing.map((episode) => updates.get(episodeStorageKey(episode)) || episode);
  for (const episode of scrapedEpisodes) {
    if (!findExistingEpisode(lookups, episode) && updates.has(episodeStorageKey(episode))) {
      merged.push(updates.get(episodeStorageKey(episode)));
    }
  }
  // Es deliberado conservar también capítulos existentes que el scraper no encontró.
  return { episodes: merged.sort((a, b) => Number.parseFloat(a.number) - Number.parseFloat(b.number)), stats };
}

function normalizeAnime(data, existing) {
  const normalized = {
    id: data.id || null,
    titulo: data.title || null,
    portada: data.cover || null,
    banner: null,
    descripcion: data.synopsis || null,
    generos: data.genres && data.genres.length ? data.genres : null,
    estado: data.status || null,
    category: data.category || null,
    startDate: data.startDate || null,
    episodios: data.episodes && data.episodes.length ? mergeEpisodes(existing.episodios, data.episodes) : null,
    relacionados: data.relations && data.relations.length ? data.relations.filter((item) => item && item.slug).map((item) => ({ slug: item.slug, type: item.type || null, startDate: item.startDate || null, id: item.id || null })) : null,
    type: data.type || null,
    chapter: data.chapter || null,
    url: data.url || null,
    score: data.score === 0 || data.score ? data.score : null,
  };

  // procesadoCompleto se decide únicamente al final del flujo, después de
  // guardar metadatos y comprobar los servidores de todos los capítulos.
  // No se escriben campos sin una respuesta válida: merge:true preservará el valor actual.
  return Object.fromEntries(Object.entries(normalized).filter(([, value]) => value !== null && value !== undefined));
}

function hasUsableDetails(details) {
  return Boolean(details && details.id && details.title && (
    details.cover || details.synopsis || details.genres.length || details.episodes.length || details.status
  ));
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function changedFields(existing, candidate) {
  return Object.keys(candidate).filter((key) => !sameValue(existing[key], candidate[key]));
}

function resolveSlug(docId, data) {
  const candidates = [data.id, data.internalId, data.url, docId];
  for (const candidate of candidates) {
    const slug = getIdFromUrl(String(candidate || '')) || String(candidate || '').trim();
    if (/^[a-z0-9][a-z0-9-]*$/i.test(slug) && !/^\d+$/.test(slug)) return slug;
  }
  return null;
}

function initializeFirestore() {
  // API modular compatible con versiones actuales de firebase-admin.
  if (getApps().length) return getFirestore();
  const serviceAccountPath = process.env.SERVICE_ACCOUNT_PATH;
  if (serviceAccountPath) {
    const resolved = path.resolve(serviceAccountPath);
    if (!fs.existsSync(resolved)) throw new Error(`SERVICE_ACCOUNT_PATH no existe: ${resolved}`);
    initializeApp({ credential: cert(require(resolved)) });
  } else {
    // ADC: GOOGLE_APPLICATION_CREDENTIALS o una identidad de servicio del entorno.
    initializeApp({ credential: applicationDefault(), projectId: process.env.FIREBASE_PROJECT_ID || undefined });
  }
  return getFirestore();
}

// Equivalente Admin SDK de setDoc(ref, data, { merge: true }) del SDK web.
async function setDoc(docRef, data, options) {
  return docRef.set(data, options);
}

async function getAllDocuments(db) {
  const docs = [];
  let lastDocument = null;
  do {
    let query = db.collection(COLLECTION).orderBy(FieldPath.documentId()).limit(PAGE_SIZE);
    if (lastDocument) query = query.startAfter(lastDocument);
    const page = await query.get();
    docs.push(...page.docs);
    lastDocument = page.docs.at(-1) || null;
    if (page.size < PAGE_SIZE) break;
  } while (lastDocument);
  return docs;
}

async function getRecentDocuments(db) {
  // fechaGuardado es el campo de sello usado por este script al escribir.
  const snapshot = await db.collection(COLLECTION).orderBy('fechaGuardado', 'desc').limit(LATEST_LIMIT).get();
  return snapshot.docs;
}

async function getRecentDocumentsById(db) {
  // Obtener los últimos 10 documentos ordenados por el campo "id"
  const snapshot = await db.collection(COLLECTION).orderBy('id', 'desc').limit(LATEST_LIMIT).get();
  return snapshot.docs;
}

async function findManualDocument(db, animeInput) {
  const slug = getIdFromUrl(animeInput);
  if (!slug) throw new Error('ANIME_ID o ANIME_URL no contiene un anime JKAnime válido.');

  const byDocumentId = await db.collection(COLLECTION).doc(slug).get();
  if (byDocumentId.exists) return { slug, snapshot: byDocumentId };

  const byAnimeId = await db.collection(COLLECTION).where('id', '==', slug).limit(1).get();
  if (!byAnimeId.empty) return { slug, snapshot: byAnimeId.docs[0] };

  // Último recurso: cubre colecciones donde el id del documento sea distinto.
  const allDocuments = await getAllDocuments(db);
  const matching = allDocuments.find((snapshot) => resolveSlug(snapshot.id, snapshot.data() || {}) === slug);
  return { slug, snapshot: matching || null };
}

async function mapWithConcurrency(items, limit, worker) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      await worker(items[index], index);
    }
  });
  await Promise.all(workers);
}

async function updateMetadata(db) {
  const documents = await getAllDocuments(db);
  log('INFO', `Documentos encontrados: ${documents.length}`);
  const summary = { total: documents.length, changed: 0, written: 0, unchanged: 0, skipped: 0, errors: 0 };
  await mapWithConcurrency(documents, CONCURRENCY, async (snapshot, index) => {
    const existing = snapshot.data() || {};
    const slug = resolveSlug(snapshot.id, existing);
    const prefix = `[${index + 1}/${documents.length}] ${snapshot.id}`;
    if (!slug) {
      summary.skipped += 1;
      log('WARN', `${prefix}: omitido; no se pudo determinar el slug de JKAnime.`);
      return;
    }
    try {
      const details = await getAnimeDetails(slug);
      if (!hasUsableDetails(details)) {
        summary.skipped += 1;
        log('WARN', `${prefix}: sin datos válidos de JKAnime; no se escribe nada.`);
        return;
      }
      const candidate = normalizeAnime(details, existing);
      const fields = changedFields(existing, candidate);
      if (fields.length === 0) {
        summary.unchanged += 1;
        log('INFO', `${prefix}: sin cambios.`);
        return;
      }
      summary.changed += 1;
      if (DRY_RUN) {
        log('INFO', `${prefix}: SIMULACIÓN; cambiaría: ${fields.join(', ')}.`);
        return;
      }
      await setDoc(snapshot.ref, { ...candidate, fechaGuardado: FieldValue.serverTimestamp() }, { merge: true });
      summary.written += 1;
      log('INFO', `${prefix}: actualizado (${fields.join(', ')}).`);
    } catch (error) {
      summary.errors += 1;
      log('ERROR', `${prefix}: ${safeError(error)}. Documento intacto.`);
    }
  });
  return summary;
}

async function updateServersForDocument(snapshot, slug, position, total, details = null) {
  const existing = snapshot.data() || {};
  const label = `[${position}/${total}] ${snapshot.id}`;
  const animeDetails = details || await getAnimeDetails(slug);
  // En modo servidores no se necesita título, portada ni sinopsis: basta con
  // identificar el anime y haber construido la lista de URLs de capítulos.
  if (!animeDetails || !animeDetails.id || !Array.isArray(animeDetails.episodes) || animeDetails.episodes.length === 0) {
    return { status: 'skipped', checked: 0, found: 0, missing: 0, added: 0, failures: 0, reason: 'JKAnime no devolvió capítulos utilizables' };
  }
  log('INFO', `${label}: buscando servidores de ${animeDetails.episodes.length} capítulo(s).`);
  const result = await collectServerUpdates(existing.episodios, animeDetails.episodes, label, slug);
  if (!result.episodes) {
    return { status: 'unchanged', checked: result.stats.checked, found: result.stats.withServers, missing: result.stats.withoutServers, added: 0, failures: result.stats.failures };
  }
  if (sameValue(existing.episodios, result.episodes)) {
    return { status: 'unchanged', checked: result.stats.checked, found: result.stats.withServers, missing: result.stats.withoutServers, added: 0, failures: result.stats.failures };
  }
  if (DRY_RUN) {
    log('INFO', `${label}: SIMULACIÓN; actualizaría servidores de episodios sin eliminar los existentes.`);
    return { status: 'changed', checked: result.stats.checked, found: result.stats.withServers, missing: result.stats.withoutServers, added: result.stats.newServers, failures: result.stats.failures };
  }
  await setDoc(snapshot.ref, { episodios: result.episodes, fechaGuardado: FieldValue.serverTimestamp() }, { merge: true });
  log('INFO', `${label}: servidores actualizados.`);
  return { status: 'written', checked: result.stats.checked, found: result.stats.withServers, missing: result.stats.withoutServers, added: result.stats.newServers, failures: result.stats.failures };
}

async function updateServers(db, documentsWithSlugs) {
  const summary = { total: documentsWithSlugs.length, changed: 0, written: 0, unchanged: 0, skipped: 0, errors: 0, checked: 0, found: 0, missing: 0, added: 0, episodeFailures: 0 };
  // Anime-level concurrency is one: cada anime puede producir muchas solicitudes de capítulos.
  await mapWithConcurrency(documentsWithSlugs, 1, async ({ snapshot, slug }, index) => {
    const label = `[${index + 1}/${documentsWithSlugs.length}] ${snapshot.id}`;
    try {
      const result = await updateServersForDocument(snapshot, slug, index + 1, documentsWithSlugs.length);
      summary.checked += result.checked;
      summary.found += result.found;
      summary.missing += result.missing;
      summary.added += result.added;
      summary.episodeFailures += result.failures;
      summary[result.status] += 1;
      if (result.status === 'skipped') log('WARN', `${label}: omitido; ${result.reason}.`);
    } catch (error) {
      summary.errors += 1;
      log('ERROR', `${label}: ${safeError(error)}. Documento intacto.`);
    }
  });
  return summary;
}

function emptySummary(total) {
  return { total, changed: 0, written: 0, unchanged: 0, skipped: 0, errors: 0, checked: 0, found: 0, missing: 0, added: 0, episodeFailures: 0 };
}

function addSummary(target, source) {
  for (const key of ['changed', 'written', 'unchanged', 'skipped', 'errors', 'checked', 'found', 'missing', 'added', 'episodeFailures']) {
    target[key] += source[key] || 0;
  }
}

function completionBlocker(details, serverResult) {
  if (!String(details.status || '').toLowerCase().includes('concluido')) return 'el anime no está Concluido';
  if (serverResult.status === 'skipped') return 'JKAnime no devolvió capítulos utilizables';
  if (serverResult.failures > 0) return `hubo ${serverResult.failures} fallo(s) al consultar capítulos`;
  if (serverResult.checked !== details.episodes.length) return `solo se comprobaron ${serverResult.checked}/${details.episodes.length} capítulos`;
  if (serverResult.found !== details.episodes.length) return `${details.episodes.length - serverResult.found} capítulo(s) no tienen servidores detectados`;
  return null;
}

async function processAnime(db, snapshot, slug, position, total) {
  const label = `[${position}/${total}] ${snapshot.id}`;
  const summary = emptySummary(1);
  const existing = snapshot.data() || {};

  // Omitir animes ya procesados completamente
  if (existing.procesadoCompleto) {
    summary.skipped += 1;
    log('INFO', `${label} | OMITIDO | ya procesado completamente (procesadoCompleto=true).`);
    return summary;
  }

  log('INFO', `${label} | INICIO | slug=${slug}`);
  try {
    log('INFO', `${label} | METADATOS | consultando JKAnime.`);
    const details = await getAnimeDetails(slug);
    if (!hasUsableDetails(details)) {
      summary.skipped += 1;
      log('WARN', `${label} | FIN | omitido: JKAnime no devolvió metadatos utilizables.`);
      return summary;
    }

    const candidate = normalizeAnime(details, existing);
    const fields = changedFields(existing, candidate);
    if (fields.length === 0) {
      summary.unchanged += 1;
      log('INFO', `${label} | METADATOS | sin cambios.`);
    } else {
      summary.changed += 1;
      if (DRY_RUN) {
        log('INFO', `${label} | METADATOS | SIMULACIÓN: cambiaría ${fields.join(', ')}.`);
      } else {
        await setDoc(snapshot.ref, { ...candidate, fechaGuardado: FieldValue.serverTimestamp() }, { merge: true });
        summary.written += 1;
        log('INFO', `${label} | METADATOS | guardados: ${fields.join(', ')}.`);
      }
    }

    // El paso de servidores recibe los episodios ya combinados en metadatos.
    // Así nunca sobrescribe ni pierde capítulos que aún no tengan servidor.
    // Importante: si se escribieron metadatos, recargar el documento para tener el estado actualizado.
    let snapshotForServers = snapshot;
    if (summary.written > 0) {
      const refreshed = await snapshot.ref.get();
      snapshotForServers = {
        id: refreshed.id,
        ref: refreshed.ref,
        data: () => refreshed.data() || {},
      };
    }
    log('INFO', `${label} | SERVIDORES | iniciando comprobación de ${details.episodes.length} capítulo(s).`);
    const serverResult = await updateServersForDocument(snapshotForServers, slug, position, total, details);
    summary[serverResult.status] += 1;
    summary.checked += serverResult.checked;
    summary.found += serverResult.found;
    summary.missing += serverResult.missing;
    summary.added += serverResult.added;
    summary.episodeFailures += serverResult.failures;

    const blocker = completionBlocker(details, serverResult);
    if (blocker) {
      log('INFO', `${label} | COMPLETADO | no se marca: ${blocker}.`);
    } else if (DRY_RUN) {
      log('INFO', `${label} | COMPLETADO | SIMULACIÓN: se marcaría tras metadatos y servidores correctos.`);
    } else {
      await setDoc(snapshot.ref, { procesadoCompleto: true, fechaGuardado: FieldValue.serverTimestamp() }, { merge: true });
      summary.written += 1;
      log('INFO', `${label} | COMPLETADO | marcado al finalizar metadatos y servidores.`);
    }
    log('INFO', `${label} | FIN | capítulos=${serverResult.checked} | conServidores=${serverResult.found} | sinServidores=${serverResult.missing} | fallos=${serverResult.failures}.`);
  } catch (error) {
    summary.errors += 1;
    log('ERROR', `${label} | FIN | ${safeError(error)}. Documento intacto.`);
  }
  return summary;
}

async function processAnimeList(db, documentsWithSlugs) {
  const summary = emptySummary(documentsWithSlugs.length);
  for (const [index, { snapshot, slug }] of documentsWithSlugs.entries()) {
    const result = await processAnime(db, snapshot, slug, index + 1, documentsWithSlugs.length);
    addSummary(summary, result);
  }
  return summary;
}

async function main() {
  if (!['metadata', 'servers_recent', 'servers_manual', 'servers_list', 'auto'].includes(MODE)) {
    throw new Error(`MODE inválido: ${MODE}. Use metadata, servers_recent, servers_manual, servers_list o auto.`);
  }
  log('INFO', `Inicio | modo=${MODE} | colección=${COLLECTION} | DRY_RUN=${DRY_RUN} | concurrencia=${CONCURRENCY}`);
  const db = initializeFirestore();
  let summary;

  if (MODE === 'metadata') {
    summary = await updateMetadata(db);
  } else if (MODE === 'servers_recent') {
    const documents = await getRecentDocuments(db);
    log('INFO', `Animes seleccionados por fechaGuardado (más recientes): ${documents.length}/${LATEST_LIMIT}.`);
    summary = await processAnimeList(db, documents
      .map((snapshot) => ({ snapshot, slug: resolveSlug(snapshot.id, snapshot.data() || {}) }))
      .filter((item) => item.slug));
  } else if (MODE === 'auto') {
    const documents = await getRecentDocumentsById(db);
    log('INFO', `Animes seleccionados por id (más recientes): ${documents.length}/${LATEST_LIMIT}.`);

    // Se completa cada anime antes de iniciar el siguiente: metadatos,
    // servidores y, solo si todo salió bien, procesadoCompleto.
    summary = await processAnimeList(db, documents
      .map((snapshot) => ({ snapshot, slug: resolveSlug(snapshot.id, snapshot.data() || {}) }))
      .filter((item) => item.slug));
  } else if (MODE === 'servers_list') {
    if (ANIME_LIST.length === 0) throw new Error('MODE=servers_list requiere la variable ANIME_LIST con IDs separados por comas.');
    log('INFO', `Animes solicitados desde lista: ${ANIME_LIST.length}.`);

    summary = emptySummary(ANIME_LIST.length);
    for (const [index, inputId] of ANIME_LIST.entries()) {
      try {
        const manual = await findManualDocument(db, inputId);
        const snapshot = manual.snapshot || {
          id: inputId,
          ref: db.collection(COLLECTION).doc(inputId),
          data: () => ({}),
        };
        if (!manual.snapshot) log('INFO', `[${index + 1}/${ANIME_LIST.length}] ${inputId} | documento nuevo; se creará tras validar los metadatos.`);
        const result = await processAnime(db, snapshot, manual.slug || inputId, index + 1, ANIME_LIST.length);
        addSummary(summary, result);
      } catch (error) {
        summary.errors += 1;
        log('ERROR', `[${index + 1}/${ANIME_LIST.length}] ${inputId} | FIN | ${safeError(error)}.`);
      }
    }
  } else {
    if (!MANUAL_ANIME_ID && !MANUAL_ANIME_URL) throw new Error('MODE=servers_manual requiere ANIME_ID o ANIME_URL.');
    const manual = await findManualDocument(db, MANUAL_ANIME_ID || MANUAL_ANIME_URL);
    if (!manual.snapshot) throw new Error(`No existe un documento de ${COLLECTION} para el anime ${manual.slug}; no se creará uno automáticamente.`);
    log('INFO', `Anime manual: ${manual.slug} (documento ${manual.snapshot.id}).`);
    summary = await processAnimeList(db, [{ snapshot: manual.snapshot, slug: manual.slug }]);
  }

  const serverPart = MODE.startsWith('servers') || MODE === 'auto'
    ? ` | capítulosConsultados=${summary.checked} | conServidores=${summary.found} | sinServidores=${summary.missing} | servidoresNuevos=${summary.added} | fallosCapítulos=${summary.episodeFailures}`
    : '';
  log('INFO', `Resumen final | total=${summary.total} | cambios=${summary.changed} | escritos=${summary.written} | sinCambios=${summary.unchanged} | omitidos=${summary.skipped} | errores=${summary.errors}${serverPart} | DRY_RUN=${DRY_RUN}`);
  if (!DRY_RUN && summary.errors > 0) process.exitCode = 1;
}

main().catch((error) => {
  log('ERROR', `Fallo de inicialización: ${safeError(error)}`);
  process.exitCode = 1;
});

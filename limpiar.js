/*
 * Elimina documentos inválidos de datos-animes: aquellos que no tienen ni id
 * ni titulo. Por seguridad DRY_RUN=true es el valor predeterminado.
 *
 * Requiere el mismo .env y serviceAccountKey.json que actualizar-datos-animes.js.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { applicationDefault, cert, getApps, initializeApp } = require('firebase-admin/app');
const { FieldPath, getFirestore } = require('firebase-admin/firestore');
require('dotenv').config();

const COLLECTION = process.env.FIRESTORE_COLLECTION || 'datos-animes';
const DRY_RUN = (process.env.DRY_RUN || 'true').trim().toLowerCase() !== 'false';
const PAGE_SIZE = positiveInteger(process.env.CLEANUP_PAGE_SIZE, 100, 1, 500);
const DELETE_CONCURRENCY = positiveInteger(process.env.DELETE_CONCURRENCY, 5, 1, 20);

function positiveInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function log(level, message) {
  console.log(`${new Date().toISOString()} ${level} ${message}`);
}

function safeError(error) {
  return error && error.message ? error.message : String(error);
}

function hasValue(value) {
  if (typeof value === 'string') return value.trim().length > 0;
  return value !== null && value !== undefined;
}

function initializeFirestore() {
  if (getApps().length) return getFirestore();
  const serviceAccountPath = process.env.SERVICE_ACCOUNT_PATH;
  if (serviceAccountPath) {
    const resolved = path.resolve(serviceAccountPath);
    if (!fs.existsSync(resolved)) throw new Error(`SERVICE_ACCOUNT_PATH no existe: ${resolved}`);
    initializeApp({ credential: cert(require(resolved)) });
  } else {
    initializeApp({ credential: applicationDefault(), projectId: process.env.FIREBASE_PROJECT_ID || undefined });
  }
  return getFirestore();
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

async function main() {
  log('INFO', `Inicio de limpieza | colección=${COLLECTION} | DRY_RUN=${DRY_RUN}`);
  const db = initializeFirestore();
  const documents = await getAllDocuments(db);
  const invalid = documents.filter((snapshot) => {
    const data = snapshot.data() || {};
    return !hasValue(data.id) && !hasValue(data.titulo);
  });

  log('INFO', `Revisados=${documents.length} | sin id ni titulo=${invalid.length}`);
  if (invalid.length === 0) return;

  if (DRY_RUN) {
    for (const snapshot of invalid) log('INFO', `SIMULACIÓN: se eliminaría ${snapshot.id}`);
    log('INFO', 'No se eliminó ningún documento. Cambie DRY_RUN=false para confirmar la limpieza.');
    return;
  }

  const summary = { deleted: 0, errors: 0 };
  await mapWithConcurrency(invalid, DELETE_CONCURRENCY, async (snapshot, index) => {
    try {
      await snapshot.ref.delete();
      summary.deleted += 1;
      log('INFO', `[${index + 1}/${invalid.length}] eliminado: ${snapshot.id}`);
    } catch (error) {
      summary.errors += 1;
      log('ERROR', `[${index + 1}/${invalid.length}] ${snapshot.id}: ${safeError(error)}`);
    }
  });
  log('INFO', `Resumen final | eliminados=${summary.deleted} | errores=${summary.errors}`);
  if (summary.errors > 0) process.exitCode = 1;
}

main().catch((error) => {
  log('ERROR', `Fallo de inicialización: ${safeError(error)}`);
  process.exitCode = 1;
});

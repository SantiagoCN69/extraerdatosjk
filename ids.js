const fs = require('node:fs');
const path = require('node:path');

async function obtenerSlugsDesdeUrl() {
  const urlApi = 'https://backend-animeflv-lite.onrender.com/api/browse?source=animeav1&letter=A&status=finalizado&page=5';

// ultimos desde la ultima carga
//todas las sin filtros estan hechas

//el ultimo anime de la ppagina 50 fue: fuuto tatei
//el primero de la priemra pagina fue: battle spiruts

// filtros letras: A: 4 de 13

  try {
    const respuesta = await fetch(urlApi);
    
    if (!respuesta.ok) {
      throw new Error(`Error en la petición: ${respuesta.status} ${respuesta.statusText}`);
    }

    const data = await respuesta.json();

    // Retornamos directamente el array mapeado
    return data.animes.map(anime => anime.url.split('/').pop()); 
    
  } catch (error) {
    console.error('Ocurrió un error:', error.message);
    return []; // Retornar un array vacío en caso de error para evitar que .join() falle
  }
}

async function actualizarEnvConIds(slugs) {
  const envPath = path.join(__dirname, '.env');

  try {
    // Leer el archivo .env actual
    let envContent = fs.readFileSync(envPath, 'utf-8');

    // Crear el nuevo valor de ANIME_LIST
    const nuevaLista = slugs.join(',');

    // Reemplazar o agregar la línea ANIME_LIST
    const regex = /^ANIME_LIST=.*$/m;
    if (regex.test(envContent)) {
      // Si existe, reemplazar
      envContent = envContent.replace(regex, `ANIME_LIST=${nuevaLista}`);
    } else {
      // Si no existe, agregar al final
      envContent = envContent.trim() + `\nANIME_LIST=${nuevaLista}\n`;
    }

    // Escribir el archivo actualizado
    fs.writeFileSync(envPath, envContent, 'utf-8');
    console.log(`✓ .env actualizado con ${slugs.length} IDs`);
    console.log(`✓ ANIME_LIST=${nuevaLista.substring(0, 100)}${nuevaLista.length > 100 ? '...' : ''}`);
  } catch (error) {
    console.error('Error al actualizar .env:', error.message);
  }
}

// Opción recomendada: Manejar la promesa con .then()
obtenerSlugsDesdeUrl().then(async (slugs) => {
  if (slugs.length > 0) {
    const slugsString = slugs.join(',');
    console.log(slugsString);
    await actualizarEnvConIds(slugs);
  } else {
    console.log('No se encontraron IDs para actualizar');
  }
});

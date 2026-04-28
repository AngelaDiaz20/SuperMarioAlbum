# Super Mario Sticker Checklist (Supabase Shared)

Web app estática (HTML + CSS + JS) para llevar el control **compartido** de un álbum de cromos/láminas tipo “Super Mario”, sincronizada entre dispositivos usando **Supabase** como fuente de verdad (sin login).

## Estructura

```
/
  index.html
  styles.css
  app.js
  /assets
```

> Nota: el proyecto **no incluye** imágenes oficiales por copyright. La carpeta `assets/` está lista para que agregues tus propios recursos.

## Cómo usar localmente

Opción rápida:
- Abre `index.html` en tu navegador.

Recomendado (evita restricciones con archivos locales y asegura clipboard):

```bash
# Node (si tienes instalado)
npx serve
```

```bash
# Python
python3 -m http.server 5173
```

Luego abre `http://localhost:5173`.

## Supabase: creación de tabla (SQL requerido)

Ejecuta este SQL en Supabase (SQL Editor):

```sql
create table sticker_collections (
  id uuid primary key default gen_random_uuid(),
  access_code text unique not null,
  album_name text not null default 'Super Mario Sticker Checklist',
  progress jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create or replace function update_updated_at_column()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger update_sticker_collections_updated_at
before update on sticker_collections
for each row
execute function update_updated_at_column();
```

Ejemplo de colección inicial:

```sql
insert into sticker_collections (access_code, album_name, progress)
values (
  'MARIO-FAMILIA-8392',
  'Super Mario Sticker Checklist',
  '{}'::jsonb
);
```

### Importante: RLS / Políticas (sin login)

Como la app **no usa login**, todas las consultas se hacen con el rol `anon`. Si activas RLS, necesitas políticas para permitir lectura/escritura.

Para un uso personal/familiar (no seguro), puedes permitir `anon`:

```sql
alter table sticker_collections enable row level security;

create policy "anon can read collections"
on sticker_collections
for select
to anon
using (true);

create policy "anon can update collections"
on sticker_collections
for update
to anon
using (true)
with check (true);
```

> Advertencia: esto **no es seguridad real**. Cualquiera que acceda a tu URL (o vea tu `access_code`) podría leer/escribir. Para seguridad real, usa Supabase Auth o una función serverless.

## Configurar Supabase + access_code fijo (sin pantalla de login)

Edita el bloque de configuración al inicio de `app.js`:

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `COLLECTION_ACCESS_CODE` (ej: `MARIO-FAMILIA-8392`)

Notas:
- `SUPABASE_URL` y `SUPABASE_ANON_KEY` son **públicos** en apps frontend.
- **Nunca** uses la key `service_role` en el frontend.
- El `COLLECTION_ACCESS_CODE` está “quemado” para que la app cargue **siempre** la misma colección automáticamente.

## Cómo funciona la sincronización

- Al abrir la URL, la app **consulta Supabase siempre** y carga la colección por `access_code`.
- Cada cambio (marcar “La tengo” o ajustar repetidas) se guarda con **debounce** para evitar demasiadas escrituras.
- Sincronización entre dispositivos:
  - Preferida: **Realtime** (Postgres Changes) escuchando `UPDATE` por `access_code`.
  - Respaldo: **polling** cada 10s revisando `updated_at`.

## Colección del álbum (IDs)

Por defecto usa la colección oficial (224):
- Álbum principal: `001`–`180`
- Póster: `M1`–`M44`

Extras (preparado, desactivado por defecto):
- `LE1`–`LE8`
- `O1`–`O16`

Para activarlos, cambia `ENABLE_EXTENDED_COLLECTION = true` en `app.js`.

## Funcionalidades

- Checklist con cards:
  - “La tengo”
  - Repetidas (+ / −)
  - Estados visuales (faltante / conseguida / repetida)
- Dashboard:
  - total, conseguidas, faltantes, repetidas, porcentaje y barra de progreso
- Filtros:
  - Todas / Tengo / Me faltan / Repetidas / Álbum principal / Póster
- Buscador:
  - `45` → `045`
  - `M12`
  - `LE3` (si extras activados)
- Exportar listas:
  - Copiar faltantes y repetidas al portapapeles
- Backup manual:
  - Exportar progreso como JSON
  - Importar progreso desde JSON (y se guarda también en Supabase)
- Resetear progreso con confirmación (y se guarda en Supabase)

## Imágenes en /assets (placeholders)

Puedes agregar tus imágenes propias (opcional):

- `assets/hero-mario.png`
- `assets/sticker-placeholder.png`
- `assets/coin.png`
- `assets/star.png`
- `assets/mushroom.png`

Si no existen, la app funciona igual con fallbacks visuales.

## Desplegar en Vercel (estático)

1. Sube este proyecto a GitHub.
2. En Vercel:
   - **New Project** → Importa tu repo
   - Framework Preset: **Other**
   - Build Command: **(vacío)**
   - Output Directory: **(vacío)** o `./`
3. Deploy.

## Uso desde dos celulares

- Abre la misma URL en ambos.
- Asegúrate de haber configurado correctamente `SUPABASE_URL`, `SUPABASE_ANON_KEY` y el mismo `COLLECTION_ACCESS_CODE`.
- Cuando marques un cromo en un celular, el otro se actualiza vía Realtime o polling.


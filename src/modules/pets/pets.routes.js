import { Router } from 'express'
import { db, ensureDb } from '../../database/connection.js'
import { requireAuth } from '../../middleware/requireAuth.js'
import { toPet } from './pets.mapper.js'

export const petsRouter = Router()

const defaultRadiusMeters = 1500
const minRadiusMeters = 100
const maxRadiusMeters = 8000
const earthRadiusMeters = 6371000
const validStatuses = new Set(['lost', 'found'])
const validTypes = new Set(['dog', 'cat', 'other'])
const validCollars = new Set(['yes', 'no', 'unknown'])
const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/
const imageDataUrlPattern = /^data:image\/(png|jpe?g|webp|gif);base64,[a-z0-9+/=]+$/i

const cleanText = (value, maxLength) => (
  typeof value === 'string' ? value.trim().slice(0, maxLength) : ''
)

const parseRadiusMeters = (value, fallback = defaultRadiusMeters) => {
  if (value === undefined || value === null || value === '') return fallback
  const radius = Number(value)
  if (!Number.isFinite(radius) || radius < minRadiusMeters || radius > maxRadiusMeters) return null
  return Math.round(radius)
}

const parseCoordinate = (value, min, max) => {
  if (value === undefined || value === null || value === '') return null
  const coordinate = Number(value)
  return Number.isFinite(coordinate) && coordinate >= min && coordinate <= max ? coordinate : undefined
}

const normalizeImage = (value) => {
  if (value === null || value === undefined || value === '') return null
  if (typeof value !== 'string') return undefined
  const image = value.trim()
  if (image.length > 2 * 1024 * 1024 * 1.37) return undefined
  return imageDataUrlPattern.test(image) ? image : undefined
}

const selectPetSql = `
  SELECT
    pets.*,
    users.name AS owner_name,
    users.avatar_url AS owner_avatar_url,
    users.contact_phone AS owner_contact_phone
  FROM pets
  INNER JOIN users ON users.id = pets.user_id
`

const distanceSql = `
  (${earthRadiusMeters} * 2 * ASIN(SQRT(
    POWER(SIN((RADIANS(pets.latitude) - RADIANS(?)) / 2), 2)
    + COS(RADIANS(?)) * COS(RADIANS(pets.latitude))
    * POWER(SIN((RADIANS(pets.longitude) - RADIANS(?)) / 2), 2)
  )))
`

const selectPetSearchSql = `
  SELECT
    pets.*,
    users.name AS owner_name,
    users.avatar_url AS owner_avatar_url,
    users.contact_phone AS owner_contact_phone,
    ${distanceSql} AS distance_meters
  FROM pets
  INNER JOIN users ON users.id = pets.user_id
`

const validatePetBody = (body, partial = false) => {
  const status = body.status === undefined && partial ? null : cleanText(body.status, 20)
  const type = body.type === undefined && partial ? null : cleanText(body.type, 30)

  if (status !== null && !validStatuses.has(status)) return { error: 'Indicá si la mascota está perdida o encontrada.' }
  if (type !== null && !validTypes.has(type)) return { error: 'Elegí un tipo de mascota válido.' }

  const collar = body.collar === undefined && partial ? null : cleanText(body.collar || 'unknown', 20)
  if (collar !== null && !validCollars.has(collar)) return { error: 'El dato del collar es inválido.' }

  const radiusMeters = body.radiusMeters === undefined && partial
    ? null
    : parseRadiusMeters(body.radiusMeters)
  if (radiusMeters === null && !(body.radiusMeters === undefined && partial)) {
    return { error: 'El radio de búsqueda es inválido.' }
  }

  const latitude = parseCoordinate(body.latitude, -90, 90)
  const longitude = parseCoordinate(body.longitude, -180, 180)
  const coordinatesOmitted = partial && body.latitude === undefined && body.longitude === undefined
  if (!coordinatesOmitted && (
    latitude === null || longitude === null || latitude === undefined || longitude === undefined
    || ((latitude === null) !== (longitude === null))
  )) {
    return { error: 'La ubicación de la mascota es inválida.' }
  }

  const photoUrl = body.photoUrl === undefined && partial ? null : normalizeImage(body.photoUrl)
  if (photoUrl === undefined) return { error: 'La foto debe ser una imagen válida de hasta 2 MB.' }

  return {
    status,
    type,
    name: body.name === undefined && partial ? null : cleanText(body.name, 100),
    breed: body.breed === undefined && partial ? null : cleanText(body.breed, 100),
    collar,
    description: body.description === undefined && partial ? null : cleanText(body.description, 4000),
    photoUrl,
    latitude,
    longitude,
    radiusMeters,
  }
}

petsRouter.get('/search', async (req, res) => {
  if (!ensureDb(res)) return

  const latitude = parseCoordinate(req.query.latitude, -90, 90)
  const longitude = parseCoordinate(req.query.longitude, -180, 180)
  if (latitude === undefined || longitude === undefined || ((latitude === null) !== (longitude === null))) {
    return res.status(400).json({ message: 'Indicá una ubicación válida para buscar mascotas.' })
  }

  const where = []
  const values = []
  const status = cleanText(req.query.status, 20)
  const type = cleanText(req.query.type, 30)
  const breed = cleanText(req.query.breed, 100)
  const collar = cleanText(req.query.collar, 20)
  const name = cleanText(req.query.name, 100)
  const lostDate = cleanText(req.query.lostDate, 10)

  if (lostDate && !isoDatePattern.test(lostDate)) {
    return res.status(400).json({ message: 'La fecha de pérdida es inválida.' })
  }

  if (validStatuses.has(status)) { where.push('pets.status = ?'); values.push(status) }
  if (validTypes.has(type)) { where.push('pets.type = ?'); values.push(type) }
  if (breed) { where.push('pets.breed LIKE ?'); values.push(`%${breed}%`) }
  if (validCollars.has(collar)) { where.push('pets.collar = ?'); values.push(collar) }
  if (name) { where.push('pets.name LIKE ?'); values.push(`%${name}%`) }
  if (status === 'found' && lostDate) {
    where.push('DATE(pets.created_at) >= ?')
    values.push(lostDate)
  }
  where.push('pets.latitude IS NOT NULL AND pets.longitude IS NOT NULL')

  try {
    const [rows] = await db.execute(
      `${selectPetSearchSql}
       WHERE ${where.join(' AND ')}
       HAVING distance_meters <= pets.radius_meters
       ORDER BY distance_meters ASC, pets.created_at DESC
       LIMIT 100`,
      [latitude, latitude, longitude, ...values],
    )
    return res.json({ pets: rows.map(toPet) })
  } catch (error) {
    console.error('Error buscando mascotas:', error)
    return res.status(500).json({ message: 'No se pudieron buscar mascotas.' })
  }
})

petsRouter.use(requireAuth)

petsRouter.get('/', async (req, res) => {
  if (!ensureDb(res)) return
  try {
    const [rows] = await db.execute(
      `${selectPetSql} WHERE pets.user_id = ? ORDER BY pets.created_at DESC`,
      [req.userId],
    )
    return res.json({ pets: rows.map(toPet) })
  } catch (error) {
    console.error('Error listando mascotas:', error)
    return res.status(500).json({ message: 'No se pudieron cargar tus mascotas.' })
  }
})

petsRouter.post('/', async (req, res) => {
  if (!ensureDb(res)) return
  const values = validatePetBody(req.body || {})
  if (values.error) return res.status(400).json({ message: values.error })

  try {
    const [result] = await db.execute(
      `INSERT INTO pets
        (user_id, status, type, name, breed, collar, description, photo_url, latitude, longitude, radius_meters)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [req.userId, values.status, values.type, values.name || null, values.breed || null,
        values.collar, values.description || null, values.photoUrl, values.latitude, values.longitude, values.radiusMeters],
    )
    const [rows] = await db.execute(`${selectPetSql} WHERE pets.id = ? AND pets.user_id = ?`, [result.insertId, req.userId])
    return res.status(201).json({ pet: toPet(rows[0]) })
  } catch (error) {
    console.error('Error creando mascota:', error)
    return res.status(500).json({ message: 'No se pudo guardar la mascota.' })
  }
})

petsRouter.patch('/:id', async (req, res) => {
  if (!ensureDb(res)) return
  const id = Number(req.params.id)
  if (!Number.isInteger(id)) return res.status(400).json({ message: 'Mascota inválida.' })
  const values = validatePetBody(req.body || {}, true)
  if (values.error) return res.status(400).json({ message: values.error })

  const fields = []
  const params = []
  for (const [column, value] of Object.entries({
    status: values.status,
    type: values.type,
    name: values.name,
    breed: values.breed,
    collar: values.collar,
    description: values.description,
    photo_url: values.photoUrl,
    latitude: values.latitude,
    longitude: values.longitude,
    radius_meters: values.radiusMeters,
  })) {
    if (value !== null) { fields.push(`${column} = ?`); params.push(value || null) }
  }
  if (!fields.length) return res.status(400).json({ message: 'No hay cambios para guardar.' })

  try {
    await db.execute(`UPDATE pets SET ${fields.join(', ')} WHERE id = ? AND user_id = ?`, [...params, id, req.userId])
    const [rows] = await db.execute(`${selectPetSql} WHERE pets.id = ? AND pets.user_id = ?`, [id, req.userId])
    if (!rows.length) return res.status(404).json({ message: 'La mascota no existe.' })
    return res.json({ pet: toPet(rows[0]) })
  } catch (error) {
    console.error('Error actualizando mascota:', error)
    return res.status(500).json({ message: 'No se pudo actualizar la mascota.' })
  }
})

petsRouter.delete('/:id', async (req, res) => {
  if (!ensureDb(res)) return
  const id = Number(req.params.id)
  if (!Number.isInteger(id)) return res.status(400).json({ message: 'Mascota inválida.' })
  try {
    const [result] = await db.execute('DELETE FROM pets WHERE id = ? AND user_id = ?', [id, req.userId])
    if (!result.affectedRows) return res.status(404).json({ message: 'La mascota no existe.' })
    return res.status(204).send()
  } catch (error) {
    console.error('Error eliminando mascota:', error)
    return res.status(500).json({ message: 'No se pudo eliminar la mascota.' })
  }
})

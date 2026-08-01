import { Router } from 'express'
import { db, ensureDb } from '../../database/connection.js'
import { requireAuth } from '../../middleware/requireAuth.js'
import { getValidatedAuthenticatedUserId } from '../auth/session.js'
import { getUserLimits } from '../premium/premiumLimits.js'
import { toJobUbication } from './jobUbications.mapper.js'

export const jobUbicationsRouter = Router()

const defaultRadiusMeters = 1500
const minRadiusMeters = 100
const maxRadiusMeters = 8000
const earthRadiusMeters = 6371000

const providerRatingJoinSql = `
  LEFT JOIN (
    SELECT
      rated_user_id,
      ROUND(AVG(score), 1) AS provider_rating_average,
      COUNT(*) AS provider_rating_count
    FROM jobRatings
    GROUP BY rated_user_id
  ) AS providerRatings
    ON providerRatings.rated_user_id = users.id
`

const providerRatingCommentsJoinSql = `
  LEFT JOIN (
    SELECT
      rated_user_id,
      JSON_ARRAYAGG(
        JSON_OBJECT(
          'id', id,
          'score', score,
          'comment', comment_text,
          'raterName', rater_name,
          'createdAt', created_at
        )
      ) AS provider_rating_comments
    FROM (
      SELECT
        jobRatings.id,
        jobRatings.rated_user_id,
        jobRatings.score,
        jobRatings.comment_text,
        jobRatings.created_at,
        ratingUsers.name AS rater_name,
        ROW_NUMBER() OVER (
          PARTITION BY jobRatings.rated_user_id
          ORDER BY jobRatings.created_at DESC
        ) AS comment_rank
      FROM jobRatings
      INNER JOIN users AS ratingUsers
        ON ratingUsers.id = jobRatings.rater_user_id
      WHERE jobRatings.comment_text <> ''
    ) AS rankedRatingComments
    WHERE comment_rank <= 5
    GROUP BY rated_user_id
  ) AS providerRatingComments
    ON providerRatingComments.rated_user_id = users.id
`

const parseRadiusMeters = (value, fallback = defaultRadiusMeters) => {
  if (value === undefined || value === null || value === '') {
    return fallback
  }

  const radiusMeters = Number(value)

  if (
    !Number.isFinite(radiusMeters)
    || radiusMeters < minRadiusMeters
    || radiusMeters > maxRadiusMeters
  ) {
    return null
  }

  return Math.round(radiusMeters)
}

const selectJobUbicationSql = `
  SELECT
    jobUbications.id,
    jobUbications.user_id,
    jobUbications.specialty_id,
    jobUbications.latitude,
    jobUbications.longitude,
    jobUbications.radius_meters,
    jobUbications.label,
    jobUbications.created_at,
    jobSpecialties.name AS specialty_name,
    users.name AS provider_name,
    users.avatar_url AS provider_avatar_url,
    users.contact_phone AS provider_contact_phone,
    users.work_hours AS provider_work_hours,
    users.profile_description AS provider_profile_description,
    CASE
      WHEN users.premium_status = 'active'
        AND (users.premium_expires_at IS NULL OR users.premium_expires_at > NOW())
      THEN 1
      ELSE 0
    END AS provider_is_premium,
    providerRatings.provider_rating_average,
    providerRatings.provider_rating_count,
    providerRatingComments.provider_rating_comments
  FROM jobUbications
  LEFT JOIN jobSpecialties
    ON jobSpecialties.id = jobUbications.specialty_id
  LEFT JOIN users
    ON users.id = jobUbications.user_id
  ${providerRatingJoinSql}
  ${providerRatingCommentsJoinSql}
`

const distanceFromPointSql = `
  (${earthRadiusMeters} * 2 * ASIN(SQRT(
    POWER(SIN((RADIANS(jobUbications.latitude) - RADIANS(?)) / 2), 2)
    + COS(RADIANS(?))
    * COS(RADIANS(jobUbications.latitude))
    * POWER(SIN((RADIANS(jobUbications.longitude) - RADIANS(?)) / 2), 2)
  )))
`

const isValidLatitude = (latitude) => Number.isFinite(latitude) && latitude >= -90 && latitude <= 90
const isValidLongitude = (longitude) => Number.isFinite(longitude) && longitude >= -180 && longitude <= 180

jobUbicationsRouter.get('/search', async (req, res) => {
  if (!ensureDb(res)) {
    return
  }

  const specialtyId = Number(req.query.specialtyId)
  const latitude = Number(req.query.latitude)
  const longitude = Number(req.query.longitude)
  const viewerUserId = await getValidatedAuthenticatedUserId(req)
  const canViewPrivateProfile = viewerUserId ? 1 : 0
  const privateProfileSelectSql = canViewPrivateProfile
    ? `
              jobSpecialties.name AS specialty_name,
              users.work_hours AS provider_work_hours,
              users.profile_description AS provider_profile_description,
              providerRatings.provider_rating_average,
              providerRatings.provider_rating_count,
              providerRatingComments.provider_rating_comments,
              1 AS can_view_private_profile,
    `
    : `
              NULL AS specialty_name,
              NULL AS provider_work_hours,
              NULL AS provider_profile_description,
              NULL AS provider_rating_average,
              0 AS provider_rating_count,
              NULL AS provider_rating_comments,
              0 AS can_view_private_profile,
    `

  if (!Number.isInteger(specialtyId)) {
    return res.status(400).json({ message: 'Elegí una especialidad para buscar.' })
  }

  if (!isValidLatitude(latitude)) {
    return res.status(400).json({ message: 'Latitud inválida.' })
  }

  if (!isValidLongitude(longitude)) {
    return res.status(400).json({ message: 'Longitud inválida.' })
  }

  try {
    const [rows] = await db.execute(
      `SELECT *
      FROM (
        SELECT
          inRange.*,
          ROW_NUMBER() OVER (
            PARTITION BY inRange.user_id
            ORDER BY inRange.distance_meters ASC, inRange.created_at DESC
          ) AS user_match_rank
        FROM (
          SELECT *
          FROM (
            SELECT
              jobUbications.id,
              jobUbications.user_id,
              jobUbications.specialty_id,
              jobSpecialties.specialty_id AS catalog_specialty_id,
              jobUbications.latitude,
              jobUbications.longitude,
              jobUbications.radius_meters,
              jobUbications.label,
              jobUbications.created_at,
              users.name AS provider_name,
              users.avatar_url AS provider_avatar_url,
              users.contact_phone AS provider_contact_phone,
              CASE
                WHEN users.premium_status = 'active'
                  AND (users.premium_expires_at IS NULL OR users.premium_expires_at > NOW())
                THEN 1
                ELSE 0
              END AS provider_is_premium,
              ${privateProfileSelectSql}
              ${distanceFromPointSql} AS distance_meters
            FROM jobUbications
            INNER JOIN jobSpecialties
              ON jobSpecialties.id = jobUbications.specialty_id
            INNER JOIN users
              ON users.id = jobUbications.user_id
            ${providerRatingJoinSql}
            ${providerRatingCommentsJoinSql}
            WHERE jobSpecialties.specialty_id = ?
          ) AS matches
          WHERE matches.distance_meters <= matches.radius_meters
        ) AS inRange
      ) AS rankedMatches
      WHERE rankedMatches.user_match_rank = 1
      ORDER BY rankedMatches.provider_is_premium DESC, rankedMatches.distance_meters ASC, rankedMatches.created_at DESC
      LIMIT 80`,
      [latitude, latitude, longitude, specialtyId],
    )

    return res.json({ jobUbications: rows.map(toJobUbication) })
  } catch (error) {
    console.error('Error buscando servicios:', error)
    return res.status(500).json({ message: 'No se pudieron buscar servicios en esa zona.' })
  }
})

jobUbicationsRouter.use(requireAuth)

jobUbicationsRouter.get('/', async (req, res) => {
  if (!ensureDb(res)) {
    return
  }

  try {
    const specialtyId = Number(req.query.specialtyId)
    const hasSpecialtyFilter = Number.isInteger(specialtyId)
    const sql = `
      ${selectJobUbicationSql}
      WHERE jobUbications.user_id = ?
      ${hasSpecialtyFilter ? 'AND jobUbications.specialty_id = ?' : ''}
      ORDER BY jobUbications.created_at DESC
    `
    const [rows] = await db.execute(
      sql,
      hasSpecialtyFilter ? [req.userId, specialtyId] : [req.userId],
    )

    return res.json({ jobUbications: rows.map(toJobUbication) })
  } catch (error) {
    console.error('Error listando ubicaciones:', error)
    return res.status(500).json({ message: 'No se pudieron cargar las ubicaciones.' })
  }
})

jobUbicationsRouter.post('/', async (req, res) => {
  if (!ensureDb(res)) {
    return
  }

  const latitude = Number(req.body.latitude)
  const longitude = Number(req.body.longitude)
  const specialtyId = Number(req.body.specialtyId)
  const radiusMeters = parseRadiusMeters(req.body.radiusMeters)
  const label = typeof req.body.label === 'string' ? req.body.label.trim().slice(0, 120) : null

  if (!isValidLatitude(latitude)) {
    return res.status(400).json({ message: 'Latitud inválida.' })
  }

  if (!isValidLongitude(longitude)) {
    return res.status(400).json({ message: 'Longitud inválida.' })
  }

  if (!Number.isInteger(specialtyId)) {
    return res.status(400).json({ message: 'Elegí una especialidad para guardar el punto.' })
  }

  if (radiusMeters === null) {
    return res.status(400).json({ message: 'El radio de cobertura es inválido.' })
  }

  try {
    const [specialties] = await db.execute(
      'SELECT id FROM jobSpecialties WHERE id = ? AND user_id = ? LIMIT 1',
      [specialtyId, req.userId],
    )

    if (!specialties.length) {
      return res.status(404).json({ message: 'La especialidad no existe para este usuario.' })
    }

    const limits = await getUserLimits(req.userId)
    const [countRows] = await db.execute(
      'SELECT COUNT(*) AS total FROM jobUbications WHERE user_id = ? AND specialty_id = ?',
      [req.userId, specialtyId],
    )
    const pointCount = Number(countRows[0]?.total || 0)

    if (pointCount >= limits.pinsPerSpecialtyLimit) {
      return res.status(403).json({
        message: `Llegaste al límite de ${limits.pinsPerSpecialtyLimit} puntos para esta especialidad${limits.isPremium ? '.' : '. Activá Premium para cargar hasta 20.'}`,
      })
    }

    const [result] = await db.execute(
      'INSERT INTO jobUbications (user_id, specialty_id, latitude, longitude, radius_meters, label) VALUES (?, ?, ?, ?, ?, ?)',
      [req.userId, specialtyId, latitude, longitude, radiusMeters, label || null],
    )
    const [rows] = await db.execute(
      `${selectJobUbicationSql}
      WHERE jobUbications.id = ? AND jobUbications.user_id = ?`,
      [result.insertId, req.userId],
    )

    return res.status(201).json({ jobUbication: toJobUbication(rows[0]) })
  } catch (error) {
    console.error('Error creando ubicación:', error)
    return res.status(500).json({ message: 'No se pudo guardar la ubicación.' })
  }
})

jobUbicationsRouter.patch('/:id', async (req, res) => {
  if (!ensureDb(res)) {
    return
  }

  const body = req.body || {}
  const id = Number(req.params.id)

  if (!Number.isInteger(id)) {
    return res.status(400).json({ message: 'Ubicación inválida.' })
  }

  const updates = []
  const values = []
  const hasLatitude = Object.hasOwn(body, 'latitude')
  const hasLongitude = Object.hasOwn(body, 'longitude')

  if (hasLatitude || hasLongitude) {
    const latitude = Number(body.latitude)
    const longitude = Number(body.longitude)

    if (!isValidLatitude(latitude)) {
      return res.status(400).json({ message: 'Latitud inválida.' })
    }

    if (!isValidLongitude(longitude)) {
      return res.status(400).json({ message: 'Longitud inválida.' })
    }

    updates.push('latitude = ?', 'longitude = ?')
    values.push(latitude, longitude)
  }

  if (Object.hasOwn(body, 'radiusMeters')) {
    const radiusMeters = parseRadiusMeters(body.radiusMeters, null)

    if (radiusMeters === null) {
      return res.status(400).json({ message: 'El radio de cobertura es inválido.' })
    }

    updates.push('radius_meters = ?')
    values.push(radiusMeters)
  }

  if (!updates.length) {
    return res.status(400).json({ message: 'No hay cambios para guardar.' })
  }

  try {
    const [result] = await db.execute(
      `UPDATE jobUbications
      SET ${updates.join(', ')}
      WHERE id = ? AND user_id = ?`,
      [...values, id, req.userId],
    )

    if (!result.affectedRows) {
      return res.status(404).json({ message: 'La ubicación no existe.' })
    }

    const [rows] = await db.execute(
      `${selectJobUbicationSql}
      WHERE jobUbications.id = ? AND jobUbications.user_id = ?`,
      [id, req.userId],
    )

    return res.json({ jobUbication: toJobUbication(rows[0]) })
  } catch (error) {
    console.error('Error actualizando ubicación:', error)
    return res.status(500).json({ message: 'No se pudo actualizar la ubicación.' })
  }
})

jobUbicationsRouter.delete('/:id', async (req, res) => {
  if (!ensureDb(res)) {
    return
  }

  const id = Number(req.params.id)

  if (!Number.isInteger(id)) {
    return res.status(400).json({ message: 'Ubicación inválida.' })
  }

  try {
    const [locations] = await db.execute(
      `SELECT id, specialty_id
      FROM jobUbications
      WHERE id = ? AND user_id = ?
      LIMIT 1`,
      [id, req.userId],
    )
    const location = locations[0]

    if (!location) {
      return res.status(404).json({ message: 'La ubicación no existe.' })
    }

    if (location.specialty_id) {
      const [countRows] = await db.execute(
        `SELECT COUNT(*) AS total
        FROM jobUbications
        WHERE user_id = ? AND specialty_id = ?`,
        [req.userId, location.specialty_id],
      )

      if (Number(countRows[0]?.total || 0) <= 1) {
        return res.status(409).json({
          message: 'Cada especialidad debe conservar al menos un punto. Podés moverlo o eliminar la especialidad completa.',
        })
      }
    }

    await db.execute('DELETE FROM jobUbications WHERE id = ? AND user_id = ?', [id, req.userId])

    return res.status(204).send()
  } catch (error) {
    console.error('Error eliminando ubicación:', error)
    return res.status(500).json({ message: 'No se pudo eliminar la ubicación.' })
  }
})

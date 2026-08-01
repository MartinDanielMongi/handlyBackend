import { Router } from 'express'
import { db, ensureDb } from '../../database/connection.js'
import { requireAuth } from '../../middleware/requireAuth.js'
import { getUserLimits } from '../premium/premiumLimits.js'
import { toJobSpecialty } from './jobSpecialties.mapper.js'

export const jobSpecialtiesRouter = Router()

jobSpecialtiesRouter.use(requireAuth)

jobSpecialtiesRouter.get('/', async (req, res) => {
  if (!ensureDb(res)) {
    return
  }

  try {
    const [rows] = await db.execute(
      `SELECT
        jobSpecialties.id,
        jobSpecialties.user_id,
        jobSpecialties.specialty_id,
        COALESCE(specialties.name, jobSpecialties.name) AS name,
        jobSpecialties.created_at
      FROM jobSpecialties
      LEFT JOIN specialties
        ON specialties.id = jobSpecialties.specialty_id
      WHERE jobSpecialties.user_id = ?
      ORDER BY name ASC`,
      [req.userId],
    )

    return res.json({ jobSpecialties: rows.map(toJobSpecialty) })
  } catch (error) {
    console.error('Error listando especialidades:', error)
    return res.status(500).json({ message: 'No se pudieron cargar las especialidades.' })
  }
})

jobSpecialtiesRouter.post('/', async (req, res) => {
  if (!ensureDb(res)) {
    return
  }

  const specialtyId = Number(req.body.specialtyId)

  if (!Number.isInteger(specialtyId)) {
    return res.status(400).json({ message: 'Elegí una especialidad del listado.' })
  }

  try {
    const [specialtiesWithoutPoints] = await db.execute(
      `SELECT jobSpecialties.id, jobSpecialties.name
      FROM jobSpecialties
      LEFT JOIN jobUbications
        ON jobUbications.specialty_id = jobSpecialties.id
      WHERE jobSpecialties.user_id = ?
      GROUP BY jobSpecialties.id, jobSpecialties.name
      HAVING COUNT(jobUbications.id) = 0
      LIMIT 1`,
      [req.userId],
    )

    if (specialtiesWithoutPoints.length) {
      return res.status(409).json({
        message: `Primero marcá una zona de trabajo para ${specialtiesWithoutPoints[0].name}.`,
      })
    }

    const limits = await getUserLimits(req.userId)

    if (limits.specialtyLimit !== null) {
      const [countRows] = await db.execute(
        'SELECT COUNT(*) AS total FROM jobSpecialties WHERE user_id = ?',
        [req.userId],
      )
      const specialtyCount = Number(countRows[0]?.total || 0)

      if (specialtyCount >= limits.specialtyLimit) {
        return res.status(403).json({
          message: `Las cuentas gratis pueden tener hasta ${limits.specialtyLimit} especialidades. Activá Premium para agregar más.`,
        })
      }
    }

    const [catalogRows] = await db.execute(
      'SELECT id, name FROM specialties WHERE id = ? LIMIT 1',
      [specialtyId],
    )
    const catalogSpecialty = catalogRows[0]

    if (!catalogSpecialty) {
      return res.status(404).json({ message: 'La especialidad elegida no existe.' })
    }

    const [result] = await db.execute(
      'INSERT INTO jobSpecialties (user_id, specialty_id, name) VALUES (?, ?, ?)',
      [req.userId, catalogSpecialty.id, catalogSpecialty.name],
    )
    const [rows] = await db.execute(
      `SELECT
        jobSpecialties.id,
        jobSpecialties.user_id,
        jobSpecialties.specialty_id,
        COALESCE(specialties.name, jobSpecialties.name) AS name,
        jobSpecialties.created_at
      FROM jobSpecialties
      LEFT JOIN specialties
        ON specialties.id = jobSpecialties.specialty_id
      WHERE jobSpecialties.id = ? AND jobSpecialties.user_id = ?`,
      [result.insertId, req.userId],
    )

    return res.status(201).json({ jobSpecialty: toJobSpecialty(rows[0]) })
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY' || error.errno === 1062) {
      return res.status(409).json({ message: 'Ya tenés esa especialidad cargada.' })
    }

    console.error('Error creando especialidad:', error)
    return res.status(500).json({ message: 'No se pudo guardar la especialidad.' })
  }
})

jobSpecialtiesRouter.delete('/:id', async (req, res) => {
  if (!ensureDb(res)) {
    return
  }

  const id = Number(req.params.id)

  if (!Number.isInteger(id)) {
    return res.status(400).json({ message: 'Especialidad inválida.' })
  }

  try {
    await db.execute('DELETE FROM jobSpecialties WHERE id = ? AND user_id = ?', [id, req.userId])

    return res.status(204).send()
  } catch (error) {
    console.error('Error eliminando especialidad:', error)
    return res.status(500).json({ message: 'No se pudo eliminar la especialidad.' })
  }
})

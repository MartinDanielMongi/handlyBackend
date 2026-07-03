import { Router } from 'express'
import { db, ensureDb } from '../../database/connection.js'
import { toSpecialty } from './specialties.mapper.js'

export const specialtiesRouter = Router()

specialtiesRouter.get('/', async (req, res) => {
  if (!ensureDb(res)) {
    return
  }

  try {
    const [rows] = await db.execute(
      'SELECT id, name, created_at FROM specialties ORDER BY name ASC',
    )

    return res.json({ specialties: rows.map(toSpecialty) })
  } catch (error) {
    console.error('Error listando catalogo de especialidades:', error)
    return res.status(500).json({ message: 'No se pudo cargar el catalogo de especialidades.' })
  }
})

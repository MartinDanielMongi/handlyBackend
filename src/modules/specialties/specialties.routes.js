import { Router } from 'express'
import {
  resendApiKey,
  resetEmailFrom,
  specialtyRequestNotificationEmail,
} from '../../config/env.js'
import { db, ensureDb } from '../../database/connection.js'
import { getValidatedAuthenticatedUserId } from '../auth/session.js'
import { toSpecialty } from './specialties.mapper.js'

export const specialtiesRouter = Router()
const resendEmailUrl = 'https://api.resend.com/emails'

const normalizeSpecialtyName = (value) => String(value || '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/[^a-z0-9\s]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()

const escapeHtml = (value) => String(value ?? '')
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#039;')

const sendSpecialtyRequestNotification = async ({ request, user }) => {
  if (!resendApiKey || !resetEmailFrom || !specialtyRequestNotificationEmail) {
    console.warn('Notificacion de solicitudes de especialidad desactivada: faltan variables de email.')
    return false
  }

  const response = await fetch(resendEmailUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${resendApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: resetEmailFrom,
      to: [specialtyRequestNotificationEmail],
      subject: `Nueva especialidad solicitada: ${request.requested_name}`,
      text: `Nueva solicitud de especialidad #${request.id}\n\nEspecialidad: ${request.requested_name}\nUsuario: ${user.name} (${user.email})\nFecha: ${request.created_at}`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:640px;margin:auto;color:#19352d">
          <h1 style="font-size:22px">Nueva especialidad solicitada</h1>
          <div style="margin:20px 0;padding:16px;background:#f3f7f5;border-radius:10px">
            <strong style="font-size:18px">${escapeHtml(request.requested_name)}</strong>
          </div>
          <p><strong>Usuario:</strong> ${escapeHtml(user.name)} (${escapeHtml(user.email)})</p>
          <p><strong>Solicitud:</strong> #${request.id}</p>
          <p><strong>Fecha:</strong> ${escapeHtml(request.created_at)}</p>
        </div>
      `,
    }),
    signal: AbortSignal.timeout(8000),
  })

  if (!response.ok) {
    const errorBody = await response.text()
    throw new Error(`Resend respondio ${response.status}: ${errorBody}`)
  }

  return true
}

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

specialtiesRouter.post('/requests', async (req, res) => {
  if (!ensureDb(res)) {
    return
  }

  const userId = await getValidatedAuthenticatedUserId(req)

  if (!userId) {
    return res.status(401).json({ message: 'Inicia sesion para solicitar una especialidad.' })
  }

  const requestedName = String(req.body.name || '').trim().replace(/\s+/g, ' ')
  const normalizedName = normalizeSpecialtyName(requestedName)

  if (requestedName.length < 3 || requestedName.length > 100) {
    return res.status(400).json({ message: 'La especialidad debe tener entre 3 y 100 caracteres.' })
  }

  try {
    const [catalogRows] = await db.execute('SELECT id, name FROM specialties')
    const existingSpecialty = catalogRows.find(
      (specialty) => normalizeSpecialtyName(specialty.name) === normalizedName,
    )

    if (existingSpecialty) {
      return res.status(409).json({
        message: `${existingSpecialty.name} ya esta disponible en la lista.`,
        specialty: toSpecialty(existingSpecialty),
      })
    }

    const [pendingRows] = await db.execute(
      `SELECT id FROM specialtyRequests
      WHERE normalized_name = ? AND status = 'pending'
      LIMIT 1`,
      [normalizedName],
    )

    if (pendingRows.length) {
      return res.status(409).json({ message: 'Esta especialidad ya fue solicitada y esta pendiente de revision.' })
    }

    const [recentRows] = await db.execute(
      `SELECT COUNT(*) AS total FROM specialtyRequests
      WHERE user_id = ? AND created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)`,
      [userId],
    )

    if (Number(recentRows[0]?.total || 0) >= 5) {
      return res.status(429).json({ message: 'Alcanzaste el limite de 5 solicitudes por dia.' })
    }

    const [users] = await db.execute('SELECT name, email FROM users WHERE id = ? LIMIT 1', [userId])
    const [result] = await db.execute(
      `INSERT INTO specialtyRequests (user_id, requested_name, normalized_name)
      VALUES (?, ?, ?)`,
      [userId, requestedName, normalizedName],
    )
    const [requests] = await db.execute(
      `SELECT id, requested_name, status, created_at
      FROM specialtyRequests WHERE id = ? LIMIT 1`,
      [result.insertId],
    )
    const request = requests[0]
    let notificationSent = false

    try {
      notificationSent = await sendSpecialtyRequestNotification({ request, user: users[0] })
    } catch (notificationError) {
      console.error('Error enviando notificacion de especialidad:', notificationError)
    }

    return res.status(201).json({
      message: 'Solicitud enviada. Te avisaremos cuando sea revisada.',
      request: {
        id: request.id,
        name: request.requested_name,
        status: request.status,
        createdAt: request.created_at,
      },
      notificationSent,
    })
  } catch (error) {
    console.error('Error guardando solicitud de especialidad:', error)
    return res.status(500).json({ message: 'No se pudo guardar la solicitud.' })
  }
})

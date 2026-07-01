import { Router } from 'express'
import { db, ensureDb } from '../../database/connection.js'
import { requireAuth } from '../../middleware/requireAuth.js'

export const ratingsRouter = Router()

const minScore = 1
const maxScore = 10
const minCommentLength = 5
const maxCommentLength = 800
const monthlyRatingLimit = 2
const ratingCommentsLimit = 5

const currentMonthRatingsSql = `
  SELECT COUNT(*) AS monthly_count
  FROM jobRatings
  WHERE rater_user_id = ?
    AND created_at >= DATE_SUB(CURRENT_DATE(), INTERVAL (DAYOFMONTH(CURRENT_DATE()) - 1) DAY)
    AND created_at < DATE_ADD(
      DATE_SUB(CURRENT_DATE(), INTERVAL (DAYOFMONTH(CURRENT_DATE()) - 1) DAY),
      INTERVAL 1 MONTH
    )
`

const toRatingStatus = (user, monthlyUsed) => {
  const isEligible = Boolean(Number(user.is_rating_eligible))
  const monthlyRemaining = Math.max(0, monthlyRatingLimit - monthlyUsed)

  return {
    accountAgeDays: Number(user.account_age_days || 0),
    accountAgeMinutes: Number(user.account_age_minutes || 0),
    canRate: isEligible && monthlyRemaining > 0,
    eligibleAt: user.eligible_at,
    isEligible,
    monthlyLimit: monthlyRatingLimit,
    monthlyRemaining,
    monthlyUsed,
  }
}

const loadRatingStatus = async (userId) => {
  const [users] = await db.execute(
    `SELECT
      id,
      created_at,
      NULL AS eligible_at,
      GREATEST(TIMESTAMPDIFF(DAY, created_at, NOW()), 0) AS account_age_days,
      GREATEST(TIMESTAMPDIFF(MINUTE, created_at, NOW()), 0) AS account_age_minutes,
      1 AS is_rating_eligible
    FROM users
    WHERE id = ?
    LIMIT 1`,
    [userId],
  )

  if (!users.length) {
    return null
  }

  const [counts] = await db.execute(currentMonthRatingsSql, [userId])
  const monthlyUsed = Number(counts[0]?.monthly_count || 0)

  return toRatingStatus(users[0], monthlyUsed)
}

const toRatingComment = (row) => ({
  id: row.id,
  score: Number(row.score),
  comment: row.comment_text || '',
  raterName: row.rater_name || 'Usuario',
  createdAt: row.created_at,
})

const loadRatingComments = async (ratedUserId) => {
  const [comments] = await db.execute(
    `SELECT
      jobRatings.id,
      jobRatings.score,
      jobRatings.comment_text,
      jobRatings.created_at,
      users.name AS rater_name
    FROM jobRatings
    INNER JOIN users
      ON users.id = jobRatings.rater_user_id
    WHERE jobRatings.rated_user_id = ?
      AND jobRatings.comment_text <> ''
    ORDER BY jobRatings.created_at DESC
    LIMIT ${ratingCommentsLimit}`,
    [ratedUserId],
  )

  return comments.map(toRatingComment)
}

const loadRatingSummary = async (ratedUserId, raterUserId) => {
  const [ratings] = await db.execute(
    `SELECT
      ROUND(AVG(score), 1) AS provider_rating_average,
      COUNT(*) AS provider_rating_count,
      MAX(CASE WHEN rater_user_id = ? THEN score END) AS my_rating_score,
      MAX(CASE WHEN rater_user_id = ? THEN comment_text END) AS my_rating_comment
    FROM jobRatings
    WHERE rated_user_id = ?`,
    [raterUserId, raterUserId, ratedUserId],
  )
  const summary = ratings[0] || {}
  const comments = await loadRatingComments(ratedUserId)

  return {
    average: summary.provider_rating_average === null
      ? null
      : Number(summary.provider_rating_average),
    count: Number(summary.provider_rating_count || 0),
    myScore: summary.my_rating_score === null || summary.my_rating_score === undefined
      ? null
      : Number(summary.my_rating_score),
    myComment: summary.my_rating_comment || '',
    comments,
    ratedUserId,
  }
}

ratingsRouter.use(requireAuth)

ratingsRouter.get('/me', async (req, res) => {
  if (!ensureDb(res)) {
    return
  }

  try {
    const ratingStatus = await loadRatingStatus(req.userId)

    if (!ratingStatus) {
      return res.status(404).json({ message: 'El usuario no existe.' })
    }

    return res.json({ ratingStatus })
  } catch (error) {
    console.error('Error cargando estado de puntuaciones:', error)
    return res.status(500).json({ message: 'No se pudo cargar el estado de puntuaciones.' })
  }
})

ratingsRouter.post('/', async (req, res) => {
  if (!ensureDb(res)) {
    return
  }

  const ratedUserId = Number(req.body.ratedUserId)
  const score = Number(req.body.score)
  const comment = typeof req.body.comment === 'string' ? req.body.comment.trim() : ''

  if (!Number.isInteger(ratedUserId)) {
    return res.status(400).json({ message: 'Prestador invalido.' })
  }

  if (ratedUserId === req.userId) {
    return res.status(400).json({ message: 'No podes puntuar tu propio perfil.' })
  }

  if (!Number.isInteger(score) || score < minScore || score > maxScore) {
    return res.status(400).json({ message: 'La puntuacion tiene que ser un numero del 1 al 10.' })
  }

  if (comment.length < minCommentLength) {
    return res.status(400).json({ message: 'Agrega un comentario de al menos 5 caracteres.' })
  }

  if (comment.length > maxCommentLength) {
    return res.status(400).json({ message: 'El comentario puede tener hasta 800 caracteres.' })
  }

  try {
    const ratingStatus = await loadRatingStatus(req.userId)

    if (!ratingStatus) {
      return res.status(404).json({ message: 'El usuario no existe.' })
    }

    if (!ratingStatus.isEligible) {
      return res.status(403).json({ message: 'Tu cuenta todavia no puede puntuar.' })
    }

    const [ratedUsers] = await db.execute(
      'SELECT id FROM users WHERE id = ? LIMIT 1',
      [ratedUserId],
    )

    if (!ratedUsers.length) {
      return res.status(404).json({ message: 'El prestador no existe.' })
    }

    const [existingRatings] = await db.execute(
      `SELECT id
      FROM jobRatings
      WHERE rater_user_id = ? AND rated_user_id = ?
      LIMIT 1`,
      [req.userId, ratedUserId],
    )
    const existingRating = existingRatings[0]

    if (!existingRating && ratingStatus.monthlyUsed >= monthlyRatingLimit) {
      return res.status(403).json({ message: 'Ya usaste tus 2 puntuaciones de este mes.' })
    }

    if (existingRating) {
      await db.execute(
        'UPDATE jobRatings SET score = ?, comment_text = ? WHERE id = ?',
        [score, comment, existingRating.id],
      )
    } else {
      await db.execute(
        `INSERT INTO jobRatings (rater_user_id, rated_user_id, score, comment_text)
        VALUES (?, ?, ?, ?)`,
        [req.userId, ratedUserId, score, comment],
      )
    }

    const [rating, updatedStatus] = await Promise.all([
      loadRatingSummary(ratedUserId, req.userId),
      loadRatingStatus(req.userId),
    ])

    return res.json({
      rating,
      ratingStatus: updatedStatus,
    })
  } catch (error) {
    console.error('Error guardando puntuacion:', error)
    return res.status(500).json({ message: 'No se pudo guardar la puntuacion.' })
  }
})
